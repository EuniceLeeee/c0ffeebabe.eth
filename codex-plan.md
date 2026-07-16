# Codex Plan — Searcher Route-Leg Adapter 架构重构

> 基线：`origin/main@4392ffc59fd4aa593500c6ee4fb83b34fe50340a`  
> 状态：施工计划；第一阶段只做行为等价重构，不引入新的 venue 能力。  
> 目标：让新增 DEX 不再修改 `main.ts`、`token-graph.ts`、`quoter.ts`、`plan-builder.ts` 等核心分发文件，同时保留 unknown factory 的长尾发现能力和 final simulation 的 fail-closed 安全门。

## 1. 结论

当前项目已经有一层可用的 `ActionAdapter` registry，它负责把 `ResolvedPlanNode` 编译成 BotVM action。它不应该被扩成同时负责 discovery、identity、quote、graph 和 warm 的巨型接口。

本次在它上面新增一层高阶 `RouteLegAdapter`。Swap、protocol conversion 和 liquidity conversion
共享最小 route-leg 契约，但保留不同子接口；不能因为都产生 edge 就把所有 leg 硬叫成 swap：

```text
候选池发现
  → 链上身份反查
  → execution-family 行为探测
  → RouteAdapterRegistry.routeLegs
  → graph / quote / plan / warm / impact
  → 现有 ActionAdapter compiler
  → final simulation
```

执行与编码职责如下：

- `RouteLegAdapter`：一种经过验证的执行语义如何建图、报价并生成 plan fragment；标准 V2 clone
  共享 `univ2-standard`，只有执行语义特殊时才新增 family adapter。
- `SwapAdapter` / `ProtocolConversionAdapter` / `LiquidityAdapter`：分别承载纯 swap、协议转换和
  LP mint/burn 的特有能力。
- Flash：继续沿用当前 planner/template + flash `ActionAdapter` 架构，作为 route 外层融资 envelope；
  本次不新增 registry、不迁移、不改行为。
- `ActionAdapter`：执行子树中的单个 action 如何编码成 BotVM opcode。

UniV4 和 Balancer V3 的一条逻辑 swap 会展开成多个 action；保留这两层可以避免把协议语义和 opcode 编码重新耦合。

这也符合冻结的 gap batch `docs/research/reports/tx-gap-1784084501081-batch.md`（input SHA-256
`38336afb798d37009c502676c138eac96c0449eec4231fde1c4e168cc0e969c0`）：排除 2 条 scope-pending 后的
28 条当前目标中，5 条纯 DEX 需要新增 swap family，22 条 DEX-protocol 主要需要
`ProtocolConversionAdapter` / `LiquidityAdapter`，另 1 条标准 V2/V3 应先查 trigger/discovery/ranking，
不能误诊为缺 adapter。

## 2. 目标与非目标

### 目标

1. `main.ts` 不再出现 `curve-exchange-underlying`、`univ2-swap`、`balancer-v3-unlock` 等具体协议分支。
2. graph、quote、plan、warm 通过 `RouteAdapterRegistry.routeLegs` 找到 family 实现；victim 处理通过正交的
   `VictimModelRegistry` 找到 pool-swap 或 oracle-rawtx 模型。
3. 协议身份与执行语义分开：unknown factory 可以保留 `protocol=unknown`，同时使用经过探测的标准 V2/V3 execution family。
4. 每个生产 execution family 在启动时完成 lane 覆盖校验，避免只接入 quote 却漏掉 plan 或 warm。
5. 第一轮迁移保持 scanner 输出、candidate plan、calldata 和逐 wei 模拟结果不变。
6. `main.ts` 最终只承担配置、依赖组装、source 启停和优雅关闭。

### 非目标

1. 第一阶段不新增 DEX，不改变 pool admission，不扩大广播范围。
2. 不重写现有 ActionAdapter compiler。
3. 不在架构重构中顺带修 planner ranking、top-N 或 sizing 问题。
4. 不修改 trusted replay/hunt harness 来制造成功结果。
5. 不把 factory、pool 或 token 实例 allowlist 作为 admission gate。
6. 不重构 flash provider、flash template 或现有 flash `ActionAdapter`。

## 3. 核心领域模型

必须拆开 pool identity、execution family 和 action encoding 三个目前容易混淆的层次：

```ts
type ProtocolId =
  | "unknown"
  | "uniswap"
  | "sushiswap"
  | "curve"
  | "balancer-v3"
  | string;

interface IdentityProof {
  kind: "factory-reverse-lookup" | "registry-lookup" | "code-hash" | "behavior-probe";
  target: string;
  blockNumber: number;
  resultHash: string;
}

interface PoolIdentity {
  protocol: ProtocolId;
  factory?: string;
  confidence: "verified" | "provisional";
  source: string;
  identityProof: readonly IdentityProof[];
}

type SwapExecutionFamilyId =
  | "univ2-standard"
  | "univ3-standard"
  | "univ4"
  | "curve-plain"
  | "curve-underlying"
  | "dodo-v2"
  | "ekubo"
  | "zamm"
  | "balancer-v3"
  | "fluid-dex"
  | `custom-swap:${string}`;

type ProtocolExecutionFamilyId = `protocol:${string}`;
type LiquidityExecutionFamilyId = `liquidity:${string}`;
type CompatExecutionFamilyId = `compat:${string}`;
type ExecutionFamilyId =
  | SwapExecutionFamilyId
  | ProtocolExecutionFamilyId
  | LiquidityExecutionFamilyId
  | CompatExecutionFamilyId;

type ActionAdapterId = string;
```

