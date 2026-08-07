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
|生产激活|`LEGACY_PRODUCTION_ADAPTER_FAMILIES` 手工列出 20 个 Family；tracked-source loader 自动扫描 Astra、EtherToken 两个 `*.production.ts`，合计 22 个|所有生产 Family 都由严格构造器产出的自动扫描模块加载，legacy 数组删除|
|高层 ownership|`AdapterFamilyRegistry` 已是唯一高层 registry，并派生 route、swap、protocol、funding、landed event、victim、discovery、pricing 与 action ownership 视图|保留唯一 registry/派生视图思想，输入收紧为 branded Swap/Protocol 插件及独立的其他 Domain 插件|
|Adapter API|`RouteLegAdapter` 仍提供异步 `buildEdges(pool, backend, control)`、`quoteExact(ctx.state)`、`buildPlanFragment(ctx)`；`ProtocolDiscoveryContext` 直接暴露 `backend`|Adapter 只声明 request program 并同步 decode/derive/build；transport、deadline、retry、cache 和并发完全归中央|
|Blockscan pricing|中央 per-StateInstance diff/cache/GraphChangeSet/CAS/warm-cache/tombstone/失败隔离已落地，并已有 lane/family 的 partition/read/finalize/sort 与 assembly 分段 telemetry；UniV2、UniV3、UniV4、DODO V2、Angstrom V4 已进入 `state-instance-v1`|所有 active pricing Family 迁移；descriptor-only current/decode 路径替代 family-shaped facade|
|迁移 facade|已迁 Family 仍用 `assembleSchema(entries)` 包装出 `{pools/groups: Map}`；未迁 Family 仍走 `legacy-family`|`assembleSchema`、`legacy-family`、full-family runtime compiler 全部删除|
|缓存版本|`adapterSchemaRevision: "...-v1"` 仍由作者手工维护|构建生成 capability 内容哈希；手工 revision 与 fallback 删除|
|reth 调度|`LiveRethReadPriority` + `RethTransportScheduler` 已有 producer-critical/producer-bulk/exact/discovery lane、producer reserve，permit 只包物理 request/batch；coarse 外层整代 foreground lease 已删除|所有 Adapter I/O 进入统一 work-intent policy；补齐 Family/instance fairness、跨阶段 dedupe、统一 outcome 与 final-sim 保留池|
|Exact feedback|`adoptExactProbeMids()` 已把 canonical current-N exact probe 的 scalar mid 安全回写 coarse recovery base|保留中央 ownership，并把 full exact cache 与 coarse-mid feedback 明确分成两种兼容合同|

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
|必需|`exact.requirements/buildRequests/decode` 或纯 `quoteLocal()`|精确报价语义|
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
|`quoteExact(ctx.state)`|任意异步 StateBackend 访问隐藏 request cost/source|`requirements/buildRequests/decode` 或纯 `quoteLocal()`|
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

