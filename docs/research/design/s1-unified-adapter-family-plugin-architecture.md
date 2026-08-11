# S1 统一扫描驱动的 Adapter Family 插件架构与实现合同

> 状态：**以 ds 分支为实现基线的目标架构合同与迁移/删除计划。** 本文统一 Swap / Protocol Adapter
> Family 的动态发现、身份准入、实例编译、路线投影、coarse pricing、exact quote、执行片段、特殊协议
> 语义和失败隔离。它既记录 ds 已经实现的基础设施，也定义从当前双模式代码迁到最终单路径合同的剩余工作；
> 不得把“ds 已实现”“迁移期兼容桥”和“最终目标”混写成同一种状态。
>
> 本文在上述范围内取代旧文档中的中央手写 Family 清单、全 Family `schema.pools/groups`、手工
> `adapterSchemaRevision`、Adapter 内直接 RPC，以及靠具体协议名扩展中央分支等目标设计；并已直接吸收
> 仍有效的 Adapter Replay、`family_local` 与六步验收语义。正式 verdict、promotion 与安全权限仍以上位
> [`gates.md`](../gates.md)、[`HISTORICAL-GAP.md`](../HISTORICAL-GAP.md) 和
> [`templates/six-step-validation.md`](../templates/six-step-validation.md) 为准。旧
> [`adapter-family-extension-boundary-and-six-step-acceptance.md`](../adapter-family-extension-boundary-and-six-step-acceptance.md)
> 仅保留历史背景，不再是新实现或验收入口。
>
> **冻结实现参考基线：**
> [`origin/codex/ds-blockscan-state-timing-refactor@94cdf1d4100e9e96c95c585365c94eaf374b383d`](https://github.com/EuniceLeeee/c0ffeebabe.eth/tree/94cdf1d4100e9e96c95c585365c94eaf374b383d)。
> 本文的现状判断来自该提交的实际生产入口、registry、discovery、StateInstance coordinator、transport
> scheduler、exact feedback 和测试；**不以 `main` 作为实现参考。** 分支 tip 后续若前进，实施前必须先做
> 基线漂移审计，不能只替换这里的 SHA。

## 0. 阅读约定与 ds 基线快照

全文使用四种状态，避免设计代码被误读成当前 API：

- **DS 已实现**：冻结基线已经存在并有当前测试/生产调用路径；新架构应复用，不得重复发明。
- **DS 迁移桥**：为兼容现有 Family 暂时存在；允许在批量重构期间使用，但必须有唯一 owner、使用范围和删除门。
- **目标合同**：本文件要求落地的最终接口；示例类型和伪代码除非明确标为当前代码，均属于这一类。
- **迁移终态**：全部生产 Family 切换并验收后只剩一条生产路径；兼容桥从源码、类型、配置和测试入口中删除。

冻结 ds 基线的真实状态如下：

|范围|冻结 ds 基线|本文终态|
|---|---|---|
|生产激活|`LEGACY_PRODUCTION_ADAPTER_FAMILIES` 手工列出 20 个 Family；tracked-source loader 自动扫描 Astra、EtherToken 两个 `*.production.ts`，合计 22 个|所有生产 Family 都由严格构造器产出，并通过 build-time generated static-import catalog 加载；legacy 数组与生产 runtime source scan 删除|
|高层 ownership|`AdapterFamilyRegistry` 已是唯一高层 registry，并派生 route、swap、protocol、funding、landed event、victim、discovery、pricing 与 action ownership 视图|保留唯一 registry/派生视图思想，输入收紧为 branded Swap/Protocol 插件及独立的其他 Domain 插件|
|Adapter API|`RouteLegAdapter` 仍提供异步 `buildEdges(pool, backend, control)`、`quoteExact(ctx.state)`、`buildPlanFragment(ctx)`；`ProtocolDiscoveryContext` 直接暴露 `backend`|Adapter 只声明 request program 并同步 decode/derive/build；transport、deadline、retry、cache 和并发完全归中央|
|Blockscan pricing|中央 per-StateInstance diff/cache/GraphChangeSet/CAS/warm-cache/tombstone/失败隔离已落地，并已有 lane/family 的 partition/read/finalize/sort 与 assembly 分段 telemetry；UniV2、UniV3、UniV4、DODO V2、Angstrom V4 已进入 `state-instance-v1`|所有 active pricing Family 迁移；descriptor-only current/decode 路径替代 family-shaped facade|
|descriptor publication|最终 snapshot/topology 有 canonical CAS；但 `prepareInstanceFamily()` 为避免 supersede 重编，会在最终 CAS 前写 `instanceSchemas`、spec fingerprint/spec/shared-fingerprint Maps，而这些 Maps 又会成为下一代 published-previous 基线|拆成 `CompileMemoStore` 与 `PublishedDescriptorStore`；memo 可内容寻址预热但不授权 previous/carry，published store 只在 source verify + generation fence 后原子切换|
|迁移 facade|已迁 Family 仍用 `assembleSchema(entries)` 包装出 `{pools/groups: Map}`；未迁 Family 仍走 `legacy-family`|`assembleSchema`、`legacy-family`、full-family runtime compiler 全部删除|
|缓存版本|`adapterSchemaRevision: "...-v1"` 仍由作者手工维护|构建生成 capability 内容哈希；手工 revision 与 fallback 删除|
|reth 调度|`LiveRethReadPriority` + `RethTransportScheduler` 已有 producer-critical/producer-bulk/exact/discovery lane、producer reserve，且 coarse 外层整代 foreground lease 已删除；但 `withHardRequestTimeout()` 的逻辑超时仍可在底层 fetch/body 未 settle 时让外层释放 slot/permit|所有 Adapter I/O 进入统一 work-intent policy；物理 transport settle 前不得释放容量，并补齐 Family/instance fairness、跨阶段 dedupe、统一 outcome 与 final-sim 保留池|
|Exact feedback|`adoptExactProbeMids()` 会把 amount-dependent exact quote 的 `amountOut/amountIn` 写入 coarse recovery base；即使 source 已 CAS，这个值仍未绑定完整 exact capability、route binding、executor 与 runtime evidence|exact cache 与 coarse state 严格分权；删除 exact→coarse 写旁路。若将来需要 quote-derived coarse observation，必须定义独立 capability、兼容投影和 publication proof，不能复用任意 exact 结果|

对应代码入口：

- [`production-registry.ts`](../../../listener/src/searcher/venues/production-registry.ts)、
  [`production-families/loader.ts`](../../../listener/src/searcher/venues/production-families/loader.ts)；
- [`adapter-family-registry.ts`](../../../listener/src/searcher/venues/adapter-family-registry.ts)、
  [`route-leg-adapter.ts`](../../../listener/src/searcher/venues/route-leg-adapter.ts)；
- [`blockscan-state-capability.ts`](../../../listener/src/searcher/venues/blockscan-state-capability.ts)、
  [`blockscan-state-coordinator.ts`](../../../listener/src/searcher/blockscan-state-coordinator.ts)；
- [`reth-transport-scheduler.ts`](../../../listener/src/searcher/reth-transport-scheduler.ts)、
  [`live-reth-read-priority.ts`](../../../listener/src/searcher/live-reth-read-priority.ts)、
  [`blockscan-runtime-loop.ts`](../../../listener/src/searcher/blockscan-runtime-loop.ts)。

**2026-08-08 实施审计 checkpoint（不是部署或完成声明）：** 本轮实施基线为
`codex/s1-unified-adapter-architecture@750028ea0e6afcda57f0b13ec68b239649cde729`；严格
catalog 已能装载 22 个 Family、生成 220 个 capability entry，但 production route/discovery/pricing/planner
authority 仍由旧 registry 派生，严格 lifecycle/exact/execution 入口还没有真实 production route consumer。
所以“catalog/插件文件齐全”只表示合同骨架已建立，不能据此宣称 Graph cutover、pool 尖峰关闭或 §18 Phase E
完成。后续 checkpoint 必须分别记录 committed HEAD、production source closure、runtime authority 和验收 receipt，
不能把本 change set 的观察倒填成上述基线 HEAD 已具备的能力。

当前阶段状态必须按证据等级拆开记录，不能用一个“完成百分比”把 unit contract、shadow 接线和 production
authority 混在一起：

|阶段|截至 2026-08-09 committed slice 可确认状态|仍未满足的晋升条件|
|---|---|---|
|Phase 0 共享 substrate|physical-settlement ownership 与 published/memo store separation 已有 change-set 实现和定向 unit contract；已绑定 committed HEAD `934eed7a`，Phase 0 回归集（lifecycle-content-cache、catalog-publication、state-carry-proof、discovery-checkpoint、完整 build）全过|即使通过也不能据此宣称 deployed/live；Phase 0 是后续 parity 的前置，不与 Family 迁移混同|
|Phase A baseline/comparator|production-shaped runner、capture schema 与 comparator contract 已存在，`7ba6f9d3` 已落地 trusted sealed-production capture issuer（unit runner 继续拒绝自封 `sealed-production`），`a879665a` 已落地双侧 capture 文件入口 `runArchitectureMigrationParityFiles` + `architecture-migration-parity:run` CLI|当前只有 `unit-contract`/`ineligible` 证据；尚无旧 ds 与 challenger 的 `sealed-production` 双侧 capture/receipt|
|Phase B 中央骨架|严格 catalog 可装载 22 个 Family、生成 220 个 capability entry；Request Program、hash、route/exact/publication 等骨架已建立；`1527c116` 为 exact quote cache 补独立 issuer/key 绑定/LRU/eviction 合同测试|多数入口仍是 shadow/disabled path；generated hash 尚未成为全部旧 blockscan cache 的唯一 production key|
|Phase C Family 迁移|22 个严格 Family 定义和 shared conformance/unit fixtures 已存在|尚无绑定真实 baseline/challenger production closure 的 batch parity receipt，不能把 synthetic rows 当成迁移通过|
|Phase D production cutover|Graph/publication、exact、Funding opaque issuer + empty tombstone、Credit lifecycle-issued instance + route/risk/execution boundary、observation ingress / append-only 全 catalog CAS、file-backed durable discovery checkpoint/CAS、`c7d9fa54` 的 snapshot inventory closure same-process verifier shadow contract、`642373c1` 的中央 value 深冻结 + StateInstance mutation/carry shadow proof、`9d954df4` 的 Credit 独立 execution handle shadow issuer、`8d4ed796` 的 point-in-time enumerator core 纯函数合同、`4275be6f` 的 durable discovery continuity composition root、`c383e58f` 的 main env 门控接线、`dd0df3d8` 的 Funding 进 strict catalog atomic CAS，以及 `4b8b79d4` 的 Credit 进 strict catalog atomic CAS（route/graph 槽扩为 union、CreditRouteRuntimeHandle/ProjectedCreditRouteGraph 同 CAS、省略即拒绝 carry）等 runtime slice 已有 unit/shadow gate|strict catalog prepare 内的一次性消费（complete-snapshot 仍拒绝）、production point-in-time enumerator 的真实数据源接线、strict pricing production consumer、Funding/Credit production consumer、默认 authority、sealed parity 和 systemic-live gate 均未关闭|
|Phase E cleanup|尚未开始|legacy registry/API/schema/revision/cache/flag authority 仍在；只有 §18.3 与 §20.2.6 全部门通过后才能删除|

该表是实施 checkpoint，不是目标合同的降级，也不预判并行实现工作最终是否通过；任一状态更新都必须引用新的
commit、测试/receipt 和实际 production consumer closure。

**2026-08-11 Phase 0 绑定 checkpoint：** 以 committed HEAD `934eed7a` 为绑定点，
`searcher:adapter-family-lifecycle-content-cache`、`searcher:adapter-family-catalog-publication`、
`searcher:adapter-family-state-carry-proof`、`searcher:adapter-family-discovery-checkpoint`
与完整 listener build 全部通过。该绑定只证明 Phase 0 substrate 在当前 HEAD 的合同回归；
不宣称 deployed/live，也不改变 Phase D/E 未完成状态。

**2026-08-11 Phase B exact cache contract checkpoint（实现 commit
`1527c116b6b096693f6b2b0315fb063dcfd69b0f`）：** 新增
`searcher:adapter-family-exact-quote-cache` 合同：cache key 绑定全部地址字段
（familyRuntimeIdentity/capability/compatibility/method/request/amount/executor/source hash），
generation 刻意不进 key；store/lookup/LRU/eviction、只接受 source-bound 成功结果与非空
SHA-256 roundFingerprints、中央签发身份与冻结输出。证据：该测试 PASS + 完整 listener build。
仍是 shadow 合同，不改变 Phase D 未完成状态。

## 1. 一句话定义与完整流水线

Adapter 负责协议/合约语义：**识别什么、证明什么、实例是什么意思、读什么、怎样解码、怎样报价、怎样编码执行。**

中央 framework 负责机制：**扫描、I/O、并发、预算、重试、缓存、diff、CAS、全局枚举、solver、final sim、EV 和发布。**

完整运行顺序如下：

```text
链上 block / log / receipt / trace / call / code surface
        ↓
S1 Discovery：selector/topic 只做候选分流
        ↓
S1 Identity：链上反向证明 + 行为证明，fail closed
        ↓
S1 Instance：生成 InstanceBinding / InstanceDescriptor
        ↓
S1 Route Projection：一个实例投影为一条或多条 verified route
        ↓
Verified Graph + 指定 source 的 coarse pricing snapshot（通常严格 N-1）
        ↓
S2 Enumeration：中央枚举 route/ring，并按 coarse spread 排名
        ↓
选择排名靠前且达到 admission floor 的候选
        ↓
S3 Exact Refine：中央预算下执行 family exact quote program
        ↓
S4 Planner / Solver：family 只构造本 leg 的 PlanFragment
        ↓
S5 Final Fork Simulation：中央执行完整计划、守恒与还款验证
        ↓
S6 EV 决策
        ↓
Submission / Inclusion（六步之外，仍受人工安全门约束）
```

这里必须区分两个容易混淆的动作：

- `projectRoutes(instance)` 是 S1：把 UniV3 pool 投影成正反两条边，或把 Astra 多 token 合约投影成多条有向边。
- `enumerate(graph, coarseState)` 是 S2：在全局图上组合多条边，找闭合套利 route/ring。

Coarse state producer 只准备供 S2 使用的 pool/edge 粗价格状态；它本身不枚举套利环路。

上图是**最终语义流水线**，不是说冻结 ds 已经通过一个统一插件对象执行全部阶段。ds 已经有公共 Graph、
coarse producer、S2 enumeration、exact、planner/final sim 等生产阶段，也已经由唯一 registry 派生多种能力；剩余
重构是把各阶段目前不同的 Adapter 调用形态收敛为同一声明式边界，而不是重写整条搜索流水线。

## 2. 核心不变量

这些是终态不变量。迁移期只有 §0 明确列出的兼容桥可以暂时违反；不得新增第二种 bridge，也不得把 bridge
作为新 Family 的推荐写法。每个 bridge 必须在 §18 的删除门关闭后消失。

1. **插件代码加载一次，链上实例动态产生。** 自动加载的是协议解释能力，不是 pool、vault、Factory 或地址 allowlist。
2. **Selector/topic 只提名 candidate。** 相同 selector 可以命中多个 Family；只有 Identity Proof/Active Probe 能准入。
3. **Factory 是 provenance/lineage，不是实例 allowlist。** 不同 Factory 可以产生同一执行 Family；同一 Factory 也可能产生不同语义实例。
4. **Family 是语义、能力、ownership 和故障命名空间，不是 pool 容器、编译单位或排名单位。**
5. **编译单位是 `familyId + stateKey` 的 StateInstance。** 正反方向共享状态时必须一起交给 Adapter 校验，不能逐 edge 编译。
6. **中央不得出现具体 Family 分支。** `if (familyId === "univ3")`、按 Adapter ID 的中央静态表或 direct import 都是架构违规。
7. **Adapter 不执行 I/O。** Adapter 纯同步地声明 requests、解码 results、验证证据和派生语义；中央执行 transport。
8. **单实例失败不连坐 sibling。** changed 实例失败也不能继续使用 fingerprint 不匹配的旧 descriptor。
9. **未知 hook/extension fail closed。** 只有通用策略明确允许时才可降为 simulation-only，不能按标准池执行。
10. **Final simulation 永远是最终关闭门。** Identity、probe、coarse、exact 或 Adapter Replay 都不能替代它。
11. **统一调度的最小占用单位是物理 request/batch/simulation。** Family、实例、coarse generation 或一整个
    producer arm 都不能持有共享 transport lease；CPU 组装、等待依赖和 decode 必须在 lease 之外。lane、
    deadline、并发、重试与公平性全部由中央从 stage/source 推导，Adapter 不能自行申报“高优先级”。
12. **逻辑完成不等于物理释放。** consumer deadline/abort 可以结束该 consumer 的等待，但 physical fetch、body
    parse、worker 或 simulation 未确认 settle 前，scheduler permit 不能释放；否则配置并发与保留容量都是假象。
13. **权威状态只在全局 canonical CAS 后原子发布。** generation-local memo 可以预热，但不能成为 published
    previous、授权 carry 或进入跨 generation cache；descriptor/snapshot/exact 的晋升必须经过 source verify 与 generation fence。
14. **route 与 exact 必须是 issuer-bound runtime handle。** 结构相似的 caller object 不是 authority；Graph、exact、
    execution 和 victim replay 只能消费当前 catalog/FamilyBox 签发并保存原始 descriptor/route/evidence 的 handle。
15. **Family shard 只 staging，全 catalog 只发布一次。** Graph、canonical-edge→route-handle index、pricing
    descriptor/snapshot 与 publication metadata 必须在同一个 source/generation fence 下原子切换，不能逐 Family
    先后成为 production truth。

### 2.1 “pool 尖峰”的关闭范围

本文把“pool 尖峰”拆成两类问题，不能用一句“统一 Adapter 后会更快”混在一起。

本合同必须关闭的是 topology/static compilation 的 **Family-wide 放大**：已有大量健康实例时，只新增或修改一个
pool，增量工作单位仍是 `StateInstanceKey = hash(familyId, stateKey)`；不能重新编译、重新 hydration、重新组装或
重新读取全部 sibling。

```text
已有 5,000 个 UniV3 StateInstance
        + 新发现 1 个健康 pool
        ↓
只产生 1 个 added StateInstance
        ↓
只编译并静态证明该新增 key
        ↓
原有 5,000 个 sibling compiler invocation = 0
原有 5,000 个 sibling static request = 0
family-wide compiler / assemble invocation = 0
```

`stateKey` 是共享同一价格状态的最小正确单位，不机械等于一个地址：UniV2/UniV3 通常是一座 pool；UniV4 是
`Manager + PoolKey`；Angstrom 等 singleton/sub-instance Family 使用完整 immutable binding；多资产实例可以让多个
方向共享一个 stateKey，但不能扩大回整 Family。

新增、删除或静态 binding 变化只触碰 added/changed/removed key。score/order 变化不得重编 descriptor；changed key
失败必须 tombstone 旧 descriptor，健康 sibling 继续发布，且不得退回 family-wide compiler。机器 receipt 至少记录：

```ts
interface PoolTopologySpikeReceipt {
  readonly familyId: FamilyId;
  readonly beforeStateInstanceCount: number;
  readonly afterStateInstanceCount: number;
  readonly addedStateInstanceKeys: readonly StateInstanceKey[];
  readonly changedStateInstanceKeys: readonly StateInstanceKey[];
  readonly addedCompilerInvocations: number;
  readonly siblingCompilerInvocations: number;
  readonly siblingStaticRequestCount: number;
  readonly familyWideCompilerInvocations: number;
  readonly familyWideAssemblyInvocations: number;
  readonly siblingCurrentRequestCount?: number;
  readonly carryProofRef?: string;
}
```

“只新增一个健康 pool”的冷 memo miss 硬门是 `added=1`、`changed=0`、`addedCompilerInvocations=1`、
`siblingCompilerInvocations=0`、`siblingStaticRequestCount=0`、`familyWideCompilerInvocations=0`、
`familyWideAssemblyInvocations=0`；已有合法
content-addressed memo 时新增 key 可以 `addedCompilerInvocations=0`，但不得超过 1。若 fixture 同时提供完整 carry proof，
unchanged sibling 的 current read 也必须为 0。该 receipt 还应记录 grouping/diff/sort wall time，但不承诺整代 O(1)。

这不承诺所有 active pool 每块零读取。没有安全 mutation/carry proof 的 reserves、slot0、liquidity、oracle 或 precision
witness 仍可能需要 current read；全图 diff/sort、receipts/activity、exact、CAS、solver 与 final sim 的剩余长尾属于
独立 `systemic_live` 轨道。S1 可以消除结构性全族放大，但不能把所有 live 时延自动归零。

## 3. 三层身份：Family、Lineage、Instance

```ts
type FamilyId = string & { readonly __familyId: unique symbol };
type LineageId = string & { readonly __lineageId: unique symbol };
type InstanceKey = string & { readonly __instanceKey: unique symbol };
type FamilyInstanceKey = string & { readonly __familyInstanceKey: unique symbol };
type RouteKey = string & { readonly __routeKey: unique symbol };
type StateInstanceKey = string & { readonly __stateInstanceKey: unique symbol };
```

|概念|回答的问题|例子|
|---|---|---|
|`familyId`|怎样报价和执行这种行为？|`swap:univ3-standard`、`protocol:erc4626-standard`|
|`lineageId`|通过哪种身份/行为证明归入该语义？|factory-child、registry-member、standalone ERC4626|
|`instanceKey`|某 Family 内的链上具体对象是谁？|pool 地址、vault 地址、`Manager + PoolKey`|

同一个 Factory 不是“同一个协议”的充分条件；Factory 只是一种证据。归类规则是：

- 执行、状态、quote、settlement 和 plan 能由同一 Family 仅替换实例参数表达，属于同一 Family。
- 身份来源不同但行为证明相同，可以使用不同 Lineage、同一 Family。
- 即使来源相同，只要 payout、callback、hook、accounting 或 plan 节点序列不同，就应拆成另一 Lineage，必要时拆另一 Family。

因此标准 ERC4626 可以同时接收 Factory、Registry 和 standalone 来源；Silo 非标准 payout 不能因为也有
`previewRedeem()` 就塞回标准 ERC4626 Family。

`InstanceKey` 只需在一个 Family 内稳定；中央跨 Family Map 一律使用
`FamilyInstanceKey = hash(familyId, instanceKey)`，避免同一物理地址承载多个行为 Family 时相互覆盖。

## 4. 顶层插件合同

**目标合同如下；冻结 ds 尚未实现这些类型。** 当前生产类型是
[`AdapterFamily`](../../../listener/src/searcher/venues/route-leg-adapter.ts) 判别联合，其中
`SwapAdapter` / `ProtocolConversionAdapter` 共享 `RouteLegAdapter`，production module 只是把一个现有
`AdapterFamily` 与其 ActionAdapters 装入 `defineProductionFamilyModule()`。这已经实现“一份 Family 定义派生
多种 registry 视图”，但还没有 branded Swap/Protocol 构造入口，也没有把 I/O 从 Adapter 中移除。

终态不是复制两套会漂移的七阶段接口，而是建立一个公共 `AdapterFamilyCore`，再通过互斥的
`SwapFamilyPlugin` / `ProtocolFamilyPlugin` 两个大模板收紧 Domain。具体 Family 在泛型闭包内保持强类型；
中央加载后只持有受控的 opaque 引用，不把协议字段降级成任意 `Record<string, unknown>`。

```ts
export interface AdapterFamilyCore<
  Candidate extends FamilyCandidate,
  Identity extends VerifiedIdentity,
  Descriptor extends CompiledInstanceDescriptor,
  Route extends FamilyRouteDescriptor,
  PricingDescriptor,
  PricingSnapshot,
  ExactEvidence,
> {
  readonly discovery: DiscoverySemantics<Candidate>;
  readonly identity: IdentitySemantics<Candidate, Identity>;
  readonly instance: InstanceSemantics<Identity, Descriptor>;
  readonly routes: RouteProjectionSemantics<Descriptor, Route>;
  readonly pricing: PricingSemantics<
    Descriptor,
    Route,
    PricingDescriptor,
    PricingSnapshot
  >;
  readonly exact: ExactQuoteSemantics<Descriptor, Route, ExactEvidence>;
  readonly execution: ExecutionSemantics<Descriptor, Route, ExactEvidence>;

  readonly sharedBindings?: SharedBindingSemantics<Descriptor>;
  readonly optional?: OptionalFamilySemantics<Descriptor, Route>;

  /** 与 Family 一起加载并由 ownership gate 校验。 */
  readonly actionAdapters: readonly FamilyOwnedActionAdapter[];
}

export interface SwapFamilyPlugin<
  Candidate extends FamilyCandidate,
  Identity extends VerifiedIdentity,
  Descriptor extends CompiledInstanceDescriptor,
  Route extends FamilyRouteDescriptor,
  PricingDescriptor,
  PricingSnapshot,
  ExactEvidence,
> extends AdapterFamilyCore<
  Candidate,
  Identity,
  Descriptor,
  Route,
  PricingDescriptor,
  PricingSnapshot,
  ExactEvidence
> {
  readonly manifest: FamilyManifest<"swap">;
  readonly swap: SwapDomainSemantics;
  readonly protocol?: never;
}

export interface ProtocolFamilyPlugin<
  Candidate extends FamilyCandidate,
  Identity extends VerifiedIdentity,
  Descriptor extends CompiledInstanceDescriptor,
  Route extends FamilyRouteDescriptor,
  PricingDescriptor,
  PricingSnapshot,
  ExactEvidence,
> extends AdapterFamilyCore<
  Candidate,
  Identity,
  Descriptor,
  Route,
  PricingDescriptor,
  PricingSnapshot,
  ExactEvidence
> {
  readonly manifest: FamilyManifest<"protocol">;
  readonly protocol: ProtocolDomainSemantics;
  readonly swap?: never;
}

export type AdapterFamilyPlugin<
  Candidate extends FamilyCandidate,
  Identity extends VerifiedIdentity,
  Descriptor extends CompiledInstanceDescriptor,
  Route extends FamilyRouteDescriptor,
  PricingDescriptor,
  PricingSnapshot,
  ExactEvidence,
> =
  | SwapFamilyPlugin<
      Candidate,
      Identity,
      Descriptor,
      Route,
      PricingDescriptor,
      PricingSnapshot,
      ExactEvidence
    >
  | ProtocolFamilyPlugin<
      Candidate,
      Identity,
      Descriptor,
      Route,
      PricingDescriptor,
      PricingSnapshot,
      ExactEvidence
    >;

export interface FamilyManifest<Domain extends "swap" | "protocol"> {
  readonly familyId: FamilyId;
  readonly domain: Domain;
  readonly ownedActionAdapterIds: readonly string[];
  readonly requiredInfraActionAdapterIds: readonly string[];
  readonly allowedTaxonomy: readonly AllowedTaxonomy[];
  /** 稳定语义标识，不是缓存 revision。 */
  readonly supportedLineages: readonly LineageId[];
}
```

因此 `domain: "swap"` 时 `swap` 必填而 `protocol` 的类型为 `never`；Protocol 反之。不能再用一个
`swap? / protocol?` 宽松对象让作者同时填写两个 Domain、两个都不填，或让 manifest 与语义不一致。

生产定义还必须经过两个唯一构造入口。构造器返回不可由普通对象伪造的 branded value；自动 catalog 只接收
这个 branded value，而不是任意满足部分结构的对象：

```ts
declare const definedFamilyPluginBrand: unique symbol;

type DefinedFamilyPlugin<Plugin> = Readonly<Plugin> & {
  readonly [definedFamilyPluginBrand]: "defined-family-plugin";
};

export declare function defineSwapFamily<
  C extends FamilyCandidate,
  I extends VerifiedIdentity,
  D extends CompiledInstanceDescriptor,
  R extends FamilyRouteDescriptor,
  PD,
  PS,
  E,
>(plugin: SwapFamilyPlugin<C, I, D, R, PD, PS, E>):
  DefinedFamilyPlugin<SwapFamilyPlugin<C, I, D, R, PD, PS, E>>;

export declare function defineProtocolFamily<
  C extends FamilyCandidate,
  I extends VerifiedIdentity,
  D extends CompiledInstanceDescriptor,
  R extends FamilyRouteDescriptor,
  PD,
  PS,
  E,
>(plugin: ProtocolFamilyPlugin<C, I, D, R, PD, PS, E>):
  DefinedFamilyPlugin<ProtocolFamilyPlugin<C, I, D, R, PD, PS, E>>;
```

两个构造器共享同一个内部 `defineFamily()` validator；它必须在构建/启动时校验 manifest Domain、未知顶层
capability、Action ownership、lineage、taxonomy 和可选能力的一致性，再 freeze 定义。Family 作者可以在插件
内部拥有任意强类型 helper，但唯一生产 export 必须是上述构造器结果，不能直接 export raw object 绕过检查。

严格性由四层共同成立：

1. 判别联合在编译期保证 Swap/Protocol 互斥、各自 Domain 必填；
2. `defineSwapFamily()` / `defineProtocolFamily()` 做构建期结构、ownership 和 coherence 校验并附加 brand；
3. 自动 catalog 只加载 branded production export，拒绝 raw object、旧 registry entry 和中央手写 Family 分支；
4. boundary gate 禁止 Adapter 拥有 RPC、scheduler、cache、solver、final sim，并按已声明 capability 执行正负 fixture。

插件作者**不填写** `revision: "univ3-v1"` 或 `adapterSchemaRevision`。语义缓存失效由构建阶段生成的
capability content hash 负责，见 §6。

迁移期的 `AdapterFamily` / `defineProductionFamilyModule()` 可以由 composition root 转换成内部兼容表示，但
兼容转换只能包住尚未迁移的既有 Family。新 Family 必须直接走两个严格入口；全部 active Family 通过终态
parity 后，兼容转换及旧公开类型从生产 source closure 删除。

### 4.1 必需、可选和不属于 Adapter 的函数

|类别|函数/声明|责任|
|---|---|---|
|必需|`discovery.patterns`、`decodeCandidate()`|定义什么 observation 可能属于该 Family|
|必需|`identity.variants[].requirements/buildRequests/decode/decide`|构造并解释身份/行为证明|
|必需|`instance.instanceKey()`、`compileDraft()`、`finalizeDescriptor()`|归一化一个链上实例|
|必需|`routes.project()`|只投影行为证明通过的方向|
|必需|`pricing.stateKey()`、descriptor compiler、current reads、`decodeSnapshot()`、`deriveMids()`|coarse state 语义|
|必需|有序 `exact.methods`（local / request-program 判别联合）|精确报价语义；只有显式 `not-applicable` 可进入下一 method|
|必需|`execution.buildFragment()`、owned ActionAdapters|本 route 的执行编码|
|可选|static evidence、dependent reads、mutation classifier|有该协议需求才声明|
|可选|`classifyUnavailable()`、live-state projection|有可证明终态或 backrun 投影时声明|
|可选|landed events、victim decode/apply/overlay|Swap/victim lane 需要时声明|
|可选|pending/head evidence、oracle trigger、prepared quote|协议确实依赖时声明|
|可选|分片 `FamilySharedBinding`|真正跨实例共享且不能编入代码 hash 的链上 binding|

以下不属于 Adapter：scanner、RPC client、retry、deadline、semaphore、batch、cache、instance Map、diff、
Graph merge、global route enumeration、ranking、solver、final sim、EV、submission。

可选能力不存在时应省略，不写空函数。需要明确关闭策略的 domain 能力使用枚举，例如
`victimSupport: "none" | "detect-only" | "overlay"`，而不是返回空结果冒充执行成功。

冻结 ds 到目标函数的对应关系是：

|冻结 ds API|当前责任混合|终态拆分|
|---|---|---|
|`discovery.candidateFromAddress/ObservedCall(candidate, ctx)`|Family 既解析候选又可通过 `ctx.backend` 发 I/O|纯 `decodeCandidate()` + `identity`/behavior request programs；中央执行|
|`discovery.probeCandidate(instance, ctx)`|active proof、读取和 edge projection 合在一个 async callback|proof request/decode → `InstanceDescriptor` → 纯 `routes.project()`|
|`buildEdges(pool, backend, control)`|identity/metadata read 与 edge materialization 混合|descriptor 已证明后只做纯 route projection|
|`pricingState.compileStateInstance(input.readStatic)`|实例粒度已正确，但 Adapter 在 compiler 内主动调用中央 runner|`compileDraft()` → static program → 中央执行 → `finalizePricingDescriptor()`|
|`pricingState.buildCurrentBlockReads/decodeState(schema, ...)`|I/O 已由中央执行，但函数仍接收 family-shaped `Schema` facade|每次只接收一个 `PricingDescriptor + stateKey + routes`|
|`quoteExact(ctx.state)`|任意异步 StateBackend 访问隐藏 request cost/source|有序 local/request-program exact methods；每个远程 method 是完整 Request Program|
|`buildPlanFragment(ctx)`|接口允许异步并持有 `state`|纯 `execution.buildFragment()`，只消费 sealed descriptor/evidence|

这里不是要求一次提交同时改完所有 Family。中央 Request Program 与兼容 executor 先独立落地，随后按 Family
迁移；但一个 Family 一旦标记为“新模板已迁移”，其生产调用链不得再穿回表中的旧 async API。

### 4.2 所有阶段共用的 Request Program

Identity、instance hydration、pricing、exact 和 runtime evidence 使用同一套 request/result IR。Family 只能
构造 IR 和解码结果，不能拿到 transport object。

这是相对冻结 ds 的**下一阶段中央收紧**。ds 的 blockscan `StateRead` 已经接近该形态：current/dependent read
由 Family 同步声明，coordinator 负责 pinned transport、batch、deadline 与结果回传；但 discovery 仍直接暴露
`ProtocolDiscoveryContext.backend`，exact 仍直接暴露 `ExactQuoteContext.state`，而 instance hydration 通过
`CompileStateInstanceInput.readStatic` 让 Adapter 主动发起执行。迁移应复用现有 `StateRead`/backend 语义形成
统一 IR，而不是在旁边再建第二套 RPC scheduler。

```ts
interface RequestRequirements {
  readonly transports: readonly (
    | "eth-call"
    | "get-code"
    | "get-storage"
    | "state-override-simulation"
    | "effect-delta-simulation"
  )[];
  readonly caller?: "none" | "executor" | "observed-sender" | "verified-actor";
  readonly effects?: readonly (
    | "return-data"
    | "revert-data"
    | "logs"
    | "trace"
    | "token-delta"
    | "native-delta"
    | "total-supply-delta"
  )[];
}

type CallerRef =
  | { readonly kind: "none" }
  | { readonly kind: "executor" }
  | { readonly kind: "observed-sender" }
  | { readonly kind: "verified-actor"; readonly evidenceId: string };

type AdapterRequest =
  | {
      readonly id: string;
      /** 省略时为 true；只有显式 false 才允许失败后继续 decode。 */
      readonly required?: boolean;
      readonly kind: "eth-call";
      readonly to: string;
      readonly data: string;
      readonly caller?: CallerRef;
      readonly completion: "return-data" | "return-or-revert-data";
    }
  | {
      readonly id: string;
      readonly required?: boolean;
      readonly kind: "get-code" | "get-storage";
      readonly address: string;
      readonly slot?: string;
    }
  | {
      readonly id: string;
      readonly required?: boolean;
      readonly kind: "state-override-simulation" | "effect-delta-simulation";
      readonly call: { readonly caller: CallerRef; readonly to: string; readonly data: string };
      readonly overrideIntent: FundedCallerOverrideIntent;
      readonly observe: readonly EffectObservationKind[];
    };

type AdapterRequestResult =
  | {
      readonly id: string;
      readonly ok: true;
      readonly source: CanonicalSource;
      readonly provenance: TrustedTransportProvenance;
      readonly completion: "returned" | "reverted-as-declared";
      readonly data: string;
      readonly effects?: ObservedEffects;
    }
  | {
      readonly id: string;
      readonly ok: false;
      readonly source: CanonicalSource;
      readonly failure: "rpc" | "deadline" | "aborted" | "resource-limited";
    };

interface RequestProgram<Input, Evidence> {
  requirements(input: Input): RequestRequirements;
  buildRequests(input: Input): readonly AdapterRequest[];
  decode(input: {
    readonly programInput: Input;
    readonly results: readonly AdapterRequestResult[];
  }): Evidence;
}

interface StaticEvidenceProgram<Input, Evidence>
  extends RequestProgram<Input, Evidence> {
  reusePolicy(input: Input):
    | { readonly kind: "source-local" }
    | {
        readonly kind: "immutable-code";
        readonly codeSubjects: readonly string[];
      }
    | {
        readonly kind: "dependency-proof";
        readonly dependencyKeys: readonly string[];
      };
}

interface ExecutedProgram<Evidence> {
  readonly evidence: Evidence;
  /** 只由中央对可信 request results 计算。 */
  readonly trustedResultsFingerprint: string;
  /** 只有 StaticEvidenceProgram 才存在；current/exact 结果使用各自的 source/cache proof。 */
  readonly reuseProof?: StaticEvidenceReuseProof;
}
```

中央执行器是唯一 transport owner。下面是单个 program 的低层执行合同；其中
`BoundedRequestExecutor` 是中央 scheduler 为当前 stage 签发的短生命周期句柄，不是 raw RPC client，也不是
覆盖整个 Family/generation 的长期 lease。完整排队和资源调度入口见 §4.3。

```ts
async function runRequestProgram<Input, Evidence>(input: {
  readonly familyId: FamilyId;
  readonly program: RequestProgram<Input, Evidence>;
  readonly programInput: Input;
  readonly source: CanonicalSource;
  readonly executor: BoundedRequestExecutor;
}): Promise<ExecutedProgram<Evidence>> {
  const requirements = input.program.requirements(input.programInput);
  input.executor.assertSupported(requirements);
  const requests = input.program.buildRequests(input.programInput);
  input.executor.assertRequirementsMatchRequests(requirements, requests);
  input.executor.assertWithinBudget(input.familyId, requests);
  const results = await input.executor.execute({
    familyId: input.familyId,
    source: input.source,
    requests,
  });
  input.executor.assertRequiredResultsSucceeded(requests, results);
  const evidence = input.program.decode({
    programInput: input.programInput,
    results,
  });
  return {
    evidence,
    trustedResultsFingerprint: fingerprintTrustedRequestResults(results),
    reuseProof: isStaticEvidenceProgram(input.program)
      ? input.executor.sealStaticEvidenceReuseProof({
          program: input.program,
          programInput: input.programInput,
          source: input.source,
          results,
        })
      : undefined,
  };
}
```

约束：

- request ID 在一个 instance/route program 内稳定且唯一，中央负责全局 namespace 和物理 calldata 去重。
- request 默认 `required=true`；required 的 RPC/deadline/abort/resource failure 必须在调用 decoder 前变成
  `unresolved`，不能由 Family 解码成负身份、unavailable 或零报价。optional failure 只有显式声明后才可进入 decoder。
- `RequestRequirements` 与实际 requests 必须严格一致：transport、caller role、completion mode、simulation intent
  和 observed effects 逐项校验；Family 不能先宽泛声明、再在 builder 中偷偷增加 trace/caller/effect。
- source number/hash/generation 由中央注入；Adapter 不能自行选择 `latest`。
- caller 使用 symbolic `CallerRef`，真实地址由中央 executor/observed sender/verified evidence 绑定；Family 不能提交
  任意 `from`。示例中的 `from` 若出现，只能理解为中央绑定后的 transport 投影，而不是 Adapter 输入能力。
- `return-or-revert-data` 只对 request 显式声明且 Family conformance 证明的合约语义有效。
- state override 只能表达“给真实 executor 准备本次 probe 所需余额”等受控意图，Adapter 不能直接提交任意 storage diff。
- deadline、retry 次数、并发和最大 request/round 数完全由中央 policy 决定。
- 同步纯度必须在运行时守卫，不能只依赖 TypeScript：中央对 `requirements`、`buildRequests`、`decode`、identity
  `decide`、instance/route/pricing projection、local exact 和 execution fragment 等所有 Family callback 使用
  `assertSynchronous()`（或等价 thenable rejection）。任何 callback 返回 Promise/thenable 都必须在 transport 或
  publication 前 fail closed；不能因为 `await` 恰好能接收普通值而静默允许异步 Family 代码。

### 4.3 中央调度平面：统一的不只是函数签名

统一 Adapter 接口只有在所有工作都进入同一个中央调度平面时，才会真正改善时效性。Family 返回的不是
一个可以自由 `await` 的异步闭包，而是一个**声明式 work intent**：它说明 stage、对象、source 和 request
program；中央再决定 lane、deadline、并发、transport pool、batch、dedupe 和 retry。

冻结 ds 已经实现了重要的物理 transport 基础，但尚未实现下面完整的 work-intent 平面：

|能力|冻结 ds 状态|剩余收敛|
|---|---|---|
|物理 permit 范围|coarse producer 已不再整代持有 foreground lease，`RethTransportScheduler.run()` 也以 request/batch 为调度单位；但 `withHardRequestTimeout()` 可在底层 fetch/body 未 settle 时先 reject，外层随后释放 slot/permit，因此当前容量计数尚未真正覆盖 physical settlement|修复 scheduler/timeout ownership：logical consumer 可先结束，但 physical work settle 前容量仍由 scheduler 持有；所有新 request program 必经同一入口|
|lane/reserve|已有 `producer-critical`、`producer-bulk`、`exact`、`discovery`；non-producer 不能占用 producer reserve|由 stage/source 推导 lane，禁止 Family 自报优先级|
|mutation proof|backend 用 `LiveRethReadPriority.runForeground()` + `runCritical()` 串行关键证明并抢占 retry-safe background|保留 critical proof 语义，收敛到统一 schedule decision/telemetry|
|exact/discovery|pinned exact backend 使用 `exact` lane；discovery 通过 background control 让步|补齐 bounded ingress、过期 generation 合并/取消、Family/instance fairness|
|batch/dedupe|各 backend 已有局部 batch；instance static read 在 family phase 内按物理 calldata 去重|把可证明等价的去重扩到统一 source/caller/effect 绑定，不跨不兼容语义合并|
|final sim|当前 final sim 由生产 runtime 的 deadline/fork worker 路径执行，不在 `RethTransportScheduler` 的 lane union 内|建立独立或保留容量的 simulator pool；不得让 exact/discovery 挤死 S5|
|outcome telemetry|现有 lane、queue wait、family/state issue 等多处 telemetry|统一 queue/transport/decode/failure-stage receipt，同时保留现有细粒度证据|

因此，下方 `CentralWorkStage`、`AdapterWorkIntent` 与 `executeAdapterWork()` 是对现有 scheduler 的统一上层合同，
不是声称 ds 已经存在这些接口。实现时应让它调用现有 transport scheduler/backend，而不是绕过或复制它们。

```ts
type CentralWorkStage =
  | "identity"
  | "instance-static"
  | "pricing-static"
  | "pricing-current"
  | "runtime-evidence"
  | "exact-refine"
  | "fork-final-sim";

interface AdapterWorkIntent<Input, Evidence> {
  readonly stage: Exclude<CentralWorkStage, "fork-final-sim">;
  /** 由 scanner/coordinator call site 填写；Family program 无权申报。 */
  readonly workClass: "head-critical" | "foreground" | "background";
  readonly familyId: FamilyId;
  readonly instanceKey?: InstanceKey;
  readonly routeKey?: RouteKey;
  readonly source: CanonicalSource;
  readonly generation: number;
  readonly program: RequestProgram<Input, Evidence>;
  readonly programInput: Input;
}

interface FinalSimulationWorkIntent {
  readonly stage: "fork-final-sim";
  readonly source: CanonicalSource;
  readonly generation: number;
  readonly resolvedPlan: ResolvedPlan;
}

type CentralWorkIntent<Input, Evidence> =
  | AdapterWorkIntent<Input, Evidence>
  | FinalSimulationWorkIntent;

interface CentralScheduleDecision {
  readonly lane:
    | "critical-proof"
    | "foreground"
    | "background"
    | "final-sim";
  readonly deadlineAtMs: number;
  readonly maxAttempts: number;
  readonly transportPool:
    | "state-read"
    | "trace"
    | "effect-sim"
    | "final-sim";
  readonly fairnessKey: string;
}
```

`CentralScheduleDecision` 只能由 framework policy 从 framework-owned `workClass`、stage、source freshness 和全局资源状态推导。
Adapter 可以声明“需要 revert data / verified actor / tx-bound evidence”，但不能声明“我的 Family 是 foreground”
或把 deadline 拉长。

中央执行核心应保留下面的顺序；这段顺序比类名更重要：

```ts
async function executeAdapterWork<Input, Evidence>(input: {
  readonly intent: AdapterWorkIntent<Input, Evidence>;
  readonly runtime: CentralAdapterRuntime;
}): Promise<ExecutedProgram<Evidence>> {
  const { intent, runtime } = input;
  runtime.generationFence.assertCurrent(intent.generation);

  // 纯 CPU：此时没有 transport lease。
  const requirements = intent.program.requirements(intent.programInput);
  const requests = intent.program.buildRequests(intent.programInput);
  runtime.requestContracts.assertRequirementsMatchRequests(
    requirements,
    requests,
  );
  const schedule = runtime.policy.bind({
    workClass: intent.workClass,
    stage: intent.stage,
    familyId: intent.familyId,
    source: intent.source,
    requirements,
    requestCount: requests.length,
  });
  runtime.budgets.assertAdmitted(schedule, requests);

  // Scheduler 按物理 request/batch 取得 permit。consumer 可先得到 timeout/abort outcome，
  // 但 permit 仍由 scheduler 持有，直到 fetch/body/worker/simulation 真正 settle 才释放。
  const results = await runtime.scheduler.executeRequests({
    schedule,
    source: intent.source,
    generation: intent.generation,
    subject: {
      familyId: intent.familyId,
      instanceKey: intent.instanceKey,
      routeKey: intent.routeKey,
    },
    requests,
    dedupeKey: canonicalRequestSetKey(intent, requests),
  });

  runtime.generationFence.assertCurrent(intent.generation);
  runtime.requestContracts.assertRequiredResultsSucceeded(requests, results);

  // 纯 CPU decode 也不占 transport lease。
  const evidence = intent.program.decode({
    programInput: intent.programInput,
    results,
  });
  return sealExecutedProgram({ intent, results, evidence });
}
```

调度器至少必须保证：

- ingress queue 有界；相同 subject/source 的重复工作可合并，过期 generation 可取消，不能无限堆积；
- 物理 dedupe key 至少绑定 chain、source block hash、generation、transport kind、target/address/slot/calldata、
  centrally-bound caller、completion、override intent 和 observed effects；共享 physical result 必须重新映射到每个
  local request ID，不能泄漏首个 consumer 的 ID；
- consumer deadline 参与复用裁决：一个短 deadline consumer 已启动的 physical work，不能成为更长 deadline consumer
  的唯一执行。中央可以给近同时 work 签发一个有界 shared-session window，但必须让每个 consumer 保留独立逻辑
  deadline，且只有 session 的 physical deadline 覆盖该 consumer 时才可复用；超出 window 的更长 consumer 必须启动
  独立 physical work。逻辑 consumer 可以先超时，但 physical permit 与 dedupe entry 直到 fetch/body/worker/simulation
  真正 settle 才释放；
- 并发既受 transport pool 限制，也受 Family/instance fairness 限制；一个 Family 的 exact probe 风暴不能耗尽全局槽位；
- background discovery 能持续获得 transport；foreground 只能在真实 critical read 期间占槽，不能让 coarse producer
  在等待、组装、decode 或整代 catch-up 期间持有 lease；
- final simulation 使用独立或保留容量的 pool/lane，不能被 discovery backfill 或 exact fan-out 长期排队；
- retry 每次重新排队并重新取得物理 permit；Adapter 不能在一次 callback 内偷偷循环 RPC；
- 所有 work intent 都必须复用 §4.2 的 request contract：实际 requests 与 requirements 严格匹配，且 required
  failure 在 decoder 前变成 `unresolved`。`executeAdapterWork()`、identity loop、static/current/exact helper 不得各自
  复制一份缺少这些 guard 的“近似执行器”；
- completion 在 generation fence 后才能进入 instance Map、snapshot、exact cache 或 publication CAS；
- queue wait、transport wall time、decode wall time和 failure stage 分开记录，避免把“排队慢”误判为“协议解析慢”。

因此中央运行形态是：

```text
head / log / receipt / pending input
        ↓
bounded ingress + coalescing
        ↓
typed work intents
        ↓
central policy + fair queues + dedupe/batch
        ├── state-read pool
        ├── trace/effect-sim pool
        └── reserved final-sim pool
        ↓
lease-free family decode
        ↓
generation fence + atomic publication
```

这个调度原则与 `sui-mev` 的有效部分同向，但不照抄其 Rust 组织。其中央
[`ArbStrategy`](https://github.com/fuzzland/sui-mev/blob/462bb2b24caec403da62f9ce8104039fbd30a3fa/bin/arb/src/strategy/mod.rs#L299-L359)
建立 worker 队列，`Defi::find_best_path_exact_in()` 在中央并发比较路线
([代码](https://github.com/fuzzland/sui-mev/blob/462bb2b24caec403da62f9ce8104039fbd30a3fa/bin/arb/src/defi/mod.rs#L242-L294))，
`Arb::find_opportunity()` 在中央并发搜索 amount
([代码](https://github.com/fuzzland/sui-mev/blob/462bb2b24caec403da62f9ce8104039fbd30a3fa/bin/arb/src/arb.rs#L142-L194))，
并把提交前 dry-run 与候选模拟分开
([代码](https://github.com/fuzzland/sui-mev/blob/462bb2b24caec403da62f9ce8104039fbd30a3fa/bin/arb/src/strategy/worker.rs#L59-L130))。
这四点应吸收为：**中央队列、中央资源池、中央 fan-out/selection、独立 final sim**。
它把异构 DEX route 统一投到同一个 Simulator 比较，进一步说明
`effect-delta-simulation` 应保留为中央标准 exact transport；但不应照搬为所有 route × amount 的默认报价方式。
本合同仍先用 coarse 排名，再让入选候选按 Family 选择 local math、pinned call 或 effect simulation，最后统一
进入 mandatory final sim，避免 simulation fan-out 本身变成时效性瓶颈。

它没有提供比本合同更强的通用 Adapter 调度边界：中央仍按 `Protocol` 手写 `match`
([代码](https://github.com/fuzzland/sui-mev/blob/462bb2b24caec403da62f9ce8104039fbd30a3fa/bin/arb/src/defi/indexer_searcher.rs#L45-L95))，
而 Cetus 构造器直接拿 simulator 读取 pool/config/clock 并维护本地 `OnceCell`
([代码](https://github.com/fuzzland/sui-mev/blob/462bb2b24caec403da62f9ce8104039fbd30a3fa/bin/arb/src/defi/cetus.rs#L29-L96))。
这会隐藏 request cost、source、deadline、retry 和公平性，不能吸收到目标接口。裁决是：两者在“中央负责
route/search/simulation，协议插件负责执行语义”上方向一致；我们只吸收其明确有效的中央 worker/resource-pool
模式，继续保留更严格的 declarative Request Program、自动 catalog、per-instance cache 和公平调度。

## 5. 自动加载能力，不注册链上实例

冻结 ds 的自动加载**已经可用，但生产激活仍是双入口**：

```ts
const LEGACY_PRODUCTION_ADAPTER_FAMILIES = Object.freeze([
  // 20 个手工 import 的 Family
]);

const productionFamilyLoad = await loadProductionFamilyModules(
  LEGACY_PRODUCTION_ADAPTER_FAMILIES,
);

export const PRODUCTION_ADAPTER_FAMILIES = new AdapterFamilyRegistry([
  ...LEGACY_PRODUCTION_ADAPTER_FAMILIES,
  ...productionFamilyLoad.modules.map((module) => module.family),
]);
```

当前 tracked-source loader 通过 `git ls-files` 扫描同目录 `*.production.ts`，当前实际发现
`astra-multitoken.production.ts` 与 `ethertoken-native-redeem.production.ts`。它已经负责：source scan/import
timeout、模块合同、Family 注册冲突、owned ActionAdapter 精确集合、descriptor edge kind、shared infra 依赖，
并用完整前缀构造 `AdapterFamilyRegistry` 检查 ownership/identity/typed capability。这些 inventory、closure 与唯一
registry 检查应保留并演进，但 runtime source scan 本身只是迁移期实现，不能成为终态生产加载机制，也不应退化为
人工协议清单。

当前迁移期 production root 只把 `source_scan_failed` 升为启动错误；单个 module 的 import/timeout/contract/conflict issue
会被记录后省略该 module。终态不能让一个 tracked production Family 因加载错误而静默退场：loader 可以继续
在开发/CI inventory 阶段返回逐 module issue 供诊断，但 generated production catalog 只有在**全部 tracked active
modules 成功生成并通过 closure 校验**，或存在独立批准并绑定 catalog hash 的 deactivation manifest 时才可发布。
迁移期若新 module 加载失败，也不得暗中退回同 ID 的 legacy Family；该启动/切换应 fail closed。

当前 `defineProductionFamilyModule()` 只 freeze `{ family, actionAdapters }`，还不是 §4 的不可伪造 brand；而
`baseFamilies` 参数与 `LEGACY_PRODUCTION_ADAPTER_FAMILIES` 正是迁移桥。runtime `git ls-files`/glob 可以保留为
开发期 source inventory 与 CI stale-artifact 检查，但**不能成为生产 composition root**：生产构建必须生成带静态
imports 的 catalog artifact，clean process 启动只加载该 artifact 并校验 module/manifest/capability closure hash。

```ts
export async function loadFamilyCapabilityCatalog(): Promise<FamilyCapabilityCatalog> {
  // 该模块由 build 生成，内部是显式 static imports，不在 runtime 扫文件或执行 git。
  const generated = await import("./generated/production-family-catalog.js");
  generated.assertArtifactCurrent();

  const defined = generated.productionFamilyModules.map((module) => {
    assertDefinedFamilyPlugin(module.plugin);
    return module.plugin;
  });
  const loaded = defined.map((plugin) =>
    attachGeneratedCapabilityHashes(plugin, generated.capabilityManifest)
  );

  return buildFamilyCapabilityCatalog(loaded);
}
```

`assertDefinedFamilyPlugin()` 必须验证构造器 brand 和冻结后的合同摘要；文件名、export 名或结构相似不能替代
brand。这样扫描仍然自动发现 Family 代码，但不能把未经 `defineSwapFamily()` / `defineProtocolFamily()` 校验的
raw object 偷渡成生产插件。

生成 artifact 至少绑定：每个 production module 的静态 import、每个 capability 的 normalized entry bundle hash、
semantic dependency closure、中央 contract version 和仅作 provenance 的 commit。构建发现 source inventory 与 artifact
不一致、依赖图缺失或内容过期时必须失败；启动也必须 fail closed，不能回退到 `Function#toString()`、手工 revision、
runtime glob 或 legacy Family。

迁移终态中央不再维护：

```ts
const LEGACY_PRODUCTION_ADAPTER_FAMILIES = [
  univ2StandardAdapter,
  univ3StandardAdapter,
  // ...
];
```

`FamilyCapabilityCatalog` 只是代码能力索引：

```ts
interface FamilyCapabilityCatalog {
  readonly byFamilyId: ReadonlyMap<FamilyId, LoadedFamilyPlugin>;
  readonly callSelectorIndex: ReadonlyMap<Hex4, ReadonlySet<FamilyId>>;
  readonly logTopicIndex: ReadonlyMap<Hex32, ReadonlySet<FamilyId>>;
  readonly addressSurfaceIndex: AddressSurfaceIndex;
  readonly actionOwnerById: ReadonlyMap<string, FamilyId>;
}
```

这里的 `LoadedFamilyPlugin` 必须是 existential `LoadedFamilyBox`，不是中央可展开的泛型对象或
`Record<string, unknown>`。FamilyBox 签发不可伪造、绑定当前 runtime box identity 的 descriptor/pricing/evidence
handles，或向中央暴露关闭泛型后的 typed closures；中央只能传递 handle、调用 closure 和比较中央签发的 fingerprint，
不能读取协议私有字段。foreign/forged handle 必须 fail closed，catalog hot replacement 后旧 box 的 process-local opaque
evidence 也不能交给新 box 解包。这样中央才不会重新长出 `v4Hooks`、`curveI/J`、`dodoActor` 分支。

Pool、vault、Factory child、PoolKey、token pair、route 和 StateInstance 都由扫描和链上证明动态产生，
不能被写进这个 catalog。代码中允许固定 Registry、Manager、Router、Oracle 等基础设施 singleton，因为它们是
身份/执行证据源；不允许用逐实例地址集合充当准入 gate。

迁移顺序必须是单调的：每迁完一个 Family，就新增其 branded `*.production.ts` 并从 legacy 数组删除同一 Family；
loader 必须拒绝同一 `familyId` 同时从两条入口激活。最后一个 legacy Family 切换并通过 §20 后，同时删除：

- `LEGACY_PRODUCTION_ADAPTER_FAMILIES` 及其 direct imports；
- loader 的 `baseFamilies` 参数、reserved-base 冲突分支和相应 legacy AST 测试；
- `defineProductionFamilyModule()` 对 raw `AdapterFamily` 的接受能力，改为只接收 `DefinedFamilyPlugin`；
- 任何“扫描失败后退回 legacy 清单”的配置或隐式 fallback。

回滚不靠常驻双路径：切换后的生产回滚使用上一份已验收构建物/提交重新部署。这样迁移代码在大重构结束后
真正消失，而不是永久增加第二套激活真相。

## 6. Capability 级内容哈希：作者不手工 bump revision

冻结 ds 目前仍以 `BlockScanStateCapability.adapterSchemaRevision` 为实例 schema 缓存版本；五个已迁 Family 分别
硬编码 `univ2-v1`、`univ3-v1`、`univ4-v1`、`dodo-v2-v1`、`angstrom-v4-v1`。coordinator 已把
`schemaRevision` 与 `snapshotCompatibilityRevision` 纳入 topology/spec fingerprint；但前者依赖作者手工 bump，
后者在当前 Family 未声明时退回 `familyId`，都不能自动感知语义代码变化。下面的 capability hash 是要替换这一
人工/缺省前提的终态机制。

构建阶段为每个 capability 生成独立哈希：

```ts
type CapabilityName =
  | "discovery"
  | "identity"
  | "instance"
  | "routes"
  | "pricing"
  | "exact"
  | "execution"
  | "victim";

interface GeneratedCapabilityIdentity {
  readonly familyId: FamilyId;
  readonly capability: CapabilityName;
  readonly contractVersion: string;
  readonly contentHash: string;
  readonly semanticDependencies: readonly string[];
  /** 仅用于追溯，绝不能作为缓存 key。 */
  readonly provenanceCommit: string | null;
}
```

核心生成逻辑：

```ts
function generateCapabilityIdentity(input: {
  familyId: FamilyId;
  capability: CapabilityName;
  contractVersion: string;
  normalizedEntryBundle: Uint8Array;
  semanticDependencyClosure: readonly DependencyArtifact[];
  provenanceCommit: string | null;
}): GeneratedCapabilityIdentity {
  return {
    familyId: input.familyId,
    capability: input.capability,
    contractVersion: input.contractVersion,
    contentHash: sha256(canonicalEncode({
      contractVersion: input.contractVersion,
      entry: sha256(input.normalizedEntryBundle),
      dependencies: input.semanticDependencyClosure
        .map((item) => [item.logicalId, item.contentHash] as const)
        .sort(([a], [b]) => a.localeCompare(b)),
    })),
    semanticDependencies: input.semanticDependencyClosure
      .map((item) => item.logicalId)
      .sort(),
    provenanceCommit: input.provenanceCommit,
  };
}
```

依赖闭包必须包含会改变语义的 ABI、常量、共享数学、request builder、decoder、ActionAdapter contract 和中央
capability contract version；测试、README、格式化和 commit SHA 不进入语义 hash。构建产物缺失、入口依赖图
不一致或 manifest 过期时必须失败，不能回退到作者填写的版本字符串。

能力哈希必须分开：

- exact-only 修改只失效 exact quote cache，不重编 pricing descriptor。
- pricing decoder/read-plan 修改失效对应 StateInstance descriptor/snapshot。
- discovery matcher 修改重跑 discovery negatives，但不清空 execution capability。
- central contract version 只使引用该 contract 的能力失效。

如果一个巨型文件导致所有能力共享同一依赖闭包，应先按 capability entrypoint 拆分语义入口；不要接受“改 exact
导致全部 pool schema 重编”作为正常代价。

生成式哈希的迁移必须分三步，不能在同一版本中静默换 key：

1. **shadow 生成**：构建产出 capability manifest，运行时同时记录 generated hash 与当前 manual revision，
   但仍按 ds 旧 key 读取；manifest 缺失或依赖闭包不完整时 CI 失败。
2. **key 切换**：以 generated capability hash 写入新 cache namespace；旧 cache 只读用于 parity/冷启动诊断，
   不允许 generated miss 回退成“沿用旧 descriptor”。
3. **删除桥**：所有 Family 通过 cache invalidation fixture 与 warm restart 后，删除 `adapterSchemaRevision`、
   `snapshotCompatibilityRevision` 的手工 fallback、旧 namespace 读取器及相应双写 telemetry。

最终源码中不保留“以 familyId 作为缺省 revision”的兜底；构建产物缺 capability identity 就不能进入生产 catalog。

## 7. Discovery：selector/topic 只负责候选分流

冻结 ds 已经由 shared scanner 统一枚举 block/log/receipt/trace，并让 Family 声明 `eventTopics`、
`callSelectors`、candidate sources；但 `ProtocolDiscoveryCapability.candidateFromAddress()`、
`candidateFromObservedCall()` 与 `probeCandidate()` 仍是可拿完整 `ProtocolDiscoveryContext` 的 async callback。
因此“扫描调度中央化”已实现，“candidate decode 与 I/O 完全分离”尚未实现。下面是终态纯语义接口。

```ts
export interface DiscoverySemantics<Candidate extends FamilyCandidate> {
  readonly sources: readonly DiscoverySourceKind[];
  readonly callPatterns?: readonly CallPattern[];
  readonly logPatterns?: readonly LogPattern[];
  readonly addressSurfaces?: readonly AddressSurfacePattern[];

  /** 同步、纯函数；不能读 RPC、cache 或全局 mutable state。 */
  decodeCandidate(input: {
    readonly observation: UnifiedObservation;
    readonly matchedPatternId: string;
  }): Candidate | null;

  candidateKey(candidate: Candidate): string;
}

interface CallPattern {
  readonly id: string;
  readonly selector: Hex4;
  readonly signature: string;
  readonly candidateAddress:
    | { readonly from: "call-target" }
    | { readonly from: "argument"; readonly index: number };
  readonly argumentProjection?: readonly AbiArgumentProjection[];
}
```

中央调用上下文：

```ts
function ingestObservation(
  observation: UnifiedObservation,
  catalog: FamilyCapabilityCatalog,
  candidates: CandidateQueue,
): void {
  for (const match of catalog.matches(observation)) {
    const family = catalog.byFamilyId.get(match.familyId)!;
    const candidate = family.discovery.decodeCandidate({
      observation,
      matchedPatternId: match.patternId,
    });
    if (candidate === null) continue;
    candidates.upsert({
      familyId: family.manifest.familyId,
      candidateKey: family.discovery.candidateKey(candidate),
      candidate,
      source: observation.source,
    });
  }
}
```

`Map<selector, Set<familyId>>` 必须是多值索引。Selector collision 的预期结果是多个 Family 各自进入身份
证明，而不是第一个注册者获胜。

迁移桥可以把一个旧 async matcher 作为单独受控 worker 执行并生成 legacy outcome，但不能把它伪装成纯
`decodeCandidate()`；该 Family 只有在 backend reads 被完整投影为 Request Program 后才算完成。最后一个 Family
迁移后，`ProtocolDiscoveryContext.backend`、family-local `runCacheScope` I/O memo 和旧 callback 签名一并删除；
scanner 只向 Adapter 传 observation、sealed results 与 opaque descriptor。

### 7.1 Bootstrap completeness 与 discovery watermark

严格 ingress 不能只消费“进程启动后刚好再次出现”的 live call/log。冻结 ds 的 startup universe、declared venue 和
持久化 incumbent 目前主要是 `PoolEntry`，其中很多实例没有可重放的原始 observation；如果直接切换，未在当前窗口
重新活动的健康 incumbent 会从 Graph 静默消失。

production cutover 前必须选择并验收至少一种中央 bootstrap authority：

1. 保存 canonical observation journal，并按 source/watermark 重放产生 incumbent 的原始 call/log/address surface；或
2. 对每个 persisted incumbent 生成中央 `address-surface` nomination，同时保证对应 Family 声明完整的 surface pattern。

**2026-08-08 实施审计：** 当前 22 个严格 Family 中只有 9 个声明 `addressSurfaces`；现有 factory/active/landed
startup 路径还会把原始发现事实压成 `PoolEntry`。因此第二条目前不能覆盖全 catalog，不能用它独立授权 cutover。
在 observation journal/replay 落地，或其余需要 bootstrap 的 Family 补齐可反向验证的 surface declaration 之前，严格
publication 只能是 shadow/partial，production Graph authority 必须继续留在已冻结的旧路径。

bootstrap 只负责重新提名，不是 admission 旁路。每个 incumbent 仍须在当前 capability 下重做链上 reverse/behavior
proof；旧 `PoolEntry`、旧 route 或地址表不能直接铸成 verified descriptor。中央 publication metadata 必须记录每个
discovery source 的 completeness/watermark；任一必需 source 未覆盖时只能发布明确的 partial/shadow outcome，不能把
当前候选集合当成 complete Graph，也不能用 `publication=null` 隐式 carry 上一代。

**2026-08-08 shadow ingress checkpoint：** 当前 change set 已新增 process-local sealed scan/bootstrap/ancestry
receipt、逐 Family incumbent inventory count/hash 与 re-attestation、event-source `0..N`/连续 history watermark，以及
generation fence 前不写状态的 shadow ingress。它只输出与 `CatalogDiscoverySourceAnchor` 不兼容的
`sourceCoverage` 诊断投影；普通 restart seed 永远只有 `append-only` 权限，point-in-time snapshot 在没有
verifier-issued inventory closure 时永远保持 partial。因此这一步不会铸造 omission/deletion authority，也不能替代
production bootstrap。

**2026-08-08 durable continuity checkpoint：** 当前 change set 又新增绑定
`chainId/catalogHash/sourceRegistryFingerprint/revision/source/full Family×source watermark matrix` 的 opaque
checkpoint candidate/receipt 与 file-backed CAS store。文件后端使用独占 sidecar lock、精确 serialized-byte CAS、`0600`
临时文件、file sync、atomic rename 与 directory sync；只有 canonical checkpoint verify、当前进程 generation fence 和
durable CAS 全部通过后才签发 trusted receipt。新 store instance 的 restart load 会重验 canonical serialization、内容
fingerprint、完整矩阵、binding 和旧 canonical anchor；任一 tamper、schema/catalog/source-registry mismatch、reorg 或
并发存储变化都清空为完整矩阵的 `append-only/-1/null`，不复用不可信 offset。若 canonical verify 期间另一 writer
提交，失稳 loader 只保留已验证的首读 bytes 作为失败 CAS token，不得重绑定到未经验证的新 bytes；因此它不能用
`expected:null` 把 winner 覆盖成 revision 1，必须重新 load 后才能从新 revision 继续。跨进程 ordering 使用 checkpoint
revision 与 canonical block ancestry，旧进程 generation 只作审计，不能与新进程 counter 比大小。

shadow ingress 现在可以消费同一 store 签发的 opaque restart receipt，并在异步 re-attestation 后、写入内存 watermark
之前产出 one-shot checkpoint candidate；普通 process-local seed 仍只能是 `append-only`，且两种 seed 不得混用。
point-in-time source 在独立 verifier-issued inventory closure 落地前会被持久化为 `append-only`，不会从 durable
continuity 获得 snapshot omission/deletion authority。该 store/ingress 接线目前仍是 shadow contract；strict catalog
root 尚未改为只消费 checkpoint receipt，production startup 也尚未采用该 store，所以不能据此宣称 bootstrap、Graph
completeness、production cutover 或 pool 尖峰验收完成。

**2026-08-09 snapshot inventory closure shadow contract（实现 commit
`c7d9fa548802a9d6371f46559b8cb99216a513b3`）：** 该 slice 新增独立的 process-local closure
verifier，并把其 one-shot candidate issuer 注入 observation ingress。ingress 只有在 `complete-snapshot` bootstrap 提供
完整 discovery-Family matrix、每个 Family 都声明可反向验证的 `address-surface` source/pattern、每个 incumbent 都有
当前 surface、对应 candidate 都得到 terminal re-attestation，且所有 event source 本轮连续覆盖时，才会准备 opaque
candidate。普通 `sourceCoverage`、bootstrap DTO、checkpoint candidate、旧 restart receipt 和结构相同的 clone 都不能
替代该 candidate。

verifier 不接受调用方自报的“空库存”为 closure。它固定绑定一个独立 point-in-time inventory enumerator，并在签发
前重新枚举同一 canonical source；candidate 与 authoritative enumeration 必须在完整 matrix、显式 zero row、排序去重
后的 inventory keys/count、地址、current surface 和 source-bound inventory hash 上精确相等。签发还必须同时绑定并
复核：

- `chainId/catalogHash/sourceRegistryFingerprint` 与精确
  `CanonicalSource { number, hash, generation }`；
- 当前同一 store 的 trusted checkpoint receipt/fingerprint，以及每个 declared event source 到该 source 的
  `contiguous-history`；
- 固定 canonical verifier 和异步返回后的 current-generation fence；
- 从固定 catalog publication root 捕获的 current `revision/publicationFingerprint`，验证期间发生 pointer 变化即拒绝；
- 每个 incumbent 的 terminal candidate key、canonical outcome fingerprint、evidence refs、lifecycle-derived
  `catalogInstancePublicationKey` 与 publication fingerprint；
- inventory matrix fingerprint、逐 Family terminal evidence fingerprint 的组合 matrix，以及最终 closure
  fingerprint。

candidate/receipt 都只存在于 issuer-private `WeakMap`，首次验证/成功消费后即失效；receipt 的可读 snapshot 只是诊断
evidence，不是 omission、deletion、source-transition 或 terminal-removal authority。checkpoint 中的 point-in-time row
仍强制降为 `append-only`，strict shadow catalog 的 stage 与 prepare 两层也继续拒绝 `complete-snapshot`；把 opaque
closure receipt 强转或夹带进结构 DTO 不能越过这两层 gate。

当前 production catalog 的 20 个 discovery Family 中仍有 11 个缺少完整 `address-surface` bootstrap coverage；因此
全 catalog candidate 必须 fail closed，不能借 19 个显式 zero row 或累计 terminal 结果绕过。该 contract 目前只在
synthetic WSTETH catalog 上证明 same-process `ingress candidate → durable checkpoint CAS → verifier receipt`，restart
必须重新签发。production 晋升仍需真实 point-in-time enumerator/journal composition、scan 与 bootstrap admitted key 的
exact union、closure receipt 在 generic catalog prepare 内的一次性消费、与 staged publication keys 的逐 Family 精确
相等，以及最终 CAS 前的再次 canonical/generation fence；这些完成前不得打开 omission/tombstone，也不得宣称
bootstrap closure、Graph completeness 或 production cutover。

**2026-08-11 closure staged exact-set coupling checkpoint（实现 commit
`02fd66d867462fad18c99e79bf6ab2ec61e19e28`，shadow gate，不打开 complete-snapshot）：**
新增 `assertClosureStagedExactSetCoupling`：closure 的每个 Family 必须与 staged publication
keys 逐 Family 精确相等（排序比较、无缺失、无额外、无未声明 Family）。该合同覆盖上段
"与 staged publication keys 的逐 Family 精确相等"这一子项；strict shadow catalog 的
stage/prepare 两层仍继续拒绝 `complete-snapshot`，closure receipt 在 generic catalog
prepare 内的一次性消费仍未接线，因此该 Phase D gate 整体仍 open。
证据：`searcher:adapter-family-closure-exact-set-coupling` PASS、
`searcher:adapter-family-snapshot-inventory-closure` PASS、完整 listener build 通过。

**2026-08-11 point-in-time enumerator core checkpoint（实现 commit
`8d4ed79646fbad0636a59f7afceb5c3d4ba9ab30`，shadow/unit gate）：**
新增 `enumeratePointInTimeInventory`：对冻结的逐 Family incumbent 库存做点-时间重枚举——
规范化地址与 address-surface、排序去重 inventory keys、拒绝重复 key/Family 与 foreign
surface，并用与 verifier 相同的 source-bound inventory hash 输出
`AdapterFamilySnapshotInventoryEnumerationInput`。合同证明枚举输出与
`adapterFamilySnapshotInventoryHash` 一致。该 core 是 production enumerator 的纯函数部分；
真实 journal/scan → enumeration 的数据源接线仍未落地，因此该 Phase D gate 整体仍 open。
证据：`searcher:adapter-family-point-in-time-enumerator` PASS、
`searcher:adapter-family-snapshot-inventory-closure` PASS、完整 listener build 通过。

**2026-08-11 durable discovery continuity composition root checkpoint（实现 commit
`4275be6f90e0c21b288dba213f1249f5dec01133`，shadow composition，不是 main 接线）：**
新增 `createDurableDiscoveryContinuityComposition`：把 file-backed checkpoint CAS、
snapshot inventory closure verifier 与 strict shadow catalog root 组装成单一组合根，
并在 closure 消费点强制 staged exact-set coupling；重启后同一路径可 `loadForRestart`
读到 trusted checkpoint。端到端合同证明：checkpoint commit → closure 签发 →
一次消费成功 / 二次消费 forged / staged 错配 exact-set mismatch → 新 composition
重启读回 trusted。该组合根是 main 接线的唯一入口；production startup 尚未采用，
strict catalog prepare 仍拒绝 `complete-snapshot`，因此该 Phase D gate 整体仍 open。
证据：`searcher:adapter-family-discovery-continuity-composition` PASS 及全套相关合同 +
完整 listener build 通过。

**2026-08-11 main env 门控接线 checkpoint（实现 commit
`c383e58f335e484a1f4d424a557890817d2ba6de`）：** `main.ts` 在
`SEARCHER_DISCOVERY_CONTINUITY_COMPOSITION_PATH` 设置时（默认关）创建
`createDurableDiscoveryContinuityComposition` 并 `loadForRestart`，用 provider 校验
checkpoint source hash，输出 `discovery continuity composition <status>` 日志；任何
closure 枚举尝试因 enumerator 数据源未接线而 fail-closed。该接线不授予 authority，
不打开 complete-snapshot/omission/tombstone；strict catalog prepare 内的一次性消费
仍未接线，因此该 Phase D gate 整体仍 open。

**2026-08-11 shadow catalog explicit zero-row checkpoint（实现 commit
`2e8b82b86818abc034595297baa2ec4a68a5880c`）：** 新增合同：resolved route Family 的
零实例 stage 必须以零 edges/handles 发布并正常前进 revision，不伪造 inventory 或
route-handle index（对应 §20.4 的显式 zero row 语义）。证据：
`searcher:adapter-family-shadow-catalog-publication` PASS + 完整 listener build。

**2026-08-11 Phase B/C shadow 合同套件聚合 checkpoint（实现 commit
`be37f5ed63a595ff20179c6927b9c97c8485dcba`）：** 新增
`searcher:adapter-family-shadow-suite` 聚合命令，一次跑通 10 个核心 shadow 合同套件
（lifecycle-content-cache、catalog-publication、state-carry-proof、discovery-checkpoint、
point-in-time-enumerator、closure-exact-set-coupling、snapshot-inventory-closure、
discovery-continuity-composition、shadow-catalog-publication、exact-quote-cache），
作为 Phase B/C shadow 合同的统一回归入口；仍不代表 production cutover。

**2026-08-11 strict pricing consumer read checkpoint（实现 commit
`5f2492bd929f19e6ad061dfd0a7e77d58e74245c`，shadow building block）：** 新增
`readStrictPricingMid`：从 committed strict pricing view 解析 RouteKey →
`mid` / `unavailable` / `missing` 三态，缺 publication 与显式 unavailable 区分；
production pricing consumer 必须以该 view 或 issuer-bound handle 路径读取。
该 helper 是 strict pricing production consumer 的构建块；blockscan pricing
consumer 接线仍未落地，gate 保持 open。证据：shadow publication 测试 + 完整 build。

**2026-08-11 Funding 进 strict catalog atomic CAS checkpoint（实现 commit
`dd0df3d8de0510db70bca2646bd0599f73695cf3`，shadow CAS，不是 production consumer）：**
shadow root 的 instance 槽扩为 `PreparedFamilyInstance | StrictFundingPublicationState`；
新增 `stageFundingFamily`：`FundingFamilyPublication` → strict shard，空 offer 显式
tombstone、outcomeRefs 绑定 evidence；Funding 与 route shards 进入同一次 atomic CAS；
views 新增 `fundingByPublicationKey` 只读投影；Funding 实例禁止跨代 carry
（省略即 `issuer-bound StateInstance mutation proof` 拒绝）。合同覆盖：tombstone 提交、
同 CAS revision、省略拒绝。证据：shadow publication 测试 + 全套件 + 完整 build。
Credit 全 catalog CAS 与 Funding/Credit production consumer 仍 open。

**2026-08-11 Credit 进 strict catalog atomic CAS checkpoint（实现 commit
`4b8b79d4397185b337806b54a7fb5e9198c63dcc`，shadow CAS，不是 production consumer）：**
shadow root 的 route/graph 槽扩为
`FamilyRouteRuntimeHandle | CreditRouteRuntimeHandle` 与
`ProjectedFamilyRouteGraph | ProjectedCreditRouteGraph`；新增 `stageCreditFamily`
（Credit lifecycle box + `PreparedCreditRoutePublication` + `PreparedFamilyInstance` →
strict shard，逐 route 断言 issuer、投影 common-Graph、按 canonicalEdgeId 对齐
route/graph key）；Credit 与 route/Funding shards 进入同一次 atomic CAS；
views.handleByCanonicalEdgeId 现为两类 handle 的 union 索引；Credit shard 省略即
`issuer-bound StateInstance mutation proof` 拒绝（禁止静默 carry）。合同覆盖：Credit
同 CAS 提交（1 edge / 1 handle / revision 1）、省略拒绝。证据：`searcher:adapter-credit-runtime`
PASS + 全套件 + 完整 build。Funding/Credit production consumer、默认 authority、
sealed parity 与 systemic-live 仍 open。

**2026-08-11 strict funding/credit consumer read checkpoint（实现 commit
`574e15ff2ae3921daa945b2a0fba986e48d4b5f8`，shadow building block）：** 新增
`readStrictFundingOffers`（offers/tombstone/missing 三态，空 verified 即显式
tombstone，绝不含糊沿用旧 offer）与 `readStrictCreditRoute`
（canonicalEdgeId → issuer-bound route handle union，null 表示 strict catalog
未发布，绝不回落 legacy registry）。production solver 接线仍 open。

**2026-08-11 parity batch request validation checkpoint（实现 commit
`52ad56d7e1e3ef93c08bad1c342b2999a90d7fcd`，#2 sealed parity 前置）：** 新增
`validateArchitectureMigrationRequestFile`（双侧 capture 路径、evidenceClass/mode、
stateAnchors、performanceDiagnostics 四项）与
`architecture-migration-parity:run --check <batch-request.json>`。节点工作流可先
生成双侧 raw capture，校验 batch request 后再跑 sealed/unit parity。真实
`sealed-production` 双侧 capture 仍未产生。

**2026-08-11 生产消费入口与边界批量 checkpoint（实现 commits `02096c67`、
`978fe256`、`86bed808`、`27638b37`、`33d3da6e`、`73327e42`）：**

- `StrictCatalogConsumer`：production solver 的唯一 strict views 消费入口
  （pricing/funding/credit 三态解析，缺失即显式 outcome，绝不回落 legacy registry）；
- Funding 非空 offer 同 CAS 代际提交、tombstone↔offers read 三态；unsupported stage
  空白 outcomeRef 拒绝；
- exact quote cache capacity/address 边界全部 fail closed；
- side capture assembler：节点回放输出 → `RawArchitectureMigrationSideCapture` JSON；
- point-in-time enumerator：跨 Family 重复 key 允许、非 address-surface 拒绝；
- Funding/Credit staging domain 门：swap↔funding↔credit 错配 box 即拒绝；
- strict pricing read 的 missing-publication 分支。

证据：`searcher:adapter-family-shadow-suite`（10 合同套件）+ credit + parity +
完整 listener build 全部通过；Phase B/C shadow 合同套件在本批 commit 上重跑全过。
仍为 shadow/consumer 入口，production solver 接线与 `sealed-production` 双侧
capture 未落地。

**2026-08-11 consumer 定位/冻结与硬化批量 checkpoint（实现 commits `2f1b0e67`、
`0dbe4d4c`、`9c9e6569`、`066d33ad`、`f60cb32c`）：**

- `strictPricingPublicationKey` 公开为 consumer 定位 pricing publication 的同一
  format；`strictFundingPublicationKeysByFamily` 按 Family 列出 funding keys；
- pricing/funding read 结果全部冻结（fail-closed 输出），consumer 冻结合同；
- Credit staging 增加 route↔staged instance、route↔publication source 绑定门；
- Funding tombstone→offers→tombstone 三代往返、unknown Family keys 空集；
- deep-seal 覆盖不可枚举属性（hidden mutable prop 拒绝）；
- exact cache 同 key 覆盖 + LRU 逐出、closure 空 admitted 集合、enumerator 空
  Family 零库存 canonical hash、continuity composition binding 身份/冻结；
- parity request sealed-production 校验、assembler 空 captureId、malformed JSON
  全部 fail closed。

证据：`searcher:adapter-family-shadow-suite`（10 合同）+ credit + parity +
完整 listener build 全部通过；Phase B/C shadow 套件在本批 commit 上重跑全过。

**2026-08-11 30-slice 硬化批量 checkpoint（实现 commits `15c993c5`、
`3b059a64`、`966179b2`、`0b7324a5`）：**

- consumer 拒绝非冻结/非 committed views；`strictPricingPublicationKeysByFamily`；
- Funding offer 投影校验（asset/amounts/source/evidenceRefs/冻结）与 verified
  outcome 强制 evidence refs；
- closure 拒绝重复 closure Family 与重复 staged key；
- parity request 逐 stateAnchor 校验、baseline/challenger 路径去重、assembler
  evidenceRefs 去重排序并冻结；
- stage route/unsupported 未知 Family 拒绝；Credit 零 route 显式拒绝
  （graph-required family 无 route handles fail closed）；
- dex cursor 空文件/错 schema/错版本/嵌套目录/覆盖写、seed 退化回退；
- enumerator 空 Family 零库存、跨 key 同地址、hash 顺序无关、空 familyId 拒绝；
- exact cache 0 金额稳定 key、evidenceRefs 归一、命中输出全冻结、默认容量。

证据：全套件（10 合同）+ credit + parity + discovery-dex-cursor + 完整 listener
build 全部通过；Phase B/C shadow 套件在本批 commit 上重跑全过。

**2026-08-11 sealed-parity capture harness checkpoint（实现 commit
`27c44ffa`，#2 前置完成，fixture 级）：**

- `ArchitectureMigrationCaptureCorpus` 清单 + 校验（captureId/commit/五类
  fingerprint/evidenceRefs/stateAnchors/familyCases）；
- `architecture-migration-capture:run <corpus.json> <out.json>` CLI +
  `writeArchitectureMigrationSideCapture`（bigint-safe JSON）；
- univ2 fixture 回放器：真实执行当前 strict lifecycle，
  instances/edges/prices 为 `exercised`，enumeratedRoutes/exactQuotes/
  executionFragments/finalSimulations 诚实标为 `framework-blocked`；
- 端到端 sealed parity：`eligible=true`、全 cohort 语义正确
  （univ2 framework-blocked ×1、其余 21 not-exercised）；
- 编排脚本 `scripts/capture-migration-parity.sh`（challenger 侧）。

证据：`searcher:architecture-migration-capture` PASS + 全套件 + parity +
完整 build。剩余节点步骤：ds-baseline 冻结 SHA 的 capture exporter、真实
corpus 双跑、batch receipt；`sealed-production` 双侧 capture 仍未产生。

**2026-08-11 ds-baseline capture exporter + 跨分支 sealed parity smoke
checkpoint（baseline commit `96e0cc4f`，branch `codex/parity-capture-baseline`）：**

- 在冻结 ds SHA `94cdf1d4` 的独立分支上新增 baseline univ2 capture exporter：
  用旧 API `univ2BlockScanState.compileStateInstance` 与旧 canonicalEdgeId
  身份导出 `instances/edges`（exercised）、`prices` 及 deep stages
  （framework-blocked）；CLI `architecture-migration-baseline-capture:run` +
  合同测试；
- 同一 fixture 在 baseline（旧代码）与 challenger（新代码）两侧生成 raw side
  capture，经 trusted issuer 跑 sealed parity 成功产出 receipt：
  `eligible=true`、aggregate `fail`（诚实：univ2 `framework-blocked`，
  baseline missing `prices/enumeratedRoutes/exactQuotes/executionFragments/
  finalSimulations` 5 个 stage，覆盖率尚不足），commonGraph 无 delta。

这证明跨分支 capture → sealed receipt 全链路已通；节点真实 corpus 双跑
（真实状态读取 + 全 Family 覆盖）是下一步。真实 `sealed-production`
双侧 capture 仍未产生。

**2026-08-11 节点真实 corpus 双侧 sealed-production capture checkpoint
（机器证据，覆盖率受限，不是 pass）：**

- 真实 pool：UniV2 WETH/USDC `0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc`
  （token0 USDC `0xa0b8...`、token1 WETH `0xc02a...`），source block
  `25729060`（hash `0x2b9631...`，取自节点 local reth）；
- baseline 侧由冻结 ds SHA `94cdf1d4e0eb20a459786b9ebcbadc8f3ff926b0` 的
  `codex/parity-capture-baseline` 分支导出（旧 API），challenger 侧由
  `codex/s1-unified-adapter-architecture-impl` 当前 HEAD
  `b8c2f05879c5dbd8cab0bffc1783759f3f39df59` 导出（capture commit 由
  `git rev-parse HEAD` 精确绑定）；
- 节点临时 worktree：`/opt/MEV-baseline-capture`、`/opt/MEV-impl-capture`
  （未触碰线上 searcher，PID/DRY_RUN/runtime commit 前后一致）；
- `architecture-migration-parity:run` 产出 receipt `/tmp/parity-receipt.json`：
  `eligible=true`、aggregate `fail`、univ2-standard outcome
  `framework-blocked`（双侧实例/边集合无 delta；prices 与 deep stages
  未接线，诚实 fail）。

这是第一份真实双侧 `sealed-production` capture/receipt；要让 batch 转 pass，
剩余工作：真实 reserves/mids 读入（baseline+challenger 两侧 prices）、其余
21 个 Family 的 capture 覆盖、common-Graph 双侧导出。

**2026-08-11 univ2 真实价格 bilateral parity phase checkpoint（实现 commits
baseline `2bc1c9cb`、impl `14347dd3`，机器证据）：**

- baseline exporter 与 challenger `captureUniv2RealCase` 均支持真实
  reserves → 两侧 `prices` stage 为 `exercised`（price id 统一为
  `pool:tokenIn>tokenOut`）；
- 节点 block `25729060` 真实 reserves
  （USDC `8779048929520` / WETH `4684677056208081765678`）双跑 receipt：
  `missingPricedEdges=[]`、`changedPrices=[]`（双侧价格语义一致）、
  `eligible=true`、aggregate `fail`、univ2 `framework-blocked`
  （仅因 deep stages 未接线，诚实 fail）；
- 本 phase 关闭"真实价格双侧 capture"子项；剩余：deep stages
  （enumeration/exact/execution/final-sim）与其余 21 个 Family 覆盖。

**2026-08-11 sealed-capture 可复现性 phase checkpoint（实现 commits baseline
`741479e9`、impl `341cc666`/`8f4bfcab`，机器证据）：**

- baseline exporter 固定 deadline 常量、evidenceRefs 去重排序；challenger 侧新增
  `assertCaptureReproducible` 与两个 CLI `--check`（bigint-safe 编码比较）；
- 节点验证：baseline 连续两次运行 sha256 均为 `9334fef4e187...`；
  challenger real 连续两次 sha256 均为 `977be165226c...`，`--check` 输出
  `real capture reproducible`；
- receipt 语义不变：`eligible=true`、aggregate `fail`、`changedPrices=[]`、
  univ2 `framework-blocked`（deep stages 未接线）。

可复现性是 sealed parity receipt 的前置条件；本 phase 关闭该子项。

**2026-08-11 parity evidence bundle phase checkpoint（实现 commit
`1bfc5aa3`，机器证据）：** 新增 `writeParityEvidenceBundle` /
`assertParityEvidenceBundle` + CLI `architecture-migration-parity:evidence`
（含 `--check`）：把 baseline/challenger sides + receipt + sha256 manifest
固化到目录，任一侧篡改即 fail。节点真实制品固化到
`/opt/MEV-runtime/parity-evidence/univ2-25729060/`：

- baseline `94cdf1d4e0eb...` sha256 `9334fef4e187...`
- challenger `341cc66642aa...` sha256 `977be165226c...`
- receipt sha256 `58920624b71d...`，acceptance `eligible=true` / `fail`
- `--check` 输出 `evidence bundle valid fail 94cdf1d4..341cc666`

这是 Phase A/C 验收的机器可验证证据制品前置；真实 batch pass 仍需 deep
stages 与其余 Family 覆盖。

**2026-08-11 common-Graph 双侧导出 + 首次节点重跑 checkpoint（实现 commits
impl `14d89dcd`、baseline `7aec76c1`，机器证据）：** 双侧 capture 均新增
`commonGraph` 导出（edges 为 `exercised`，deep stages 诚实
`framework-blocked`）；节点 SSM `5b818694`（12:45:53Z）在 impl
`14d89dcd` / baseline `7aec76c1` 上重跑真实 corpus
（WETH/USDC `0xB4e16d...`，block `25729060`）：

- `baselineCaptureMissing=false`、`challengerCaptureMissing=false`；
- `commonGraphDelta.edges` 出现语义差异：baseline 旧
  `canonicalEdgeId` 用 tuple 型 execution-variant key
  （`["univ2-swap",null,null,null,null]`），challenger 用新
  `adapter-family-graph-route-v1` 内容哈希，同一 pool/方向被报为
  `missingIds` + `addedIds`；enumeratedRoutes/exactQuotes/
  executionFragments/finalSimulations 仍为 blocked、无 delta；
- `eligible=true`、verdict `fail`、univ2 `framework-blocked`。

这证明双侧 common-Graph 均已导出，但旧/新 edge 身份必须先经 fixed
baseline normalizer 归一才能比较；common-Graph edges parity 子项尚未关闭。

**2026-08-11 baseline edge identity normalizer phase checkpoint（实现
commits impl `70f0cf0b`/`8df6797b`、baseline `9d198bcc`，机器证据）：**

- baseline exporter：univ2 默认 feeBps 修正为 `30n`（与 challenger
  `uniV2FeeRuleForFactory` 标准 factory 规则一致），每个 legacy edge item
  携带 `baselineFacts`
  （`familyId/pool/token0/token1/tokenIn/tokenOut/feeBps/factory/reversePool`）；
- impl 新增 `architecture-migration-baseline-normalizer.ts`：在 trusted
  comparator 内用 legacy facts 重放 challenger
  `familyRouteCanonicalEdgeId`（binding fingerprint 用 EIP-55 canonical
  address，routeKey/id 用 lowercase，value 保留 checksummed token），
  分别接入 family `edges` stage 与 common-Graph `edges` stage；facts 缺失
  时原样透传，feeBps 与 factory rule 矛盾时 fail closed；
- 合同证据：`architecture-migration-baseline-normalizer` PASS、
  `searcher:architecture-migration-capture` PASS、
  `searcher:architecture-migration-parity-runner` PASS、
  `searcher:architecture-migration-parity` PASS、
  `searcher:architecture-migration-evidence` PASS、完整 listener build
  通过（fixture 双侧 legacy→challenger edges 归一后 delta 为空）；
- 节点 SSM `dfb12b00` 在 impl `8df6797b` / baseline `9d198bcc` 重跑真实
  corpus：`commonGraphDelta.edges = {missingIds:[], addedIds:[],
  changedIds:[]}`，四个 deep stage 均为 blocked 且 delta 空，
  `eligible=true`、verdict `fail`、univ2 `framework-blocked`（仅 deep
  stages 未接线）。

本 phase 关闭"common-Graph 双侧 edges parity"子项；剩余：deep stages
（enumeration/exact/execution/final-sim）双侧真实接线与其余 21 个 Family
的 capture 覆盖。

**2026-08-11 univ2 enumeratedRoutes bilateral phase checkpoint（实现
commits impl `b1f3f817`、baseline `c90e1eb4`，机器证据）：**

- fixture replay 与 baseline exporter 双侧 `enumeratedRoutes` 均从
  exercised edges 派生（按 routeKey 排序后带 `order`），normalizer 扩展
  覆盖 `enumeratedRoutes` stage（缺失 `order` 时 fail closed）；
- common-Graph 双侧 enumeratedRoutes 为 `exercised`，`buildUniv2CommonGraph`
  与 baseline `buildBaselineUniv2Side` 同步接线；
- 合同证据：`architecture-migration-baseline-normalizer` PASS、
  `searcher:architecture-migration-capture` PASS、
  `searcher:architecture-migration-parity-runner` PASS、
  `searcher:architecture-migration-parity` PASS、
  `searcher:architecture-migration-evidence` PASS、完整 listener build
  通过；
- 节点 SSM `a5d56b91` 在 impl `b1f3f817` / baseline `c90e1eb4` 重跑真实
  corpus：`commonGraphDelta.enumeratedRoutes={missingIds:[], addedIds:[],
  changedIds:[]}`，`edges` 仍全空；blocked stages 仅剩
  `exactQuotes`/`executionFragments`/`finalSimulations`，
  `eligible=true`、verdict `fail`、univ2 `framework-blocked`（仅上述三个
  deep stage 未接线）。

本 phase 关闭"双侧 enumeration parity"子项；剩余：exact/execution/
final-sim 双侧真实接线与其余 21 个 Family 的 capture 覆盖。

**2026-08-11 univ2 exactQuotes bilateral phase checkpoint（实现 commits
impl `b521a204`、baseline `1fec46cd`，机器证据）：**

- 固定测试 amount `1_000_000`（`UNIV2_CAPTURE_EXACT_AMOUNT_IN`）双侧
  exact quote：challenger 走 univ2 exact request program
  （`exact-reserves` → `quoteV2ExactInput`），baseline 用冻结 ds 同一
  `quoteV2ExactInput` 与同一 reserves/fee；item id 统一为
  `canonicalEdgeId + "\u001fexact:" + amountIn`，value 统一为
  `{routeKey, tokenIn, tokenOut, canonicalEdgeId, amountIn, amountOut,
  feeBps}`；
- baseline exporter 双侧 exactQuotes 仅在 reserves 提供时 `exercised`，
  否则诚实 `framework-blocked`；normalizer 扩展覆盖 `exactQuotes` stage
  （facts 缺失透传、amount 字段缺失透传、fee 与 factory rule 矛盾时
  fail closed）；
- 合同证据：`architecture-migration-baseline-normalizer` PASS、
  `searcher:architecture-migration-capture` PASS（含 real-reserves 双侧
  local parity：edges/enumeratedRoutes/exactQuotes delta 全空）、
  parity-runner/parity/evidence PASS、完整 listener build 通过；
- 节点 SSM `4b6e53a3` 在 impl `b521a204` / baseline `1fec46cd` 重跑真实
  corpus：`commonGraphDelta.exactQuotes={missingIds:[], addedIds:[],
  changedIds:[]}`，`edges`/`enumeratedRoutes` 仍全空；blocked stages
  仅剩 `executionFragments`/`finalSimulations`，`eligible=true`、
  verdict `fail`、univ2 `framework-blocked`（仅上述两个 deep stage 未
  接线）。

本 phase 关闭"双侧 exact parity"子项；剩余：execution/final-sim 双侧真实
接线与其余 21 个 Family 的 capture 覆盖。

**2026-08-11 univ2 executionFragments + finalSimulations bilateral phase
checkpoint（实现 commits impl `61abd3c2`、baseline `0bbd8a4a`，机器证据，
common-Graph 全阶段关闭）：**

- challenger 走 `univ2Execution.buildFragment`（exact evidence 绑定、
  `minAmountOut=quotedAmountOut`、`MIGRATION_CAPTURE_EXECUTOR`），final-sim
  用 `expectedEffects` + 四腿 token-delta conservation 检查 + repayment
  检查；baseline exporter 用冻结 ds 同一 `quoteV2ExactInput` 与同一
  fragment/effects 语义（canonical EIP-55 address、`sortedPair`
  amount0/1Out 放置）导出 raw node/effects 字段；
- impl normalizer 扩展覆盖 `executionFragments` 与 `finalSimulations`：
  从 baseline facts 重放 canonical edge id，重建 node（bigint 安全）计算
  `nodeFingerprint`，重建 effects 计算 `effectsFingerprint`；facts 缺失
  透传、node/effect 畸形或 conservation/repayment 不符 fail closed；
- 合同证据：`architecture-migration-baseline-normalizer` PASS、
  `searcher:architecture-migration-capture` PASS（local real-reserves
  双侧断言五个 commonGraph stage delta 全空 + `assembledCommonGraphParity`
  为 true + family 行仍 non-pass）、parity-runner/parity/evidence PASS、
  完整 listener build 通过；
- 节点 SSM `50b1ba20` 在 impl `61abd3c2` / baseline `0bbd8a4a` 重跑真实
  corpus：`commonGraphDelta` 五个 stage 全部
  `{missingIds:[], addedIds:[], changedIds:[]}`，
  `baselineBlockedStages=[]`、`challengerBlockedStages=[]`（
  `assembledCommonGraphParity=true`）；univ2-standard 全部 required
  stages 双侧 `exercised`、无 framework blocker，但 family 行仍为
  `semantic-mismatch`（family-level instance 身份尚未归一）；
  `eligible=true`、verdict `fail`（21 个未覆盖 Family + univ2 family 行
  non-pass）。

本 phase 关闭"common-Graph 双侧 deep stages（execution/final-sim）parity"
子项，common-Graph gate 已全绿；剩余：univ2 family 行 instance 身份归一
（令该行转 pass）、其余 21 个 Family 的 capture 覆盖。

**2026-08-11 univ2 family-level pass + common-Graph gate checkpoint（实现
commits impl `e25bc542`、baseline `af676bbe`，机器证据）：**

- baseline exporter 的 instance/price item 增加 `baselineFacts`；impl
  normalizer 新增 `instances`（用冻结 catalog 的
  `instance.contentHash` + `staticBindingProjection` 重算
  `staticBindingFingerprint`）与 `prices`（重建 univ2 routeEdge/mid，
  bigint 以 string 形态与 JSON 侧一致）两路归一；
- trusted comparator 的 `nonMigratedFamilies` 双侧均为 null 时按 vacuous
  pass 处理（没有声明非迁移 Family 不是 gate 失败）；
- 合同证据：`architecture-migration-baseline-normalizer` PASS、
  `searcher:architecture-migration-capture` PASS（local real-reserves 双侧
  univ2 family 行 pass + aggregate `partial`）、parity-runner/parity/
  evidence PASS、完整 listener build 通过；
- 节点 SSM `467bb405` 在 impl `e25bc542` / baseline `af676bbe` 重跑真实
  corpus：`univ2-standard` family 行 **pass**；commonGraph 五 stage 全空 +
  `assembledCommonGraphParity=true`；`nonMigratedFamilySemanticHashParity
  =true`；`aggregateVerdict=partial`（21 个未覆盖 Family）、acceptance
  `eligible=true`/`verdict=partial`。

本 phase 关闭 univ2-standard 的 family 行语义 parity 与 common-Graph gate；
剩余：其余 21 个 Family 的 capture 覆盖，令 batch matrix 全部 pass 后
aggregate 转 pass。

**2026-08-11 univ3 fixture capture + pricing precision plain-record
framework fix checkpoint（实现 commit impl `61c77305`，fixture 级合同证据，
不是节点机器证据）：**

- 发现并修复 strict lifecycle blocker：UniV3/UniV4 pricing snapshot 的
  `precision` 是 `ReadonlyMap`，中央 runtime 的 plain-record 校验拒绝
  （`decode:pricing snapshot.precision must contain only plain records
  and arrays`）→ 两族 pricing `decodeSnapshot` 改为 plain `Record`，
  `deriveMids`/`classifyUnavailable` 改用索引访问；capability 内容哈希随
  源码变化重生成（`family-capability-shadow.generated.json` 已更新，
  build `--check` 通过）；
- 新增 `captureUniv3FixtureCase`：swap-call observation 走完整 strict
  lifecycle（identity pool-static + reverse binding、instance、routes、
  pricing current slot0/liquidity + precision quote、quoter-v2 exact、
  execution fragment、final-sim conservation/repayment）→ 全部 10 个
  stage 为 `exercised`（edges/prices/exact/execution/final-sim 各 2 条）；
- 合同证据：`searcher:architecture-migration-capture` PASS（含 univ3
  fixture 全 stage 断言）、`univ3-family-plugin` PASS、parity-runner/
  parity/evidence PASS、完整 listener build 通过。

这是 fixture 级（本地合同）证据；baseline 侧 univ3 exporter + univ3
normalizer + 节点真实 corpus 双侧 capture 是下一 phase，未完成前不得把
univ3 当作 batch pass 或 production cutover。

**2026-08-11 univ3 baseline normalizer contract checkpoint（实现 commit
impl `ab4c06bd`，本地合同证据）：**

- `architecture-migration-baseline-normalizer.ts` 按 `baselineFacts.familyId`
  分流 univ2/univ3：univ3 facts 携带
  `pool/token0/token1/tokenIn/tokenOut/fee/tickSpacing/factory/reversePool/
  quoter/router/quoterProvenance`；
- univ3 canonical edge 用同一 `adapter-family-graph-route-v1` 派生
  （binding fingerprint = `uniV3StaticBindingProjection` 形状，venue =
  `address-pool`），instances 用 univ3 `instance.contentHash` 重算
  `staticBindingFingerprint`，prices 重建 univ3 routeEdge/mid
  （`v3Fee`/`v3TickSpacing`/`sqrtABX96`/`liquidity`），exact/execution/
  final-sim 与 univ2 同构（execution node 参数
  `zeroForOne/amountSpecified/sqrtPriceLimit`）；
- 合同证据：`architecture-migration-baseline-normalizer` PASS（univ3
  fixture 双侧 legacy→challenger 逐 stage deepEqual）、
  capture/parity-runner/parity/evidence PASS、完整 listener build。

univ3 baseline exporter（冻结 ds `univ3-standard` 侧）与节点真实 corpus
双侧 capture 仍未落地，是下一 phase。

**2026-08-11 univ3 bilateral fixture parity phase checkpoint（实现 commits
impl `ab4c06bd`、baseline `877e95b7`，本地跨分支机器证据）：**

- baseline exporter 新增 `captureUniv3BaselineCase`/`buildBaselineUniv3Side`/
  CLI `family:"univ3"`：冻结 ds `univ3BlockScanState.compileStateInstance`
  （readStatic 回放 factory getPool reverse binding）+ `deriveMids`
  （slot0/liquidity + 本地 v3 precision quote）+ 同一 `v3SwapExactInput`
  exact/execution/final-sim，与 challenger fixture 使用同一组
  pool/tokens/fee/tickSpacing/liquidity/sqrtPriceX96；
- 本地跨分支 fixture parity（baseline CLI ×2 + impl fixture corpus +
  trusted parity runner）：`univ2-standard` **pass**、`univ3-standard`
  **pass**、`assembledCommonGraphParity=true`（五 stage delta 全空）、
  `nonMigratedFamilySemanticHashParity=true`、aggregate `partial`（剩余
  20 个未覆盖 Family）；
- 合同证据：baseline `searcher:architecture-migration-baseline-capture`
  PASS（univ3 全 stage exercised + commonGraph 断言）、impl normalizer
  PASS、双侧 tsc/build 通过。

univ3 节点真实 corpus 双侧 capture 是下一 phase（需在节点写入 univ3
descriptor 并跑合并 corpus）；此前不得把 univ3 当作 production cutover。

**2026-08-11 univ3 real-corpus bilateral parity phase checkpoint（实现
commits impl `c91a9a43`、baseline `877e95b7`/`0d518421`，节点机器证据）：**

- impl 新增 `captureUniv3RealCase`（真实 pool/token/fee/tickSpacing/
  liquidity/sqrtPriceX96 参数化）与 multi-family real manifest CLI
  （`{sourceBlock, cases:[univ2, univ3]}` 合并 familyCases + commonGraph）；
- baseline exporter 修正 univ3 fee 强转 bigint（`0d518421`），真实
  descriptor 走同一 `compileStateInstance` + `deriveMids` + 本地 v3
  exact/execution/final-sim；
- 节点 SSM `8579d3fa`（impl `c91a9a43` / baseline `0d518421`）在 block
  `25729060` 双跑真实 corpus：
  - univ2 WETH/USDC `0xB4e16d...`（reserves 同前）；
  - univ3 WETH/USDC 0.3% `0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8`
    （fee `3000`、tickSpacing `60`、slot0 sqrtPriceX96
    `7496226128926009721885528998955294720`、liquidity
    `623616275992676280`，取自节点 local reth eth_call）；
  - receipt：`univ2-standard` **pass**、`univ3-standard` **pass**、
    `assembledCommonGraphParity=true`、
    `nonMigratedFamilySemanticHashParity=true`、aggregate `partial`
    （20 个未覆盖 Family）、acceptance `eligible=true`/`verdict=partial`。

本 phase 关闭 univ3 真实 corpus 双侧 parity；剩余：其余 20 个 Family 的
capture 覆盖（含 funding-only 与各 protocol 族）。

**2026-08-11 multi-family real capture reproducibility checkpoint（实现
commit impl `dc952658`，本地跨分支证据）：**

- `architecture-migration-capture:real` 支持 `--check`：同一 manifest 连续
  两次生成 side JSON 必须字节一致（`real capture reproducible`）；
- 新增 `scripts/run-migration-parity-multi.py` 编排器：读取 frozen
  manifest（sourceBlock/hash + cases），逐 Family 跑 baseline exporter、
  合并 baseline sides、跑 impl challenger real capture、写 batch request、
  跑 trusted parity runner 并落盘 receipt；本地跨分支复跑
  univ2+univ3 fixture corpus 得到与节点一致的
  `aggregate=partial`、`commonGraphParity=true`、
  `univ2-standard pass`、`univ3-standard pass`。

该编排器使后续 Family（univ4、funding-only、protocol 族）的节点双跑可以
用同一 frozen manifest 机械复现，不再依赖手写 SSM 命令。

**2026-08-11 univ4 fixture capture checkpoint（实现 commit impl
`9caaa83a`，fixture 级合同证据，不是节点机器证据）：**

- 新增 `captureUniv4FixtureCase`：manager swap-call observation（pool key
  USDC/WETH 0.3%/60/no-hook）走完整 strict lifecycle——identity
  `manager-active-proof`（manager code + state view getSlot0/getLiquidity）、
  instance、routes、pricing current（slot0/liquidity + univ4 precision
  quote）、`univ4-quoter` exact、`univ4Execution` multi-node fragment
  （unlock/swap/take/sync/transfer）、final-sim 两腿 conservation +
  repayment；
- 全部 10 个 stage 均为 `exercised`（edges/prices/exact/execution/
  final-sim 各 2 条）；canonical edge id 使用
  `manager+poolId` 结构（`manager-pool-id` venue）；
- 合同证据：`searcher:architecture-migration-capture` PASS（univ4 fixture
  全 stage 断言）、parity-runner/parity/evidence PASS、完整 listener
  build。

univ4 baseline exporter（冻结 ds `univ4-standard`）+ univ4 normalizer +
节点真实 corpus 双跑是下一 phase；此前不得把 univ4 当作 batch pass 或
production cutover。

**2026-08-11 univ4 real capture + manifest 支持 checkpoint（实现 commit
impl `408c348b`，fixture 级合同证据）：**

- 新增 `captureUniv4RealCase`（currency0/1、fee、tickSpacing、hooks、
  liquidity、sqrtPriceX96、lpFee 参数化，poolId 由 `v4PoolId` 推导）；
- `architecture-migration-capture:real` 的 multi-family manifest 支持
  `family:"univ4"` case，与 univ2/univ3 合并进同一 corpus/commonGraph；
- 合同证据：`searcher:architecture-migration-capture` PASS（univ4 real
  全 stage exercised 断言）、完整 listener build。

下一步：univ4 baseline exporter + univ4 normalizer（`manager-pool-id`
venue 与 `manager+poolId` instance 身份）+ 节点真实 corpus 双跑。

该 commit 的合同证据为
`searcher:adapter-family-snapshot-inventory-closure`、
`searcher:adapter-family-observation-shadow-ingress`、
`searcher:adapter-family-discovery-checkpoint`、
`searcher:adapter-family-shadow-catalog-publication`、
`searcher:adapter-family-catalog-publication`、
`searcher:family-capability-catalog`、
`searcher:production-family-composition` 与完整 `npm run build` 全部通过；这些是 unit/shadow receipt，仍不是
`sealed-production`、deployment 或 live evidence。

**2026-08-09 topology adoption runtime-descriptor 修复 checkpoint（实现 commit
`90887cc53e9649805fc1acb88e09a1e2f1b4d019`）：** `febda231` 的节点观测在 block `25713055`
发生确定性覆盖断崖：前 30 代 `priced/expected` 约为 `87.9%–91.5%`，随后 45 代稳定为约
`486/32184`（`1.51%`）。五个 `state-instance-v1` swap Family 同时报
`lacks its runtime descriptor`，而 generation 仍为 `degraded`、`recoveryPending=false`，所以继续等待不会触发
bootstrap/recovery，也不能获得连续 300 个 valid pass。

根因是 production registry 的 `blockScanStateFamilies()` 每次 projection 都新建 registration 闭包；闭包拥有
`compileStateInstance()` 生成的 process-local runtime-descriptor store。拓扑不变时 coordinator 继续消费旧 topology
中的 registration，故启动后可正常运行；拓扑重建/adoption 后，新 topology 换成空 store 的新 registration，却复用
已经 canonical CAS 发布的 `CompiledStateInstance`，导致全量 carry 的实例失去 runtime descriptor。修复把该
projection 固定为 registry 进程生命周期内的同一不可变 registration 集合；这不改变 Family membership、Graph、
pricing 数学、budget 或 fallback，只恢复 published instance 与其 runtime descriptor 的共同生命周期。

回归先要求连续两次 registry projection 返回同一数组及逐 Family 同一 registration identity；另一个
production-shaped 用例通过真实 `AdapterFamilyRegistry` 执行 `gen1: 1 pool compile/publish → gen2: 1 old pool carry +
1 new pool compile → compose`，并断言第二代 `complete`、只编译/静态读取新增 pool 且没有 runtime-descriptor issue。
它与 `5,000+1` topology-spike 合同共同覆盖 topology rebuild。定向证据
`searcher:production-family-composition`、`searcher:blockscan-state-coordinator`、
`searcher:blockscan-state-pool-topology-spike`、`searcher:adapter-runtime-coordinator` 与完整 `npm run build` 已通过。
该 checkpoint 仍只表示代码与本地合同通过；节点 guarded deployment 以及从新 process anchor 开始的连续 300 个
periodic non-warm pass（`enumeration=ran` 且 `priced/expected > 80%`）尚待单独机器证据，不能在取得该证据前
宣称 live acceptance 或 production cutover。

**2026-08-09 N−1 hot-path continuity 失败与修复 checkpoint（不是 live pass 或 production cutover）：**
`f6ff7a43be72f4d378ba126d9b05ea4be1765b32` 的 guarded bounded-live 部署在同一
PID/runtime/log inode 且 `NRestarts=0` 下取得 `25713999..25714117` 的 119 个严格连续 valid pass，随后
`25714118` 以 `stale_state/source_head_superseded` 中断；canonical schema-v2 receipt 由 SSM
`4710c7cf-5c90-4b5f-8968-a4cb41c83bce` 产生，manifest SHA-256 为
`6b4eb6f60b33007b9c60283523e5fe13b6f1bd92c9437dc5a296fe30ed1a5488`。因此该精确部署明确未通过连续
300 门，119 个样本不得在后续 commit 上续算。

块级 telemetry 把前一 pass 的 `17,792ms` 拆为 state `1,444ms`、enumeration `1,704ms`、exact refine
`6,256ms` 和 planner/funding `8,387ms`；同期 strict discovery backfill 运行 `9,496ms`，随后两个 head 只隔
`1ms` 进入本地 scheduler。修复分成两个已提交 slice：
`3fdcdd1e5c6b2fd69067643d7a1ee9f1f689bd46` 在 DEX/protocol backfill 的 job、read 与 DEX→projection/protocol
stage 边界把 producer-busy 变成可重试 defer；`5d23ce848a4e9cf29ebc25ccb2fafe264bf97ef8` 在完整 yield 后仍
producer-busy 时拒绝新 exact batch，并把 exact-refine 硬限制为默认 `4,000ms`（仍受更短 outer pass/reserve
deadline 约束）。`searcher:discovery-backfill-lane` 12/12、`searcher:exact-producer-yield` 12/12、
`searcher:blockscan-runtime-startup-warm` 42/42、candidate-refinement、pass-deadline 与完整 listener build 已通过；
这些仍只是实现/本地合同证据。必须从 `5d23ce84...` 的新 guarded deployment、process anchor 和日志边界重新取得
连续 300 个 valid pass，才可关闭该精确 runtime 的 live-continuity 子门；strict catalog production authority、
sealed parity、Funding/Credit production consumers、完整 systemic-live gate 与 Phase E 仍全部未关闭。

**2026-08-11 S1 分支 discovery 优化接入 checkpoint（实现 commit
`269ade3c610b9b79368d566fb2ee0e88e500d0f0`，cherry-pick 自 ds `3c4e2014`，不是 live pass）：**
把 DEX coverage 游标持久化与冻结开关移植进 S1 分支：

- 新增 `discovery-dex-cursor.ts`，按 `SEARCHER_DISCOVERY_DEX_CURSOR_PATH`
  （默认 `listener/searcher/pools/runtime-dex-graph-coverage.json`）持久化
  `sourceCompleteThrough/graphCompleteThrough + canonical source hash`；启动时先校验 hash，
  再以 `max(universe.toBlock, persisted cursor)` 作为初始 DEX source completeness，
  不再退化为 `universe.fromBlock-1` 的 2 天窗口深扫；
- `SEARCHER_DISCOVERY_BACKFILL_ENABLED=0` 停掉 deep backfill lanes（保留 startup seed + hot path）；
- `SEARCHER_DISCOVERY_HOT_DEX_ENABLED=0` 额外冻结 per-block hot DEX scan，图停在启动截断点。

**验收口径更新（用户 2026-08-11 指示）：** live-continuity 子门从连续 300/300 放宽为
连续 100/100，其余口径不变——同一精确部署 commit、稳态锚点后、每个合格 pass 均为
`enumeration=ran` 且 `priced/expected > 80%`，每 commit 最多观察 500 个合格 pass。
旧的 300/300 不再作为完成条件；`f6ff7a43` 的 119 连记录因此已满足 100/100，但该 commit
已被后续修复取代，不能跨 commit 续算，仍需从新部署的精确 commit 重新取机器证据。

证据：`searcher:discovery-dex-cursor` PASS、`searcher:discovery-backfill-lane` 12/12、
完整 listener build 通过；这些仍是实现/本地合同证据，不是 `sealed-production` 或 live 验收。

**2026-08-11 S1 100/100 live-continuity 验收 checkpoint（机器证据，不是 Phase D cutover）：**
精确部署 commit `269ade3c610b9b79368d566fb2ee0e88e500d0f0`
（`codex/s1-unified-adapter-architecture-impl`，节点 `/opt/MEV` detached HEAD），进程锚点为
systemd `mev-searcher` PID `2882014`、`NRestarts=0`、进程 env `SEARCHER_RUNTIME_COMMIT` 与
部署 commit 一致；沿用既有 bounded-live envelope（`.deploy-live` 未改动、`SEARCHER_DRY_RUN=0`、
`SEARCHER_EV_GATE=1`）。本次部署同时启用 discovery 冻结
（`SEARCHER_DISCOVERY_BACKFILL_ENABLED=0`、`SEARCHER_DISCOVERY_HOT_DEX_ENABLED=0`），消除
discovery 追赶与 N-1 producer 的 CPU/RPC 争抢。

验收工具 `analysis blockscan-window`（schema-v2），`startLine=105905`
（`[searcher/live] starting V5 searcher` + 唯一 `runtime_commit` 锚点，`recordsBeforeRuntimeCommit=0`，
`eligibleForQualification=true`），`minRun=100`：

- 113 passes、105 valid、8 `enumeration_not_ran`（全部在启动 catch-up 期）、
  `ranMissingState=0`、`ranLowCoverage=0`、`continuityBreaks` 为空；
- `longestRun=105`：block `25729708..25729812`（blockSpan 105，`consecutiveSourceBlocks=true`），
  `priced/expected` min `0.9092` / avg `0.9093`（>80%），`generationWallMs` P50 `5.86s` /
  P95 `6.17s` / max `6.36s`，graphEdges 恒为 `35120`；
- 外部 PID 绑定：systemd PID `2882014`、`NRestarts=0`、进程 env runtime commit 一致。

按用户 2026-08-11 放宽后的口径（同一精确部署 commit、稳态锚点后连续 100/100 合格 pass，
每个 pass 均为 `enumeration=ran` 且 `priced/expected>80%`），该精确 runtime 的 live-continuity
子门关闭。此证据不关闭 strict catalog production authority、sealed parity、
Funding/Credit production consumers、systemic-live gate 或 Phase E。

## 8. Identity：多来源 variant，统一行为证明

冻结 ds 已有 `identityPolicies`、`discoveryIdentityResolver`、typed `IdentityAuthority`、retained-instance re-probe
和 `probeCandidate()` 后准入，且唯一 registry 会检查 identity/discovery 声明覆盖。目标不是丢掉这些链上证明，
而是把现在分散在 resolver、candidate matcher、probe callback 中的“构造 read / 执行 read / 解释证据”拆成下方
variant program；authority、reverse binding 与 active behavior proof 继续 fail closed。

```ts
type IdentityVariantKind =
  | "factory-child"
  | "registry-member"
  | "standalone-contract"
  | "singleton-subinstance"
  | "custom";

export interface IdentitySemantics<
  Candidate extends FamilyCandidate,
  Identity extends VerifiedIdentity,
> {
  readonly variants: readonly IdentityVariant<Candidate, Identity, unknown>[];
  /** 多个 provenance 证明同一实例时，归一化到一个稳定 key。 */
  identityKey(identity: Identity): string;
}

interface IdentityVariant<Candidate, Identity, Evidence> {
  readonly id: string;
  readonly kind: IdentityVariantKind;
  applies(candidate: Candidate): boolean;

  requirements(input: IdentityStepInput<Candidate, Evidence>): RequestRequirements;
  buildRequests(
    input: IdentityStepInput<Candidate, Evidence>,
  ): readonly AdapterRequest[];
  decode(input: {
    readonly step: IdentityStepInput<Candidate, Evidence>;
    readonly results: readonly AdapterRequestResult[];
  }): Evidence;
  decide(input: IdentityStepInput<Candidate, Evidence>):
    | { readonly status: "continue" }
    | { readonly status: "verified"; readonly identity: Identity }
    | { readonly status: "rejected"; readonly reason: IdentityRejectReason };
}
```

Adapter 声明 requests，中央执行它们：

```ts
async function runIdentityVariant<C, I, E>(input: {
  family: LoadedFamilyPlugin<C, I, any, any, any, any, any>;
  variant: IdentityVariant<C, I, E>;
  candidate: C;
  source: CanonicalSource;
  policy: IdentityExecutionPolicy;
}): Promise<IdentityOutcome<I>> {
  let evidence: E | undefined;
  let executedSteps = 0;

  for (;;) {
    const context = {
      candidate: input.candidate,
      evidence,
      step: executedSteps,
    };
    const decision = input.variant.decide(context);
    if (decision.status !== "continue") return sealIdentityOutcome(decision);
    if (executedSteps >= input.policy.maxProtocolSteps) {
      return { status: "unresolved", reason: "identity_step_budget_exhausted" };
    }

    const requirements = input.variant.requirements(context);
    input.policy.assertSupportedAndBudgeted(requirements);
    const requests = input.variant.buildRequests(context);
    input.policy.assertRequirementsMatchRequests(requirements, requests);
    const results = await input.policy.executeRequests({
      stage: "identity",
      familyId: input.family.manifest.familyId,
      candidateKey: input.family.discovery.candidateKey(input.candidate),
      source: input.source,
      generation: input.policy.generation,
      requirements,
      requests,
    });
    input.policy.assertRequiredResultsSucceeded(requests, results);
    evidence = input.variant.decode({ step: context, results });
    executedSteps++;
  }
}
```

Family 不能控制无限 retry、deadline 或并发，也不能通过 request builder 直接调用 backend。`rejected` 只能来自
成功取得并解码的负面行为证据；RPC/deadline/resource failure 是 `unresolved`，不能缓存成永久负身份。
这里的 `policy` 必须委托给 §4.2/§4.3 的同一中央 Request Program executor；上面的显式断言只是把不可省略的
顺序写清楚，不授权实现一套 identity-only transport 旁路。

`runIdentityVariant()` 只是一个 variant 的执行器；candidate 的最终身份必须聚合**全部 applicable variants**：

1. 任一 variant `verified` 时，收集全部 verified 结果，要求 `identityKey` 一致后合并 provenance；互相冲突则 fail closed。
2. 无 verified、但至少一个 variant `unresolved` 时，candidate 总结果为 `unresolved`，不能被另一个 variant 的 reject 覆盖。
3. 无 verified/unresolved、但有 framework/decoder failure 时，总结果为 `failed`。
4. 只有全部 applicable variants 都取得可信负证据并 terminal reject 时，才是 `rejected`。
5. 没有 applicable variant 时是 `unsupported-variant`。

反向证明成功不等于执行语义已经完整。例如新 Factory 的 pool 即使通过 `getPool(...) === candidate`，若当前
Lineage 没有可验证的 router/quoter/actor 或其他执行 binding，最终必须是 `unsupported-variant`，不能借用另一
Factory/Lineage 的固定基础设施继续准入。

因此 Factory variant 的负证据不能误杀同一 candidate 的 Registry/standalone 正证据；first-match/first-reject 都是违规。

## 9. Instance 与真正的 FamilySharedBinding

这里要区分两个“instance”：冻结 ds 已经在 **blockscan pricing** 中央持有
`Map<StateInstanceKey, CompiledStateInstance>`；但 discovery → route → exact/execution 仍主要通过 `PoolEntry`、
`TokenEdge` 与 family-specific fields 传递，并没有一份贯穿 S1–S4 的通用 `CompiledInstanceDescriptor`。本节是在
已部署 pricing StateInstance 之上建立全 Adapter 生命周期 descriptor，不是宣称当前完全没有实例隔离。

```ts
export interface InstanceSemantics<
  Identity extends VerifiedIdentity,
  Descriptor extends CompiledInstanceDescriptor,
> {
  instanceKey(identity: Identity): InstanceKey;
  compileDraft(identity: Identity): InstanceBindingDraft;
  readonly staticEvidence?: StaticEvidenceProgram<InstanceBindingDraft, unknown>;
  finalizeDescriptor(input: {
    readonly identity: Identity;
    readonly draft: InstanceBindingDraft;
    readonly staticEvidence?: unknown;
    readonly sharedBindings: readonly FamilySharedBindingRef[];
  }): Descriptor;
  staticBindingProjection(descriptor: Descriptor): CanonicalValue;
}

interface CompiledInstanceDescriptor {
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
  readonly instanceKey: InstanceKey;
  readonly provenance: readonly IdentityProvenance[];
  readonly runtimeRequirements: readonly RuntimeRequirement[];
}
```

中央持有：

```ts
Map<FamilyInstanceKey, CompiledInstanceDescriptorRef>
```

Adapter 每次只收到当前 identity/descriptor，不收到 sibling Map。

Family 的意义不是拥有 `schema.pools`。它提供：

- 同一套协议解释代码与 capability hashes；
- identity/route/pricing/execution ownership；
- domain policy 和 telemetry/failure namespace；
- 真正共享的 immutable binding 引用。

若确有共享链上数据，使用分片 binding：

```ts
interface FamilySharedBindingRef {
  readonly familyId: FamilyId;
  readonly bindingKind: string;
  readonly bindingKey: string;       // 例如 manager address、token、factory
  readonly fingerprint: string;
}

interface SharedBindingSemantics<Descriptor> {
  references(descriptor: Descriptor): readonly SharedBindingRequestKey[];
  readonly program: RequestProgram<SharedBindingRequestKey, unknown>;
  canonicalProjection(input: unknown): CanonicalValue;
}
```

正确例子：V4 Manager immutable binding、Factory reverse-proof binding、Router binding、按 token 分片的 decimals、
Oracle binding。错误例子：一个 `FamilySharedBinding` 重新装入整族所有 pool descriptor。共享 binding 变化只失效
引用它的实例；按 token 的数据不能用一个 family-wide decimals Map 放大全族故障域。

冻结 ds 的 `FamilySharedBinding` 已有 revision/fingerprint/value、content cache 与 canonical publication 接线，
但 capability 当前一次只能为整个 Family 返回一个 binding。迁移期可以继续使用这一实现；终态若共享数据可按
token/manager/registry 分片，中央 Map 的 key 必须扩为 `familyId + bindingKind + bindingKey + fingerprint`，实例只
引用所需 shard。无法分片的真实全族 binding 允许存在，但其 fan-out 必须显式计量，不能把 descriptor Map 塞回
`value` 绕过实例边界。

## 10. Route Projection：InstanceBinding 与 RouteBinding 分离

```ts
export interface RouteProjectionSemantics<Descriptor, Route> {
  project(input: {
    readonly descriptor: Descriptor;
  }): readonly Route[];
  projectGraph(input: {
    readonly descriptor: Descriptor;
    readonly route: Route;
  }): FamilyGraphProjection;
}

interface FamilyRouteDescriptor {
  readonly routeKey: RouteKey;
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
  readonly instanceKey: InstanceKey;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly taxonomy: AllowedTaxonomy;
  readonly bindingRef: RouteBindingRef;
  readonly runtimeRequirements: readonly RuntimeRequirement[];
}

interface FamilyGraphProjection {
  /** 本 route 的 Family-owned root ActionAdapter；不是中央 Family 分支。 */
  readonly routeActionAdapterId: string;
  /** 实际 call/settlement target；可与 identity subject 不同。 */
  readonly executionTarget: string;
  /** pool/address/Manager+PoolKey 等稳定 venue 身份的 canonical projection。 */
  readonly venueIdentity: CanonicalValue;
  /** 只标识中央 score/ranking 行；score 值和策略仍由中央拥有。 */
  readonly centralScoreKey?: string;
}

declare const familyRouteRuntimeHandleBrand: unique symbol;

interface FamilyRouteRuntimeHandle {
  readonly [familyRouteRuntimeHandleBrand]: void;
  readonly familyRuntimeIdentity: object;
  readonly familyId: FamilyId;
  readonly instanceKey: InstanceKey;
  readonly routeKey: RouteKey;
  readonly canonicalEdgeId: CanonicalEdgeId;
  readonly graph: FamilyGraphProjection;
}
```

`RouteProjectionSemantics` 必须同时提供无协议分支的 Graph projection（或等价的 Family-owned closure），让中央能
构造现有 compatibility `TokenEdge`。中央 catalog/publication coordinator 验证 action ownership、地址、taxonomy、
venue identity 和 canonical edge identity 后，签发 `FamilyRouteRuntimeHandle`，并在 issuer-private store 中保存原始
`Descriptor + Route + 完整 Family 私有 binding`。公开 handle 只暴露中央真正需要的投影；它不是可由对象字面量构造的
DTO。

标准投影策略可以复用：

```ts
type RouteProjectionStrategy =
  | { readonly kind: "bidirectional-pair" }
  | { readonly kind: "all-directed-pairs"; readonly tokensPath: string }
  | { readonly kind: "verified-directions" }
  | { readonly kind: "pool-key-routes" }
  | { readonly kind: "custom" };
```

例子：

- UniV3：一个 pool descriptor → 两条有向 route。
- Curve/Astra 三 token：最多六条有向 route，但只投影身份/行为已经证明的 pair。
- UniV4：Manager 不是实例本身；`Manager + PoolKey` 是 instance，再投影两个方向。
- ERC4626：只投影 `verifiedDirections`。Deposit 通过但 Redeem 未证明时，不能由通用 builder 重新长出 Redeem edge。

中央 Graph 只保存通用 route 字段、Graph projection 和 opaque handle ref；协议字段留在 family-owned descriptor
closure。不要把 `v4Hooks`、`curveI/J`、`dodoActor` 等字段逐个塞进中央 `TokenEdge`。route binding fingerprint
必须覆盖 Family 私有 immutable binding（例如 pool、fee/direction、V4 `PoolKey`、actor policy），不能只 hash
`FamilyRouteDescriptor` 的公共字段。exact、execution 与 victim replay 必须由 issuer 解包 stored route；caller 重新提交
一个 `routeKey` 相同、公共字段相同但私有字段被替换的对象时必须 fail closed。

## 11. StateInstance pricing：从已部署实例机制收紧到 descriptor-only

这部分必须按冻结 ds 的真实实现写：中央 StateInstance v1 已经包含：

- `schemaMode: "legacy-family" | "state-instance-v1"` 双模式和 `(familyId, rawStateKey)` 完整 edge group；
- coordinator-owned `StateInstanceSpec` / `CompiledStateInstance` Map、单一 `GraphChangeSet`、topology/schema/
  snapshot-compatibility 分层 diff；
- schema/static-evidence/instance/aggregate fingerprint、`FamilySharedBinding`、实例 static-read 去重；
- added/changed-only compile、changed failure 删除旧 descriptor、removed/re-add tombstone、warm-cache 三指纹、
  carry policy、canonical source CAS 与 generation fence；
- 非权威 compile content cache 可在未发布 generation 中预热，authoritative topology/state publication 仍只在
  canonical CAS 后切换；
- UniV2、UniV3、UniV4、DODO V2、Angstrom V4 的 full-vs-instance parity 与 `+1 pool` 增量测试。

对应实现是
[`BlockScanStateCapability`](../../../listener/src/searcher/venues/blockscan-state-capability.ts) 与
[`BlockScanStateCoordinator.prepareInstanceFamily()`](../../../listener/src/searcher/blockscan-state-coordinator.ts)，
回归集中在
[`blockscan-state-coordinator.ts` tests](../../../listener/src/searcher/test/blockscan-state-coordinator.ts)。

冻结 ds 同时仍有四个**迁移桥**：

1. 未迁 active pricing Family 继续走 `legacy-family` 的 full-family compiler；
2. 五个已迁 Family 通过 `assembleSchema(entries)` 把 coordinator-owned instance entries 包成
   `{ pools/groups: Map }`，供现有 current/decode closure 使用；
3. `compileStateInstance()` 可在 Adapter 内主动调用 `input.readStatic()`；
4. `adapterSchemaRevision` 仍手工维护，`snapshotCompatibilityRevision` 当前未声明时退回 `familyId`；spec 的
   static binding 则由中央 `stateSchemaFingerprint(group.edges)` 提供，而不是每个 capability 的生成式
   canonical projection。

因此，下面不是重做 B1–B6，而是把已部署机制的最后一层 family-shaped facade 和主动 I/O 收紧掉。迁移终态
不再存在：

```text
schemaMode
compileStaticSchema
extendStaticSchema
assembleSchema
schema.pools
schema.groups
adapterSchemaRevision
```

批量重构期间 legacy full path 可以作为 frozen oracle/显式部署回滚桥存在，但不能在单实例失败后自动 fallback；
已迁 Family 的生产 generation 仍必须二选一。全部 active pricing Family 通过 §20 后，full compiler、双模式
discriminant、`assembleSchema` facade、旧 schema container 类型及 legacy-only tests 必须删除。终态回滚使用上一
已验收构建物，而不是让第二条 runtime path 常驻。

### 11.1 完整 pricing 合同

下方是**终态 descriptor-only 合同**。它保留 ds 已验证的 `stateKey`、snapshot compatibility、dependent reads、
mutation、carry 与 unavailable semantics，但 Adapter 每次只处理一个实例，不再拿 family container。

```ts
interface BoundRequestProgram<Evidence> {
  readonly requirements: RequestRequirements;
  readonly requests: readonly AdapterRequest[];
  decode(results: readonly AdapterRequestResult[]): Evidence;
}

export interface PricingSemantics<
  Descriptor,
  Route,
  PricingDescriptor,
  Snapshot,
> {
  stateKey(route: Route): string;

  /** Adapter 提供 canonical 语义投影，中央负责 hash。 */
  staticBindingProjection(input: {
    readonly descriptor: Descriptor;
    readonly routes: readonly Route[];
  }): CanonicalValue;
  snapshotCompatibilityProjection(input: {
    readonly descriptor: Descriptor;
    readonly routes: readonly Route[];
  }): CanonicalValue;

  compileDraft(input: {
    readonly descriptor: Descriptor;
    readonly stateKey: string;
    readonly routes: readonly Route[];
  }): PricingDescriptorDraft;
  readonly staticEvidence?: StaticEvidenceProgram<PricingDescriptorDraft, unknown>;
  finalizePricingDescriptor(input: {
    readonly draft: PricingDescriptorDraft;
    readonly staticEvidence?: unknown;
    readonly sharedBindings: readonly FamilySharedBindingRef[];
  }): PricingDescriptor;

  readonly current: {
    requirements(input: CurrentPricingInput<PricingDescriptor, Route>): RequestRequirements;
    buildRequests(
      input: CurrentPricingInput<PricingDescriptor, Route>,
    ): readonly AdapterRequest[];
    buildDependentProgram?(input: {
      readonly current: CurrentPricingInput<PricingDescriptor, Route>;
      readonly completedRound: number;
      readonly initialResults: readonly AdapterRequestResult[];
      readonly priorEvidence: readonly unknown[];
    }): BoundRequestProgram<unknown> | null;
    decodeSnapshot(input: {
      readonly descriptor: PricingDescriptor;
      readonly initialResults: readonly AdapterRequestResult[];
      readonly dependentEvidence: readonly unknown[];
    }): Snapshot;
    deriveMids(input: {
      readonly descriptor: PricingDescriptor;
      readonly snapshot: Snapshot;
      readonly routes: readonly Route[];
    }): ReadonlyMap<RouteKey, RouteVenueMid>;
    classifyUnavailable?(input: {
      readonly descriptor: PricingDescriptor;
      readonly snapshot: Snapshot;
      readonly routes: readonly Route[];
    }): ReadonlyMap<RouteKey, string>;
  };

  dependencies(input: {
    readonly descriptor: PricingDescriptor;
    readonly routes: readonly Route[];
  }): readonly string[];
  readonly mutation?: MutationSemantics<PricingDescriptor, Route>;
  readonly liveStateProjection?: LiveStateProjection<PricingDescriptor, Snapshot>;
}
```

所有 Adapter 函数必须同步、确定性、无 I/O。dependent round 必须返回完整的 per-round program，而不是只返回裸
requests 并借用 initial round 的 requirements；每轮可以有不同 caller/transport/effects/decoder。中央拥有最大轮数、
budget 与循环，`null` 表示协议语义已经 terminal，不能由 Adapter 自己循环到满意为止。

### 11.2 中央 descriptor 编译核心

冻结 ds 当前顺序是：coordinator 构造 `StateInstanceSpec` → 对 changed/added key 调异步
`family.compileStateInstance({ previous, sharedBinding, readStatic })` → 将成功 opaque entries 交给
`family.assembleCompiledFamily()`。目标顺序把 Adapter 发起的 static I/O 再拆开：纯 `compileDraft()` 先声明
program，中央执行后调用纯 `finalizePricingDescriptor()`；随后 current/decode 直接使用该 descriptor。下方代码
表示终态顺序。

```ts
async function compilePricingInstance(input: {
  family: LoadedFamilyPlugin;
  group: StateInstanceGroup;
  previous?: CompiledStateInstance;
  /** 只作 candidate lookup；永远不等价于 `previous`。 */
  compileMemoStore: CompileMemoStore;
  sharedBindings: readonly FamilySharedBindingRef[];
  source: CanonicalSource;
  executor: BoundedRequestExecutor;
}): Promise<CompiledStateInstance> {
  const pricing = input.family.pricing;
  const groupBindingFingerprint = validateAndFingerprintStateInstanceGroup({
    familyId: input.family.manifest.familyId,
    instanceKey: input.group.instanceDescriptor.instanceKey,
    stateKey: input.group.rawStateKey,
    routes: input.group.routes.map((route) => ({
      routeKey: route.routeKey,
      instanceKey: route.instanceKey,
      bindingFingerprint: route.bindingRef.fingerprint,
    })),
  });
  const staticProjection = pricing.staticBindingProjection({
    descriptor: input.group.instanceDescriptor,
    routes: input.group.routes,
  });
  const schemaInputFingerprint = hashCanonical({
    key: input.group.key,
    pricingCapabilityHash: input.family.hashes.pricing.contentHash,
    instanceFingerprint: input.group.instanceFingerprint,
    staticProjection,
    sharedBindings: input.sharedBindings
      .map((item) => [item.bindingKey, item.fingerprint])
      .sort(([a], [b]) => a.localeCompare(b)),
  });
  const snapshotCompatibilityFingerprint = hashCanonical({
    pricingCapabilityHash: input.family.hashes.pricing.contentHash,
    projection: pricing.snapshotCompatibilityProjection({
      descriptor: input.group.instanceDescriptor,
      routes: input.group.routes,
    }),
  });
  const draft = pricing.compileDraft({
    descriptor: input.group.instanceDescriptor,
    stateKey: input.group.rawStateKey,
    routes: input.group.routes,
  });

  if (input.previous?.schemaInputFingerprint === schemaInputFingerprint) {
    const staticEvidenceReusable = await input.executor
      .proveStaticEvidenceReusable({
        familyId: input.family.manifest.familyId,
        program: pricing.staticEvidence,
        programInput: draft,
        previous: input.previous.staticEvidenceProof,
        source: input.source,
      });
    if (staticEvidenceReusable) {
      // 只复用 descriptor/evidence；当前 group/route coverage 与 carry
      // compatibility 必须按本代输入重新验证并重封，不能原样返回旧 wrapper。
      return resealCompiledStateInstance({
        previous: input.previous,
        key: input.group.key,
        groupBindingFingerprint,
        schemaInputFingerprint,
        snapshotCompatibilityFingerprint,
        source: input.source,
      });
    }
  }

  const memoCandidate = input.compileMemoStore.lookup({
    familyRuntimeIdentity: input.family.runtimeIdentity,
    stateInstanceKey: input.group.key,
    pricingCapabilityHash: input.family.hashes.pricing.contentHash,
    schemaInputFingerprint,
  });
  if (
    memoCandidate !== undefined &&
    await input.executor.proveCompileMemoReusable({
      candidate: memoCandidate,
      program: pricing.staticEvidence,
      programInput: draft,
      source: input.source,
    })
  ) {
    return sealCompiledStateInstanceFromMemo({
      candidate: memoCandidate,
      key: input.group.key,
      groupBindingFingerprint,
      schemaInputFingerprint,
      snapshotCompatibilityFingerprint,
      source: input.source,
    });
  }

  const executedStaticEvidence = pricing.staticEvidence
    ? await runRequestProgram({
        familyId: input.family.manifest.familyId,
        program: pricing.staticEvidence,
        programInput: draft,
        source: input.source,
        executor: input.executor,
      })
    : undefined;
  const descriptor = pricing.finalizePricingDescriptor({
    draft,
    staticEvidence: executedStaticEvidence?.evidence,
    sharedBindings: input.sharedBindings,
  });
  const staticEvidenceFingerprint = executedStaticEvidence
    ?.trustedResultsFingerprint ?? hashCanonical([]);

  const compiled = sealCompiledStateInstance({
    key: input.group.key,
    groupBindingFingerprint,
    schemaInputFingerprint,
    instanceFingerprint: hashCanonical({
      key: input.group.key,
      schemaInputFingerprint,
      staticEvidenceFingerprint,
    }),
    snapshotCompatibilityFingerprint,
    staticEvidenceProof: executedStaticEvidence?.reuseProof ??
      noStaticEvidenceReuseProof(input.source),
    descriptor,
  });
  input.compileMemoStore.putCandidate({
    familyRuntimeIdentity: input.family.runtimeIdentity,
    pricingCapabilityHash: input.family.hashes.pricing.contentHash,
    schemaInputFingerprint,
    compiled,
  });
  return compiled;
}
```

这里故意分三层：`groupBindingFingerprint` 由中央直接检查同一 Family/instance/stateKey、routeKey 唯一与 binding
coverage 完整；`schemaInputFingerprint` 决定 descriptor/static evidence 是否重编；
`snapshotCompatibilityFingerprint` 决定 route membership 变化后旧 snapshot 能否 carry。不能把全部 route binding
机械塞进 schema fingerprint，否则会破坏 UniV2 新增反向方向可复用 reserves 的安全优化；也不能只信任 Family
projection，否则遗漏 route ownership/binding 时中央无法发现。

中央只 hash 自己知道的 canonical projection 和可信 transport evidence，不序列化 Adapter 的 opaque descriptor。
复用 previous descriptor 还必须满足 static evidence 的 `reusePolicy`：`source-local` 每次重跑；
`immutable-code` 只有 code hash/proxy implementation 和 capability hash 均未变化时复用；`dependency-proof`
由中央在当前 source 检查依赖 fingerprint。Family 不能把可变链上值命名成 static 后永久缓存。
由于 reuse policy 可以依赖当前 draft，复用检查必须接收本代 `programInput`；命中后也只复用 descriptor 与可信
evidence，不复用旧的 group wrapper。当前 `groupBindingFingerprint` 与 `snapshotCompatibilityFingerprint` 必须重封，
否则 route membership/binding 变化可能被旧 coverage 或 carry proof 掩盖。

### 11.3 generation 调度与失败隔离

本节的 diff、实例复用、失败隔离和 CAS 不是未来假设，ds 已经由 `buildGraphChangeSet()`、
`prepareInstanceFamily()` 与 `prepare()` 实现。下面伪代码把现有机制映射到终态接口，省略的主要是当前
`assembleCompiledFamily()` facade。

```ts
async function preparePricingGeneration(input: PricingGenerationInput) {
  const groups = groupRoutesByFamilyAndStateKey(input.graph, input.catalog);
  // `previous` 只能来自最后一次成功 publication，不能来自 compile memo。
  const published = this.publishedDescriptorStore.snapshot();
  const changeSet = diffStateInstances(published.groups, groups);
  const staged = new Map(published.compiledInstances);

  for (const removed of changeSet.removed) staged.delete(removed.key);

  const settled = await runBoundedPerInstance(
    [...changeSet.added, ...changeSet.changed],
    async (group) => compilePricingInstance({
      family: input.catalog.forFamily(group.familyId),
      group,
      previous: published.compiledInstances.get(group.key),
      // memo 只提供待重新验证的 candidate；compilePricingInstance 不得把它
      // 当成 published previous，也不得据此授权 carry。
      compileMemoStore: this.compileMemoStore,
      sharedBindings: input.sharedBindings.forGroup(group),
      source: input.source,
      executor: input.staticReadExecutor,
    }),
  );

  for (const result of settled) {
    if (result.ok) staged.set(result.key, result.value);
    else {
      // changed key 失败时旧 descriptor 也必须移除。
      staged.delete(result.key);
      input.issues.recordInstanceFailure(result.key, "pricing_compile", result.error);
    }
  }

  const stagedSnapshots = await runCurrentStateLanes({
    graph: input.graph,
    instances: staged,
    source: input.source,
    transport: input.currentReadExecutor,
    carryProofs: input.carryProofs,
  });

  await input.canonical.verifySource(input.source);
  input.generationFence.assertCurrent(input.generation);
  await this.publicationCoordinator.commitAtomically({
    expectedPublishedRevision: published.revision,
    graph: input.graph,
    groups,
    compiledInstances: staged,
    snapshots: stagedSnapshots,
    publishedDescriptorStore: this.publishedDescriptorStore,
  });
}
```

上面把两个 store 直接写进伪代码是有意的：`publishedDescriptorStore.snapshot()` 是 diff、`previous` 和 carry 的
唯一历史来源；`compileMemoStore` 即使命中，也只能返回一个由 `compilePricingInstance()` 在当前 capability、输入、
source/reuse proof 下重新验证的候选。memo miss、memo 验证失败或 orphan generation 都不能改变 published snapshot。
最终 coordinator 的 CAS 同时校验 `expectedPublishedRevision`、canonical source 与 generation fence，成功后才推进
`PublishedDescriptorStore`；失败时 Graph、descriptor、snapshot 和 memo 之外的权威对象全部保持原 identity/content。

冻结 ds 的意图是保留两层状态，但当前 `prepareInstanceFamily()` 在最终 CAS 前写入 `instanceSchemas`、
`instanceSpecFingerprints`、`instanceSpecs` 与 `familySharedFingerprints`，而这些 Map 又会成为下一代的 published
previous；“controller 尚未 abort”不能证明 source 已发布。终态必须明确拆成：

- **`CompileMemoStore`** 可在 compile 成功后按 capability hash、schema input、可信 evidence/reuse proof 内容寻址预热，
  以免 40–50 秒纯编译在连续 supersede 中每代重做；memo 不能充当 published previous、授权 snapshot carry 或直接
  进入跨 generation exact/snapshot cache，每次消费仍要重新验证 reuse policy。
- **`PublishedDescriptorStore`** 保存 topology、active specs/descriptors、state/mids/coverage；只有 source canonical verify、
  generation fence 与全局 atomic CAS 全部通过后才能切换。late/foreign fingerprint 结果不能进入 publication。

所以“原子发布”不等于禁止一切预热 memo，而是禁止 memo 被伪装成权威历史。当前 pre-CAS Map 写入是必须修复的
substrate violation，不是终态可接受的优化。

这里的 publication transaction 是 **全 catalog**，不是 `for (family) family.publish()`。每个 Family shard 只能返回
staged instances/routes/pricing/outcomes；唯一中央 coordinator 在确认所有必需 discovery source 的 coverage/watermark、
canonical source 与 generation fence 后，一次提交：

- canonical Graph compatibility view；
- `CanonicalEdgeId → FamilyRouteRuntimeHandle` issuer index；
- pricing descriptors、snapshots、mids 与 coverage；
- 显式 `added/changed/removed/tombstone` delta 和 publication metadata。

任何 shard unresolved/failed 都必须按 source completeness 和 changed-key 规则生成明确 delta；不能把
`publication=null` 解释为“沿用旧 Family publication”。CAS 失败时上述权威对象的 identity 和 content 必须全部不变，
也不能出现 Graph 已更新但 route-handle/pricing 仍属于上一代的撕裂状态。

**2026-08-08 append-only publication checkpoint：** 当前 change set 已提供 shadow-only 全 catalog root：route、Graph、
pricing 与 compatibility views 由一个 opaque one-shot candidate 经 canonical verify、generation fence 和单 pointer CAS
原子切换；CAS loser、verifier/fence failure 保持旧 envelope/views/Maps 的 identity 与 content 不变。terminal/source
transition proof authority 由 composition 外部注入，root 不公开 issuer；pricing descriptor、snapshot、mid 与 readonly
Map 均深封闭。该 root 目前故意拒绝 `complete-snapshot`，也拒绝任何缺少 issuer-bound StateInstance mutation proof 的
跨 generation carry，所以每代 active route 必须由 fresh lifecycle publication 重新 staging。它仍是 shadow contract，
不构成 strict pricing production consumer、current-publication exact/execution membership 或默认 authority cutover。

中央拥有 Map、diff、read execution、batch、deadline、retry、cache、carry、CAS 和 publication。Adapter 不得
通过 `compileDraft()` 保存全族 Map，或在 `finalizePricingDescriptor()` 中扫描 sibling。

冻结 ds 的单实例 compile/hydration failure 已能隔离 sibling；但 `assembleCompiledFamily()` 仍是一个 family-level
组装点，理论上 facade 构造失败会让该 Family 本代没有 compiled runtime。五个已迁 Family 当前只做机械 Map
包装，风险受限但边界仍不理想。descriptor-only current/decode 落地后必须删除该组装点，才算完全消除这最后一个
family-wide failure surface。

`preparePricingGeneration()` 也不得在函数外层取得一个覆盖整代的 foreground lease。上面的
`runBoundedPerInstance()` / `runCurrentStateLanes()` 必须把每个声明式 program 投递给 §4.3 的中央 scheduler；
只有实际物理 read/batch 占 transport permit。等待 sibling、计算 descriptor、decode、catch-up 下一块和 publication
都不占 permit。这样 coarse catch-up 可以持续逐块生产，又不会饿死 discovery background backfill。

### 11.4 Carry 兼容性

`snapshotCompatibilityProjection()` 回答：Graph route 变化后，旧 snapshot 是否仍能为新 route 派生 mid。

- UniV2 reserves 与方向集合无关；新增反向 route 可复用 snapshot 并重派生 mid。
- UniV3/UniV4 的 precision witness 与方向相关；新增方向通常需要 direct/dependent read。
- score/order 不进入 static binding 或 snapshot compatibility。
- PoolKey、fee/tick、factory binding 是否触发 descriptor 重编由 Family projection 决定。

冻结 ds 已经提供 `snapshotCompatibilityFingerprint(edges)` 扩展点，但上述五个 migrated Family 当前没有自定义
该 projection，因而使用包含 edge direction 的保守 `stateSchemaFingerprint(edges)` 缺省值。所以上面的 UniV2
方向复用是终态可安全收紧的 Family 语义，不应误记为当前已经启用；迁移时必须先用方向新增 fixture 证明再放宽。

Adapter 只表达兼容语义；中央验证 mutation completeness、source hash、generation 和 cache fingerprint 后才允许 carry。

**2026-08-11 StateInstance mutation/carry proof checkpoint（实现 commit
`642373c1959b41efa7e77659043fac9d71f1e1b5`，shadow contract，不是 production cutover）：**
中央 `prepareAdapterFamilyCatalogPublication` 的 value seal 校验从顶层 `Object.isFrozen`
强化为递归深冻结：

- 每个可达对象（含不可枚举属性）都必须已冻结；`Map`/`Set`/`Date`/`ArrayBuffer`/
  `TypedArray`/`DataView` 等内部槽不受 `Object.freeze` 保护的容器一律 fail-closed；
- 环状冻结对象经 `WeakSet` 防循环后合法接受；
- seal 与 carry 两条路径共用同一深冻结 gate，contract 不能靠返回“顶层冻结、嵌套可变”
  的快照绕过 mutation/carry proof。

新增合同 `searcher:adapter-family-state-carry-proof`：seal 拒绝嵌套可变值；carry 拒绝
浅冻结 clone，且失败后 previous envelope 结构不变；合法 carry 把 StateInstance 重新绑定到
新 source/generation、previous 保持不可变、staged 输入事后修改不影响已发布值。
证据：`searcher:adapter-family-state-carry-proof` PASS、
`searcher:adapter-family-catalog-publication` PASS、完整 listener build 通过。
该 contract 仍是 shadow 合同：cache fingerprint 绑定、strict pricing production consumer、
Funding/Credit production consumers、默认 authority、sealed parity 与 Phase E
均未因此关闭。

## 12. Exact：拆成 requirements / requests / decode

冻结 ds 当前仍由 `RouteLegAdapter.quoteExact(ctx)` 接收 `ExactQuoteContext.state` 并返回 Promise；pinned reth quote
backend 已把物理 call/simulation batch 放入共享 scheduler 的 `exact` lane，但 Adapter API 本身仍能隐藏读取次数、
caller/source dependency 和内部 retry。终态删除任意 `async quoteExact(ctx)`，统一合同是：

```ts
type LocalExactAttempt<Evidence> =
  | { readonly status: "quoted"; readonly result: ExactQuoteResult<Evidence> }
  | { readonly status: "not-applicable"; readonly reason: string };

type ExactMethod<Descriptor, Route, Evidence> =
  | {
      readonly id: string;
      readonly kind: "local";
      quote(
        input: ExactQuoteInput<Descriptor, Route>,
      ): LocalExactAttempt<Evidence>;
    }
  | {
      readonly id: string;
      readonly kind: "request-program";
      readonly program: RequestProgram<
        ExactQuoteInput<Descriptor, Route>,
        ExactQuoteResult<Evidence>
      >;
    };

export interface ExactQuoteSemantics<Descriptor, Route, Evidence> {
  methods(
    input: ExactQuoteInput<Descriptor, Route>,
  ): readonly ExactMethod<Descriptor, Route, Evidence>[];
  cacheCompatibilityProjection(input: ExactQuoteInput<Descriptor, Route>): CanonicalValue;
}
```

Exact 不是含糊的“可选 local callback 与 remote callback 二选一”。Family 必须声明有序 methods，例如 UniV3 warm local math 后接
pinned QuoterV2；只有 local method 明确返回 `not-applicable` 才能进入下一 method。local bug、decode error、RPC
failure、deadline 或 resource limit 都必须终止为对应 failure/unresolved，不能 fallback 掩盖。method id/order 进入
receipt，并由 exact capability dependency closure 覆盖。

上述 `ExactQuoteInput<Descriptor, Route>` 只存在于当前 `FamilyBox` 的 issuer-private closure 内。中央公开入口只接收
`FamilyRouteRuntimeHandle`；它不能接收 caller 重新提交的 descriptor、route 或 binding fingerprint。issuer 验证 handle
属于当前 catalog/runtime box 后，才把保存的原始 descriptor/route 与中央 source/executor/runtime evidence 绑定成
Family-private quote input。

中央调用：

```ts
async function refineCandidate(
  input: RefineCandidateInput,
): Promise<SealedExactQuoteHandle> {
  const issuedRoute = input.catalog.resolveIssuedRouteHandle(input.routeHandle);
  const family = issuedRoute.family;
  const exact = family.exact;
  const quoteInput = issuedRoute.bindExactInput({
    amountIn: input.amountIn,
    source: input.source,
    executor: input.executor,
    runtimeEvidence: input.runtimeEvidence,
  });

  const cacheKey = exactCacheKey({
    familyRuntimeIdentity: family.runtimeIdentity,
    exactCapabilityHash: family.hashes.exact.contentHash,
    instanceFingerprint: issuedRoute.instanceFingerprint,
    routeBindingFingerprint: issuedRoute.bindingFingerprint,
    amountIn: input.amountIn,
    sourceOrCarryProof: input.sourceOrCarryProof,
    executor: input.executor,
    runtimeEvidenceHashes: input.runtimeEvidence.map((item) => item.evidenceHash),
    compatibility: exact.cacheCompatibilityProjection(quoteInput),
  });
  await input.canonical.verifySourceOrCarryProof({
    source: input.source,
    sourceOrCarryProof: input.sourceOrCarryProof,
  });
  input.generationFence.assertCurrent(input.generation);
  const cached = input.exactCache.getCompatible(cacheKey);
  if (cached) {
    const replayed = family.replayAndVerifyCachedExactEvidence(cached, {
      routeHandle: input.routeHandle,
      sourceOrCarryProof: input.sourceOrCarryProof,
      executor: input.executor,
      runtimeEvidence: input.runtimeEvidence,
    });
    input.generationFence.assertCurrent(input.generation);
    // Cache 只保存可重新验证的可信结果/transport evidence；命中也必须
    // 由当前 FamilyBox 为当前 route/source/generation 重新签发 handle。
    return family.issueExactQuoteHandle({
      routeHandle: input.routeHandle,
      result: replayed,
      amountIn: input.amountIn,
      sourceOrCarryProof: input.sourceOrCarryProof,
      executor: input.executor,
      runtimeEvidence: input.runtimeEvidence,
    });
  }

  let result: ExactQuoteResult<unknown> | null = null;
  for (const method of exact.methods(quoteInput)) {
    if (method.kind === "local") {
      const attempt = method.quote(quoteInput);
      if (attempt.status === "not-applicable") continue;
      result = attempt.result;
      break;
    }
    result = (await executeAdapterWork({
      intent: {
        stage: "exact-refine",
        workClass: "foreground",
        familyId: family.manifest.familyId,
        instanceKey: issuedRoute.instanceKey,
        routeKey: issuedRoute.routeKey,
        source: input.source,
        generation: input.generation,
        program: method.program,
        programInput: quoteInput,
      },
      runtime: input.adapterRuntime,
    })).evidence;
    break;
  }
  if (result === null) throw new Error("no exact method applies");

  await input.canonical.verifySourceOrCarryProof({
    source: input.source,
    sourceOrCarryProof: input.sourceOrCarryProof,
  });
  input.generationFence.assertCurrent(input.generation);
  const exactHandle = family.issueExactQuoteHandle({
    routeHandle: input.routeHandle,
    result,
    amountIn: input.amountIn,
    sourceOrCarryProof: input.sourceOrCarryProof,
    executor: input.executor,
    runtimeEvidence: input.runtimeEvidence,
  });
  input.exactCache.publishAtomically(
    cacheKey,
    family.sealReplayableExactCacheRecord({
      routeHandle: input.routeHandle,
      result,
      sourceOrCarryProof: input.sourceOrCarryProof,
      executor: input.executor,
      runtimeEvidence: input.runtimeEvidence,
    }),
  );
  return exactHandle;
}
```

`verifySourceOrCarryProof()`、generation fence 与 `publishAtomically()` 是 cache 合同的一部分，不是示例中的可选
日志。request-program path 内部的 fence 不能替代这里的发布 gate：local method 和 cache hit 同样必须受当前 canonical
source/carry proof 约束，late/foreign result 不能进入 exact cache 或作为 refined leg 返回。

内存 exact cache 必须按当前 `FamilyBox.runtimeIdentity` 分片；capability hash 相同也不能把旧 runtime box 签发的
process-local opaque evidence 交给热替换后的新 box 解包。cache hit 也必须重放当前 request-program declaration、重新
验证可信结果与 source/generation，再由当前 issuer 签发一个新 handle；cache 本身不能把旧 handle 当作值返回。
persistent cache 只能保存能在新 box 下重新验证或重建的 sealed representation，不能持久化裸 opaque handle。

成功结果必须由同一个 issuer 签发不可伪造的 `SealedExactQuoteHandle`，至少绑定
`FamilyBox.runtimeIdentity + FamilyRouteRuntimeHandle + amountIn + source/carry proof + executor + runtime evidence +
exact capability/method`。issuer-private payload 保存原始 exact evidence 与 raw `quotedAmountOut`；公开 projection 只提供
中央 amount propagation/telemetry 所需的 amount 和 identity。结构相似的 `ResolvedFamilyExactQuote`、旧 FamilyBox
签发的 handle、或绑定另一个 route/source/executor 的 handle都不能进入 execution。

amount propagation 必须逐 leg 保留该 handle，而不是只留下 `bigint[]`。下一 leg 的 `amountIn` 来自前一 leg handle 的
raw `quotedAmountOut`；中央 safety policy 另算 `minAmountOut`。S4 execution 由 issuer 解包同一个 handle 内的 stored
descriptor/route/evidence，因此 exact→execution 不存在调用者重新拼装证据的缝隙。

完整 exact quote 只进入 exact cache；它绑定 amount、route/instance binding、exact capability、source/carry proof、
executor 与 runtime evidence，不能直接或通过 `amountOut / amountIn` 的 scalar 降格写入 coarse snapshot/recovery base。

冻结 ds 的 `adoptExactProbeMids()` 虽然检查 newer publication、edge/stateKey/Family 和有限正值，但写入值仍来自特定
amount 的 exact quote，且 recovery base 没有完整绑定 caller/hook/tx evidence 与 capability closure，因此不是终态
安全边界，必须删除。若将来确需 quote-derived coarse feedback，应新增独立 `CoarseMidFeedback` capability/overlay：
显式绑定 source hash、instance/route binding、pricing 与 exact capability、兼容策略和 receipt；actor/hook/tx-bound
evidence 禁止反馈；overlay 不得伪造原 coarse snapshot freshness，并在 mutation/topology/capability 变化时失效。

## 13. 承载和调度特殊语义的通用插槽

特殊协议不是给中央增加 `if (univ4)`，而是给中央增加可复用的**调度类别**，Family 再填入协议 payload。

冻结 ds 已经有若干正确但分散的 typed carrier，例如 `PendingExecutionEvidence` 的 tx/head binding、
`routeActivationScope`、V4 `poolId/v4PoolKey`、caller-sensitive exact context、oracle victim、prepared quote 和
effect simulation transport；唯一 registry 也会检查部分 ownership。终态 `RuntimeRequirement` 不是把这些降成
`Record<string, unknown>`，而是把跨 Family 都需要中央调度的维度统一命名，并把协议 ABI payload 留在 sealed
Family closure。迁移时先做旧字段→通用 slot 的无损映射，最后删除旧平行字段；不能永久双写两套语义。

```ts
type RuntimeRequirement =
  | {
      readonly kind: "source-state";
      readonly freshness: "pinned-block" | "current-head" | "tx-bound";
    }
  | {
      readonly kind: "execution-actor";
      readonly role: "executor" | "observed-sender" | "verified-actor";
    }
  | {
      readonly kind: "head-evidence";
      readonly scope: "family" | "instance";
      readonly evidenceKind: string;
    }
  | {
      readonly kind: "quote-completion";
      readonly mode: "return-data" | "return-or-revert-data" | "effect-delta";
    }
  | {
      readonly kind: "effect-observation";
      readonly effects: readonly (
        | "token-delta"
        | "native-delta"
        | "total-supply-delta"
        | "logs"
        | "trace"
      )[];
    }
  | {
      readonly kind: "extension-policy";
      readonly mode:
        | "proven-transparent"
        | "quote-and-final-sim"
        | "tx-bound"
        | "simulation-only";
      readonly extensionBinding: string;
    }
  | {
      readonly kind: "oracle-state";
      readonly oracleBinding: string;
      readonly maxSourceLagBlocks: number;
    }
  | {
      readonly kind: "opaque-payload";
      readonly slot: string;
      readonly evidenceKind: string;
    };

interface RuntimeEvidence {
  readonly evidenceId: string;
  readonly familyId: FamilyId;
  readonly instanceKey?: InstanceKey;
  readonly kind: string;
  readonly scope: "source-block" | "head" | "transaction";
  readonly source: CanonicalSource;
  readonly txHash?: string;
  readonly evidenceHash: string;
  readonly sealedPayloadRef: string;
}
```

中央只理解 freshness、actor、transport completion、effect observation、evidence scope 和 extension policy；
Family closure 解释 `sealedPayloadRef` 的 ABI 内容。

|协议差异|放入的通用插槽|中央如何调度|
|---|---|---|
|UniV4 hook|Instance/RouteBinding + `extension-policy` + 可选 `opaque-payload:hookData`|未知 swap-affecting hook 拒绝；已证明策略走 exact + final sim|
|Angstrom|`head-evidence`、`tx-bound`、`opaque-payload:unlockData`|只允许相同 canonical head/instance 的 evidence 激活 route|
|Ekubo config/extension|完整 PoolKey RouteBinding + `extension-policy`|config 参与 instance identity；未知 extension 不按 base pool 执行|
|Balancer hook/sender/userData|`execution-actor` + `opaque-payload:userData` + extension policy|中央绑定真实 executor/sender，Family 编码 bytes|
|Fluid revert quote|`quote-completion:return-or-revert-data`|transport 把合约约定的 revert bytes 交给 decoder，不把它当 RPC failure|
|self-burn native|`effect-observation`|中央模拟并返回 token/native/supply delta；Family 验证因果关系|
|Metronome oracle|`oracle-state` + optional oracle victim|中央保证 source freshness，Family 解码 oracle/route 语义|
|Curve variants|custom route projection + typed RouteBinding|Family 解释 i/j/underlying；中央仍只枚举通用 route|
|DODO actor-sensitive quote|`execution-actor:verified-actor`|quote request 的 `from` 绑定验证过的 actor，不能用任意默认 caller|
|Astra 多 token|`all-directed-pairs` + registry-derived binding|统一投影所有 verified pair，不把一个合约误当一个 token pair|
|ERC4626 Silo payout|独立 behavior Family/Lineage|非标准 payout 不污染标准 ERC4626 descriptor|

一个新协议需要中央理解的新东西时，先判断它是否能归入上述通用类别。只有多个 Family 都可能复用、且中央
必须据此安排 transport/budget/freshness 的语义，才扩展 `RuntimeRequirement`。纯 ABI 字段留在 Family binding。

## 14. Execution 与 ActionAdapter

冻结 ds 已经把 ActionAdapter ownership、shared infra、descriptor edge kind 和 resolved-plan identity 纳入 registry/
loader conformance；这些直接复用。仍需收紧的是 `buildPlanFragment(ctx): Promise<PlanFragment>`：其 context 带
`StateBackend`，类型上仍允许计划阶段再读链。终态函数必须只消费 exact/runtime sealed evidence 并同步构造 fragment。

```ts
export interface ExecutionSemantics<Descriptor, Route, ExactEvidence> {
  buildFragment(input: {
    readonly descriptor: Descriptor;
    readonly route: Route;
    readonly amountIn: bigint;
    readonly quotedAmountOut: bigint;
    /** slippage/protection policy 由中央 planner/solver 冻结，Family 只能编码。 */
    readonly minAmountOut: bigint;
    readonly exactEvidence: ExactEvidence;
    readonly executor: string;
    readonly runtimeEvidence: readonly RuntimeEvidence[];
  }): PlanFragment;

  /** Family 声明效果语义；中央 final sim 计算并验证实际效果。 */
  expectedEffects(input: ExecutionEffectInput<Descriptor, Route>):
    readonly ExpectedEffect[];
}
```

这个泛型接口是 FamilyBox 内部 closure 的类型，不是中央可直接调用的公共 DTO API。中央不得自己填充
`descriptor/route/exactEvidence`；只有 exact issuer 能从 `SealedExactQuoteHandle` 的 private record 取回这些原始值，
再调用该 closure。

`buildFragment()` 必须同步、纯函数，只生成：

- approve/transfer 等通用 requirements；
- family-owned route-root ActionAdapter 节点；
- family-specific calldata 参数和 evidence ref；
- 可供中央守恒检查的 expected effects。

`quotedAmountOut` 是 exact 事实，`minAmountOut` 是中央 planner/policy 的保护值，二者不能复用一个模糊
`amountOut` 字段。Family 不拥有 slippage policy，也不能在 calldata builder 内偷偷放宽保护值。

ActionAdapter 只负责低层编码/解码，不负责 discovery、identity、quote、solver 或 final sim。Route-root action
必须由唯一 Family own；approve/transfer/assert-balance 一类经过中央声明的基础动作才可作为 shared infra。

中央调用上下文：

```ts
function buildCandidatePlan(input: BuildCandidatePlanInput): CandidatePlan {
  const fragments = input.refinedRoute.legs.map((leg) => {
    const issuedExact = input.catalog.resolveIssuedExactQuoteHandle(
      leg.exactHandle,
    );
    // resolveIssuedExactQuoteHandle() 返回关闭泛型后的 issuer facade，
    // 不向中央暴露原始 descriptor/route/evidence。
    const fragment = issuedExact.buildFragment({
      minAmountOut: leg.minAmountOut,
      executor: input.executor,
    });
    input.actionOwnership.assertFragmentOwned(
      issuedExact.familyRuntimeIdentity,
      fragment,
    );
    return fragment;
  });

  return input.solver.assembleAndSize(fragments);
}
```

之后的 fork final simulation、flash repayment、token conservation 和 EV 判定完全由中央执行。

Family 迁移后若仍需要 plan-time I/O，说明所需事实没有在 identity/pricing/exact/runtime-evidence 阶段声明完整；
应补 request program，而不是保留一个“临时 async plan callback”。所有 Family 迁完后删除旧
`PlanBuildContext.state` 与 Promise 签名。

## 15. Domain Policy：公共 Core，Swap/Protocol 两个严格模板

两类 Family 共用 Discovery、Identity、Instance、Route、Pricing、Exact 和 Execution Core；作者实际填写的生产
入口则只能是 `SwapFamilyPlugin` 或 `ProtocolFamilyPlugin`。差异由下面的 Domain Policy 表达，不能通过空实现、
类型断言或同时填写两个 Domain 绕过：

```ts
interface SwapDomainSemantics {
  readonly landedEvents: LandedEventSpec;
  readonly observation: SwapObservationSpec;
  readonly victimSupport: "none" | "detect-only" | "local-apply" | "overlay";
  readonly poolMaterialization?: PoolMaterializationSpec;
  readonly localApply?: LocalVictimApplySpec;
  readonly overlay?: VictimOverlaySpec;
}

interface ProtocolDomainSemantics {
  readonly candidateKinds: readonly (
    | "observed-call"
    | "address-surface"
    | "factory-child"
    | "registry-member"
    | "standalone-contract"
  )[];
  readonly activeBehaviorProof: "required";
  readonly oracleVictim?: OracleVictimSpec;
}
```

Funding/Credit 不应为了复用 route 模板而伪装成普通 Swap/Protocol。它们使用独立 Domain Plugin 合同，复用
catalog、request executor、evidence、ownership 和 final safety primitives，但保留 position/repayment/risk 语义。

冻结 ds 的 `AdapterFamily` 还包含 `flash-loan`、`credit`、`liquidity`，而 Protocol 名为
`protocol-conversion`。本 S1 重构只把 route-producing Swap/Protocol 收进两个严格入口；flash/funding、credit、
liquidity 必须在同一 catalog 中使用各自判别类型，不能为了清空 legacy 数组被强转为 Swap/Protocol。终态 catalog
可以是 `DefinedSwapFamily | DefinedProtocolFamily | DefinedFundingFamily | ...`，但本文件要求的两个“大模板”仍只
指 Swap 与 Protocol，不代表所有 Domain 共用同一 optional object。

### 15.1 Funding：offer 必须是 issuer-bound authority

Funding 不进入普通 swap/protocol Graph，但它的 liquidity evidence、borrow fragment 和 repayment fragment 仍必须
遵守同一 opaque issuer 边界。publication 可以暴露供中央 sizing 使用的只读投影，例如 funding ID、asset、
`maxBorrow`、fee 和 priority；**可执行 authority 只能是 `PreparedFundingOfferHandle`**：

```ts
declare const preparedFundingOfferHandleBrand: unique symbol;

interface PreparedFundingOfferHandle {
  readonly [preparedFundingOfferHandleBrand]: void;
  readonly familyRuntimeIdentity: object;
  readonly familyId: FamilyId;
  readonly fundingId: string;
  readonly asset: string;
  readonly maxBorrow: bigint;
  readonly fee: bigint;
  readonly source: CanonicalSource;
  readonly generation: number;
  readonly fundingCapabilityHash: string;
}
```

issuer-private WeakMap 必须保存当前 catalog 签发的 loaded `FamilyBox`、原始 `FundingOfferDescriptor`、transport/static
evidence、source/generation 和 capability identity。`buildBorrowFragment()` / `buildRepaymentFragment()` 只接受该
handle，并在进入 Family callback 前同时执行 loaded-box authority 与 offer issuer authority 校验。冻结对象、对象字段
相同或 capability hash 相同都不是 authority：spread/clone、same-field/same-hash forge、foreign catalog box、
hot-reload-old box、wrong source/generation/capability 或已失效 publication 的 handle 必须 fail closed。

Funding publication 只有在 canonical source 与 generation fence 通过后才能原子替换；失败/无 offer 必须有显式
outcome，不能用 `publication=null` 隐式沿用旧 offer。当前实施 checkpoint 已有 Funding Request Program、opaque
offer issuer、fragment ownership/TOCTOU 负向门，以及“成功但无 offer 发布空 tombstone、读取/解码失败不覆盖
current”的 unit contract；它们仍是 shadow runtime。全 catalog publication receipt 与真实 production consumer 尚未
接线，因此不能把它记成 production cutover。

### 15.2 Credit：route、risk 与 execution 使用同一 issuer closure

Credit 不能只在 catalog 中拥有一个 plugin 定义，然后继续让 solver 查询 legacy registry。终态需要独立中央
Credit runtime，并签发同一 runtime box 约束下的：

- `CreditRouteRuntimeHandle`：绑定 credit instance、asset/direction、source/generation 与 capability；
- `CreditRiskEvidenceHandle`：绑定 borrow limit、repayment/position 约束及其可信 evidence；
- `CreditExecutionHandle`：绑定选中的 route、risk evidence、amount 与 owned ActionAdapter closure。

会产生 lend/credit route 的 Family 必须通过公共 `projectGraph()` 形成 canonical edge，并与其 route-handle index、
pricing/risk evidence 一起进入全 catalog publication CAS；不能在 common Graph 发布后再由 solver 临时查询另一份
Credit registry 补边。不会产生 Graph route 的 Credit capability 也必须通过同一 catalog/runtime box 和 final safety
primitive，不能获得 raw RPC、planner 或 final-sim authority。

当前实施 checkpoint 已有 shadow central Credit identity/instance lifecycle、lifecycle-issued exact instance authority、
route/risk issuer handle、common-Graph projection 与同步 execution closure；raw descriptor、spread/clone、同字段伪造、
foreign/hot-reload FamilyBox、wrong source/generation/executor/evidence 均有 callback-before-rejection unit gate。但独立
`CreditExecutionHandle`、全 catalog route/Graph/risk 同 CAS、production solver consumer、repayment/position final sim 与
sealed parity 仍未落地，production solver 也仍有 legacy Credit authority。因此这些实现只能算 contract/shadow
evidence，不能据此切换 authority。

**2026-08-11 Credit 独立 execution handle checkpoint（实现 commit
`9d954df4eed440994384630c8f23f37c6f9aa5df`，shadow contract，不是 production cutover）：**
新增 issuer-private `SealedCreditExecutionHandle`（`issueCreditExecutionHandle`），一次签发即绑定
选中 route、sealed risk quote、`minAmountOut`、executor、sealed runtime evidence 与
source/generation；`buildCreditExecutionFragment` 现在只接受该 handle，不再接收 raw
route/risk/evidence/descriptor。合同覆盖：

- handle 冻结且不暴露 raw evidence/descriptor/runtime evidence；
- forged、foreign/hot-reload FamilyBox、same-field clone 全部在进入 Family callback 前
  fail closed；
- 签发期拒绝 executor/evidence/`minAmountOut`/source/generation 错绑。

证据：`searcher:adapter-credit-runtime` PASS、完整 listener build 通过。全 catalog
route/Graph/risk 同 CAS、production solver consumer、repayment/position final sim 与
sealed parity 仍未落地。

## 16. UniV3 完整实现示例

下面是**终态插件示例**，不是冻结 ds 的 `univ3-standard.ts` 原样摘录。当前 UniV3 已完成 pricing
`state-instance-v1`、单 pool static binding hydration、parity 与增量隔离，但 discovery/route/exact/execution 仍通过
旧 `SwapAdapter` 形态接线。示例展示迁移完成后的关键上下文，省略 ABI helper 具体编码，但不省略调用链。

```ts
export const uniV3Family = defineSwapFamily({
  manifest: {
    familyId: familyId("swap:univ3-standard"),
    domain: "swap",
    supportedLineages: [lineageId("univ3:factory-child")],
    ownedActionAdapterIds: ["univ3-exact-input-single"],
    requiredInfraActionAdapterIds: ["erc20-approve"],
    allowedTaxonomy: [{ slotKind: "swap" }],
  },

  discovery: {
    sources: ["factory-log", "landed-log", "observed-call"],
    logPatterns: [
      logPattern("PoolCreated(address,address,uint24,int24,address)"),
      logPattern("Swap(address,address,int256,int256,uint160,uint128,int24)"),
    ],
    callPatterns: [callPattern("swap(address,bool,int256,uint160,bytes)")],
    decodeCandidate({ observation, matchedPatternId }) {
      return decodeUniV3Candidate(observation, matchedPatternId);
    },
    candidateKey: (candidate) => canonicalAddress(candidate.pool),
  },

  identity: {
    variants: [{
      id: "factory-child",
      kind: "factory-child",
      applies: () => true,
      requirements: () => ({ transports: ["eth-call", "get-code"] }),
      buildRequests({ candidate, step, evidence }) {
        if (step === 0) {
          return [
            call(candidate.pool, "factory()"),
            call(candidate.pool, "token0()"),
            call(candidate.pool, "token1()"),
            call(candidate.pool, "fee()"),
            call(candidate.pool, "tickSpacing()"),
          ];
        }
        const facts = requireUniV3PoolFacts(evidence);
        return [call(
          facts.factory,
          "getPool(address,address,uint24)",
          [facts.token0, facts.token1, facts.fee],
        )];
      },
      decode({ step, results }) {
        return step.step === 0
          ? decodeUniV3PoolFacts(results)
          : decodeUniV3ReverseBinding(step.evidence, results);
      },
      decide({ candidate, step, evidence }) {
        if (step === 0 && evidence === undefined) {
          return { status: "continue" };
        }
        if (!hasReverseBinding(evidence)) {
          return { status: "continue" };
        }
        if (!sameAddress(evidence.reversePool, candidate.pool)) {
          return { status: "rejected", reason: "factory_reverse_binding_failed" };
        }
        return {
          status: "verified",
          identity: {
            familyId: familyId("swap:univ3-standard"),
            lineageId: lineageId("univ3:factory-child"),
            subject: canonicalAddress(candidate.pool),
            facts: evidence,
            provenance: [{ kind: "factory", address: evidence.factory }],
          },
        };
      },
    }],
    identityKey: (identity) => identity.subject,
  },

  instance: {
    instanceKey: (identity) => instanceKey(identity.subject),
    compileDraft(identity) {
      return {
        pool: identity.subject,
        token0: identity.facts.token0,
        token1: identity.facts.token1,
        fee: identity.facts.fee,
        tickSpacing: identity.facts.tickSpacing,
        factoryBinding: {
          factory: identity.facts.factory,
          reversePool: identity.facts.reversePool,
        },
        precisionQuoterBinding: chooseVerifiedQuoterBinding(identity.facts),
      };
    },
    finalizeDescriptor({ identity, draft }) {
      return Object.freeze({
        familyId: identity.familyId,
        lineageId: identity.lineageId,
        instanceKey: instanceKey(identity.subject),
        ...draft,
        provenance: identity.provenance,
        runtimeRequirements: [],
      });
    },
    staticBindingProjection(descriptor) {
      return {
        pool: descriptor.pool,
        token0: descriptor.token0,
        token1: descriptor.token1,
        fee: descriptor.fee,
        tickSpacing: descriptor.tickSpacing,
        factoryBinding: descriptor.factoryBinding,
        precisionQuoterBinding: descriptor.precisionQuoterBinding,
      };
    },
  },

  routes: {
    project({ descriptor }) {
      return [
        uniV3Route(descriptor, descriptor.token0, descriptor.token1),
        uniV3Route(descriptor, descriptor.token1, descriptor.token0),
      ];
    },
  },

  pricing: {
    stateKey: (route) => route.instanceKey,
    staticBindingProjection: ({ descriptor }) =>
      uniV3StaticProjection(descriptor),
    snapshotCompatibilityProjection: ({ descriptor, routes }) => ({
      pool: descriptor.pool,
      fee: descriptor.fee,
      directions: routes.map((route) => [route.tokenIn, route.tokenOut]).sort(),
    }),
    compileDraft: ({ descriptor }) => descriptor,
    finalizePricingDescriptor: ({ draft }) => draft,
    current: {
      requirements: () => ({ transports: ["eth-call"] }),
      buildRequests({ descriptor, source }) {
        return [
          pinnedCall(source, descriptor.pool, "slot0()"),
          pinnedCall(source, descriptor.pool, "liquidity()"),
        ];
      },
      buildDependentProgram({ current, completedRound, initialResults }) {
        if (completedRound > 0) return null;
        const state = decodeUniV3CoreState(initialResults);
        return {
          requirements: { transports: ["eth-call"], caller: "executor" },
          requests: current.routes.flatMap((route) =>
            buildUniV3PrecisionRequest(current.descriptor, route, state)
          ),
          decode: decodeUniV3PrecisionEvidence,
        };
      },
      decodeSnapshot: ({ descriptor, initialResults, dependentEvidence }) =>
        decodeUniV3Snapshot(descriptor, initialResults, dependentEvidence),
      deriveMids: ({ descriptor, snapshot, routes }) =>
        deriveUniV3Mids(descriptor, snapshot, routes),
      classifyUnavailable: ({ snapshot, routes }) =>
        classifyUniV3Unavailable(snapshot, routes),
    },
    dependencies: ({ descriptor }) => [
      descriptor.pool,
      descriptor.factoryBinding.factory,
      descriptor.precisionQuoterBinding.quoter,
    ],
    mutation: uniV3MutationSemantics,
  },

  exact: {
    methods(input) {
      return [
        {
          id: "warm-local-math",
          kind: "local",
          quote: (quoteInput) => quoteUniV3WarmLocal(quoteInput),
        },
        {
          id: "pinned-quoter-v2",
          kind: "request-program",
          program: {
            requirements: () => ({ transports: ["eth-call"], caller: "executor" }),
            buildRequests(quoteInput) {
              return [buildUniV3QuoterRequest({
                quoter: quoteInput.descriptor.precisionQuoterBinding.quoter,
                tokenIn: quoteInput.route.tokenIn,
                tokenOut: quoteInput.route.tokenOut,
                fee: quoteInput.descriptor.fee,
                amountIn: quoteInput.amountIn,
                caller: { kind: "executor" },
              })];
            },
            decode: ({ programInput, results }) =>
              decodeUniV3ExactQuote(programInput, results),
          },
        },
      ];
    },
    cacheCompatibilityProjection: ({ descriptor, route }) => ({
      pool: descriptor.pool,
      direction: [route.tokenIn, route.tokenOut],
      fee: descriptor.fee,
      quoter: descriptor.precisionQuoterBinding,
    }),
  },

  execution: {
    buildFragment(input) {
      return buildUniV3PlanFragment({
        pool: input.descriptor.pool,
        router: input.descriptor.precisionQuoterBinding.router,
        tokenIn: input.route.tokenIn,
        tokenOut: input.route.tokenOut,
        fee: input.descriptor.fee,
        amountIn: input.amountIn,
        minAmountOut: input.minAmountOut,
        recipient: input.executor,
      });
    },
    expectedEffects: uniV3ExpectedEffects,
  },

  swap: uniV3SwapDomainSemantics,
  actionAdapters: [uniV3ExactInputSingleAction],
});
```

这里的 Factory 地址只保存在 provenance/binding；准入凭据是
`factory.getPool(token0, token1, fee) === pool`。中央无需知道 UniV3，也不会按 Factory 地址排名 Family。

## 17. ERC4626 多来源、单标准行为示例

这是**终态 Protocol 插件示例**。冻结 ds 的 ERC4626 仍是 legacy production Family，discovery resolver/probe
已经证明多来源和行为差异，但尚未迁入严格模板或 descriptor-only pricing。ERC4626 没有统一 Factory，因此候选
来源和标准行为证明必须分离：

```ts
const erc4626IdentityVariants = [
  candidateVariant("factory-child", "factory-child"),
  candidateVariant("registry-member", "registry-member"),
  candidateVariant("standalone-contract", "standalone-contract"),
].map((variant) => withCommonErc4626BehaviorProof(variant, {
  requirements: {
    transports: ["get-code", "eth-call", "state-override-simulation"],
    effects: ["token-delta", "logs"],
  },
  buildRequests(candidate) {
    return [
      getCode(candidate.vault),
      call(candidate.vault, "asset()"),
      call(candidate.vault, "totalAssets()"),
      call(candidate.vault, "totalSupply()"),
      call(candidate.vault, "convertToShares(uint256)", [candidate.sampleAssets]),
      call(candidate.vault, "convertToAssets(uint256)", [candidate.sampleShares]),
      call(candidate.vault, "previewDeposit(uint256)", [candidate.sampleAssets]),
      call(candidate.vault, "previewRedeem(uint256)", [candidate.sampleShares]),
      simulateDeposit(candidate),
      simulateRedeem(candidate),
    ];
  },
  decode: decodeErc4626BehaviorEvidence,
  verify(evidence) {
    return {
      asset: verifyAssetRelation(evidence),
      verifiedDirections: {
        deposit: verifyStandardDeposit(evidence),
        redeem: verifyStandardAssetPayout(evidence),
      },
    };
  },
}));
```

三类来源归一化到同一 descriptor：

```ts
interface Erc4626Descriptor extends CompiledInstanceDescriptor {
  readonly vault: string;
  readonly asset: string;
  readonly share: string; // 标准 ERC4626 为 vault 本身
  readonly verifiedDirections: {
    readonly deposit: boolean;
    readonly redeem: boolean;
  };
}

const erc4626Instance: InstanceSemantics<Erc4626Identity, Erc4626Descriptor> = {
  instanceKey: (identity) => instanceKey(identity.vault),
  compileDraft(identity) {
    return {
      vault: identity.vault,
      asset: identity.asset,
      share: identity.vault,
      verifiedDirections: identity.verifiedDirections,
    };
  },
  finalizeDescriptor({ identity, draft }) {
    return {
      familyId: familyId("protocol:erc4626-standard"),
      lineageId: identity.lineageId,
      instanceKey: instanceKey(identity.vault),
      provenance: identity.provenance,
      runtimeRequirements: [],
      ...draft,
    };
  },
  staticBindingProjection: (descriptor) => ({
    vault: descriptor.vault,
    asset: descriptor.asset,
    share: descriptor.share,
    verifiedDirections: descriptor.verifiedDirections,
  }),
};

const erc4626Routes: RouteProjectionSemantics<Erc4626Descriptor, Erc4626Route> = {
  project({ descriptor }) {
    const routes: Erc4626Route[] = [];
    if (descriptor.verifiedDirections.deposit) {
      routes.push(depositRoute(descriptor.asset, descriptor.share));
    }
    if (descriptor.verifiedDirections.redeem) {
      routes.push(redeemRoute(descriptor.share, descriptor.asset));
    }
    return routes;
  },
};
```

完整生产 export 通过 Protocol 唯一入口把上述强类型部件组装起来；没有 Factory 的实例不需要另一套模板，只需
由 `identity.variants` 声明不同 provenance：

```ts
export const erc4626Family = defineProtocolFamily({
  manifest: {
    familyId: familyId("protocol:erc4626-standard"),
    domain: "protocol",
    supportedLineages: [
      lineageId("erc4626:factory-child"),
      lineageId("erc4626:registry-member"),
      lineageId("erc4626:standalone-contract"),
    ],
    ownedActionAdapterIds: ["erc4626-deposit", "erc4626-redeem"],
    requiredInfraActionAdapterIds: ["erc20-approve"],
    allowedTaxonomy: [{ slotKind: "protocol-conversion" }],
  },

  discovery: erc4626Discovery,
  identity: {
    variants: erc4626IdentityVariants,
    identityKey: (identity) => canonicalAddress(identity.vault),
  },
  instance: erc4626Instance,
  routes: erc4626Routes,
  pricing: erc4626Pricing,
  exact: erc4626Exact,
  execution: erc4626Execution,

  protocol: {
    candidateKinds: [
      "factory-child",
      "registry-member",
      "standalone-contract",
    ],
    activeBehaviorProof: "required",
  },
  actionAdapters: [erc4626DepositAction, erc4626RedeemAction],
});
```

Pricing/Exact 对 deposit 调 `previewDeposit(amountIn)`，对 redeem 调 `previewRedeem(amountIn)`；Execution 分别
生成标准 `deposit(assets, receiver)` 和 `redeem(shares, receiver, owner)` ActionAdapter 节点。

如果某实例 `previewRedeem()` 返回“资产数量”，但真实 `redeem()` 支付 Silo share、第三种 payout token 或
需要另一组 accounting/plan 节点，它不能被标记为标准 redeem direction。它应由独立
`protocol:erc4626-silo-redeem` Family 证明 payout token、quote 与 execution。这不是“4626 有无 Factory”的差异，
而是执行语义差异。

## 18. 冻结 ds 基线到目标合同的迁移与删除计划

### 18.1 真实实现映射

|冻结 ds 接口/实现|基线判定|目标位置|迁移动作与终态删除|
|---|---|---|---|
|`LEGACY_PRODUCTION_ADAPTER_FAMILIES`（20）+ scanned modules（2）|双入口迁移态|build-time generated static-import branded module catalog|逐 Family 移入 tracked module；生成并校验静态 catalog；最后删除 legacy 数组、`baseFamilies` loader 参数、raw module contract 和生产 runtime source scan|
|`AdapterFamilyRegistry` 唯一高层 registry|已实现基础|`FamilyCapabilityCatalog` / 唯一 typed registry|保留派生视图和 ownership checks；输入收紧，不建立第二个并行 registry|
|`poolAdapters` / `edgeAdapterIds` / Action ID declarations|显式 ownership 已工作，但有重复声明|route/action ownership projection|从插件 route/action 定义派生；parity 后删除可漂移的重复字段|
|`ProtocolDiscoveryContext.backend` + async candidate callbacks|扫描中央、I/O 边界未收紧|Discovery decode + Identity/behavior Request Program|先由兼容 executor 记录 requests，再纯化 callback；最后删除 backend-bearing context|
|`identityPolicies` / `discoveryIdentityResolver` / `IdentityAuthority`|链上证明基础已存在|`identity.variants`|无损迁移 Factory/Registry/standalone/reverse proof；删除平行 resolver registry，仅保留统一 outcome|
|`probeCandidate()` 直接返回 edges|proof 与 projection 混合|Identity/behavior evidence + instance + `routes.project()`|先 seal descriptor，再纯投影 verified directions；删除 async probe-to-edge path|
|`buildEdges(pool, backend, control)`|胖异步 route API|`routes.project(descriptor)`|去 backend 与二次 identity read；最后删除 `TokenQueryBackend` 参数和旧方法|
|五个 Family 的 `state-instance-v1` + B1–B6 coordinator|已实现、必须复用|终态 per-instance pricing lifecycle|保留 diff/cache/CAS/failure isolation；只替换最外层 capability 调用形态|
|其余 active pricing Family 的 `legacy-family`|迁移桥|同一 descriptor-only pricing path|按严格模板批量迁移，由统一 harness 生成逐 Family 结果行；最后删除 schema mode 与 full-family compiler|
|`compileStateInstance(input.readStatic)`|粒度正确、Adapter 仍主动执行 I/O|draft/static program/finalize|中央先执行 program；删除 `readStatic` callback 与 async compiler|
|`assembleSchema(entries) -> pools/groups Map`|已迁 Family 的机械兼容 facade|descriptor 直接进入 current/decode|先证明 current/decode parity，再删除 facade、family container 和 assembly failure point|
|手工 `adapterSchemaRevision`/compat revision|当前 cache 正确性前提|generated capability hashes|shadow → 新 namespace → 删除手工字段/fallback|
|family-level `FamilySharedBinding`|生命周期/CAS 已实现|按真实依赖可分片 shared bindings|保留机制，补 binding key/ref；删除用 value 承载全族 descriptor 的可能性|
|`RethTransportScheduler` + `LiveRethReadPriority`|lane/reserve 与 request/batch 调度单位已实现，但 hard timeout 可早于底层 fetch/body settlement 释放外层 slot/permit|统一 work-intent scheduler|先修 physical-settlement ownership，再补 stage policy、fairness、dedupe/fence/final-sim pool；不另建 Family scheduler|
|`prepareInstanceFamily()` 的 `instanceSchemas`/spec/shared fingerprint Maps|最终 CAS 前即可写入，且会被下一 generation 当作 published previous|`CompileMemoStore` + `PublishedDescriptorStore`|先拆 store；memo 只内容寻址预热，published previous/carry 只能读取 source verify + generation fence + atomic CAS 后的 store|
|`quoteExact(ctx.state)` + pinned exact lane|transport 部分中央、语义 API 仍胖|Exact requirements/buildRequests/decode|逐 Family 拆 request shape；删除 StateBackend-bearing exact callback|
|`adoptExactProbeMids()`|当前 exact→coarse 写旁路；值未完整绑定 route/caller/hook/runtime evidence，不是安全 publication 边界|中央 exact cache；未来可选、独立的 `CoarseMidFeedback` overlay|删除当前旁路。若以后确需反馈，必须新建完整绑定且独立失效的 capability/overlay，不复用任意 exact scalar|
|`buildPlanFragment(ctx.state): Promise`|ownership 已中央、plan API 仍可读链|纯 `execution.buildFragment()`|前移所有 evidence reads；删除 state 与 Promise 签名|
|`PendingExecutionEvidence`、V4/Angstrom 等 typed fields|正确语义分散在不同 context|`RuntimeEvidence` / `RuntimeRequirement` + opaque payload|无损映射、双写 parity 后删除旧平行字段；中央不增加协议名分支|
|runtime final sim/deadline/fork worker|S5 已中央执行，但未纳入统一资源平面|reserved/independent final-sim pool|接入统一 intent/outcome；保持 mandatory final sim，删除临时旁路调度|

### 18.2 大重构允许的迁移阶段

大重构可以批量实施，但 production truth 在任一时刻仍只有一个。推荐阶段如下：

```text
Phase 0  修复共享 substrate
         ├─ logical timeout 与 physical settlement 分离，未 settle work 不释放容量
         └─ pre-CAS Maps 拆为 CompileMemoStore / PublishedDescriptorStore
        ↓
Phase A  冻结 ds baseline + comparator/oracle receipts
        ↓
Phase B  中央严格类型、Request Program、兼容 executor、generated-hash shadow
        ↓
Phase C  按严格模板批量迁移冻结的 Family cohort
         ├─ 一次统一 harness 自动产出逐 Family 结果矩阵
         ├─ 同一 production generation 只走旧或新路径
         └─ 不为每个已成熟 Family 手写、重复运行一套验收
        ↓
Phase D  只补验矩阵中的非 pass Family + common-Graph/batch cutover gate
        ↓
Phase E  删除所有迁移桥，重新运行终态 catalog/semantic/live gate
```

Phase 0 是后续 parity 的前置条件，不是可以与 Family 迁移混在一起“顺手验证”的优化。否则 hard timeout 下的并发
上限仍可能失真，superseded generation 的 pre-CAS compile 结果也可能污染下一代 previous/carry，使 comparator 把
substrate 泄漏误判为 Family parity。Phase 0 必须先用 §20.4 的定向回归证明，再冻结 Phase A 输入。

Phase D 内部的 production authority cutover 也有固定依赖顺序，不能因为 22 个插件已经能被 catalog 装载就直接
替换旧 registry consumer：

1. 先落地统一 `projectGraph()`、issuer-private route store、`FamilyRouteRuntimeHandle` 和
   `SealedExactQuoteHandle`；
2. 接入 observation shadow ingress，并完成 incumbent bootstrap/re-attestation 与 source watermark；
3. 所有 Family 只产出 staged shard，由唯一全 catalog publication coordinator 形成一次 atomic CAS；
4. 从同一 publication 同时导出当前 `TokenEdge` compatibility view 与
   `CanonicalEdgeId → FamilyRouteRuntimeHandle` index；
5. 复用现有 BlockScan per-StateInstance diff/carry/CAS，把 strict descriptor/snapshot/mid 接到该共同 Graph；
6. 逐 leg 保留 sealed exact handle，完成 amount propagation，再接纯 execution fragment 与 mandatory final sim；
7. 迁移 victim/pending/backrun evidence，随后分别完成不进 Graph 的 Funding 与会产生 lend route 的 Credit；
8. 独立 baseline/challenger capture、batch parity、common-Graph 与 systemic-live gate 通过后，才切默认 authority 并
   删除 legacy registry/API/cache/flag bridge。

任一步只能 shadow/disabled-path 验证时，下一步不得把它描述成 production truth。尤其不能用当前 observation window
重建出的局部 Graph 替换持久化 incumbent，也不能先发布 Graph、后补 route handle/pricing；两者都会制造静默覆盖率
回退或跨代撕裂。

Phase B 可以引入 adapter shim、dual-read cache namespace、legacy oracle 和双写 telemetry；这些代码必须：

- 只在 composition root/framework migration package 中存在，不散落到每个 Family；
- 明确标注被哪个终态接口替代、由哪个 gate 允许删除；
- 不在单实例失败、deadline 或 cache miss 时偷偷切换语义路径；
- 不成为新 Family 可调用的公共 API。

Phase C 默认采用 **batch-first**：先按同一模板完成一个冻结 cohort，再执行一次统一 comparator。逐 Family 的
输入、outcome、parity 和 verdict 是该 batch receipt 自动生成的结果行，不是要求作者为每个 Family 手写一份文档、
启动一套 harness 或重复跑 live A/B。现有 Family 的协议解释、quote 数学和执行语义以冻结 ds production closure
及其既有 fixtures 为 baseline oracle；纯架构迁移只证明这些语义没有在换承载方式时丢失，不从零重审一遍协议。

单 Family 模式保留为**定向补验工具**，只用于 batch 矩阵中的 `semantic-mismatch`、`not-exercised`、
`framework-blocked`、使用特殊语义插槽而公共 corpus 未覆盖的 Family，或真正只改一个 Family 的独立提交。已经由
同一 batch 得到 `pass` 的 Family 不再单独验收。五个已进入 `state-instance-v1` 的 Family 从现有实例语义迁到
descriptor-only；legacy pricing Family 可以直接迁到终态合同，不要求为了形式先经过一版永久的
`state-instance-v1 + assembleSchema`。共享中央缺口单独修复；若修复触及公共执行闭包，则失效受影响的结果行并
重跑相应 batch，不能把 framework diff 假装成某个 Family-local 变化。

### 18.3 强制迁移终态：兼容代码必须消失

Phase E 不是可选清理。只有同时满足以下条件，才可宣称本架构重构完成：

1. production catalog 的全部 active Family 都来自严格构造器；启动输出能列出每个 source module/family/hash，
   且不存在 legacy base input。production composition root 只能加载 build-time generated static imports；runtime
   `git ls-files`/glob/source scan 仅可作为 dev/CI stale-artifact 检查，不能参与生产模块发现或回退。
2. `LEGACY_PRODUCTION_ADAPTER_FAMILIES`、`legacy-family` runtime branch、`compileStaticSchema`、
   `extendStaticSchema`、`assembleSchema/assembleCompiledFamily` 和 per-family full schema cache 已从生产 source
   closure 删除。
3. `RouteLegAdapter.buildEdges(...backend)`、`ProtocolDiscoveryContext.backend`、`quoteExact(ctx.state)`、
   `buildPlanFragment(ctx.state)`、`CompileStateInstanceInput.readStatic` 等旧 I/O 入口已删除；boundary gate 证明
   Family 无 raw RPC/scheduler/cache/final-sim import。
4. 手工 `adapterSchemaRevision`、旧 cache namespace、dual-write/dual-read 与 revision fallback 已删除；只有
   generated capability identities 能创建生产 cache key。
5. `adoptExactProbeMids()` 及任何等价 exact→coarse scalar 写旁路已删除。未来若实现 `CoarseMidFeedback`，它必须
   作为独立 capability/overlay 通过完整 binding、publication 与失效验收，不能作为 cleanup 兼容桥保留。
6. batch migration receipt 的结果矩阵覆盖全部 active Family，且不存在非 `pass` 或缺失结果行；cross-family/
   common-Graph gate、held-out negative fixtures 和默认路径 cutover gate 均通过。不能因为旧代码“暂时没被调用”
   就删除证据，也不能因为保留旧代码“方便回滚”而跳过清理。
7. 删除后重新从 clean process 执行 catalog load、cold/warm semantic parity、单实例失败隔离、六步代表性 corpus
   与所需 live gate；结果不能依赖旧 module、旧 cache 文件或旧 runtime flag。
8. rollback runbook 指向上一已验收 commit/build artifact，并证明能重新部署；源码内不保留双实现作为回滚手段。

历史 baseline 输出、sealed receipts 和 canonical fixtures 可以保留；可执行旧 compiler/Adapter 路径不保留。若某段
兼容代码在 Phase E 仍有调用者，应把重构状态记为 `migration_incomplete`，而不是把它重新命名为长期 abstraction。

迁移始终把 framework slice 与 Family 模板填充解耦，但 Family 证据默认由统一 batch 自动生成，不建立 N 套人工
验收流程。某 Family 无法用标准合同表达时，在结果矩阵中记录确切的通用 framework 缺口；不能在 Family 内私建
scheduler/cache，也不能为了“Family-local”把中央逻辑复制进去。

## 19. 可观测失败：能知道哪个 Family 的哪个 Instance 失败

冻结 ds 的 blockscan `BlockScanStateIssue` 已带 lane/familyId/可选 stateKey，per-family/lane telemetry 也能看到
实例 compile/read/decode 问题；production family loader 另有 sourceFile/code/message issue。Discovery/identity/exact/
execution 则仍使用各自 outcome/error 形态，尚没有一份贯穿全部 Adapter stage 的统一 receipt。下面的
`AdapterInstanceOutcome` 是整合目标，实施时应映射现有机器码并保留原始 evidence refs，不能把不同失败阶段压成
一个新字符串。

每个阶段必须输出机器可读 outcome：

```ts
interface AdapterInstanceOutcome {
  readonly familyId: FamilyId;
  readonly lineageId?: LineageId;
  readonly candidateKey: string;
  readonly instanceKey?: InstanceKey;
  readonly stage:
    | "discovery"
    | "identity"
    | "instance-compile"
    | "route-projection"
    | "pricing-compile"
    | "pricing-current"
    | "exact"
    | "execution";
  readonly status:
    | "candidate"
    | "verified"
    | "rejected"
    | "unsupported-variant"
    | "unresolved"
    | "failed";
  readonly reasonCode: string;
  readonly source: CanonicalSource;
  readonly evidenceRefs: readonly string[];
}
```

这能区分：

- selector 命中但不属于该 Family：`identity/rejected`；
- 实例确实存在，但当前 Family 不能解析该行为：`unsupported-variant`；
- RPC/deadline：`unresolved`；
- descriptor 本身不一致：`instance-compile/failed`；
- 只有某个 direction 未被行为证明：route outcome 拒绝该方向，健康方向仍发布。

Outcome 必须带 `familyId + candidateKey`，通过身份后再带 `lineageId + instanceKey`。一个实例失败不能把整个
Family 的 outcome 合并成单一 `family_failed`。

## 20. 可落地但不机械的验收合同

验收判断语义结果，不以固定 Family 数、文件数、LOC、类名或临时命令名代替正确性。正式 verdict 仍由
[`gates.md`](../gates.md) 与
[`templates/six-step-validation.md`](../templates/six-step-validation.md) 定义；本节把新增或迁移 Family 时
真正需要执行和观察的内容直接写进目标架构，不再依赖旧 Adapter 六步文档。

本重构的 baseline 必须是本文冻结的 ds production closure（或实施开始时经漂移审计后重新冻结的更新 ds tip），
不是 `main`。已有 StateInstance parity/incremental tests 是可复用的底层证据，但不能单独替代整个
Discovery→Graph→Exact→Execution semantic comparator。

### 20.1 先选择声明，不让一种 replay 冒充另一种证据

|验收轨道|能证明什么|决定性证据|明确不能证明|
|---|---|---|---|
|`architecture_migration_parity`|同一 Adapter 语义从旧机制批量迁入新模板后没有语义回退|一次冻结 cohort 的旧/新 production closure 双跑；自动生成逐 Family canonical instance/edge/state/priced/price/failure 结果矩阵；共同 Graph 的 enumeration/exact/execution 代表性证明；只对非 `pass` 行定向补验|不单独证明 live p95、资源公平性、默认生产切换、某个历史盈利机会或未声明的新 coverage 正确|
|`family_execution`|Family-owned capability 在 fixture 下正确，尤其是 quote/plan/encoding，且 family-owned diff 可合并|identity/probe conformance fixture；同一 route fixture 的稳定 baseline 未注册或 typed family failure → challenger Adapter Replay pass；Steps 3–6、ownership、conformance、`family_local` 全通过|Adapter Replay 本身不证明自然 discovery、自然排名、生产时效性、部署或 branch cleanup|
|`production_route_stage`|某个历史生产 route gap 已被生产 funnel 自然关闭|target-blind producer 不接收预期 route/amount；同一 causal chain 的 Steps 1–6 全通过|全系统 latency、资源公平性、长期 coverage|
|`systemic_live`|scheduler、queue、cache、rank、candidate distribution、共享热路径或资源策略改善|预先声明的正/负 cohort、相同输入前后对照与 Hermes paired A/B|不能靠单笔六步或单次 Adapter Replay 得出|
|`migration_cleanup`|语义已经切到唯一新路径，删除兼容桥没有重新引入隐藏依赖|§18.3 删除清单、clean-process catalog/cold+warm replay、旧 flag/cache/module negative test、此前 parity receipt 引用|不能仅靠 grep 证明语义正确，也不替代默认 cutover 的 live gate|

`adapter_merge_ready` 与 `production_gap_fixed` 必须分开。一份 route-pinned Adapter Replay 即使包含真实 fork
final sim，也没有执行自然 discovery/enumeration；反过来，route 没进入自然 top-K 也不能推翻已经证明的
Adapter 语义，只说明另有 S2/ranking/runtime gap。

### 20.2 Architecture migration parity：批量优先，单个只作定向补验

这条轨道专门验收“Adapter 语义不变，承载它的架构改变”。默认工作单元是按严格模板写完的一批
Swap/Protocol Family，然后只运行一次统一 harness。harness 在内部按 Family/instance/stage 分桶并生成结果矩阵；
它不是把全部输出压成一个总数，也不是为每个 Adapter 启动一份独立验收工程。

单 Family scope 仍使用同一 comparator，但只服务于定向补验或真正隔离的单 Family diff，不作为“写一个、验一个”
的默认迁移节奏。这里的“单个 Adapter”指一个生产 `AdapterFamilyPlugin`，不是一个 pool/instance，也不是低层
ActionAdapter；一个物理协议若被拆成多个 behavior Family，就在 batch scope 中分别列出。

现有 Adapter 的协议语义已经由 ds production behavior、既有单测/fixtures 和已知执行证据承载。纯迁移不会机械地
要求每个 Family 重新证明整套协议知识；统一 comparator 复用这些事实作为 oracle，重点确认模板化后 canonical
语义未变。只有公共 corpus 没有产生可判断结果、出现新旧差异、启用了此前未覆盖的特殊语义插槽，或迁移顺带
声明 semantic improvement 时，才补充 Family-specific evidence。

冻结 ds 已提供五个 migrated pricing Family 的 `full compile == instance compile + assemble`、`+1 pool` 只编译新增
实例、GraphChangeSet、shared binding、snapshot compatibility、score-only、removed/re-add、warm fingerprint 和
CAS/supersede 回归。这些测试在迁移前继续作为 baseline oracle：

- 对 UniV2/UniV3/UniV4/DODO/Angstrom，先证明目标 descriptor-only 输出等价于现有 ds instance path，再删除
  `assembleSchema`；
- 对其余 pricing Family，baseline 是 ds 的 `legacy-family` production closure，challenger 是目标 descriptor path；
- 对 discovery/exact/execution，baseline 是 ds 当前 `RouteLegAdapter`/resolver/probe 行为，不能只跑 pricing tests；
- cleanup commit 删除 executable oracle 后，保留 sealed canonical outputs/receipts，并运行 `migration_cleanup`，不靠
  永久双实现继续比较。

```ts
type ArchitectureMigrationScope =
  | {
      readonly kind: "single-family";
      readonly familyIds: readonly [FamilyId];
      readonly reason: "targeted-follow-up" | "isolated-family-change";
    }
  | {
      readonly kind: "batch";
      readonly familyIds: readonly FamilyId[];
    };

type ArchitectureMigrationMode =
  | "pure-refactor"
  | "declared-improvement";

type ArchitectureMigrationEvidenceClass =
  | "unit-contract"
  | "sealed-production";
```

`familyIds`、mode、fixture corpus 和允许的 semantic delta 必须在运行前冻结。迁移默认冻结一个 batch cohort；
统一 harness 必须保留逐 Family、逐 instance、逐 stage 结果。一个全局 count/hash 不能替代这些子结论，但也
不能把“有逐 Family 结果”误写成“人工运行 N 次验收”。

`unit-contract` 只证明 comparator/schema/conformance 自身按预期工作；即使其 synthetic semantic rows 全部相同，
也必须输出 `acceptance.eligible=false` / `verdict="ineligible"`。只有绑定两侧真实 production closure、activation
manifest、config/policy、frozen corpus 和 evidence refs 的 `sealed-production` capture 才能申请 Phase A/C/D parity
或 production cutover。evidence class 必须由可信 production capture issuer 在 sealed input 中签发，不能由调用者在
结果生成前后自行填写或改写；在该 issuer 尚未落地时，公开 unit runner 必须拒绝 `sealed-production` 输入，而不是
预留一个可由普通调用者开启的字符串开关。

**2026-08-11 sealed-production capture issuer checkpoint（实现 commit
`7ba6f9d37a716e2484f68b19e12f2113dbcd0ded`，Phase A 前置，不是 capture 本身）：**
已落地 trusted production capture issuer：

- `createArchitectureMigrationProductionCaptureIssuer()` 只接受模块内签发的 issuer 身份；
- `issueArchitectureMigrationSideCapture(issuer, capture)` 签发时强制 closure 身份字段与
  每个 exercised stage 的独立 evidence refs，深冻结后存入 issuer-private WeakMap，返回
  opaque handle；调用方拿不到 raw capture 改写路径；
- `sealArchitectureMigrationBatchInput` 对 `sealed-production` 只接受该 issuer 签发的双侧
  handle：forged handle、foreign issuer、raw capture 自封全部
  `requires the trusted production capture issuer`；`unit-contract` 拒绝 sealed handle。

证据：`searcher:architecture-migration-parity-runner` PASS、
`searcher:architecture-migration-parity` PASS、完整 listener build 通过。
该 issuer 只是 Phase A 前置；真实旧 ds 与 challenger 的 `sealed-production` 双侧
capture/receipt 仍未产生，不能据此宣称 Phase A/C/D parity 或 cutover。

**2026-08-11 migration parity production-shaped 文件入口 checkpoint（实现 commit
`a879665a5cff68e8d386d6155f83e0f517c92c3a`）：** 新增
`runArchitectureMigrationParityFiles`：读双侧 raw capture JSON，`sealed-production`
经 trusted issuer 重新校验/签发，`unit-contract` 走原 raw 路径，统一 seal + run 后输出
receipt；并新增 `architecture-migration-parity:run <batch-request.json>` CLI。
合同覆盖：unit/sealed 双侧文件跑通、缺 issuer fail closed、畸形 capture 文件 fail closed。
证据：`searcher:architecture-migration-parity-runner` PASS、
`searcher:architecture-migration-parity` PASS、完整 listener build 通过。真实双侧
`sealed-production` capture 仍未产生，Phase A/C/D parity 与 cutover 不因此成立。

#### 20.2.1 同输入双跑

每个 parity case 必须让旧、新 production closure 使用相同的：

- block number/hash/state root 组成的 `StateAnchor`；
- observation、universe、normalized config、active Family manifest 和 production policy；
- Adapter 支持范围、lineage/variant 声明、Action ownership 和 source policy（例如都绑定同一个 N-1）；
- 外部 request 事实；优先记录 pinned results 后 replay，或在不可 replay 时绑定完全相同的 archive/fork source；
- target-blind 输入边界；expected instance/edge/route 只能在两侧输出冻结后交给 trusted comparator。

“双跑”指同一 frozen input 在隔离的 baseline/challenger process、fork 或 replay backend 中执行，不代表一个 live
generation 同时把两份结果混进 production Graph/cache。旧侧必须绑定 ds baseline commit 与旧 activation manifest；
新侧绑定 challenger commit 与声明的 migration scope。若 batch 只迁部分 Family，两侧共同 active manifest 必须相同，
非迁移 Family 的 canonical semantic hash 也必须相同。

单个静态区块不足以覆盖批量重构。冻结的 corpus 应按实际 Family 能力包含：cold/bootstrap、无 topology 变化的
增量块、新实例/topology delta、已有实例 mutation/update，以及单实例读取/解析失败隔离；每个已声明
identity variant 和 execution behavior 至少由一个正向与必要负向 fixture 覆盖。没有相关能力的 Family 不机械要求
无意义场景。

#### 20.2.2 比较 canonical semantic set，不比较裸数量

`edgeCount`、`pricedCount` 仍记录用于诊断，但绝不能单独决定 verdict。数量相同可能是一条旧 edge 丢失、另一条
错误 edge 混入；数量增加也可能是假阳性。两侧必须先归一化为下面的语义集合再比较：

旧路径不一定原生输出 `lineageId`、`StateInstanceKey` 等新字段；trusted comparator 必须使用在 challenger freeze
前固定的 baseline normalizer，从旧 family/pool/direction/state facts 推导同一 canonical identity。不能因为旧字段
缺失就跳过比较，也不能让 challenger 自己定义有利的映射。

|比较层|比较内容|`pure-refactor` 通过条件|
|---|---|---|
|Instance|`familyId + lineageId + instanceKey`、provenance/behavior class|canonical 集合及关键 metadata 相同|
|Graph edge|canonical route/edge identity、方向、token、ownership、taxonomy、ActionAdapter|有序身份与 metadata 相同|
|State coverage|`StateInstanceKey`、required state keys、source、availability/completeness|集合与 source-bound 状态相同|
|Priced edge|具体哪些 canonical edge 被 priced/unpriced 及 reason|集合相同，不只是总数相同|
|Price|每条 edge 的 protocol-native integer/rational mid、fee、availability、source proof|规范化值相同；任何容差须由既有独立 oracle 合同预先声明|
|Failure|逐 candidate/instance 的 rejected、unsupported、unresolved、failed stage/reason|不得新增回退或把失败改名隐藏|
|Enumeration|共同 Graph 上的 canonical route identity、顺序、top-K refine set|相同 production policy 下相同|
|Exact|固定测试 amount 的 amount-out、fee、rounding、evidence/source|按 Family 既有 parity 合同相同|
|Execution|`PlanFragment`、Action ownership、resolved calldata/effect intent|相同|
|Final sim|代表性 route corpus 的 effects、repayment、conservation、EV input|相同；无需穷举每条组合 route|

核心 receipt 必须同时保存 delta 明细和汇总 hash：

```ts
type FamilyArchitectureParityOutcome =
  | "pass"
  | "semantic-mismatch"
  | "not-exercised"
  | "framework-blocked";

interface FamilyArchitectureParityResult {
  readonly familyId: FamilyId;
  readonly implementationClosureHash: string;
  readonly missingInstances: readonly FamilyInstanceKey[];
  readonly addedInstances: readonly FamilyInstanceKey[];
  readonly missingEdges: readonly RouteKey[];
  readonly addedEdges: readonly RouteKey[];
  readonly changedEdgeMetadata: readonly RouteKey[];
  readonly lostStateKeys: readonly StateInstanceKey[];
  readonly newlyUnresolvedStateKeys: readonly StateInstanceKey[];
  readonly missingPricedEdges: readonly RouteKey[];
  readonly changedPrices: readonly PriceParityMismatch[];
  readonly changedFailures: readonly FailureParityMismatch[];
  readonly changedRoutes: readonly RouteParityMismatch[];
  readonly changedExactQuotes: readonly ExactParityMismatch[];
  readonly changedExecutionFragments: readonly ExecutionParityMismatch[];
  readonly changedFinalSimulations: readonly FinalSimulationParityMismatch[];
  /** additions/corrections lacking a frozen declaration + independent proof */
  readonly unprovenAddedArtifacts: readonly string[];
  /** all semantic deltas outside the frozen declared-improvement envelope */
  readonly undeclaredDeltaIds: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly outcome: FamilyArchitectureParityOutcome;
}

interface ArchitectureMigrationParityReceipt {
  readonly scope: ArchitectureMigrationScope;
  readonly mode: ArchitectureMigrationMode;
  readonly inputManifestHash: string;
  readonly stateAnchors: readonly StateAnchor[];
  readonly familyResults: readonly FamilyArchitectureParityResult[];
  readonly familyResultMatrixHash: string;
  readonly nonPassFamilyIds: readonly FamilyId[];
  readonly nonMigratedFamilySemanticHashParity: boolean;
  readonly assembledCommonGraphParity: boolean;
  readonly aggregateVerdict: "pass" | "partial" | "fail";
  readonly performanceDiagnostics: {
    readonly wallMs: number;
    readonly requestCount: number;
    readonly batchCount: number;
    readonly peakConcurrency: number;
  };
}

interface ArchitectureMigrationBatchParityReceipt {
  readonly evidenceClass: ArchitectureMigrationEvidenceClass;
  readonly baselineCaptureId: string;
  readonly challengerCaptureId: string;
  readonly baselineCommit: string;
  readonly challengerCommit: string;
  readonly baselineProductionClosureHash: string;
  readonly challengerProductionClosureHash: string;
  readonly baselineActivationManifestHash: string;
  readonly challengerActivationManifestHash: string;
  readonly comparatorClosureHash: string;
  readonly parityReceipt: ArchitectureMigrationParityReceipt;
  readonly acceptance: {
    readonly eligible: boolean;
    readonly verdict: "pass" | "partial" | "fail" | "ineligible";
    readonly reasons: readonly string[];
  };
}
```

`ArchitectureMigrationParityReceipt.aggregateVerdict` 是纯语义 comparator 结论；它不能脱离外层 evidence/capture
receipt 直接授权晋升。`ArchitectureMigrationBatchParityReceipt.acceptance` 必须重新检查：两侧 capture 独立、commit/
production closure/activation manifest/corpus 全部冻结且相互匹配、evidence class 为 `sealed-production`、逐 Family
coverage 与 common-Graph/non-migrated gates 完整。任何 unit fixture、手工拼接 capture、共享对象引用或缺少一侧
production closure 的输入，即使内部 `aggregateVerdict="pass"`，外层也只能 `ineligible` 或 fail。

Comparator 的核心顺序必须是“先逐 Family，后 aggregate”，不能先看总数决定通过：

```ts
function judgeArchitectureMigration(input: FrozenMigrationRun):
  ArchitectureMigrationParityReceipt {
  assertValidFrozenScope(input.scope);
  assertSameFrozenInputs(input.baseline, input.challenger);

  const familyResults = input.scope.familyIds.map((familyId) => {
    const exercisedCases = input.corpus.casesForFamily(familyId);
    if (exercisedCases.length === 0) {
      return makeNotExercisedResult(familyId, input);
    }

    return compareCanonicalFamilySemantics({
      familyId,
      exercisedCases,
      baseline: normalizeFamilyOutput(input.baseline, familyId),
      challenger: normalizeFamilyOutput(input.challenger, familyId),
      declaredDeltas: input.declaredDeltas.forFamily(familyId),
    });
  });

  const nonMigratedFamilySemanticHashParity = compareNonMigratedFamilies(input);
  const assembledCommonGraphParity = compareAssembledCommonGraph(input);
  const nonPassFamilyIds = familyResults
    .filter((item) => item.outcome !== "pass")
    .map((item) => item.familyId);
  const allFamiliesPass = nonPassFamilyIds.length === 0;
  const anySemanticMismatch = familyResults.some(
    (item) => item.outcome === "semantic-mismatch",
  );
  const sharedGateFailed =
    !nonMigratedFamilySemanticHashParity || !assembledCommonGraphParity;

  return sealMigrationReceipt({
    ...input,
    familyResults,
    nonPassFamilyIds,
    nonMigratedFamilySemanticHashParity,
    assembledCommonGraphParity,
    aggregateVerdict:
      allFamiliesPass &&
      nonMigratedFamilySemanticHashParity &&
      assembledCommonGraphParity
        ? "pass"
        : anySemanticMismatch || sharedGateFailed
          ? "fail"
          : "partial",
  });
}
```

`not-exercised` 不是静默缺席：当公共 corpus 没覆盖某 Family 时，harness 必须合成该行并列入
`nonPassFamilyIds`。`framework-blocked` 表示输入已经覆盖，但中央 transport/scheduler/cache/fence 等问题让语义
无法裁决；它也不能被改名为 Adapter fail。这样一次 batch 后可以直接查询“哪些还没有验收成果”，而不是人工
翻 N 份日志。只有 `semantic-mismatch` 表示已观察到新旧 Adapter 语义不一致。

#### 20.2.3 Pure refactor 与 declared improvement

`pure-refactor` 表示 Adapter 能力和激活范围相同，要求共同 baseline-active manifest 上语义等价：

```text
missing baseline-valid instance       = 0
missing baseline-valid edge           = 0
changed edge ownership/metadata       = 0
lost required StateInstanceKey        = 0
missing baseline-priced edge          = 0
unexpected price/exact quote mismatch = 0
new unresolved/failed instance        = 0
```

旧输出也不是链上真相本身。若迁移同时修复旧漏收、加入新 pool/方向，或删除已证明的重复/错误 edge，必须改用
`declared-improvement`，并在运行前提交逐 Family `DeclaredSemanticDelta`：

```ts
interface DeclaredSemanticDelta {
  readonly familyId: FamilyId;
  readonly kind:
    | "verified-addition"
    | "canonical-deduplication"
    | "semantic-correction"
    | "approved-deactivation";
  readonly affectedCanonicalIds: readonly string[];
  readonly independentEvidenceRefs: readonly string[];
}
```

共同 baseline 集合仍须严格 parity；新增集合必须单独通过 identity、state、quote 和 execution 证明。新增 30 条不能
抵消丢失 20 条。canonicalization 允许 raw edge 数下降，但必须提供旧重复 edge → 新 canonical edge 的完整映射和
行为等价证明。approved deactivation 是独立 coverage/product 变更，不能伪装成重构提速。

新增语义可能合法改变全图 rank/top-K，因此 comparator 应先在共同 baseline-active manifest 上关闭 additions 做
parity，再单独启用 addition manifest 验证新增输出及其完整资源成本；不能在一个混合总数中判定“更好”。

#### 20.2.4 批量主验收与单 Family 定向补验的边界

|范围|必须输出|通过条件|失败后如何处理|
|---|---|---|---|
|`batch`（默认）|冻结 cohort 的一份 receipt、自动逐 Family 结果矩阵、跨 Family ownership/selector/stateKey 冲突检查、共同 assembled Graph、非迁移 Family canonical semantic hash|矩阵中每个 Family 都是 `pass`，且跨 Family 与共同 Graph gate 全 pass；不能平均、投票或用总增量抵消单 Family 回退|直接按 `nonPassFamilyIds` 分流：语义差异回 Family，未覆盖补 corpus，中央阻塞回 framework；已 pass 行不重复验收|
|`single-family`（定向）|原 batch receipt/hash、目标非 pass 行、只覆盖该 Family 的补充证据、受影响共同 Graph 检查|目标行转为 `pass`，且依赖闭包证明未使其他已 pass 行失效|若只改 Family-local closure，可替换该结果行后重封 batch receipt；若改共享 framework closure，必须失效并重跑所有受影响行|

因此批量重构不需要为每个 Adapter 重复启动一套 comparator、审查文档或 live A/B；一次 sealed batch harness
同时提供所有 Family 的语义结果。`batch=pass` 等价于“结果矩阵全部 pass + cross-family gate pass”，不是“总体
edge/priced 数量相近”。逐 Family 行应由机器从统一运行中生成，作者只需要处理非 pass 行。

如果批量运行只有部分 Family 通过，原批次保持 `partial` 或 `fail`，不能把未通过 Family 静默移出运行后
denominator。Family-local 补丁可以依据 `implementationClosureHash` 只重跑该 Family 并重新执行共同 Graph gate；
中央模板、normalizer、scheduler、cache、Graph merge 或 comparator 变化会失效其影响闭包内的既有 pass 行，必须
重跑受影响 cohort。这样既避免机械 N 次全量验收，也不会复用已经过期的证据。

#### 20.2.5 语义验收与时效性/生产切换分离

`architecture_migration_parity` 不设置 production p95 硬阈值。它只使用运行前冻结的宽松 outer safety timeout
防止死锁，并要求：所有 case 最终有 terminal outcome、request 数有硬上界、无整 Family 连坐、无无限 retry；
wall time、request/batch 数和峰值并发必须记录，但只是诊断字段，不能把 semantic fail 改成 pass。

目标状态允许诚实地输出：

```text
semantic_parity   = pass
timing_status     = not_yet_validated
production_cutover = blocked
```

该状态可支持默认关闭、shadow 或 dual-mode 路径继续合并/迁移，但不授权替换线上默认路径。默认生产切换仍需
独立 `systemic_live` shadow/paired A/B，检查 queue、RPC/resource、p95、head freshness 和完整 denominator；
现有 [`gates.md`](../gates.md) 若仍对 universal refactor 规定更严格的 merge/timing sentinel，则上位规则继续生效，
本 receipt 只能提供 semantic verdict，不能自行放宽 promotion 权限。若项目决定允许 semantic-only shadow merge，
必须在上位 gate 明文采用该边界，不能靠本文暗中覆盖。

#### 20.2.6 迁移桥删除验收

兼容桥删除应作为单独、可审查的最终 slice，输入绑定最终 batch 结果矩阵、必要的定向补验引用和已批准的
default-path cutover。通过条件不是“旧代码搜索不到”这么机械，而是同时证明：

```ts
interface MigrationCleanupReceipt {
  readonly baselineDsCommit: string;
  readonly preCleanupTargetCommit: string;
  readonly cleanupCommit: string;
  readonly batchParityReceiptHashes: readonly string[];
  readonly finalFamilyResultMatrixHash: string;
  readonly nonPassFamilyIds: readonly [];
  readonly cutoverEvidenceRef: string;
  readonly activeCatalogHash: string;
  readonly productionCatalogKind: "generated-static-imports";
  readonly productionRuntimeSourceScan: false;
  readonly legacyActivationInputs: readonly [];
  readonly legacyRuntimeBranches: readonly [];
  readonly exactToCoarseBypassPresent: false;
  readonly ambientFamilyIoApisPresent: false;
  readonly familyWideSchemaApisPresent: false;
  readonly manualSchemaRevisionsPresent: false;
  readonly oldCacheAccepted: false;
  readonly oldFlagsAccepted: false;
  readonly unifiedSchedulerCoverageHash: string;
  readonly finalSimulationReservedCapacityReceiptHash: string;
  readonly staleGenerationFenceReceiptHash: string;
  readonly perInstanceFailureIsolationReceiptHash: string;
  readonly poolTopologySpikeReceiptHashes: readonly string[];
  readonly cleanColdSemanticHash: string;
  readonly cleanWarmSemanticHash: string;
  readonly representativeSixStepReceiptHashes: readonly string[];
  readonly systemicLiveCutoverReceiptHashes: readonly string[];
  readonly rollbackArtifactRef: string;
  readonly verdict: "pass" | "fail";
}
```

结构扫描/TypeScript compile 用来证明旧 public symbol、imports 和 runtime flag 已删除；clean-process cold/warm replay、
旧 cache/旧 flag negative test、catalog hash 与 representative six-step 用来证明删除后仍能工作。两类证据缺一不可。
机器 receipt 还必须直接绑定统一 scheduler、final-sim 保留容量、stale-generation fence、单实例失败隔离、真实
`5,000+1` executable receipt 与默认切换所需的 systemic-live A/B；一个不透明 `cutoverEvidenceRef` 只能作索引，
不能替代这些逐项字段。
若某 Family 只能靠旧 compiler/resolver 才能通过，cleanup 必须 fail 并回到该 Family 或 framework migration，不能把
旧路径重新放回 optional fallback。通过后，迁移期 baseline executable code 可以删除，只保留 sealed evidence。

### 20.3 统一六步语义

六步是生产因果链，不是六个 Adapter 函数。每一步都必须有 canonical input/state anchor、stage-owned output、
内容 hash 和明确失败归属。

|Step|输入|实际动作|必须观察到的输出|失败首先归属|
|---|---|---|---|---|
|1 `discovery_admission_graph`|lane-aware `StateAnchor`、统一 observation、自动 capability catalog|中央扫描并分流；Family decode candidate、声明 identity proof、编译 instance、投影 verified routes；中央合并 Graph 并检查选中 route 所需 shard|candidate provenance、identity/admission proof、`familyId/lineageId/instanceKey`、canonical edge identity、runtime graph membership、required-shard completeness|候选/证明/descriptor/route 语义错归 Family；输入、transport、publication/CAS 错归 framework|
|2 `route_enumeration`|同一 Graph、同一 source 的 coarse snapshot、生产 caps/policy|中央全局枚举 route/ring，以 coarse spread 排名并自然选择 refine set；不得注入目标 route、pool 或 amount|canonical ordered route identity、自然 route-set hash、目标 route membership、策略范围内 `rankComplete=true`|edge 已存在但未组合/排名归 central enumeration；缺 edge 回到 Step 1；缺 coarse state 回到 pricing/framework|
|3 `exact_quote_refine`|Step 2 自然产出的 route/top-K，或明确标记为 route-pinned 的 Adapter Replay route；同一 state anchor|中央 exact scheduler 按 amount/source/evidence 调用各 Family 的 request program/local quote，执行 budget、dedupe、cache/carry|每 leg 的 exact amount-in/out、fee、rounding、source/mutation proof、runtime evidence 与 exact hash|Family request/decode/math/parity 错归 Family；queue/deadline/transport/cache 绑定错归 framework|
|4 `plan_and_size`|Step 3 refined legs、真实 executor/runtime evidence|Family 为每 leg 纯构造 `PlanFragment`；中央检查 action ownership，组装计划并由 solver 选择 amount 和 resolved subtree|canonical plan identity、solver-selected input、逐 leg resolved amount、action ownership、execution surface/calldata subtree hash|Family fragment/ABI/evidence 绑定错归 Family；无可执行 sizing、borrowability 或 solver-internal search 失败归 central planner/solver|
|5 `fork_final_sim`|Step 4 的 exact resolved plan 与 compiled bytes|中央在独立 mandatory fork simulation 执行完整计划；不是复用 solver 内部试算|root calldata/script hash、success/revert、gross/net profit、gas、flash repayment、token conservation、standing-position result|Family calldata/settlement 语义错归 Family；fork/anchor/runner 基础设施错归 framework；timeout 不能冒充 typed family failure|
|6 `production_ev`|Step 5 的实际 effects、production valuation/policy|中央按生产 EV policy 计算并作 allow/reject|valuation inputs、policy inputs、decision、reason、`net_ev > 0`|EV reject 是 policy 结果，不得回写成 Adapter quote failure；估值/配置读取错归 framework|

六条 record 必须绑定同一个 `run_id`、`StateAnchor` 和目标 route，并形成前一步 output hash → 后一步 input
hash 的 causal chain。`metrics` 和 `extensions` 只用于诊断，不能补齐缺失的核心输出或把 fail 改成 pass。

生产轨道还必须满足：

- producer 在输出冻结前看不到 expected route、pool、token、amount 或 comparator reference；target 只能在之后匹配；
- amount 必须由 solver 选择，route 不能被 forced append/select；
- scanner 必须正常走到生产策略终点，没有 refinement deadline 截断；`rankComplete` 表示在冻结的生产
  caps/policy 下完成，不表示穷举全图所有路径；
- 纯 DEX route 合法，不要求图中人为存在 protocol edge；Step 1 只对最终路线实际使用的 Family shard fail closed，
  无关 Family 的局部失败作为 isolated outcome 记录；
- Step 5 的 root calldata 必须与 Step 4 solver-selected resolved subtree 的编译结果 byte-match；
- 只有 mandatory final sim 的还款、守恒和 standing position 通过，且 Step 6 返回 positive allowed EV，才能得到
  `production_gap_fixed`。

Adapter Replay 轨道必须诚实地把 Steps 1–2 标为 `bypassed`，而不是伪造“已发现/已枚举”。它至少需要：

```text
同一 hash-bound fixture + state anchor
→ baseline 未注册或稳定 typed family-owned failure
→ challenger route-pinned Steps 3–6 pass
→ exact impacted-family ownership/conformance
→ family boundary = family_local
→ adapter_fixed + adapter_merge_ready
```

RPC、timeout、abort、资源不足或错误字符串本身都不是稳定 family baseline。`adapter_merge_ready` 只允许合并
family-owned diff，不授权部署、发布或清理分支。

### 20.4 横向架构验收

六步证明一条 route 的因果正确性；下面的场景证明统一插件和调度边界没有被绕过。

|场景输入|执行动作|必须观察到的结果|失败归属|
|---|---|---|---|
|两个 Family 共享 selector|扫描同一 successful call|两个候选都可被提名；只有 proof 通过者准入|Discovery 索引或 Family identity|
|伪造 Factory child|读取 pool facts 后做 reverse call|`getPool(...) != candidate` 时拒绝，不产生实例/route|Family identity semantics|
|同一标准 ERC4626 分别来自 Factory、Registry、standalone|运行各 identity variant + common behavior proof|归一化为同一 Family 的标准 descriptor；provenance/lineage 保留差异|Family identity/instance|
|5,000 个 unchanged StateInstance + 1 个新增健康 pool（cold memo）|比较前后 instance set 与 `PoolTopologySpikeReceipt`|`added=1`、`changed=0`、新增 compiler=1；5,000 sibling compiler/static request=0，family-wide compiler/assemble=0|中央 diff/cache，或 Family projection 不稳定|
|同一 5,000+1 fixture 命中合法 content-addressed memo|重跑新增 key 并验证 reuse proof|新增 compiler=0（最多不得超过 1）；sibling compiler/static request 与 family-wide compiler/assemble 仍为 0；memo 不被当作 published previous/carry|中央 memo/store separation 或 reuse policy|
|一个新增实例 static hydration 失败|并行编译多个 sibling|只该 key unresolved；健康 sibling 继续发布|中央 failure isolation 或 Family decoder|
|exact-only 代码变化|重新生成 capability manifest 并启动|只 exact hash/cache 失效；pricing descriptor fingerprint 不变|build hash dependency closure|
|pricing decoder 变化|重新生成 manifest|对应 pricing hash 和实例 descriptor/snapshot 失效|build hash dependency closure|
|只增加 score|adopt 新 graph|ranking metadata 更新，descriptor/snapshot 不重编|中央 diff|
|新增 UniV2 反向 direction|更新 route membership|旧 reserves snapshot 可重派生新 mid|Family compatibility projection/中央 carry|
|新增 UniV3 precision direction|更新 route membership|descriptor 可复用，但缺 witness 的方向 direct/补读|Family compatibility projection/中央 state lane|
|某 ERC4626 只证明 deposit|投影 routes|只出现 asset→share；redeem 不会被通用 builder 重建|Family route projection|
|未知 V4/Ekubo extension|编译 instance/route|拒绝执行，或显式 simulation-only；不能按 base pool quote|Family extension policy|
|Fluid quote 约定 revert bytes|执行 exact request|transport 成功交付 declared revert data 给 decoder；普通 revert 仍失败|中央 transport classification/Family decoder|
|DODO quote 依赖 actor|用不同 caller 尝试 cache reuse|caller/evidence 不匹配时 exact cache miss/fail closed|Family requirements/中央 cache key|
|Adapter 请求超预算|构造过多 reads/steps|中央在 transport 前拒绝为 unresolved；Adapter 无法绕过|中央 scheduler/budget|
|required request 失败，或声明的 transport/caller/completion/effects 与实际 request 不一致|执行任一 initial/dependent executor path|transport 与 decoder 调用次数均为 0；返回 typed declaration/authority failure|中央 Request Program executor|
|transport capacity=1，首个 request 已 logical timeout/abort，但底层 fetch/body 未 settle|在首个 physical work settle 前提交第二个 request|第二个 request 仍排队，observed physical concurrency 始终为 1；首个 settle 后才释放 permit。consumer timeout 不能提前释放容量|中央 timeout/physical-settlement ownership|
|短 deadline consumer 与长 deadline consumer 命中同一物理 request|短 consumer 先超时|短 consumer 可终止，但它不能成为长 consumer 的唯一物理 work owner；底层 settle 前 permit/dedupe entry 不释放|中央 dedupe/deadline ownership|
|coarse 连续 catch-up，同时 discovery backfill 排队|运行多个 generation|coarse 只在物理 reads 占 foreground permit；background watermark 持续推进|中央 lease scope/fair queue|
|一个 Family 产生 exact probe 风暴|并发提交大量 exact work|按 Family/instance 限流、相同 request dedupe；其他 Family 和 final sim 仍有进展|中央 scheduler/resource pool|
|新 head 使旧 generation 过期|旧 work 尚在 queue/in-flight|queued work 取消；迟到结果被 generation fence 拒绝，不能污染 publication/cache|中央 cancellation/CAS|
|generation A 编译成功但在 canonical CAS 前 supersede；generation B 随后开始|检查 B 的 previous/carry 输入与 memo reuse|A 的结果可留在 `CompileMemoStore` 并重新验证 reuse proof，但绝不能出现在 `PublishedDescriptorStore`、previous/carry 或跨代 snapshot/exact cache|中央 store separation/CAS|
|一个 tracked production module 使 generated artifact 生成/contract closure 校验失败|构建 catalog 后由 clean process 加载 static-import artifact|artifact 构建或 production 启动 fail closed；逐 module issue 可见，不执行 runtime source scan，也不回退同 ID legacy Family|build catalog/composition root|
|多个 identity variant 对同一 candidate 给出 verified/unresolved/conflict|运行完整 variant aggregate|只有可归一化到同一 instance 的 verified 证据能准入；冲突 fail closed，不能取“第一个成功”|Family identity aggregate/中央裁决|
|ordered exact methods 同时存在 local 与 request-program|依次运行 quoted、`not-applicable`、throw/fail case|只有 local 明确返回 `not-applicable` 才能尝试下一 method；已选 request method 或任意失败不得 fallback|Family exact semantics/中央 method runner|
|伪造、spread/clone、foreign/hot-reload-old route 或 exact handle|尝试 exact、victim replay 或 execution|issuer WeakMap 查验失败；wrong route/source/generation/executor/runtime evidence 同样 fail closed；Family callback 收到 issuer 保存的原始 descriptor/route/evidence|中央 handle authority|
|spread/clone、same-field/same-hash forge、foreign/hot-reload-old Funding offer|尝试 borrow 或 repayment fragment|loaded FamilyBox 与 offer issuer 双重查验在 Family callback 前失败；wrong source/generation/capability/publication 同样拒绝，公开 offer projection 不能充当执行 authority|Funding issuer/runtime boundary|
|raw/clone/same-field Credit descriptor 或非当前 lifecycle instance|尝试签发 Credit route handle|在 route projection 等任一 Family callback 前拒绝；route issuer 只接受当前 loaded FamilyBox + source/generation 下 lifecycle 签发的 exact instance object|Credit instance issuer root|
|Credit Family 产生 lend route、risk evidence 与 execution|发布 common Graph 后交给 solver/plan/final sim|route/risk/execution handle 来自同一当前 FamilyBox；Graph edge 与 handle/risk publication 同 CAS，solver 不查询 legacy Credit registry；repayment/position final sim fail closed|Credit runtime 或全 catalog publication|
|全 catalog canonical CAS 被拒绝|比较 CAS 前后 publication object 与所有权威 Maps|Graph、route-handle index、descriptor、snapshot、mid、coverage、delta metadata 的 identity/content 全部不变；不得只更新其中一部分|中央 publication coordinator|
|`unit-contract` comparator 输入产生零 semantic delta|生成 batch receipt 并尝试作为 Phase A/C/D 或 cutover evidence|内部 semantic verdict 可用于测试，但外层 `acceptance.eligible=false`、`verdict=ineligible`；只有独立 `sealed-production` captures 可晋升|migration evidence authority|
|中央 shared surface 扫描|加载任意新 Family|scanner/planner/solver 无新增 Family ID branch|framework boundary|
|声明默认 strict authority 已切换|扫描 production source closure 与启动后的实际 consumers|scanner/discovery/pricing/quoter/plan-builder/solver 全部只消费 strict catalog/publication；`PRODUCTION_ADAPTER_FAMILIES`、legacy Credit/Funding view 或同义 facade 的生产 consumer 为零|composition root / authority cutover|
|计划 exact 与编码都通过|运行完整 fork final sim|只有还款、守恒、效果和 EV 全部通过才可进入提交判断|中央 S5/S6|

### 20.5 每个 Family fixture 的最小语义面

fixture 数量按行为变体决定，不按机械文件数决定；但每个已声称支持的行为至少覆盖：

这是一张由统一 harness 汇总的**覆盖面合同**，不是要求迁移时为每个 Family 从头新写一套同名测试。优先复用
冻结 ds 已有 fixture、production replay 和共享标准 conformance case；batch 运行后只有落为 `not-exercised`、
`semantic-mismatch` 或特殊插槽缺证据的行才新增定向 fixture。

- identity 正/负证据，以及 Factory/Registry/standalone 等已声明 variant；
- instance static metadata 与 `familyId/lineageId/instanceKey` 归一化；
- verified direction 投影，未证明方向不得由通用 builder 猜出来；
- static/current/dependent request 形状、source binding 和预算上界；
- decode、mid、exact fee/rounding 数学与独立 parity；
- 所有已声明 `RuntimeRequirement` 的正向和 stale/mismatch 负向证据；
- `PlanFragment`、owned ActionAdapter、calldata 与 exact evidence 一致；
- landed real transaction 的 decode/encode 或行为等价 witness；
- 单实例失败隔离、unknown variant fail closed 与无 ambient I/O purity。

若 Family 语义全部正确，但失败发生在中央 queue fairness、transport lease、CAS、generation fence、warm cache、
request budget、topology diff、solver 或 final-sim runner，结果应为 `framework_blocked` 或对应
`systemic_live` gap；不要继续修改 Adapter 来掩盖中央缺口。

## 21. 最终裁决

冻结 ds 不是从零开始：唯一 registry/派生 projections、tracked production source inventory/closure checks、StateInstance
B1–B6、五个 migrated pricing Family、request/batch lane/reserve 和 coarse 外层整代 lease 修复都应作为新架构地基。
它也不是终态：hard timeout 尚未保证 physical settlement 前不释放容量，pre-CAS descriptor Maps 仍会污染下一代
published previous，`adoptExactProbeMids()` 也仍是必须删除的 exact→coarse 旁路；此外 20 个 legacy 激活、raw
backend/state-bearing Adapter API、14 个 legacy pricing Family、family facade 和手工 revision 仍需迁移（冻结基线的
22 个 Family 中，19 个属于 swap/protocol pricing，5 个已进入 `state-instance-v1`，其余 14 个仍在 legacy pricing path）。

对“pool 尖峰”的精确裁决是：本文完成后应消除 topology/static compilation 的 Family-wide 放大；在 5,000 unchanged
StateInstance + 1 新 pool 的 fixture 中，cold memo 只允许新增 key 编译一次，合法 memo hit 可为零，所有 sibling
compiler/static request 与 family-wide compiler/assemble 都必须为零。它不承诺 current-state reads、receipts/activity、
全图 diff/sort、exact、solver、CAS 或 final sim 的 live 长尾自动消失；这些仍需独立 `systemic_live` 证据。

1. 一套统一 `AdapterFamilyCore` 同时服务 Swap 与 Protocol；生产插件只能通过互斥的
   `defineSwapFamily()` / `defineProtocolFamily()` 两个严格模板进入 catalog。
2. build-time 自动发现并生成 static-import catalog 来加载 Family **代码能力**；生产 runtime 不扫源码。链上实例、
   pair、route、StateInstance 仍全由动态链上扫描和证明产生。
3. Family 插件完整覆盖 Discovery、Identity、Instance、Route、Pricing、Exact、Execution；可选能力省略而非空实现。
4. Identity 支持 factory-child、registry-member、standalone、singleton-subinstance 和 custom variant，并统一经过行为证明。
5. `familyId`、`lineageId`、`instanceKey` 分离；Factory 只作 provenance/lineage，不是准入 allowlist。
6. 中央持有 per-instance descriptor Map；Adapter 不再接收或构造全 Family `schema.pools/groups`。
7. 作者不手工维护 revision；构建生成 capability 级内容 hash，commit SHA 仅作 provenance。
8. Exact custom 能力拆成 requirements/buildRequests/decode；所有 RPC、retry、budget 和 cache 归中央。
9. 所有 Family work 进入同一中央 scheduler；lane、fairness、deadline、batch、dedupe、transport/simulator pool、
   cancellation 与 generation fence 由 framework 决定。logical timeout/abort 可先结束 consumer，但 permit 必须覆盖
   物理 I/O/simulation 直到真实 settlement，不能随外层 Promise 提前 reject 而释放。
10. V4 hook、Angstrom evidence、Ekubo config、Balancer context、Fluid revert quote、self-burn delta、Oracle、Curve、DODO、Astra、ERC4626 Silo 通过通用调度插槽承载，不增加中央协议名分支。
11. Route Projection 属于 S1；全局 route/ring enumeration 属于 S2；Exact 属于 S3；Plan Fragment 属于 S4；Final Simulation 与 EV 始终中央所有。
12. Adapter Replay 只证明 route-pinned Steps 3–6 与 family-local merge；自然 Steps 1–6 才能证明
    `production_gap_fixed`，scheduler/latency/resource 改动另走 `systemic_live` cohort A/B。
13. 架构迁移默认按严格模板批量编写并运行一次统一 harness；harness 自动生成逐 Family 结果矩阵，只对非 `pass`
    行做单 Family 定向补验。只有矩阵无缺失/非 pass 行且 cross-family/common-Graph gate 都通过时 aggregate 才通过。
14. Graph edge/priced 的裸数量只作诊断；pure refactor 比较 canonical semantic set，declared improvement 将共同
    baseline parity 与 independently-proven additions/corrections 分开，新增不能抵消回退。
15. `architecture_migration_parity` 的 semantic verdict 与 live timing/cutover verdict 分离；semantic pass 可支持
    上位 gate 明确允许的 shadow/disabled-path 迁移，但不能自行授权默认生产切换。
16. 迁移期允许双模式、shim、oracle、dual cache namespace 和双写 telemetry，但 production generation 只有一个
    权威路径，任何失败都不能隐式 fallback 到另一实现。
17. 全部 Family parity 与 cutover 完成后，legacy activation/schema/API/revision/cache bridge 必须通过 §18.3/
    §20.2.6 的 cleanup slice 从源码和运行时删除；回滚依靠上一已验收构建物，不靠常驻双实现。
18. 实施基线是 `origin/codex/ds-blockscan-state-timing-refactor@94cdf1d4...`；若分支前进，先审计差异再更新
    baseline，不能重新用 `main` 的现状替代 ds 事实。