- `PoolIdentity`：链上来源、factory、置信度和可审计 proof；不决定执行。
- `ExecutionFamilyId`：已经验证的行为/调用语义，用于选择高阶 adapter。PanoramaSwap 之类未知
  factory 在 proof 充分时可以是 `protocol=unknown + executionFamily=univ2-standard`。
- `ActionAdapterId`：BotVM action 编码 ID，例如 `univ4-take`、`univ4-settle`。

这三个概念不要求在 `TokenEdge` 上新增三个可漂移字段。现有 `TokenEdge.adapterId` 是日志、fixture、
analysis 和 planner 共用的稳定序列化键，本次重构不全局重命名它，也不再新增一个
`edge.executionFamilyId` 与它并存。`RouteLegRegistry` 维护经过唯一性校验的
`edgeAdapterId → ExecutionFamilyId` alias 索引：

```ts
interface RouteLegAdapter {
  readonly id: ExecutionFamilyId;
  readonly edgeAdapterIds: readonly string[]; // existing TokenEdge.adapterId values
}

routeLegRegistry.forEdge(edge.adapterId); // alias 必须唯一命中一个 RouteLegAdapter
```

`PoolDescriptor.executionFamily` 只存在于 pool→edge 生命周期，用于选择 `buildEdges` 实现；adapter
产出的 edge 继续使用现有稳定 `adapterId`。`ResolvedPlanNode.adapterId` 才是 `ActionAdapterId`。
若未来要重命名跨系统 edge key，必须作为独立 schema migration，同步修改 listener、fixtures、日志和
analysis consumers；不夹在本次行为等价重构中。

建议的 pool 描述：

```ts
interface PoolDescriptor {
  address: string;
  identity: PoolIdentity;
  executionFamily: ExecutionFamilyId;
  metadata: PoolMetadata;
}
```

### 与现有 TokenEdge safety taxonomy 对齐

所有 `buildEdges` 输出必须通过唯一共享 constructor，由显式 `slotKind` / `protocolAction` 调用
`deriveEdgeTaxonomy` 派生 `edgeKind` 和 `leavesStandingPosition`。adapter 禁止独立赋值或覆盖后两者：

```ts
function createAdapterEdge(input: EdgeInput): TokenEdge {
  const taxonomy = deriveEdgeTaxonomy(input.slotKind, input.protocolAction);
  return { ...input, ...taxonomy };
}
```

constructor 约定不能只靠 TypeScript/CI。每个 `RouteLegAdapter` 必须声明允许的
`slotKind/protocolAction` 集合；registry wrapper 对每次动态 `buildEdges`（包括运行时发现的 unknown pool）
重新派生并验证 taxonomy。提交前 standing guard 再从 `slotKind/protocolAction` 派生安全位，不直接信任
edge 上序列化的 `leavesStandingPosition`。

当前 main 仍会构造 `fluid-vault` credit edge，并有 planner fixture 依赖其存在。为保持 graph 行为等价，
迁移时提供 `compat:fluid-credit` adapter，但 lane policy 永远不授予 production submission；它继续被
standing guard fail closed。未来若 mission 改变，应另立策略、风险和验证合同，不能把 credit 塞进
`SwapAdapter` 或借本次重构放行。

## 4. 高阶 RouteLegAdapter 契约

```ts
type RouteLegKind = "swap" | "protocol-conversion" | "liquidity" | "compat";

interface RouteLegAdapter {
  readonly id: ExecutionFamilyId;
  readonly kind: RouteLegKind;
  readonly edgeAdapterIds: readonly string[];
  readonly allowedTaxonomy: readonly AllowedTaxonomy[];

  buildEdges(ctx: EdgeBuildContext): Promise<TokenEdge[]>;
  buildPlanFragment(ctx: PlanBuildContext): Promise<PlanFragment>;

  // scanner 热路径：只能同步读取本 block 已完成 warm 的 view。
  readonly mid: MidQuoter | null;
  readonly quoteLocal: LocalQuoter | null;

  // solver 定稿路径：允许异步读取 fork/revm/RPC，生产 adapter 必须显式提供。
  readonly quoteExact: ExactQuoter | null;

  // adapter 声明请求、失效来源和结果应用；调度、去重、deadline、reorg 归 coordinator。
  readonly warm: WarmSpec | null;
  readonly victimModels: readonly VictimModelId[];
}

interface SwapAdapter extends RouteLegAdapter { readonly kind: "swap" }
interface ProtocolConversionAdapter extends RouteLegAdapter { readonly kind: "protocol-conversion" }
interface LiquidityAdapter extends RouteLegAdapter { readonly kind: "liquidity" }
interface CompatRouteLegAdapter extends RouteLegAdapter { readonly kind: "compat" }

interface PlanBuildContext {
  edge: TokenEdge;
  amountIn: bigint;
  amountOut: bigint;
  rawOut: bigint;
  executor: string;
}

type PlanRequirement =
  | { kind: "approve"; token: string; spender: string; amount: bigint }
  | { kind: "transfer-to-pool"; token: string; pool: string; amount: bigint };

interface PlanFragment {
  requirements: readonly PlanRequirement[];
  nodes: readonly ResolvedPlanNode[];
}

interface MidQuoter {
  read(ctx: MidReadContext, view: WarmView): VenueMid | null; // no Promise
}

interface LocalQuoter {
  quote(ctx: LocalQuoteContext, view: WarmView): bigint | null; // no Promise
}

interface ExactQuoter {
  quote(ctx: ExactQuoteContext): Promise<bigint>;
}

interface WarmSpec {
  invalidationSources(ctx: WarmInvalidationContext): readonly WarmInvalidationSource[];
  requests(ctx: WarmRequestContext): readonly WarmRequest[];
  apply(result: WarmResult, target: WarmDraft): WarmApplyResult;
}
```

