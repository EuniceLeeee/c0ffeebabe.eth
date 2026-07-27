# 生产事故报告 — live block-scan 输出为零（2026-07-27）

> **严重度：P0（生产能力完全丧失）。** live block-scan lane 在当前部署下 **260/260 个 pass 全部失败，
> 定价 0 条边、产出 0 个候选**。本报告只陈述实测事实与代码定位，不含修复。
> 基线：live 部署 SHA `137b0f8`（= 当时 `origin/main`），进程 PID 163788，运行时长 3h53m。

## 1. 事实：整条 lane 零产出

结构化遥测 `[searcher/blockscan-family]` 的 `block_scan_timing` 事件，最近 12000 行日志：

```
事件数        : 260
source_block  : 25621435 .. 25621809（跨 375 块，尝试 260 块）
candidates    : 每一条都是 0
priced        : 0/28235（28235 条边，定价 0 条）
```

每个 pass 的阶段状态一律：

```json
"stages":{"state":{"status":"failed"},
          "enumeration":{"status":"not-run"},
          "exact_refine":{"status":"not-run"},
          "planner_solver":{"status":"not-run"},
          "final_sim":{"status":"not-run"},
          "ev":{"status":"not-run"}}
```

⇒ **state 阶段每块失败，其后全部阶段从未运行。** 不是"少扫了几个机会"，是**block-scan 完全没有产出**。

`degraded families=` 行显示**全部 18 个 family 无一幸免**：
`balancer-v3, credit:fluid, curve-plain, curve-underlying, custom-swap:dodo-v2, fluid-dex,
protocol:eigenpie, protocol:erc4626, protocol:erc4626-silo-redeem, protocol:goldx,
protocol:metronome-hgusdc, protocol:metronome-synth, protocol:psm, protocol:rocksolid,
protocol:wsteth, univ2-standard, univ3-standard, univ4` — `priced=0/N`。

## 1b. 根因（最终版）：增量刷新依赖「上一块成功发布」，一次失败即进入不可恢复的死亡螺旋

> 本节是对 §2 的修正与深化。§2 描述的"29–34 秒"是**现象**；下面是**为什么每块都要 29–34 秒**。

新 coordinator 的增量刷新以「上一代成功发布的 snapshot」为前提
（`blockscan-state-coordinator.ts:777-790`）：

```ts
if (!previous) {                       // 没有上一代已发布 snapshot
  for (const family of families) {
    if (compiledFamilies.get(family.familyId)?.incremental) {
      fullFallbackReasonByFamily.set(family.familyId, "previous-snapshot-unavailable");
    }
  }
  return { plans, ... };               // ⇒ 全部 family 退化为「每个 stateKey 全量当块读」
}
```

而 `previous` 就是 `this.published`（`:393`），`this.published = snapshot` **仅在成功发布时赋值**
（`:721`）；失败或被取代的 generation **从不提交**。

**闭环：**

```
任一趟 pass 失败（超时 / 被 discovery 门毙 / 瞬时 RPC 抖动 / reorg）
   → 不发布 snapshot
   → 下一趟 previous 不存在
   → 全部 incremental family 退化为全量读（28235 条边规模的 stateKey）
   → 29–34 秒，必然超预算
   → 又不发布
   → 永远回不去增量
```

**这是自维持故障态**：只要错过一块，系统再也不会自行恢复。它解释了三件事——
为什么**每块**都 29–34 秒（永远在全量）、为什么 `priced=0`（从未完成）、
以及为什么**重构前能出块、重构后不能**。

### 连坐是两层的：发布粒度与回退粒度都是「全体」

**层一 — 发布是全局 all-or-nothing。** `this.published` 是**单个 coordinator 级 snapshot**，不是 per-family。
成功路径在 `:721` 赋值（注意它在 `degraded` 计算**之前**，所以 **degraded 快照是会发布的**，
下一块仍可增量）；但 `incompleteResult(...)`（`:702` 等路径）**直接返回且从不赋值**。
因此**任一** family 未结算（实测样本：`protocol:eigenpie did not settle within 0ms`）
⇒ 整趟 `incomplete` ⇒ **全局不发布**。

**层二 — 回退也是全局。** `if (!previous)` 分支里是
`for (const family of families) { … fullFallbackReasonByFamily.set(…) }`——
把**所有** incremental family 一起标记为全量回退，**包括上一块明明成功读到状态的 family**。

实测：**260/260 趟均未发布**（124 趟在 coordinator 之前即被 discovery 门 `return`；136 趟 `incomplete`），
故 `previous` 恒为 `null`，恒全量，恒超时。

**代码内已有细粒度结转的痕迹但未生效**：`carryStateKeys` / `directStateKeys` /
`missingPreviousStateKeys`（`:150-153`）表明设计上考虑过按 stateKey 结转，
但被全局 `previous` 的 all-or-nothing 前置条件卡死。

