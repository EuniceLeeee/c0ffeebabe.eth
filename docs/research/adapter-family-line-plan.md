# Codex — Universal AdapterFamily 生产线与 Block-Scan 当前状态统一计划

> 本文是当前 canonical 总纲；被它取代的分拆 state-lane 草稿不再作为设计依据。
>
> 状态：计划稿；尚未实施，尚未证明 `<10s`，live busy gap 未 fixed。
>
> 基线：`origin/main @ ad35790a8fa6aa5e4f9529d1099600a270a0d1ea`。
>
> 本文合并三项工作：已经进入 main 的 adapter-family 自动发现第一版、所有高阶执行语义收敛到唯一
> production family registry，以及 live `skipped=busy` 暴露出的 block-scan 状态刷新问题。本文只把
> 对话中已经裁定的事项写成硬边界；仍需 benchmark/A/B 才能决定的参数与实现选择单列，不再把讨论提议
> 写成决定。

## 0. 最终决定

### 0.1 已决定

1. **性能优化不能靠减边。** `<10s` 不能靠降低 top-N、删除一个已激活 family 的 routes、缩小候选 universe
   或跳过 slow family 达成。统一 family cutover 若把不完整的 legacy adapter 退出生产，必须把它单独记成
   `activation_delta`；它不能被包装成输出等价或性能提升。
2. **所有高阶生产执行语义都必须是 `AdapterFamily`。** 不再因类别不同维护 route adapter、flash descriptor、
   compat adapter 等平行真相源。Swap、protocol conversion、flash loan、credit，以及未来真正进入生产的
   liquidity 都是同一个 discriminated family union 的成员。
3. **一个 family 继续对应一种完整编译语义。** 新实例由 family discovery 自动收入；同语义实例不新增
   family、不在 `main.ts` 加分支。
4. **生产激活只有一条线。** 只有满足完整 `AdapterFamily` 合同并进入唯一 registry 的实现才会进入 discovery、
   graph、planner、quote、funding 或 encode。旧 adapter 可以保留源文件，但不得为了“先跑起来”保留 fallback、
   legacy edge、descriptor table 或 consumer switch；未完成迁移的文件是明确不生效的孤岛。
5. **自动发现与实时状态刷新是两层能力。**
   - discovery/identity/probe 决定“这个实例是什么、能生成哪些 verified routes”；
   - block-scan state 决定“这些 routes 在当前 source block 的价格和池状态是什么”。
6. **动态状态必须绑定当前 source block `N`。** 用于 pruning、ranking、quote sign 或 flash borrowability 的
   动态状态不能统一使用固定 TTL、旧 block 结论或“平时变化不大”的假设。
7. **coarse price 调度只有两个 lane。**
   - swap lane；
   - protocol-conversion lane。

   Flash loan 仍是 family，但它提供 funding/liquidity capability，不伪装成价格 edge，也不进入 coarse-price
   lane。不为 Uni、Curve、DODO、ERC4626 或 flash provider 各造一套 scheduler/cache/timer。
8. **family 声明语义，coordinator 负责调度。** Adapter 声明 state identity、所需 reads、decode 与本地数学；
   coordinator 负责去重、batch、并发、deadline、取消、source pinning 和原子发布。
9. **`main.ts` 不拥有 venue 语义。** 终态只调用 family-derived runtime views，不再判断具体协议或 flash provider。
10. **公共 framework 只复用已经证明相同的 invariants。** Framework 不是 family、没有 registry ID；family
   只保留 identity、ABI、rounding、calldata 等真实差异，因此应该很轻。
11. **live 当前/近期状态直接读本地 reth。** Anvil/Revm 用于需要状态变化的 exact solve/final sim；外部 archive
   RPC 只用于本地 pruned reth 无法回答的历史 replay。
12. **性能目标是激活 family 完整图的六个生产阶段在 10 秒内完成。** 固定交易
   `0x055f5c5df75f4a1006d5af0fcff60218b3acb856c3ef988a5089147794908f4b` 是本轮严格交易级验收：
   从 `source_head_seen` 到 production EV decision 的 steady-process/fresh-source-state p95 必须
   `<10,000ms`，每个物理阶段分别记录 wall/cumulative time。该样本是必要条件；系统性
   scanner/performance 仍必须同时通过完整 cohort、输出等价性和 paired live A/B，不能用单笔 replay 冒充
   live p95。

### 0.2 已否决

- topology 固定或最多使用 `T-10`；
- protocol/Curve dynamic mid 使用固定 10-block TTL；
- 把 30 秒 timeout 直接改成 10 秒；
- 只提高 `MID_CONCURRENCY`；
- 只把 Curve 与 protocol 两个旧函数并行；
- 用 stale/unresolved mid 把路线判成 `no opportunity`；
- 为每个协议新增 `main.ts` 特殊优化；
- 继续维护独立 `FLASH_PROVIDER_DESCRIPTORS` 作为第二个高阶执行注册源；
- 继续保留 `LEGACY_PRODUCTION_ROUTE_EDGES` 作为终态例外；
- 给未完成 family 合同的旧 adapter 留 production compatibility wrapper；
- 在同一分支部署一个“部分新 registry + 部分旧旁路”的中间态；
- 把所有协议塞进一个内部 `switch` 的巨型 umbrella family；
- 把 `ActionAdapter`、`erc20-approve`、`assert-balance` 这类低阶 BotVM 编码积木冒充高阶 family；
- 用 Adapter Replay 代替 discovery/enumeration 或 live performance 验收；
- 把六步 checker 恢复成部署强制开关。

### 0.3 尚待实测，不在本文伪装成决定

- 每个 lane 的 batch 大小与 concurrency；
- Multicall 与 JSON-RPC batch 的具体分配；
- 新 head 到来时是立即取消旧 pass，还是让不可取消的短任务 settle 后只运行最新 pending head；
- state read 失败时，是停止整个完整图扫描，还是继续诊断已解决 edges 并把本轮标成 incomplete；
- 每个 family 内部 read/batch/concurrency 如何分配；§8.4 只冻结完整六阶段总预算，分段耗时先如实记录，
  不预设可被针对性优化的硬配额；
- graph discovery 的刷新 cadence、base snapshot 大小与 current-block delta 的实现；
- 如何证明 `GraphView(N)` 的 completeness watermark 已覆盖到 source block `N`；唯一已定边界是不能用固定
  `T-k` 许可替代这个证明；
- `skipped_busy=0` 是硬门还是 paired window 的覆盖指标。

## 1. 两笔证据不能混在一起

### 1.1 live busy 样本

固定验收交易：

```text
tx=0x055f5c5df75f4a1006d5af0fcff60218b3acb856c3ef988a5089147794908f4b
landed_block=25585381
tx_index=271
blockscan_source=25585380
source_hash=0x6cf953cd24df65a1d0505aa661b8361b69178dbc74eb73085e3531df284c8f22
source_state_root=0x8bb7fd340dc4088cf2572be4915b861e5dc5fe4827da2ad56a7672fbbcae678e
```

核心本金闭环由 canonical receipt/call trace 独立得到；按 scanner 的 canonical rotation 表示为：

```text
WETH
  → UniV3 0xe0554a476a092703abdb3ef35c80e0d76d32939f
USDC
  → UniV4 poolId 0x3ea74c37fbb79dfcd6d760870f0f4e00cf4c3960b3259d0d43f211c0547394c1
WBTC
  → UniV3 0xe6ff8b9a37b0fab776134636d9981aa778c4e718
WETH
```