`RoutePlanner` 统一收集 `PlanFragment.requirements`，在共享 approval set 上去重并按腿顺序 materialize
sibling approve/transfer，再追加 fragment nodes。这样 Curve/Fluid 的 approve、V4/Balancer 的嵌套 action
都可表达；adapter 不得直接修改外层 `inner`。`compiler.ts` 仍是唯一调用 `ActionAdapter.encode` 的地方。

`WarmView` 必须绑定 blockNumber。外部 venue 的 `eth_call`、batch quote 或状态读取必须在 prewarm 阶段
完成，`mid.read` / `quoteLocal.quote` 中禁止 I/O、`await` 和隐式 fallback。

`WarmSpec` 不是调度器。唯一的 `BlockScanWarmCoordinator` 负责 full/incremental/reorg 决策、跨 adapter
请求去重、deadline 和 cache restamp/invalidate。第一阶段严格保留 main 当前的 mutable/allow-partial
语义：原子单位是单个 pool/key，best-effort pool 失败不得阻塞整个 block；scanner 只在本 lane 的 required
warm 阶段完成后运行。全局 immutable generation/全请求成功后发布属于独立 correctness change，不混入
行为等价搬移。adapter 不拥有 last-warmed block、TTL 或并发状态。

Victim 语义与 route family 正交，由 `VictimModelRegistry` 提供：

- `pool-swap-overlay`：整组 logs/graph 解码 → post-impact seed → local overlay。
- `oracle-rawtx`：识别 oracle trigger，应用真实 raw tx，再探测 post-victim price；不要求 pool overlay。

backrun 启动校验针对 lane 声明的 victim model 和整条 route，不要求 route 中每个 adapter 同时实现
impact/postImpact/overlay。

可选能力必须显式为实现或 `null`，不能靠方法是否存在来猜测。registry 在启动时按 lane 校验：

- block-scan 生产支持：`buildEdges + quoteExact + buildPlanFragment + final sim` 必须存在；另按该 family
  声明的热路径校验 `mid/quoteLocal/warm`。无外部状态的实现可显式 `warm=null`，不能用空壳方法冒充能力。
- backrun 生产支持：在上面基础上要求 route 绑定的 victim model 可用；oracle-rawtx 与 pool-swap-overlay
  分别验证，不能互相冒充。
- 缺能力时 fail closed，并给出确定的 admission/drop reason。

注册采用显式依赖注入：

```ts
interface RouteAdapterRegistry {
  routeLegs: {
    swaps: RouteLegRegistry<SwapAdapter>;
    protocols: RouteLegRegistry<ProtocolConversionAdapter>;
    liquidity: RouteLegRegistry<LiquidityAdapter>;
    // 只用于重构期保留历史 graph/diagnostic 语义；production lane 永不准入。
    compat: RouteLegRegistry<CompatRouteLegAdapter>;
  };
}
```

这里有意不包含 flash：flash 仍由现有 route 外层 template/provider 选择，并复用低阶 flash
`ActionAdapter`；它不是 `RouteLegAdapter` 子类。

不使用 side-effect import 或目录自动扫描，避免注册顺序和测试隔离不透明。标准 clone 只增加
identity/discovery proof；只有新的 execution family 才增加实现模块和 registry assembly 中一行显式注册。

## 5. Identity admission 与 adapter 分离

`allowProvisionalFactories` 属于准入策略，不属于 swap 执行。将 main 中重复布尔参数集中为：

```ts
interface IdentityAdmissionPolicy {
  unknownFactory: "reject" | "probe";
  unregisteredCurveUnderlying: "reject" | "probe";
}

export const PRODUCTION_IDENTITY_ADMISSION: IdentityAdmissionPolicy = {
  unknownFactory: "probe",
  unregisteredCurveUnderlying: "probe",
};
```

`main.ts` 只注入一份 policy，不出现 Curve/V2/V3 的具体分支。identity resolver 仍负责反向验证链上身份；execution-family probe 决定能否使用通用执行 adapter。

