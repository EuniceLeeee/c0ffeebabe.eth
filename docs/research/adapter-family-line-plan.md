# Codex — 轻量 Adapter Family 自动实例接入与 Block-Scan 状态统一计划

> 状态：`implemented_not_validated`。架构实现已落地；严格 tx02、真实 conversion freshness 与
> paired-live A/B 证据尚未取得。
>
> 本文取代同文件上一版 `Universal AdapterFamily Plugin` 设计。Git 历史保留旧稿，但旧稿中的动态 plugin
> catalog、candidate/active/quarantine、promotion receipt、generated import 和独立插件进程不再是目标架构。
>
> 实施基线：`origin/main @ 8aece69787a77561a18f85908eb0142e337f53b3`。计划稿曾在
> `a6c28ccc4196b56e56901c89076ce1185cb660b2` 上完成实施前审查；该 SHA 只用于审查历史，不是本轮
> 实施基线。
>
> 干净实施历史：T0 `5945146` 冻结 trusted blind-run、stage artifact chain、历史样本 contract 与
> paired-live primitive；T1 `059f7c0` 给旧 main pipeline 增加 baseline 六阶段 instrumentation；F 是本
> branch 的单个架构实现 commit。T1 专用 baseline runtime 在 F 树中删除是预期的 producer 翻转，不是能力
> 回退。

## 0. 一句话目标

把已经在 ERC4626 上成立的模式推广到所有执行语义：

```text
人工实现一次 execution family
        ↓
共享扫描器持续发现链上实例
        ↓
family 行为 probe + IdentityAdmissionPolicy
        ↓
自动生成 FamilyInstance 和 verified edges
        ↓
统一 current-N state / quote / plan / final-sim
```

Family 只表达链上语义差异；共享 framework 提供共同实现；静态 registry 明确启用 family；中央
coordinator 负责调度、批处理、时效和故障隔离。

新增一个符合现有 family 的 pool、vault、token 或其他实例时，不修改代码。只有出现无法由现有 family
参数化表达的新执行语义时，才人工新增 family。

## 1. 已决定的边界

### 1.1 保留现有成熟路径

原来的 V2/V3 自动发现池完整保留，不重新实现：

```text
现有 V2/V3 active-pool discovery
        ↓
候选 pool + factory + token0/token1
        ↓
V2/V3 identity 与 fee 验证
        ↓
生成 FamilyInstance
        ↓
统一 graph/state/quote/plan
```

必须保留：

- factory/log 扫描；
- active-pool universe；
- pinned/force-include；
- V2/V3 专用高效状态读取和现有 cache updater；
- provisional factory 准入策略；
- fee-by-factory 与链上 fee 探测；
- 当前已证明正确的 reorg、增量 warm 和 source-block 语义。

不会额外启动一套“通用自动发现”与这些成熟路径重复扫描、重复抢 RPC 或重复写 cache。新架构只是让
V2/V3 discovery 的已准入输出成为 `univ2-standard`、`univ3-standard` family 的实例输入。

ERC4626 已有的 token-domain candidate、链上行为 probe、自动建 deposit/redeem edges 同样保留，并作为
protocol family 自动实例接入的参考实现。

### 1.2 不建立重插件平台

本轮不做：

- 动态加载 family；
- 扫描目录并靠模块副作用注册；
- candidate/active/quarantined 生命周期；
- generated production catalog；
- promotion receipt；
- plugin source-tree hash 治理；
- 独立插件进程或插件沙箱；
- 一套新的 universal kernel 覆盖现有强类型 adapter。

继续使用显式静态 production registry。新增一种执行语义时，允许在 registry 增加一条 family 注册；目标是
不再同时修改 `main.ts`、graph、quoter、plan-builder、warm/state switch、victim dispatcher 等多个消费者，
不是追求“连注册一行都没有”。

### 1.3 Family 可以轻，也可以重

Family 是语义和故障边界，不是文件边界。

- 简单 family 可以只有一个文件；
- 复杂 family 可以拆成 identity、discovery、state、quote、plan、victim 等多个内部文件；
- 对中央 registry 暴露一个 family registration value 即可；
- 不因 capability 分层复制中央 discovery/state/route 子管道。

### 1.4 当前块与性能

- 用于 graph 负判定的 discovery view 必须证明 completeness 覆盖 source block `N`，不存在固定 `T-10`
  许可；
- 用于 pruning、ranking、quote sign、depth 或 funding borrowability 的动态状态必须绑定当前 source
  block number、hash 和 generation；
- 静态 schema、decimals、ABI call descriptor、codehash 可以跨块缓存；
- 动态 mid、reserve、slot0、rate、fee、liquidity 不能靠固定 TTL 冒充当前值；
- “绑定当前块”可以由两种证据成立：
  - `directRead(N)`：直接读取 N；
  - `carryForward(previousSnapshot, canonicalMutationCursor)`：只有 family conformance 已证明所有会改变
    定价状态的 mutation 都被该 cursor 完整覆盖，且 cursor 明确 complete through N 的 canonical
    number/hash/generation 时才允许 restamp。日志缺口、source hash 不一致或 reorg 一律撤销证明并强制
    direct/full refresh。

  该例外用于保留已经证明正确的 V2/V3 incremental warm；不能推广成 protocol/Curve 的通用
  “没有事件所以沿用旧 mid”。
- 性能优化不能靠减边、缩小 universe、目标专用 prewarm、强制 append route 或跳过 slow family。

### 1.5 验收与部署

六步验收是可独立运行的检查项目，不是 A/B 部署脚本的强制启动开关。若 checker 自身有 bug，可以基于原始
六阶段证据人工裁决 checker，不允许把未运行的生产阶段人工写成通过。

固定交易
`0x02a8b803ed975ebc944d61a218c9438f5ae62615969434046a5d53ab4d1966af`
用于本轮 full-graph 六步与耗时验收。原 tx055 因本地 reth 对其 source state 已 prune，已由用户明确批准
替换；不能继续拿只能读 header/tx、不能执行任意 storage 的节点冒充合法 backend。禁止把 tx、pool、
route、amount 或 calldata 写入被测 production closure。

## 2. 概念与边界

### 2.1 PoolIdentity

回答“这个链上实例是什么，凭什么相信”：

```ts
interface PoolIdentity<Params, Proof extends IdentityProof> {
  protocolLabel?: string;
  factory?: string;
  confidence: "provisional" | "verified";
  identityProof: Proof;
  runtimeParameters: Params;
}
```

Factory、协议品牌、implementation hash、事件 topic 都是身份材料，不直接决定执行 family。

`IdentityAdmissionPolicy` 仍是独立的准入策略，负责是否允许 provisional evidence；它不属于 quote 或 plan，
也不会因为 family 抽象而消失。

### 2.2 ExecutionFamily

回答“怎样发现、定价、编译和验证这种执行语义”：

```text
univ2-standard
univ3-standard
curve-stableswap
dodo-v2
erc4626
wsteth-compatible
self-burn-native
```

一个 family 只对应一种完整执行语义。协议品牌不同不自动产生新 family。

### 2.3 FamilyInstance

FamilyInstance 是行为 probe 已证明属于某 family 的具体链上对象：

```ts
interface FamilyInstance<Params, Proof extends IdentityProof> {
  familyId: ExecutionFamilyId;
  address: string;
  identity: PoolIdentity<Params, Proof>;
  tokens: readonly string[];
  instanceKey: string;
}
```

每个 family registration 绑定自己的 `Params` 与 `Proof` 类型；同一个 family 可以拥有任意数量自动发现的
instances。中央 runtime 只保留必要的公共投影，不把参数降级成 `Record<string, unknown>`。

### 2.4 SharedFramework

Framework 没有独立 family ID，不参加 registry。它只复用已经证明相同的语义。

例如 `ReceiptDepositFramework` 可以复用：

- `asset → receipt` edge 构造；
- approve requirement；
- exact-in 结果检查；
- receipt balance 增加；
- 无 standing position；
- plan/final-sim 约束。

ERC4626、Eigenpie、RockSolid 仍是不同 execution families，因为它们的 identity、ABI、rounding、quote 或
calldata 不同。

### 2.5 ActionAdapter

`ActionAdapter` 继续只负责编码低阶 BotVM action。`approve`、`transfer`、`assert-balance` 等可以是共享
infra；协议专有 action 由对应 family 引用。

低阶 ActionAdapter 不是高阶 execution family，也不负责 discovery、quote 或经济语义。

## 3. 新 family 与新 instance 的判定

### 3.1 已有 family 的新实例

以下情况不新增 family：

- 新 ERC4626 vault；
- 新标准 V2/V3 pool；
- 未知 factory 但行为证明为标准 V2 的 pool；
- 新的 wstETH-compatible wrapper；
- 新的 self-burn-native token。

它们经过 discovery、identity、behavior probe 后自动生成 FamilyInstance。

### 3.2 PanoramaSwap 示例

不会因为名字或 factory 不同默认创建 `panorama-v2`。

若链上证明满足：

- `token0/token1/getReserves` 语义；
- 标准 pair `swap` calldata、recipient 与 callback 语义；
- 标准 reserve accounting 与 `Swap + Sync` post-state；
- constant-product 数学；
- fee 可作为经过证明的实例参数；
- 现有 V2 plan/action 可以直接执行；
- known-good fork sim 成功；

则 Panorama pool 是：

```ts
{
  familyId: "univ2-standard",
  address: panoramaPool,
  identity: {
    protocolLabel: "panorama",
    factory: panoramaFactory,
    confidence: "verified",
    identityProof,
    runtimeParameters: { feeNumerator, feeDenominator }
  }
}
```