⇒ **正确形态应是 per-family（乃至 per-stateKey）结转**：各 family 各自保留上次成功状态，
单个 family 失败只影响自身，不应令全体回到全量。

### 与旧架构的结构性差异

旧架构的增量 warm 由独立模块 `listener/src/searcher/blockscan-warm-coordinator.ts` 承担，
**该文件已在本次重构中删除**（当前树中不存在，生产代码零引用）。它的关键性质是：
**warm 缓存的存活与"某一趟 pass 是否成功"无关**——一趟失败不会清空已 warm 的池状态，
下一趟仍可只读变化部分。因此旧构建每块只付增量代价，`protocolMidDeadline=0`（从未撞 deadline），
稳定产出 `protocolMids=2013 / externalSwapMids=1023 / exactCurveMids=815/826`。

新架构把「增量能力」与「发布成功」耦合在一起，于是**失败具有传染性**：
一次失败 ⇒ 下一次必然更慢 ⇒ 必然再失败。

> **注**：旧架构遇到 deadline **同样是 `return` 中止本趟**
> （`7f8b859:listener/src/searcher/main.ts:2059-2062`），所以**失败策略不是差异**；
> 差异只在**下一趟能否继续增量**。

## 2. 现象：state 准备耗时 29–34 秒，而出块间隔 12 秒

按 decision 分组的实测耗时（n=260）：

| decision | n | state_ms p50 | state_ms max | queue_ms p50 |
|---|---:|---:|---:|---:|
| `discovery_backfill_behind:N<N` | **124** | 5,865 | 35,835 | 3,842 |
| `deadline reached` | 46 | **28,941** | 33,850 | 0 |
| `adapter runtime deadline reached` | 45 | **34,055** | **44,057** | 7,164 |
| `scanner_deadline` | 28 | 28,661 | 29,055 | 0 |
| `block-scan state deadline reached` | 8 | 34,212 | 35,328 | 15,456 |
| `runtime_error:DEX discovery deadline expired at N` | 6 | 32,369 | 34,304 | **24,522** |
| `block-scan state family protocol:eigenpie did not settle within 0ms` | 3 | 29,272 | 29,534 | 0 |

**核心事实：136/260（52%）是纯超时，state 阶段中位数 29–34 秒。** 以太坊出块 12 秒 ⇒
**系统被 2.5~3 倍超额订阅，结构上不可能跟上**。

### 两簇是一条因果链，不是两个独立问题

`queue_ms` 是决定性证据——pass 在排队等前一个 pass 释放：

- `runtime_error:DEX discovery deadline expired` 的 **queue_ms p50 = 24.5 秒**：这个 pass 在队列里等了
  24.5 秒才开始，此时 discovery 的截止时间早已过。
- `block-scan state deadline reached` queue_ms p50 = 15.5 秒；`adapter runtime deadline` = 7.2 秒。

因果链：

```
state 准备 29–34s（> 12s 出块）
   → pass 串行积压，后来的 pass 排队 4–25s
   → discovery backfill 被饿死，watermark 追不上 head
   → 门 `graphCompleteThrough >= N-1` 判定失败（124 次 discovery_backfill_behind）
   → 整趟 pass 被毙
   → 永远没有候选
```

**`discovery_backfill_behind` 是症状，不是病根**：实测 watermark 只落后 **1~3 块**
（样本：`25621788<25621789` 差 1、`25621778<25621781` 差 3），说明 discovery 本身并没崩，
只是被 30 秒的 state pass 挤得追不上。

`block-scan state family protocol:eigenpie did not settle within 0ms` 是同一饥饿的直接证据：
**预算被前面的 family 吃光，轮到 eigenpie 时分到 0 毫秒。**

## 3. 与旧构建的对比：这是回归

旧架构（block 25601279 前后，同一日志文件早段）曾打印：

```
[searcher/blockscan] block=25601279 warmedV2V3=8378 warmedV4=2316 warmedCurve=221
                     v3TickMeta=3462 protocolMids=2013 exactCurveMids=815/826 exactCurveMidFailed=11
[searcher/blockscan] block=25601282 protocolMidFailed=2 externalSwapMidFailed=142
                     protocolMidDeadline=0 externalSwapMids=1023 protocolMids=1198
```

⇒ 旧构建**每块能算出约 2000 条 protocol mid、1000 条 external swap mid、815/826 条 exact curve mid**。
当前构建 **priced=0**。

> **诚实边界**：旧构建能算出 mid ≠ 能产出候选/成交。本报告只能断言
> **"定价能力从数千条回归到零"**，未验证旧构建的候选产出率。