## 6. unknown factory 的长尾策略

unknown factory 可以使用通用 V2/V3 adapter，但必须经过能力探测，不能仅凭事件 topic 判断。

### unknown V2

至少验证：

1. `token0()`、`token1()`、`getReserves()` 可读且返回合法值。
2. `factory()` 可读时，调用 `factory.getPair(token0, token1)` 反查当前 pool。
3. 标准 `swap(uint256,uint256,address,bytes)` selector、callback、calldata 和收款语义与执行计划兼容。
4. 在本地 fork/dry-run 上执行最小行为 probe，验证 token balance/reserve 的方向变化、invariant 和 callback；
   不在 mainnet 发送探测交易。
5. 手续费模型必须有 factory config、verified code 或行为 probe 的证据；未知时不得静默套
   `997/1000`、30bps 或任何默认 fee。
6. 每项 proof 记录 target、block、proof kind 和 result hash；单凭 Swap topic 永远不足以分配
   `univ2-standard`。
7. provisional quote 只能用于候选排序，最终必须由 fork/revm simulation 校正。

### unknown V3

至少验证：

1. `token0()`、`token1()`、`fee()`、`slot0()`、`liquidity()`、`tickSpacing()` 可读。
2. `factory.getPool(token0, token1, fee)` 可用时反查当前 pool。
3. direct pool `swap(...)` 和 callback 语义兼容。
4. tick 数据读取和本地数学路径兼容，否则降级到该 adapter 明确支持的外部/模拟报价。
5. 不默认复用 Uniswap QuoterV2；部分 Quoter 会校验特定 factory。

输出身份示例：

```ts
{
  identity: {
    protocol: "unknown",
    factory: "0x...",
    confidence: "provisional",
    identityProof: [/* reverse lookup + behavior probe hashes */]
  },
  executionFamily: "univ2-standard"
}
```

final simulation 始终是生产提交前的 fail-closed gate。

## 7. 建议目录

```text
listener/src/searcher/venues/
  admission.ts
  identity.ts
  execution-family-probe.ts
  pool-descriptor.ts
  route-leg-adapter.ts
  route-leg-registry.ts
  route-adapter-registry.ts
  victim-model-registry.ts
  swaps/
    univ2-standard.ts
    univ3-standard.ts
    univ4.ts
    curve-plain.ts
    curve-underlying.ts
    dodo-v2.ts
    ekubo.ts
    zamm.ts
    balancer-v3.ts
    fluid-dex.ts
  protocols/
    erc4626.ts
    psm.ts
    rpl-migration.ts
    wrapper-conversion.ts
  liquidity/
    curve-liquidity.ts
```

现有 `listener/src/adapters/*` 保持 action 编码层定位，不搬进 searcher venue 目录。
flash provider/loan 选择、template 和低阶 flash `ActionAdapter` 保持现状，不进入本轮目录重构。

## 8. 六步检查矩阵

同一文件可能跨多个阶段；迁移时按阶段验证，而不是只看文件是否编译。

| 步骤 | 新责任边界 |
|---|---|
| 1 scanner | `DiscoveryRegistry` → `VenueIdentity` → `GraphBuilder` → `OpportunityEnumerator` |
| 2 planner | `PathEnumerator` → `RoutePlanner`；family adapter 产出 plan fragment，`compiler.ts` 才编码 action |
| 3 solver | `QuoteRegistry` → `SizingEngine` → execution-family exact/local quote |
| 4 fork/revm | `RouteEncoder` → `SimulationRunner` → 通用 state backend；backend 不含 venue dispatch |
| 5 EV | 独立 `EvEvaluator`，main 只消费统一结果 |
| 6 replay | 现有 trusted harness；架构 challenger 不得修改输入或成功判据 |

### 步骤 1 — scanner 自发发现

主要文件：

- `listener/src/searcher/active-pool-discovery.ts`
- `listener/src/searcher/build-active-pool-universe.ts`
- `listener/src/searcher/pool-universe.ts`
- `listener/src/searcher/pool-universe-arb-relevance.ts`
- `listener/src/searcher/force-include.ts`
- `listener/src/searcher/pinned-warm-pools.ts`
- `listener/src/searcher/blockscan-view-overrides.ts`
- `listener/src/searcher/venues/capability.ts`
- `listener/src/searcher/venues/identity.ts`
- `listener/src/searcher/venues/curve-underlying.ts`
- `listener/src/searcher/planner/token-graph.ts`
- `listener/src/searcher/detector/blockscan-scanner.ts`
- `listener/src/searcher/detector/blockscan-candidate-refinement.ts`
- `listener/src/searcher/detector/pool-impact.ts`

判据：同一输入 universe 生成相同 graph；目标环由 scanner 自发枚举，不靠手插 edge/path。

### 步骤 2 — planner 生成 plan

主要文件：

- `listener/src/searcher/planner/token-graph.ts`
- `listener/src/searcher/planner/planner.ts`
- `listener/src/searcher/templates/path-template.ts`
- `listener/src/searcher/solver/plan-builder.ts`