WBTC/USDT flash 借还是外围 funding shell；残余 WETH unwrap 是利润退出，不是第四条 swap edge。这个 route
oracle 与 landed amounts 只供运行后的 trusted comparator 使用，不能传给被测 searcher 或 solver。
在 parent state 对原始 calldata 的独立 replay 曾得到 `+20,602,902,877,952 wei`，所以它可以作为
`source=25585380` 的 block-scan correctness/performance fixture；landed canonical net
`-21,825,125,369,329 wei`，因此不能用它宣称“正收益历史交易已修复”。

目标机会需要 source block `25585380`。生产 A 的上一轮 `25585379` 运行了 `28.739s`：

```text
block=25585380 skipped=busy
block=25585381 skipped=busy
```

主要耗时：

| 阶段 | 实测 |
|---|---:|
| Curve warm | `9.629s` |
| protocol mids | `11.630s` |
| 两者合计 | `21.259s` |
| 完整 pass | `28.739s` |

当时 graph 约 `29,220` edges。状态准备吃完了 refine/solve 预算，最终
`exactRouteProbes=0`、`deadline=1`、solver 没有运行。

因此这个样本只能证明：

- 所需 source block 没有进入 scanner；
- 当前 `skipped=busy` 会整块丢失主动搜索机会；
- 不能说该 route 被 spread、quote、sim 或 EV 主动拒绝。

隔离估算的约 `9.36bps` 不是 live 拒绝证据。整笔 landed tx 扣 gas 后为负，因此交易级验收不强迫 EV
`allow`；它要求搜索器在真实生产 policy 下自然走完六步并输出可复算的 `allow/reject + reason`。本轮把这个
样本升级为架构等价与 busy/latency 的**必要验收样本**，但它仍不能单独证明系统性 live 性能。
旧的 61-edge 隔离图、rank 1 和约 `2.548s` graph-only 结果全部排除：它们没有 solver/final-sim/EV，而且减了图。

### 1.2 tx4cca family 样本

`tx4cca` 的 parent block 是 `25585334`，路线是：

```text
Pancake V3 → Eigenpie deposit → Pancake V3
```

截至当前证据：

- source/identity：pass；
- pair claim/projection：pass；
- source-unseeded exact winner enumeration：partial；
- Adapter Replay quote/solve：pass；
- fork final sim：pass；
- production EV：reject。

它适合验证 Eigenpie family 的 discovery、identity、quote、plan 与 execution，但不能单独证明统一 discovery
管道 fixed，也不能证明 `<10s` 改造。

**禁止写成“tx4cca 因 25585380 busy 未发现”。** 两个样本是两条独立证据链。

## 2. 当前 main 的真实状态

### 2.1 已完成

`main@ad35790` 已有：

- `RouteLegAdapter`、`SwapAdapter`、`ProtocolConversionAdapter` 和 `PRODUCTION_ROUTE_ADAPTERS`；
- DODO V2 已经是旧合同下完整的 `custom-swap:dodo-v2` `SwapAdapter`，含 edge、quote、prepared quote、
  plan 与 observation；它不是“没有 adapter”。但在本文的新 production-family 合同下，它仍缺
  family-owned block-scan state capability，当前 `external-mid` 旁路不能被 grandfather；
- family-owned `buildEdges`、`quoteExact`、`buildPlanFragment`、`readMid`；
- shared observed protocol discovery；
- pair-scoped identity 与 nonzero behavior probe；
- Eigenpie/ ERC4626 共用的 `ReceiptDepositFramework`；
- prepared quote 与低阶 ActionAdapter；
- V2/V3/V4/Curve cache；
- Balancer/Morpho flash 的低阶 ActionAdapter、provider metadata 和 flash-liquidity cache；
- `StateBackend.call` 的 absolute deadline 与 `AbortSignal` 能力；
- 局部 `BlockScanWarmCoordinator`，能为 V2/V3/V4/Curve 规划 full/incremental warm 并处理 reorg。

这里的 `RouteFamilyAdapter` 是架构角色，不要求为了改名再造一套接口。第一步应把现有类型收敛成一个生产
family 合同，而不是为每个协议复制新文件。

### 2.2 尚未完成

- 没有 adapter-owned `blockScanState` capability；
- 没有所有类别共用的高阶 `AdapterFamily` union/registry；
- flash loan 仍由独立 `FLASH_PROVIDER_DESCRIPTORS` 驱动 planner、liquidity cache 与 plan-builder；
- Fluid DEX 仍在 `LEGACY_PRODUCTION_ROUTE_EDGES`，并由 plan-builder switch 编译；这是当前真正的 route-family
  legacy exception；
- `fluidCreditCompatAdapter` 只够 diagnostic/planner equivalence，exact quote 不完整且会留下 standing
  position；不能改个 family 名字后继续 production；
- `fluid-dex-liquidate` 目前只是低阶 ActionAdapter/trace action，不具备
  discovery→state→quote→plan→final-sim 的高阶 family 生命周期；
- 没有统一的 `BlockScanStateCoordinator`；
- swap/protocol lane 尚未并行；
- Curve warm、external mids、protocol mids 仍在关键路径串行；
- protocol/external 仍大量逐 edge quote，没有按逻辑实例去重；
- Curve schema 与 current-block dynamic state 尚未分离；
- slow warm/mids 没有贯穿 absolute deadline/AbortSignal；
- busy 时仍直接丢掉新 head；
- graph/state 仍存在原位分阶段更新，缺少 pass-owned、source-pinned view；
- missing/stale mid 可能被 `null/skip` 吞掉，无法区分无机会与状态不完整；
- 附件所述详细 busy phase、near-threshold route、生命周期事件只存在旧基线的本地脏 diff，尚未进入 main；
- `<10s` 没有可信实测证据。

当前 `WarmSpec` 仍把 route adapter 塞进四个粗桶：

```text
mutable-pool(v2/v3/v4)
curve-pool
external-mid
protocol-mid
```

这正是 execution 已 family 化、实时状态仍未 family 化的缺口。

更完整地说：大多数 swap/protocol execution 已经具备旧 route-family 外形，但生产所有权仍按类别分裂，
Fluid DEX 仍是 legacy，flash loan 仍只有 descriptor，实时状态还依赖 `main.ts` 旁路。本文不是“再迁一个
DODO”，而是一次建立完整 production-family 主线：

- 已满足新合同的实现批量注册；
- 当前生产活跃的实现必须在 cutover 前补齐合同；默认不允许靠静默减覆盖过门；
- 原本就未生产化、或经明确 review 允许退出生产的旧 adapter，可以保留文件但成为零生产引用的孤岛；
- 任何孤岛都不能通过 legacy switch、fallback edge 或 descriptor table 偷跑。

## 3. 目标架构

### 3.1 一个 universal family registry

终态唯一高阶真相源：

```ts
type AdapterFamily =
  | SwapAdapterFamily
  | ProtocolConversionAdapterFamily
  | FlashLoanAdapterFamily
  | CreditAdapterFamily
  | LiquidityAdapterFamily;

const PRODUCTION_ADAPTER_FAMILIES: AdapterFamilyRegistry = createAdapterFamilyRegistry([
  // every production execution family exactly once
]);
```

共同 base 只放所有类别都真正共有的字段：

```ts
interface AdapterFamilyBase<Kind extends AdapterFamilyKind> {
  readonly id: ExecutionFamilyId;
  readonly kind: Kind;
  readonly ownedActionAdapterIds: readonly string[];
  readonly requiredInfraActionAdapterIds: readonly string[];
}
```

类别差异通过 discriminated capabilities 表达，而不是一个充满 optional 字段的大接口：