type AdapterRequest =
  | {
      readonly id: string;
      readonly kind: "eth-call";
      readonly to: string;
      readonly data: string;
      readonly from?: string;
      readonly completion: "return-data" | "return-or-revert-data";
    }
  | {
      readonly id: string;
      readonly kind: "get-code" | "get-storage";
      readonly address: string;
      readonly slot?: string;
    }
  | {
      readonly id: string;
      readonly kind: "state-override-simulation" | "effect-delta-simulation";
      readonly call: { readonly from: string; readonly to: string; readonly data: string };
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
  readonly reusePolicy:
    | { readonly kind: "source-local" }
    | {
        readonly kind: "immutable-code";
        readonly codeSubjects: readonly string[];
      }
    | {
        readonly kind: "dependency-proof";
        dependencyKeys(input: Input): readonly string[];
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
  input.executor.assertWithinBudget(input.familyId, requests);
  const results = await input.executor.execute({
    familyId: input.familyId,
    source: input.source,
    requests,
  });
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
          source: input.source,
          results,
        })
      : undefined,
  };
}
```

约束：

- request ID 在一个 instance/route program 内稳定且唯一，中央负责全局 namespace 和物理 calldata 去重。
- source number/hash/generation 由中央注入；Adapter 不能自行选择 `latest`。
- `return-or-revert-data` 只对 request 显式声明且 Family conformance 证明的合约语义有效。
- state override 只能表达“给真实 executor 准备本次 probe 所需余额”等受控意图，Adapter 不能直接提交任意 storage diff。
- deadline、retry 次数、并发和最大 request/round 数完全由中央 policy 决定。

### 4.3 中央调度平面：统一的不只是函数签名

统一 Adapter 接口只有在所有工作都进入同一个中央调度平面时，才会真正改善时效性。Family 返回的不是
一个可以自由 `await` 的异步闭包，而是一个**声明式 work intent**：它说明 stage、对象、source 和 request
program；中央再决定 lane、deadline、并发、transport pool、batch、dedupe 和 retry。

冻结 ds 已经实现了重要的物理 transport 基础，但尚未实现下面完整的 work-intent 平面：

|能力|冻结 ds 状态|剩余收敛|
|---|---|---|
|物理 permit 范围|`RethTransportScheduler.run()` 的 permit 只覆盖一次 HTTP request/batch；coarse producer 不再整代持有 foreground lease|保持该不变量，并让所有新 request program 必经同一入口|
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

`CentralScheduleDecision` 只能由 framework policy 从 call site、stage、source freshness 和全局资源状态推导。
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
  const schedule = runtime.policy.bind({
    stage: intent.stage,
    familyId: intent.familyId,
    source: intent.source,
    requirements,
    requestCount: requests.length,
  });
  runtime.budgets.assertAdmitted(schedule, requests);

  // Scheduler 在内部按物理 request/batch 获取并释放 permit；返回时 lease 已释放。
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
- 物理 calldata/object read 在 source 与 caller 等绑定一致时由中央 dedupe/batch；
- 并发既受 transport pool 限制，也受 Family/instance fairness 限制；一个 Family 的 exact probe 风暴不能耗尽全局槽位；
- background discovery 能持续获得 transport；foreground 只能在真实 critical read 期间占槽，不能让 coarse producer
  在等待、组装、decode 或整代 catch-up 期间持有 lease；
- final simulation 使用独立或保留容量的 pool/lane，不能被 discovery backfill 或 exact fan-out 长期排队；
- retry 每次重新排队并重新取得物理 permit；Adapter 不能在一次 callback 内偷偷循环 RPC；
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

tracked-source loader 通过 `git ls-files` 扫描同目录 `*.production.ts`，当前实际发现
`astra-multitoken.production.ts` 与 `ethertoken-native-redeem.production.ts`。它已经负责：source scan/import
timeout、模块合同、Family 注册冲突、owned ActionAdapter 精确集合、descriptor edge kind、shared infra 依赖，
并用完整前缀构造 `AdapterFamilyRegistry` 检查 ownership/identity/typed capability。这个 loader 和唯一 registry
应保留并演进，不应重写为协议清单。

当前 production root 只把 `source_scan_failed` 升为启动错误；单个 module 的 import/timeout/contract/conflict issue
会被记录后省略该 module。终态不能让一个 tracked production Family 因加载错误而静默退场：loader 可以继续
返回逐 module issue 供诊断，但 production catalog 只有在**全部 tracked active modules 成功**，或存在独立批准并
绑定 catalog hash 的 deactivation manifest 时才可发布。迁移期若新 module 加载失败，也不得暗中退回同 ID 的
legacy Family；该启动/切换应 fail closed。

当前 `defineProductionFamilyModule()` 只 freeze `{ family, actionAdapters }`，还不是 §4 的不可伪造 brand；而
`baseFamilies` 参数与 `LEGACY_PRODUCTION_ADAPTER_FAMILIES` 正是迁移桥。目标 composition root 只自动收集严格
插件模块：

```ts
export async function loadFamilyCapabilityCatalog(): Promise<FamilyCapabilityCatalog> {
  const modules = await loadTrackedFamilyModules("**/*.production.ts");
  const generated = await loadGeneratedCapabilityManifest();

  const defined = modules.map((module) => {
    assertDefinedFamilyPlugin(module.plugin);
    return module.plugin;
  });
  const loaded = defined.map((plugin) =>
    attachGeneratedCapabilityHashes(plugin, generated)
  );

  return buildFamilyCapabilityCatalog(loaded);
}
```

`assertDefinedFamilyPlugin()` 必须验证构造器 brand 和冻结后的合同摘要；文件名、export 名或结构相似不能替代
brand。这样扫描仍然自动发现 Family 代码，但不能把未经 `defineSwapFamily()` / `defineProtocolFamily()` 校验的
raw object 偷渡成生产插件。

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
    const results = await input.policy.executeRequests({
      stage: "identity",
      familyId: input.family.manifest.familyId,
      candidateKey: input.family.discovery.candidateKey(input.candidate),
      source: input.source,
      generation: input.policy.generation,
      requirements,
      requests,
    });
    evidence = input.variant.decode({ step: context, results });
    executedSteps++;
  }
}
```