判据：重构前后 `candidate_plans` 数量和路径边序一致；plan 子树按 edge 顺序展开。
`RoutePlanner` 负责 requirement 去重和 fragment 组装，`plan-builder` 不再含 family switch；
`compiler.ts` 继续独占 `ActionAdapter.encode`。

### 步骤 3 — quote 与 sizing

主要文件：

- `listener/src/searcher/solver/quoter.ts`
- `listener/src/searcher/detector/blockscan-curve-mids.ts`
- `listener/src/searcher/solver/curve-math.ts`
- `listener/src/searcher/solver/v2-fee.ts`
- `listener/src/searcher/solver/v3-math.ts`
- `listener/src/searcher/solver/v4-math.ts`
- `listener/src/searcher/solver/amount-bounds.ts`
- `listener/src/searcher/solver/amount-propagation.ts`
- `listener/src/searcher/solver/pool-state-cache.ts`
- `listener/src/searcher/solver/pool-state-updater.ts`
- `listener/src/searcher/solver/solver.ts`

判据：每腿 quote 与基线逐 wei 一致；amount search 输入点、输出点和 fallback 路径不变。

### 步骤 4 — fork/revm final simulation

主要文件：

- `listener/src/searcher/solver/plan-builder.ts`
- `listener/src/adapters/*`
- `listener/src/compiler.ts`
- `listener/src/searcher/live-state-backend.ts`
- `listener/src/searcher/live-backends/revm-live-backend.ts`
- `listener/src/searcher/live-backends/rpc-anvil-live-backend.ts`
- `listener/src/searcher/live-backends/hybrid-live-backend.ts`
- `listener/src/searcher/live-backends/victim-overlay.ts`
- `listener/src/searcher/revm-sim-client.ts`
- `listener/src/searcher/solver/victim-apply.ts`
- `listener/src/searcher/solver/post-impact-overrides.ts`
- `listener/src/searcher/solver/final-verify-gate.ts`
- `listener/src/searcher/standing-guard.ts`

判据：calldata 字节一致、模拟成功状态一致、闪电贷归还一致、毛利逐 wei 一致、无 standing position。
`RouteEncoder` 只消费完整 `ResolvedPlan`，revm/anvil/hybrid backend 只执行统一 calldata 和 state overlay。

### 步骤 5 — EV 门

主要文件：

- `listener/src/searcher/solver/solver.ts`
- `listener/src/searcher/main.ts`
- `listener/src/searcher/execution/bundle-router.ts`
- `listener/src/searcher/execution/submission-coordinator.ts`

EV policy 保持全局策略，不进入 adapter。判据使用生产 `netProfit` 和现有 `SEARCHER_EV_GATE` 口径，不增加协议自己的提交判断。

### 步骤 6 — replay/harness

trusted harness：

- `listener/src/searcher/test/planner.ts`
- `listener/src/searcher/test/blockscan-fork-solve.ts`
- `listener/src/searcher/test/blockscan-hunt.ts`

纯重构要求等价，不要求伪造 execution-family flip；harness 在 challenger 中保持不变。unknown factory 新能力另开变更，用同一真实失败样本验证：

```text
not_admitted → path_found → final_sim_success
```

## 9. Strangler 迁移阶段

### Phase 0 — 冻结基线

工作：

1. 等所有修改 graph/quoter/plan-builder/main 的在飞 feature/cherry-pick 已合入、放弃或移出重叠文件后，
   从最新 `origin/main` 建立干净 worktree；不得从当前冲突态或旧 feature branch 起重构。
2. 记录 main SHA、生产 view/universe SHA 和 replay fixture。
3. 为下表每个即将迁移的 execution family 记录 fixture、命令、输入 artifact SHA-256 和基线输出 SHA-256。
4. 运行现有 adapter descriptor、planner、quote/math、final verify 和对应 fork harness。
5. 保存 scanner rings、candidate plans、compiled calldata 和逐 wei profit 作为等价性基线。

验证：现有 harness 全绿；不修改 fixture/harness。缺失的 fixture 必须先在独立 prerequisite
commit 中补齐并合入 main，再重新冻结重构基线，不能由架构 challenger 同时修改 trusted harness。

#### Execution-family 等价性 corpus（开工门，不是建议清单）

表中的“现有锚点”只是候选输入，不等于已经满足开工门；Phase 0 必须实际运行并记录 receipt。
迁移单位是 `ExecutionFamilyId × production lane`，不是模糊的 venue 品牌。每个被迁 family
至少需要一个覆盖 graph → quote → plan → compile → final simulation 的 pinned known-good fixture；
backrun lane 还必须覆盖其声明的 victim model（pool overlay 或 oracle rawtx）。

