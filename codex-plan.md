# Codex Plan — Searcher Swap Adapter 架构重构

> 基线：`origin/main@4392ffc59fd4aa593500c6ee4fb83b34fe50340a`  
> 状态：施工计划；第一阶段只做行为等价重构，不引入新的 venue 能力。  
> 目标：让新增 DEX 不再修改 `main.ts`、`token-graph.ts`、`quoter.ts`、`plan-builder.ts` 等核心分发文件，同时保留 unknown factory 的长尾发现能力和 final simulation 的 fail-closed 安全门。

## 1. 结论

当前项目已经有一层可用的 `ActionAdapter` registry，它负责把 `ResolvedPlanNode` 编译成 BotVM action。它不应该被扩成同时负责 discovery、identity、quote、graph 和 warm 的巨型接口。

本次在它上面新增一层高阶 `SwapAdapter`：

```text
候选池发现
  → 链上身份反查
  → 交换能力探测
  → SwapAdapter registry
  → graph / quote / plan / warm / impact
  → 现有 ActionAdapter compiler
  → final simulation
```

两层职责如下：

- `SwapAdapter`：一条逻辑 swap 如何建图、报价、生成执行子树、预热和处理状态影响。
- `ActionAdapter`：执行子树中的单个 action 如何编码成 BotVM opcode。

UniV4 和 Balancer V3 的一条逻辑 swap 会展开成多个 action；保留这两层可以避免把协议语义和 opcode 编码重新耦合。

## 2. 目标与非目标

### 目标

1. `main.ts` 不再出现 `curve-exchange-underlying`、`univ2-swap`、`balancer-v3-unlock` 等具体协议分支。
2. graph、quote、plan、warm、impact、victim overlay 通过同一个高阶 registry 找到实现。
3. 协议身份与交换能力分开：unknown factory 可以保留 `venueId=unknown`，同时使用经过探测的标准 V2/V3 能力。
4. 每个生产 adapter 在启动时完成能力覆盖校验，避免只接入 quote 却漏掉 plan、warm 或 overlay。
5. 第一轮迁移保持 scanner 输出、candidate plan、calldata 和逐 wei 模拟结果不变。
6. `main.ts` 最终只承担配置、依赖组装、source 启停和优雅关闭。

### 非目标

1. 第一阶段不新增 DEX，不改变 pool admission，不扩大广播范围。
2. 不重写现有 ActionAdapter compiler。
3. 不在架构重构中顺带修 planner ranking、top-N 或 sizing 问题。
4. 不修改 trusted replay/hunt harness 来制造成功结果。
5. 不把 factory、pool 或 token 实例 allowlist 作为 admission gate。

## 3. 核心领域模型

必须拆开三个目前容易混淆的 ID：

```ts
type VenueId =
  | "unknown"
  | "uniswap"
  | "sushiswap"
  | "curve"
  | "balancer-v3"
  | string;

type SwapCapabilityId =
  | "univ2-standard"
  | "univ3-standard"
  | "univ4"
  | "curve-plain"
  | "curve-underlying"
  | "balancer-v3"
  | "fluid-dex";

type ActionAdapterId = string;
```

- `VenueId`：链上来源和协议标签，不决定执行。
- `SwapCapabilityId`：已经验证的交换语义，用于选择高阶 adapter。
- `ActionAdapterId`：BotVM action 编码 ID，例如 `univ4-take`、`univ4-settle`。

建议的 pool 描述：

```ts
interface PoolDescriptor {
  address: string;
  identity: {
    venueId: VenueId;
    factory?: string;
    source: string;
    confidence: "verified" | "provisional";
  };
  swapCapabilityId: SwapCapabilityId;
  metadata: PoolMetadata;
}
```

`TokenEdge` 继续携带执行所需 metadata，但 adapter 选择只读 `swapCapabilityId`，不再根据协议名称猜测执行方式。

## 4. 高阶 SwapAdapter 契约

```ts
interface SwapAdapter {
  readonly id: SwapCapabilityId;

  buildEdges(ctx: EdgeBuildContext): Promise<TokenEdge[]>;
  quote(ctx: QuoteContext): Promise<bigint>;
  buildPlan(ctx: PlanBuildContext): Promise<ResolvedPlanNode>;

  readonly mid: MidQuoter | null;
  readonly warm: WarmPlanner | null;
  readonly impact: ImpactDecoder | null;
  readonly victimOverlay: VictimOverlayBuilder | null;
}
```

