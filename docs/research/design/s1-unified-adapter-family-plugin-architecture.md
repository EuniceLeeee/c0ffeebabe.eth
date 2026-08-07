# S1 统一扫描驱动的 Adapter Family 插件架构与实现合同

> 状态：**目标架构合同；当前 `main` 仅部分实现。** 本文统一 Swap / Protocol Adapter Family
> 的动态发现、身份准入、实例编译、路线投影、coarse pricing、exact quote、执行片段、特殊协议语义和
> 失败隔离。它是新增或迁移 Family 时的目标规范，不得用本文的目标接口声称当前代码已经完成迁移。
>
> 本文在上述范围内取代旧文档中的中央手写 Family 清单、全 Family `schema.pools/groups`、手工
> `adapterSchemaRevision`、Adapter 内直接 RPC，以及靠具体协议名扩展中央分支等目标设计；并已直接吸收
> 仍有效的 Adapter Replay、`family_local` 与六步验收语义。正式 verdict、promotion 与安全权限仍以上位
> [`gates.md`](../gates.md)、[`HISTORICAL-GAP.md`](../HISTORICAL-GAP.md) 和
> [`templates/six-step-validation.md`](../templates/six-step-validation.md) 为准。旧
> [`adapter-family-extension-boundary-and-six-step-acceptance.md`](../adapter-family-extension-boundary-and-six-step-acceptance.md)
> 仅保留历史背景，不再是新实现或验收入口。
>
> 当前实现参考基线：本地已获取的 `origin/main@78d15664`。其中 production module 自动扫描、
> `AdapterFamilyRegistry` 派生视图、共享 discovery/identity coordinator 已部分存在；legacy 中央清单、
> family-wide pricing schema 和直接异步 Adapter API 仍待迁移。

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

## 2. 核心不变量

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

下面的接口是目标 TypeScript 形态。具体 Family 在泛型闭包内保持强类型；中央注册后只持有受控的 opaque
引用，不把协议字段降级成任意 `Record<string, unknown>`。

```ts
export interface AdapterFamilyPlugin<
  Candidate extends FamilyCandidate,
  Identity extends VerifiedIdentity,
  Descriptor extends CompiledInstanceDescriptor,
  Route extends FamilyRouteDescriptor,
  PricingDescriptor,
  PricingSnapshot,
  ExactEvidence,
> {
  readonly manifest: FamilyManifest;

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
  readonly swap?: SwapDomainSemantics;
  readonly protocol?: ProtocolDomainSemantics;
  readonly optional?: OptionalFamilySemantics<Descriptor, Route>;

  /** 与 Family 一起加载并由 ownership gate 校验。 */
  readonly actionAdapters: readonly FamilyOwnedActionAdapter[];
}

export interface FamilyManifest {
  readonly familyId: FamilyId;
  readonly domain: "swap" | "protocol";
  readonly ownedActionAdapterIds: readonly string[];
  readonly requiredInfraActionAdapterIds: readonly string[];
  readonly allowedTaxonomy: readonly AllowedTaxonomy[];
  /** 稳定语义标识，不是缓存 revision。 */
  readonly supportedLineages: readonly LineageId[];
}
```

插件作者**不填写** `revision: "univ3-v1"` 或 `adapterSchemaRevision`。语义缓存失效由构建阶段生成的
capability content hash 负责，见 §6。

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

### 4.2 所有阶段共用的 Request Program

Identity、instance hydration、pricing、exact 和 runtime evidence 使用同一套 request/result IR。Family 只能
构造 IR 和解码结果，不能拿到 transport object。

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

当前 `production-families/loader.ts` 的 tracked-source module 扫描可以作为迁移基础。目标 composition root
只自动收集插件模块：

