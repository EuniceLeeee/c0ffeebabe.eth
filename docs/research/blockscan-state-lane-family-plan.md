# Block-scan 状态层 family 化 — swap/protocol 双 lane 时效架构（完整图 <10s）

> 基线：`origin/main @ ad35790`（已含 adapter-family-auto-discovery 合并）。
> 本文是 [codex-adapter-family-auto-discovery-plan.md](codex-adapter-family-auto-discovery-plan.md) 的姊妹篇：
> 那份把**执行层**做成"一条管道，family 只提供差异"（§4）并已落地第一版（§14）；本文把同一 doctrine 延伸到
> **block-scan 的状态刷新/时效层**——今天它还是 `main.ts` 里按 `WarmSpec` 四桶分派的串行大 switch。
> 版本：v2，Fable 5 重写（2026-07-23），替换 2026-07-22 初稿；所有行号锚点按 `ad35790` 重新核实。
> 状态：**设计稿。未实现、未部署；busy 调度未修复；本文不使任何历史 gap 变为 fixed。**

## 0. 证据：为什么必须做（live 已锁定，非推测）

tx `0x055f5c…` 复盘的最终事实：live funnel 里**没有**该路线"发现后放弃"的记录——所需源块被整轮跳过。

| 事实 | 数值 | 出处 |
|---|---|---|
| `source=25585379` 的 pass 总耗时 | **28,739ms** | 生产日志（SSM `4afc0b54`）|
| 其中 Curve warm | 9,629ms | 同上 |
| 其中 protocol mids | 11,630ms | 同上 |
| 两项合计 | 21,259ms ≈ **74%** | 同上 |
| `25585380`（目标源块）、`25585381` | `skipped=busy`（[main.ts:1781](../../listener/src/searcher/main.ts:1781)）| 同上 |
| 图规模 | 29,220 边 > 20,000 → pass 预算升至 30s | 同上 |
| refine 结果 | 预留 8s solve 后耗尽：`exactRouteProbes=0`、`deadline=1`，solve 未运行 | 同上 |
| funnel 事件 | 该块 4 条 `opportunity_seen`/5 条 drop 全是其他 mempool 候选，无本路线 | `analysis:block-activity`（SSM `1732ec95`，exit 0；manifest SHA `90cd32d7…a08c9`）|

busy 的机制在代码里逐字可见：`blockScanBusy` 是**单个布尔**
（[main.ts:1723](../../listener/src/searcher/main.ts:1723)），无队列、无抢占、无历史源块补扫——
`25585382` 只会扫新 state，永远不会重建 `25585380`。

## 1. 根因：执行层 family 化了，状态层没有

执行层已经是目标形态：`RouteLegKind = "swap" | "protocol-conversion" | "compat"`
（[route-leg-adapter.ts:28](../../listener/src/searcher/venues/route-leg-adapter.ts:28)），每个 family 拥有
`buildEdges / quoteExact / buildPlanFragment / readMid`，注册源唯一（plan doc §14 边界 1）。

但状态层的声明只有四个桶（[route-leg-adapter.ts:73](../../listener/src/searcher/venues/route-leg-adapter.ts:73)）：

```ts
export type WarmSpec =
  | { kind: "mutable-pool"; cache: "v2" | "v3" | "v4" }
  | { kind: "curve-pool" }
  | { kind: "external-mid" }
  | { kind: "protocol-mid"; priority: 0 | 1 | 2; quotePrewarm?: … };
```

于是 `main.ts` 按桶各写一套刷新逻辑（消费点散布在
[4427](../../listener/src/searcher/main.ts:4427)–[5016](../../listener/src/searcher/main.ts:5016)），并且
pass 是**纯串行阶段链**——每段顺序 `await`，阶段名就是代码里 `passBudgetExceeded(stage)` 的实参：

