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

## 1-0. 【第二次更正 · 2026-07-27 深夜】§1 的「260/260 全在 state 失败」也过于绝对

扩样到 638 个 `block_scan_timing` 事件后复测：

| 指标 | 实测 |
|---|---|
| `stages.state.status` | `failed` **607** / **`ran` 46** |
| `stages.enumeration.status` | `not-run` 608 / **`ran` 43** |
| 那 43 次 enumeration 的结局 | **全部 `budget_exceeded`**，`candidates=0`、`planned=0` |
| 它们的耗时 | state **28.6–29.2s** ＋ enumeration **4.4–5.9s** ≈ **34s** |
| `priced` 覆盖 | 绝大多数 `0/29xxx`；**但出现过一次 `28383/28949`（98%）** |
| `outcome` 全谱 | degraded 301 / budget_exceeded 249 / stale_state 102 / **startup_warm 1** |

**两条结论性推论：**

1. **定价不是"做不到"，是"来不及"**——存在过一次 98% 定价完成的 pass，说明工作量本身可完成，
   失败是延迟性质而非能力性质。
2. **即使 state 跑通，全图 enumeration 还要 4.4–5.9s**，叠加后必然爆预算 ⇒
   仅把 state 压进预算**不足以**产出候选，端到端预算才是真门。

⇒ §1 的「260/260 全部失败于 state」应修正为：**约 7%（46/638）的 pass 能把 state 跑到 `ran`，
其中 43 次进入 enumeration，但全部因端到端超预算而在产出候选前终止。**
`candidates=0` 因此**不能**解读为"图里没有机会"——它是"没跑到能判断的地方"。

> 该更正由外部审计（Codex + fable5 非作者审计）指出方向后，由本人实测确认。
> 报告此前两处过度断言（`previous` 恒 null、260/260 全失败）均源于**以代码推断代替数据实测**。

## 1a. 【更正 · 2026-07-27 晚】§1b 的机制已被实测证伪，勿再引用

§1b（下节）由**代码阅读推断**得出「`previous` 恒为 null ⇒ 全局死亡螺旋」。
经 Codex 反驳 + 本人实测，**该机制不成立**。保留原文仅为留痕，**结论以本节为准**。

### 实测证据（live 遥测，最近 20000 行）

```
"fullFallbackReason":"mutation-range-failed"   × 357     ← 唯一取值
"fullFallbackReason":"previous-snapshot-unavailable"  × 0  ← 从未出现
```

⇒ **`previous` 是存在的**，代码从未进入 §1b 引用的 `if (!previous)` 分支。

### 逐条更正

| 原断言（§1b/§2/§8） | 实测/代码事实 | 判定 |
|---|---|---|
| `previous` 恒为 null，构成自维持死亡螺旋 | 实测 fallback 原因恒为 `mutation-range-failed`；`previous` 存在 | **证伪** |
| 单个 family 失败导致**全局**回退连坐 | 回退在 `families.map(async …)` **内部**按 family 设置：`fullFallbackReasonByFamily.set(family.familyId, phase)`（`:913`），本就是 per-family | **证伪** |
| family 串行「先到先得」，前面吃光预算致 eigenpie 0ms | `await Promise.all(families.map(...))`（`:837/:1023/:1057/:1393`）——**并发**；0ms 源于**共享的绝对截止已过期**，非被前序占用 | **证伪** |
| 缺少 family 级耗时遥测（§8 证据不足 #1） | `BlockScanFamilyTelemetry`（`:140-157`）已含 `wallMs / reads / batches / uniqueStateKeys / carryStateKeys / directStateKeys / missingPreviousStateKeys / fullFallbackReason` | **证伪** |

### 修正后的机制

```ts
// blockscan-state-coordinator.ts:876-915
phase = "mutation-range-failed";
const range = await awaitWithAbort(
  readRange.call(this.backend, descriptor, previousSource, through, { deadlineAtMs, signal }), signal);
validateCanonicalMutationRange(range, descriptor, previousSource, through);
…
} catch {
  // 注释原文：增量证明/分类只是优化，失败即令该 family 转为直接当块读，绝不产生 unresolved
  fullFallbackReasonByFamily.set(family.familyId, phase);
}
```