Family 不能控制无限 retry、deadline 或并发，也不能通过 request builder 直接调用 backend。`rejected` 只能来自
成功取得并解码的负面行为证据；RPC/deadline/resource failure 是 `unresolved`，不能缓存成永久负身份。

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
```

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

中央 Graph 只保存通用 route 字段和 `bindingRef`；协议字段留在 family-owned descriptor closure。不要把
`v4Hooks`、`curveI/J`、`dodoActor` 等字段逐个塞进中央 `TokenEdge`。

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
    buildDependentRequests?(input: {
      readonly current: CurrentPricingInput<PricingDescriptor, Route>;
      readonly completedRound: number;
      readonly priorResults: readonly AdapterRequestResult[];
    }): readonly AdapterRequest[];
    decodeSnapshot(input: {
      readonly descriptor: PricingDescriptor;
      readonly results: readonly AdapterRequestResult[];
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

所有 Adapter 函数必须同步、确定性、无 I/O。`buildDependentRequests` 是可选的 bounded protocol step，
不是 Adapter 自己循环到满意为止。

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
  sharedBindings: readonly FamilySharedBindingRef[];
  source: CanonicalSource;
  executor: BoundedRequestExecutor;
}): Promise<CompiledStateInstance> {
  const pricing = input.family.pricing;
  const staticProjection = pricing.staticBindingProjection({
    descriptor: input.group.instanceDescriptor,
    routes: input.group.routes,
  });
  const schemaInputFingerprint = hashCanonical({
    key: input.group.key,
    pricingCapabilityHash: input.family.hashes.pricing.contentHash,
    staticProjection,
    sharedBindings: input.sharedBindings
      .map((item) => [item.bindingKey, item.fingerprint])
      .sort(([a], [b]) => a.localeCompare(b)),
  });

  if (input.previous?.schemaInputFingerprint === schemaInputFingerprint) {
    const staticEvidenceReusable = await input.executor
      .proveStaticEvidenceReusable({
        familyId: input.family.manifest.familyId,
        program: pricing.staticEvidence,
        previous: input.previous.staticEvidenceProof,
        source: input.source,
      });
    if (staticEvidenceReusable) return input.previous;
  }

  const draft = pricing.compileDraft({
    descriptor: input.group.instanceDescriptor,
    stateKey: input.group.rawStateKey,
    routes: input.group.routes,
  });
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

  return sealCompiledStateInstance({
    key: input.group.key,
    schemaInputFingerprint,
    instanceFingerprint: hashCanonical({
      key: input.group.key,
      schemaInputFingerprint,
      staticEvidenceFingerprint,
    }),
    snapshotCompatibilityFingerprint: hashCanonical({
      pricingCapabilityHash: input.family.hashes.pricing.contentHash,
      projection: pricing.snapshotCompatibilityProjection({
        descriptor: input.group.instanceDescriptor,
        routes: input.group.routes,
      }),
    }),
    staticEvidenceProof: executedStaticEvidence?.reuseProof ??
      noStaticEvidenceReuseProof(input.source),
    descriptor,
  });
}
```

