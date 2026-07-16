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

---

## 19. victim detect 从 route 派生(纠正 detect-only 默认)— 仅限 public-mempool swap-leg

用户定夺 + 代码核实(route-leg-adapter 分支):**public-mempool swap-leg 的 victim detect 必须从 route 能力直接派生,不是另外声明的可选 `victim` 块。** 纠正 Sol §18 victim 三级模型的错误默认。本节只讨论当前 full-tx public mempool lane；MEV-Share hash-only 不在本轮范围内，不能用它否定 raw-tx replay 兜底。

### 代码事实(route-leg-adapter 分支)
- `detectImpact`(识别 victim)用的**就是和 discovery/quote 同一份事件 ABI + 池数学**:[pool-impact.ts](listener/src/searcher/detector/pool-impact.ts) 的 `UNIV3_SWAP`/`UNIV2_SWAP`/`TokenExchangeUnderlying` topic + `decodeUniV3SwapData(amount0/amount1)`,与该 venue 的 discovery topic、quote 曲线同源。
- `applyLocal` 用的就是和 quote 同一份 v2/v3/curve math。
- **curve-underlying 现状 = `localApplyVariant:null` + `overlayReplayVariant:null`** 只关闭 hash-only local/overlay；当前 public-mempool 路径先 fork-apply 完整 rawTx、取得 receipt logs，再做 impact detect，因此它仍有真实 raw-tx replay，不会因这两个 `null` 直接 drop。

### 正确模型:可路由 ⇒ 自动可 detect ⇒ 至少 raw-tx-replay ⇒ backrun 永不因"没配 victim"而 drop

分级的不是"识别",是"重现":

| 能力 | 来源 | 可选? |
|---|---|---|
| **detect** | route + 事件 ABI **派生**(swap-leg) | **不可选,可路由即有** |
| **重现: raw-tx-replay** | fork 回放真实 victim tx,无需 venue 专属状态数学 | **当前 public-mempool lane 的必备兜底**；admitted hint 必须携带 full tx + rawTx |
| **重现: applyLocal** | 复用 quote 数学(仅结构简单的 venue) | **可选加速**;建不了就退回 raw-tx-replay,**不退回丢弃** |

- **在当前 public-mempool lane，没有任何可路由的 swap venue 应该因缺少 venue 专属 apply/overlay 而“不能 backrun”。** 最差 = `detect + raw-tx-replay`(慢但正确),永不是 `detect-only + drop`。
- Sol 的 detect-only 默认反了:detect 应自动,只有"是否 applyLocal 加速"才 opt-in。
- **安全澄清**:自动 detect 无安全代价 —— detect 只"认出 victim 存在",要不要 backrun 仍由下游 sim/EV/phantom-guard 判。把"丢弃"改成"进入下游判定",不放宽任何门。

### 当前结论(route-leg-adapter 分支)
curve-underlying 在 public-mempool lane 已经是 **`detect + raw-tx-replay`**；不需要为了本轮给 `localApplyVariant`/`overlayReplayVariant` 填实现。真正要修的是 swap detectability 仍由第二张 victim 表决定，新增 route swap adapter 可能像 Balancer V3 一样漏配 decoder。

### 范围(用户明确)
**本条只适用 full-tx public-mempool swap-leg。** swap 是 position-conserving、事件语义标准(一 Swap 事件 = 一次价格移动),detect 派生天然成立。**protocol/credit 等其他 leg 的 victim 先不管** —— 它们的 victim 语义(mint/burn/oracle 各异)复杂,留到需要时设计,不提前。oracle/rate trigger(victim 非 swap、与 route adapter 非 1:1)仍走独立 TriggerAdapter(§18)；MEV-Share hash-only 的 replay/submit 合同也不在本轮扩展。

### 对 VenueAdapter 接口的影响
swap venue 的 `victim.detect` **不声明也存在**(由 route 的事件 ABI 派生);venue 只需可选声明 `applyLocal`(加速)。即:
```
SwapVenueAdapter:
  route + discovery(topic 自声明)  → detect 自动派生 + public-mempool raw-tx-replay 兜底
  applyLocal?                       → 可选加速,缺省 = raw-tx-replay
```
不再有"可路由 swap venue 却 detect-only/drop"的配置可能。

---

## 20. Plan — swap victim 从 route 派生,消灭第二张易漏配的 victim 表(代码核实)