| 阶段（按执行顺序） | 代码锚点 | 实际行为 |
|---|---|---|
| `warm_plan` | [main.ts:1956](../../listener/src/searcher/main.ts:1956) | 计划 |
| `warm_v2v3`（含 v4） | :1962 `await warmBlockScanV2V3` | **专用批处理——这是 Uni 快的唯一原因** |
| `warm_verify` / `v3_tick_meta` | :1987 / :2002 | 校验/元数据 |
| `warm_curve` | :2012 `await` [warmBlockScanCurves:4908](../../listener/src/searcher/main.ts:4908) | 226 池 × 8 chunk × **两轮**；chunk 在 [pool-state-cache.ts:985](../../listener/src/searcher/solver/pool-state-cache.ts:985) **顺序 await** → 9.6s |
| `warm_verify_curve` | :2046 | 校验 |
| `protocol_mids` | :2085 `await` [buildBlockScanProtocolMids:4621](../../listener/src/searcher/main.ts:4621) | **逐 edge task**（签名直接收 `edges[]` + `concurrency`）：约 1,879 个 protocol/external quote × 并发 24（[main.ts:732](../../listener/src/searcher/main.ts:732) 默认）≈ 79 波 → 11.6s |
| `curve_mids` | :2100 `await buildExactBlockScanCurveMids` | 追加串行段 |
| `scan` → `refine` | :2138 / :2155 | 到这里预算已尽 |

结论一句话：**Uni 快是因为它独享批处理；Curve/protocol/external 慢是因为逐 edge + 串行，不是因为"每块刷新"
本身。** 所以正确修法不是给 Curve、ERC4626、wstETH 一个个打缓存补丁，而是把 §4 的 doctrine 搬到状态层：
**一个协调器，family 只声明读取差异。**

## 2. 时效契约：按 lane 统一规则，**不是统一 TTL**

设计过程中"protocol 统一 TTL 10 blocks"曾被提出，**已撤回**（用户本人否决："要是突然有个区块汇率大更新了
不就找不到机会了"）。撤回理由成立且是本契约的基石：

- 套利机会往往恰好发生在**更新块**：ERC4626 因 donation/harvest/loss 单块跳变；wstETH 汇率随 oracle report
  离散更新；PSM `tin/tout` 一次治理直接改；oracle 类协议单块跳变。
- stale mid 的失败模式是**假阴性**：旧 mid 看起来无利 → coarse scanner 不产候选 → exact probe / final sim
  根本不执行。**final sim 只能过滤假阳性，救不了假阴性**——所以"最后有 sim 兜底"不构成缓存正确性论据。

契约（lane 统一规则，实现差异由 family 声明）：

| 数据 | 允许的块 | 责任方 |
|---|---|---|
| Graph topology（成员/拓扑） | 允许滞后，最多 **T-10** 已验证 snapshot | 后台 discovery，不在热路径 |
| Swap 动态价格状态 | **source block N** | swap lane：有可靠事件的池只刷 changed；无可靠事件的 family 每块读最小 sentinel |
| Protocol 动态兑换状态 | **source block N** | protocol lane：每唯一实例批量读一次最小状态 |
| Coarse mids | 从 N 的最小状态**本地推导** | 各 family 的 `deriveMid` |
| Exact probe / final sim | **source block N** | 现有 solver/sim，不变 |

TTL 仅允许用于**静态**部分：schema、call descriptor、decimals、拓扑、后台完整性巡检。事件驱动只能做
"优先刷新"，不能做唯一失效依据——Curve NG 的 `stored_rates` 可因外部依赖变化而无目标合约日志，ERC4626
同理。**没有可靠事件证明的 family，要么每块批量读最小状态，要么其旧 mid 不得用于硬拒绝。**

回答两个已问过的问题：

- **"Curve 为什么要每块？"** —— 动态状态（A/fee/offpeg/balances/stored_rates）必须每块，因为 rate 有链上
  外部依赖；但结构信息（coins/pool-kind/schema）长期缓存。Curve 今天慢是两轮串行 + 逐边解析 metadata，
  不是每块刷新的物理代价——批处理后应与 Uniswap 同量级。
- **"protocol mids 波动小，用 T-10 行不行？"** —— 拓扑可以 T-10，动态兑换率不行（见撤回理由）。真正省时间
  的不是让价格变旧，而是把约 1,879 个逐 edge quote 压成"每实例一次最小状态读 + 本地派生"。

## 3. 接口：`WarmSpec` 收敛为 `BlockScanStateCapability`

调度层只有**两个 lane**（已拍板），直接复用 `RouteLegKind` 的 swap / protocol-conversion 二分
（`compat` 随 plan doc Slice 6 清退）。family 声明"怎么读、怎么解码、怎么算"，**不得自己决定调度**：