Fee 不得默认成 `997/1000`。Fee 不同但能表示成已证明实例参数时，仍属于 `univ2-standard`。

只有差异无法由现有 family 参数化表达时才新增 family，例如：

- quote 不再是标准 constant product；
- fee 由方向、hook 或动态曲线决定；
- swap selector、参数或结算语义不同；
- 必须经过特殊 router、Vault、callback、unlock/settle；
- reserve 不是真实可交易状态；
- victim post-state 或 final-sim accounting 需要不同算法。

边界规则：

> 能表示为现有 family 的已证明实例参数，就复用 family；只影响身份或发现，也复用 family；需要替换
> graph、state、quote、settlement、plan、accounting、victim 或 action 编码算法，才新增 execution
> family。

### 3.3 无法分类

Selector、topic、协议名或相似 bytecode 只能提名 candidate。无法得到唯一 identity 和完整执行证明时：

- 保持 candidate/provisional；
- 不建生产 edge；
- 不猜 V2/V3；
- 不通过默认 fee、默认 router 或 legacy fallback 强行执行。

## 4. 轻量 Family 合同

### 4.1 不替换现有强类型接口

现有 `RouteLegAdapter` 继续是 route family 的主要合同。实现阶段只按需要增加可选能力，不创建一套使用
`unknown` 的平行 kernel。

概念形态：

```ts
interface RouteLegAdapter {
  readonly id: ExecutionFamilyId;
  readonly kind: RouteLegKind;

  readonly identity: IdentityCapability;
  readonly discovery?: DiscoveryCapability;
  readonly blockScanState?: BlockScanStateCapability;
  readonly victim?: ReceiptVictimCapability;

  buildEdges(...): Promise<TokenEdge[]>;
  quoteExact(...): Promise<bigint>;
  buildPlanFragment(...): Promise<PlanFragment>;
}
```

现有字段在迁移期间可以保留；最终是否合并 `readMid/warm` 由逐 family parity 决定，不为了改名重写已经成熟
的 V2/V3 reader。

### 4.2 公共实现与 override

Family 必须显式选择共享实现或提供自己的实现，不能把“字段缺失”解释成猜测默认语义。

```ts
const standardV2Family = defineRouteFamily({
  id: "univ2-standard",
  identity: standardV2Identity,
  discovery: existingV2Discovery,
  graph: standardV2Graph,
  state: existingV2StateCapability,
  quote: standardV2Quote,
  plan: standardV2Plan,
});
```

特殊 family 只替换真正不同的部分：

```ts
const dodoV2Family = defineRouteFamily({
  id: "custom-swap:dodo-v2",
  identity: dodoIdentity,
  discovery: dodoDiscovery,
  graph: dodoGraph,
  state: dodoPmmState,
  quote: dodoPmmQuote,
  plan: dodoPlan,
});
```

### 4.3 修改中央接口的门槛

新增 family 通常只能：

1. 组合共享能力；
2. 在 family 内实现特殊 capability；
3. 在静态 registry 注册一次；
4. 增加 family conformance 与 known-good fixture。

只有现有能力无法表达、并且是多个 family 都可能复用的新通用语义时，才扩展中央接口一次。例如通用的
`simulateValueDelta` quote capability。

禁止为单个 family 在中央代码添加：

```ts
if (family.id === "...") { ... }
```

## 5. 静态 Registry 与派生视图

使用一份显式静态 production family registry。不同消费者从这份 registry 派生只读视图，而不是维护平行
手工清单：

```text
PRODUCTION_FAMILIES
    ├─ discoveryFamilies()
    ├─ routeFamilies()
    ├─ pricingFamilies()
    ├─ victimFamilies()
    ├─ fundingFamilies()
    └─ actionAdapterCoverage()
```

对 route families，registration 直接引用现有强类型 `RouteLegAdapter`。Funding 可以作为同一 registry 中的
typed capability，但不伪装成 route edge，也不进入 swap/protocol price lane。

Startup conformance 至少检查：

- family ID 唯一；
- instance/edge owner 唯一；
- discovery 与 identity resolver 成对交付；
- 按 kind/framework 所需能力完整；
- shared ActionAdapter 与 family-owned ActionAdapter 明确声明，不能按“出现次数”猜 ownership；
- registry-derived views 不漏 active family；
- 任何生产 edge 都能反查唯一 family、instance 和 identity proof。

### 5.1 静态与硬编码的允许边界

“代码里出现 family 名称”本身不是 bug，判断标准是出现位置和用途：

| 位置 | 是否允许知道具体 family/adapter | 规则 |
|---|---:|---|
| `production-registry.ts` | 是 | 唯一显式 composition root；只负责启用 registration |
| family 自己的 identity/discovery/state/quote/plan/victim 文件 | 是 | ABI、selector、数学、canonical singleton 与行为 probe 本来就是协议语义 |
| 低层 `ActionAdapter`/BotVM compiler | 是 | 编译具体 action 必须知道 selector 与 calldata |
| frozen trusted evidence compatibility | 是 | 只允许冻结旧证据词汇，不能进入 production dispatch |
| `main/runtime/scanner/planner/quoter/graph/victim/funding` 共享编排 | 否 | 不得按具体 family、pool adapter 或 edge adapter 做 equality/switch/static map/direct import |

当前 production registry 共 20 个 family：

- 17 个 current-block pricing family：8 个 swap、9 个 protocol conversion；
- 1 个 credit family：`credit:fluid`；
- 2 个 typed funding family：`flash-loan:balancer-v2`、`flash-loan:morpho`。

“全部 family quote > 0”的机器门只适用于前 17 个 pricing family。Credit 与 funding 不伪造 mid：
credit 走自己的 standing-position/risk 合同，funding 走 `FundingStateCapability` 的
borrow/repayment/coverage 合同。

当前仍有 6 个 family-local `declaredVenues`：

| family | owner-local address | 当前身份形态 | 本轮准确结论 |
|---|---|---|---|
| `protocol:goldx` | `0x355C665e101B9DA58704A8fDDb5FeeF210eF20c0` | canonical singleton | 静态 seed；不是自动实例发现 |
| `protocol:metronome-synth` | `0x3364f53cb866762aef66deef2a6b1a17c1f17f46` | canonical singleton | 静态 seed；不是自动实例发现 |
| `protocol:metronome-hgusdc` | `0x365084b05fa7d5028346bd21d842ed0601bab5b8` | canonical singleton | 静态 seed；不是自动实例发现 |
| `protocol:psm` | `0xf6e72Db5454dd049d0788e411b06CfAF16853042` | canonical singleton | 静态 seed；不是自动实例发现 |
| `protocol:rocksolid` | `0x936facdf10c8c36294e7b9d28345255539d81bc7` | canonical singleton | 静态 seed；不是自动实例发现 |
| `protocol:wsteth` | `0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0` | canonical Lido singleton | 静态 seed；当前不是通用 `wsteth-compatible` 自动发现 |

这些地址只能存在于 owner family 的 registration/identity 证明中，中央消费者必须通过 registry 获得。
如果未来要接受同语义的第二实例，必须给该 family 增加候选来源与行为 probe；不能把第二地址继续塞进
`main.ts` 或另一张 allowlist。尤其本文中的 `wsteth-compatible` 是可扩展方向，不得把当前
`protocol:wsteth` 的单例实现误报为已经完成该方向。

当前动态实例来源：

- `protocol:erc4626`：`dex-token-domain + observed-interaction`；
- `protocol:erc4626-silo-redeem`：`dex-token-domain + observed-interaction`；
- `protocol:eigenpie`：`observed-interaction`；
- `fluid-dex`、`credit:fluid`：`dex-token-domain`；
- V2/V3：继续使用成熟 factory/log/active-pool fast path。

`candidateAddressHints` 只增加 clean-start recall。Hint 仍必须经过同一 current-block identity 与行为
probe，不能携带 token、route、quote 或准入结论，因此不等于实例 allowlist。

机器防回归由 `searcher:adapter-family-shared-surface` 承担。它从 production registry AST/runtime
机械取得所有 family/pool/edge/provider ID，然后在共享 live surface 拒绝：

- `if (edge.adapterId === "...")`；
- `switch (family.id)`；
- 以具体 ID 为 key 的中央静态 Map/Object；
- 中央文件直接 import 某个 family module；
- 已废弃 descriptor/parallel registry 的 import。

检测器包含 synthetic bad/good self-test；新增 family 后不需要手工把新 ID 加进 checker。新增中央 live
consumer 时必须同时纳入 shared surface。Family-owned 文件不进入该检查，否则会错误禁止必要的协议语义。

## 6. 自动发现与 Graph

### 6.1 一个共享候选入口

```text
V2/V3 成熟 fast path                         protocol/其他候选
factory-log / active-pool / pinned           token-domain / observed-call /
        / force-include                       canonical-registry
              ↓                                      ↓
现有 V2/V3 identity、fee、probe              共享候选调度器
              ↓                                      ↓
      admitted FamilyInstance                family matcher/identity/probe
                                                     ↓
                                           IdentityAdmissionPolicy
                                                     ↓
                                              FamilyInstance
              └───────────────┬──────────────────────┘
                              ↓
                     verified instances
                              ↓
                    family.buildEdges()
```

协议/其他候选的共享调度器拥有遍历、block/log/receipt/trace 获取、cache、deadline 和并发。Family 只声明
如何筛选候选和证明语义，不能自己再启动后台 scanner。V2/V3 分支直接消费现有 admitted output，不再次进入
通用 matcher/probe。

### 6.2 V2/V3 特殊说明

V2/V3 继续走现有成熟 discovery fast path。共享调度器消费其 admitted pool 结果，不对所有 token 或地址
重复运行通用行为模拟。

