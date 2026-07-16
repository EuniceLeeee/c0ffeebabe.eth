# Codex Plan — Searcher Swap Adapter 架构重构

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
- `FlashAdapter`：融资/执行 envelope，属于 `RouteAdapterRegistry.flash`，但不是 route edge，不能被迫
  实现 graph/quote/impact 接口。
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
3. 协议身份与交换能力分开：unknown factory 可以保留 `venueId=unknown`，同时使用经过探测的标准 V2/V3 能力。
4. 每个生产 execution family 在启动时完成 lane 覆盖校验，避免只接入 quote 却漏掉 plan 或 warm；
   flash provider 单独按融资能力校验。
5. 第一轮迁移保持 scanner 输出、candidate plan、calldata 和逐 wei 模拟结果不变。
6. `main.ts` 最终只承担配置、依赖组装、source 启停和优雅关闭。

### 非目标

1. 第一阶段不新增 DEX，不改变 pool admission，不扩大广播范围。
2. 不重写现有 ActionAdapter compiler。
3. 不在架构重构中顺带修 planner ranking、top-N 或 sizing 问题。
4. 不修改 trusted replay/hunt harness 来制造成功结果。
5. 不把 factory、pool 或 token 实例 allowlist 作为 admission gate。

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
  kind: "factory-reverse-lookup" | "registry-lookup" | "behavior-probe";
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
  | "balancer-v3"
  | "fluid-dex";

type ProtocolExecutionFamilyId = `protocol:${string}` | `compat:${string}`;
type ExecutionFamilyId = SwapExecutionFamilyId | ProtocolExecutionFamilyId;

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

## 4. 高阶 SwapAdapter 契约

```ts
interface SwapAdapter {
  readonly id: SwapCapabilityId;
  readonly edgeAdapterIds: readonly string[];

  buildEdges(ctx: EdgeBuildContext): Promise<TokenEdge[]>;
  buildPlan(ctx: PlanBuildContext): Promise<ResolvedPlanNode>;

  // scanner 热路径：只能同步读取本 block 已发布的 immutable warm snapshot。
  readonly mid: MidQuoter | null;
  readonly quoteLocal: LocalQuoter | null;

  // solver 定稿路径：允许异步读取 fork/revm/RPC，生产 adapter 必须显式提供。
  readonly quoteExact: ExactQuoter;

  // adapter 只声明“需要暖什么”；调度、去重、deadline、reorg 与原子发布归 coordinator。
  readonly warm: WarmSpec | null;
  readonly impact: ImpactDecoder | null;
  readonly postImpact: PostImpactApplier | null;
  readonly victimOverlay: VictimOverlayBuilder | null;
}

interface MidQuoter {
  read(ctx: MidReadContext, snapshot: WarmSnapshot): VenueMid | null; // no Promise
}

interface LocalQuoter {
  quote(ctx: LocalQuoteContext, snapshot: WarmSnapshot): bigint | null; // no Promise
}

interface ExactQuoter {
  quote(ctx: ExactQuoteContext): Promise<bigint>;
}

interface WarmSpec {
  requests(ctx: WarmRequestContext): readonly WarmRequest[];
  invalidationKeys(ctx: WarmInvalidationContext): readonly string[];
}
```

`WarmSnapshot` 必须绑定唯一 `blockNumber`/generation，并且只在该 block 的全部必需 warm request
成功后一次性发布；scanner 不得看到部分更新的 snapshot。外部 venue 的 `eth_call`、batch quote
或状态读取必须在 prewarm 阶段完成，`mid.read` / `quoteLocal.quote` 中禁止 I/O、`await` 和隐式 fallback。

`WarmSpec` 不是调度器。唯一的 `BlockScanWarmCoordinator` 负责 full/incremental/reorg 决策、跨 adapter
请求去重、deadline、cache restamp/invalidate 和 snapshot 原子切换。adapter 不拥有 last-warmed block、
TTL 或并发状态。

可选能力必须显式为实现或 `null`，不能靠方法是否存在来猜测。registry 在启动时按 lane 校验：

- block-scan 生产支持：`buildEdges + quoteExact + buildPlan + mid/quoteLocal/warm policy + final sim`。
- backrun 生产支持：在上面基础上还要求匹配的 `impact + postImpact + victimOverlay` 能力。
- 缺能力时 fail closed，并给出确定的 admission/drop reason。