```ts
interface BlockScanStateCapability {
  readonly lane: "swap" | "protocol";
  stateKey(edge): string;                   // 按池/实例去重；N 条 edge 共享一个 key
  staticReadPlan?(edge): Call[];            // coins/token/fee/schema —— 长期缓存
  dynamicReadPlan(edge, schema): Call[];    // 当前块 N 的最小动态状态
  decode(results): StateSnapshot;
  deriveMid(snapshot, edge): Mid;           // 纯本地：一个 snapshot 派生 N 条 edge
  eventDependencies?(edge): Address[];      // 仅"优先刷新"提示
  batching: "multicall" | "rpc-batch";      // 依赖 msg.sender 的走固定 from 的 JSON-RPC batch
}
```

共享协调器（唯一 owner，最终取代 main.ts 的四桶 switch）：

```
完整 graph（拓扑可 T-10）
  ↓ 按 lane + stateKey 分组去重
  ↓ refreshSwapLane(N) ‖ refreshProtocolLane(N)   —— 两 lane 并行
      每 lane：dedup → dynamicReadPlan → Multicall/RPC batch（source-block N pin）
             → decode → deriveMid 映射回所有原始 edge → 原子发布 snapshot
  ↓ 全 lane 就绪后运行完整 graph scanner（edge 数、顺序、hash 不变）
```

职责切分沿用 §14 的边界语言：

- **协调器统一拥有**：source-block pinning、stateKey 去重、schema cache、批处理、deadline/AbortSignal、
  事件失效提示消费、snapshot 原子发布、telemetry。
- **family 只声明**：Uni reserve/slot0 数学、Curve A/rates/offpeg、DODO PMM 状态、Balancer router quote、
  ERC4626 preview 语义。这些链上语义**不能强行统一**——否则"统一方法"只能二选一：全部每块重读（回到 20+s）
  或全部缓存（假阴性）。
- **协调器不是 owner**（对应 §14 边界 6）：它不进 `PRODUCTION_ROUTE_ADAPTERS`、不拥有 pool/edge/action ID；
  capability 挂在真实 adapter 对象上，`WarmSpec` 由它投影兼容，不允许出现第二份 family 状态表。

### 3.1 硬护栏（防退化，conformance 必须断言）

1. **`deriveMid` 禁止读链**——只吃已 fetch 的 snapshot。谁在 deriveMid 里调 quoteExact，谁就把设计退回
   逐 edge = 原地回到 11.6s。这是全设计成立的前提。
2. **一个 stateKey 只读一次**——N 条同池/同实例 edge 共享一次读取再映射回去。这是 N→1 收益的本体
   （1,879 edge task → 少数几个 batch）。
3. **stale/unresolved mid 不得把路线判成 no-opportunity**——只能标"需 exact probe"，不能硬拒。
4. **无法本地派生的 family**（如 Metronome 复合方向）才走批量 quote fallback，且必须合入 batch，不逐 edge。
5. **duplicate-key 胜出规则、edge 顺序、graph hash 不变**——批处理是实现细节，不许改变可观测输出。

## 4. busy 调度修复：latest-head 单槽抢占

`blockScanBusy` 布尔改为 latest-head single-slot：

- 新 head **取消**进行中的 pass（AbortSignal 贯穿 warm/mids/scan/refine/solve），只保留最新 pending source；
- 被取消 pass 的 RPC/worker 完全 settle 后才复用 Anvil/cache（绝不并行两个共享状态的 pass）；
- final sim 前后、submit 前**重新校验 source block hash**；
- **不排队历史块**：`25585380` 错过就是错过；解法是 <10s 让下一个不再错过，不是补扫历史。

## 5. <10s 预算（目标，非结论）

严格口径：**29,220 边不减、所有 slow edge 仍读当块状态**。

| 阶段 | 目标 |
|---|---|
| head → 完整状态就绪（双 lane 并行 + 批处理） | ≤ 4.5s |
| 完整图 scanner | ≤ 1.8s |
| exact probe / solve / final sim | ≤ 3.2s |
| 余量 | 0.5s |
| **p95 head_seen → scanner_done** | **< 10s** |

预扫描只读阶段直接用 canonical provider 的 source-block pinned reads；Anvil fork 后台准备，候选进
solve/final sim 时 join。

## 6. 不能采用的捷径（对抗清单）