未知 factory 可以进入 provisional identity 流程，但必须验证 token/reserve/swap/fee/calldata；不能仅凭
`Swap` topic 或名字直接归类。

### 6.3 GraphView 时效

交给 scanner 的 graph view 必须携带：

```ts
interface VerifiedGraphView {
  id: string;
  sourceBlock: number;
  sourceBlockHash: string;
  generation: number;
  completenessWatermark: number;
  perSourceCoverage: readonly {
    familyId: ExecutionFamilyId;
    sourceId: string;
    sourceFingerprint: string;
    completeThroughBlock: number;
    completeThroughHash: string;
  }[];
  orderedEdgeHash: string;
  metadataHash: string;
  ownershipHash: string;
  edges: readonly TokenEdge[];
}
```

`VerifiedGraphView` 只能由 `createVerifiedGraphView()` 从 ordered edges 与 registry ownership 派生；
`orderedEdgeHash`、`metadataHash`、`ownershipHash` 不是调用方可以任意填写的证明字段。

全局 `completenessWatermark` 只能取全部 active discovery sources 在同一 canonical chain 上的最小
`completeThroughBlock`。任一 source/family fingerprint 改变、hash 不在 canonical chain、或 coverage 未到
source block 时，对应 family 和全局都标 degraded；只能输出 `graph_incomplete` 与正发现，不能输出完整图
`no opportunity`。

## 7. Block-Scan 当前状态能力

### 7.1 Family-owned state capability

实现采用现有强类型 family registration 闭包，不把 family 私有 schema/snapshot 放进共享
`Record<string, unknown>`。当前 production 接口为：

```ts
interface BlockScanStateCapability<Schema, Snapshot> {
  stateKey(edge: TokenEdge): string;
  compileStaticSchema(input: CompileStaticSchemaInput): Schema | Promise<Schema>;
  buildStaticSchemaReads?(input: BuildStaticSchemaReadsInput<Schema>): readonly StateRead[];
  hydrateStaticSchema?(schema: Schema, results: readonly StateReadResult[]): Schema;
  buildCurrentBlockReads(input: BuildCurrentBlockReadsInput<Schema>): readonly StateRead[];
  buildDependentBlockReads?(input: BuildDependentBlockReadsInput<Schema>): readonly StateRead[];
  decodeState(schema: Schema, results: readonly StateReadResult[]): Snapshot;
  deriveMids(snapshot: Snapshot, edges: readonly TokenEdge[]): ReadonlyMap<string, RouteVenueMid>;
  behaviorProvenUnavailableEdges?(
    snapshot: Snapshot,
    edges: readonly TokenEdge[],
  ): ReadonlyMap<string, string>;
  projectBackrunState?(snapshot: Snapshot, source: BlockSource): BlockScanBackrunStateSeed;
  dependencies(edges: readonly TokenEdge[]): readonly string[];
  incremental?: IncrementalStateCapability<Schema>;
}
```

Family 只返回 decode 结果与纯 `deriveMids`；required-read coverage 与 authoritative freshness 由
coordinator 根据 trusted transport result 生成，family 不能自报。下面的 source、mutation、transport、
coverage 类型是该接口背后的语义模型；它们不是另一套待实现 API，也不假设 `calls[i]` 对应 `edges[i]`：

```ts
interface BlockSource {
  number: number;
  hash: string;
  generation: number;
}

interface ChainLog {
  blockNumber: number;
  blockHash: string;
  transactionIndex: number;
  logIndex: number;
  address: string;
  topics: readonly string[];
  data: string;
  removed?: boolean;
}

type StateFreshnessProof =
  | { kind: "direct-read"; source: BlockSource }
  | {
      kind: "carry-forward";
      source: BlockSource;
      previousSource: BlockSource;
      mutationRangeFingerprint: string;
      completeThroughBlock: number;
      completeThroughHash: string;
    };

interface MutationQueryDescriptor {
  addresses: readonly string[];
  topics: readonly (string | readonly string[] | null)[];
  fingerprint: string;
}

interface CanonicalMutationRange {
  fromExclusive: BlockSource;
  through: BlockSource;
  events: readonly ChainLog[];
  complete: true;
  queryDescriptorFingerprint: string;
  canonicalPathFingerprint: string;
  /** Trusted coordinator hashes sources + descriptor + ordered events + canonical path. */
  rangeFingerprint: string;
}

interface FamilyMutationClassification {
  mutationRangeFingerprint: string;
  classifierFingerprint: string;
  changedReadKeysByStateKey: ReadonlyMap<string, ReadonlySet<string>>;
}

interface PublishedFamilyState<Snapshot> {
  source: BlockSource;
  snapshot: Snapshot;
  coverageByReadKey: ReadonlyMap<
    string,
    ReadonlyMap<string, StateKeyCoverage>
  >;
  freshnessByReadKey: ReadonlyMap<
    string,
    ReadonlyMap<string, StateFreshnessProof>
  >;
}

type StateRefreshInput<Snapshot> =
  | { mode: "direct" }
  | {
      mode: "incremental";
      previous: PublishedFamilyState<Snapshot>;
      mutationRange: CanonicalMutationRange;
      classification: FamilyMutationClassification;
    };

interface StateReadPlan {
  stateKey: string;
  reads: readonly {
    readKey: string;
    to: string;
    data: string;
  }[];
}

type StateReadProvenance =
  | {
      kind: "eip1898";
      source: BlockSource;
      requireCanonical: true;
    }
  | {
      kind: "immutable-fork";
      source: BlockSource;
      forkId: string;
    };

interface StateReadResult {
  provenance: StateReadProvenance;
  success: boolean;
  returnData?: string;
  error?: string;
}

interface BlockStateTransport {
  callAt(
    source: BlockSource,
    read: StateReadPlan["reads"][number],
    control: StateCallControl,
  ): Promise<StateReadResult>;

  batchAt(
    source: BlockSource,
    reads: ReadonlyArray<StateReadPlan["reads"][number]>,
    control: StateCallControl,
  ): Promise<readonly StateReadResult[]>;
}

interface IncrementalStateCapability<
  Params,
  Proof extends IdentityProof,
  Schema
> {
  mutationQueryDescriptor(input: {
    schema: Schema;
    instances: readonly FamilyInstance<Params, Proof>[];
  }): MutationQueryDescriptor;

  classifyMutations(input: {
    schema: Schema;
    instances: readonly FamilyInstance<Params, Proof>[];
    range: CanonicalMutationRange;
  }): FamilyMutationClassification;
}

type StateKeyCoverage =
  | { status: "resolved" }
  | { status: "rejected"; reason: string }
  | { status: "unresolved"; reason: string };

interface DecodedFamilyState<Snapshot> {
  snapshot: Snapshot;
  coverageByReadKey: ReadonlyMap<
    string,
    ReadonlyMap<string, StateKeyCoverage>
  >;
}

type CanonicalEdgeId = string & { readonly __brand: "CanonicalEdgeId" };

interface DerivedFamilyMids<Mid> {
  mids: ReadonlyMap<CanonicalEdgeId, Mid>;
  coverageByEdge: ReadonlyMap<CanonicalEdgeId, StateKeyCoverage>;
}

interface BlockScanStateCapability<
  Params,
  Proof extends IdentityProof,
  Schema,
  Snapshot,
  Mid
> {
  stateKey(edge: TokenEdge): string;

  compileStaticSchema(
    instances: readonly FamilyInstance<Params, Proof>[],
  ): Promise<Schema>;

  buildCurrentBlockReadPlans(input: {
    source: BlockSource;
    schema: Schema;
    edges: readonly TokenEdge[];
    refresh: StateRefreshInput<Snapshot>;
  }): readonly StateReadPlan[];

  decodeCurrentBlockState(input: {
    source: BlockSource;
    schema: Schema;
    refresh: StateRefreshInput<Snapshot>;
    resultsByStateKey: ReadonlyMap<
      string,
      ReadonlyMap<string, StateReadResult>
    >;
  }): DecodedFamilyState<Snapshot>;

  deriveMids(
    snapshot: Snapshot,
    edges: readonly TokenEdge[],
  ): DerivedFamilyMids<Mid>;

  dependencies(
    instances: readonly FamilyInstance<Params, Proof>[],
  ): readonly string[];

  readonly incremental?: IncrementalStateCapability<Params, Proof, Schema>;
}
```

`incremental` 不是“无事件就沿用”的默认捷径。Shared coordinator 从同一 canonical source 一次抓取完整
mutation range：family 先声明 address/topic query descriptor，trusted coordinator 负责 canonical range 与
coverage；family 的同步纯函数 `classifyMutations` 再把 logs 映射到 stateKey/readKey。只有通过 §1.4
conformance 的 family 才能收到 `previous + mutationRange + classification`。Family 用 classification
决定本块需直读的 changed stateKey/readKey，并把未变 state 从 previous snapshot 搬入新的 staging
snapshot。Coordinator 不读取 family 私有 cache、不硬编码 V2/V3/V4 event 语义，也不替 family 猜哪些字段
未变。

`fromExclusive` 必须等于 `previous.source`，descriptor/classifier/canonical-path fingerprint 必须匹配，
classification 的 `mutationRangeFingerprint` 必须等于 trusted range fingerprint，changed readKey 不得
carry-forward。Range 不完整、previous/source 不连续、reorg、removed log 或 hash 不一致就把本次 refresh
降级为 direct/full refresh。

`deriveMids` 必须同步、纯函数、无 backend I/O。Conformance 不能只检查“不是 Promise”，还要在断网/毒化
backend 和调用计数器下证明零 I/O。