注册采用显式依赖注入：

```ts
export function createProductionSwapRegistry(): SwapRegistry {
  return createSwapRegistry([
    univ2StandardAdapter,
    univ3StandardAdapter,
    univ4Adapter,
    curvePlainAdapter,
    curveUnderlyingAdapter,
    balancerV3Adapter,
  ]);
}
```

不使用 side-effect import 或目录自动扫描，避免注册顺序和测试隔离不透明。新增协议的核心改动应为一个实现模块和 registry assembly 中一行显式注册。

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

`main.ts` 只注入一份 policy，不出现 Curve/V2/V3 的具体分支。identity resolver 仍负责反向验证链上身份；capability probe 决定能否使用通用执行 adapter。

## 6. unknown factory 的长尾策略

unknown factory 可以使用通用 V2/V3 adapter，但必须经过能力探测，不能仅凭事件 topic 判断。

### unknown V2

至少验证：

1. `token0()`、`token1()`、`getReserves()` 可读且返回合法值。
2. `factory()` 可读时，调用 `factory.getPair(token0, token1)` 反查当前 pool。
3. 标准 `swap(uint256,uint256,address,bytes)` selector/callback 形状与执行计划兼容。
4. 手续费模型有明确来源；未知时不得静默把默认 30bps 当作精确定价。
5. provisional quote 只能用于候选排序，最终必须由 fork/revm simulation 校正。

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
  venueId: "unknown",
  factory: "0x...",
  confidence: "provisional",
  swapCapabilityId: "univ2-standard"
}
```

final simulation 始终是生产提交前的 fail-closed gate。

## 7. 建议目录

```text
listener/src/searcher/venues/
  admission.ts
  identity.ts
  capability-probe.ts
  pool-descriptor.ts
  swap-adapter.ts
  swap-registry.ts
  production-registry.ts
  swaps/
    univ2-standard.ts
    univ3-standard.ts
    univ4.ts
    curve-plain.ts
    curve-underlying.ts
    balancer-v3.ts
    fluid-dex.ts
    protocol-conversion.ts