**链条：`readRange`（读 previous→N 的变更范围）对每个 family 均失败/超时
⇒ 各 family 退回全量当块读 ⇒ 代价爆炸 ⇒ 撞 5 秒 family 截止 ⇒ `incomplete`。**

关键常量（Codex 指出，已核实）：`DEFAULT_FAMILY_TIMEOUT_MS = 5_000`（`:332`）、
`hotPricingFamilyBudgetMs ?? 5_000`（`blockscan-runtime-loop.ts:814`）。

### 全量回退的实测代价（本轮新测，此前无人量化）

```json
{"familyId":"univ4","lane":"swap","wallMs":12052,"uniqueStateKeys":2889,"reads":5778,
 "batches":1,"status":"incomplete","issueCount":5778,"carryStateKeys":0,
 "directStateKeys":2889,"missingPreviousStateKeys":2889,
 "fullFallbackReason":"mutation-range-failed"}
{"lane":"swap","wallMs":14422,"uniqueStateKeys":15059,"reads":13940,"batches":7}
{"lane":"protocol","wallMs":11979,"uniqueStateKeys":245,"reads":287,"batches":9}
```

- univ4 单家全量：**2889 stateKeys / 5778 reads / 12.05s**，对 5 秒截止**天然不可能**；
- swap lane 合计 **14.4s**（15059 stateKeys / 13940 reads / 7 batches）；protocol lane **12.0s**；
- **`issueCount` 5778 恰等于 `reads` 5778 —— 每一次读都带 issue**；
- **`batches: 1`** —— 5778 次读挤在单个批次。

### 新的根因前沿（尚未查清，必须先查）

**为什么 `readRange` 对每一个 family 都失败？** 可能是共享 deadline 早已过期、
log-range 读本身超时/报错，或 `validateCanonicalMutationRange` 校验失败。
**在查清此点之前，不应把任何修法当作定案**——§5 的 F1 已因本节而失去其原始依据（见 §5 顶部批注）。

## 1b.〔已证伪·留痕〕原根因推断：增量刷新依赖「上一块成功发布」

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

## 5. 修法

> **【2026-07-27 晚 · 重要批注】** 本节写于 §1b 的（已证伪）机制之上，**F1 的原始依据已不成立**：
> 回退本就是 per-family，`previous` 也存在。见 §1a。
>
> 修正后的优先级：
> 1. **先查清 `readRange` 为何对每个 family 都失败**（新的根因前沿，§1a 末）——未查清前不定案；
> 2. **5 秒 family 截止 vs 全量回退 12–14 秒的结构性不匹配**（Codex 指出，已核实常量）——
>    要么让增量真正生效（回到 1），要么让全量代价降到截止以内（F5），二者必居其一；
> 3. F1 的 per-family/per-stateKey 结转**方向仍有价值**（`carryStateKeys` 实测恒为 0），
>    但它**不是"唯一解"**，且必须与 1/2 组合；
> 4. F2/F3/F4/F5/F6 相对次序不变。
>
> 以下 F1–F6 原文保留，读时请以本批注为准。

### F1（核心）— 结转粒度从全局降到 per-family / per-stateKey

**改什么**：把 `blockscan-state-coordinator.ts:777-790` 的全局前置条件

```ts
if (!previous) { /* 所有 family 一起全量回退 */ }
```

替换为**逐 family 判定**：某 family 有自己上次成功的 base ⇒ 它走增量；没有 ⇒ **只有它**全量。
`this.published` 从"单个全局 snapshot"改为"**per-family（或 per-stateKey）的最近成功状态**"，
使 `incompleteResult(...)` 路径**仍能提交成功 family 的结转基线**。

**零件已在**：`carryStateKeys` / `directStateKeys` / `missingPreviousStateKeys`（`:150-153`）
即为此设计，只是被全局 `previous` 卡住。

**不可动摇的边界（防止把修复做成作弊）**：
- 结转的是**增量的 base**，不是价格。carried state **必须仍按 source block N 做 delta 推进**
  （沿用现有 `mutationQueryDescriptor` / `readRange`），**动态报价一律不得跨块复用**；