中央只 hash 自己知道的 canonical projection 和可信 transport evidence，不序列化 Adapter 的 opaque descriptor。
复用 previous descriptor 还必须满足 static evidence 的 `reusePolicy`：`source-local` 每次重跑；
`immutable-code` 只有 code hash/proxy implementation 和 capability hash 均未变化时复用；`dependency-proof`
由中央在当前 source 检查依赖 fingerprint。Family 不能把可变链上值命名成 static 后永久缓存。

### 11.3 generation 调度与失败隔离

本节的 diff、实例复用、失败隔离和 CAS 不是未来假设，ds 已经由 `buildGraphChangeSet()`、
`prepareInstanceFamily()` 与 `prepare()` 实现。下面伪代码把现有机制映射到终态接口，省略的主要是当前
`assembleCompiledFamily()` facade。

```ts
async function preparePricingGeneration(input: PricingGenerationInput) {
  const groups = groupRoutesByFamilyAndStateKey(input.graph, input.catalog);
  const changeSet = diffStateInstances(this.publishedGroups, groups);
  const staged = new Map(this.compiledInstances);

  for (const removed of changeSet.removed) staged.delete(removed.key);

  const settled = await runBoundedPerInstance(
    [...changeSet.added, ...changeSet.changed],
    async (group) => compilePricingInstance({
      family: input.catalog.forFamily(group.familyId),
      group,
      previous: this.compiledInstances.get(group.key),
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
  this.commitAtomically({
    graph: input.graph,
    groups,
    compiledInstances: staged,
    snapshots: stagedSnapshots,
  });
}
```

实现时要保留 ds 已验证的两层状态：

- **content cache** 可在 family controller 未 abort 且 compile 成功后提前保存，以免一个 40–50 秒 compile 被连续
  supersede 后每代重做；它只按内容/指纹复用，不代表该 generation 已发布。
- **authoritative pointer**（topology、active specs/descriptors、state/mids/coverage）只能在 source canonical CAS 与
  generation fence 后一起切换；late/foreign fingerprint 结果不能进入 publication。

所以“原子发布”不等于禁止一切预热缓存，而是禁止未通过 fence 的 generation 改变权威可见状态。终态 compiler
也必须维持这一差别。

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

## 12. Exact：拆成 requirements / requests / decode

冻结 ds 当前仍由 `RouteLegAdapter.quoteExact(ctx)` 接收 `ExactQuoteContext.state` 并返回 Promise；pinned reth quote
backend 已把物理 call/simulation batch 放入共享 scheduler 的 `exact` lane，但 Adapter API 本身仍能隐藏读取次数、
caller/source dependency 和内部 retry。终态删除任意 `async quoteExact(ctx)`，统一合同是：

```ts
export interface ExactQuoteSemantics<Descriptor, Route, Evidence> {
  requirements(input: ExactQuoteInput<Descriptor, Route>): RequestRequirements;
  buildRequests(
    input: ExactQuoteInput<Descriptor, Route>,
  ): readonly AdapterRequest[];
  decode(input: {
    readonly programInput: ExactQuoteInput<Descriptor, Route>;
    readonly results: readonly AdapterRequestResult[];
  }): ExactQuoteResult<Evidence>;

  /** 纯本地数学 Family 可提供，并让 buildRequests 返回空。 */
  quoteLocal?(input: ExactQuoteInput<Descriptor, Route>): ExactQuoteResult<Evidence>;
  cacheCompatibilityProjection(input: ExactQuoteInput<Descriptor, Route>): CanonicalValue;
}
```

中央调用：