| execution family | `origin/main` 现有锚点 | Phase 0 状态/动作 |
|---|---|---|
| `univ2-standard` | `blockscan-coffee-f2de7499.json`、`yeti-balancerv1-0ffa9acf.json` 都不是可用成功闭环 | **BLOCKED**：先补真正覆盖 V2 graph→final-sim 的 fixture |
| `univ3-standard` | `rocksolid-balancer-v3-7ce631.json`、`sfrxeth-8756ba5c.json` | 记录 loop fork、逐腿 quote 和 calldata 基线 |
| `univ4` | `blockscan-coffee-f2de7499.json`、`sfrxeth-8756ba5c.json`、`searcher:validate-v4-quote` | 记录 native/WETH、hook、quote 与多 action calldata 基线 |
| `curve-plain` | `sfrxeth-8756ba5c.json`、`searcher:curvemath` | 固定 block；记录 local/on-chain quote 与 loop final sim |
| `curve-underlying` | `searcher:blockscan-hunt-tx149` 包含 underlying 且断言 final sim | 复用该 pinned receipt，并补齐逐腿 quote/calldata hash |
| `dodo-v2` | 尚未在 main；在飞 DODO feature 不属于本重构基线 | **BLOCKED**：feature 独立合入 main 并固定 replay 后再迁移 |
| `fluid-dex` | `searcher:fluid-dex-verify` 只覆盖 plan/calldata/quote | **BLOCKED**：补 final-simulation fixture 后再迁移 |
| `balancer-v3` / `rocksolid` | `rocksolid-balancer-v3-7ce631.json` | 运行 parameterized loop fork，记录四腿 plan/calldata/profit |
| `erc4626` | `sfrxeth-8756ba5c.json`、`searcher:blockscan-fork-solve-f391` | 分别覆盖标准与 Silo redeem 形状 |
| `psm` | `searcher:protocol-loop` | 记录 PSM+Curve 原子闭环与 calldata |
| `wsteth` | `searcher:wsteth-quote` | **BLOCKED**：quote 单测不足，先增加 closed-loop/final-sim fixture |
| `metronome` | `searcher:blockscan-fork-solve-metronome` | 记录 oracle victim 前后反事实和 final sim |
| `goldx` | `searcher:blockscan-hunt-tx149` | 记录 pinned hunt 的 graph/plan/calldata/final-sim 输出 |
| `liquidity:curve` | gap batch 的 Curve LP lifecycle cohort，main 无统一 end-to-end fixture | **BLOCKED**：按 lifecycle family 固定 add/remove LP replay |
| `protocol:rpl-migration` / `protocol:cashiva` / `protocol:goldfish` | 对应 feature 尚未全部在 main | **BLOCKED**：各自先独立落地并固定 replay |
| `compat:fluid-credit` | planner 的 credit absent/present fixtures | 保持 edge/diagnostic 等价，并断言 production submission 继续 fail closed |

#### 并发施工门

1. 同一时刻只允许一个 execution family 迁移 PR；不得把多个 venue/family 迁移堆在同一 branch。
2. 每个 phase 开始时从最新 main 重建基线，并对该 phase 的重叠 execution family/文件实行短期 ownership；
   新 gap-repair 可以继续做非重叠模块，重叠改动必须等待该 phase 合入后再 rebase。
3. 禁止把旧 feature commit 直接 cherry-pick 穿过已经重写的 graph/quoter/plan-builder；应在新边界上重放意图。
4. 如果 main 在 phase 期间出现重叠语义变更，本 phase 立即失效：rebase、重新生成 corpus 基线并重跑等价门。
5. 不做覆盖整个重构周期的全仓冻结；用小 phase、明确 ownership 和快速合入降低 feature 停顿时间。

### Phase 1 — 脚手架与 admission policy

新增：

- `venues/route-leg-adapter.ts`
- `venues/route-leg-registry.ts`
- `venues/route-adapter-registry.ts`
- `venues/admission.ts`

改动：集中 main 中重复的 provisional admission 参数；registry 暂不接管生产分发。

验证：build、adapter descriptor、venue identity、planner 输出完全不变。

### Phase 1.5 — 先固定 warm coordinator 边界

在迁移任何 per-venue warm 逻辑之前，将 `main.ts` 现有 full/incremental/reorg/logs-error 状态机封装为
唯一 `BlockScanWarmCoordinator`。这一 phase 只移动所有权，不改变 request 集合、并发度、deadline、
cache invalidation/restamp 或发布时机；旧 venue 分支仍通过临时 legacy `WarmSpec` 进入同一个 coordinator。

必须先为 startup full warm、incremental changed-pool、reorg/range fallback、logs error、budget timeout
和 partial-pool failure 的 cache/marker 可见性建立 characterization assertions。若现有 harness 不覆盖，测试补充作为
Phase 0 prerequisite 单独合入 main，然后重新冻结基线。

验证：相同 block/log 输入生成相同 warm plan、RPC request multiset、cache keys、last-warmed marker 和 scanner 输出；
`searcher:blockscan-scanner`、`searcher:curve-warm-batch` 及对应 warm/replay gate 全绿。

### Phase 2 — UniV2 完整纵向迁移

把 UniV2 的以下逻辑迁进 `univ2-standard.ts`：

- pool edge 构建与 token/reserve 校验
- exact quote 与 fee model
- plan subtree 构建
- `mid`/`quoteLocal` 的同步读实现与 declarative `WarmSpec`