```ts
interface SwapAdapterFamily extends AdapterFamilyBase<"swap"> {
  readonly route: SwapRouteCapability;
  readonly discovery: SwapDiscoveryCapability;
  readonly pricingState: BlockScanStateCapability;
}

interface ProtocolConversionAdapterFamily
  extends AdapterFamilyBase<"protocol-conversion"> {
  readonly route: ProtocolRouteCapability;
  readonly discovery: ProtocolDiscoveryCapability;
  readonly pricingState: BlockScanStateCapability;
}

interface FlashLoanAdapterFamily extends AdapterFamilyBase<"flash-loan"> {
  readonly funding: FlashFundingCapability;
}
```

Credit/liquidity 使用自己的 typed claim、accounting 与 policy capability，不能为了进入同一 registry 被压成
swap-like `TokenEdge`。`kind` 只是 capability discriminator，不再选择不同 registry 或生命周期。
`compat` 不能成为 production family kind。

Registry constructor 是激活门，不接受半成品：

```text
swap/protocol family:
  discovery + identity + route projection + current-N pricing state
  + exact quote + plan fragment + ActionAdapter coverage + final-sim assertions

flash-loan family:
  provider identity + current-N liquidity + planning/callback/repayment
  + ActionAdapter coverage + conservation/final-sim assertions

credit/liquidity family:
  typed claim + accounting/position policy + execution + final-sim assertions
```

缺任一 required capability 就无法进入 `PRODUCTION_ADAPTER_FAMILIES`。不设置 `enabled=false`、`legacy=true`
或“找不到新 family 再回旧 switch”的逃生口。

从 universal registry 派生现有消费者视图：

```text
route families / RouteLegRegistry
discovery source union + identity resolvers
swap/protocol pricing lanes
flash planning order + default provider
flash liquidity holders
ActionAdapter descriptor coverage
typed category projectors
```

消费者只能调用 canonical registry 自己的 typed view，例如
`PRODUCTION_ADAPTER_FAMILIES.routes()`、`.pricing("swap")`、`.funding()`。终态不保留
`PRODUCTION_ROUTE_ADAPTERS` facade、独立 `FLASH_PROVIDER_DESCRIPTORS` 或
`LEGACY_PRODUCTION_ROUTE_EDGES`。否则 facade/表仍能成为第二入口。

低阶 `ActionAdapter` 仍是 BotVM encoder，例如 `erc20-approve`、`assert-balance`、`balancer-flash` callback
encoder。它不是高阶 family。family-owned encoder 必须唯一 owner；`approve`、`transfer`、balance guard 等
共享 infra encoder 可被多个 family 引用。conformance 分别检查两类 ID、descriptor 与 encoder，不能把共享
infra 错判成 ownership 冲突。

旧 adapter 文件允许留在仓库，但必须满足两条可机器检查的孤岛规则：

1. 不被 `main.ts`、production registry、graph、planner、quoter、solver、plan compiler 或 live backend 的
   production import closure 触达；
2. 不贡献 edge、provider、descriptor、template、warm task、runtime flag 或默认配置。

测试可以直接 import 孤岛用于后续迁移；生产不能。

### 3.2 控制面：自动发现与 source-pinned graph view

沿用已经进入 main 的 discovery/identity 管道，但入口改由 universal registry 派生：

```text
PRODUCTION_ADAPTER_FAMILIES
        ↓
candidate sources
        ↓
identity attestation
        ↓
family behavior probe
        ↓
verified route claims
        ↓
ownership / arbitration
        ↓
graph projection
        ↓
VerifiedGraphView(N)
```

控制面边界不变：

- selector/topic 只提名 candidate，不直接 admission；
- identity 不能依赖 executable instance allowlist；
- codeHash/implementation 只用于 cache invalidation；
- shared framework 不拥有 execution family ID；
- graph 只能包含已通过 claim/ownership 检查的 projection；
- 对 source block `N` 做完整负判定前，view 必须证明自己的 completeness watermark 已覆盖到 `N`；
- 如果 discovery/delta 尚未追到 `N`，本轮只能标 `graph_incomplete`，不能把缺边解释为无机会；
- 不存在“最多允许 T-10”或任何固定滞后许可。

实现可以使用已验证 base snapshot 加 current-block 增量投影，也可以使用其他能证明同一合同的结构。选择仍需
benchmark，但交给 scanner 的只读 view 至少携带：

```ts
interface VerifiedGraphView {
  readonly id: string;
  readonly sourceBlock: number;
  readonly completenessWatermark: number;
  readonly orderedEdgeHash: string;
  readonly metadataHash: string;
  readonly ownershipHash: string;
  readonly edges: readonly TokenEdge[];
}
```

`completenessWatermark < sourceBlock` 时，view 只能产生诊断/正发现，不能产生“完整图无机会”的负结论。
base snapshot 的年龄可以作为 telemetry，但永远不自动转化成准入许可。

### 3.3 数据面：一个 coordinator、两个 price lane

```text
source-pinned VerifiedGraphView(N)
             +
       source block N
             ↓
 BlockScanStateCoordinator
       ├─ refreshSwapLane()
       └─ refreshProtocolLane()
             ↓
 current-N state snapshot
             ↓
 scanner
```

公共 coordinator 负责：

- 冻结 graph version；
- 固定 source block/hash；
- 按 family + state key 分组；
- 合并重复 reads；
- 选择 Multicall/RPC batch transport；
- concurrency、deadline、AbortSignal 与 backpressure；
- generation fencing；
- 原子发布 state snapshot；
- unresolved/resource-limited/aborted 分类；
- 稳定结果顺序与 telemetry。

Adapter family 只负责：

```ts
interface BlockScanStateCapability<Schema, Snapshot> {
  stateKey(edge: TokenEdge): string;
  compileStaticSchema(edges: readonly TokenEdge[]): Promise<Schema>;
  buildCurrentBlockReads(input: {
    sourceBlock: number;
    schema: Schema;
    edges: readonly TokenEdge[];
  }): readonly StateRead[];
  decodeState(schema: Schema, results: readonly StateReadResult[]): Snapshot;
  deriveMids(
    snapshot: Snapshot,
    edges: readonly TokenEdge[],
  ): ReadonlyMap<string, RouteVenueMid>;
  dependencies(edges: readonly TokenEdge[]): readonly string[];
}
```

Adapter 可以声明 call 是否需要固定 `from`、是否 Multicall-safe、是否有跨调用依赖，但不能拥有 timer、TTL、
并发循环或 cache commit。

lane 从现有 adapter `kind` 派生，不维护第二张手工映射：

```text
kind=swap                 → swap lane
kind=protocol-conversion  → protocol lane
kind=flash-loan           → funding capability，不进入 price lane
credit/liquidity          → 只有对应 category runtime 生产化后才启用
```

Flash borrowability 同样绑定 source N，但由 `FlashFundingCapability` 派生 holder、repayment、parameter shape、
planning priority 与 liquidity reads；planner、flash-liquidity cache、plan-builder 不再直接 import provider
descriptor 表。

### 3.4 执行面

```text
VerifiedGraphView(N)
       +
current-N state snapshot
       ↓
coarse scanner
       ↓
exact refine / planner / solver
       ↓
fork/revm final sim
       ↓
global EV / submission policy
```

EV、standing-position、submission policy 继续是全局策略，不进入 adapter。source hash 在 scan、final sim 和
submit 边界复核；过期 generation 不得提交。

## 4. 公共 framework 让 family 保持轻量

### 4.1 ReceiptDepositFramework

已经落地的 `ReceiptDepositFramework` 是本次 universal family 模式的模板。它统一复用：

- `asset → receipt` edge 构造；
- approve requirement；
- exact-in quote 结果检查；
- receipt balance/supply 增加；
- 无 standing position；
- plan fragment 的共同形状；
- nonzero behavior simulation facts；
- final-sim 的余额、mint 与 conservation 约束。