`stateKey + readKey` 是复合 read identity；结果、coverage 与 freshness 都必须按
`stateKey → readKey` 分层，不能让多个 pool 都叫 `slot0/reserves` 时互相覆盖，也不能用一个 stateKey 级
freshness 冒充“部分 direct-read、部分 carry-forward”都已证明。每个 required `(stateKey, readKey)` 和
edge 都必须显式给出 `resolved | rejected(reason) | unresolved(reason)`；稀疏 Map 缺项自动视为
unresolved，并使 family coverage incomplete。

Decoder 只解释 returndata 并给出 decode coverage；authoritative `freshnessByReadKey` 由 coordinator 根据
trusted transport provenance 或已验证的 mutation range/classification 生成，再组成
`PublishedFamilyState`。Family decoder 不能自报 freshness。

Graph builder 给每条 edge 一次性分配 `CanonicalEdgeId`：

```text
familyId + instanceKey + direction + executionVariantKey
```

`executionVariantKey` 由 family 声明，必须覆盖改变执行语义的 discriminator，例如 V4 poolId、Curve
`i/j`、logical instance 或其他 family-specific route variant；不能只用 target/token pair。Startup
conformance 断言 active graph 内 ID 唯一、同输入稳定，state/mid/coverage、replay 与 A/B 全部复用这一
identity，不再各写一套 `edgeKey()`。

Freshness-bearing read 走独立的 trusted `BlockStateTransport`，不是让 family 自己填写 provenance，也不要求
所有 mutable-fork `StateBackend` 一次性扩大接口。Direct Reth RPC 必须使用 EIP-1898
`eth_call(tx, { blockHash: source.hash, requireCanonical: true })`；Multicall 把外层 aggregate call 绑定到
同一 block hash，多个 batch 也全部绑定同一 hash。标准 `eth_call(blockNumber)` 的响应不携带实际执行
block hash，禁止把请求侧 number/hash 复制进结果冒充 backend 证明。Startup 必须 probe 实际节点是否支持
EIP-1898；不支持时只能使用已经核对 source hash 的 immutable fork，否则该 read unresolved，不能静默
退回 number-only current-state 证明。Coordinator 原子发布前逐 `(stateKey, readKey)` 验证：

- `freshness.source` 与当前 `BlockSource` 的 number/hash/generation 完全一致；
- provenance 由 trusted transport 产生，且其 `source` 等于当前 source；EIP-1898 read 必须成功执行
  `requireCanonical=true`，immutable-fork read 必须绑定已核对的 fork ID；
- carry-forward 的 mutation range `complete=true`、`through` 等于 source，对应 freshness proof 的
  complete-through block/hash 等于 source，且 previous→source 仍在 canonical chain；
- publish 前再次执行 canonical hash + generation CAS；即使 call 成功后发生 reorg，旧 generation 也不得
  发布。

验证失败时该 stateKey unresolved；若 family 支持 direct/full refresh 则执行受 deadline 约束的刷新，否则
该 family 本 generation incomplete。

`dependencies` 默认只用于事件提示、优先刷新和 cache invalidation。只有 §1.4 的
`StateFreshnessProof=carryForward` conformance 已成立时，完整 canonical mutation range 才能证明 N
状态未变；其他 family 不能把“没有事件”当 freshness proof。

### 7.2 Coordinator 职责

一个公共 coordinator 负责：

- 固定 graph version 和 `BlockSource`；
- 按 `(familyId, stateKey, readKey)` 去重；
- 选择现有 V2/V3 fast transport 或去重后的 JSON-RPC batch；远程 RPC 才可按环境选择 Multicall；
- 并发、deadline、AbortSignal、backpressure；
- 每个 family 独立 settled result；
- 跨 family 合批只允许使用能返回逐 call success/error 的 transport；若 transport 只能 aggregate throw，
  必须按 family 分批或在 throw 后做 family-scoped retry/settle，不能把一个 family 的错误扩散到整个 lane；
- generation fence：晚到结果与当前 number/hash/generation 不一致就丢弃；
- 对允许 incremental 的 family，从同一 canonical source 抓取一次完整 mutation range，调用 family-owned
  classifier，并把 `previous + range + classification` 作为显式输入；coordinator 不从共享 production
  cache 暗取旧 snapshot；
- family 结果先写 staging snapshot；全部 required coverage 结束后才逐
  `(familyId, source hash, generation)` 原子交换，任何 updater 不得边 decode 边修改共享 production cache；
- 输出 structured telemetry 和 unresolved reason。

Family 负责：

- 静态 schema；
- 当前块真正需要的 reads；
- decode；
- 本地数学；
- instance dependencies。

本轮遵循 D-007：local reth 默认使用并行 JSON-RPC batch，`aggregate3` 只保留为远程 RPC 可选 transport。
同机实测 45 calls 时 `aggregate3=73.7ms`、并行 direct RPC `=38.6ms`。因此 `<10s` 的主要杠杆是
`(familyId,stateKey)` 去重、并行、Curve 去串行化和 protocol instance-local derivation，不把 Multicall
本身写成性能成果。

### 7.3 V2/V3 不复制实现

Fable 的 V2/V3 shadow code只证明了公式切分形状，不是可直接接 live 的 transport：

- V2 声明只读 `getReserves`，decode 却期待 transport 额外返回 pool/fee/block；
- V3 声明只读 `slot0/liquidity`，decode 却期待完整 `V3Snapshot`。

本计划不搬这两个模块。实现时复用现有 V2/V3 updater 的 batching、read、decode/math、fee、tick 和 reorg
语义，但不保留“边读取边直接写共享 production cache”的发布方式。Updater 先写 family-owned staging
snapshot；required coverage 完整后由 capability wrapper 原子交换。Wrapper 是该 family 唯一 production
publisher，也不能为了包一层 capability 再发第二轮链上 reads。

每个方向的新 `deriveMids` 必须和现有 `readV2WarmMid/readV3WarmMid` 使用同一 snapshot 对拍：
reserve、`sqrtPriceX96`、liquidity、fee、depth、edge/key、coverage 与 unresolved exact set 必须精确
相同；IEEE `mid` 使用 relative tolerance `1e-12`。迁移完成后抽取 canonical pure math，避免长期保留
两份公式。

### 7.4 Curve 与 protocol mids

Curve warm 的工作是读取 coins、balances、A、fee、rates、offpeg multiplier 等定价所需状态。它慢不是因为
Curve 理论上必须比 Uniswap 慢，而是当前存在 schema/current-state 混读、多轮串行和重复 RPC。

Protocol mids 是 ERC4626、wstETH、PSM、Metronome、Eigenpie 等 conversion edge 的粗价格。当前慢因是大量
逐 edge quote，同一实例、同一方向和同一状态被重复读取。

迁移目标：

```text
按唯一 instance/stateKey 生成 current-N reads
        ↓
去重后的并行 RPC batches / 按环境选择 transport
        ↓
family decode
        ↓
本地派生该实例全部方向 mids
```

无法本地派生的 family 才使用 batched view-quote fallback，禁止在 family 内恢复逐 edge 自建 RPC 循环。

## 8. Family-local 故障隔离

### 8.1 结构化结果

中央协调器在 discovery、state、quote、plan、victim、funding 边界统一返回：

```ts
type FamilyStageResult<T> =
  | {
      ok: true;
      familyId: ExecutionFamilyId;
      source: BlockSource;
      value: T;
    }
  | {
      ok: false;
      familyId: ExecutionFamilyId;
      instanceId?: string;
      stage: FamilyStage;
      source: BlockSource;
      reason: string;
    };
```

### 8.2 最小故障范围

| 故障 | 结果 |
|---|---|
| 一个 candidate/instance probe 失败 | 只隔离该实例 |
| 一个 family matcher/state 系统性失败 | 该 family 本 generation incomplete |
| family quote/plan 抛错 | 只拒绝依赖它的 routes |
| victim decode 无法证明 | 该 family unresolved，禁止另一 decoder 猜成 V2 |
| funding state 不完整 | 依赖该 funding source 的计划不可用 |
| healthy family 完成 | 正常发布 current-N 结果 |

存在 incomplete active family 时：

- 全局结果标记 `degraded/incomplete`；
- 依赖 incomplete family 的 route 在 quote 前 fail closed；
- 只依赖 complete families 与 complete funding 的 route 可以继续 final sim/EV；
- 不能把无候选解释为完整图 `no opportunity`；
- strict equivalence/performance acceptance 要求全部 active families complete。

### 8.3 防止“格式正确但语义错误”影响其他 family

类型和异常隔离不能证明协议数学正确。还需要：

- instance/edge/cache 都带 family owner；
- candidate claim 不能覆盖已有 active owner；
- ownership 冲突 fail closed；
- family 级调用、候选和 final-sim 失败预算；
- 连续异常触发 family-local circuit breaker；
- 错误 family 的 routes 不得挤满全局 candidate/refine cap；
- exact quote、known-good fixture 和 final sim 作为语义强门。

错误 family 仍可能使包含它的 route 失败，但不能修改 sibling family 的 graph、state、cache、ownership 或
健康路线输出。

## 9. Quote、Plan、Victim 与 Funding

### 9.1 Quote

所有可定价 route leg 必须显式获得 quote：

- 复用 shared framework quote；
- 或提供 family-owned quote；
- 或声明通用 batched simulation quote。

不存在“没写 quote 就猜一个默认协议”。“没有特殊 quote”表示显式复用共享 quote。

### 9.2 Plan

Family 的 `buildPlanFragment` 返回一棵或多棵高阶 plan nodes。一条逻辑 leg 可以展开成 approve、unlock、
swap、settle、take 等多个低阶 ActionAdapter。

