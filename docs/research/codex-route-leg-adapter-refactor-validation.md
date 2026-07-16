# Codex Route Leg Adapter Refactor — Implementation and Validation

Date: 2026-07-16  
Status: `implemented_not_validated`  
Baseline: `4392ffc59fd4aa593500c6ee4fb83b34fe50340a`  
Candidate: `f72ccde0ba61f9acd02f694694cfa66be35fe10e`  
Branch: `codex/route-leg-adapter-refactor`

## Scope implemented

- Added an explicit `RouteAdapterRegistry` split into swap, protocol-conversion, and compatibility adapters. Flash routing remains on the existing architecture by design; no `FlashAdapterRegistry` was added.
- Separated pool identity/admission from execution family. `IdentityAdmissionPolicy` now owns provisional factory and Curve-underlying admission; `main.ts` no longer repeats `allowProvisionalFactories` or `allowProvisionalCurveUnderlying` flags.
- Migrated UniV2, UniV3, Curve plain/underlying, Balancer V3, UniV4, ERC4626, PSM, wstETH, RockSolid, Metronome, and GOLDx routing into family modules.
- Preserved the legacy Fluid credit edge as a fail-closed compatibility adapter. Fluid DEX remains the only explicit legacy switch because the plan marks its final-simulation fixture as blocked.
- Kept route construction separate from BotVM `ActionAdapter` encoding. Route adapters return multi-node `PlanFragment`s so UniV4 and approval/transfer siblings remain representable.
- Extracted the block-scan warm coordinator and retained synchronous mid reads over prewarmed state.
- Separated victim replay models from route execution, unified RPC victim replay, and extracted EV evaluation.
- Added prepared-state quote/prewarm/allowance capabilities and removed the second concrete venue dispatch from `revm-live-backend.ts`.
- Added runtime taxonomy validation and a final standing-position fail-closed re-derivation.

The candidate has 14 registered route adapters. `main.ts` is 4,936 lines versus 5,565 at the baseline (629 lines removed). The remaining concrete switches in token graph, quoter, and plan builder are all the same explicitly blocked `fluid-dex-swap` family; Revm has no migrated-family quote/prewarm switch.

## Adversarial review

The requested subagent performed two review passes against the local code diff.

- First pass found one code P1: Revm still contained a second venue quote/prewarm dispatch. This was fixed in `bbd5ae6` by moving the prepared-state capabilities into the route adapters.
- Second pass found no P0 or P1 and confirmed the Revm dispatch was closed.
- It found one P2: Fluid credit advertised a prepared quote that always threw. This was fixed in `f72ccde` as `quote: null` plus an explicit unsupported reason, preserving the old fail-closed error.
- Final targeted re-review passed with no new P0/P1.

Non-blocking follow-ups remain: inject the production registry into Revm from the composition root instead of importing the singleton; turn the quote/reason pair into a discriminated union; connect the oracle raw-tx model descriptor to production composition; and add identity proof/fee-rule behavior only with pinned fork fixtures. DODO, Fluid DEX migration, and a separate liquidity adapter kind remain fixture-gated future work.

## Deterministic validation

At both baseline and candidate:

- TypeScript build passes.
- Adapter descriptors pass 5/5.
- Venue identity passes 7/7.
- Planner passes 15/15, replay fixtures 22/22, plus the high-spread universe replay.
- Final verify, standing guard, submit gate, taxonomy, warm coordinator, victim model/apply, protocol legs, protocol quotes, overlay fidelity, V4 admission, Balancer V3, universe split, and EV evaluator gates pass.

The final candidate ran 23 no-RPC gates successfully. `searcher:blockscan-scanner` retains the exact baseline-known failure at `delta-restrict` after 4/17 (`untouched anchor should be filtered`); it is not a candidate regression. RPC/fork gates were not run locally because no `MAINNET_RPC_URL` was available.

## Local performance comparison

This is a local deterministic TopN planner benchmark, not the trusted same-block production A/B. Both revisions used the same 7,704-pool input:

`active-pools.json` SHA-256: `eb4f064aee642ad270ab228499de16a51adf2e7da25ba42e644b2ff8dcd51baf`

Six 50-iteration rounds were run in AB/BA alternating order. Values below are medians across rounds; retention is `baseline / candidate` for latency, so 100% is equal and lower is slower.

| TopN | Edges A/B | Build A→B | Plan p50 A→B | p50 retention | Plan p95 A→B | p95 retention |
|---:|---:|---:|---:|---:|---:|---:|
| 1,000 | 1,798 / 1,798 | 48.666 → 48.739 ms | 17.950 → 18.285 ms | 98.17% | 20.171 → 20.707 ms | 97.41% |
| 3,000 | 5,470 / 5,470 | 145.136 → 145.314 ms | 30.405 → 31.369 ms | 96.93% | 32.225 → 33.799 ms | 95.34% |
| 6,000 | 11,158 / 11,158 | 280.351 → 280.042 ms | 33.734 → 34.971 ms | 96.46% | 35.404 → 38.132 ms | 92.85% |