ERC4626、Eigenpie、RockSolid 等 family 只保留自己的：

- candidate source 与 identity；
- event/trace 因果规则；
- quote ABI、rounding 和返回 token 验证；
- calldata selector 与参数；
- family-specific pause/availability；
- ActionAdapter。

Framework **不是** `protocol:receipt-deposit` family，也不拥有 pool/edge/action ID。不同 ABI/rounding/call graph
仍是不同 family；复用 invariants 不等于把协议差异塞进一个 dispatcher。

### 4.2 FlashLoanFramework

Balancer 与 Morpho 当前重复散落在 provider descriptor、planner、liquidity cache 与 plan-builder。迁移时提取
一个共享 `FlashLoanFramework`，负责：

- 选择可借 token/provider；
- current-block liquidity balance reads；
- borrow root 与 callback children 的共同结构；
- repayment/conservation 断言；
- `assert-balance` 与 profit floor；
- final-sim 中 lender balance/repayment 检查。

每个 `FlashLoanAdapterFamily` 只声明：

- provider identity/target；
- liquidity holder；
- repayment semantics（transfer 或 approve-pull）；
- callback/parameter shape；
- planning priority 与 liquidity tie-break priority（两者不能合并）；
- 低阶 flash ActionAdapter。

FlashLoanFramework 也没有 registry ID；Balancer 与 Morpho 仍是两个 family，因为 target、callback 和 repayment
编译语义不同。

### 4.3 Framework 提取规则

只有至少两个真实 family 共享、且能写成共同 assertion 的行为才进入 framework。禁止：

- 为了减少文件数提前造万能 framework；
- framework 内按协议名/address switch；
- framework 自己扫描、注册实例或拥有 scheduler；
- 用公共形状洗掉 family-specific rounding、state delta 或 safety policy。

因此 universal family 不是“大 adapter”。它是一组很薄的 family modules，共享少量经过实证的 frameworks。

## 5. Curve 和 protocol mids 到底是什么

### 5.1 Curve warm

Curve warm 是为了取得 coarse scanner 本地报价所需的池状态，不是 discovery，也不是每块重新“找 Curve 池”。

当前把结构信息和动态状态混在两轮读取中：

| 可长期缓存的结构 | 当前块动态状态 |
|---|---|
| coins、pool kind、coin decimals、call descriptor | A、fee、offpeg、balances、stored_rates |

慢的主要原因是：

- 多个 pool chunk 串行；
- 每个 chunk 两轮 Multicall；
- 已知 schema 仍重复读取；
- dynamic batch 完成后才进入后续 protocol mids。

目标不是让 Curve 用旧状态，而是：

1. graph/schema 更新时编译 coins/kind/decimals/read plan；
2. source block N 只读取真正动态的 fields；
3. 多个 batch 有界并行；
4. 全部结果完成后按稳定 state key 原子发布；
5. 一份 pool snapshot 派生所有方向 mids。

因此 Curve 与 Uni 具有相同的 current-source freshness contract，但保留不同的状态数学。

### 5.2 protocol mids

`protocol mids` 不是协议自动发现或 graph 更新。它是 coarse scanner 用的当前兑换率，例如：

- ERC4626 deposit/redeem rate；
- wstETH wrap/unwrap rate；
- PSM tin/tout；
- Eigenpie asset→receipt quote；
- Metronome conversion quote。

当前约 1,879 个 protocol/external edge tasks 会造成大量重复 RPC。正确优化是：

1. 按逻辑实例和方向去重；
2. 对唯一实例读取一次当前块最小状态；
3. 打包成少数 Multicall/RPC batch；
4. 本地派生所有相关 edge mids；
5. 无法本地派生的 family 才走 batched view quote。

动态 rate、fee、pause、oracle、donation/harvest/loss 可能单块跳变。final sim 能过滤错误的正候选，但救不了
stale mid 在 coarse scanner 制造的假阴性。因此 dynamic mid 不使用固定 TTL。

## 6. 调度与本地节点分工

### 6.1 候选实现共同的正确性约束

- 同一时刻不能有两个 pass 修改共享 Anvil/cache；
- 新 head 不能继续只输出一个无上下文的 `skipped=busy`；
- 每个 pass 必须记录 active generation、source block、graph version、当前阶段和 elapsed；
- 旧 generation 的 late result 不能写入新 generation；
- state incomplete 不能伪装成完整图 `no opportunity`；
- current-block read 使用本地 reth；
- fork preparation 可以和只读 state lanes 并行，但 exact/final sim 前必须 join 正确的 source fork。

### 6.2 推荐实现，需 benchmark 裁决

建议实现 latest-head single-slot：

```text
head N
  ↓
generation N running
  ├─ 完成：publish N → scan
  └─ head N+1 到达：
       cancel 可取消的 N 工作
       pending 只保留 N+1
       旧共享资源 settle 后启动 N+1
```

这是针对当前“无队列、无抢占、直接丢新块”的最小调度修法，但它是待实测实现选择，不是对话中已经证明的性能结论。

如果某个 transport 不能真正 abort：

- 必须用 generation token 丢弃结果；
- 共享 Anvil/cache 在旧任务 settle 前不能复用；
- 不允许 orphan promise 与新 solver 竞争同一个 backend。

### 6.3 reth / Anvil / archive RPC

```text
head N
  ├─ local reth: current-N swap reads
  ├─ local reth: current-N protocol reads
  ├─ local reth: current-N flash liquidity reads
  ├─ local reth: canonical source hash
  └─ Anvil/Revm: forkAt(N) for stateful solve/final sim
```

依赖固定 `msg.sender` 的只读 quote 可以使用 reth `eth_call(from=...)`。只有需要多调用状态变化、余额注入或真实
执行验证时才进入 Anvil/Revm。近期 live block 不需要为了普通 state reads 抢外部 archive RPC。

## 7. 实施顺序

### 7.1 交付单位：一条新生产线，一次 cutover

实现可以分提交，生产入口不能分阶段混跑。整个开发期间：

```text
旧 production line                    新 family line
保持冻结、只作 baseline               在 shadow/test 中完整构建
没有 “new miss → legacy fallback”     没有生产副作用
                 ↓ parity + activation review
                       一次切换
                 ↓
新 family line 成为唯一 production line；旧线失去生产引用
```

这不是逐协议 strangler。允许保留旧源文件，不允许部署“部分新 registry + 部分旧 switch”的半成品。

### 7.2 冻结 inventory 与 activation manifest

以开工时的最新 `origin/main` 冻结 baseline，并从真实 import/registry/consumer closure 生成 inventory：

```text
execution semantic
baseline_active?
current owner(s)
required family kind/capabilities
new family complete?
cutover disposition = active_family | legacy_island
activation_delta reason/reviewer
```

默认规则：

- baseline-active semantic 必须在同一批次补齐 family 后继续 active；
- DODO 属于 baseline-active，因此要复用现有实现补 `pricingState`，不是新建第二个 adapter，也不能默认丢进孤岛；
- 原本未接 production、或明确 review 同意退出的 partial adapter 才可成为 `legacy_island`；
- activation manifest 有任何未审 `active → island` 就阻断 cutover。

同时冻结 ordered graph、metadata、ownership、admission、flash provider order/default、template、calldata 与
ActionAdapter coverage，作为 cutover 前后的机器对照。

### 7.3 建 universal family kernel

一次建立：

- `AdapterFamily` discriminated union；
- `AdapterFamilyRegistry` 与 `PRODUCTION_ADAPTER_FAMILIES`；
- 每种 kind 的 required-capability validator；
- registry 原生 `.routes()`、`.pricing(lane)`、`.funding()`、`.actionIds()` 等 typed views；
- family ID、kind、ActionAdapter IDs、claim ownership 和 derived-view 唯一性 conformance；
- production import-closure 检查，禁止 legacy island 被 live consumer 触达。