中央 plan compiler 只组合 fragments，不判断协议名。

### 9.3 Victim

Victim capability 使用 receipt 级接口：

```ts
interface ObservedPoolImpact {
  logIndex: number;
  impact: PoolImpact;
  consumedTriggerIds: readonly string[];
}

interface OwnedReceiptTrigger {
  triggerId: string;
  logIndex: number;
  emitter: string;
  topic0: string;
}

type NonEmptyReadonlyArray<T> = readonly [T, ...T[]];

type ReceiptImpactResult =
  | { status: "no-match" }
  | {
      status: "resolved";
      impacts: NonEmptyReadonlyArray<ObservedPoolImpact>;
      consumedTriggerIds: NonEmptyReadonlyArray<string>;
    }
  | { status: "unresolved"; reason: string };

decodeReceiptImpacts(
  receipt,
  matchedOwnedTriggers: readonly OwnedReceiptTrigger[],
  ownedEdges,
  source,
): Promise<ReceiptImpactResult>
```

原因：

- V2 需要关联 `Swap + Sync`；
- V4/Balancer 单例需要按 poolId 匹配；
- 多 swap、多池 victim 必须按 logIndex 还原最终 post-state。

Supervisor 在 dispatch 前必须验证 receipt block number/hash 与 `BlockSource` 一致。`no-match` 只允许表示
family-owned 纯 matcher 得到的 matched trigger exact set 为空；一旦存在相关 trigger，但 decoder
unsupported、throw、缺必要关联 log 或无法证明完整 post-state，必须返回 unresolved。Resolved 必须
non-empty，且所有 impact 的 `consumedTriggerIds` 并集必须与 matched trigger exact set 相等；任何漏消费、
重复消费或未知 trigger 都使整个 family 的 receipt 结果 unresolved。禁止用空数组或部分成功混淆 no-match
与失败，也禁止 topic/Transfer fallback 把未知协议重新解释成 V2/V3。

### 9.4 Funding

Flash/funding 与 route family 使用同一静态 registry 派生视图，但不伪装成 swap edge。Funding capability
负责 current-N borrowability、provider 选择、borrow/repayment plan；全局 final sim 负责 lender
conservation 与 EV。

```ts
interface FundingSource {
  fundingId: string;
  instanceKey: string;
  provider: string;
  asset: string;
  stateKey: string;
  requiredReadKeys: readonly string[];
}

interface FundingOffer {
  fundingId: string;
  asset: string;
  maxBorrow: bigint;
  fee: bigint;
  planningPriority: number;
}

interface DecodedFundingState<Snapshot> {
  snapshot: Snapshot;
  coverageByReadKey: ReadonlyMap<
    string,
    ReadonlyMap<string, StateKeyCoverage>
  >;
}

interface DerivedFundingOffers {
  offers: ReadonlyMap<string, FundingOffer>;
  coverageByFundingId: ReadonlyMap<string, StateKeyCoverage>;
}

interface PublishedFundingView {
  source: BlockSource;
  offers: ReadonlyMap<string, FundingOffer>;
  coverageByFundingId: ReadonlyMap<string, StateKeyCoverage>;
  freshnessByFundingId: ReadonlyMap<
    string,
    ReadonlyMap<string, StateFreshnessProof>
  >;
}

interface FundingCapability<Params, Proof extends IdentityProof, Schema, Snapshot> {
  sources(
    instances: readonly FamilyInstance<Params, Proof>[],
  ): readonly FundingSource[];

  compileStaticSchema(
    instances: readonly FamilyInstance<Params, Proof>[],
  ): Promise<Schema>;

  buildCurrentBlockReadPlans(input: {
    source: BlockSource;
    schema: Schema;
    sources: readonly FundingSource[];
  }): readonly StateReadPlan[];

  decodeCurrentBlockState(input: {
    source: BlockSource;
    schema: Schema;
    resultsByStateKey: ReadonlyMap<
      string,
      ReadonlyMap<string, StateReadResult>
    >;
  }): DecodedFundingState<Snapshot>;

  deriveOffers(
    snapshot: Snapshot,
    sources: readonly FundingSource[],
  ): DerivedFundingOffers;

  buildBorrowFragment(offer: FundingOffer, amount: bigint): ResolvedPlanNode;
  buildRepaymentFragment(offer: FundingOffer, amount: bigint): ResolvedPlanNode;
}
```

Funding 复用同一 `BlockSource`、trusted `BlockStateTransport`、deadline、family-local settled result、
staging 与原子发布；它不经过 `TokenEdge`/mid 接口。Authoritative freshness 由 coordinator 根据 trusted
transport result 写入 `PublishedFundingView`，family 不能在 `FundingOffer` 自报。每个 funding source 的
全部 required `(stateKey, readKey)` 必须 current-N resolved，且 `coverageByFundingId` 必须有 exact entry；
missing source/offer/coverage 自动 unresolved，不能进入 planner。`deriveOffers` 必须同步纯函数，provider
顺序、fee、repayment 语义都来自 capability/registry，不能在 planner 再建第二张表。

不建立单独的 `FlashAdapterRegistry`，也不把 flash 塞进 coarse-price lane。

## 9.5 实施结果与证据台账

| 项目 | 当前事实 |
|---|---|
| typed family registry、current-N coordinator、原子发布、family-local failure isolation | 已实现 |
| V2/V3 成熟 discovery/identity/fee 路径 | 保留并接入统一 family runtime，没有另起重复 scanner |
| Curve、external swap、protocol conversion state | 已接入 family-owned state capability；中央逐 venue warm/mid switch 已移除 |
| receipt-level victim 与 funding view | 已由同一静态 registry 派生；funding 保持独立类型，不建立 `FlashAdapterRegistry` |
| T0 trusted 工具 | `5945146` 冻结；其 22 个非 package 源码/工具文件在 F 中 byte-identical |
| T1 baseline instrumentation | `059f7c0`；build、baseline runtime、blind contract、production harness 与 scanner 回归已通过 |
| T1/F blind evidence vocabulary | F 只在验收输出层投影 T1 冻结的 edge/family/state/graph 口径；production 继续使用 richer family/instance identity；跨版本冻结测试通过 |
| F build/focused conformance | 本地 build 与 focused suite 已通过；详见下方记录 |
| tx02 六步语义与 p95 `<10s` | 冻结 full-graph diagnostic 已到 final sim 且 EV 正确 reject；该次仍用了 forced probe，只是定位证据，不是 strict natural-selection pass；20 轮 p95 未跑 |
| conversion freshness | harness 已实现；真实冻结样本证据缺失 |
| V2/V3 parity | local-reth + frozen production universe 连续块 artifact 已通过；forced-reorg/invalidation 由同一 artifact 绑定的 synthetic harness 覆盖 |
| paired live | trusted primitive/unit test 已实现；真实 A/B window 未跑 |
| 中央 family hardcode | 本地 AST conformance 已覆盖 21 个共享 live 文件、20 个 registry family；当前无具体 family ID dispatch |
| hunt quote coverage | 已改为从 registry 枚举全部 17 个 pricing family；不再手列 ERC4626/wstETH/PSM/Metronome 四类 |
| family-local 静态实例 | 仍有 6 个 `declaredVenues`；见 §5.1，不能误报为自动发现 |
| 总状态 | `implemented_not_validated` |

F0 的 activation continuity fixture 仍锚定 `040a9cc`；`040a9cc..8aece69` 的 `listener/` tree 无差异，
所以它仍能证明该段 activation 语义连续。但它不是完整 F0 生产证据，不能替代当时 production universe、
V2/V3 warm-state hash、stage timings、RPC/call/batch 分布或 strict tx02 raw artifact。

2026-07-24 最终本地验证已通过 TypeScript build、boundary lint，并覆盖：

- registry activation/shared-surface/route-adapter closure 与 Fluid token-order execution identity；
- current-N state backend/coordinator/runtime、swap/protocol families、V2/V3 incremental + shadow parity；
- discovery watermark/backfill/publication/reorg/cancellation、instance discovery 与 family isolation；
- DODO、Fluid、Curve、Balancer、victim、funding、planner、scanner/refinement 与 replay fixtures；
- T0 v2 artifact chain、challenger stage-boundary immutability、trusted blind harness/content-addressed
  fail-closed、T1/F canonical compatibility、conversion freshness harness 和 paired-live primitive。

这些是实现与合约测试，不提升下方其余真实证据的 `missing` 状态。

节点近期真实 parity 证据：

```text
tested_runtime_commit=951f84bca8688ba8a49e8753b50e4f5eb47fc28b
tested_listener_tree=bd52ac2cecbf61089dcfde733dae6baca1954be5
local_reth_blocks=25599469..25599480
production_universe_sha256=3307bc17bda3a4efa8e88dfbabb32657cc9a7405975feab955e8462e4eea3333
production_universe_rows=12989
selected_pools=4 (V2=2,V3=2)
change_coverage=changed-and-unchanged
failures=0
artifact_sha256=740ac8337ed4a0bf4c0581e6b4db93980d4302f9ba847b63c786efec0e97f98c
artifact_path=/opt/MEV-runtime/evidence/v2-v3-shadow-951f84bca8688ba8a49e8753b50e4f5eb47fc28b.json
```

这次直接验证最终实现的 `listener/` tree：只在临时 detached checkout 读取节点 local reth；没有重启
A/B、改变 running universe 或触发 searcher warm，命令结束后临时 checkout 已自动清理，生产 A 仍运行
原部署 commit。Artifact 还绑定 `v2-v3-incremental-state` 的 forced same-height reorg、V3
Mint/Burn/tick invalidation 和 missing-log full-refresh 证据。最终文档收口 commit 只修改本文件；
其 `listener/` tree 必须继续等于上面的 `tested_listener_tree`，否则这份 parity 证据失效。