```

现有 `listener/src/adapters/*` 保持 action 编码层定位，不搬进 searcher venue 目录。
高阶实现目录使用 `venues/swaps/`，避免与低阶 opcode `adapters/` 同名。

## 8. 六步检查矩阵

同一文件可能跨多个阶段；迁移时按阶段验证，而不是只看文件是否编译。

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

纯重构要求等价，不要求伪造 capability flip；harness 在 challenger 中保持不变。unknown factory 新能力另开变更，用同一真实失败样本验证：

```text
not_admitted → path_found → final_sim_success
```

## 9. Strangler 迁移阶段

### Phase 0 — 冻结基线

工作：

1. 等所有修改 graph/quoter/plan-builder/main 的在飞 feature/cherry-pick 已合入、放弃或移出重叠文件后，
   从最新 `origin/main` 建立干净 worktree；不得从当前冲突态或旧 feature branch 起重构。
2. 记录 main SHA、生产 view/universe SHA 和 replay fixture。
3. 为下表每个即将迁移的 capability 记录 fixture、命令、输入 artifact SHA-256 和基线输出 SHA-256。
4. 运行现有 adapter descriptor、planner、quote/math、final verify 和对应 fork harness。
5. 保存 scanner rings、candidate plans、compiled calldata 和逐 wei profit 作为等价性基线。

验证：现有 harness 全绿；不修改 fixture/harness。缺失的 fixture 必须先在独立 prerequisite
commit 中补齐并合入 main，再重新冻结重构基线，不能由架构 challenger 同时修改 trusted harness。

#### Capability 等价性 corpus（开工门，不是建议清单）

表中的“现有锚点”只是候选输入，不等于已经满足开工门；Phase 0 必须实际运行并记录 receipt。
迁移单位是 `SwapCapabilityId × production lane`，不是模糊的 venue 品牌。每个被迁 capability
至少需要一个覆盖 graph → quote → plan → compile → final simulation 的 pinned known-good fixture；
backrun 能力还必须覆盖 impact → postImpact → victimOverlay。

| capability | `origin/main` 现有锚点 | Phase 0 状态/动作 |
|---|---|---|
| `univ2-standard` | `blockscan-coffee-f2de7499.json`、`yeti-balancerv1-0ffa9acf.json` | 运行 parameterized loop fork；未得到完整成功锚前不得迁移 |
| `univ3-standard` | `rocksolid-balancer-v3-7ce631.json`、`sfrxeth-8756ba5c.json` | 记录 loop fork、逐腿 quote 和 calldata 基线 |
| `univ4` | `blockscan-coffee-f2de7499.json`、`sfrxeth-8756ba5c.json`、`searcher:validate-v4-quote` | 记录 native/WETH、hook、quote 与多 action calldata 基线 |
| `curve-plain` | `sfrxeth-8756ba5c.json`、`searcher:curvemath` | 固定 block；记录 local/on-chain quote 与 loop final sim |
| `curve-underlying` | main 尚无独立 pinned loop fixture | **BLOCKED**：先以独立 prerequisite commit 增加并验证 fixture |
| `fluid-dex` | `searcher:fluid-dex-verify` | 记录其 pinned tx/block、plan、calldata 与 quote 输出 |
| `balancer-v3` / `rocksolid` | `rocksolid-balancer-v3-7ce631.json` | 运行 parameterized loop fork，记录四腿 plan/calldata/profit |
| `erc4626` | `sfrxeth-8756ba5c.json`、`searcher:blockscan-fork-solve-f391` | 分别覆盖标准与 Silo redeem 形状 |
| `psm` | `searcher:protocol-loop` | 记录 PSM+Curve 原子闭环与 calldata |
| `wsteth` | `searcher:wsteth-quote` | **BLOCKED**：quote 单测不足，先增加 closed-loop/final-sim fixture |
| `metronome` | `searcher:blockscan-fork-solve-metronome` | 记录 oracle victim 前后反事实和 final sim |
| `goldx` | `searcher:blockscan-hunt-tx149` | 记录 pinned hunt 的 graph/plan/calldata/final-sim 输出 |

#### 并发施工门

1. 同一时刻只允许一个 SwapAdapter capability 迁移 PR；不得把多个 venue 迁移堆在同一 branch。
2. 每个 phase 开始时从最新 main 重建基线，并对该 phase 的重叠 capability/文件实行短期 ownership；
   新 gap-repair 可以继续做非重叠模块，重叠改动必须等待该 phase 合入后再 rebase。
3. 禁止把旧 feature commit 直接 cherry-pick 穿过已经重写的 graph/quoter/plan-builder；应在新边界上重放意图。
4. 如果 main 在 phase 期间出现重叠语义变更，本 phase 立即失效：rebase、重新生成 corpus 基线并重跑等价门。
5. 不做覆盖整个重构周期的全仓冻结；用小 phase、明确 ownership 和快速合入降低 feature 停顿时间。

### Phase 1 — 脚手架与 admission policy

新增：

- `venues/swap-adapter.ts`
- `venues/swap-registry.ts`
- `venues/production-registry.ts`
- `venues/admission.ts`

改动：集中 main 中重复的 provisional admission 参数；registry 暂不接管生产分发。

验证：build、adapter descriptor、venue identity、planner 输出完全不变。

### Phase 1.5 — 先固定 warm coordinator 边界

在迁移任何 per-venue warm 逻辑之前，将 `main.ts` 现有 full/incremental/reorg/logs-error 状态机封装为
唯一 `BlockScanWarmCoordinator`。这一 phase 只移动所有权，不改变 request 集合、并发度、deadline、
cache invalidation/restamp 或发布时机；旧 venue 分支仍通过临时 legacy `WarmSpec` 进入同一个 coordinator。

必须先为 startup full warm、incremental changed-pool、reorg/range fallback、logs error、budget timeout
和“失败时不发布部分 snapshot”建立 characterization assertions。若现有 harness 不覆盖，测试补充作为
Phase 0 prerequisite 单独合入 main，然后重新冻结基线。

验证：相同 block/log 输入生成相同 warm plan、RPC request multiset、cache generation 和 scanner 输出；
`searcher:blockscan-scanner`、`searcher:curve-warm-batch` 及对应 warm/replay gate 全绿。

### Phase 2 — UniV2 完整纵向迁移

把 UniV2 的以下逻辑迁进 `univ2-standard.ts`：

- pool edge 构建与 token/reserve 校验
- exact quote 与 fee model
- plan subtree 构建
- `mid`/`quoteLocal` 的同步读实现与 declarative `WarmSpec`
- pool impact、victim apply/overlay

核心文件改为 `swapRegistry.forEdge(edge.adapterId)`；alias 索引完成唯一分发，核心文件不再判断
`univ2-swap`。不在 `TokenEdge` 上同时维护 `adapterId` 和 `swapCapabilityId`。

验证：V2 scanner、planner、quote、overlay、final sim 等价；`main.ts` 中 UniV2 分支归零。

### Phase 3 — UniV3 与 UniV4

先迁 UniV3，再迁 UniV4。V4 的 PoolKey、native/WETH alias、hook admission 和 unlock action 展开必须保留在 adapter 内部，不下沉到通用 planner。

验证：V3 local/fallback quote、V4 hook/native replay 和 calldata 等价。

### Phase 4 — Curve family

拆成至少两个 capability：

- `curve-plain`
- `curve-underlying`

MetaRegistry identity、coin/index 解析、get_dy 路径、mid、warm 和 plan 参数由对应 adapter 管理。main、quoter、plan-builder 不再出现 Curve 具体字符串。

验证：Curve math equivalence、underlying 代表性 fork replay、final verify 逐 wei 一致。

### Phase 5 — 外部报价 DEX 与 protocol conversion

依次迁移：

1. Fluid DEX
2. Balancer V3
3. PSM / ERC4626 / wstETH / RockSolid / Metronome / GoldX

protocol conversion 可以复用 descriptor-driven base adapter，但特殊多调用 quote 或复合 plan 必须保留独立 override。

验证：每迁一个 capability，就删除该 capability 在核心文件中的分支并运行对应 replay。

### Phase 6 — main.ts 瘦身

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
2. `force-include` 只影响候选覆盖，不能绕过 identity/capability/final sim。
3. unknown capability 不能静默套用默认 fee、quoter 或 calldata 语义。
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

并按 Phase 0 corpus 表运行该 capability 的 pinned math/quote/fork replay；receipt、输入 hash 和输出 hash
必须绑定同一 baseline/challenger SHA。等价性判据：

- scanner rings 相同
- candidate plan 数量与顺序相同
- compiled calldata 字节相同
- final simulation success/revert 相同
- gas/profit 口径相同
- gross/net profit 逐 wei 相同
- 每条 edge 的 `adapterId`、`slotKind`、`protocolAction`、`edgeKind`、`leavesStandingPosition` 相同
- warm request multiset、snapshot block/generation 和失败时的 fail-closed 行为相同

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

1. `SwapCapabilityId` 唯一。
2. 每个现有 `TokenEdge.adapterId` alias 唯一映射到一个 `SwapCapabilityId`，不存在双键漂移。
3. 所有生产 pool descriptor 都能解析到一个 adapter，adapter 产出的 edge alias 必须反解回自身。
4. adapter 生成的 action IDs 均存在于 ActionAdapter registry。
5. block-scan/backrun lane 的必需能力没有空缺；backrun 明确校验 impact/postImpact/overlay 三段。
6. `mid` / `quoteLocal` 的类型签名不允许 Promise，且在 instrumentation test 中不产生 I/O。
7. 每条 edge 的 `edgeKind` / `leavesStandingPosition` 必须等于
   `deriveEdgeTaxonomy(slotKind, protocolAction)`，adapter 不得独立覆盖安全位。
8. adapter 的 edge token 顺序、quote token 顺序和 plan token 顺序一致。
9. 任何 unsupported capability 都有稳定 drop reason，而不是落入默认分支。

## 13. 风险与回滚

主要风险：

- adapter 接口过胖，最终只是把 switch 搬进一个文件。
- optional method 漏接导致某 lane 静默丢路径。
- identity 与 capability 再次合并，使 known factory allowlist 变成准入门。
- pure refactor 同时改变 quote/fallback/ranking，无法定位行为差异。
- side-effect registry 导致测试顺序依赖。
- warm scheduler 与 adapter 同时持有 TTL/reorg/last-warmed 状态，产生部分 snapshot 或重复请求。
- 与 graph/quoter/plan-builder 的在飞 feature 并发，导致语义冲突被误当成机械 merge。

控制措施：

1. 按 capability 纵向迁移，一次只迁一个协议族。
2. 每阶段保持旧实现可回切，等价性通过后才删除旧分支。
3. registry 显式构造并冻结，测试使用独立 registry 实例。
4. 任何输出差异先判定为重构回归，不解释成“优化”。
5. 每个阶段独立 commit，可按阶段 revert，不做 big-bang 合并。
6. warm 调度状态只有 coordinator 一个 owner；adapter 只提供 `WarmSpec`。
7. 每 phase 使用短期文件/capability ownership，main 重叠变化后废弃旧基线并重新验证。

## 14. Definition of Done

架构重构完成需要同时满足：

- [ ] `main.ts` 不包含具体 venue ABI、event topic、quote 或 adapter 分支。
- [ ] `token-graph.ts` 只协调 pool→edge，不包含 per-venue switch。
- [ ] `quoter.ts` 只提供通用入口/共享数学，不包含 per-venue dispatch switch。
- [ ] `plan-builder.ts` 只协调 path 和公共 approve/guard/flash 语义，不包含 per-venue plan switch。
- [ ] warm、impact、victim overlay 通过同一 SwapAdapter capability 查找。
- [ ] warm coordinator 是 TTL/reorg/deadline/snapshot generation 的唯一 owner；scanner 热读无 I/O。
- [ ] identity admission policy 只有一个生产配置入口。
- [ ] unknown V2/V3 的身份、能力、fee/quote confidence 均可审计。
- [ ] `TokenEdge.adapterId` 保持跨系统稳定，alias 唯一；未新增会漂移的 edge capability 双键。
- [ ] 所有 edge safety taxonomy 只由 `deriveEdgeTaxonomy` 派生，重构前后逐 edge 相同。
- [ ] 新增一个标准兼容 DEX 不需要修改 main、graph、quoter、plan-builder。
- [ ] trusted harness 未被架构 challenger 修改。
- [ ] Phase 0 corpus 表中每个被迁 capability/lane 都有成功 receipt，scanner、plan、calldata 和 final profit 等价。
- [ ] final simulation 和 EV gate 继续 fail closed。

---

## 17. 第二位 reviewer(Sol)架构审阅 — 收敛点 + 仍存盲点

Sol 独立审阅,与本 plan **收敛到同一两层拆分**(`PoolIdentity`/`ExecutionFamily` ≈ 本 plan 的 `VenueId`/`SwapCapabilityId`),验证方向稳。Sol 未动存在冲突的生产 worktree(正确 —— 印证 H3:核心文件正被多分支漂移,非落地时机)。

### 采纳 Sol 的增量:六步责任组件分解(比 §8 更细,折进 §8)

| 步骤 | 责任组件(main 只组装/调用,不含 venue 分支) |
|---|---|
| 1 scanner | DiscoveryRegistry · VenueIdentity · GraphBuilder · OpportunityEnumerator |
| 2 planner | PathEnumerator · RoutePlanner;plan-builder 只编译 plan |
| 3 solver | QuoteRegistry · SizingEngine · 各 execution family 的 quote |
| 4 fork sim | RouteEncoder · SimulationRunner · 通用 revm backend |
| 5 EV | 独立 EvEvaluator;main 只调用 |
| 6 replay | 现有 trusted harness,challenger 不得修改 |

Sol 的 PanoramaSwap 探测清单(token0/token1/getReserves/swap 形状/储备变化/fee 规则/calldata,**fee 不默认 997/1000**,final sim 强门)与 §6 一致,并入 §6 作为 V2 探测的最小集。

### Sol 仍漏的两个高危(与 §16 H7 / §15 H1 重合 —— 两位 reviewer 都漏,更须显式钉进正文)

- **H7(安全位)**:Sol 六步责任表未提 `slotKind/edgeKind/leavesStandingPosition/deriveEdgeTaxonomy`。"新增标准 V2 只进 identity/discovery 数据"未保证这些 edge 的 `leavesStandingPosition` 仍经 `deriveEdgeTaxonomy` 派生 → 孤立安全位 = S2 guard 绕过风险。**两位独立 reviewer 同漏,证明此条隐蔽,必须成为 §3 + §12 的硬约束。**
- **H1(sync 契约)**:Sol 步骤 3 "QuoteRegistry / 各 family 的 quote" 未区分 `prewarm`(async,每块一次)vs 热循环 `mid`(sync,每块上千次)。async-agnostic 的责任分解会在热路径回归延迟。QuoteRegistry 必须内建 prewarm/sync-read 分层。

### 结论(汇总两位 reviewer + 两轮)
方向三方收敛(plan / fable / Sol),稳。落地前**正文必修**:H1(sync 分层)、H2(warm 协调器提前)、H3(与 feature work 串行化 + feature 冻结窗口)、H7(deriveEdgeTaxonomy 安全位对齐)。采纳 Sol 的六步责任组件分解 + V2 探测最小集。H4/H5/H6 收尾。
**时机**:核心文件(token-graph/quoter/plan-builder/main)现被 ~10 条未合并 ab/* 分支漂移;须先收敛在飞 feature、开 feature 冻结窗口,再起 strangler。plan ready,timing not。

---

## 18. 四类 RouteLegAdapter 分类(Sol)— 采纳,但校准 LiquidityAdapter 与 taxonomy

Sol 提议按 leg 领域语义分四类(不硬塞 union),**采纳**——比单一 `SwapVenue` 或 `Venue{edgeKind}` 清晰:

```
RouteLegAdapter
├── SwapAdapter            (UniV2/V3/V4 · Curve swap · DODO/Ekubo/zAMM · Balancer/Fluid)
├── ProtocolConversionAdapter (ERC4626 · PSM · RPL migration · wrapper mint/burn …)
├── LiquidityAdapter       (Curve add/remove_liquidity_one_coin)   ← 见下,占位不实现
└── FlashAdapter           (Balancer/Aave/Morpho flash)
RouteAdapterRegistry = { SwapAdapterRegistry, ProtocolAdapterRegistry, LiquidityAdapterRegistry, FlashAdapterRegistry }
```
底层 `ActionAdapter` 继续只编码 BotVM action。main/graph/quoter/planner 只面向统一 `RouteLegAdapter`。

### 与现有 SlotKind/EdgeKind 的对齐(必须核对,防平行分类=H7 重犯)

| 类别 | SlotKind → EdgeKind | 状态 |
|---|---|---|
| SwapAdapter | `swap` → `swap` | ✓ 对齐,重构现有 |
| ProtocolConversionAdapter | `protocol` → `protocol` | ✓ 对齐,**复用现有 descriptor 框架**(adapter-descriptors/protocol-legs/makeProtocolAdapter,srUSDe/GOLDx/PSM 已在);是 formalize 既有,不是新建,风险低 |
| FlashAdapter | `flash` → `flash` | ✓ 对齐 |
| **LiquidityAdapter** | **无对应 SlotKind → `lp`** | ✗ 见下 |

### 🟡 H8(新)— LiquidityAdapter 无 runtime slot,应占位不实现(同 credit)

代码核实:`EdgeKind.lp` 明文"reserved analysis vocabulary, **never derived from a runtime slot**";无 `SlotKind` 对应;Curve `add_liquidity/remove_liquidity` 当前**零 adapter 零 quote**。要让它成 runtime leg 须:新增一个 `SlotKind` + 把 `lp` 翻成可派生 + **给 `deriveEdgeTaxonomy` 定 LP 腿的 `leavesStandingPosition`**(加流动性拿 LP token = 留仓位,与 credit 同类)。这是 H7 安全派生面,不能静默。且 **JIT-LP 在 Mission 之外**。
**结论**:LiquidityAdapter **接口占位、不进本次 strangler 迁移**(与 credit 同待遇,留门不实现)。本次只迁 Swap/ProtocolConversion/Flash 三类(它们都对齐既有 slotKind + 有现成代码)。

### H7 对四类全适用(强化)
`RouteAdapterRegistry` 每个子 registry 产的 edge 都必须经 `deriveEdgeTaxonomy` 派生 `edgeKind`/`leavesStandingPosition`,永不独立写 —— swap→false、protocol→按 protocolAction、credit/lp→true。四类拆分让"安全位统一派生"更关键,§12 conformance 的 leavesStandingPosition 断言覆盖全部四类。

### 结论(本轮)
四类分法采纳(领域语义清晰)。本次迁移范围 = **Swap + ProtocolConversion + Flash 三类**;LiquidityAdapter/credit 仅接口占位不实现(H8/§15)。ProtocolConversion 是 formalize 既有 descriptor,非新建。安全位 H7 覆盖四类。时机不变:先冻结 feature、核心文件停漂再起。