这里不写 Uni/DODO/Fluid/Balancer 的协议分支。类别只影响 required capabilities，不产生第二个 registry。

### 7.4 建共享 framework 与 runtime coordinator

- 保留并加固 `ReceiptDepositFramework`：统一 asset→receipt edge、approve、exact-in result、receipt delta、
  no-standing-position、plan/final-sim assertions；
- 新建 `FlashLoanFramework`：统一 provider selection、liquidity read、borrow/callback shell、
  repayment/conservation、profit floor 与 lender final-sim assertions；
- 建 `AdapterRuntimeCoordinator`，从 registry capability views 一次准备：
  - `VerifiedGraphView(N)`；
  - swap/protocol current-N pricing state；
  - current-N flash funding state；
  - generation/deadline/AbortSignal/telemetry。
- 内部 block-scan price scheduler 仍只有 swap/protocol 两 lane；flash funding 不伪造 price edge。

Framework 和 coordinator 都不能拥有协议名/address switch、family ID 或独立注册表。

### 7.5 全量 family cohort 接线

对 inventory 中所有 `active_family` 一次完成纵向合同：

```text
candidate/discovery
  → identity/claim
  → route or funding projection
  → current-N state
  → exact quote / sizing
  → plan fragment / callback
  → ActionAdapter encoding
  → final-sim / accounting assertions
```

这是一个 cohort 迁移，不再把 Curve、DODO、ERC4626、Flash 分成四条生产主线。family 文件只填本协议必须的
ABI、state reads、math、rounding、calldata 和 identity：

- 能本地派生的，一份实例 state 映射到所有 edges；
- 必须调用 quoter/router 的，声明固定 `from` 和 batched view call；
- singleton Vault/Manager 用 poolId/state key 隔离；
- Curve schema 与 current-N dynamic state 分离，但 freshness 与 Uni 相同；
- receipt-deposit family 复用已经存在的 framework；
- flash family 复用 funding framework。

任何 route/funding state read 失败都发布 `unresolved/incomplete`，不能归零或 skip 后解释成没有价格、没有机会或
不可借。

### 7.6 隔离 partial legacy，删除全部旁路

对 `legacy_island`：

- 保留文件和直接单测；
- 删除 production registry/import/export；
- 删除为它单独存在的 edge row、provider descriptor、template、warm task、runtime flag 和 switch case；
- production ActionAdapter bootstrap 只从 active families 的 owned/required ID closure 构造，不能继续从
  `adapters/index.ts` 无差别 side-effect 注册全部旧 encoder；
- 不提供 compatibility wrapper。

全仓必须清零：

- `PRODUCTION_ROUTE_ADAPTERS`；
- 独立 `FLASH_PROVIDER_DESCRIPTORS`；
- `LEGACY_PRODUCTION_ROUTE_EDGES`；
- production `compat` family kind；
- `external-mid` / `protocol-mid` 迁移桶；
- `main.ts`、token graph、planner、quoter、solver、plan-builder、live backend 对具体 venue/provider 的生产分支。

### 7.7 Shadow parity 后原子翻转

旧线与新线使用同一 frozen inputs 分别运行，不做 runtime fallback。必须先通过：

- registry/activation manifest；
- graph/funding/template/calldata parity；
- current-N state/mid/candidate parity；
- planner/solver/final-sim/EV parity；
- legacy island production reachability = 0。

然后只改一次 production root import。最终 `main.ts` 只保留：

```ts
const runtime = await adapterRuntimeCoordinator.prepare({
  sourceBlock,
  deadline,
  signal,
});
const opportunities = scan(runtime.graph, runtime.pricing);
await solveFinalSimAndApplyGlobalEv(opportunities, {
  graph: runtime.graph,
  pricing: runtime.pricing,
  funding: runtime.funding,
});
```

### 7.8 在同一 family runtime 上解决 busy

- state reads 按 family state key 去重并 batch；
- swap/protocol 两 price lane 与 source hash/fork preparation 有界并行；
- 加 generation、latest pending head 和统一 cancellation control；
- 验证 transport abort、late-result fencing 和共享 backend settle；
- 完整 active-family graph 下证明新 head 不再被上一轮无界占锁连续跳过。

性能结果不得把 `legacy_island` 的 activation delta 算成优化收益；比较使用同一 active manifest，另报全量
coverage delta。

## 8. 验收

### 8.1 语义等价

同一 frozen inventory、active manifest、source block 和配置比较 baseline/challenger：

- production family/legacy inventory 与 activation delta；
- ordered edge set；
- metadata、ownership、admission；
- 每条 resolved state 的 source block；
- coarse mids；
- candidate route fingerprints 与排序；
- exact probe sign/margin；
- planner/solver amount 与 profit；
- PlanFragment/calldata；
- final sim success/revert、gas、profit、repayment/conservation；
- flash provider selection order、default、borrowable amount、root params 与 repayment mode；
- production ActionAdapter/encoder exact set；
- EV allow/reject 与 reason。

任何允许差异必须在运行前声明，不能看完结果再放宽。baseline-active semantic 若退出生产，必须作为
`activation_delta` 独立 review；不得把它藏在 graph diff 里。

### 8.2 性能与覆盖

必须使用同一个 active-family manifest 的完整 graph：

- `head_seen → state_ready` p50/p95；
- `head_seen → scanner_done` p50/p95；
- `head_seen → exact_refine_done` p50/p95；
- `head_seen → planner_solver_done` p50/p95；
- `head_seen → final_sim_done` p50/p95；
- `head_seen → ev_decision` p50/p95；
- swap/protocol lane wall time与 overlap；
- unique state keys、calls、batches；
- timeout/abort/late-result；
- state incomplete 数和 family 分布；
- `skipped_busy`；
- CPU/RSS/provider error；
- final-sim false-positive。

本轮性能合同：

```text
同一 active-family manifest，性能比较不减边
AND agreed warm paired window 的 busy-source coverage 达标
AND tx055 严格 replay 的 head_seen → EV decision steady-process/fresh-source-state p95 < 10s
AND 预先冻结的 paired-live eligible exact-block 分母中，每块都在 10s 内产生
    scanner_done(no_candidate) 或 block_ev_done(candidate)
AND graph/candidate/final-sim 等价合同通过
AND 完整 active manifest 的 expected current-N state-key/edge coverage exact hash 全部 resolved
AND activation_delta 单独审计、不计入提速
```

paired-live 分母必须在 warm/catch-up 完成后、查看 block outcome 前按 exact block hash/range 封存。
`skipped_busy`、timeout、incomplete、missing terminal 仍留在分母并直接判该块失败；candidate/no-candidate
类别只能由完整 production pipeline 的自然边界事件决定，不能用“最终跑完的才算 candidate”做后验筛选。

交易 replay 使用 steady process，但只允许静态 schema、decimals、codehash 与 call descriptor cache
预热。首轮开始前，manifest 必须封存 `run_count ≥ 20`、seeded A/B 交错顺序、nearest-rank
`p95 = sorted[ceil(0.95*n)-1]` 算法及 timeout 记法；不得在看到结果后追加快轮拯救 p95，额外运行只能作为
一轮新的 experiment。每一轮都恢复同一份已封存的 N-1 输入，换代或清空全部 N 相关
state/mid/refine/amount/plan/sim/EV cache，并重置 clean fork 后复核 pre-state root。每轮必须重新发生
current-N dynamic reads/batches，计数随原始 `stage_ms/cumulative_ms` 一起留存；不能删掉慢 run，也不能让
前一轮的 N 结果给后一轮提速。所有 attempted runs 都进入报告，timeout 既保留其 elapsed 又是 correctness
fail。process startup 与一次性历史数据下载不计入 live hot path，但必须在两边测量前完成且内容哈希相同；
target-specific prewarm 不允许。没有严格 tx replay 与 paired live A/B 两类证据，只能写
`implemented_not_validated`。