## 10. 实施顺序

### F0 — 冻结基线

- 从当前 production registry 自动生成 active family/instance/edge/action/funding inventory；
- 封存 V2/V3 discovered pool set、identity、fee、ordered graph 和 warm-state hashes；
- 封存 tx02 与代表性 family fixtures；
- 记录当前 full-graph stage timings、RPC/call/batch 数和 incomplete 分布。

不手写第二张 inventory。

### F0.5 — 先落 trusted blind-run 工具

在 challenger 开始修改 production closure 前，先用独立 tooling commit 把以下工具落入共同
trusted base/main 并冻结 SHA：

- 六阶段 runner；
- sealed-oracle builder；
- comparator；
- conversion sentinel 的 eligibility/seed/salt commitment builder；
- 未提前披露邻块/held-out block 自检。

这些工具只消费 production entry 的原始输出，不替 searcher 枚举、报价、编译或 sim；challenger diff
不得修改。若 checker 后续暴露 bug，修复也必须先作为独立 tooling change 进入共同 base，再重新冻结
baseline/challenger，不能在被测分支里边测边改 oracle。

### F1 — 最小接口扩展

- 在现有 adapter 类型增加可选 `blockScanState`、victim/funding 所需的最小 typed capability；
- 从现有静态 registry 派生 runtime views；
- 加 startup conformance；
- 不改变 production 调用路径。

### F2 — Shadow State Coordinator

- 建 current-N shared coordinator；
- 使用真实 block number/hash/generation；
- 实现 per-family settled result、deadline/cancel 和 late-result fence；
- shadow 输出不能影响 production graph、mid 或排序。

### F3 — 包装现有 V2/V3

- 不重写 discovery；
- 复用高效 updater 的 batching/read/decode/math，不复用原位 partial commit；
- 把现有 admitted pools、warm snapshots 和 mid readers接入 capability；
- 结果先 staging，coverage 完整后原子交换，由 capability wrapper 成为唯一 publisher；
- 运行 transport/decode 与纯数学两层 parity；
- 运行连续多块 incremental parity；测试窗口必须同时包含 changed/unchanged pools 和一次强制 reorg，
  逐块比较 snapshot、freshness proof、mid 与 unresolved set；
- shadow 与 production pool/edge/state exact-set 相同后，逐 family 翻转 owner。

同一个 family 在任一时刻只能有一个 production state owner；禁止新旧两条路径同时发布。

### F4 — Curve 与 external/protocol mids

- Curve 分离静态 schema 与 current-N dynamic state；
- DODO/Balancer/其他 external swap 接入 family state；
- ERC4626/wstETH/PSM/Metronome/Eigenpie 等 conversion 按唯一实例 batch；
- 无法本地派生的才走公共 batched view quote；
- 删除已迁 family 在 `main.ts` 的对应 switch。

### F4.5 — Victim 与 funding 接线

- 把现有 receipt-level `SwapObservationCapability` 接入 registry-derived victim view，显式传
  `BlockSource`，保留 logIndex 顺序，并让 observer throw/unsupported 产出 unresolved；禁止 legacy
  topic/Transfer fallback 重新解释；
- 把现有 flash provider descriptors 收进同一静态 registry 派生的 funding view；保留 funding 与 route
  edge 的类型边界，不建立 `FlashAdapterRegistry`，不进入 coarse-price lane；
- funding current-N state 接入 shared transport/staging，旧 liquidity cache 与新 funding capability 比较
  provider exact set/order、borrowable amount、fee、freshness、borrow/repayment fragment 和 calldata；
- victim/funding 均先做 shadow parity、ownership conformance 和 family-local failure injection，再逐
  family 翻转 production owner；翻转后旧 liquidity/victim owner 不再发布，同一 source 不能双写。

### F5 — 自动实例与故障隔离回归

- V2/V3 原有自动发现 pool set 不变；
- ERC4626 新 vault 继续零代码自动接入；
- 注入 bad instance、bad family、timeout、decode throw、wrong state shape、ownership conflict；
- 证明 sibling family graph/mids/routes/calldata 不变；
- 证明 degraded run 不输出完整负结论。

### F6 — 收口

- 删除所有已迁 family 的 duplicate warm/mid consumer branch；
- 删除失去 owner 的 legacy fallback；
- 保留未迁 family 的原生产路径直到它完成自己的 shadow parity，不能静默减覆盖；
- 生产 `main.ts` 最终只调用 registry-derived coordinators，不含 venue/provider switch。

允许按 family 做 shadow、parity、flip；不允许一个 family 同时有两个生产 owner，也不允许为了切换整条架构
一次性重写 V2/V3 成熟路径。

## 11. 验收

### 11.1 自动发现与身份回归

V2/V3 baseline/challenger 必须比较：

- discovered pool exact set；
- factory、token0/token1、identity confidence/proof；
- fee 参数；
- pinned/force-include；
- ordered graph edges；
- reorg 和 retained-instance 行为。

ERC4626 至少验证：

- 一个未硬编码 vault 由 token-domain candidate 自动发现；
- behavior probe 通过后自动生成 deposit/redeem edges；
- 不修改 graph/main 手工实例表；
- probe 失败实例不进图。

### 11.2 State 与 quote 等价

每个迁移 family 都必须：

1. 使用相同 source block/hash 和相同实例/edges；
2. 旧路径和新路径分别从该 source 独立执行真实 read + decode，比较 snapshot hash、required-state coverage
   hash、source provenance 和 unresolved set，捕获 transport/ABI/decode 错误；
3. 再把同一 canonical snapshot 喂给旧 reader 与新 `deriveMids`，比较两个方向的 mid、fee、depth、
   reserve/rate 和 null/reject 行为；
4. exact quote、rounding、plan fragment、ActionAdapter closure 比较；
5. known-good clean-fork final sim；
6. 记录 state keys、reads、batches、RPC calls 与耗时。
7. 对支持 carry-forward 的 family，在连续 N 块窗口中比较旧 updater 与新 capability；窗口必须包含
   changed/unchanged stateKey、日志缺口 fail-closed 和一次强制 reorg，逐块比较 snapshot/mid/freshness
   proof/unresolved exact set。V3 另外注入 Mint/Burn/tick-word 变化，证明 cursor 能表达 sub-state/readKey
   invalidation，而不是只标一个粗粒度 pool changed。

生产 hunt 另外输出结构化 `ADAPTER_FAMILY_QUOTE_COVERAGE`。它必须由 registry 自动枚举全部 pricing
families，并逐 family 记录 `graphEdges / positiveQuotes / unavailableEdges / unresolvedEdges / wallMs`。
当前合同要求每个 pricing family 在验收 frozen graph 中至少有一条正 current-block quote，且
`unresolvedEdges=0`；不能再用“ERC4626、wstETH、PSM、Metronome 计数都非零”代替完整覆盖。若 frozen
graph 本身缺某个 active pricing family，验收输入不完整，应 fail closed，而不是删掉该 family 的断言。

V2/V3 的整数状态、fee/depth、edge/key 与 coverage/unresolved exact set 精确比较；IEEE `mid` 的固定
relative tolerance 是 `1e-12`。Synthetic changed/unchanged/reorg 测试只证明实现形状，不能替代使用
local reth、production universe 的真实连续块 artifact。

Fable 已证明 V2/V3“公式对拍”的测试形状可行，但其 shadow transport 是占位，不能替代上述真实 pipeline
等价。

### 11.3 Family-local failure conformance

至少注入：

- matcher/probe throw 与 timeout；
- current read 部分失败；
- 一个 family 触发 aggregate transport throw；
- decode/derive throw；
- late generation result；
- source hash mismatch；
- duplicate edge/owner；
- quote/plan/victim/funding failure；
- 一个错误 family 产生大量虚假高利润结果。

断言：

- failed family 本代不可用；
- healthy families 继续 current-N 发布；
- healthy-only routes 能走到 final sim/EV；
- incomplete-dependent routes 不进入 quote；
- 全局标 degraded；
- 无完整图 `no opportunity`；
- sibling graph/mids/rank/calldata hash 不受错误 family 污染。
- aggregate throw 的 family-scoped retry/settle 后，其他 family 的 snapshot 与冻结 healthy-only
  baseline exact 相同。

### 11.4 tx02 严格六步与秒数

固定证据：

```text
tx=0x02a8b803ed975ebc944d61a218c9438f5ae62615969434046a5d53ab4d1966af
base/source_block=25599789
source_hash=0xbdaf5f6640f784373f4e6d644e27dd447f0914db43affbe2f9bc16f7e5bb062a
source_state_root=0xdffdabeabb966c54a3023f332531c0d384d884034a5569318723e621cdf1808e
landed_block=25599790
landed_hash=0x19252e62dcc5e10e53f71bb6948b01083943587622e5e0e170cc215f76b2eed4
landed_state_root=0x5f497472793e3154fc9479accb1a8ec609d1f24fd688776f82614a1e96f737ab
```

目标 tx/route/pools/tokens/amount/calldata 只存在于 trusted oracle/comparator，不能传入被测 searcher。
每次 strict run 先封存一个 lean blind-run manifest，至少绑定：

- baseline/challenger 各自真实 production entry SHA；
- frozen trusted runner、oracle builder、comparator 的 SHA；三者必须先进入共同 trusted base/main，
  challenger diff 不得修改；
