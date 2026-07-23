# Codex — Universal AdapterFamily Plugin 生产线与 Block-Scan 当前状态统一计划

> 本文是当前 canonical 总纲；被它取代的分拆 state-lane 草稿不再作为设计依据。
>
> 状态：计划稿；尚未实施，尚未证明 `<10s`，live busy gap 未 fixed。
>
> 基线：`origin/main @ ad35790a8fa6aa5e4f9529d1099600a270a0d1ea`。
>
> 本文合并四项工作：已经进入 main 的 adapter-family 自动发现第一版、所有高阶执行语义收敛到唯一
> family plugin catalog、错误 family 的逐插件故障隔离，以及 live `skipped=busy` 暴露出的 block-scan
> 状态刷新问题。本文只把
> 对话中已经裁定的事项写成硬边界；仍需 benchmark/A/B 才能决定的参数与实现选择单列，不再把讨论提议
> 写成决定。

## 0. 最终决定

### 0.1 已决定

1. **性能优化不能靠减边。** `<10s` 不能靠降低 top-N、删除一个已激活 family 的 routes、缩小候选 universe
   或跳过 slow family 达成。baseline-active legacy adapter 不能在本轮 cutover 中顺手退出；产品若决定
   下线，必须先作为独立 `approved_deactivation` 变更审计，且不能取得本轮输出等价或性能提升结论。
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
   coordinator 负责去重、batch、并发、deadline、取消、source pinning 和逐 family 原子发布。
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
13. **一个 family 是一个自包含 plugin module。** 默认一个 family 只有一个生产入口文件，在同一个 bundle
    中组合协议 ABI、identity、discovery、state、quote、plan、observation 与 family-owned
    `ActionAdapter`；禁止为了 capability 分层机械复制 discovery/state/route 子管道。测试/fixture 可独立，
    真正通用的数学、ABI 或 framework 可复用，但新增 family 不得修改 `main.ts`、graph、planner、solver、
    state coordinator、ActionAdapter bootstrap 或中央协议字符串 union。
14. **唯一 catalog 不等于 production import 全部 plugin。** `families/*` 是唯一源码目录；确定性生成器输出
    仅含 metadata/source hash 的 candidate catalog，以及只 import 已 promotion plugin 的 active production
    catalog。candidate/quarantined 源码不得进入 production bundle/import closure；禁止 side-effect
    registration。
15. **promotion 不能由 plugin 自证。** Plugin 作者不能填写 `active`，也不能用随 plugin 提交的测试结果自行
    promotion。可信工具根据源码、依赖、正负 fixture、conformance、replay、隔离与 reviewer receipt 生成
    active manifest；任一绑定 hash 改变即退回 candidate。
16. **运行时 fail-closed 的边界是 family，不是整个中央接口。** 一个 active family 在某 generation 的
    discovery/state/quote/encode 失败，只撤销该 family 本代输出；其他 healthy families 继续发布自己的
    current-N 结果。全局结果必须标 `degraded/incomplete`，不得声称完整图 `no opportunity`；只依赖
    complete families 与 complete funding 的 route 可以继续 final sim/EV。strict replay、equivalence 与
    performance acceptance 仍要求所有 active families complete。
17. **错误必须结构化归因。** 每层返回 `familyId + stage + generation + sourceBlock/hash + verdict`；matcher、
    probe、decode、derive、plan 或 encoder 的 throw/timeout 不得穿透 supervisor，也不得使 sibling family
    丢候选、复用旧状态或被新 candidate 抢走 ownership。

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
- production eager-import candidate/quarantined plugin 后再靠状态字段过滤；
- 允许 plugin 自行声明 `active` 或自行签发 promotion 证据；
- 因一个 family 的错误拒绝发布全部 healthy-family current-N 结果；
- 用闭合 `PoolEntry.adapter`/venue/action 字符串 union 迫使新增 family 修改中央消费者；
- 运行时扫描目录并依赖模块顶层副作用自动注册 plugin。

### 0.3 尚待实测，不在本文伪装成决定

- 每个 lane 的 batch 大小与 concurrency；
- Multicall 与 JSON-RPC batch 的具体分配；
- 新 head 到来时是立即取消旧 pass，还是让不可取消的短任务 settle 后只运行最新 pending head；
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

历史证据凭据由 Fable 对照稿补齐：耗时/skip 日志 receipt `SSM 4afc0b54`；block-activity 工具 receipt
`SSM 1732ec95`（exit 0）；事件切片 receipt `SSM fd518ba2`；其 execution manifest 在现存文档中只保留了截断摘要
`90cd32d7…a08c9`。这些标识用于追溯旧结论，不是本轮新实测；正式机器验收前必须从可信证据库恢复并绑定
**完整** manifest SHA-256，截断摘要不能单独出具 pass。

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
- `EXTERNAL_AND_LEGACY_POOL_REGISTRY` 等静态实例 row 仍可绕过 discovery/identity/probe，必须逐 row 迁移或
  作为独立 deactivation 审计，不能让 executable instance allowlist 成为第二 admission 源；
- `PROTOCOL_LEG_DESCRIPTORS`、venue capability、landed-event、victim-model/pool-impact 等平行表仍拥有
  ABI、approve、observation 或 victim-state 语义；终态必须由 family 投影，或由 registry-derived coverage
  conformance 证明正交表没有漏 family；
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
- 原本就未生产化的旧 adapter 可以保留文件但成为零生产引用的孤岛；baseline-active 退出必须先走独立
  `approved_deactivation`，不能混入本轮重构；
- 任何孤岛都不能通过 legacy switch、fallback edge 或 descriptor table 偷跑。

## 3. 目标架构

### 3.1 一个 universal family plugin catalog

终态的作者交付单位不是一行中央 descriptor，而是一个显式导出的 family plugin：

```ts
type AdapterFamily =
  | SwapAdapterFamily
  | ProtocolConversionAdapterFamily
  | FlashLoanAdapterFamily
  | CreditAdapterFamily
  | LiquidityAdapterFamily;

interface AdapterFamilyPlugin<Family extends AdapterFamily = AdapterFamily> {
  readonly family: Family;
  readonly ownedActionAdapters: readonly ActionAdapter[];
  readonly requiredInfraActionAdapterIds: readonly InfraActionAdapterId[];
}
```