### 8.3 架构 conformance

机器检查至少覆盖：

1. 每个 production family 恰好一个 ID/kind/owner，required capabilities 齐全；
2. 每个 production edge 的 discovery、state、quote、plan owner 是同一个 family；
3. owned ActionAdapter 唯一，shared infra ActionAdapter 存在且不被误判成独占；
4. flash family 不生成 TokenEdge，route family 不声明 flash repayment；
5. `ReceiptDepositFramework` / `FlashLoanFramework` 不是 registry owner；
6. production import closure 不能触达 legacy island、compat、旧 descriptor 或 fallback；
7. current-N route/funding read 失败只产生 `unresolved/incomplete`，不能变成零值或 no-opportunity；
8. topology completeness watermark 未覆盖 source N 时不得输出完整负结论；
9. frozen baseline-active semantic 不得在无 approved activation delta 时消失。

每个 active family 都要有 interface/conformance 测试；每种共享 framework 至少要有两个真实 family 的正例和
负例；高风险 ABI/repayment/rounding 必须有 known-good fork fixture。单个 DODO/Eigenpie fixture 不能代表整个
universal registry。

### 8.4 tx055 严格 blind 六步与秒数

本轮把六步统一成 `gates.md` 的 block-scan 物理阶段；A/B equivalence 是六步完成后的比较，不再冒充第六个
生产阶段：

| # | 生产阶段 | tx055 通过条件 | 时间口径 |
|---:|---|---|---|
| 1 | graph/admission + current-N state | 以 watermark 到 N-1 的完整 production base 为起点，在计时区间内处理 N delta；`GraphView(25585380)` completeness 覆盖 N；完整 active-family graph 自然包含三条腿；由完整 universe+manifest 派生的 expected required state-key/edge exact-set 全部在 N resolved，coverage hash 相同 | `head_seen → state_ready`，记录 wall/cumulative ms |
| 2 | route enumeration | 完整 ordered route 自然出现在 candidate set，记录自然 rank；不得 append | `state_ready → enumeration_done`，记录 wall/cumulative ms |
| 3 | exact quote/refine | target 自然被 probe；逐腿 quote/rounding 绑定 N；amount 由 solver 搜索，不取 landed amount | `enumeration_done → exact_refine_done`，记录 wall/cumulative ms |
| 4 | planner + solver | route 自然进入 solve set，plan count > 0，family/action ownership 正确 | `exact_refine_done → planner_solver_done`，记录 wall/cumulative ms |
| 5 | resolved-plan clean-fork re-sim | production compiler 现编 calldata；sim success、还贷、无 standing position，记录逐 wei profit/gas | `planner_solver_done → final_sim_done`，记录 wall/cumulative ms |
| 6 | production EV decision | unchanged production evaluator 必须执行；输出 `execution_status=pass` 与可复算的 `decision=allow|reject`、`decision_reason`。本样本允许正确 reject，禁止把结果写死 | `final_sim_done → ev_decision`，记录 wall/cumulative ms |

唯一硬秒数门是全部六阶段 `head_seen → ev_decision` 的
steady-process/fresh-source-state p95 `<10,000ms`；每个阶段必须有边界与耗时，但本轮不人为分配
`4.5s/1.8s/3.2s/0.5s` 等可被逐段做假的配额。历史已证明的只有旧 pass `28.739s` 及其阶段分解；
第一次严格 full-graph 六步运行必须重新产出 baseline/challenger 秒数。如果总时间不通过，就保留真实
stage breakdown、资源和错误证据，状态写 `implemented_not_validated` 并讨论工程取舍；不得靠减图、
目标预热、缓存复用、强制候选或策略放宽制造通过。

语义与时间分开记账：可以是 `semantic_status=pass`、`timing_status=fail`，不能把它们折成一个看似成功的
总状态。冻结后也不得挑有利窗口/percentile、移动计时边界、只取最优 warm blocks 或删除“异常”慢样本。
如果真实工程结果说明 `<10s` 不合理，只能带完整证据由人重新决定目标或交付边界；新口径从下一轮生效，
不能追认本轮为 pass。

计时使用 monotonic clock，从 production entry 接收 source head 开始，覆盖
`runtime.prepare(N) → graph/state → enumeration → refine → planner/solver → final sim → EV`。不能在
warm/mids 完成后才启动 timer，也不能把某个 slow family、graph delta 或 unresolved state 移到计时区间外。
每次输出 `stage_started_at / stage_finished_at / stage_ms / cumulative_ms`；任何 `bypassed/not-run` 都是 fail。

历史数据下载和 process startup 可在 measured window 前完成，因为 live hot path 不执行这两项；但两边必须
使用相同本地 reth/backend、相同内容寻址的 N-1 base 与相同静态 cache 起点。对该样本，base topology
completeness watermark 必须是 `25585379`；从 N-1 推进到 `25585380` 的 topology delta、current-N
dynamic state 与全部六阶段都在计时区间内。若直接预装已经覆盖 N 的 universe，只能作 route/state
诊断，不能取得本严格 full-pipeline timing pass。

进程可以 steady，但测量状态必须 fresh：至少 20 轮中的每一轮都恢复同一 N-1 base、清空或 generation-bump
所有 N 相关动态 cache、重置 clean fork 并复核 pre-state root；只允许复用静态 schema/decimals/codehash/
call-descriptor cache。每轮记录 fresh dynamic read/batch count，禁止预热目标三个池或复用上一轮 N 的
state、quote、plan、sim、EV 结果。timer 外只允许清理并恢复 N-1 harness；任何 `forkAt(N)`、source-N
snapshot/sync/pre-state materialization 或 production per-head backend preparation 都必须发生在
`head_seen` 后并计时。任一阶段 `bypassed/not-run` 都是 correctness fail，不能从 p95 样本中删除。

“完整图”也约束状态覆盖，不只约束 edge 数：首轮前只封存 N-1 base 的 expected sets；producer 必须在
timer 内吸收 N delta 并自行形成 `GraphView(N)`。trusted independent builder 可在 producer 看不到的
oracle 侧构建 N 的 `expected_required_state_keys`、`expected_priced_edges` 及 hashes，待输出封存后
post-hoc exact compare。只有 GraphView(N) 的全部 required keys 成功 resolved 且原子发布后才允许发
`state_ready`。任何 Curve/protocol/其他 slow family 的 timeout/unresolved/incomplete 都只能产生
degraded diagnostic，不能取得 strict timing pass。

### 8.5 Producer/oracle 隔离与反作弊

当前 `blockscan-hunt` / `ab-canary-gate` 会向 producer 传 `AB_EXPECTED_ROUTE_JSON/POOL_IDS`，并能把 top-K
外的 expected route 强制 append 到 solve set；这条旧 checker 只能继续做诊断，**不能**为 tx055 严格标准出具
pass。实施代码冻结前，先在 trusted main 落一个薄的 blind producer + post-hoc comparator；challenger 不得修改
runner、oracle 或 comparator。

```text
trusted oracle builder
  receipt + call trace + source block
  → sealed route oracle + oracle SHA
                         ┐
blind producer           │  producer 完成并封存 output 后
  source block/hash/root │
  full universe/config   ├→ trusted comparator post-hoc match
  active manifest/backend│
  → natural outputs      ┘
```

机器必须断言：