```ts
async function refineCandidate(input: RefineCandidateInput): Promise<RefinedLeg> {
  const family = input.catalog.ownerOfRoute(input.route);
  const exact = family.exact;
  const quoteInput = bindExactInput({
    route: input.route,
    descriptor: input.instanceDescriptor,
    amountIn: input.amountIn,
    source: input.source,
    executor: input.executor,
    runtimeEvidence: input.runtimeEvidence,
  });

  const cacheKey = exactCacheKey({
    exactCapabilityHash: family.hashes.exact.contentHash,
    instanceFingerprint: input.instanceFingerprint,
    routeBindingFingerprint: input.route.bindingRef.fingerprint,
    amountIn: input.amountIn,
    sourceOrCarryProof: input.sourceOrCarryProof,
    executor: input.executor,
    runtimeEvidenceHashes: input.runtimeEvidence.map((item) => item.evidenceHash),
    compatibility: exact.cacheCompatibilityProjection(quoteInput),
  });
  const carried = input.exactCache.getCompatible(cacheKey);
  if (carried) return carried;

  const result = exact.quoteLocal
    ? exact.quoteLocal(quoteInput)
    : (await executeAdapterWork({
        intent: {
          stage: "exact-refine",
          familyId: family.manifest.familyId,
          instanceKey: input.route.instanceKey,
          routeKey: input.route.routeKey,
          source: input.source,
          generation: input.generation,
          program: exact,
          programInput: quoteInput,
        },
        runtime: input.adapterRuntime,
      })).evidence;

  input.exactCache.publish(cacheKey, sealExactResult(result));
  return result;
}
```

“把 exact refine 结果更新到 carry”需要区分两种数据，冻结 ds 已经实现了其中一种：

|数据|兼容边界|中央目的地|
|---|---|---|
|完整 exact quote|绑定 amount、route binding、instance fingerprint、exact capability hash、source/mutation proof、executor 与 runtime evidence|exact cache；只能为兼容 exact request 复用|
|由 exact probe 推出的 scalar mid|只用于同一 canonical source 的对应 edge，且 producer 尚未发布更新 source；不携带完整 amount/caller-sensitive quote 语义|coarse recovery-base mid feedback|

ds 的 `BlockScanStateCoordinator.adoptExactProbeMids()` 已实现第二条：调用方先通过 source canonical CAS，coordinator
再检查 newer publication、edge→stateKey、Family/base、已有 edge 和有限正 mid 后，才替换 `lastGood` 中该 edge 的
mid。它是中央 scheduler/coordinator 所有的安全反馈，不是 Adapter 私改 snapshot。