- 全部 config loader 完成后的 resolved live config hash；
- production universe、静态 family registry、N-1 GraphView 与 backend identity/hash；
- N-1 base block/hash/root、source N block/hash/root；
- 隔离物化的本地 N backend/clean-fork ID、dynamic-cache generation/reset 与 timed-window
  `non_loopback_upstream_rpc_calls=0` 证据；
- producer argv/env 中 target metadata absence；
- 一个 producer 不可见的 sealed-oracle commitment。

Secret 不写入报告，只记录脱敏 endpoint/provider identity 和 secret-presence hash。

Strict timing 的 backend class 固定为完全本地、已物化的 clean state。Producer 在 timer 前只持有 N-1
GraphView/static cache；trusted runner 另行准备以下两种可验 backend 之一：

1. 持有 N state 的完整本地 archive reth/state DB，并核对 N block hash/state root；
2. 与 N state root 对账、允许任意 EVM execution storage read 的完整 world-state snapshot/DB。

若普通本地 reth 仍保留 N state，可直接作为第 1 类；已 prune 时可以在 timer 外用 verified archive 构建
上述完整本地 DB/snapshot，但不能只按目标 route/pools、access list 或 trace 预取。Content-addressed
exact-call cache 可以均匀物化已知 graph/funding reads，却不能证明 arbitrary EVM final sim 所需的
transitive storage 完整；exporter 对 `finalSimulation` requirement 返回 `unsupported`，strict prewarm
必须 fail closed。Anvil lazy fork、target-derived access list 和 trace-derived exact-call cache 都不是合法
替代。`source_head_seen` 时，runner 才把 N head/log delta 和只读 N backend 原子暴露给 production entry；
这对应 live 节点先执行完 block、再发 newHead，而不是把节点 import 时间算成 searcher 时间。

从 `source_head_seen` 到 terminal，state reads、scanner、quote、plan、sim 与 EV 全部只打本地 backend；
网络出口关闭或由 trusted call counter 断言 `non_loopback_upstream_rpc_calls=0`；loopback 的本地
reth/snapshot/Anvil calls 单独计数并进入性能报告。Final sim 使用该本地 N state 的隔离 mutable clone。
每轮重新建立 producer 的 N-1 dynamic-cache generation，并重新暴露干净的本地 N state，不能复用上一轮
producer 的 source-N cache。这样 p95 测的是 searcher 路径而不是 archive 网络或 lazy-fork 延迟，验收也
不会随本地 pruning 窗口消失。

Expected route、required state-key、priced-edge 与其原始 oracle 只存在 sealed oracle section；producer
raw output 封存前，不能通过 argv/env、文件、API、日志或低熵 hash 读取。封存后 comparator 才 reveal
oracle，并从原始 oracle 和 producer raw output 独立重算结果。`source_head_seen` 由 frozen trusted runner
在第一次向 production entry 交付 source N 时盖章，challenger 不能自行移动 timer 边界。

| # | 阶段 | 通过条件 |
|---:|---|---|
| 1 | discovery/graph/current-N state | timer 内从封存的 N-1 base 处理 N delta；完整 production universe 自然包含三条腿；GraphView completeness 覆盖 N；全部 required state keys resolved |
| 2 | enumeration | 目标 route 自然进入 candidate set并记录自然 rank，不 append |
| 3 | quote/refine | 每腿使用 N 状态，amount 由 solver 搜索 |
| 4 | planner/solver | 自然进入 solve set并生成 plan |
| 5 | clean-fork final sim | production compiler 现编 calldata；记录 success/revert、profit、gas、standing position |
| 6 | EV decision | unchanged production EV 输出 allow/reject 与可复算 reason；允许正确 reject |

Producer 完成并封存 raw outputs 后，trusted comparator 才能读取 oracle 并比较 route、state/edge coverage、
calldata、sim balance delta 与 EV。Producer 必须报告：

```text
selection_mode=production
forced_selection_count=0
```

Producer 禁止在 `source_head_seen` 前预装 `GraphView(N)`、读取或缓存 N dynamic state，或从 oracle
反推出 target-specific condition。Trusted runner 可以按上一段均匀物化完整 N backend，但在 timer 前不得
向 producer 暴露其 handle、state 或 target metadata。冻结后还要用未提前披露的邻块/held-out block 控制，
检测 `25585380`、目标地址或等价元数据分支。

从 `source_head_seen` 到 `ev_decision`：

- 每阶段记录 monotonic `stage_ms` 和 cumulative time；
- steady-process、fresh-source-state 至少 20 轮；
- 轮数与 percentile 算法在运行前冻结；默认使用 nearest-rank
  `ceil(0.95 * sampleCount)`，p95 目标 `<10,000ms`；
- 不在 state ready 后才开始计时；
- `timeout`、`skipped_busy`、`incomplete`、missing terminal 或任何阶段 `not-run/bypassed` 都使该轮
  直接失败，并留在固定 denominator 中；不能删除或记成较短耗时；
- 不预热目标 pools；
- 不复用上一轮 source-N dynamic state；
- 不减图、不强制候选、不放宽 EV/rank/deadline。

如果语义通过但时间未通过，记录：

```text
semantic_status=pass
timing_status=fail
overall=implemented_not_validated
```

保留真实阶段分解后再讨论，不制造假通过。

当前冻结 full-graph diagnostic 证明四腿
`USDT -> PAXG -> GOLDx -> USDx -> USDT` 可以从 production universe 建图、枚举、精确报价、编译并
在 clean fork 成功执行。该次证据不能升级为 strict pass，因为 diagnostic harness 将自然 refine rank
`719` 的目标作为 forced probe 送入 solver；这违反本节 `forced_selection_count=0`。它只能证明
downstream capability，不能证明 production 自然选择。

已取得的定位证据：

```text
tested_runtime=bbaa9dad8777345e9eea5009b84af86ebbe46499
universe_sha256=80c4b8d940d1f029ada3abfdd1825553a88301458cc2599b1337de2b65eba13b
graph_edges=22655
edge_set_sha256=e0e5c79d86c257777fcbaabc7cfc03f8c16a2cb4f5fe46751251af49bf47d00f
coarse_rank=1174/1875
refined_rank=719
probe_margin_bps=156.46869459736865
selection_mode=forced_probe
plan_count=1
final_sim=success
profit_token=USDT
net_profit_raw=499624
gas_used=1664930
calldata_sha256=13540775224ff4ce9c984636354d25eab1e8cad323d008386dc76dbe0857c252
ev_decision=below_ev_gate
ev_reason=correct_reject_under_frozen_policy
state_wall_ms_single_run=9910
log_sha256=17361a04df2c9d8853f3f99607ec9e4ab5dcf9aa28608673bbf9350981364ffb
output_sha256=ba0e742d8c8041b826f0fbd13569e4fc851eca14b8111d82121bdf4f6b091e24
strict_tx02_semantic_evidence=missing
tx02_timing_evidence=missing
blocker=production_natural_selection_and_20_run_denominator_not_yet_run
overall=implemented_not_validated
```

真实 landed tx 与上述 final sim 的执行偏差已单独核对：solver 的 start amount 比 landed tx 高
`0.343543%`，最终毛利润只多 `1` 个 USDT 最小单位，sim gas 比 landed gas 少 `0.131244%`。因此 Step
6 reject 不是 adapter、quote、sizing 或 sim 偏差；冻结 policy 使用 `ETH_USD=3500`、`20%` profit
haircut 和 `2x` gas buffer，而 landed block 的 ETH/USD 约为 `1869.11261`，真实 builder payment 也只有
扣真实 gas 后剩余利润的约 `9.9%`。即使用历史 ETH/USD，只要保留 `20% haircut + 2x gas` 仍应 reject。
验收要求 A/B 的 unchanged EV policy 给出同一 reject/reason，不要求把真实 winner 强行判为 allow。

### 11.5 Conversion freshness

tx02 不覆盖 conversion rate 单块跳变。Conversion sentinel 复用 blind harness：

- challenger freeze 前只封存 eligibility range、predicate/version、最小样本数量、selection algorithm
  以及 trusted seed/salt commitment；
- challenger freeze 后 trusted oracle 才按已封存算法选择并 reveal 一个真实 ERC4626
  donation/harvest/loss 或 wstETH oracle-report 更新块；
- producer 和 production closure 在 raw output seal 前看不到 block、协议、实例、token、rate 或 route
  metadata；seal 后 comparator 才 reveal 并比较。

被选样本必须满足：

- N-1 与 N 使用相同 topology 和静态 cache；
- N 必须发生 fresh stateKey read；
- rate/mid 在 N 当块改变；
- candidate/rank 的因果变化与 trusted oracle 一致；
- 禁止 fixed TTL、synthetic producer override、目标预热或 route append。

没有合格真实样本时如实写 `freshness_evidence=missing`，不能用合成 fixture 冒充链上时效验收。

当前实现状态：

```text
freshness_harness=implemented
freshness_evidence=missing
```

仓库内的 known fixture、synthetic RPC 测试和“代码每块刷新”均不替代 freeze 后由 trusted oracle 选择的
真实链上更新块证据。

### 11.6 Paired live A/B

Baseline/challenger 使用相同：

- live resolved config；
- universe；
- source blocks；
- local reth/backend；
- warmup 与 paired-block 规则；
- EV/submission policy。

比较窗口开始前封存 block-number/time range、warmup/catch-up、共同输入可用性、reorg 处理和 eligibility
规则，以及默认 `absolute_head_coverage_floor=0.95`。未来 block hash 此时尚不存在，不能伪造“预先封存
exact hashes”。独立 trusted header auditor 必须直接订阅本地 canonical source，在每个 newHead 到达后、
向 A/B 任一进程交付前，把 `(number, hash, source generation, observed_at)` 追加到 hash-chained
`eligible_heads` journal；10 秒从这个 `observed_at` 起算。Delivery broker 给 A/B 发送同一个 immutable
envelope，并分别记录 delivery/ack receipt；缺任一侧 receipt 就记该侧失败，不能把 head 删掉。