核心文件改为 `routeLegRegistry.forEdge(edge.adapterId)`；alias 索引完成唯一分发，核心文件不再判断
`univ2-swap`。不在 `TokenEdge` 上同时维护 `adapterId` 和 `executionFamilyId`。

验证：V2 scanner、planner、quote、plan fragment 和 final sim 等价；旧 backrun victim 分发暂时保留。

### Phase 3 — UniV3

迁移 UniV3 graph、mid/local/exact quote、plan fragment 和 warm spec。

验证：V3 local/fallback quote、planner、calldata 和 final sim 等价。

### Phase 4 — Curve family

拆成至少两个 execution family：

- `curve-plain`
- `curve-underlying`

MetaRegistry identity、coin/index 解析、get_dy 路径、mid、warm 和 plan 参数由对应 adapter 管理。main、quoter、plan-builder 不再出现 Curve 具体字符串。

验证：Curve math equivalence、underlying 代表性 fork replay、final verify 逐 wei 一致。

### Phase 5 — DODO 与 Fluid DEX

只有对应 feature 和 fixture 已先独立落到 main，才依次迁移：

1. DODO V2
2. Fluid DEX

验证：各自 graph、external/local quote、plan fragment、calldata 和 final sim 等价。

### Phase 6 — UniV4 与 Balancer V3

V4 的 PoolKey、native/WETH alias、hook admission 和 unlock/take/settle action fragment 保持在
`SwapAdapter`；Balancer V3 的 unlock/swap/settle/send-to fragment 同理，不下沉通用 planner。

验证：V4 hook/native replay、Balancer V3/RockSolid loop、calldata 与 final sim 等价。

### Phase 7 — Protocol 与 victim models

1. 迁移 main 已有的 ERC4626、PSM、wstETH、RockSolid、Metronome、GoldX 等
   `ProtocolConversionAdapter`；RPL/Cashiva/Goldfish 等尚未落 main 的 family 仍是独立后续 feature。
2. 以 `compat:fluid-credit` 消除 token-graph 的旧 credit switch，但保持 production fail closed。
3. 最后把 pool-impact/victim-apply/overlay 迁进 `VictimModelRegistry.pool-swap-overlay`，把 Metronome
   oracle backrun 迁进 `oracle-rawtx`；确认两种模型不会互相要求错误能力。

每迁一个 family/model，就删除对应核心分支并运行其 pinned replay。

### LiquidityAdapter 后续门（不属于本次行为等价 strangler）

Curve `add_liquidity/remove_liquidity_one_coin` 当前没有 runtime `SlotKind`，不能仅靠新增类名伪装成已支持。
它也不等同于 JIT-LP：gap batch 中存在把 LP token 作为原子闭环中间资产的 position-conserving lifecycle。
后续 execution-family change 必须先确定 runtime taxonomy（新 liquidity slot，或明确的 protocol mint_lp/burn_lp
语义）、让 final guard 验证整条 route 最终不残留 LP token/头寸，并用 Curve LP lifecycle pinned replay
证明 add→route→remove 闭环。完成前 `RouteAdapterRegistry.routeLegs.liquidity` 保持空，不参与 production admission。

### Phase 8 — main.ts 瘦身

adapter 迁移完成后再拆 orchestration：

```text
main.ts
  → live-config.ts
  → searcher-bootstrap.ts
  → opportunity-processor.ts
  → blockscan-runtime.ts
  → mempool-source.ts
  → shutdown.ts
```

`blockscan-warm-coordinator.ts` 已在 Phase 1.5 建立，本阶段只把其 wiring 从 `main.ts` 移入
`blockscan-runtime.ts`。目标：`main.ts` 只保留配置加载、依赖构造、source 启动和 shutdown wiring，
不包含 ABI、event topic、quote、warm 或 protocol switch。

## 10. 硬编码治理

允许固定：

- registry、vault、oracle、canonical manager 等基础设施 singleton。
- token constants 和明确的生产配置。
- adapter/action ID 的类型化常量。

禁止作为 admission gate：

- pool 实例 allowlist。
- factory allowlist 决定 unknown pool 是否可进入能力探测。
- 为单个 replay 样本新增 seed/address 才使其通过。

约束：

1. factory/registry 地址只能是身份来源或 provenance，不能替代反向验证。
2. `force-include` 只影响候选覆盖，不能绕过 identity/execution-family/final sim。
3. unknown execution family 不能静默套用默认 fee、quoter 或 calldata 语义。
4. 所有 provisional 路径在事件和日志中携带 confidence/source。

## 11. 验证合同

### 纯架构重构

分类为行为等价重构：只能声称 `implemented/equivalent`，不能声称修复了某个 deterministic gap。

每个 Phase 至少运行：

```bash
cd listener
npm run build
npm run searcher:adapter-descriptors
npm run searcher:venue-identity
npm run searcher:planner
npm run searcher:finaloverlayequiv
npm run searcher:finalverifygate
```

并按 Phase 0 corpus 表运行该 execution family 的 pinned math/quote/fork replay；receipt、输入 hash 和输出 hash
必须绑定同一 baseline/challenger SHA。等价性判据：