- 任一 stateKey 无法推进到 N ⇒ 该 edge 仍 `unresolved`，**绝不产生零值或旧价**；
- fail-closed 与 final sim 不变。

### F2 — 解耦 discovery 完整性门

`live-discovery-publication.ts:357-368` 的全局 `min(DEX, 每个 protocol family anchor)` 拆开：
**DEX block-scan 只 gate 在 DEX 自身完整性**；protocol family 落后只影响其自身的边（标 unresolved），
不毙整趟。或对 watermark 给 1–2 块容差。
**预期**：消掉 124 次 `discovery_backfill_behind` 误毙。**但不做 F1，超时簇（136）仍在。**

### F3 — family 预算公平性

当前先到先得，实测出现 `protocol:eigenpie did not settle within 0ms`。
改为**每 family 保底预算 + 轮转**，并在超时时只标记该 family（degraded），不升级为全局 incomplete。

### F4 — 把每块同步落盘移出热路径

`finishPublishedDiscoveryState` → `persistRuntimeGraphs`（`main.ts:511` 同步 `writeFileSync`
全量 14418 池）+ 证据缓存序列化，改为 debounce/异步；`addressEntries` 加容量上限。

### F5 — 已实测的确定性提速（可与 F1 并行）

- Curve chunk 串行 → 有界并行：**实测 1.6–3.2×，逐位等价**（此前已验证）。
- Model-B 实例级去重：每个协议实例**一次**当块状态读 → 本地派生所有方向，
  替代"每条 edge 一次 quote"。（用户提出的「instance 没有缓存 quote」指向此项；
  准确表述为**静态 schema/call-plan 按实例缓存，动态状态仍每块读**。）

### F6（最后）— univ3 provisional-fork witness

148 池 / 约 4.2% 覆盖。**在 `priced=0` 的前提下它不是瓶颈**，必须排在恢复产出之后。

---

## 6. 验收标准

**基线（当前生产实测，作为对照）**：`published 0/260`、`priced 0/28235`、`candidates 0/260`、
`state p50 29–34s`、`fullFallbackReason=previous-snapshot-unavailable` 每块出现。

**验收全部使用已有的 `block_scan_timing` 结构化遥测**，无需新建 harness（这是现状的一个优点）。

### A. 硬门（全部必须通过，任一不过即不合并）

| # | 判据 | 阈值 | 取值来源 |
|---|---|---|---|
| A1 | **死亡螺旋已破**（F1 的直接验证） | 人为注入一次单 family 失败后，**下一块**即恢复增量：`fullFallbackReason` 要么不出现，要么**仅出现在被注入的那个 family** 上 | `familyTelemetry.fullFallbackReason` |
| A2 | **发布率** | paired window 内 `published / passes` ≥ **80%** | coordinator 发布计数 |
| A3 | **state 阶段耗时** | p50 **< 8s**、p95 **< 12s**（必须小于出块间隔，否则仍会积压） | `stage_timing_ms.state` |
| A4 | **定价覆盖** | `priced / expected` ≥ **95%**，且 `expected ≥ 28235`（见 A6） | `priced=X/Y` |
| A5 | **候选产出** | 窗口内 `candidates > 0` 的块比例 > 0，且 enumeration 阶段 `status != "not-run"` ≥ **80%** | `stages.enumeration.status` |
| A6 | **不得靠减图达标** | `expectedEdgeKeys` **不低于基线 28235**；任何激活集变化须单列 `activation_delta` 并单独审查 | `coverage.expectedEdgeKeys` |
| A7 | **新鲜度不倒退** | 每条已发布 mid 的 `freshnessByReadKey` 仍绑定 source block N；**零**跨块复用的动态报价 | `freshnessByReadKey` |
| A8 | **公平性** | **无** family 分到 0ms；每 family 至少获得保底预算 | `familyTelemetry` |

### B. 明确禁止的"通过方式"