资格只能由预声明规则决定，任何搜索结果产生后都不能删除或改写 entry；reorg replacement 是新的 source
generation，按已冻结规则处理。窗口结束后，再用独立本地 header source 枚举冻结 block-number range 的
最终 canonical header sequence，与 journal 逐 number/hash 对账；任何 canonical head 缺 journal entry
使实验 invalid，不能缩 denominator。Journal 中按预声明规则纳入的 orphan/replacement generation 也保留。
封存 reconciled journal SHA 后才得到最终 denominator。每个 eligible head 的目标是在 10 秒内产生完整
terminal：

```text
scanner_done(no_candidate)
或
ev_decision(candidate)
```

`skipped_busy`、timeout、incomplete、missing terminal 都使该 head 的 head-coverage 失败，且必须留在固定
denominator。窗口报告显式计算：

```text
head_coverage = on_time_terminal_heads / eligible_heads
```

语义不变部分要求 exact equality；新增已批准实例单列 addition。候选覆盖、完成块数和吞吐不得低于 baseline
的 95%，`challenger.head_coverage` 也必须至少达到 `0.95 × baseline.head_coverage`，并解释所有 per-head
失败；baseline 与 challenger 还都必须达到运行前冻结的 absolute floor。若 baseline 未达 floor，本次结果
只能作为相对诊断，不能完成 live-readiness/合并验收。任何 challenger 独有且重复出现的系统性 failure
category 直接 fail。这个 95% 允许诚实的 live 抖动，但不能删除失败 head、改 denominator 或把失败记成
短耗时。性能结论同时报告 p50/p95、busy/incomplete、calls/batches 和 family 分布。

六步检查不是部署开关；A/B 部署不能因历史样本 checker 不匹配而卡住，但最终合并判定必须有相应的独立
六阶段证据。

T0 已实现 hash-chained eligible-head journal、trusted clock、双侧 delivery/ack/terminal receipt、reorg
generation、final canonical reconciliation、固定 denominator、10 秒与 95% 门；package 命令运行的是该
primitive 的 unit test，不是一次真实节点实验。当前必须记录 `paired_live_evidence=missing`。

## 12. 非目标

本轮不做：

- 批量交易 corpus → missing-family 自动分类；
- 自动生成未知执行语义；
- `self-burn-native` 等尚未批准的新 family 本身；
- 为单笔交易 hardcode pool、route、amount 或 calldata；
- EV、submission、安全门策略放松；
- 为了性能下线 baseline-active family；
- 重新实现 V2/V3 discovery；
- 重插件 catalog/promotion 平台。

## 13. Fable 代码审计后的吸收边界

审阅分支：`fable/adapter-family-line @ 00a3a21`。其四组新增 focused tests 在审阅时通过，但只证明 shadow
结构和 V2/V3 公式，不证明 production transport、自动发现、family isolation 或 live 性能。

吸收：

1. `stateKey → static schema → current reads → decode → pure deriveMids` 的 capability 分界；
2. `(familyId, stateKey)` 去重、current source pinning、failure→unresolved；
3. 从静态 registry 派生 pricing/funding/action views；
4. Flash 作为 funding capability，不伪装 route edge；
5. V2/V3 新旧 reader 双方向、reject case 逐字段等价测试。

不吸收：

1. 新 universal kernel 和大量 `unknown`；
2. no-op pricing、空 identity、空 liquidity read 的 projection；
3. 用 observation topic 替代 V2/V3 factory/log/active-pool discovery；
4. “ActionAdapter 出现两次就是 shared infra”的启发式；
5. 一次 transport throw 使整条 lane unresolved 的 coordinator；
6. 只有计数器、没有 source hash/current-generation 校验的伪 generation fence；
7. read plan 与 decode 输入不一致的 V2/V3 shadow transport；
8. 接受 placeholder 和硬编码 family 数量的激活测试。

因此不直接 cherry-pick任何完整 Fable 模块；只把上述五个设计切片实现在现有 adapter、registry 和成熟
V2/V3路径上。

### 13.1 2026-07-23 实施前计划稿双盲对抗审计

审计对象是本文件在 `origin/main @ a6c28ccc4196b56e56901c89076ce1185cb660b2` 上的改写稿；审查者只读，
没有修改 production code 或 trusted harness。

- Fable 5 首轮找到 3 个 P1：incremental capability 没显式输入 previous/range、number-pinned
  `eth_call` 不能证明 source hash、trusted blind harness 未在 challenger 前落地；
- Codex 独立审查继续找到 mutation 分类 owner、victim/funding typed coverage、historical backend 和 live
  denominator 等可执行性缺口；
- 中间一轮 Fable 先报 `P0=0/P1=0`，Codex 又构造出 5 个 readKey/trigger/source/header 证据反例；这些反例
  没有因先前“通过”被忽略；
- 修订后，fresh Codex closure 与 fresh targeted Fable 5 最终均为 `P0=0/P1=0`。

因此 canonical 稿额外固定了：

1. trusted canonical mutation range + family-owned pure classifier；
2. `(stateKey, readKey)` 级 coverage/freshness 和 coordinator-owned provenance；
3. victim matched-trigger exact coverage，部分成功也 unresolved；
4. funding per-source/readKey current-N coverage；
5. 两类可验本地 historical backend、timed non-loopback RPC 为零；
6. live header journal、双侧 delivery receipt 和最终 canonical sequence reconciliation；
7. challenger 前独立落入 main 的 blind runner/oracle/comparator。

这里的 `P0=0/P1=0` 只表示当时的计划合同没有已知阻断，不表示后来的实现已经通过六步/live 验收。

### 13.2 2026-07-24 实现期三轮对抗审计

按“文档/实现收口前最多三轮”的约束，本轮只做了三次实现期对抗审计，没有以重复审查代替施工：

1. 第一轮发现 trusted harness 与 challenger 同分支生成，无法证明生产者不可见；因此重建为
   T0 `5945146`（先冻结工具）→ T1 `059f7c0`（旧 main baseline instrumentation）→ F（实现）的干净
   历史。
2. 第二轮发现 historical/paired-live 证据仍缺少共同冻结输入、双侧 delivery/terminal receipt 与
   canonical reconciliation；修复落在 T0 trusted tool layer，F 不得修改这些工具。F 中 22 个非 package
   T0 文件继续 byte-identical。
3. 第三轮 `P0=0/P1=1/P2=1`：P1 是 T1 与 F 使用不同的 blind canonical vocabulary，业务等价也会被
   判成 artifact mismatch；P2 是 discovery 在 source-delta 建立前早退时只能由 runner timeout 记失败，
   不会假通过但定位较慢。

P1 的修复严格限制在 blind evidence compatibility projection：

- edge ID、family ID、state key、graph metadata/ownership/source coverage 与 opportunity route 投影到 T1
  冻结口径；
- `protocol:erc4626-silo-redeem`、`credit:fluid`、`fluid-dex` 只在该证据桥中映射回 T1 的合并/compat/
  legacy 表达，production registry 和执行身份不倒退；
- active-family manifest 从当前 registry 机械派生后必须等于 T1 的 17-family fingerprint；inventory
  增减会 fail closed，并要求未来另冻一代 T0，而不是静默隐藏；
- 新增跨版本冻结测试，锁定 T1 manifest fingerprint、代表性 V2 edge ID、graph hashes、state coverage
  与 route step；同时对齐六阶段 evidence 的 `not_evaluated`、`no_plans`、`planner_error`、
  `non_positive_solved_quote`、`solver_error` 语义。

这些修复已经通过 build、blind contract/freezer/production-harness/challenger-runtime 和
`searcher:adapter-family-blind-t1-compatibility`。没有进行第四轮对抗审计。P2 不制造 pass，保留为非阻断
诊断 follow-up；严格 tx02 和 paired-live 仍保持 `missing`，不能由上述单元/合约测试替代。

## 14. 完成定义

只有同时满足以下条件才可以写“完成”：

1. 现有 V2/V3 自动发现和高速状态路径无回归；
2. ERC4626 式 family-once/instance-auto 模式可由其他 family 复用；
3. 新实例不要求修改 `main.ts`、graph、quoter、plan-builder 或 warm switch；
4. 新执行语义通常只新增 family 实现、静态注册和 fixtures；
5. production registry 是 family/runtime views 的唯一高阶来源；
6. 动态 graph/state/quote 绑定当前 source block/hash/generation；
7. Curve/protocol mids 不再逐 edge 串行读取；
8. 单 family failure 不回滚 healthy family，且全局正确标记 degraded；
9. 旧/新 reader、quote、plan、final sim 等价；
10. tx02 六步全部自然执行且 p95 `<10s`；
11. conversion freshness 证据成立；
12. paired live A/B 满足 exact semantic contract 与至少 95% 覆盖/吞吐门；
13. 无 hardcode、减图、目标预热、强制候选或策略放宽；
14. trusted review 未发现中央 venue switch、第二实例 allowlist 或 legacy fallback。

在这些条件完成前，准确状态只能是 `planned` 或 `implemented_not_validated`。

本 branch 当前裁决：

```text
architecture_implementation=implemented
strict_tx02=missing
conversion_freshness=missing
v2_v3_live_parity=pass
paired_live=missing
overall=implemented_not_validated
```

因此本文和 commit message 都不得写 `complete`、`fixed`、`<10s passed` 或 `live-equivalent`。