### 核实(远端 837fa829,fable 复核 Sol 发现,全部成立)
- `production-registry.ts` 注册 6 swap adapter(univ2/univ3/univ4/curvePlain/curveUnderlying/**balancerV3**)。
- `victim-model-registry.ts` 覆盖 `univ2-swap/univ3-swap/univ4-unlock/curve-exchange-underlying + []`(oracle)——**零 balancer**。
- `pool-impact.ts` decoder 仅 UNIV2/UNIV3/UNIV4/curve —— **无 Balancer V3**。
- **测试方向反了**:`test/victim-model-registry.ts` 遍历 VICTIM 条目查其有无 route(victim→route),**不查 route→victim**,故 Balancer V3(有 route 无 victim)静默 PASS。
- **净后果**:public-mempool 的 Balancer V3 swap 即便 raw-tx 回放拿到 receipt logs,也无 decoder 转成 `PoolImpact` → **无法 backrun**。这就是"两套表漂移"的实例。
- 纠正 Sol 一处:curve-underlying 的 `null/null` 只关掉 hash-only 的 local-apply/overlay;raw-tx 路径本身能拿 receipt(`main.ts:1842`)。真问题是"能否 detect"仍由第二张表决定,而非从 route 派生。

### 目标(用户原则)
**注册一个 swap adapter ⇒ 自动获得 public-mempool victim 检测。** victim-model-registry 不再决定"一个 swap 能否作 victim";它只留 oracle/非-swap trigger + 可选的 overlay/applyLocal 加速。

### 改法
1. **`SwapAdapter` 接口加必选 receipt-level observation capability**([route-leg-adapter.ts:151](listener/src/searcher/venues/route-leg-adapter.ts:151) 现在没有)。不是单条 `decodeSwapImpact(log)`，而是：

   ```ts
   interface SwapObservationCapability {
     readonly topics: readonly string[];
     readonly canonicalIntakeTargets: readonly string[];
     decodeSwapImpacts(ctx: {
       logs: readonly EventLog[];
       graphIndex: SwapGraphIndex;
       tokenQuery?: TokenQueryBackend | null;
     }): Promise<readonly PoolImpact[]>;
   }

   interface SwapAdapter extends RouteLegAdapter {
     readonly kind: "swap";
     readonly observation: SwapObservationCapability;
   }
   ```

   每个 swap adapter(univ2/v3/v4/curve/curve-underlying/**balancer-v3**)实现它；同一 adapter 可声明多个
   event variant。`canonicalIntakeTargets` 只放该 family 的 Router/Vault/Manager singleton，跨 venue
   aggregator 仍由下面的 chain-derived router index 提供。
2. **decoder 必须看完整 receipt，而不是逐 log 调用**：
   - UniV2 在同一 pool 的 Swap 前后寻找相邻 Sync，优先采用 Sync 的精确 post-reserves；缺 Sync 时才允许
     从 pre-reserves + Swap amounts 计算，并保持现有 fail-closed/error 行为。
   - UniV4 由 singleton PoolManager 发事件，按 `topics[1].poolId ↔ edge.v4PoolKey/poolId` 匹配。
   - Balancer V3 由 singleton Vault 发事件，`log.address` 是 Vault，真实 pool/tokenIn/tokenOut 在 indexed
     topics；decoder 必须用 indexed pool identity 匹配 graph edge，不能沿用 `log.address → edges`。
   - 一笔 receipt 可产生多个 impacts；decoder 返回数组，保留 log 顺序后再由 coordinator 稳定去重。
3. **`pool-impact.ts` 去 per-venue ABI/topic 硬编码，但保留 receipt coordinator**：composition root 从
   production swap registry 构建 `topic0 → observation[]` 索引；一份 receipt 只调用命中 topic 的
   observation。coordinator 继续负责 graph index、direct-call/Transfer 通用 fallback、跨 adapter 汇总和
   deterministic dedupe，不把这些通用职责硬塞进某一个 venue adapter。
4. **`victim-model-registry` 删掉所有 swap edgeAdapterIds**:只保留 oracle/非-swap trigger(那个 `[]` 项)+ 把 overlay/applyLocal 降为**按 adapterId 索引的可选优化表**(不是 detectability 的门)。
5. **测试改方向(承重)**:断言每个 production route swap adapter 都有非空 `observation.topics`、合法
   canonical targets，并至少有一份真实 receipt fixture 使 `decodeSwapImpacts` 产出预期 impact
   (route→victim)。UniV2 fixture 必含 Swap+Sync 并断言精确 post-reserves；V4/Balancer V3 fixture 必断言
   singleton log emitter 能反解到正确 pool identity。保留旧的 victim→route 方向作双检。
6. **附带闭合**:Balancer V3 随 §20.1 自动获得 decoder，先闭合“已进入 intake 后”的 receipt→impact；
   完整 public-mempool 覆盖还必须同时闭合下面的 intake 派生。

### 同轮必做:mempool intake 从 production swap capabilities 派生

中央 `MEMPOOL_ROUTER_ADDRESSES` 不能继续作为 public-mempool 覆盖的准入真相。当前实现把 14 个内置
router、force-include seed、pinned pools 和 hot-pool top-N 拼成 `toAddress` filter；新增一个可路由、
可 decode 的 swap adapter 后，如果其 canonical Router/Vault/Manager 不在这张表，pending tx 仍会在
进入 victim pipeline 前被过滤。Balancer V3 就是现成反例：route adapter 已知 canonical Router/Vault，
但 central intake 没有从 adapter 读取它们。

正确边界：

1. production `SwapAdapter` 的 observation capability 同时声明其事件 topics 和 **canonical direct
   entrypoints**（Router/Vault/Manager；基础设施 singleton 可以固定在 adapter 内，不在 `main.ts`
   维护第二张表）。注册 adapter 后，这些 direct targets 自动进入 intake plan。
2. graph 中所有可路由 pool/manager identity 自动进入本地 firehose 的内存匹配集合；`hot-pool top-N`
   只允许作为外部 provider server-side filter 的容量降级，不能成为 local-reth intake 的覆盖边界。
3. 1inch、桥和其他跨 venue aggregator 不属于任一 execution family，不能硬塞进某个 swap adapter。
   复用并改造 `discover-routers.ts`：按 production registry 汇总的 swap topics 扫描成功 receipt，只有
   `tx.to` 在链上实际产生已注册 swap observation 时才进入动态 router index；intake coordinator 合并
   adapter direct targets + graph targets + 该 chain-derived router index。
4. dynamic router index 是 load-shedding 输入，不是安全凭证；route identity、完整 raw-tx fork replay、
   final sim 和 EV gate 仍然 fail closed。新 router 在历史样本形成前可能暂时未知，另设有预算的
   exploration/audit lane，不能重新退化成手工往中央 allowlist 加地址。
5. `main.ts` 删除 `MEMPOOL_ROUTER_ADDRESSES` 和 venue/router 常量，只调用统一的 mempool intake plan；
   新增标准 swap adapter 不再修改 main。外部 filtered subscription 若有地址上限，必须记录 truncation
   与未覆盖集合；本轮把 local-reth firehose 改为使用完整集合，不再复用被截断的 server-side
   `toAddress` 列表。

这条与 decoder 同轮验收：Balancer V3 fixture 必须从 `tx.to = canonical Balancer V3 Router` 的 pending
raw tx 开始，经过 intake → fork-apply → Vault Swap receipt decode → `PoolImpact`，不能把预构造 receipt
logs 直接塞给 decoder 来绕过 intake。

### 附:同模式的另一处(可同轮或跟进)
- **discovery topic 三处硬编码**([active-pool-discovery.ts:133](listener/src/searcher/active-pool-discovery.ts:133)、[build-active-pool-universe.ts:16](listener/src/searcher/build-active-pool-universe.ts:16)、[pool-impact.ts:66](listener/src/searcher/detector/pool-impact.ts:66)):同 §18 —— 各 adapter 自声明 topic(`ethers.id(sig)`),三处改为读 registry 汇总。新增协议只改一处。

### 验收
- **conformance**:production-registry 每个 route swap adapter 有非空 receipt-level observation，且每个
  event variant 都有 fixture(route→victim)；Balancer V3 必过。
- **等价性**:原有 victim 的 venue(univ2/v3/v4/curve-underlying)decoder 搬进 adapter 后,产出的 `PoolImpact` 对同一 victim tx **逐字节/逐 wei 相同** vs baseline。
- **V2 精确后态**:同 receipt 的 Swap+Sync 必须使用 Sync reserves；去掉 Sync 后才走 pre-reserve 计算
  fallback，两条路径均有断言。
- **singleton identity**:V4/Balancer V3 的 `log.address` 不作为 pool identity；fixture 分别断言 poolId/
  indexed pool → graph edge 的精确映射。
- **Balancer V3 = 新覆盖**(预声明 diff:它获得了以前没有的 victim 检测,非回归)。
- 每个 swap venue 一笔 public-mempool backrun tx 走通新路径；Balancer V3 必须从 canonical Router
  intake 开始，不能只测 decoder。
- local-reth intake 使用 registry 派生的完整 direct/graph/dynamic-router 集合；新增 adapter 时
  `main.ts` router/pool filter 零修改。外部 provider 的地址截断必须产生结构化 coverage 事件。

### A/B 冻结边界（对抗审查补充）

本轮开发 worktree 可以同时包含生产代码、fixture 和测试，但不能把这个混合 diff 直接冻结成
production challenger。部署前必须拆成以下顺序，防止 gate 把测试/配置变化误当成运行时因果：

1. 把从旧中央 router 表迁出的 aggregator seeds 作为 prep 配置先落到 champion；A、B 都从这份相同的
   content-addressed dynamic-router snapshot 启动。配置不是 challenger 变量。
2. 从 prep champion 切出 **runtime-only** challenger；相对 A 只包含 listener 生产 `.ts`，不包含
   `package.json`、测试文件、fixture 或 router JSON 差异。冻结这个 SHA 做 paired-block A/B。
3. 测试/fixture 在开发分支上验证同一份 runtime patch；A/B 判赢并合入精确 challenger 后，再以独立
   test-only commit 落库。测试不能为了通过 gate 被删除，也不能混进 B 改变部署输入。
4. 若 prep 后 runtime pool-view、TokenEdge graph 或 dynamic-router snapshot hash 在 A/B 不一致，直接判
   fairness failure；不能用性能结果解释该差异。

### 时机
属已合并 route-leg-adapter 之上的独立行为变化；从当前 `origin/main` 新开分支，原有 venue 做严格
impact 等价，Balancer V3 与 adapter-derived intake 作为预声明的新覆盖分别跑 receipt 与 intake flip。