终态应保留这条能力并为它生成独立 receipt；不能把完整 exact amount-out 对象直接塞进 coarse carry，也不能让
Adapter 自行写 exact cache/global recovery base，否则 caller-sensitive、hook-sensitive 或 tx-bound quote 会被错误复用。

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
    readonly amountOut: bigint;
    readonly exactEvidence: ExactEvidence;
    readonly executor: string;
    readonly runtimeEvidence: readonly RuntimeEvidence[];
  }): PlanFragment;

  /** Family 声明效果语义；中央 final sim 计算并验证实际效果。 */
  expectedEffects(input: ExecutionEffectInput<Descriptor, Route>):
    readonly ExpectedEffect[];
}
```

`buildFragment()` 必须同步、纯函数，只生成：

- approve/transfer 等通用 requirements；
- family-owned route-root ActionAdapter 节点；
- family-specific calldata 参数和 evidence ref；
- 可供中央守恒检查的 expected effects。

ActionAdapter 只负责低层编码/解码，不负责 discovery、identity、quote、solver 或 final sim。Route-root action
必须由唯一 Family own；approve/transfer/assert-balance 一类经过中央声明的基础动作才可作为 shared infra。

中央调用上下文：

```ts
function buildCandidatePlan(input: BuildCandidatePlanInput): CandidatePlan {
  const fragments = input.refinedRoute.legs.map((leg) => {
    const family = input.catalog.ownerOfRoute(leg.route);
    const fragment = family.execution.buildFragment({
      descriptor: leg.descriptor,
      route: leg.route,
      amountIn: leg.amountIn,
      amountOut: leg.amountOut,
      exactEvidence: leg.exactEvidence,
      executor: input.executor,
      runtimeEvidence: leg.runtimeEvidence,
    });
    input.actionOwnership.assertFragmentOwned(family, fragment);
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
      buildDependentRequests({ current, completedRound, priorResults }) {
        if (completedRound > 0) return [];
        const state = decodeUniV3CoreState(priorResults);
        return current.routes.flatMap((route) =>
          buildUniV3PrecisionRequest(current.descriptor, route, state)
        );
      },
      decodeSnapshot: ({ descriptor, results }) =>
        decodeUniV3Snapshot(descriptor, results),
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
    requirements: () => ({ transports: ["eth-call"], caller: "executor" }),
    buildRequests(input) {
      return [buildUniV3QuoterRequest({
        quoter: input.descriptor.precisionQuoterBinding.quoter,
        tokenIn: input.route.tokenIn,
        tokenOut: input.route.tokenOut,
        fee: input.descriptor.fee,
        amountIn: input.amountIn,
        from: input.executor,
      })];
    },
    decode: ({ programInput, results }) =>
      decodeUniV3ExactQuote(programInput, results),
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
        minAmountOut: input.amountOut,
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
|`LEGACY_PRODUCTION_ADAPTER_FAMILIES`（20）+ scanned modules（2）|双入口迁移态|自动 branded module catalog|逐 Family 移入 tracked module；最后删除 legacy 数组、`baseFamilies` loader 参数和 raw module contract|
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
|`RethTransportScheduler` + `LiveRethReadPriority`|物理 permit/lane/reserve 已实现|统一 work-intent scheduler|在现有 scheduler 上补 stage policy、fairness、dedupe/fence/final-sim pool；不另建 Family scheduler|
|`quoteExact(ctx.state)` + pinned exact lane|transport 部分中央、语义 API 仍胖|Exact requirements/buildRequests/decode|逐 Family 拆 request shape；删除 StateBackend-bearing exact callback|
|`adoptExactProbeMids()`|ds 已实现的安全 coarse feedback|中央 exact cache + coarse-mid feedback 两类合同|保留并补 receipt/hash；不让 Adapter 直接写 cache/base|
|`buildPlanFragment(ctx.state): Promise`|ownership 已中央、plan API 仍可读链|纯 `execution.buildFragment()`|前移所有 evidence reads；删除 state 与 Promise 签名|
|`PendingExecutionEvidence`、V4/Angstrom 等 typed fields|正确语义分散在不同 context|`RuntimeEvidence` / `RuntimeRequirement` + opaque payload|无损映射、双写 parity 后删除旧平行字段；中央不增加协议名分支|
|runtime final sim/deadline/fork worker|S5 已中央执行，但未纳入统一资源平面|reserved/independent final-sim pool|接入统一 intent/outcome；保持 mandatory final sim，删除临时旁路调度|

### 18.2 大重构允许的迁移阶段

大重构可以批量实施，但 production truth 在任一时刻仍只有一个。推荐阶段如下：

```text
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
   且不存在 legacy base input。
2. `LEGACY_PRODUCTION_ADAPTER_FAMILIES`、`legacy-family` runtime branch、`compileStaticSchema`、
   `extendStaticSchema`、`assembleSchema/assembleCompiledFamily` 和 per-family full schema cache 已从生产 source
   closure 删除。
3. `RouteLegAdapter.buildEdges(...backend)`、`ProtocolDiscoveryContext.backend`、`quoteExact(ctx.state)`、
   `buildPlanFragment(ctx.state)`、`CompileStateInstanceInput.readStatic` 等旧 I/O 入口已删除；boundary gate 证明
   Family 无 raw RPC/scheduler/cache/final-sim import。
4. 手工 `adapterSchemaRevision`、旧 cache namespace、dual-write/dual-read 与 revision fallback 已删除；只有
   generated capability identities 能创建生产 cache key。
5. batch migration receipt 的结果矩阵覆盖全部 active Family，且不存在非 `pass` 或缺失结果行；cross-family/
   common-Graph gate、held-out negative fixtures 和默认路径 cutover gate 均通过。不能因为旧代码“暂时没被调用”
   就删除证据，也不能因为保留旧代码“方便回滚”而跳过清理。
6. 删除后重新从 clean process 执行 catalog load、cold/warm semantic parity、单实例失败隔离、六步代表性 corpus
   与所需 live gate；结果不能依赖旧 module、旧 cache 文件或旧 runtime flag。
7. rollback runbook 指向上一已验收 commit/build artifact，并证明能重新部署；源码内不保留双实现作为回滚手段。

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
```

`familyIds`、mode、fixture corpus 和允许的 semantic delta 必须在运行前冻结。迁移默认冻结一个 batch cohort；
统一 harness 必须保留逐 Family、逐 instance、逐 stage 结果。一个全局 count/hash 不能替代这些子结论，但也
不能把“有逐 Family 结果”误写成“人工运行 N 次验收”。

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
  readonly changedRoutes: readonly RouteParityMismatch[];
  readonly changedExactQuotes: readonly ExactParityMismatch[];
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
```

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
  readonly legacyActivationInputs: readonly [];
  readonly legacyRuntimeBranches: readonly [];
  readonly oldCacheAccepted: false;
  readonly oldFlagsAccepted: false;
  readonly cleanColdSemanticHash: string;
  readonly cleanWarmSemanticHash: string;
  readonly representativeSixStepReceiptHashes: readonly string[];
  readonly rollbackArtifactRef: string;
  readonly verdict: "pass" | "fail";
}
```

结构扫描/TypeScript compile 用来证明旧 public symbol、imports 和 runtime flag 已删除；clean-process cold/warm replay、
旧 cache/旧 flag negative test、catalog hash 与 representative six-step 用来证明删除后仍能工作。两类证据缺一不可。
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
|新增一个健康 pool|比较前后 instance set|只编译新增 StateInstance；旧 sibling compiler invocation 为零|中央 diff/cache，或 Family projection 不稳定|
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
|coarse 连续 catch-up，同时 discovery backfill 排队|运行多个 generation|coarse 只在物理 reads 占 foreground permit；background watermark 持续推进|中央 lease scope/fair queue|
|一个 Family 产生 exact probe 风暴|并发提交大量 exact work|按 Family/instance 限流、相同 request dedupe；其他 Family 和 final sim 仍有进展|中央 scheduler/resource pool|
|新 head 使旧 generation 过期|旧 work 尚在 queue/in-flight|queued work 取消；迟到结果被 generation fence 拒绝，不能污染 publication/cache|中央 cancellation/CAS|
|一个 tracked production module import/contract 校验失败|clean-process 加载完整 active source set|production catalog 不发布；逐 module issue 可见，且不回退同 ID legacy Family|loader/composition root|
|中央 shared surface 扫描|加载任意新 Family|scanner/planner/solver 无新增 Family ID branch|framework boundary|
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

冻结 ds 不是从零开始：唯一 registry/派生 projections、tracked production module loader、StateInstance B1–B6、
五个 migrated pricing Family、物理 request/batch scheduler、coarse lease 修复与 exact-mid feedback 都应直接作为
新架构地基。它也不是终态：20 个 legacy 激活、raw backend/state-bearing Adapter API、14 个 legacy pricing Family、
family facade 和手工 revision 仍需迁移（冻结基线的 22 个 Family 中，19 个属于 swap/protocol pricing，5 个已进入
`state-instance-v1`，其余 14 个仍在 legacy pricing path）。

1. 一套统一 `AdapterFamilyCore` 同时服务 Swap 与 Protocol；生产插件只能通过互斥的
   `defineSwapFamily()` / `defineProtocolFamily()` 两个严格模板进入 catalog。
2. 自动扫描加载 Family **代码能力**；链上实例、pair、route、StateInstance 全由动态扫描和证明产生。
3. Family 插件完整覆盖 Discovery、Identity、Instance、Route、Pricing、Exact、Execution；可选能力省略而非空实现。
4. Identity 支持 factory-child、registry-member、standalone、singleton-subinstance 和 custom variant，并统一经过行为证明。
5. `familyId`、`lineageId`、`instanceKey` 分离；Factory 只作 provenance/lineage，不是准入 allowlist。
6. 中央持有 per-instance descriptor Map；Adapter 不再接收或构造全 Family `schema.pools/groups`。
7. 作者不手工维护 revision；构建生成 capability 级内容 hash，commit SHA 仅作 provenance。
8. Exact custom 能力拆成 requirements/buildRequests/decode；所有 RPC、retry、budget 和 cache 归中央。
9. 所有 Family work 进入同一中央 scheduler；lane、fairness、deadline、batch、dedupe、transport/simulator pool、
   cancellation 与 generation fence 由 framework 决定，permit 只覆盖物理 I/O/simulation。
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
