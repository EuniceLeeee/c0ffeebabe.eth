# Fable 独立版 — Adapter Family 全量框架计划（swap / protocol / flash 一律以 family 形式）

> **角色**：本文是 Fable 5 独立起草、现经批注修正的历史对照稿。最终裁决见 canonical
> [adapter-family-line-plan.md §11](adapter-family-line-plan.md#11-fable-对照审计与最终收敛)；本文不是第二
> 真相源，不驱动实施，也不再保留“待裁决”分歧。正文中的“必须/步骤/验收”只记录原提案及审计上下文，
> 不能单独作为实现或 gate 合同。
> 原始基线：`origin/main @ ad35790`；Codex 于 `7bd6d40` 复核代码事实并完成收敛。
> 状态：设计稿。未实现；不使任何历史 gap 变为 fixed。

## 0. 本轮定位（用户拍板，2026-07-23）

1. **重点是全量 adapter family 框架，不是升级单个 adapter。** 框架建成后，单 adapter 迁移应是薄活。
2. **一律以 family 形式存在**：只要是接入的 adapter，不分 swap / protocol / flashloan，都必须是
   adapter family——统一的是**形式**（注册契约、谱系框架、conformance、状态 capability），不是运行路径：
   各类保留各自的谱系框架与运行时 lane。"线"指生产 family 的公共框架，不是一条混用的运行管道。
3. **孤岛政策**：已有 adapter 但尚未升级成 family 形式的——**保留 adapter 文件**，但把"为了让它在旧线
   上跑起来"而穿进共享代码的接线**切断**，退成孤岛文件（不再被线引用）。共享代码里不允许残留
   按-adapter 特判。
4. **公共框架吃掉共性，family 变轻**。用户点名的六项公共职责（§3.2 Conversion 谱系）：
   asset → receipt edge 构造；按需 approve requirement；exact-in quote 结果检查；caller receipt-token
   balance delta 增加；无 standing position；
   plan/final-sim 约束。

## 1. 现状矩阵（2026-07-23 按 `ad35790` 逐项核实，非记忆）

已有 16 个 route adapter 注册在 `PRODUCTION_ROUTE_ADAPTERS`
（[production-registry.ts:53-69](../../listener/src/searcher/venues/production-registry.ts:53)），但不能据此
说 production execution ownership 已全量 family 化：Fluid DEX 仍是 legacy，flash 在 registry 外，
fluid-dex-liquidate 仍只是低阶 ActionAdapter。缺口横跨状态层、flash 入册和孤岛接线：

| adapter | kind | identity 政策 | 状态层（`warm`） | prepared | 缺什么 |
|---|---|---|---|---|---|
| univ2 / univ3 / univ4 | swap | onchain-resolver ×2；v4 singleton-seed | `mutable-pool` 专用批处理 | ✅ | 样板，仅待并入协调器（S0）|
| curve-plain | swap | onchain-resolver | `curve-pool` 两轮串行 → 9.6s | ✅ | 状态层批处理（S1）|
| curve-underlying | swap | onchain-resolver | **`external-mid` 逐边** | ✅(custom) | 状态层（S2）|
| balancer-v3 | swap | onchain-resolver | **`external-mid` 逐边** | ❌ null | 状态层（S2）+ prepared |
| dodo-v2 | swap | onchain-resolver | **`external-mid` 逐边** | ✅ | 状态层（S2）——**"DODO 没 family 化"的真实含义就是这一格** |
| fluid-dex | swap | singleton-seed | external-mid + **main.ts:4749 特判** | — | 孤岛候选（§6）|
| erc4626 / goldx / metronome×2 / psm / eigenpie / rocksolid / wsteth | protocol-conversion | singleton-seed；erc4626/eigenpie 另有 discovery+identity | **`protocol-mid` 逐边 quote** → 旧样本 11.6s | mixed：PSM/Eigenpie/Goldx/Metronome synth 有；其余 null | 状态层（S3）|
| fluid-credit | compat | trusted-singleton-seed | — | partial（quote null + unsupported reason）| 孤岛候选（§6）|
| balancer-flash / morpho-flash | **registry 外** | 描述符表 + **动态链上 borrowability**（`balanceOf(token, holder)`，非 allowlist，[flash-liquidity.ts](../../listener/src/searcher/solver/flash-liquidity.ts)）| 默认约 120s refresh；每 400 tokens 分 chunk，可能多个 Multicall | n/a | 入册 + source-N funding（§4）|

以下只是最先发现的三处代表性旁路，**不是穷举**。初稿的 grep 模式
`adapterId === "` 不仅漏掉 switch/case，也漏 venue-key map、fallback 与 direct import：

1. [main.ts:4749](../../listener/src/searcher/main.ts:4749) `edge.adapterId === "fluid-dex-swap"`；
2. [plan-builder.ts:179](../../listener/src/searcher/solver/plan-builder.ts:179)
   `switch (edge.adapterId)` + `case "fluid-dex-swap"`——plan 编译级的按-adapter 分支；
3. `LEGACY_PRODUCTION_ROUTE_EDGES`（[path-template.ts:4](../../listener/src/searcher/templates/path-template.ts:4)）
   ——registry 外的 legacy edge 描述符表，被 path templates 消费，是结构性旁路而非单行特判。

后续审计又在 token-graph、quoter、blockscan-scanner、revm-live-backend、pool-state-updater、
amount-propagation/solver 与 victim 路径发现 family-specific 分发。完整清单必须由 production
consumer/import closure 生成；三处手工表只能做 inventory 种子，不能宣称冻结完成。

## 2. 框架的五个部件

```
                        ┌──────────────────────────────────────────────┐
                        │ PRODUCTION_ADAPTER_FAMILIES（唯一高阶注册源） │
                        └──────┬───────────────────────────────────────┘
             ┌─────────────────┼──────────────────────┬────────────────┐
       kind: "swap"    kind: "protocol-conversion"  kind: "flash-loan"
             │                 │                      │
   ┌─────────┴─────────┐ ┌─────┴──────────────┐ ┌─────┴──────────────┐
   │ Swap 共性候选      │ │ Conversion 谱系框架 │ │ Flash 谱系框架      │   ← §3 可证共性层
   └─────────┬─────────┘ └─────┬──────────────┘ └─────┬──────────────┘
             └─────────────────┴──────────────────────┘
                               │
              AdapterRuntimeCoordinator（price 双 lane + typed funding）
                               │
              conformance 门（启动断言 + AST/import-closure 零特判）
```

1. **唯一注册源**：使用 universal discriminated `PRODUCTION_ADAPTER_FAMILIES`；route、protocol 与 flash
   从同一 registry 派生 typed views，但 flash 不塞进 `RouteLegKind`、也不伪装成 price edge。继续执行
   auto-discovery plan §14 边界：一个 adapter 就是一个 family；发现与身份同次交付；framework 永远不是 owner。
2. **谱系框架层**（§3）：只把至少两个真实 family 已证明相同的 invariant 下沉；ReceiptDeposit 与
   FlashLoan 已有明确对象，Swap 只列共性候选，不预设必须造一个 umbrella framework。
3. **状态协调器**（§5）：双 lane 时效层——这是当前最大的延迟债（28.7s pass → `skipped=busy`）。
4. **conformance 门**：启动断言（family 契约完整性、discovery+identity 同交付、§5.4 硬护栏）+
   **共享代码零特判门**——family IDs 从 registry 派生，AST/import-closure 检查 equality、switch/case、
   venue-key map、fallback 与 direct import；字面 grep 不算证据。
5. **孤岛区**（§6）：未迁移 adapter 的保命接线的唯一去处。

## 3. 可证共性层：共性下沉，family 变轻

### 3.1 framework ≠ family（沿用 §14 边界 6）

ERC4626 deposit、Eigenpie deposit 的 identity、quote ABI、calldata、事件、rounding 各不相同——谱系框架
**不注册、不拥有 pool/edge/action ID**，只提供共享执行骨架。已存的 `ReceiptDepositFramework` 就是这个
形态的第一个实例。是否继续抽取 FlashLoan 或 Swap 共性，必须满足“至少两个真实 family + 共同机器
assertion”，不能为追求三类对称而预造框架。

### 3.2 已确认框架与候选共性

| 谱系 | 吃掉的公共职责 | family 剩下什么 |
|---|---|---|
| **ReceiptDeposit**（单向 asset→receipt deposit） | edge 构造；按需 approve requirement；exact-in quote shape；caller receipt-token balance delta；共同 plan shape。standing taxonomy、route conservation 与 final sim 仍由全局 owner 负责 | identity 根、方向、quote ABI、approve/transfer 形态、calldata、rounding、token delta/event、`deriveMid`；redeem/unwrap/rebase/native 不被强塞进 base framework |
| **Swap 候选**（池对池；不是预先批准的 framework） | pair edge 构造、quote 符号/taxonomy、plan/final-sim 中可被至少两个真实 family 共同断言的部分 | 池 identity、reserve/slot0/A/PMM 数学、tick/rate schema、`deriveMid`、prepared quote；不能为了共用而塞进协议 switch |
| **Flash**（借还同 tx） | 动态 borrowability（链上 balanceOf，非 allowlist）；borrow/repay 守恒；按 provider fee/repayment 语义验证 lender 不减少；repayment 形态（approve-pull / transfer）编排 | 描述符（target/holder/paramShape/priority）+ ActionAdapter 编码 |

### 3.3 "轻"的可验收定义

框架建成后，新增一个 family 只应包含：**identity 解析 + 调用描述符（quote/execute ABI）+ 数学/断言
差异 + capability 声明**。原稿提出的 `≤200 行` 经审计降级为 code-review smell：超出时必须检查是否重复了
orchestration/framework，但行数不能作为 correctness gate，避免通过挪文件或压缩代码做假。

## 4. Flash family 化（第三 kind 的具体形状）

现状可复用的部分是 `FLASH_PROVIDER_DESCRIPTORS` 的 provider 语义
（[flash-providers.ts](../../listener/src/adapters/flash-providers.ts)，target/holder/repayment/paramShape/
双 priority）和 chunked Multicall borrowability read。原稿“每块一个 Multicall、只改归属”经代码审计为错：
当前默认约每 `120s` 刷新，且每 400 tokens 分 chunk，可能多个 Multicall；source-N funding state 是真实行为
改造。收敛后的步骤：

1. `balancer-flash` / `morpho-flash` 各注册为 `kind: "flash-loan"` 的 family（描述符即声明）；
2. plan-builder 不再 import `DEFAULT_FLASH_ADAPTER_ID` 常量，改从 registry 取
   （[plan-builder.ts:42](../../listener/src/searcher/solver/plan-builder.ts:42) 的默认参数是最后一个
   registry 外接线）；
3. `FlashLiquidityCache` 的刷新并入状态协调器，改成 source-N typed funding capability；
4. conformance 新增：flash family 必须声明 liquidityHolder，并按 provider fee/repayment 语义验证应还金额；
   通用 lender 下界为 `after >= before`，不是 equality。

注意：这里没有**实例 discovery/allowlist** 问题——flash provider 是基础设施 singleton（CLAUDE.md §2
允许 pin 的 identity 源），但仍须通过 family registration、code/chain 与 repayment conformance；
borrowability 本来就动态。

## 5. 状态层：双 lane 时效架构（完整图 <10s）

### 5.1 证据：为什么必须做（live 已锁定，非推测）

tx `0x055f5c…` 复盘的最终事实：live funnel 里**没有**该路线"发现后放弃"的记录——所需源块被整轮跳过。

| 事实 | 数值 | 出处 |
|---|---|---|
| `source=25585379` 的 pass 总耗时 | **28,739ms** | 生产日志（SSM `4afc0b54`）|
| 其中 Curve warm / protocol mids | 9,629ms / 11,630ms（合计 ≈74%）| 同上 |
| `25585380`（目标源块）、`25585381` | `skipped=busy`（[main.ts:1781](../../listener/src/searcher/main.ts:1781)）| 同上 |
| 图规模 | 29,220 边 > 20,000 → pass 预算升至 30s | 同上 |
| refine 结果 | 预留 8s solve 后耗尽：`exactRouteProbes=0`、`deadline=1`，solve 未运行 | 同上 |
| funnel 事件 | 该块 4 条 `opportunity_seen`/5 条 drop 全是其他 mempool 候选，无本路线 | `analysis:block-activity`（SSM `1732ec95`，exit 0；manifest SHA `90cd32d7…a08c9`）|

busy 机制在代码里逐字可见：`blockScanBusy` 是**单个布尔**
（[main.ts:1723](../../listener/src/searcher/main.ts:1723)），无队列、无抢占、无历史源块补扫。

### 5.2 根因：pass 是纯串行阶段链

`WarmSpec` 只有四个桶（[route-leg-adapter.ts:73](../../listener/src/searcher/venues/route-leg-adapter.ts:73)：
`mutable-pool / curve-pool / external-mid / protocol-mid`），`main.ts` 按桶各写一套刷新逻辑（消费点散布
[4427](../../listener/src/searcher/main.ts:4427)–[5016](../../listener/src/searcher/main.ts:5016)），且
每段顺序 `await`——阶段名就是 `passBudgetExceeded(stage)` 的实参：

| 阶段（执行顺序） | 锚点 | 实际行为 |
|---|---|---|
| `warm_plan` → `warm_v2v3` | [main.ts:1956](../../listener/src/searcher/main.ts:1956) / :1962 | 专用批处理，是 Uni 较快的主要结构性原因之一 |
| `warm_verify` / `v3_tick_meta` | :1987 / :2002 | 校验/元数据 |
| `warm_curve` | :2012 `await` [warmBlockScanCurves:4908](../../listener/src/searcher/main.ts:4908) | 226 池 × 8 chunk × **两轮**；chunk 在 [pool-state-cache.ts:985](../../listener/src/searcher/solver/pool-state-cache.ts:985) **顺序 await** → 9.6s |
| `protocol_mids` | :2085 `await` [buildBlockScanProtocolMids:4621](../../listener/src/searcher/main.ts:4621) | **逐 edge task**（签名收 `edges[]`+`concurrency`）：约 1,879 个 quote × 并发 24（[main.ts:732](../../listener/src/searcher/main.ts:732)）≈ 79 波 → 11.6s |
| `curve_mids` → `scan` → `refine` | :2100 / :2138 / :2155 | 到这里预算已尽 |

**Uni 较快主要因为专用批处理、增量 changed-pool warm 与 metadata/cache 复用；Curve 是按池 chunk 的两轮
串行，protocol/external 才是逐 edge 大头。问题不是“每块刷新”本身，而是调度与读放大。**

### 5.3 时效契约：按 lane 统一规则，**不是统一 TTL**

"protocol 统一 TTL 10 blocks"曾被提出，**已撤回**（用户否决："突然有个区块汇率大更新就找不到机会了"）：

- 机会往往恰好发生在**更新块**：ERC4626 donation/harvest/loss 单块跳变；wstETH oracle report 离散更新；
  PSM `tin/tout` 一次治理直接改。
- stale mid 的失败模式是**假阴性**：旧 mid 看着无利 → coarse scanner 不产候选 → exact probe / final sim
  根本不执行。**final sim 只能过滤假阳性，救不了假阴性。**

| 数据 | 允许的块 | 责任方 |
|---|---|---|
| Graph topology | 原提案 `T-10` 已否决；完整负判定前必须证明 `completenessWatermark >= N` | base snapshot + current-block delta |
| Swap 动态价格状态 | **source block N** | swap lane：有可靠事件的池只刷 changed；无可靠事件的每块读最小 sentinel |
| Protocol 动态兑换状态 | **source block N** | protocol lane：每唯一实例批量读一次最小状态 |
| Coarse mids | 从 N 的最小状态**本地推导** | 各 family 的 `deriveMid` |
| Exact probe / final sim | **source block N** | 现有 solver/sim，不变 |

TTL 仅限**静态**部分（schema/descriptor/decimals/拓扑/后台巡检）。事件驱动只能做"优先刷新"，不能做
唯一失效依据——Curve NG `stored_rates` 可因外部依赖变化而无目标合约日志，ERC4626 同理。Curve 今天慢
是两轮串行 + 逐边解析 metadata，不是每块刷新的物理代价——批处理后应与 Uniswap 同量级。

### 5.4 接口与硬护栏

`WarmSpec` 收敛为 per-family capability，调度归唯一协调器；family 声明"怎么读、怎么解码、怎么算"，
**不得自己决定调度**：

```ts
interface BlockScanStateCapability {
  readonly lane: "swap" | "protocol";
  stateKey(edge): string;                   // 按池/实例去重；N 条 edge 共享一个 key
  staticReadPlan?(edge): Call[];            // schema —— 长期缓存
  dynamicReadPlan(edge, schema): Call[];    // 当前块 N 的最小动态状态
  decode(results): StateSnapshot;
  deriveMid(snapshot, edge): Mid;           // 纯本地：一个 snapshot 派生 N 条 edge
  eventDependencies?(edge): Address[];      // 仅"优先刷新"提示
  batching: "multicall" | "rpc-batch";      // 依赖 msg.sender 的走固定 from 的 batch
}
```

流程：按 lane + stateKey 分组去重 → 双 lane 并行批量读（source-block N pin）→ decode →
`deriveMid` 映射回所有 edge → 原子发布 → 全 lane 就绪后跑完整 graph scanner（edge 数/顺序/hash 不变）。

硬护栏（conformance 必须断言）：

1. **`deriveMid` 禁止读链**——签名不接 backend；conformance 在断网/毒化 backend 下调用并断言
   provider/call counters 全为零，任何 I/O 即 fail。
2. **一个 stateKey 只读一次**——N→1 收益的本体（1,879 task → 少数几个 batch）。
3. **stale/unresolved mid 不得把路线判成 no-opportunity**——发布 typed incomplete/degraded；strict
   full-profile 直接 fail。是否另建受限 exact-probe diagnostic 必须显式设计，不能假设 missing mid 会自然进 refine。
4. **无法本地派生的 family** 才走批量 quote fallback，必须合批，不逐 edge。
5. **duplicate-key 胜出规则、edge 顺序、graph hash 不变。**

### 5.5 busy 调度：latest-head 单槽抢占

`blockScanBusy` 布尔应升级为 latest-head single-slot 候选实现，只保留最新 pending source，并用 generation
fencing 阻止 late result 写回；final sim 前后、submit 前重校验 source block hash。新 head 是立即 abort，
还是等待不可取消的短任务 settle，必须由 transport cancellation、共享 Anvil/cache 安全性和 benchmark
裁决，不能在计划里先拍板。

### 5.6 <10s 预算（目标，非结论）与禁用捷径

原稿 `4.5/1.8/3.2/0.5s` 分段硬预算已经否决，旧 `29,220` 也只是历史图规模。唯一硬口径见 canonical
§8.4：完整 active-family graph 的六阶段 `source_head_seen → EV decision`、steady-process/fresh-source-state
p95 `<10s`；每阶段只如实记录。真实超时就 fail 并升级讨论，不能针对分段配额制造假快。

| 禁用捷径 | 原因 |
|---|---|
| 30s 预算直接改 10s | scanner 前退出，什么都没扫 |
| 只并行 Curve + protocol mids | 推算约 19.1s，仍不够 |
| 统一 TTL 让动态价格变旧 | 机会在更新块；假阴性（§5.3）|
| mid 只按目标合约日志失效 | 无目标日志的状态变化会漏 |
| 只调大 `MID_CONCURRENCY` | 可能打爆 Anvil/reth；逐 edge 模型没变 |
| 先扫 V2/V3/V4、慢图以后再说 | 不是完整图 <10s |

## 6. 孤岛政策（用户拍板：切断保命接线）

**规则**：adapter 文件保留；共享代码里为其存在的特判/兼容接线**移出**到 `venues/islands/`（或直接删除，
无人引用即成孤岛文件）；共享代码不 import 孤岛目录。每个孤岛文件头部必须写 (a) 属于哪个 adapter、
(b) 缺哪块 family 契约、(c) 迁移或删除条件。

当前孤岛候选（原稿手工表，**不是穷举**；完整 inventory 必须从 production closure 生成）：

| 候选 | 现状 | 处置 | 覆盖影响（显式，不许静默） |
|---|---|---|---|
| `fluid-dex-swap` 特判（main.ts:4749） | 代表性旁路之一，非唯一分支 | baseline-active，必须补齐完整 family；若产品决定退出，先走独立 `approved_deactivation`，不属于本轮重构 gate | 不得默认暂停覆盖或把减图计为提速 |
| `fluid-credit` compat adapter | `kind: "compat"`；已有 trusted-singleton identity，prepared 仅 partial | 保留文件；切断生产/诊断 planner 引用前必须先走独立 `approved_deactivation` | 即使 credit 不属于本轮提交目标，也不能宣称无生产覆盖损失 |
| plan-builder `case "fluid-dex-swap"`（plan-builder.ts:179，v2 补） | plan 编译级按-adapter 分支 | fluid-dex 补齐 family 契约（含 `buildPlanFragment` 自有编码）后删除；否则随 fluid-dex 孤岛化一并移出 | 同 fluid-dex 行 |
| `LEGACY_PRODUCTION_ROUTE_EDGES`（path-template.ts，v2 补） | registry 外 legacy edge 描述符表 | baseline-active edge 逐条迁入 family；未激活项才可孤岛化，终态不允许 registry 外第二 edge 源 | 已激活 edge 的退出必须先走独立 deactivation |
| `WarmSpec` 四桶 | 状态层旧协议 | 由 capability 投影为兼容 shim，F5 清退 | 无——投影期逐 wei 等价 |

**红线**：任何因孤岛化产生的生产覆盖变化必须出现在上表和部署说明里；静默丢覆盖就是自己制造 pool gap。

## 7. Shadow 实施切片（框架先行，生产一次翻转）

每片可以单独提交、单独验证，降低开发审查爆炸半径；但只能在 production-unreachable shadow/test
中前进。不得逐片替换线上真相源；全 cohort parity 后 production root 一次原子翻转。

| 片 | 内容 | 等价/验收 |
|---|---|---|
| **F0** | registry 扩全 kind（+`flash-loan`）；conformance 门（契约完整性 + shared consumer surface 的 registry-derived AST/import-closure） | 纯增量，现有 conformance 全绿 |
| **F1** | 保留 `ReceiptDepositFramework`；提取有两-family 机器证据的 FlashLoan 共性；Swap 只审查候选 invariants | 相同输入下现有 family route-adapters/replay 套件 bit-identical |
| **F2** | 状态协调器（§5）：S0 包装 V2/V3/V4 → S1 Curve 一轮批 → S2 清退 external-mid 桶（dodo/balancer/curve-underlying）→ S3 protocol 接入 | 相同 sealed successful snapshot 下 bigint/calldata exact；deadline 内 coverage/rank/scheduling 变化走 frozen cohort + Hermes A/B |
| **F3** | flash ownership 入册；source-N funding 调度另列行为变更 | ownership 在 sealed identical liquidity snapshot 下做 plan/final-sim parity；120s→source-N 的 cadence/selection 走 Hermes resource/output A/B |
| **F4** | 仅隔离 baseline-inactive partial 文件；baseline-active removal 必须先走独立 deactivation | shared-surface 结构门变绿；本轮性能比较不减 active manifest |
| **F5** | `WarmSpec` shim + `buildBlockScanProtocolMids` / `warmBlockScanCurves` / busy 布尔删除，busy 换单槽抢占（§5.5） | 删除后全套 replay + A/B |

治理分流按**是否触达 production closure/行为**固定，不按 F 编号猜：

- production-unreachable 的 additive kernel/framework/shadow coordinator 走普通非生产实现 review，可分提交
  进入 main，但不属于 HISTORICAL promotion；
- conformance/tooling 只有落在 `HISTORICAL-GAP.md` 明列的 `analysis/src`、同名 tests/package script、
  归档 artifact 或精确 trusted hunt harness 时，才走现有 direct-main；新增 listener runner 先独立扩门；
- 单 family deterministic production wiring 只有满足 HISTORICAL-GAP 的 adapter replay/production replay
  与 smoke 才能走其窄通道；
- 任一 production consumer、graph/state scheduling、coverage、latency/ranking、root flip 或 busy 行为变化，
  统一走 Hermes cohort + paired A/B。

## 8. 验收门（整线）

1. conformance 全绿：全 kind 注册；provider-specific flash repayment；shared orchestration/consumer
   surface 的 registry-derived AST/import-closure 零特判（排除 family module/低阶 ActionAdapter）；
   `deriveMids` 在断网/毒化 backend 下 provider/call counters 为零；每 stateKey 唯一调度。
2. 新 family 契约压力测试：按 §3.3 用新合同重写 Eigenpie。family production module `>200 LOC` 触发强制
   framework/重复 orchestration review，并报告重写前后 LOC；它是 review trigger，不是 pass/fail 数字。
3. 状态层四门：同 graph snapshot 生产形态 A/B 逐项等价（route fingerprint/候选排序/probe 符号/final sim）；
   完整六阶段 p95 `<10s`；预冻结 paired-block 分母中 busy/timeout/incomplete/missing terminal 全部算失败；
   §5.4 五条硬护栏断言。
4. 孤岛表逐条落地，覆盖影响显式发布。
5. 定锚交易验收：tx055 六步 + 秒级时限（细则见 canonical 版 §8.4–§8.5，两文共享同一标准，含
   时限不达标的"诚实 fail + 升级讨论"出口）。
6. **conversion-lane freshness blind sentinel**：只采用 canonical §8.6 / `gates.md` 的 commit-reveal、
   root-only secret、因果反事实、baseline/challenger 同输入与独立 clean-generation 合同；本文旧版的公开
   deterministic seed + 单 producer 描述已作废。
7. 诚实边界：若开工时生成的 tool index 仍没有适用的 architecture/latency runner，就先补可信测量工具；
   本文完成 ≠ 任何历史 gap fixed，fixed 仍要 scanner 自发枚举 + final sim（gates.md）。

## 9. 与 canonical 版的关系

- canonical（Codex）版 [adapter-family-line-plan.md](adapter-family-line-plan.md) 驱动实施；本文冻结为
  已审计的历史对照输入。
- 两文重合的结论（双 lane、source-N 动态状态、deriveMid 本地化、stateKey 去重、flash 非价格 lane、
  禁 TTL/减图/参数硬凑）视为已收敛。
- 原分歧均已裁决：topology 用 current-N watermark；抢占策略 benchmark 后定；开发可切片但 production
  一次翻转；200 LOC 仅触发 review。不得从本文恢复被否决版本。

## 10. Codex(gpt-5.6-sol ultra)对抗审计(2026-07-23)

### 10.1 P0/P1/P2 findings

**P0-1 — §1 的“特判清单已穷尽”及 F0 零特判门不成立。**

- **claim**：Fable 只列 `main.ts`、`plan-builder.ts`、legacy edge 三处，并以 grep `adapterId === "` 作为门，遗漏了 switch、映射表、descriptor、template、pool adapter、suffix 和并行 registry。
- **evidence**：Fluid 仍存在 `token-graph.ts` 的静态实例/`ADAPTER_MAP`/`switch(pool.adapter)`（`listener/src/searcher/planner/token-graph.ts:144-198,246-266,365-384`）、quoter fallback（`listener/src/searcher/solver/quoter.ts:191-210`）、Revm quote/allowance fallback（`listener/src/searcher/live-backends/revm-live-backend.ts:338-348,478-485`）、scanner fallback（`listener/src/searcher/detector/blockscan-scanner.ts:317-351`）；另有跨 family 的 `PROTOCOL_LEG_DESCRIPTORS`（`listener/src/adapters/protocol-legs.ts:110-185`）、venue capability 表（`listener/src/searcher/venues/capability.ts:41-186`）、event/victim-model 表（`listener/src/searcher/venues/landed-event-registry.ts:86-208`、`listener/src/searcher/venues/victim-model-registry.ts:56-110`）。完整复扫见 §10.3。
- **破坏什么**：F0 的新 registry 要么不驱动生产、因而不是“唯一注册源”，要么与上述 owner 同时驱动生产；后者形成第二真相源。字面 grep 会放过当前绝大多数分派形态。
- **建议修法**：先从 production import/consumer closure 生成 activation manifest；按 execution、discovery、state、template、quote、plan、ActionAdapter、observation 分层记录 owner。门禁应检查 derived-view 唯一性和孤岛 production reachability；文本扫描只能作辅助，不能只匹配一种等号写法。

**P0-2 — 两文均未显式处置当前可执行的 ERC4626 实例 allowlist。**

- **claim**：Fable 的孤岛表和两文的切换 inventory 都没有逐实例裁定 `EXTERNAL_AND_LEGACY_POOL_REGISTRY` 中的 ERC4626 compatibility rows。
- **evidence**：多个 vault 地址直接硬编码为 `erc4626` 实例（`listener/src/searcher/planner/token-graph.ts:144-182`），随后并入生产 `POOL_REGISTRY`（`:246-249`）；live 启动直接从该 registry 构造协议 universe（`listener/src/searcher/main.ts:913-916`）。注释还明确这些 rows 不经过 discovery candidate/identity evidence（`token-graph.ts:148-151`）。
- **破坏什么**：即使 universal family registry 建成，实例 admission 仍可由静态地址表旁路，造成 hardcode allowlist 回潮和两套实例真相源。
- **建议修法**：activation manifest 必须逐 row 标为“由 discovery+identity+probe 替代”或“经 review 退出”；普通 ERC4626 地址全部从生产静态表删除。`srUSDe` 这类非标准语义若保留，应作为独立完整 family/claim，而不是地址例外。

**P0-3 — §6 所称 Fluid DEX 孤岛化“backrun 不受影响”错误。**

- **claim**：Fluid 不是只在 block-scan `main.ts:4749` 有接线；graph、template、quote、plan 和 live backend 都是 backrun/block-scan 共用。
- **evidence**：Fluid 静态 pool 进入 `POOL_REGISTRY`（`listener/src/searcher/planner/token-graph.ts:183-198`），base pool 原样进入 backrun view（`listener/src/searcher/strategy-views.ts:25-35`）；共享 quoter、plan-builder 和 Revm fallback 分别见 `listener/src/searcher/solver/quoter.ts:191-210`、`listener/src/searcher/solver/plan-builder.ts:92-123,169-214`、`listener/src/searcher/live-backends/revm-live-backend.ts:338-348,478-485`，两 lane 的 solver 都调用同一 resolved-plan builder（`listener/src/searcher/solver/solver.ts:33,367-381`）。
- **破坏什么**：删除 fallback 会同时失去 Fluid backrun 的枚举/quote/编译能力；保留 fallback 又无法达到零特判和唯一 owner。当前覆盖影响表因此低报 production route loss。
- **建议修法**：Fluid 要么在 cutover 前补齐完整 family 并同时替换两 lane，要么把 block-scan、backrun、template、quote、plan、Revm、ActionAdapter 的全量退出作为一个已审 activation delta；不能只记 block-scan pause。

**P0-4 — §5.3 固定 `T-10` 会把 topology 不完整静默解释成无机会。**

- **claim**：snapshot 年龄不等于 discovery 完整性；新池首块、reorg 和 discovery 部分失败均可在“最近十块”内漏边。
- **evidence**：
  - 运行期 DEX 默认五分钟刷新，且只回扫最近 25 块（`listener/src/searcher/main.ts:898-904,1394-1400`），新 pool 在 N 创建并首 swap 时，N 的 scanner 可先于下一次 discovery。
  - `PoolUniverseFile` 只有数字 `fromBlock/toBlock`、没有 block hash（`listener/src/searcher/pool-universe.ts:23-29`），加载后这些元数据被丢弃（`:43-77`）。
  - log retry 最终会静默跳过失败的 10-block slice（`listener/src/searcher/active-pool-discovery.ts:307-326`）。
  - runtime graph 只 append pool/edge，不移除 reorg orphan（`listener/src/searcher/runtime-pool-refresh.ts:60-80,86-87,132-141`）。
  - protocol cursor 也只持 block number，无 cursor hash（`listener/src/searcher/protocol-discovery-cache.ts:27-35,261-291`）。
- **破坏什么**：新池首块 route 会成为假阴性；同高度 replacement reorg 会保留 orphan edge、漏新 canonical edge；discovery 停摆或缺 chunk 仍可能输出“完整图无机会”。final sim 无法补救未生成的候选。
- **建议修法**：采用 §10.2 所述 per-source completeness watermark；任何 source range、identity 或 probe 未完成都不得推进 watermark，`watermark < N` 时只能输出正发现或结构化 `graph_incomplete`。

**P0-5 — §7 的 F0–F5 横向 production strangler 会长期制造中间双 owner。**

- **claim**：Fable 的“小提交、小爆炸半径”适用于 shadow 开发，但不适用于把 F0/F1/F3 分别直进正在运行的 production champion。
- **evidence**：F0 若先加入 flash family，旧 descriptor 仍同时驱动 order/default/target（`listener/src/adapters/flash-providers.ts:24-62`）、template（`listener/src/searcher/templates/path-template.ts:65-91`）、planner（`listener/src/searcher/planner/planner.ts:192-194,377-438`）、plan-builder（`listener/src/searcher/solver/plan-builder.ts:10-13,34-43`）、liquidity（`listener/src/searcher/solver/flash-liquidity.ts:37-44`）和 ActionAdapter bootstrap（`listener/src/adapters/index.ts:43-47`）。F0 的“零特判门”还要等 F4 才可能满足。bounded-live champion 的 guarded deploy 会同步并运行 `origin/main`（`scripts/deploy-node.sh:2-7,330-338,571-574`）。
- **破坏什么**：任一后续 slice 延迟，半迁移 registry/framework/runtime 即成为无期限生产状态；输出差异难以归因于单一 owner。
- **建议修法**：保留 F0–F5 作为 production-unreachable 的 shadow commits；旧 production line 冻结，全量 family/coordinator/activation manifest 通过 shadow parity 后，只翻转一次 root import，并在同一提交清除旧 owner 的 production reachability。

**P0-6 — §4 的“每块一个 Multicall、行为不变”与当前实现不符，不能据此直接迁归属。**

- **claim**：dynamic borrowability 机制属实，但它既非 source-N，也非每块刷新，更非固定一个 Multicall。
- **evidence**：启动刷新后使用 120 秒 timer（`listener/src/searcher/main.ts:1286-1306`），graph/protocol projection 变化还会发起未等待的刷新（`:1375-1377,1431-1433`）；每 400 token 分块，可产生多个 Multicall（`listener/src/searcher/solver/flash-liquidity.ts:94-112`）；RPC 没有 `blockTag`，可选 block number 只写元数据且生产调用未传（`:82-90,109-112,133-134`）；并发 refresh 最终都无 generation/CAS 地覆盖整个 map（`:96,133`）。
- **破坏什么**：旧 refresh 后完成可覆盖新 refresh；偏小的 stale 余额会静默漏 route，偏大的 stale 余额会选择已不可借 provider。F3 若真正改为 source-N，输出本来就不可能与当前两分钟 cache byte-identical。
- **建议修法**：coordinator 接收 `{blockNumber, blockHash, generation}`，将 blockTag 传到每个 call；按稳定 token/provider/chunk 顺序读取，以 generation fence 原子发布。准确契约应是“每 source block 一次 refresh，每次可含多个 chunked Multicall”。

**P1-1 — §3.2 把 receipt deposit 的不变量过度推广为全部 Conversion 公共职责。**

- **claim**：现有 framework 只能证明单向 asset→receipt deposit，不能公共拥有 redeem/unwrap/convert、最终模拟或所有 approval 语义。
- **evidence**：
  - 文件自身限定 one-way deposit，并声明 ABI、identity、quote、calldata 仍由 family 拥有（`listener/src/searcher/venues/protocols/receipt-deposit-framework.ts:24-32`）。
  - ERC4626 redeem 与 wstETH unwrap 需要 family 自建反向 edge（`listener/src/searcher/venues/protocols/erc4626.ts:62-77,93-106`；`listener/src/searcher/venues/protocols/wsteth.ts:42-55`）。
  - `PROTOCOL_LEG_DESCRIPTORS` 中 wrap/deposit 要 approve，unwrap/redeem 不要（`listener/src/adapters/protocol-legs.ts:121-150`）；Metronome HGUSDC 使用 `transfer-to-pool`（`listener/src/searcher/venues/protocols/metronome.ts:161-174`）。
  - 公共 quote 检查只有正负/零值 shape（`receipt-deposit-framework.ts:91-100`），rounding、事件和资产去向仍明确归 family（`:155-160`）。
  - receipt 增量探针固定 approve→deposit→balance/supply reads（`:162-240,257-312`），不覆盖 native、redeem、rebase/fee token。
  - standing-position 真正由全局 taxonomy 决定；`mint` 默认 fail-closed（`listener/src/searcher/strategy-taxonomy.ts:20-32,66-79`）。
- **破坏什么**：把这些职责强行上收会产生第二套 final-sim/taxonomy owner，或错误接受 approval、余额方向、rounding 不同的 conversion。
- **建议修法**：只保留 `ReceiptDepositMixin`；全局 owner 负责 requirement 编排、standing taxonomy、route conservation 和 final sim；family 声明方向、exact-in/out、approve/transfer、rounding、expected token deltas/events 与 calldata。

**P1-2 — §3.2/§4 所称“final sim 已有 lender before==after”不成立。**

- **claim**：生产 final sim 没有 lender balance 字段或断言。
- **evidence**：`SimulationResult` 只含 profit/gas/calldata（`listener/src/searcher/simulator/botvm-simulator.ts:11-20`），模拟只比较 executor 的 profit-token 前后余额（`:35-51`）；Revm 也只返回 profit/gas/success（`listener/src/searcher/live-backends/revm-live-backend.ts:365-392`）。lender 检查只存在 Adapter Replay 的独立 conservation pass（`listener/src/searcher/test/adapter-replay.ts:1545-1569`），条件为 `after >= before`，不是相等（`:1377-1400`）。
- **破坏什么**：conformance 若按“现有断言上收”实现会得到虚假绿灯；无条件相等还会错误拒绝带 fee 的 flash provider。
- **建议修法**：在唯一全局 final-sim owner 增加 fee-aware observer，按 provider 声明校验 `after >= before` 或 `after == before + expectedFee`；framework 只提供 invariant descriptor，不另跑一套模拟。

**P1-3 — F0–F5 的“逐 wei/bit-identical”验收口径混合了整数语义、浮点 coarse mid 和有意改变的调度。**

- **claim**：
  - F0 只有在新 registry 完全不可达时 output-identical，此时它还不是 production owner。
  - F1 纯 delegation 理论上可 byte-identical，但 route replay 不覆盖 discovery/order/bootstrap。
  - F2 全局 bit-identical 不可要求：提速本身会改变哪些 block/task 在 deadline 前被扫描；修复 unresolved 假阴性也必须改变候选集。
  - F3 改成 current-N 后不能与当前 120 秒 flash cache bit-identical。
  - F4 是显式 coverage delta，按定义不等价。
  - F5 会改变被扫描 source block、cache history 和 submit 顺序。
- **evidence**：protocol/Curve mids 是 `Number(bigint)/Number(bigint)`（`listener/src/searcher/main.ts:4714-4719`；`listener/src/searcher/detector/blockscan-curve-mids.ts:133-140`），scanner 再用 `Math.log/exp` 和 bigint→Number（`listener/src/searcher/detector/blockscan-scanner.ts:404-433,527-582`），不存在“逐 wei”的 coarse-mid 单位。当前 batch 虽并发但按 input index 保存结果（`listener/src/searcher/detector/blockscan-mid-batch.ts:7-11,19-45`）；缺 mid 会直接 skip venue/ring（`blockscan-scanner.ts:97-104,404-433`）。Adapter Replay 明确不覆盖 scanner/detector discovery（`listener/src/searcher/test/adapter-replay.ts:1-13`）。
- **破坏什么**：把有意的 coverage/scheduling 改变包装成“等价”会掩盖 route set、rank、duplicate-key winner、cache failure path 和 submit-order 差异。
- **建议修法**：分字段定义合同：raw bigint quote、calldata、repayment 可 bit-exact；IEEE mid 固定公式与结果序列化，并另查 threshold/rank/route-set exact parity；集合按 semantic fingerprint 比较；F2/F3/F4/F5 必须走 frozen cohort + paired live A/B，显式报告 scheduling/activation delta。

**P1-4 — §5.5 可以先定 latest-head single-slot 外壳，但不能先定“新 head 一律立即取消整轮”。**

- **claim**：当前关键 RPC、Multicall、fork/reset 并未贯穿 AbortSignal；无条件 restart 还有 full-warm starvation 风险。
- **evidence**：StateBackend 只有受控 `call` 才走可 abort transport，普通调用仍走 ethers（`listener/src/shared/state/state-backend.ts:479-490`）；`forkAt` 的 `anvil_reset` 没有 signal，最长等待 60 秒（`:150-169`）；Curve chunk 顺序 await 且无 signal（`listener/src/searcher/solver/pool-state-cache.ts:981-1005`）；mid batch 到 deadline 只停止领新任务，仍等待 in-flight settle（`listener/src/searcher/detector/blockscan-mid-batch.ts:27-40`）。现有 full warm 明确需要保留 pinned progress，避免每块从 batch zero 重启（`listener/src/searcher/blockscan-warm-coordinator.ts:106-112`；`listener/src/searcher/main.ts:1732-1739`）。
- **破坏什么**：表面 abort 后复用仍在工作的 backend/cache 会污染 generation；连续快 head 下每轮重启可能一轮都完成不了。
- **建议修法**：先冻结“一 active generation + 一 latest pending、late-result fence、copy-on-write publish、backend settle 后复用”；对可取消 transport 才 abort。立即取消、stage-boundary settle、near-complete finish 由 benchmark/A/B 裁定。

**P1-5 — 两文均未给出跨 family descriptor/observation owner 的逐表处置。**

- **claim**：即使 route registry cutover，ABI、approve、quote signature、event invalidation 和 victim apply 仍可能由平行表拥有。
- **evidence**：`PROTOCOL_LEG_DESCRIPTORS` 同时驱动 plan、quote 和 ActionAdapter 注册（`listener/src/adapters/protocol-legs.ts:110-185`；`listener/src/searcher/venues/protocols/protocol-plan.ts:6-23`；`listener/src/searcher/venues/protocols/protocol-quote.ts:91-106`；`listener/src/adapters/index.ts:55-57`）。另有 landed event、victim model 和 impact maps（`listener/src/searcher/venues/landed-event-registry.ts:86-208`；`listener/src/searcher/venues/victim-model-registry.ts:56-110`；`listener/src/searcher/detector/pool-impact.ts:136-200,217-239,351-380,469-480`）。
- **破坏什么**：协议 ABI/approval 可在 family 与 descriptor 中漂移；新增 family 可能执行可用但事件失效、victim apply 或 impact 路径缺失。
- **建议修法**：ABI/plan/quote descriptor 应由同一 family 声明投影；event/victim 表若因正交语义保留独立，必须有 registry-derived coverage conformance，禁止手工漏项。

**P2-1 — §3.3 的 `≤200` 行硬阈值按现文不可执行。**

- **claim**：按直接 family 文件统计偏松且可拆文件规避；按 family-owned closure 统计又对 discovery family 过紧。
- **evidence**：15 个直接实现文件合计 2,497 物理行、中位数 152，11/15 不超过 200，但 UniV4/DODO/UniV2/UniV3 分别为 433/299/242/217 行；Metronome 一个 194 行文件含两个 family（`listener/src/searcher/venues/protocols/metronome.ts:28,99,194`）。Eigenpie closure 至少 125+514+33=672 行，ERC4626 至少 123+752=875 行。
- **破坏什么**：门槛奖励机械拆文件，不能证明 owner 更少或 family 更薄，也会阻断必要的 identity/discovery 代码。
- **建议修法**：将“核心声明文件约 ≤200”降为非阻断 smell；分别给 discovery/identity/ActionAdapter 预算，硬门改为 owner closure、无共享按-adapter 分支、无第二 registry 和 conformance 完整。

**P2-2 — §5.2 的结构锚点大体正确，但部分描述超出代码可证明范围。**

- **claim**：Curve 不是“逐 edge”，`pool-state-cache.ts:985` 也不是实际 await；226 pools/8 chunks/9.6s 属 live 样本，不能由 checkout 独立复现。
- **evidence**：Curve 是按 pool 去重、chunk=31、两轮读取，顺序 loop 在 `listener/src/searcher/solver/pool-state-cache.ts:810-893,981-1005`，真正 await 在 `:993`；protocol/external 才是 per-edge task（`listener/src/searcher/main.ts:4652-4724`）。
- **破坏什么**：若按“Curve 逐 edge”设计优化，可能重复已有 pool 去重，而没有解决两轮/chunk 串行和 schema/dynamic-state 分离。
- **建议修法**：文案改为“Curve 已按 pool 合批，但两轮和 chunks 串行；protocol/external 仍逐 edge”；live 数值保留为外部证据，不作为代码锚点结论。

**P2-3 — 两文都缺少可机器归因的 topology/flash generation terminal 与失败 corpus。**

- **claim**：当前 scanner 不能表达 `graph_incomplete`，runtime telemetry 也不足以把结果绑定到 watermark/state generation。
- **evidence**：`BlockScanOutcome` 只有 `ran|budget_exceeded`（`listener/src/searcher/detector/blockscan-scanner.ts:28-35`）；strategy version 只混入 pool hash/generatedAt，不含 source block/hash/completeness（`listener/src/searcher/strategy-views.ts:45-60`）；flash equal-balance 使用严格 `>`，tie 由 provider 顺序决定（`listener/src/searcher/solver/flash-liquidity.ts:119-130`）。
- **破坏什么**：A/B 可能比较了不同 graph generation；discovery 缺口仍只能表现为普通零候选；flash chunk failure/tie/旧刷新覆盖无法稳定归因。
- **建议修法**：每个 pass/result 携带 graph generation、per-source watermark、source hash、state snapshot hash；新增 `graph_incomplete/state_incomplete/aborted` terminal，并覆盖新池首块、同高度 reorg、log chunk failure、flash tie、>400-token 中途失败和 stale-result overwrite fixture。

### 10.2 分歧裁断

#### §5.3 topology：采 watermark，否决固定 `T-10`

Codex 立场与 canonical 一致。真实风险不是“旧十块的 pool 价格略旧”，而是 topology 中根本没有 route：

- **新池首块**：运行期五分钟/25-block 回扫不能保证 pool 创建与首 swap 的 N 块已被 scanner 看见（`listener/src/searcher/main.ts:898-904,1394-1400`）。
- **reorg**：当前 graph append-only，orphan edge 不会被删除（`listener/src/searcher/runtime-pool-refresh.ts:132-141`）。
- **discovery 停摆/部分失败**：失败 log slice 被跳过，返回值没有 completeness 标志（`listener/src/searcher/active-pool-discovery.ts:307-326`）。

第一版可实施形态应为：

```ts
interface GraphCoverageV1 {
  chainId: number;
  policyHash: string;
  baseSnapshotHash: string;
  perSource: readonly {
    sourceId: string;
    sourceFingerprint: string;
    completeThroughBlock: number;
    completeThroughHash: string;
  }[];
  completenessWatermark: number; // min(perSource.completeThroughBlock)
  sourceBlock: number;
  sourceBlockHash: string;
  orderedEdgeHash: string;
  metadataHash: string;
  ownershipHash: string;
}
```

每个 factory/event/registry/protocol source 各有 cursor+hash；任一 range、identity 或 probe 未完成都不推进该 source。对 `(watermark,N]` 的 delta 全部 pin 到 N，off-side 构造 immutable graph 后原子发布。`watermark<N` 可报告已知 edge 的正发现，但 terminal 必须是 `graph_incomplete`。reorg 时按 cursor hash 回退到共同 anchor 或从 base 重放，不能继续 additive merge。

#### §5.5 抢占形态：单槽可先定，立即全程取消待实测

Codex 采 canonical 的待实测立场。可以先定的安全合同是：

- 一个 active generation；
- 一个 coalesced latest pending head；
- generation token 阻止 late commit；
- copy-on-write/原子发布；
- 不可取消任务 settle 后才复用 Anvil/cache；
- discovery/state delta range 不随 solve pass 取消而丢失。

“立即 abort”“stage boundary settle”“near-complete finish”是实现策略，不是预先可定的不变量；当前 `forkAt`、Curve Multicall 和多数 warm call 均不可取消（`listener/src/shared/state/state-backend.ts:150-169,479-490`；`listener/src/searcher/solver/pool-state-cache.ts:981-1005`），必须 benchmark/A/B 后裁定。

#### §7 cutover：保留分片开发，生产一次翻转

Codex 采 canonical 的 production cutover，吸收 Fable 的“小提交可审计性”作为开发方式：

```text
F0–F5 小提交：仅 shadow/test 可达
        ↓
冻结 inventory + activation delta
        ↓
全量 graph/funding/template/calldata/state/candidate parity
        ↓
一次 root-import flip
        ↓
旧 production closure = 0
```

Fable 的 F0→F5 是按 registry/framework/state/flash/island/runtime 横向切片，不是“一个 family 的新 owner 与旧 owner在同一提交替换”的纵向 strangler；因此它会让多个 owner 跨提交共存。生产节点正在 bounded-live 运行并不构成接受中间态的理由，反而要求 deployed SHA 的 owner closure 可独立审计。

#### §3.3 `≤200` 行：取消硬门，保留 advisory smell

按 registry 直接实现文件、排除测试、物理行数统计：

| family 文件 | 行数 |
|---|---:|
| `swaps/univ4.ts` | 433 |
| `swaps/dodo-v2.ts` | 299 |
| `swaps/univ2-standard.ts` | 242 |
| `swaps/univ3-standard.ts` | 217 |
| `protocols/metronome.ts`（两个 family） | 194 |
| `swaps/curve-plain.ts` | 168 |
| `swaps/curve-underlying.ts` | 164 |
| `swaps/balancer-v3.ts` | 152 |
| `protocols/eigenpie.ts` | 125 |
| `protocols/erc4626.ts` | 123 |
| `protocols/psm.ts` | 114 |
| `protocols/goldx.ts` | 82 |
| `compat/fluid-credit.ts` | 67 |
| `protocols/wsteth.ts` | 61 |
| `protocols/rocksolid.ts` | 56 |

15 个文件合计 2,497 行，中位数 152，11/15 ≤200。直接文件口径偏松且可拆分规避；closure 口径下 Eigenpie 至少 672 行、ERC4626 至少 875 行，又明显偏紧。因此 `≤200` 只能作为核心声明文件的 review signal，不能成为 conformance 硬门。

### 10.3 矩阵与锚点重验

#### §1 逐格复核

| 行/格 | 裁断 | 代码证据与修正 |
|---|---|---|
| “16 个 adapter 都在 registry、执行层已全部 family 化” | **diverge** | 7 swap + 8 protocol + 1 compat 的计数属实（`listener/src/searcher/venues/production-registry.ts:51-72`），但 Fluid DEX 仍在 legacy registry（`:42-49`），`fluid-credit` 只是 incomplete compat；不能推出全部生产 execution 已 family 化。 |
| UniV2/V3/V4 identity/warm/prepared | **agree** | `mutable-pool/v2|v3|v4` 且 prepared 非 null：`listener/src/searcher/venues/swaps/univ2-standard.ts:30-55`、`univ3-standard.ts:36-70`、`univ4.ts:47-91`；identity：`production-registry.ts:75-76,91-96`。 |
| Curve plain | **agree** | `curve-pool`、prepared 非 null：`listener/src/searcher/venues/swaps/curve-plain.ts:25-41`；两轮读取：`listener/src/searcher/solver/pool-state-cache.ts:810-893`。9.6s 是 live 样本，不是静态代码结论。 |
| Curve underlying | **agree** | `external-mid`、prepared 非 null：`listener/src/searcher/venues/swaps/curve-underlying.ts:25-36`；identity：`production-registry.ts:79`。 |
| Balancer V3 | **agree** | `external-mid`、prepared null：`listener/src/searcher/venues/swaps/balancer-v3.ts:16-36`；identity：`production-registry.ts:80-84`。 |
| DODO V2 | **agree** | 已是 family，`external-mid`、prepared 非 null：`listener/src/searcher/venues/swaps/dodo-v2.ts:30-44`；identity：`production-registry.ts:85-89`。 |
| Fluid DEX | **部分 agree / disposition diverge** | singleton identity 与 legacy external-mid 特判属实（`production-registry.ts:109-112`；`main.ts:4746-4782`）；family `prepared` 确实不存在，但 live 仍有独立 exact quote/allowance 路径（`revm-live-backend.ts:338-348,478-485`），且孤岛化影响不止 block-scan。 |
| 8 个 protocol 的 identity/warm | **agree** | `protocol-mid` 与 ERC4626/Eigenpie discovery+identity 同次注册属实（`production-registry.ts:61-69,115-145`）。 |
| 8 个 protocol 的 `prepared=null` | **diverge** | 非 null：Goldx `protocols/goldx.ts:36-58`、Metronome synth `protocols/metronome.ts:42-75`、PSM `protocols/psm.ts:39-62`、Eigenpie `protocols/eigenpie.ts:38-78`；null：ERC4626 `protocols/erc4626.ts:34-36`、Metronome HGUSDC `protocols/metronome.ts:117-119`、RockSolid `protocols/rocksolid.ts:30-32`、wstETH `protocols/wsteth.ts:28-30`。 |
| Fluid credit identity/warm/prepared | **diverge** | `fluid-vault` 有 trusted singleton seed identity（`production-registry.ts:107`）；`warm:null`，但 `prepared` 是非 null 对象，只是 exact quote unsupported（`listener/src/searcher/venues/compat/fluid-credit.ts:18-34`）。 |
| Flash descriptor | **agree** | target/holder/repayment/paramShape/双 priority：`listener/src/adapters/flash-providers.ts:9-46`。 |
| Flash dynamic borrowability | **agree** | 对 graph token 读取 holder `balanceOf` 并选最大单 provider：`listener/src/searcher/solver/flash-liquidity.ts:37-44,90-130`。 |
| Flash “每块一个 Multicall” | **diverge** | 120 秒 timer、无 blockTag、每 400 token 分 chunk：`listener/src/searcher/main.ts:1286-1306`；`flash-liquidity.ts:90-135`。 |

#### 按 adapter/venue/provider 分派点全量复扫

以下是 production `.ts` 中用 equality、switch/case、Map/Record/Set、descriptor、`includes`、template consumer 和 suffix heuristic 多模式复扫得到的分派面；其中正常的动态 registry lookup 不等同于缺陷，但必须进入 cutover inventory。

1. **核心 registry/legacy/identity**

   - `LEGACY_PRODUCTION_ROUTE_EDGES`：`listener/src/searcher/venues/production-registry.ts:30-49`
   - route registry：`:51-72`
   - identity policy 表及动态 protocol projection：`:74-173`
   - `VENUE_CAPABILITIES` venue→factory/runtime adapter：`listener/src/searcher/venues/capability.ts:48-186`

2. **Fluid graph/quote/plan/live fallback**

   - 静态 pool rows、`ADAPTER_MAP`、`switch(pool.adapter)`：`listener/src/searcher/planner/token-graph.ts:144-198,254-266,365-384`
   - hardcoded fallback graph：`token-graph.ts:395-531`；无注入 graph 时由 detector 使用：`listener/src/searcher/detector/detector.ts:49-73`
   - quoter：`listener/src/searcher/solver/quoter.ts:191-210`
   - plan-builder：`listener/src/searcher/solver/plan-builder.ts:92-123,169-214`
   - Revm quote/allowance：`listener/src/searcher/live-backends/revm-live-backend.ts:338-348,478-485`
   - block-scan scanner/main：`listener/src/searcher/detector/blockscan-scanner.ts:317-351`；`listener/src/searcher/main.ts:4746-4782`

3. **Fluid credit/standing-position**

   - taxonomy：`listener/src/searcher/strategy-taxonomy.ts:56-63`
   - lend template allowlist：`listener/src/searcher/templates/path-template.ts:70-77`
   - amount propagation：`listener/src/searcher/solver/amount-propagation.ts:63-70`
   - debt-bps/prefix inversion：`listener/src/searcher/solver/solver.ts:471-475,576-579`
   - submission standing guard：`listener/src/searcher/standing-guard.ts:20-47`

4. **状态、coarse scan、impact**

   - V2/V3/V4 updater 分桶与 V4 poolId：`listener/src/searcher/solver/pool-state-updater.ts:92-128,389-396`
   - Curve exact-mid ID set：`listener/src/searcher/detector/blockscan-curve-mids.ts:18-23,67-88`
   - V4 venue identity：`listener/src/searcher/detector/blockscan-scanner.ts:385-390`
   - solver Fluid/V4 branches：`listener/src/searcher/solver/solver.ts:471-475,576-601`
   - impact adapter map/fallback：`listener/src/searcher/detector/pool-impact.ts:136-200,217-239,351-380,469-480`
   - landed V2/V3/V4 state dispatch：`listener/src/searcher/main.ts:5064-5111`

5. **Discovery、identity、metadata、observation**

   - factory V2/V3 decoder：`listener/src/searcher/active-pool-discovery.ts:40-64`
   - pool metadata ABI dispatch：`listener/src/searcher/build-active-pool-universe.ts:753-799,811-856,897-907`
   - V4 composite identity：`listener/src/searcher/pool-universe.ts:193-268,350-367`
   - pinned V4 parsing：`listener/src/searcher/pinned-warm-pools.ts:85-116,197-214`
   - landed swap/mutation family table：`listener/src/searcher/venues/landed-event-registry.ts:86-208`
   - victim-model table与 variant switch：`listener/src/searcher/venues/victim-model-registry.ts:56-110`；`listener/src/searcher/solver/victim-apply.ts:21-39`
   - oracle trigger→edge：`listener/src/searcher/detector/victim-effect.ts:72-102`
   - Curve/V2 observation branches：`listener/src/searcher/venues/swap-observation.ts:231-243,513-525`

6. **模板、Flash、编码器和协议描述符**

   - legacy/flash/lend slots：`listener/src/searcher/templates/path-template.ts:65-91`
   - flash default/target/provider selection：`listener/src/searcher/planner/planner.ts:192-194,377-438`
   - flash descriptor/default/find：`listener/src/adapters/flash-providers.ts:24-62`
   - flash liquidity projection：`listener/src/searcher/solver/flash-liquidity.ts:37-44`
   - Flash ActionAdapter bootstrap：`listener/src/adapters/index.ts:43-47`
   - protocol ABI/amount/approve/quote descriptor：`listener/src/adapters/protocol-legs.ts:110-185`
   - protocol plan/quote/ActionAdapter consumers：`listener/src/searcher/venues/protocols/protocol-plan.ts:6-23`、`protocol-quote.ts:91-106`、`listener/src/adapters/index.ts:55-57`
   - 低阶 `ADAPTER_DESCRIPTORS`：`listener/src/adapters/adapter-descriptors.ts:24-370`

7. **模式扫描补充**

   - production 中未发现针对 `adapterId` 的 `startsWith(...)` 分派。
   - suffix heuristic 存在：`endsWith("-flash")`（`listener/src/searcher/main.ts:4160-4167`）。
   - venue wildcard 的 `startsWith/endsWith` 在 `listener/src/searcher/venues/capability.ts:223-228`，属于 venue matching。
   - `protocol-instance-discovery.ts:548,1059-1118` 的 `includes` 是注册声明校验；`planner.ts:201-203,835` 的 `slot.adapters.includes` 是动态 template consumer，不应误报为具体 adapter 特判。
   - 正常动态索引包括 `listener/src/searcher/venues/route-leg-registry.ts:5-91` 和 registry-derived manifest `listener/src/searcher/venues/route-family-manifest.ts:39-75`。

#### §5.1/§5.2 行号锚点抽查

| 锚点 | 结果 |
|---|---|
| `main.ts:1723` 单一 `blockScanBusy`；`:1781` `skipped=busy` | **agree**（`listener/src/searcher/main.ts:1723,1778-1784`） |
| WarmSpec 四桶 | **agree**（`listener/src/searcher/venues/route-leg-adapter.ts:73-81`） |
| `warm_plan`/`warm_v2v3` | **agree**（`listener/src/searcher/main.ts:1955-1969`） |
| `warm_verify`/`v3_tick_meta` | **agree**（`listener/src/searcher/main.ts:1977-2002`） |
| `warm_curve` → `warmBlockScanCurves` | **agree**（`listener/src/searcher/main.ts:2012-2028,4908-4938`） |
| `pool-state-cache.ts:985` 为顺序 await | **锚点偏移**：`:985` 是 slice，loop 为 `:981-1005`，真正 await 在 `:993`；两轮 await 在 `:853,:893` |
| `protocol_mids` → `buildBlockScanProtocolMids`、并发 24 | **agree**（`listener/src/searcher/main.ts:2085-2098,4621-4724,731-736`） |
| `curve_mids`/`scan`/`refine` | **agree**（`listener/src/searcher/main.ts:2100-2111,2138-2189`） |
| `main.ts:4427-5016` 含四桶 consumer | **agree，但范围过宽**；直接 literal/capability 分派集中在 `:4427-4453,4652-4724,4746-4782,4954-5019` |
| “Curve/protocol/external 都逐 edge” | **diverge**：protocol/external 逐 edge；Curve 已按 pool/chunk 合批，但两轮及 chunks 串行 |
| 226 pools/8 chunks/9.6s、1,879 quotes/11.6s | **checkout 无法独立重验**；代码只证明 chunk=31、两轮、并发配置与执行结构，数值仍属外部 live 证据 |

### 10.4 verdict

Fable 的双 lane、source-N 动态状态、stateKey 去重、动态 flash borrowability、显式 activation delta 和“小提交用于 shadow 开发”应并入 canonical；固定 `T-10`、立即全程 abort、`≤200` 硬门、F0/F1/F3 横向直进 main、逐 wei 全局等价、Fluid backrun 无损及“每块一个 Multicall/final sim 已有 lender 相等断言”应放弃。

其中“显式 activation delta”只适用于 additions；baseline-active removal 已进一步收紧为独立
`approved_deactivation`，不属于 equivalence/performance gate，也不得把减边计为提速。

## 11. 最终收敛索引（2026-07-23）

完整逐项裁决位于 canonical
[§11 Fable 对照审计与最终收敛](adapter-family-line-plan.md#11-fable-对照审计与最终收敛)。摘要：

| 类别 | 结论 |
|---|---|
| Fable 更强并已采纳 | `deriveMids` 纯度/stateKey 唯一调度/batched fallback/event 仅提示；更细的历史串行证据；可执行 inventory schema；零 venue 特判机器门 |
| 修正后采纳 | F0–F5 仅作为 shadow 开发 work packages；`>200 LOC` 只触发 review；手工现状矩阵只做生成式 inventory 的种子 |
| 新增验收 | challenger 不可见的真实 conversion 更新块 blind sentinel，验证 N-1→N mid 与自然候选集同块变化 |
| 明确否决 | `T-10`、硬分段预算、默认暂停 Fluid 覆盖、route 化 flash、立即取消、逐片 production cutover、lender equality |
| 事实纠正 | Fluid/legacy 特判远多于三处；flash 不是每块一个 batch；protocol `prepared` 不是全 null；flash funding 不能由 swap/protocol-only lane 表达 |

收敛后的唯一组合是：

```text
adapter-family-line-plan.md  = 架构、施工、inventory 与验收范围
gates.md                     = 机器验证合同
本文                         = 已完成审计的来源记录，不再参与决策
```