```ts
export async function loadFamilyCapabilityCatalog(): Promise<FamilyCapabilityCatalog> {
  const modules = await loadTrackedFamilyModules("**/*.production.ts");
  const generated = await loadGeneratedCapabilityManifest();

  const loaded = modules.map((module) =>
    attachGeneratedCapabilityHashes(module.plugin, generated)
  );

  return buildFamilyCapabilityCatalog(loaded);
}
```

中央不再维护：

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

## 6. Capability 级内容哈希：作者不手工 bump revision

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

## 7. Discovery：selector/topic 只负责候选分流

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

## 8. Identity：多来源 variant，统一行为证明

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

## 11. StateInstance pricing：删除全 Family schema

目标状态不再存在：

```text
schemaMode
compileStaticSchema
extendStaticSchema
assembleSchema
schema.pools
schema.groups
adapterSchemaRevision
```

迁移期间 legacy path 可以作为显式 rollback/oracle 存在，但不能成为目标接口，也不能在单实例失败后自动 fallback。

### 11.1 完整 pricing 合同

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

中央拥有 Map、diff、read execution、batch、deadline、retry、cache、carry、CAS 和 publication。Adapter 不得
通过 `compileDraft()` 保存全族 Map，或在 `finalizePricingDescriptor()` 中扫描 sibling。

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

Adapter 只表达兼容语义；中央验证 mutation completeness、source hash、generation 和 cache fingerprint 后才允许 carry。

## 12. Exact：拆成 requirements / requests / decode

Adapter 不再实现任意 `async quoteExact(ctx)`。统一合同是：

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

所以“把 exact refine 结果更新到 carry”是可取的，但 ownership 必须在中央 exact cache：结果绑定 amount、
route binding、instance fingerprint、exact capability hash、source/mutation proof、executor 和 runtime evidence。
Adapter 不能直接修改 coarse snapshot 或全局 carry；否则 caller-sensitive、hook-sensitive 或 tx-bound quote 会被错误复用。

## 13. 承载和调度特殊语义的通用插槽

特殊协议不是给中央增加 `if (univ4)`，而是给中央增加可复用的**调度类别**，Family 再填入协议 payload。

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

## 15. Domain Policy：一套模板，Swap/Protocol 两种约束

两类 Family 共用 Discovery、Identity、Instance、Route、Pricing、Exact 和 Execution 引擎。差异只在 domain policy：

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

## 16. UniV3 完整实现示例

下面示例展示插件关键上下文，省略 ABI helper 的具体编码实现，但不省略调用链。