| 捷径 | 为什么不行 |
|---|---|
| 把 30s 预算直接改 10s | scanner 前就退出，什么都没扫 |
| 只把 Curve 与 protocol mids 并行 | 推算约 19.1s，仍不够 |
| 统一 TTL 让动态价格变旧 | 机会在更新块；制造假阴性（§2） |
| mid 只按目标合约日志失效 | NG stored_rates / oracle / ERC4626 无目标日志也会变 |
| 只调大 `MID_CONCURRENCY` | 可能打爆 Anvil/reth，且无结果等价证明；逐 edge 模型没变 |
| 先扫 V2/V3/V4、慢图以后再说 | "完整当块状态"在约束内时，这不是完整图 <10s |

## 7. 迁移顺序（strangler，逐 wei 等价）

沿用 plan doc 的 Slice 纪律，每步单独提交、单独等价验证，任一步 mid 不 bit-identical 即 fail：

1. **Slice S0**：建 `BlockScanStateCoordinator`，先只包装现有 V2/V3/V4 路径。同 source block、同图，
   每条 edge mid **bit-identical**；输出/日志/telemetry 结构不变。
2. **Slice S1（Curve）**：schema/coins 缓存；两轮串行 Multicall 合成一轮动态 batch；chunk 4 路有界并发，
   结果按固定顺序提交 cache；本地派生所有方向。不减覆盖、不引入 stale NG rate。
3. **Slice S2**：DODO / Balancer / Curve-underlying 接入，**删除 `external-mid` 大桶**。
4. **Slice S3**：protocol conversion 接入同一 capability（ERC4626 / wstETH / PSM / Metronome / Eigenpie 的
   `deriveMid` 或声明式 fallback）。
5. **Slice S4**：删除 [buildBlockScanProtocolMids](../../listener/src/searcher/main.ts:4621)、
   [warmBlockScanCurves](../../listener/src/searcher/main.ts:4908) 及 main.ts 全部按桶分支；`WarmSpec` 由
   capability 投影为兼容 shim 后清退。
6. **Slice S5**：latest-head 抢占（§4）替换 `blockScanBusy` 布尔。抢占独立成片，便于单独 A/B 归因。

## 8. 与 adapter-family plan / Eigenpie gap 的关系

- 执行层 family 化 = plan doc §4/§14，已在 main；本文给**同一个** adapter 对象加 `blockScanState`
  capability——同一注册单元、同一 lane 二分，不新建第二套 adapter、不产生第二真相源。
- 与 §15.2（tx4cca）**正交**：Eigenpie 的残余问题是 enumeration（canonical PancakeV3 首腿未进完整
  opportunity 集合）+ 保守 EV 拒绝（net `-41575352949598 wei`），属于发现/排序/经济层；本文解决的是
  状态刷新延迟导致的 `skipped=busy`。两者各自挡在"证明我们主动发现并主动放弃"之前，需分别关闭。

## 9. 验收门（升 fixed 的硬条件）

1. **等价**：同一完整 graph snapshot 生产形态 A/B——route fingerprint、候选排序、probe 符号、final sim
   结果逐项等价；批处理重排不得改变任何可观测结论。
2. **延迟**：head_seen → scanner_done **p95 < 10s**，连续重块（`25585379→25585380` 型）`skipped=busy` 归零。
3. **freshness**：构造一个"更新块汇率跳变"样本（ERC4626 donation 或 wstETH oracle report 块），证明改后
   当块即捕捉，未被任何缓存层漏掉。
4. **护栏**：conformance 断言 §3.1 全部五条（deriveMid 无链读、stateKey 单读、stale 不硬拒、fallback 合批、
   输出不变量）。
5. 诚实边界：`tool-index --select latency,performance,block-scan` 当前**无工具覆盖 latency/performance**——
   所以本文只能声称"修法可实施"，<10s 是目标不是结论；等实现后需先补延迟测量工具再谈达标。只有 scanner
   在真实 live/replay 上**自发枚举该类路线并通过 final sim**，相应历史 gap 才升 `fixed`。

## 10. 证据与工具凭据（provenance）

- 生产只读查询：SSM `1732ec95-7b47-457e-8e9f-e5bd5848ec33`（block-activity，exit 0）、
  `4afc0b54-bbe4-40f5-93b1-0d2cb1eef0e9`（根因日志）、`fd518ba2-cad9-4329-b32a-ab49504d3fbc`（事件切片）；
  生产 manifest SHA `90cd32d7…a08c9`。
- 代码锚点全部按 `origin/main @ ad35790` 于 2026-07-23 重新核实（§0/§1 行号）。
- "并行化仅得 ~19.1s"为推算，"<10s"为预算目标——两者都不是实测，文中已按 §9.5 标注。