The edge counts and graph-build latency are equivalent. Median planner latency retains 96.46–98.17%, meeting the requested approximate 95% target. The 6,000-pool p95 is below 95%; individual runs show large tail variation on both sides, consistent with local V8 JIT/GC and CPU-frequency noise. A smaller real component may come from changed edge object shapes and registry/taxonomy indirection. This tail result must be measured on the trusted nodes before claiming production parity.

Raw AB/BA log-set digest: `dc42d3e3db8eca5f6fb711035e6fe55df3092b6e5e896d8223c28b423b0557a1`.

## Trusted A/B deployment decision

No production A/B was started, and the active A process was not changed. Read-only preflight found A running commit `840069d9d30b40d0c9585ed5a879091a666aa533`; the requested baseline is `4392ffc`, so the deployed champion is not the requested baseline.

More importantly, the trusted deployment contract mechanically rejects this candidate for two independent reasons:

1. The implementation branch includes its conformance tests and `listener/package.json`; the trusted challenger accepts production-only diffs and rejects challenger-authored test evidence.
2. A production challenger must show the same real +EV sample advancing at least one production stage. This refactor intentionally preserves stages. The infrastructure-shakedown mode cannot be used because it requires identical searcher code.

Creating a production-only branch would remove the first veto but not the second. Inventing a stage transition or using the shakedown path for changed code would falsify the trusted evidence, so deployment was stopped before mutating A or B.

Therefore the architecture and local approximate-95% performance checks are complete, but the requested trusted-node A/B acceptance is not. Under `docs/research/gates.md`, the honest verdict remains `implemented_not_validated` until the project adds an equivalence/performance-only trusted A/B mode or authorizes a different non-production parity harness.

---

## 对抗审查(fable,非作者)— `implemented_not_validated` 诚实,但归因错、且非"纯等价"重构

判决:同意不部署、`implemented_not_validated`。**但阻断的真实原因不是报告说的"trusted A/B 没有 equivalence 模式",而是"等价重构唯一该跑的本地逐-wei 等价回放,根本没跑"。** 且此重构**不是纯等价**——它捆绑了 ≥2 处行为改进,"equivalence"是错误的框。

### 已核实清白(不构成问题)
- **v4-math.ts**:仅 import 从 token-graph 迁到 venues/swaps/univ4-common,数学未动。
- **victim-apply.ts**:dispatch 从 4 curve + univ2/3/4 的显式 switch 收敛进 `victim-model-registry`;核实 registry `edgeAdapterIds` **覆盖全部 7 个 baseline id + 新增 curve-exchange-underlying**,无静默 drop。
- 诚实未部署、未绕安全门、main.ts 5565→4936、未过度引入 FlashAdapter、两轮 subagent review —— 均认可。

### 🔴 R1 — 等价断言从未运行,且被误归因(核心)
报告(line 60/75)证明的是 **"edge counts equivalent" + planner 延迟保持率 96–98%**;plan §7/§11 要求的是 **"scanner rings 相同 / candidate plan 数量与顺序相同 / compiled calldata 字节相同 / gross/net profit 逐 wei 相同"**。edge 数量相等 ≠ 边相同 ≠ 报价相同 ≠ wei 相同 —— **这是弱得多的检查**。
报告把 `implemented_not_validated` 归因于"trusted-node A/B 缺 equivalence 模式"。**但本地逐-wei 等价回放不需要生产部署、不需要 trusted A/B**:在 baseline 4392ffc 与冻结 SHA 各跑一遍 tx149/rocksolid/coffee 代表 corpus 的 fork replay,断言 rings/plans/calldata/wei 前后相同即可。这是 plan 自己指定的本地门,**Sol 没跑**。所以诚实标记方向对,但**真实缺口是"没跑本地等价回放",不是"trusted A/B 限制"**。

### 🟡 R2 — standing-guard.ts 是捆绑进"等价"重构的行为变更
`evaluateStandingGuard` 从"信任 edge 存的 `leavesStandingPosition`"改为**用 `deriveEdgeTaxonomy` 重新派生 + 交叉核对,不一致则新增 `edge_taxonomy_inconsistent` 拒绝**。这是好改进(正是 §16 H7 的缓解),但:
- 它**新增了一条拒绝路径** → 纯等价重构里不该有任何 verdict 变化;
- 若任一 refactor 产出的 edge 存的 bit ≠ 派生 bit,先前 allowed 的机会会翻成 rejected;
- 因此**破坏了"任何 diff = 回归"的等价不变式** —— 无法区分"有意的安全改进"和"意外回归"。
**必做**:(a) 拆成独立 commit / 独立验证;或 (b) 在等价 corpus 上显式断言此新拒绝路径**不触发**(若触发,说明某新 adapter 的 taxonomy 派生有 bug,是真发现)。