## 4. 代码定位

| 环节 | 文件/函数 | 与本事故的关系 |
|---|---|---|
| 门判定 | `listener/src/searcher/blockscan-runtime-loop.ts:542`（`graphCompleteThrough < blockNumber-1` ⇒ degraded）与 `:599`（`< blockNumber` ⇒ degraded） | 124 次 `discovery_backfill_behind` 的直接产生点 |
| 完整性口径 | `listener/src/searcher/live-discovery-publication.ts:357-368` `deriveLiveDiscoveryGraphCompleteThroughUnchecked` = `min(DEX 覆盖, 每个 protocol family anchor)` | 全局 min ⇒ 任一 family 落后即拖垮整趟（含纯 DEX） |
| 状态准备（真正的病根） | `listener/src/searcher/blockscan-state-coordinator.ts`（family lane 编排、deadline 分配） | state 阶段 29–34s；family 预算耗尽（eigenpie 0ms） |
| 每块持久化开销 | `live-discovery-coordinator.ts` `finishPublishedDiscoveryState` → `persistRuntimeGraphs`（`main.ts:511` **同步 `writeFileSync`** 全图，14418 池）+ 证据缓存序列化 | 每块同步写盘，直接计入热路径（此前对抗审查已标 P1，本事故坐实其代价） |

## 5. 修复方向（按影响排序，本轮不实施）

1. **压 state 准备到出块间隔以内**——这是唯一能真正解开死锁的一步。
   - 实例级去重 + 批量当块读 + 本地派生所有方向（Model-B）：把"每条 edge 一次 quote"变成
     "每个实例一次状态读"。用户 2026-07-27 提出的「instance 没有缓存 quote」正指向此簇；
     准确说法是**静态 schema/call-plan 按实例缓存，动态状态仍每块读**（不得缓存动态报价）。
   - 已实测的确定性收益：Curve chunk 串行→有界并行 **1.6–3.2x**（逐位等价，此前已验证）。
   - 把每块同步 `writeFileSync` 移出热路径（debounce/异步）。
2. **解耦 discovery 完整性门**：DEX block-scan 只 gate 在 DEX 自身完整性上，不被 protocol family
   anchor 的全局 `min` 拖累；或对 watermark 给 1–2 块容差。可让 124 次误毙立即消失，
   但**若不做第 1 步，超时簇仍在**。
3. **family 预算公平性**：当前先到先得，最后一个 family 可分到 0ms。需按 family 保底或轮转。
4. univ3 provisional-fork witness（148 池、约 4.2% 覆盖）——**在 priced=0 的前提下不是瓶颈**，排最后。

## 6. 工具 reconcile

`cd analysis && npm run tool-index -- --select venue,pool,block-scan --out /tmp/mev-tool-selection.json`
推荐集：`analysis:ab-canary-compare`（block-scan）、`analysis:test:venue-aggregate`（venue）、
`listener:searcher:pool`（pool）。实跑：

| tool id | exit | 说明 |
|---|---|---|
| `analysis:test:venue-aggregate` | 0 | pass 2/2 |
| `listener:searcher:pool-adapter-policy` | 0 | PASS（17 derived adapters） |

- `tool-reconciled: analysis:ab-canary-compare n/a 该工具是配对 A/B 日志比较器（`guard-ab-manual-first` 强制要求 --manual-verdict/--a-log/--b-log），本报告是单路 live 日志的根因分析，非 A/B 比较，执行不适用`
- `tool-reconciled: analysis:test:venue-aggregate n/a 本事故分析不做链上 venue 聚合；结论来自生产自身的结构化遥测`
- `tool-reconciled: listener:searcher:pool-adapter-policy agrees 17 个 derived adapter 的清单与遥测里 degraded 的 18 个 family 一致（含 credit:fluid），无遗漏 family`

**无 tool_divergence**。

## 7. 证据不足（明确声明）

1. **未确定 state 阶段 29–34 秒的内部构成**：遥测只给 `stage_timing_ms.state` 总时长，
   **没有 family 级/阶段级细分**，因此**无法说出是哪个 family、哪类读取吃掉了时间**。
   要定位必须先补 per-family state 耗时遥测。
2. **未确认这是何时引入的回归**：只知道 `137b0f8` 构建 priced=0、更早的日志段有数千 mid，
   **未做二分定位到具体提交**。
3. **未验证旧构建的候选产出率**（见 §3 边界）。
4. **未在受控环境复现**：本报告全部依据生产日志与代码静态阅读，未跑 replay/A-B。
5. backrun lane 另有 `solverSuccess=0 / simSuccess=0`（counters `hints=4930 plans=66 solverEntered=24`）
   与 `victim transition unresolved` 大量出现——**本报告未展开调查**，可能是独立问题。