可选能力必须显式为实现或 `null`，不能靠方法是否存在来猜测。registry 在启动时按 lane 校验：

- block-scan 生产支持：`buildEdges + quote + buildPlan + mid/warm policy + final sim`。
- backrun 生产支持：在上面基础上还要求匹配的 `impact` 和 `victimOverlay`/post-impact 能力。
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
  adapters/
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

1. 记录 main SHA、生产 view/universe SHA 和 replay fixture。
2. 运行现有 adapter descriptor、planner、quote/math、final verify 和代表性 fork harness。
3. 保存 scanner rings、candidate plans、compiled calldata 和逐 wei profit 作为等价性基线。

验证：现有 harness 全绿；不修改 fixture/harness。

### Phase 1 — 脚手架与 admission policy

新增：

- `venues/swap-adapter.ts`
- `venues/swap-registry.ts`
- `venues/production-registry.ts`
- `venues/admission.ts`

改动：集中 main 中重复的 provisional admission 参数；registry 暂不接管生产分发。

验证：build、adapter descriptor、venue identity、planner 输出完全不变。

### Phase 2 — UniV2 完整纵向迁移

把 UniV2 的以下逻辑迁进 `univ2-standard.ts`：

- pool edge 构建与 token/reserve 校验
- exact quote 与 fee model
- plan subtree 构建
- mid/warm metadata
- pool impact、victim apply/overlay

核心文件改为 `swapRegistry.get(edge.swapCapabilityId)`，不再判断 `univ2-swap`。

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
  → blockscan-warm-coordinator.ts
  → mempool-source.ts
  → shutdown.ts
```

目标：`main.ts` 只保留配置加载、依赖构造、source 启动和 shutdown wiring，不包含 ABI、event topic、quote、warm 或 protocol switch。

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

并按 adapter 增加对应 math/quote/fork replay。等价性判据：

- scanner rings 相同
- candidate plan 数量与顺序相同
- compiled calldata 字节相同
- final simulation success/revert 相同
- gas/profit 口径相同
- gross/net profit 逐 wei 相同

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
2. 所有生产 pool descriptor 都能解析到一个 adapter。
3. adapter 生成的 action IDs 均存在于 ActionAdapter registry。
4. block-scan/backrun lane 的必需能力没有空缺。
5. adapter 的 edge token 顺序、quote token 顺序和 plan token 顺序一致。
6. 任何 unsupported capability 都有稳定 drop reason，而不是落入默认分支。

## 13. 风险与回滚

主要风险：

- adapter 接口过胖，最终只是把 switch 搬进一个文件。
- optional method 漏接导致某 lane 静默丢路径。
- identity 与 capability 再次合并，使 known factory allowlist 变成准入门。
- pure refactor 同时改变 quote/fallback/ranking，无法定位行为差异。
- side-effect registry 导致测试顺序依赖。

控制措施：

1. 按 capability 纵向迁移，一次只迁一个协议族。
2. 每阶段保持旧实现可回切，等价性通过后才删除旧分支。
3. registry 显式构造并冻结，测试使用独立 registry 实例。
4. 任何输出差异先判定为重构回归，不解释成“优化”。
5. 每个阶段独立 commit，可按阶段 revert，不做 big-bang 合并。

## 14. Definition of Done

架构重构完成需要同时满足：

- [ ] `main.ts` 不包含具体 venue ABI、event topic、quote 或 adapter 分支。
- [ ] `token-graph.ts` 只协调 pool→edge，不包含 per-venue switch。
- [ ] `quoter.ts` 只提供通用入口/共享数学，不包含 per-venue dispatch switch。
- [ ] `plan-builder.ts` 只协调 path 和公共 approve/guard/flash 语义，不包含 per-venue plan switch。
- [ ] warm、impact、victim overlay 通过同一 SwapAdapter capability 查找。
- [ ] identity admission policy 只有一个生产配置入口。
- [ ] unknown V2/V3 的身份、能力、fee/quote confidence 均可审计。
- [ ] 新增一个标准兼容 DEX 不需要修改 main、graph、quoter、plan-builder。
- [ ] trusted harness 未被架构 challenger 修改。
- [ ] 代表性 corpus 的 scanner、plan、calldata 和 final profit 等价。
- [ ] final simulation 和 EV gate 继续 fail closed。