- 调大 deadline / pass 预算蒙混过关（若确需调整，必须单独声明并证明 A3/A7 仍成立）；
- 缓存动态报价、或用上一块的 mid 顶替本块（违反 A7，且正是漏更新块的成因）；
- 缩小 universe / top-N / 跳过 slow family 来把 state 压进预算（违反 A6）；
- 只在"安静块"或 warm 之后取样（窗口须预先按块高冻结，见 C）；
- 把 `incomplete` 改成 `degraded` 却不真正恢复增量（A1 会抓住：`fullFallbackReason` 仍全体出现）。

### C. 验证方法

1. **配对 A/B**：同一节点、同一 universe 文件与 config、**预先按块高冻结**的窗口（建议 ≥120 块），
   baseline = 当前 `origin/main`，challenger = 修复分支；两侧读同一 `block_scan_timing` 遥测。
2. **恢复性专项测试**（A1）：在 challenger 上人为使**单个** family 超时一次，
   观察下一块是否只有该 family 全量、其余仍增量。这是与旧架构行为对齐的关键回归。
3. **短 smoke**：启动、安全门（dry-run/EV-gate 不变）、CPU/RSS 无回归。

### D. 阶段性目标（若一次做不到全绿）

允许分两步合并，但**必须如实标注状态**：

- **第一步（恢复产出）**：A1 + A2 + A5 通过，A3 放宽到 p50 < 12s ⇒ 状态可写
  `blockscan_output_restored`。**此时不得声称性能达标。**
- **第二步（达标 <10s）**：A3 全绿（p50<8s / p95<12s）+ A4 ⇒ 才可声称满足 state-lane 的 `<10s` 目标。

**任何一步都不得在未通过 A6/A7 的情况下宣称通过**——那是用减覆盖或用旧价换来的速度。

## 7. 工具 reconcile

`cd analysis && npm run tool-index -- --select venue,pool,block-scan --out /tmp/mev-tool-selection.json`
推荐集：`analysis:ab-canary-compare`（block-scan）、`analysis:test:venue-aggregate`（venue）、
`listener:searcher:pool`（pool）。实跑：

| tool id | exit | 说明 |
|---|---|---|
| `analysis:test:venue-aggregate` | 0 | pass 2/2 |
| `listener:searcher:pool-adapter-policy` | 0 | PASS（17 derived adapters） |

- `tool-reconciled: analysis:ab-canary-compare n/a 该工具是配对 A/B 日志比较器（`guard-ab-manual-first` 强制要求 --manual-verdict/--a-log/--b-log），本报告是单路 live 日志的根因分析，非 A/B 比较，执行不适用`
- `tool-reconciled: listener:searcher:blockscan-contract agrees block-scan 契约套件 7/7 通过，与遥测字段（stages/outcome/priced/familyTelemetry）的结构一致，未发现契约层缺陷`
- `tool-reconciled: analysis:test:venue-aggregate n/a 本事故分析不做链上 venue 聚合；结论来自生产自身的结构化遥测`
- `tool-reconciled: listener:searcher:pool-adapter-policy agrees 17 个 derived adapter 的清单与遥测里 degraded 的 18 个 family 一致（含 credit:fluid），无遗漏 family`

**无 tool_divergence**。

## 8. 证据不足（明确声明）

1. **未确定 state 阶段 29–34 秒的内部构成**：遥测只给 `stage_timing_ms.state` 总时长，
   **没有 family 级/阶段级细分**，因此**无法说出是哪个 family、哪类读取吃掉了时间**。
   要定位必须先补 per-family state 耗时遥测。
2. **未确认这是何时引入的回归**：只知道 `137b0f8` 构建 priced=0、更早的日志段有数千 mid，
   **未做二分定位到具体提交**。
3. **未验证旧构建的候选产出率**（见 §3 边界）。
4. **未在受控环境复现**：本报告全部依据生产日志与代码静态阅读，未跑 replay/A-B。
5. backrun lane 另有 `solverSuccess=0 / simSuccess=0`（counters `hints=4930 plans=66 solverEntered=24`）
   与 `victim transition unresolved` 大量出现——**本报告未展开调查**，可能是独立问题。