一个 plugin 默认就是 `families/<family-id>.ts`：一个入口文件、一个显式 bundle、一个故障与 promotion
边界。Capability 是该对象内部的强类型字段，不要求拆成 `discovery.ts/state.ts/route.ts`。测试与 fixture
可放在测试目录；真正跨 family 共用的 framework/math/ABI helper 可以外置，但 family-specific orchestration
不能散落到中央或多个平行注册源。新增同 family 实例仍由 discovery 自动收入，不新增 plugin。

共同 family base 只放所有类别都真正共有的字段：

```ts
interface AdapterFamilyBase<Kind extends AdapterFamilyKind> {
  readonly id: ExecutionFamilyId;
  readonly kind: Kind;
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

源码目录、候选验证与生产 import closure 必须分开：

```text
families/*                                  唯一 plugin 源码目录
    ↓ deterministic generator
candidate-family-catalog.json               metadata、source-tree hash、schema version；
                                            不被 production import
    ↓ trusted isolated validation/promotion
active-family-catalog.generated.ts          只 import promotion receipt 仍有效的 plugin
    ↓
PRODUCTION_ADAPTER_FAMILIES                 active catalog 的 typed runtime view
```

生成器按规范化相对路径稳定排序，拒绝 symlink/重复 ID/未声明入口，输出内容可重现；generated artifact 必须
提交，CI 运行 `--check`，手改或漏生成都失败。Candidate 验证在独立进程执行，不能取得 production secrets、
全局 ActionAdapter registry、active cache 或 live backend；它使用独立 backend proxy/cache namespace，并有
外部硬 CPU/memory/output/deadline/kill 边界。不能依赖错误 plugin 配合 `AbortSignal`。

`active-family-catalog.generated.ts` 是 production 唯一允许 import 的 plugin closure。它绝不能先 import
candidate 再按 `stage` 过滤，因为 ESM 顶层代码在过滤前已经执行。Family 模块禁止顶层注册、timer、后台任务、
env 读取或全局 mutation，只能显式导出 bundle。

Promotion 由 trusted tooling 生成，receipt 至少绑定：

```text
familyId
plugin source-tree hash
capability schema version
catalog generator SHA/version
base commit + dependency lock hash
positive/negative fixture hashes
conformance/replay/isolation/resource receipts
review decision
```

任一绑定改变后，该 plugin 不再出现在 regenerated active catalog。`candidate` / `quarantined` / `active` 是从
唯一 catalog 与可信 receipt 派生的状态，不是三个手工 registry，也不是 plugin 作者可选择的字段。

Active registry constructor 仍是 production 激活门，不接受半成品：

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
plan/quote ABI + approve requirements
landed-event / victim-model / impact coverage
typed category projectors
```

消费者只能调用 canonical registry 自己的 typed view，例如
`PRODUCTION_ADAPTER_FAMILIES.routes()`、`.pricing("swap")`、`.funding()`。终态不保留
`PRODUCTION_ROUTE_ADAPTERS` facade、独立 `FLASH_PROVIDER_DESCRIPTORS` 或
`LEGACY_PRODUCTION_ROUTE_EDGES`。否则 facade/表仍能成为第二入口。

低阶 `ActionAdapter` 仍是 BotVM encoder，例如 `erc20-approve`、`assert-balance`、`balancer-flash` callback
encoder。它不是高阶 family；family-owned encoder 的实现必须由 plugin bundle 显式携带，shared infra 的
实现只存在于可信基础设施 catalog，plugin 只引用其 ID。Candidate 的 encoder 永不注册进全局 ActionAdapter
registry；promotion 先验证 owned ID 唯一、shared infra 只引用显式基础设施集合、每个 plan fragment 只使用
`owned ∪ requiredInfra`，再从 active catalog 派生 production bootstrap exact closure。
`approve`、`transfer`、balance guard 等 shared infra 可被多个 family 引用，不能用“出现两次就算 infra”的
引用次数推断，否则会把双 owner bug 洗成合法。

为了新增 plugin 不改中央协议清单，pool/venue/family/action identity 使用经 runtime registry 校验的 branded
ID；中央只保留 `swap/protocol-conversion/flash-loan/credit/liquidity` 等稳定领域 taxonomy，不能保留
`fluid-vault` 这类按 adapter 名称判断的规则。Identity source 也由 capability descriptor 表达，不再要求每个
新协议扩展中央字符串 union。

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
- 静态协议实例 row 必须逐项由 discovery+identity+probe 替代；只有 Safety Rule 2 允许的 infrastructure
  singleton 才能 pin，且仍须 code/chain/behavior conformance；
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
  readonly sourceBlockHash: string;
  readonly completenessWatermark: number;
  readonly perSourceCoverage: readonly {
    sourceId: string;
    sourceFingerprint: string;
    completeThroughBlock: number;
    completeThroughHash: string;
  }[];
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
 per-family current-N outcomes
       ├─ complete family snapshots
       └─ incomplete family diagnostics
             ↓
 dependency-scoped scanner
```

公共 coordinator 负责：

- 冻结 graph version；
- 固定 source block/hash；
- 按 family + state key 分组；
- 合并重复 reads；
- 选择 Multicall/RPC batch transport；
- concurrency、deadline、AbortSignal 与 backpressure；
- generation fencing；
- 以 `(familyId, generation, sourceBlockHash)` 为原子单元发布 family snapshot；
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

Fable 对照稿在这一层给出了比本文初稿更可执行的微观护栏，收敛后成为机器 conformance：

1. `deriveMids` 必须是同步、确定性的 snapshot→mid 纯计算，类型和测试都不能给它 chain/backend I/O；
2. 同一 generation 内，每个 `(familyId, stateKey)` 的 current-N 动态读取只允许由 coordinator 编排一次；
   chunk/retry 必须共享该 identity 并单独计数，不能退回逐 edge 重读；
3. event dependency 只用于优先级/失效提示，不是 freshness proof；外部依赖无目标日志时仍必须取得 N 状态；
4. 无法本地派生的 family 才能声明 view-quote fallback，而且必须进入公共 batch，不能在 family 内自建逐 edge
   promise/concurrency loop；
5. duplicate-key arbitration、edge 顺序和 snapshot publication 必须确定性；相同输入产生相同 coverage/hash；
6. 任一 required key unresolved 时只能输出 incomplete/degraded diagnostic，不能把缺失 mid 变成
   `no opportunity`，也不能取得 strict full-profile timing pass。

一个 family 的 failure 不得回滚或阻止 sibling family 已完成的 current-N publication。Composite runtime
显式携带 `completeFamilyIds`、`incompleteFamilyIds` 与逐 family coverage/hash：

- failed family 本 generation 的 edges/mids/funding 不进入可执行视图，也不能沿用前一块旧值；
- 只依赖 complete family snapshots 与 complete funding providers 的 route 可以继续
  enumeration/exact quote/final sim/EV；
- 任一依赖 incomplete family 的 route 在进入 quote 前 fail closed；
- 存在 incomplete active family 时，全局状态只能是 `degraded/incomplete`，无候选不能解释为完整生产图
  `no opportunity`；
- strict blind、语义等价、完整 coverage、性能与 paired live 验收仍要求全部 active family complete。

这种隔离不能靠 family 自己 catch。Supervisor 必须在 load、discovery、identity/probe、graph projection、
state、quote、plan、ActionAdapter encode、observation/victim decode 每一层建立 family boundary，把
throw/timeout/超量输出转换成带 `familyId/stage/generation/sourceBlock/hash` 的结构化 verdict；candidate
matcher 的失败或冲突只能 quarantine candidate，不能改变已有 active owner。

动态 snapshot/result identity 至少包含：

```text
chainId
activeManifestHash
familyId
capabilitySchemaVersion
plugin source-tree hash
sourceBlockNumber + sourceBlockHash
family stateKey
```

静态 schema/read-plan cache 使用：

```text
chainId
familyId
capabilitySchemaVersion
plugin source-tree hash
family stateKey
```

它不绑定 source block，因此可跨块复用；动态结果必须绑定 source block/hash。Candidate 与 active 使用不同
cache namespace/目录；promotion 后不能复用 candidate 动态 cache。静态 schema 仍绑定 source-tree
hash/schema version，避免升级后的 decoder 读取旧 schema。

纯度测试不是只看签名：先构造合法 snapshot，再断开网络并把所有 provider/backend/call 入口替换为计数后
抛错的 poison backend；调用每个 active family 的 `deriveMids` 后断言调用计数为零。任何隐式 singleton、
动态 import 或 fallback I/O 都使 conformance fail。

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
- caller 的 receipt-token balance delta `> 0`，并与 family rounding 后的 quote 一致；
- 无 standing position；
- plan fragment 的共同形状；
- nonzero behavior simulation facts；
- final-sim 的 caller 余额与 conservation 约束。

`totalSupply` 增加、mint event 或特定发行路径不是 framework base invariant；rebasing、库存转出等合法 family
未必满足它们。需要这些证据的 family 必须在自己的 assertion 中声明。approve 也只是按需 requirement，
不能让 framework 无条件插入。

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

这不只是所有权搬家：当前 flash liquidity 默认约每 `120s` 刷新，并按 token chunk 产生一个或多个
Multicall；目标合同要求 source-N funding state，因此 cadence/调度会发生真实变化。迁移复用现有
borrowability read 与 chunked Multicall transport，同时冻结 provider planning order、liquidity tie-break
order、同 source 的 liquidity 结果和 repayment 结果；calls/batches 作为资源指标比较，不要求机械同数。
lender 断言也不是 `after == before`：provider 可能收取 fee；每个 family 必须按自己的 fee/repayment 语义
证明应还金额已到账，通用下界只能是 `after >= before`。

### 4.3 Framework 提取规则

只有至少两个真实 family 共享、且能写成共同 assertion 的行为才进入 framework。禁止：

- 为了减少文件数提前造万能 framework；
- framework 内按协议名/address switch；
- framework 自己扫描、注册实例或拥有 scheduler；
- 用公共形状洗掉 family-specific rounding、state delta 或 safety policy。

因此 universal family 不是“大 adapter”。它是一组很薄的 family modules，共享少量经过实证的 frameworks。

为把“薄”从口号变成 review 触发器：新增或重写的单个 family production module 超过 `200 LOC` 时，必须
提交一份 framework/重复 orchestration 审查；这不是 correctness fail，也不得靠挪文件或压缩代码过门。
框架完成度压力测试固定选择 Eigenpie：在 shadow 中按新合同重写，报告重写前后 LOC、重复 orchestration
项与最终 framework 提取结论。

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
4. 该 Curve family 的全部 required 结果完成后按稳定 state key 原子发布；
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
固定 exact SHA/manifest，不再打补丁      在 shadow/test 中完整构建
没有 “new miss → legacy fallback”     没有生产副作用
                 ↓ parity + activation review
                       一次切换
                 ↓
新 family line 成为唯一 production line；旧线失去生产引用
```

这不是逐协议 strangler。允许保留旧源文件，不允许部署“部分新 registry + 部分旧 switch”的半成品。

本轮用户终裁：预计一天量级的构建窗口内，正在 live 的旧 production line **完全冻结**，不接受任何
bugfix/feature/promotion，也不存在“bit-identical 小修”例外。旧线 exact SHA/manifest 是最终 A/B baseline；
新 family line 在 shadow 中完成并一次 cutover。若构建/验收返工使窗口显著延长到数天以上，是否解除冻结
必须由用户重新裁决，agent 不得自行放开。文档、production-unreachable shadow/tooling 可以按 §7.9 继续进入
`main`，但不能改变旧 live production closure。

### 7.2 冻结 inventory 与 activation manifest

以开工时的最新 `origin/main` 冻结 baseline，并从真实 import/registry/consumer closure 生成 inventory：

```text
execution semantic
baseline_active?
current owner(s)
required family kind/capabilities
plugin package path + normalized source-tree hash
capability schema version
identity/discovery source
block-scan state lane + stateKey shape
prepared/exact quote support
current read/batch shape
static instance/descriptor/observation rows + owner
new family complete?
cutover disposition = active_family | legacy_island
activation_delta reason/reviewer (additions only)
promotion receipt + generator/dependency/fixture hashes
separate_deactivation_change_id (baseline-active only)
```

默认规则：

- baseline-active semantic 必须在同一批次补齐 family 后继续 active；
- DODO 属于 baseline-active，因此要复用现有实现补 `pricingState`，不是新建第二个 adapter，也不能默认丢进孤岛；
- 原本未接 production 的 partial adapter 可成为 `legacy_island`；
- baseline-active semantic 在本轮 refactor/performance gate 中不得删除。若产品层决定退出，必须先拆成一个
  独立 `approved_deactivation` 变更，单独审计覆盖与激活结果；它不能取得 equivalence verdict，也不能把
  减边节省的时间计入本重构。重构比较只使用双方共同且未删减的 baseline-active manifest；
- activation manifest 有任何未完成的 `active → island` 或未绑定的 deactivation change 就阻断 cutover。

同时冻结 ordered graph、metadata、ownership、admission、flash provider order/default、template、calldata 与
ActionAdapter coverage，作为 cutover 前后的机器对照。

Fable 的逐 adapter 矩阵直接作为这份 inventory 的**盘点种子**，避免从空白重新列举；但不能原样冻结。
生成器必须从当前 production closure 回填并纠正它漏掉的 consumer、prepared capability 与真实 flash
cadence，然后由 reviewer 对 seed-vs-generated diff 逐项签字。最终真相是生成式 inventory，不是手工表。

### 7.3 建 universal family plugin kernel

一次建立：

- `AdapterFamily` discriminated union；
- self-contained `AdapterFamilyPlugin` bundle contract；
- deterministic catalog generator、metadata-only candidate catalog 与 active-only generated import catalog；
- trusted promotion receipt schema 与 source/dependency/fixture/review hash 重算；
- 独立进程 candidate validator/quarantine runner，production import closure 不含 candidate code；
- `AdapterFamilyRegistry` 与从 active catalog 派生的 `PRODUCTION_ADAPTER_FAMILIES`；
- 每种 kind 的 required-capability validator；
- registry 原生 `.routes()`、`.pricing(lane)`、`.funding()`、`.actionIds()` 等 typed views；
- family ID、kind、ActionAdapter 实现/IDs、claim ownership 和 derived-view 唯一性 conformance；
- production import-closure 检查，禁止 legacy island 被 live consumer 触达。

这里不写 Uni/DODO/Fluid/Balancer 的协议分支。类别只影响 required capabilities，不产生第二个 registry。
生产加载器只接收 active generated imports；candidate/quarantine 工具即使失效也不能成为 production startup
dependency。

### 7.4 建共享 framework 与 runtime coordinator

- 保留并加固 `ReceiptDepositFramework`：统一 asset→receipt edge、approve、exact-in result、receipt delta、
  no-standing-position、plan/final-sim assertions；
- 新建 `FlashLoanFramework`：统一 provider selection、liquidity read、borrow/callback shell、
  repayment/conservation、profit floor 与 lender final-sim assertions；
- 建 `AdapterRuntimeCoordinator`，从 registry capability views 一次准备：
  - `VerifiedGraphView(N)`；
  - swap/protocol 逐 family current-N pricing state；
  - current-N flash funding state；
  - complete/incomplete family map；
  - generation/deadline/AbortSignal/telemetry。
- 所有 plugin 调用都经 family supervisor；单 family failure 只撤销自己的本代输出，healthy family 独立发布，
  composite runtime 标 `degraded/incomplete`。
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

任何 route/funding state read 失败都发布带 owner 的 `unresolved/incomplete`，不能归零、复用旧态或 skip 后
解释成没有价格、没有机会或不可借。失败 family 的 route 本代 fail closed；不依赖它的 complete-family route
继续运行，但整轮不能取得完整图负结论或 strict acceptance pass。

Fable 的 F0–F5 切片保留为**开发/审查 work packages**：kernel/conformance、framework、state coordinator、
flash ownership、legacy isolation、scheduler cleanup 可以分提交和分测；但每片只能在 shadow/test 中前进，
不能逐片替换 production 真相源。生产仍按 §7.7 在全 cohort parity 后一次原子翻转。

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

性能结果不得把任何 activation/deactivation delta 算成优化收益；比较使用同一、未减边的 active manifest，
另报全量 coverage delta。

### 7.9 治理分流固定映射

分流按“是否进入 production closure、是否改变 live distribution”决定，不能按文件名或 F0–F5 编号临时争论：

| 变更形态 | 固定去向 |
|---|---|
| production-unreachable 的 additive family types/registry kernel/framework/shadow coordinator | 走普通非生产实现 review；可分提交进入 main，但不属于 HISTORICAL promotion，也不得声称生产能力已改变 |
| conformance / trusted measurement tool | 只有位于 `HISTORICAL-GAP.md` 已允许的 `analysis/src`、同名 tests/package script、归档 artifact 或精确 trusted hunt harness 时，才能走现有 direct-main；新增 listener runner 必须先单独扩 gate allowlist、跑 regression 并经 fresh 非作者 review |
| 单 family 的 deterministic identity/quote/plan/encode，且没有 shared interface、universe、scanner、ranking、budget 或调度变化 | 只有满足 `HISTORICAL-GAP.md` 的 +EV cohort、trusted replay 与 smoke 时才走其窄 direct-main 通道 |
| universal shared interface、production consumer/import closure、graph/universe、current-N state scheduling、coverage、latency/ranking、deadline/concurrency、root flip 或 busy policy | 一律进入 Hermes cohort + paired A/B；历史单笔不能 promotion |
| 最终 production root flip | 只能使用通过全量 shadow parity 与 Hermes A/B 的 frozen SHA，一次原子翻转 |

因此“kernel/framework 直进 main”只适用于尚未被 production import 的纯增量骨架；一旦接入现有生产消费者，
就按实际 diff 重新分类，不能用先前文件名继承豁免。§7.1 的本轮旧线冻结是更强的临时约束：即使一般治理
允许某个 production 修复进入 Hermes，本构建窗口也不 promotion 到旧 live line。

## 8. 验收

### 8.1 语义等价

同一 frozen inventory、共同 baseline-active manifest、source block 和配置比较 baseline/challenger；
预声明 additions 作为 challenger-only superset 单列，不参与共同集合的语义等价结论：

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

任何允许差异必须在运行前声明，不能看完结果再放宽。baseline-active semantic 若退出生产，必须先走独立
`approved_deactivation` 变更；它不属于本轮 equivalence/performance verdict，也不得藏在 graph diff 里。

### 8.2 性能与覆盖

语义等价使用双方共同、未删减的 baseline-active manifest；性能与 paired-live 则分别使用各自**实际部署的
完整 manifest**。因此 challenger 若含预声明 additions，必须承担这些新增 edges/state keys 的全部成本：

- `source_head_seen → state_ready` p50/p95；
- `source_head_seen → scanner_done` p50/p95；
- `source_head_seen → exact_refine_done` p50/p95；
- `source_head_seen → planner_solver_done` p50/p95；
- `source_head_seen → final_sim_done` p50/p95；
- `source_head_seen → ev_decision` p50/p95；
- swap/protocol lane wall time与 overlap；
- unique state keys、calls、batches；
- timeout/abort/late-result；
- state incomplete 数和 family 分布；
- `skipped_busy`；
- CPU/RSS/provider error；
- final-sim false-positive。

本轮性能合同：

```text
baseline 运行其完整 baseline manifest；challenger 运行 baseline ∪ declared additions 的完整 manifest
AND 两边都不减 baseline-active edges，additions 的成本计入 challenger、收益不计入
AND agreed warm paired window 的 busy-source coverage 达标
AND tx055 严格 replay 的 source_head_seen → EV decision steady-process/fresh-source-state p95 < 10s
AND 预先冻结的 paired-live eligible exact-block 分母中，每块都在 10s 内产生
    scanner_done(no_candidate) 或 block_ev_done(candidate)
AND graph/candidate/final-sim 等价合同通过
AND 完整 active manifest 的 expected current-N state-key/edge coverage exact hash 全部 resolved
AND activation additions 单独审计、不计入提速；本次比较不包含 baseline deactivation
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
9. frozen baseline-active semantic 在本轮 refactor/performance gate 中不得消失；deactivation 只能先走
   独立产品/覆盖变更，不能由本门豁免；
10. `deriveMids` 无 I/O、每 generation/stateKey 唯一调度、view fallback 必须 batch、event dependency
    不作为 freshness proof；
11. **shared orchestration/consumer surface** 的结构化零特判检查：family/edge/provider IDs 从 registry
    派生，AST 检查 equality、switch/case、venue-key map 与 direct import。registry-owned family module
    与低阶 ActionAdapter 明确排除，否则合法的 ABI/协议语义也会被误报；字面 grep 不能作为门，因为它会
    漏掉 `case "fluid-dex-swap"` 这类分支；
12. `>200 LOC` family 的 framework/重复 orchestration review receipt，以及 Eigenpie 新合同重写的
    before/after LOC 与重复逻辑报告；LOC 本身不决定 pass。
13. plan/quote ABI、approve requirement、landed-event、victim-model 与 pool-impact 若保留正交表，必须由
    registry 派生 exact coverage；新增 active family 但任何一面缺 owner 就 fail。
14. Production import closure 只能触达 active generated catalog；candidate/quarantined plugin module 即使含
    top-level throw/side effect 也不得被求值。Candidate runner 必须用外部 deadline/kill 证明无限循环或
    超量输出只能生成 quarantine receipt。
15. Promotion receipt 的 family/source/schema/generator/base/dependency/fixture/review hashes 必须从源码重算；
    plugin 自声明、手改 generated catalog、stale receipt 或 source hash 漂移全部 fail。
16. 注入 matcher throw/timeout、错误 identity、重复 edge、错误 mid、ActionAdapter 冲突与模块顶层副作用的
    bad candidate 后，active manifest/import closure、healthy-family graph/mids、route/rank/calldata hash、
    ActionAdapter closure 与 production startup/result 必须和“不存在该 candidate”的冻结基线 exact 相同。
17. Active runtime 的 family outcome map 必须证明 failed family 本代不可用、healthy families 继续 current-N；
    degraded run 不能输出完整图 `no opportunity`，依赖 incomplete family 的 route 不能进入 quote，而只依赖
    complete families 的 route 能自然走到 final sim/EV。Strict acceptance 另断言全部 active family complete。
18. Candidate/active cache namespace 必须绑定 chain、active manifest、family、capability schema、plugin source
    hash 与 source block/hash；candidate 动态 cache 不得在 promotion 后复用。

每个 active family 都要有 interface/conformance 测试；每种共享 framework 至少要有两个真实 family 的正例和
负例；高风险 ABI/repayment/rounding 必须有 known-good fork fixture。单个 DODO/Eigenpie fixture 不能代表整个
universal registry。

### 8.4 tx055 严格 blind 六步与秒数

本轮把六步统一成 `gates.md` 的 block-scan 物理阶段；A/B equivalence 是六步完成后的比较，不再冒充第六个
生产阶段：

| # | 生产阶段 | tx055 通过条件 | 时间口径 |
|---:|---|---|---|
| 1 | graph/admission + current-N state | 以 watermark 到 N-1 的完整 production base 为起点，在计时区间内处理 N delta；`GraphView(25585380)` completeness 覆盖 N；完整 active-family graph 自然包含三条腿；由完整 universe+manifest 派生的 expected required state-key/edge exact-set 全部在 N resolved，coverage hash 相同 | `source_head_seen → state_ready`，记录 wall/cumulative ms |
| 2 | route enumeration | 完整 ordered route 自然出现在 candidate set，记录自然 rank；不得 append | `state_ready → enumeration_done`，记录 wall/cumulative ms |
| 3 | exact quote/refine | target 自然被 probe；逐腿 quote/rounding 绑定 N；amount 由 solver 搜索，不取 landed amount | `enumeration_done → exact_refine_done`，记录 wall/cumulative ms |
| 4 | planner + solver | route 自然进入 solve set，plan count > 0，family/action ownership 正确 | `exact_refine_done → planner_solver_done`，记录 wall/cumulative ms |
| 5 | resolved-plan clean-fork re-sim | production compiler 现编 calldata；sim success、还贷、无 standing position，记录逐 wei profit/gas | `planner_solver_done → final_sim_done`，记录 wall/cumulative ms |
| 6 | production EV decision | unchanged production evaluator 必须执行；输出 `execution_status=pass` 与可复算的 `decision=allow|reject`、`decision_reason`。本样本允许正确 reject，禁止把结果写死 | `final_sim_done → ev_decision`，记录 wall/cumulative ms |

唯一硬秒数门是全部六阶段 `source_head_seen → ev_decision` 的
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
`source_head_seen` 后并计时。任一阶段 `bypassed/not-run` 都是 correctness fail，不能从 p95 样本中删除。

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

### 8.6 Conversion 更新块 freshness blind sentinel

tx055 只能证明完整热路径和 busy/latency transition，不能证明“动态 conversion mid 不用 TTL”已经兑现。
因此本轮再增加一个必要但不充分的 held-out sentinel：

1. challenger freeze 前先公开并封存 chain range、eligibility predicate/version、`minEligibleCardinality ≥ 32`
   和 selection algorithm；root-only trusted oracle 另持有 `secretSeed + salt`，只公开
   `SHA256(secretSeed || salt || rangeHash || predicateHash)` commitment。freeze 后才 reveal seed/salt 并
   验证 commitment，再按算法从真实链上解析一个 ERC4626 donation/harvest/loss 或 wstETH oracle-report
   更新块 `N`。集合小于预声明 cardinality、或没有合格样本时直接记 `freshness_evidence=missing`，不能让
   challenger 通过枚举小集合提前知道目标，也不能看输出后挑样本；
2. eligibility 必须在 trusted reference 上预先要求自然候选能到达六个生产边界，并排除同时触碰目标
   active DEX/routes 的混杂更新；否则 oracle 必须提供固定边界 causal pair：同一 prefix 的 update 前/后，
   或在固定 N 状态只撤销该 conversion update，证明 target mid/candidate delta 随之消失。这个
   oracle-only counterfactual 不提供给 producer；“禁止 synthetic override”只约束被测 producer；
3. baseline/challenger 各自包装己方 frozen SHA 的真实 production entry closure；byte-identical 只约束
   sealed N-1 base、source block N、当前 live A normalized config（除预声明 activation additions）、
   universe、共同 baseline-active manifest、backend 与 output schema。challenger 的 addition manifest
   另行封存且计入其完整图；两边都不得收到 tx hash、协议/实例/token/route、预期 rate/mid、
   candidate fingerprint、amount 或 calldata；
4. 两边的 N-1 control 与 N measured run 使用相同静态 cache snapshot，但各自从独立 generation/clean
   fork 启动，清空 dynamic state/mid/refine/amount/plan/sim/EV caches。N-1 不能紧邻 N 形成
   target-specific prewarm；topology delta 与全部 current-N dynamic reads 在 N timer 内执行；
5. baseline/challenger 分别封存 N-1/N 的 full-graph mids、candidate/rank、exact quote、
   plan/final-sim/EV 原始输出后，trusted comparator 才 reveal oracle。pass 同时要求：自然 family admission、
   N 的 stateKey fresh read、`deriveMids` 当块改变、causal candidate/rank delta 与 oracle 一致、自然候选走完
   六阶段，以及双方同输入的输出/资源差异满足本轮 A/B 合同；
6. producer 不能使用 synthetic state override、目标预热、route append、减图、TTL fallback 或
   acceptance-only 参数；使用与 tx055 相同的 production-entry/config/universe provenance、计时与
   held-out control 规则。无合格因果样本就如实缺证，不能用合成 fixture 或“原则上会更新”替代。

该 sentinel 只覆盖 conversion lane。Curve/DODO/external swap 的 current-N 语义仍由 family cohort、
known-good fork fixtures 与 paired live coverage 证明，不能拿一个 ERC4626/wstETH 样本代替全量 family。

## 9. 非目标

本计划不顺手扩大到：

- 批量交易 corpus 的 missing-family 自动分类、execution-fingerprint 聚类或自动生成 adapter；本轮只交付
  plugin authoring/隔离/promotion/runtime 边界，为以后工具保留 capability 入口；
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

完成后，一个新 production execution family 以一个自包含 plugin module 按自己的 kind 同时交付完整纵向合同：

```text
identity/discovery
route or funding projection
current-N state
quote/sizing or borrowability
plan/callback + owned/required ActionAdapters
final-sim/accounting assertions
```

通过 trusted promotion、进入 generated active catalog 后：

- route family 自动进入共享 discovery/graph 与 swap/protocol pricing lane；
- flash family 自动进入 funding selection/liquidity/repayment；
- 新增 family 的人工业务修改只发生在一个 plugin 入口文件；catalog/receipt 是工具生成物；
- `main.ts`、graph、planner、solver、state coordinator、ActionAdapter bootstrap 与中央 ID union 零 venue 编辑；
- current-block state 由统一 coordinator 调度；
- family 只拥有链上语义，不拥有 scheduler/cache/timer。

只有以下条件全部成立，才能写本计划完成：

1. 所有 baseline-active 高阶 execution semantics 都是 complete family；任何退出已先作为独立
   `approved_deactivation` 变更完成，且不计入本轮等价/性能 verdict；
2. `families/*` + trusted promotion receipts 是唯一 lifecycle catalog；production import closure 只含其
   generated active view，candidate/quarantine code 不被求值；
3. `PRODUCTION_ROUTE_ADAPTERS`、`FLASH_PROVIDER_DESCRIPTORS`、`LEGACY_PRODUCTION_ROUTE_EDGES`、
   production `compat` 和 legacy fallback 全部不存在；
4. legacy island 的 production reachability 为零；
5. topology completeness/pass-consistency 合同已机器化，不存在固定 `T-k` 许可；
6. 动态 swap/protocol/flash funding state 全部绑定 source N；
7. `main.ts`、graph、planner、quoter、solver、plan-builder、live backend 不含 venue/provider-specific
   production 分支；
8. 一个 family runtime supervisor/coordinator；route-price 只有 swap/protocol 两 lane，flash 作为 typed
   funding product；单 family failure 只关闭其本代输出，healthy family 继续运行且全局显式 degraded；
9. tx055 strict blind 六步全部执行、post-hoc 匹配、steady-process/fresh-source-state p95 `<10s`，且反作弊断言全绿；
10. conversion 更新块 blind sentinel 通过 commit-reveal、因果反事实与同输入 A/B 证明真实 N-1→N
    rate/mid/candidate delta，且无 oracle 泄露；
11. active-family 完整 graph paired live 达到预先冻结的 `<10s` 统计口径；
12. busy-source coverage 达到预先冻结的 paired-window 门；
13. bad-plugin 零污染、trusted promotion、active-only import closure、cache namespace 与逐-family failure
    conformance 全部通过；
14. registry conformance、语义等价、state coverage、资源与 reviewer verdict 全部通过。

在此之前，准确状态只能是计划或 `implemented_not_validated`，不能写 busy fixed，也不能写 live performance 已验收。

## 11. Fable 对照审计与最终收敛

审计对象是 [fable-adapter-family-line-plan.md](fable-adapter-family-line-plan.md)，其事实基线为
`ad35790`；本轮在 `7bd6d40` 上重新对照当前代码与本文。结论不是“选一整份”：Fable 有若干实质优点，
已修正后并入本文；其余分歧全部裁决，实施只看本文与 [gates.md](gates.md)。

### 11.1 Fable 哪里更好，如何采纳

| Fable 的优势 | 审计结论 | 收敛位置 |
|---|---|---|
| §5.4 把 state capability 写成可检查的微观不变量 | 真优点；补足本文原先只有职责、缺少机器护栏的问题 | §3.3、§8.3：pure `deriveMids`、stateKey 唯一调度、batched fallback、event 仅提示、稳定 hash |
| §5.1–5.2 把旧 live 耗时与串行 await 链串成完整证据 | 真优点，但 `29,220` edges、`1,879` tasks 等只属于旧基线，不能冒充当前值 | §1.1/§5 保留历史证据；开工时按 §7.2 重新生成 inventory |
| §1 的 adapter×identity×warm×prepared×gap 矩阵更容易施工 | 真优点，但其 prepared/flash cadence 单元格有事实错误，手写表也会过时 | §7.2 把 identity、state lane/key、prepared 与 batch shape 加入生成式 inventory schema |
| §2/§8 要求“共享生产代码零 venue 特判”成为 CI 门 | 目标正确；其 literal grep 已经漏过 switch/case，不能照搬 | §8.3 改为 registry-derived AST + production import-closure 检查 |
| §7 的 F0–F5 切片便于 review，并显式区分 deterministic 与 live-distribution 工作 | 仅适合作为 shadow 开发 work packages，治理必须按真实 production reachability 分流 | §7.5/§7.9：允许分提交，production 仍一次 cutover |
| §3.3 用行数检验 family 是否够轻 | 有价值的 code-review smell，不是 correctness gate；直接文件实测中位数 152 行、11/15 ≤200，说明它只能触发审查且需防拆文件规避 | §4.3/§8.3：核心声明文件 `>200 LOC` 触发强制 review，并用 Eigenpie before/after 压测 framework 完成度 |
| §5.3/§8 要求真实“更新块跳变”样本 | 真优点；本文原先只声明动态 mid 不用 TTL，没有样本证明该原则 | §8.6 + `gates.md`：challenger freeze 后选择 conversion-lane blind sentinel |
| §5.1 的 SSM/tool execution 凭据 | 让旧性能归因可追溯，但现存 manifest 只有截断摘要 | §1.1 记录 receipt；正式验收前恢复完整 SHA-256 |

### 11.2 Canonical 更强、明确否决的点

| Fable 提议 | 裁决 |
|---|---|
| topology 最多可用 `T-10` | 否决。固定滞后会漏掉 N 新实例；必须证明 `completenessWatermark >= N` |
| `4.5/1.8/3.2/0.5s` 分段硬预算，且只到 `scanner_done` | 否决。唯一硬门是完整六阶段 `source_head_seen → EV decision`；分段只如实计时 |
| Fluid DEX 未迁完就默认暂停 block-scan 覆盖 | 否决。baseline-active 不能在本轮 gate 中退出；产品若下线须先走独立 `approved_deactivation`，不能靠减图提速 |
| 把 flash 放进 `PRODUCTION_ROUTE_ADAPTERS`/`RouteLegKind` | 否决。使用 universal discriminated registry 的 typed funding view；flash 不伪装成 route/price edge |
| `lane` 仅含 swap/protocol，同时声称能协调 flash | 类型自相矛盾。universal coordinator 有 typed funding capability，但 price scheduler 仍只含 swap/protocol |
| flash 已“每块一个 Multicall”，迁移行为不变 | 事实错误。当前默认约 `120s` 刷新且每 400 tokens 分 chunk；source-N funding 是需验收的行为变化 |
| 新 head 到来立即取消旧 pass | 未证明。保留 latest-head single-slot 候选，但是否 abort 由 transport cancellation、orphan settle 与 benchmark 裁决 |
| strangler 每片替换 production | 否决。允许 shadow 分片开发，不允许半新 registry + 半旧旁路的生产中间态 |
| lender `before == after` | 错误。flash fee 可使 lender 增加；按 provider repayment/fee 语义验证，通用下界是 `after >= before` |
| unresolved mid 直接送 exact probe | 不作为通用生产策略。它可能放大候选并掩盖状态缺口；strict full-profile 必须 current-N 全覆盖 |
| generic ActionAdapter 唯一 owner | 不成立。family-owned encoder 与 `approve/transfer/assert-balance` 等 shared infra 必须分开校验 |

### 11.3 事实审计修正

Fable §1 把三处 Fluid/legacy 接线称为接近穷举，仍不完整。Fluid route 旁路至少还存在：

- `quoter.ts` 的 `case "fluid-dex-swap"`；
- `revm-live-backend.ts` 的 quote 与 allowance-spender 特判；
- `blockscan-scanner.ts` 的 Fluid mid 特判；
- `token-graph.ts` 的 adapter map、Fluid 分发与两条静态 Fluid edges；
- plan-builder switch、`LEGACY_PRODUCTION_ROUTE_EDGES` 和 `main.ts` 特判。

更宽的 production-family inventory 还必须覆盖 `pool-state-updater.ts` 的 V2/V3/V4 state dispatch、
`amount-propagation.ts`/`solver.ts` 的 fluid-credit 分支，以及 `main.ts`/`victim-apply.ts` 的 victim-state
variant。Fable 的现状矩阵也误把 protocol `prepared` 整组写成 `null`：PSM、Eigenpie、Goldx、
Metronome synth 已有 prepared capability，fluid-credit 也不是空；必须由代码生成 inventory 后逐项裁决。
静态 ERC4626/legacy instance rows、`PROTOCOL_LEG_DESCRIPTORS`、capability、landed-event、victim-model 与
pool-impact 表也必须进入同一 closure inventory，不能只迁 route registry 后留下第二套 admission/ABI/
observation owner。

这也反证 literal grep 不能承担 conformance。开工 inventory 必须从 production import/consumer closure
生成，不能继续维护一张声称“穷举”的手工清单。

### 11.4 旧线冻结粒度——终裁：完全冻结（用户 2026-07-23）

原分歧是新线构建期，正在 live 的旧 searcher 是否允许先打“看似无害”的补丁。对向审计先证明状态层提速
本身会改变 deadline 内可完成的扫描集合，“bit-identical 旧线优化”并不存在；用户随后终裁：
**旧线完全冻结，构建期不打任何补丁**。本次预计一天量级，且不动的旧线是最干净的 A/B baseline。

若构建窗口因验收返工显著延长到数天以上，冻结决定由用户重新裁决，agent 不得自行放开。生产入口仍按
§7.7 一次 root-import 翻转。

### 11.5 唯一收敛结果

- 本文是唯一架构与施工真相源；`gates.md` 是唯一验证合同；
- Fable 文件保留为带批注的历史审计输入，不再保留待裁决架构分歧；
- 已采纳内容只以本文上述接口、inventory、conformance 和 shadow work-package 形式生效；
- 本轮预计一天量级的构建窗口内旧 live production line 完全冻结；若窗口显著延长，只能由用户重新裁决，
  不能由 agent 自行放开；
- 任何后续实现若引用 Fable 中已否决的 `T-10`、硬分段预算、减覆盖、route 化 flash 或分片生产切换，
  视为偏离计划。

### 11.6 Fable 5 最终非作者复核

在远端两笔同主题提交完成 rebase、上述合同收敛后，使用 `claude-fable-5` 对基于 `329e352` 的最终工作树
只读复核。结果为 **P0=0**；两项 P1 已在本版关闭：

- A/B 各自使用己方 frozen SHA 的真实 production entry，byte-identical 只约束输入；
- 语义 parity 使用共同 baseline-active manifest，但性能/paired-live 各跑实际完整 manifest，addition 成本
  必须进入 challenger 计时。

同时直接修正四项小问题：held-out eligible cardinality 下限、Eigenpie 压测与 `>200 LOC` 解耦、
`source_head_seen` 事件名统一，以及 Fable 历史稿的 tx055 交叉引用。该复核只证明计划/gate 文本闭合，
不把任何实现、历史 gap 或 `<10s` 性能标成已完成。

## 12. Plugin 方向对抗审计与终裁（用户 2026-07-23）

用户将目标进一步收敛为：family 内可以容纳完整协议复杂度，中央接口只调度 typed capabilities；一个 family
适配错误时，错误必须精确归因于该 family，不能阻止其他 healthy family 正常 current-N、enumeration、
final sim 与 EV。批量交易 corpus 的 missing-family 分类本轮明确不做。

独立非作者对抗审计最初给出 **3 个 P0、4 个 P1**。本文已把全部阻断项转成 §§0、3、7、8、10 的硬合同，
因此设计层 verdict 为 **approved_to_implement**，不是代码或验收通过：

| 审计发现 | 终裁 |
|---|---|
| ESM eager import 在状态过滤前已执行 candidate 顶层代码 | candidate catalog 只含 metadata/hash；production generated catalog 只 import active plugin；candidate 在独立受限进程验证 |
| plugin 可自称 active 会绕过隔离 | trusted promotion receipt 绑定 source/schema/generator/base/dependency/fixture/review；hash 漂移自动退回 candidate |
| 当前 whole-runtime atomic 与 family-local 隔离目标相反 | 改成逐 `(familyId,generation,sourceBlockHash)` publication；failed family 本代关闭，healthy family 继续，全局显式 degraded |
| partial run 容易制造假 `no opportunity` | degraded run 禁止完整图负结论；route dependency closure 必须全部 complete；strict acceptance 要求全 active complete |
| candidate matcher/claim 可影响 incumbent | candidate namespace 与 active ownership 隔离；冲突只 quarantine candidate；两个 active owner 冲突是 manifest 构建错误 |
| ActionAdapter 仍可能是第二中央真相源 | plugin bundle 携带 family-owned 实现；candidate 不注册；active bootstrap 从 generated catalog exact closure 派生；shared infra 只按 ID 引用可信基础设施 catalog |
| cache/source 升级可能交叉污染 | dynamic key 绑定 chain/manifest/family/schema/source-tree/source block+hash/stateKey；static key 去掉 block 但保留 family/schema/source-tree；candidate 与 active 隔离 |
| “进程没崩”不足以证明零污染 | bad-plugin suite exact 比较 active manifest/import closure/graph/mids/routes/rank/calldata/actions/startup，并用外部 kill 覆盖资源 DoS |

这轮也修正了“一个 family 要拆多个文件”的误表述：**默认一个 family 一个生产入口文件**，capability 是同一
bundle 内的字段，不机械拆成 discovery/state/route 子文件。测试/fixture 与真正通用 framework 可独立；
family-specific orchestration 不能因此回流中央。

当前代码只有在下列事实全部成立后才能称 `plugin-complete`：

1. 新增 family 的人工业务 diff 只包含一个 plugin 入口；其余变化只能是可重现 generated catalog/receipt；
2. production import closure 对 candidate/quarantined plugin 为零；
3. ActionAdapter、pool/venue/identity descriptor 与 capability 都从 plugin bundle 派生，不再修改中央协议表；
4. load/discovery/state/quote/plan/encode/observation 的错误都由 family supervisor 隔离和归因；
5. bad candidate exact-zero-impact suite 与 active family degraded-runtime suite 通过；
6. 所有 active family complete 时，再执行 §§8.4–8.6、完整 cohort 与 paired live A/B。

在此之前，当前分支最多是 `plugin_implemented_not_validated`，不能因为统一 registry 已存在就声称插件边界完成。