```ts
export const uniV3Family = defineAdapterFamily({
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

ERC4626 没有统一 Factory，因此候选来源和标准行为证明必须分离：

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

Pricing/Exact 对 deposit 调 `previewDeposit(amountIn)`，对 redeem 调 `previewRedeem(amountIn)`；Execution 分别
生成标准 `deposit(assets, receiver)` 和 `redeem(shares, receiver, owner)` ActionAdapter 节点。

如果某实例 `previewRedeem()` 返回“资产数量”，但真实 `redeem()` 支付 Silo share、第三种 payout token 或
需要另一组 accounting/plan 节点，它不能被标记为标准 redeem direction。它应由独立
`protocol:erc4626-silo-redeem` Family 证明 payout token、quote 与 execution。这不是“4626 有无 Factory”的差异，
而是执行语义差异。

## 18. 当前 `main` 到目标合同的迁移映射

|当前接口/实现|目标位置|迁移动作|
|---|---|---|
|`LEGACY_PRODUCTION_ADAPTER_FAMILIES`|自动 module catalog|逐 Family 搬入 tracked `*.production.ts`，最后删除中央手写数组|
|`AdapterFamilyRegistry`|`FamilyCapabilityCatalog`|保留唯一 ownership/typed projection 思路；不存链上实例|
|`poolAdapters` / `edgeAdapterIds` 手工投影|route/action ownership projection|由插件 route/action 定义自动派生|
|`discovery.candidateFromAddress/ObservedCall()` 内 I/O|Discovery decode + Identity request program|候选 decode 纯化，RPC 搬中央|
|`discoveryIdentityResolver` / `identityPolicies`|`identity.variants`|Factory/Registry/standalone 统一成多 variant proof program|
|`probeCandidate()` 直接返回 edges|Identity/behavior evidence + `routes.project()`|先归一化 descriptor，再只投影 verified directions|
|`buildEdges()`|`routes.project()`|去除 backend 参数和二次 identity read|
|`quoteExact()`|Exact requirements/buildRequests/decode|Adapter 不再任意异步访问 state/backend|
|`buildPlanFragment()`|`execution.buildFragment()`|保留纯 family plan 语义，显式 runtime evidence|
|`compileStaticSchema/extend/assemble`|per-StateInstance descriptor compiler|中央持有 instance Map，删除全族 facade|
|`schema.pools/groups`|`CompiledStateInstance`|Adapter 每次只接收当前 descriptor/routes|
|`adapterSchemaRevision`|generated capability hashes|删除手工 bump；hash 分 discovery/pricing/exact 等|
|`PendingExecutionEvidence`|通用 `RuntimeEvidence`|保留 source/head/tx 绑定，扩展为协议无关 evidence slot|
|V4/Angstrom/Ekubo 特殊字段散落在 edge/context|InstanceBinding + RouteBinding + RuntimeRequirement|中央只理解调度类别，payload 由 Family 解码|

迁移应按独立 framework slice 和独立 Family slice 进行。某 Family 无法用标准合同表达时，记录确切的通用
framework 缺口；不能在 Family 内私建 scheduler/cache，也不能为了“Family-local”把中央逻辑复制进去。

## 19. 可观测失败：能知道哪个 Family 的哪个 Instance 失败

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

### 20.1 先选择声明，不让一种 replay 冒充另一种证据

|验收轨道|能证明什么|决定性证据|明确不能证明|
|---|---|---|---|
|`family_execution`|Family-owned capability 在 fixture 下正确，尤其是 quote/plan/encoding，且 family-owned diff 可合并|identity/probe conformance fixture；同一 route fixture 的稳定 baseline 未注册或 typed family failure → challenger Adapter Replay pass；Steps 3–6、ownership、conformance、`family_local` 全通过|Adapter Replay 本身不证明自然 discovery、自然排名、生产时效性、部署或 branch cleanup|
|`production_route_stage`|某个历史生产 route gap 已被生产 funnel 自然关闭|target-blind producer 不接收预期 route/amount；同一 causal chain 的 Steps 1–6 全通过|全系统 latency、资源公平性、长期 coverage|
|`systemic_live`|scheduler、queue、cache、rank、candidate distribution、共享热路径或资源策略改善|预先声明的正/负 cohort、相同输入前后对照与 Hermes paired A/B|不能靠单笔六步或单次 Adapter Replay 得出|

`adapter_merge_ready` 与 `production_gap_fixed` 必须分开。一份 route-pinned Adapter Replay 即使包含真实 fork
final sim，也没有执行自然 discovery/enumeration；反过来，route 没进入自然 top-K 也不能推翻已经证明的
Adapter 语义，只说明另有 S2/ranking/runtime gap。

### 20.2 当前六步语义

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

### 20.3 横向架构验收

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
|中央 shared surface 扫描|加载任意新 Family|scanner/planner/solver 无新增 Family ID branch|framework boundary|
|计划 exact 与编码都通过|运行完整 fork final sim|只有还款、守恒、效果和 EV 全部通过才可进入提交判断|中央 S5/S6|

### 20.4 每个 Family fixture 的最小语义面

fixture 数量按行为变体决定，不按机械文件数决定；但每个已声称支持的行为至少覆盖：

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

1. 一套统一 Adapter Framework，同时服务 Swap 与 Protocol；差异由 Domain Policy 和固定 capability slots 表达。
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