- scanner rings 相同
- candidate plan 数量与顺序相同
- compiled calldata 字节相同
- final simulation success/revert 相同
- gas/profit 口径相同
- gross/net profit 逐 wei 相同
- 每条 edge 的 `adapterId`、`slotKind`、`protocolAction`、`edgeKind`、`leavesStandingPosition` 相同
- warm request multiset、cache keys、last-warmed marker、partial failure 和 fail-closed 行为相同

### unknown factory 能力变化

必须另开 commit/PR，并记录：

```text
failing_sample:
baseline_failure:
fix_commit:
replay_command:
replay_result:
expected_transition:
verdict:
```

同一个真实样本必须从 baseline 失败桶推进；build/test 通过不等于 fixed。

## 12. Registry 完整性测试

新增 adapter conformance suite，启动和 CI 均检查：

1. `ExecutionFamilyId` 唯一，route-leg kind 与子 registry 一致。
2. 每个现有 `TokenEdge.adapterId` alias 唯一映射到一个 `ExecutionFamilyId`，不存在双键漂移。
3. 所有生产 pool descriptor 都能解析到一个 adapter，adapter 产出的 edge alias 必须反解回自身。
4. adapter 生成的 action IDs 均存在于 ActionAdapter registry。
5. block-scan/backrun lane 的必需能力没有空缺；backrun 按声明分别校验 pool-swap-overlay 或
   oracle-rawtx victim model，不要求每个 route adapter 实现 overlay。
6. `mid` / `quoteLocal` 的类型签名不允许 Promise，且在 instrumentation test 中不产生 I/O。
7. registry wrapper 对每次动态 `buildEdges` 校验 allowed taxonomy，并重新派生
   `edgeKind` / `leavesStandingPosition`；final guard 同样重新派生，不能只做启动测试。
8. adapter 的 edge token 顺序、quote token 顺序和 plan token 顺序一致；plan fragment 的 requirements
   经共享 assembler 去重后与基线 sibling action 顺序一致。
9. `compat:fluid-credit` 保持 graph/diagnostic fixture 等价，但 production submission 稳定拒绝。
10. 任何 unsupported family 都有稳定 drop reason，而不是落入默认分支。

## 13. 风险与回滚

主要风险：

- adapter 接口过胖，最终只是把 switch 搬进一个文件。
- optional method 漏接导致某 lane 静默丢路径。
- identity 与 execution family 再次合并，使 known factory allowlist 变成准入门。
- pure refactor 同时改变 quote/fallback/ranking，无法定位行为差异。
- side-effect registry 导致测试顺序依赖。
- warm scheduler 与 adapter 同时持有 TTL/reorg/last-warmed 状态，产生部分 snapshot 或重复请求。
- 与 graph/quoter/plan-builder 的在飞 feature 并发，导致语义冲突被误当成机械 merge。

控制措施：

1. 按 execution family 纵向迁移，一次只迁一个 family。
2. 每阶段保持旧实现可回切，等价性通过后才删除旧分支。
3. registry 显式构造并冻结，测试使用独立 registry 实例。
4. 任何输出差异先判定为重构回归，不解释成“优化”。
5. 每个阶段独立 commit，可按阶段 revert，不做 big-bang 合并。
6. warm 调度状态只有 coordinator 一个 owner；adapter 只提供 `WarmSpec`。
7. 每 phase 使用短期文件/execution-family ownership，main 重叠变化后废弃旧基线并重新验证。

## 14. Definition of Done

架构重构完成需要同时满足：

- [ ] `main.ts` 不包含具体 venue ABI、event topic、quote 或 adapter 分支。
- [ ] `token-graph.ts` 只协调 pool→edge，不包含 per-venue switch。
- [ ] `quoter.ts` 只提供通用入口/共享数学，不包含 per-venue dispatch switch。
- [ ] `plan-builder.ts` 只协调 path 和公共 approve/guard/flash 语义，不包含 per-venue plan switch。
- [ ] 已迁移的 swap/protocol leg 只依赖各自 `RouteLegAdapter` 子接口；liquidity 子 registry 在后续门完成前为空，flash 架构保持基线不变。
- [ ] warm 通过 route-leg family 查找，victim 通过独立 VictimModelRegistry 查找。
- [ ] warm coordinator 是 TTL/reorg/deadline/last-warmed 的唯一 owner；scanner 热读无 I/O。
- [ ] identity admission policy 只有一个生产配置入口。
- [ ] unknown V2/V3 的身份、能力、fee/quote confidence 均可审计。
- [ ] `TokenEdge.adapterId` 保持跨系统稳定，alias 唯一；未新增会漂移的 edge family 双键。
- [ ] 动态 edge 和 final guard 都重新执行 taxonomy/allowed-family 校验，重构前后逐 edge 相同。
- [ ] 新增一个标准兼容 DEX 不需要修改 main、graph、quoter、plan-builder。
- [ ] trusted harness 未被架构 challenger 修改。
- [ ] Phase 0 corpus 表中每个被迁 family/lane 都有成功 receipt，scanner、plan、calldata 和 final profit 等价。
- [ ] final simulation 和 EV gate 继续 fail closed。