1. producer argv/env 不含 tx hash、winner hash、expected route/pools/tokens/factory、amount、search center、
   rank、calldata、`AB_EXPECTED_*` 或同义字段；tx hash 只存在于外层 manifest/oracle/comparator。producer
   使用隔离的 effective config：禁用仓库 `.env` 二次加载或运行在无该文件的干净 cwd，并在所有 config
   loader 完成后再次封存/审计 normalized effective config，不能只清启动 shell 的 env；
2. `selection_mode=production`、`forced_selection_count=0`；target 必须自然通过 production candidate/refine/solve
   caps，top-K 外不得 append。若自然 rank 不够或在 final sim 前被 threshold 丢弃就是 fail，不能把 early
   drop 冒充“六步完成”；
3. 不使用 fixture edge/pool/route preload、force-include、target pin、target-specific warm、storage override、
   中间 token balance 预置或只含三池的隔离 universe；
4. runner 必须包装实际 production entry 的
   `AdapterRuntimeCoordinator → scanner/refine → planner/solver → final sim → EV` import closure 与正式
   deployment config resolver，不能复制一份“长得像 production”的验收管道；manifest 绑定 production
   entry SHA、通用 universe builder SHA/range/input hashes、独立重建的 universe hash、normalized config、
   active-family manifest、backend 与 source hash/root；
5. `normalized config` 必须来自当前标准 live A 进程在全部 env/config loader 完成后的实际 resolved dump，
   并绑定其 capture SHA；至少包括 universe top-N/view max、candidate/refine/solve caps、deadlines、
   concurrency 与 active-family manifest。baseline/challenger 除预声明的 historical source/backend
   substitutions 外逐字节相同；不能让两边一起退回较小的源码 fallback。secret value 不写入报告，
   只绑定脱敏后的 provider class/endpoint identity 与 secret-presence hash；
6. 通用 production discovery 先生成 completeness watermark 到 `25585379` 的 base；baseline/challenger
   byte-identical，并在 timer 内处理 source N=`25585380` delta。实例只能由生产 discovery/identityProof
   准入；fixture、force/static instance seed 不能成为某 route venue 的唯一来源（通用 infra singleton
   仅可作为显式审查过的例外）；
7. 不减图：纯重构要求 ordered edge identity exact-set 相同；若有预声明新激活，只允许
   `baseline_edges ⊆ challenger_edges`，新增逐项列出，零删除；另比较 metadata/ownership、funding providers、
   ActionAdapter closure 与完整 current-N resolved-state coverage exact hash，不能只比 edge count；
8. solver 自选 route amount/flash amount，production compiler 现编 calldata；landed amounts/calldata 只能在
   producer 输出封存后作 oracle；
9. trusted comparator 从 raw output 重算 route match、sim balance delta 与 EV；challenger 自报的
   `matched/pass` 不算证据；
10. runner/oracle/comparator 必须先进入 trusted main 且不在 challenger diff；challenger production closure
   的新增文本/常量扫描不得出现 sentinel tx、source hash/root、目标 poolId/address、token 序列、landed
   amounts、calldata、`25585379/25585380/25585381`、`txIndex=271` 或其编码/派生条件。已有通用
   production pin 只能保持原样并逐项审查，不能因本样本新增；challenger freeze 后，trusted runner 还要用
   未提前披露的邻块/held-out block controls 检测 fixture-metadata 条件分支；
11. 每轮报告 dynamic-cache generation/reset、fresh reads/batches、clean-fork id/pre-state root 与全部 output
    hashes，证明测到的不是上一轮同一历史块的缓存命中。

本样本不允许 acceptance-only 调低 `minSpread`/EV、提高 candidate/rank cap 或放宽 deadline。若某个通用参数确实
需要修改，它必须成为真实 production diff，并独立通过候选分布、资源和 paired A/B；在此之前不能帮助本次 strict
run 通过。

当前 harness 还缺逐阶段 elapsed，且 V4 matcher 没从 `v4PoolKey.currency0/currency1` 推导方向。这两项必须作为
通用 trusted-harness 修复先进入 main：不能为该 poolId 写特判，也不能在 challenger 中顺手修改验收器。

tx055 strict blind six-step 是本轮必要条件，不是充分条件。它覆盖 UniV3/V4 与完整 block-scan critical path，
不能代表 Curve、DODO、receipt-deposit、flash provider 等全部 family；§8.1–8.3 的全量 conformance、cohort
和 paired live A/B 仍是完成门。六步仍不是 deploy 启动开关，但用户已将它明确选为本次 merge/验收合同。

## 9. 非目标

本计划不顺手扩大到：

- `self-burn-native` 与 amount-dependent `simulateValueDelta`；
- 为当前尚未生产化的 credit/liquidity 行为发明新 projector 或经济策略；若它们进入生产，仍必须走
  `AdapterFamily`；
- flash coarse-price lane；flash-loan family 与 funding state 本身属于本计划；
- 为某一笔交易补新的协议特例或单独激活 partial legacy adapter；
- 其余 static `declaredVenues` 清理；
- claim ownership 全面重写；
- challenger-authored Production Replay 升格为 trusted gate；
- 广播、安全门或 EV policy 放松。

## 10. 完成定义

完成后，一个新 production execution family 按自己的 kind 同时交付完整纵向合同：

```text
identity/discovery
route or funding projection
current-N state
quote/sizing or borrowability
plan/callback + owned/required ActionAdapters
final-sim/accounting assertions
```

注册进 `PRODUCTION_ADAPTER_FAMILIES` 后：

- route family 自动进入共享 discovery/graph 与 swap/protocol pricing lane；
- flash family 自动进入 funding selection/liquidity/repayment；
- `main.ts` 零 venue 编辑；
- current-block state 由统一 coordinator 调度；
- family 只拥有链上语义，不拥有 scheduler/cache/timer。

只有以下条件全部成立，才能写本计划完成：

1. 所有 baseline-active 高阶 execution semantics 都是 complete family，或有逐项批准的 activation delta；
2. 唯一 `PRODUCTION_ADAPTER_FAMILIES` 是所有生产消费者的真相源；
3. `PRODUCTION_ROUTE_ADAPTERS`、`FLASH_PROVIDER_DESCRIPTORS`、`LEGACY_PRODUCTION_ROUTE_EDGES`、
   production `compat` 和 legacy fallback 全部不存在；
4. legacy island 的 production reachability 为零；
5. topology completeness/pass-consistency 合同已机器化，不存在固定 `T-k` 许可；
6. 动态 swap/protocol/flash funding state 全部绑定 source N；
7. `main.ts`、graph、planner、quoter、solver、plan-builder、live backend 不含 venue/provider-specific
   production 分支；
8. 一个 family runtime coordinator；route-price 只有 swap/protocol 两 lane，flash 作为 typed funding product；
9. tx055 strict blind 六步全部执行、post-hoc 匹配、steady-process/fresh-source-state p95 `<10s`，且反作弊断言全绿；
10. active-family 完整 graph paired live 达到预先冻结的 `<10s` 统计口径；
11. busy-source coverage 达到预先冻结的 paired-window 门；
12. registry conformance、语义等价、state coverage、资源与 reviewer verdict 全部通过。

在此之前，准确状态只能是计划或 `implemented_not_validated`，不能写 busy fixed，也不能写 live performance 已验收。

## 11. Fable 对抗审计：增强点收敛与立场清算（2026-07-23）

审计人：Fable 5。对象：本文全文 @ `7bd6d40`（§0–§10 逐节通读；§1/§2/§8 关键声明按
`origin/main @ ad35790` 代码复核）。对向审计（Codex 5.6-sol ultra 审 Fable 独立版
[fable-adapter-family-line-plan.md](fable-adapter-family-line-plan.md)）并行进行，其结论落该文 §10。
本节先给"Fable 版更强、应并入本文"的点，再如实清算 Fable 撤回的立场，最后留下唯一真分歧待裁决。