### 🟡 R3 — victim 覆盖扩大(curve-underlying)也是捆绑的行为变更
新 registry 给 victim overlay 加了 `curve-exchange-underlying`(baseline 的 victim-apply 没有)。好事,但 backrun 等价 corpus 会因此**合法地不同**(现在能 overlay 以前不能的 victim)。同 R2:改进被藏在"equivalence"下。

### 结论
**此重构不是纯等价——至少捆绑了 standing-guard 重派生(R2)与 victim curve-underlying 覆盖(R3)两处行为改进。** 所以:
1. "equivalence" 是错误的框;逐-wei corpus 在这两条路径上会**合法地 diff**,不能简单"全相同"。
2. 正确验证 = 跑本地逐-wei 等价 corpus,对**未变路径**断言逐 wei 相同,对**已变的两条**断言 diff 正是那两处有意改进(非意外)。
3. R1 是硬门:在拿到这个逐-wei 结果前,`implemented_not_validated` 成立,但理由应更正为"本地等价回放未跑",而非"trusted A/B 限制"。

诚实性认可(未部署、未绕门);但**验证深度不足**:性能保持率 + edge counts 替代不了等价重构的逐-wei 断言。

---

## 逐-wei 等价核对 — 可执行人工 checklist(节点数据)

总纲:**同块 + 同 universe/graph 种子 + 同 warm 状态**喂 A(baseline 4392ffc)与 B(冻结 SHA),B 用 `SEARCHER_DRY_RUN=1`(不广播、不占 bounded-live、不需第二个 funded wallet)。逐块 diff;**比集合/字节/wei,不比计数**;第一个出现 diff 的块 + 阶段 = bug 落点。延迟/CPU/内存不算(另一条 95% 性能轴)。

### 前置(2 个小改,否则阶段1/3 核不了)
1. **dumpRuntimeGraphPools 加 edge 级安全位**:当前 dump 是 pool 级(address/adapter/venueId/factory/poolId…),**不含 `edgeKind`/`leavesStandingPosition`**。核 H7 安全位需给 dump 增这两字段(或以 standing-guard 的 `edge_taxonomy_inconsistent` 日志代替 —— 一旦触发即安全位不一致)。
2. **确认被丢弃 ring 的 net 日志足够**:进 sim 的 ring 靠阶段4 calldata 核;**没进 sim 就丢弃的 ring** 靠 `[searcher/blockscan] solve ring=X net=... / error=no_plans` 日志核其 net/quoteProfit。

### 逐阶段(dump 源 + diff 方法 + 精度)

| 阶段 | dump 源 | diff | 精度 |
|---|---|---|---|
| **1 图** | `runtime-graph-pools.json`(+前置1的 edgeKind/leavesStandingPosition) | pool 集合逐元素 `(address,adapter,venueId,factory,poolId)` 一一对应;每边 edgeKind/leavesStandingPosition 相同 | 集合精确,不是数量 |
| **2 枚举 rings** | `[searcher/blockscan] block=X solve ring=Y` 日志 | 每块 ring 集合逐个比(ring 身份=`path_id`/`resolvedRouteSummary`) | 集合精确 |
| **3 报价/solve** | 进 sim 的→阶段4吸收;未进 sim 的→`solve ring=X net=...` 日志 | 未进 sim 的 ring 逐个比 net/quoteProfit;进 sim 的 per-hop 金额由阶段4 calldata 保证 | 逐 wei |
| **4 sim** | 结构化输出 `{calldata, profitToken, netProfit, gasUsed}` | 进 final-sim 的 ring 集合相同;每 ring calldata **字节相同**、success/revert 相同、netProfit/gasUsed 逐 wei | 字节 + 逐 wei |
| **5 EV/提交决策** | drop reason 日志(`error=no_plans`/blacklist skip/below_ev)+ quotePositive | 每 ring allow/reject 判定+reason 相同;过 EV 门"会提交"集合相同 | 精确 |

**"进 top-N/进 sim 的 ring 集合"必须相同**(非时间问题):重构改了 edge 对象形状可能影响排序 tie-break,分数相等时选中不同 ring = 真回归。

### 允许 diff 的两条路径(R2/R3,须预声明,否则误判回归)
1. **standing-guard**(R2):新增 `edge_taxonomy_inconsistent` 拒绝路径。正确边上**不应触发** —— 若触发是真 bug(某 adapter taxonomy 派生错),**不是**预期差异。
2. **curve-underlying victim**(R3/§19):新覆盖了以前没有的 victim。仅 **backrun lane** 的 curve-underlying ring 集合会合法多出;block-scan lane 不受影响。

**除这两条外,阶段 1–5 全部逐元素/逐字节/逐 wei 相同,才判等价通过。** 有 diff 落在这两条外 = 回归,不合。