### 11.1 并入增强点（Fable 版更强，与本文既有边界无冲突，视为本文一部分）

1. **现状矩阵只作盘点种子与交叉核对，不得直接冻结**（用户裁决 2026-07-23）。对向审计
   （Fable 版 §10 P0-1/P0-3/P0-6、§10.3）已证实该矩阵漏了多处分派点——token-graph 静态实例表与
   `ADAPTER_MAP`/`switch(pool.adapter)`、quoter/Revm/scanner 的 fluid fallback、跨 family 的
   `PROTOCOL_LEG_DESCRIPTORS`、capability/landed-event/victim-model 三张表——且 prepared/flash cadence
   有错（flash 实为 120s timer + 400-token 分块多 Multicall、无 blockTag，并非"每块一个 Multicall"）。
   收敛动作：§7.2 冻结 inventory 必须按其原定义从真实 production import/registry/consumer closure
   生成；矩阵仅用于对生成结果做人工交叉核对，两者不一致时以 closure 为准并追查矩阵为何漏。
2. **"更新块跳变" freshness 验收样本。** §5.2 确立了"动态 mid 不用固定 TTL，因为 donation/harvest/oracle
   report 单块跳变"的原则，§8.5 也承认 tx055 只覆盖 UniV3/V4 关键路径、"不能代表 Curve、DODO、
   receipt-deposit、flash provider"。但全文没有任何验收项证明该原则被实现兑现。收敛动作：§8.2 性能合同
   增补一个 conversion-lane freshness 样本——选一个真实 ERC4626 donation/harvest 或 wstETH oracle-report
   块，blind 重放证明该 family 的 mid 在块 N 当块变化并引起候选集变化；构造与反作弊约束沿用 §8.5 同一
   套 producer/oracle 隔离，样本块由 trusted oracle 侧选定、producer 不可见。
3. **`deriveMids` 纯度机器断言。** §3.3 禁止 adapter 拥有 timer/TTL/并发/cache commit，但 §8.3 的九条
   conformance 无一断言 `deriveMids` 不触链。这是两 lane 设计不退化回逐 edge quote（11.6s 根因）的
   前提。收敛动作：§8.3 增补第 10 条——conformance harness 以断网/毒化 backend 调用每个 family 的
   `deriveMids`，任何 RPC/IO 触碰即 fail。
4. **family"轻"的量化触发器**（用户裁决：同意，为强制 review 触发器；对向审计校准了口径）。新迁移
   family 的**核心声明文件**（不含测试）超过 200 行触发强制 review——永远不是 conformance 硬门。
   口径依据实测（Fable 版 §10.2）：直接文件口径中位数 152 行、11/15 ≤200（偏松且可拆分规避）；
   closure 口径 Eigenpie ≥672、ERC4626 ≥875（明显偏紧）——故取"核心声明文件"口径，拆分规避视同超限。
   超限的合法解释是"该协议真实差异就这么多"，非法解释是"框架缺共性被抄进了 family"。"按新合同重写
   Eigenpie 并对比行数"仍列为 framework 完成度的压力测试。
5. **治理分流映射**（措辞已按 `HISTORICAL-GAP.md` Promotion Matrix 逐行核准，用户裁决 2026-07-23）：
   - **只有 production-unreachable 的纯增量骨架可直进 main**——§7.3 kernel、§7.4 framework/coordinator
     的 shadow 实现、§8.5 的 trusted runner/oracle/comparator 及 harness 通用修复，前提是 production
     import closure 不可达；按 Promotion Matrix"analysis tool / classifier / gate"行执行：
     build + regression + 非作者 review，直进 main，**永不作为 B 部署**；
   - **任何生产 consumer 接线、state scheduling、root-import flip（§7.7）、busy 行为变化（§7.8）**属
     "systemic scanner / graph / universe / performance"与"flow admission, latency, candidate ranking"
     两行：预声明 cohort + 覆盖/输出合同 + 同输入公平性证据，然后**必须 Hermes A/B**；历史 replay
     单独不能 promote；
   - §7.5 cohort 接线在 shadow 内完成（不触生产），随 §7.7 翻转一并进 A/B。
6. **§1.1 证据 provenance。** §1.1 的 `28.739s/9.629s/11.630s/29,220` 缺执行凭据。收敛动作：补记
   生产只读查询 SSM `4afc0b54`（根因日志）、`1732ec95`（block-activity，exit 0）、`fd518ba2`（事件切片）、
   生产 manifest SHA `90cd32d7…a08c9`，与 §8 的机器证据纪律对齐。

### 11.2 Fable 撤回的立场（对向收敛，如实记录）

1. **T-10 topology 许可**：撤回。本文 §3.2 的 watermark + `graph_incomplete` 降级已给出可实施的渐进
   形态，且 §0.2 对固定 T-k 的否决成立（Fable 版 §5.3 的标注分歧就此关闭）。
2. **抢占形态"可先定"之争**：实质已收敛——§6.2 推荐的 latest-head single-slot + generation fencing 就是
   Fable 版 §5.5 的形态，仅"性能结论待实测"的定性不同，无需裁决。
3. **分阶段预算表（4.5/1.8/3.2/0.5s）**：撤回。§8.4"不人为分配可被逐段做假的配额"是对的——唯一硬门是
   端到端 p95，分段只留测量不留配额。
4. **Fable 版 §5.4 capability 接口**：废弃,采用本文 §3.3 的 typed 版本(Schema/Snapshot 泛型、
   `deriveMids` 批量形态更优)——叠加 11.1-3 的纯度断言。
5. **孤岛表中 fluid-dex/DODO 的处置**：由本文 §7.2 更严的 baseline-active 规则取代（active 语义默认
   同批补齐，退出必须显式 `activation_delta` 审查——比 Fable 版"暂停覆盖列队迁移"更硬,采纳）。
6. **初稿"共享路径仅一处特判"**：Fable 版自身的事实错误(grep 模式漏 switch/case),已在该文 v2 修正,
   本文 §2.2 的 legacy 清单为准。

### 11.3 旧线冻结粒度——已裁决关闭（2026-07-23）

原分歧：旧线构建期是否允许"bit-identical 窄域修复"先行。裁决依据两条：
(a) 用户规则——任何生产 consumer、state scheduling、root flip 或 busy 行为变化必须 Hermes A/B；
(b) 对向审计（Fable 版 §10 P1-3）——所谓等价的状态层提速本身会改变 deadline 内可完成的扫描集合与
候选集，**"bit-identical 旧线优化"这一前提在 coarse-mid/调度语境下不成立**。

结论：旧线修复不被禁止，但不存在"等价例外"通道——一律作为独立 challenger 走现行 Hermes A/B 分流；
promotion 改变 champion 后重钉 §7.2 frozen baseline SHA 并重跑 parity 基线。生产入口维持 §7.7 一次
root-import 翻转。分歧关闭，无遗留。

### 11.4 verdict

本文 @ `7bd6d40` 的架构核心（universal registry、watermark、双 lane coordinator、framework 提取规则、
blind 验收与反作弊）全部成立，Fable 审计未发现 P0/P1；对向审计（Codex 5.6-sol ultra，全文见
[fable-adapter-family-line-plan.md](fable-adapter-family-line-plan.md) §10）对 Fable 版录得 P0×6/P1×5，
其结论与本节 11.1/11.2/11.3 的收敛一致。六个增强点（11.1，其中 1/4/5 按用户裁决与审计校准后措辞）
自本节起生效；11.3 已关闭；除 §0.3 既有待实测项外无开放分歧。互评闭环。
