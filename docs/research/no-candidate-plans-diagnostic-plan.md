# Plan: no_candidate_plans Diagnostic + Fix Fork

> 一句话原则:diagnostics first。先把 `no_candidate_plans` 拆成可行动 subtype,再决定是"早丢长尾噪声"还是"目标化补 return venue"。第一张 PR **不改任何交易行为**。

## 0. 已定位的根因(收紧版)

2026-06-29 hybrid live-run:`opportunity_seen=18 → pipeline_dropped=17`(15 `no_candidate_plans` + 2 `expired-before-solver`),`solverEntered=0`。最高频样本(×6):
```
victim impact: 0x39484A…(longtail) -> WETH  on pool 0xEcABc504…
planner:       raw=93  focused=0  constraintPass=0  noBorrowable=0
```

**大类:detection surface 与 planner/routing viability 不一致。** detector 看到长尾/WETH impacted pool(`allPoolMap` 故意比 routing graph 宽,[detector.ts:33-35](../../listener/src/searcher/detector/detector.ts:33)),但 `focusPathsOnImpact`([planner.ts:330](../../listener/src/searcher/planner/planner.ts:330))找不到任何能反接 impacted pool/pair 的可用闭环 → 0 候选。

**严谨措辞(不要过度断言):**
- `raw=93` 只证明全图存在 93 条 WETH→WETH 环;**不**证明 `0x39484A` 有有效 return venue(这 93 条多半与该 pool 无关)。
- `focused=0` 证明没有任何环能通过 impact focus;但它**单独**既不能证明"impact pool 不在 graph",也不能证明"mainnet 没有 return venue"。注意 `hasImmediateSamePoolReverse` 会在 focus **之前**剪掉同池即时自反,所以"pool 在图里但只有同池自反"也会表现成 `raw>0 / focused=0`。
- `noBorrowable=0` 不是"借款没问题",是"根本没走到 rotation"(focus 已 0)。→ borrowability **不是**当前阻塞点。

**确认不是:** backend / bid / builder / submit / latency / borrowability / LP / borrow / v4 template。这些这轮无有效信号。

**旁证(指导优先级,非数学证明):** 这些长尾 token 在所有静态 pool-universe 文件里 grep=0(纯运行时 discovery);competitor-watch 两个盯防 bot 碰它们 0 次(他们做 USDC/USDT)。→ 倾向"长尾噪声",但需 PR1+PR2 拍板。

## 1. 现在不要修

```
不加 LP / borrow / v4 template
不全局调 maxHops / maxPoolsPerToken / discoveryTopN
不全历史扫 factory
不为长尾开更宽 mempool
不动 bid / builder / capital / submit
不让 no_candidate_plans 自动 promotion 成 production strategy
```
理由:连可执行闭环 path 是否存在都还没证明。贸然放宽 = 计算爆炸 + CU 上升 + 误报增加。

## 2. PR1 — 结构化 no_candidate 分类(diagnostics only)

在 planner 给 `no_candidate_plans` 加诊断,**只读现有 graph,不新增 live RPC,不改 candidate 输出**。

### subtype
```
impact_pool_not_in_routing_graph
only_immediate_same_pool_reverse        # 同池自反存在但被 pruning 剪掉,无 cross-venue
impact_token_no_supported_return_venue
return_venue_pruned_by_bounds           # 有 venue 但被 topN/maxHops/maxPoolsPerToken 剪掉
template_constraint_failed              # focused>0 才可能落这
borrowability_missing                   # 进了 rotation 才可能落这
unknown_no_candidate
```

### 每个 no_candidate 输出字段
```yaml
impact_pool: / impact_token_in: / impact_token_out:
impact_pool_in_detection_set:
impact_pool_edge_in_routing_graph:
same_pool_reverse_edge_exists:
same_pool_reverse_raw_paths:
same_pool_reverse_pruned:               # 被 hasImmediateSamePoolReverse 剪掉的数量
cross_venue_reverse_count:
same_pool_any_direction_count:
focused_count:
impact_token_degree:                    # 该 token 在当前 graph 的边数
impact_token_return_venues:             # 当前 graph 内的 return venue 数
raw_paths: / pruned_immediate_same_pool_reverse: / constraint_pass: / no_borrowable:
classification:
```

### classification 决策树(顺序判定,首个命中即止)

**绝不把所有 `focused=0` 粗暴归成 `single_pool_longtail` / `return_venue_missing`。** 必须按序显式分流,`impact_pool_not_in_routing_graph` 和 `only_immediate_same_pool_reverse` 是**优先、独立**的早判分支(避免误诊):

```
1. impact_pool_edge_in_routing_graph == false
   → impact_pool_not_in_routing_graph
   (detector 看到了,但它根本不是 routing graph 的一条边)

2. 否则(pool 在图里):
   2a. same_pool_reverse_edge_exists 且 same_pool_reverse_pruned>0
       且 cross_venue_reverse_count==0 且无其它 return venue
       → only_immediate_same_pool_reverse
       (唯一反向腿是同池自反,被 hasImmediateSamePoolReverse 正确剪掉 → 无效噪声,不是 missing graph)

   2b. impact_token_return_venues<=1 且 cross_venue_reverse_count==0
       → impact_token_no_supported_return_venue  [graph-only;A/B 待 PR2 链上 venue-count 拍板]
       (图内该 token 只有这一个 venue;究竟是"主网就单池"(A噪声)还是"主网有但我们没收"(B覆盖缺口),PR1 离线判不了)

   2c. 存在 return venue 但被边界剪掉(topN / maxHops / maxPoolsPerToken)
       → return_venue_pruned_by_bounds

3. focused_count>0 且 constraint_pass==0   → template_constraint_failed
4. 进了 rotation 且 no_borrowable>0          → borrowability_missing
5. 其它                                       → unknown_no_candidate
```

关键纪律:`2b` 是**临时标签**,PR1 不得直接断言"单池噪声"或"缺 venue"——A/B 由 PR2 的链上 venue-count 才能拍板。`1` 与 `2a` 必须在 `2b` 之前判,否则会把"pool 不在图"和"同池自反噪声"误并入"缺 venue"。

### 验收
1. 不改变 planner candidate 输出 / solver / submit / bid / builder。
2. 不新增 live hot-path RPC。
3. `no_candidate_plans` 事件带 `classification`。
4. 现有 15 个 ≥90% 能归到具体 subtype。
5. `0xEcABc504 / 0x39484A` 明确落到 `impact_pool_not_in_routing_graph` | `only_immediate_same_pool_reverse` | `impact_token_no_supported_return_venue` | `return_venue_pruned_by_bounds` 之一。
6. **分类器不许折叠**:单元测试覆盖三个独立 case —(a) pool 不在图 → `impact_pool_not_in_routing_graph`;(b) 图里仅同池自反(被剪)→ `only_immediate_same_pool_reverse`;(c) 图内该 token 仅一个 venue → `impact_token_no_supported_return_venue`(标 graph-only)。三者必须落到**不同** subtype,不得统一归成 `single_pool_longtail` / `return_venue_missing`。
7. `npm run build` + 新增 planner diagnostic unit test 通过。
8. redacted JSONL/Markdown 无 raw calldata / RPC URL / secret。

## 3. PR2 — 目标化链上 venue-count(判 A/B,补离线诊断的洞)

离线搜索证明不了"mainnet 没有 return venue"——一个我们从没索引过的 venue 会被误判成"单池噪声",把真机会当噪音丢。所以对**高频重复 impacted token** 做一次小范围链上 venue-count。

### 边界(硬性)
```
只查重复出现的 impacted token(top N 高频)
只查 supported factory / adapter(UniV2/Sushi getPair, UniV3 getPool 常见 fee tiers, Curve registry)
CU cap + token cap + factory cap
默认 offline/manual,不进 live hot path
结果写 venue_count_report,不改生产策略
```

### 输出 + 验收
```yaml
pool: / token:
impact_pool_edge_exists: / same_pool_reverse_edge_exists:
token_degree_current_graph: / return_venue_count_current_graph:
onchain_supported_venue_count:          # 关键:链上(不限我们图)有几个 supported return venue
classification: A_no_supported_return_venue | B_return_venue_missing_from_graph
```
验收:对 `0x39484A` 能明确给出 A 还是 B;不进 hot path;有 CU cap;报告无 secret。

## 4. PR3 — 按分类选生产修法(三选一,有了 PR1+PR2 才做)

### 3A 长尾噪声(A:无 supported return venue / 只有同池自反)
对齐 detection→planner viability:**更早、更清楚地丢弃,但不静默**。
```
emit pipeline_dropped / suppressed_opportunity
reason = unroutable_impact_pool | only_same_pool_self_reverse
```
验收:① 这类不再记成泛泛 `no_candidate_plans`;② 新 reason 上升;③ `solverEntered` 不下降(本来 plans=0);④ CU 不增加;⑤ live-loss summary 能单独统计该 reason。

### 3B 缺 return venue(B:链上有 supported venue 但 graph 没有)
**目标化**补 pool universe,不全局放宽。
```
只补高频 impacted token,每 token 最多 top K(2-3)return venues
只收 supported adapter;要求 min liquidity / recent activity / 成功 token0-token1 query
写 file-backed pool universe;feature flag 默认 guarded
```
验收:① 代表 fixture 的 `0xEcABc504` 从 plans=0 变 >0;② candidate 必须含 impacted pool 反向腿或明确 cross-venue reverse;③ `solverEntered>0`;④ graph edge 增长 ≤5-10%;⑤ startup/graph-build 时间 ≤基线+10-15%;⑥ CU/min 不明显上升;⑦ final verify 保持开;⑧ 不改 bid/builder/capital。

### 3C 真钱在 stable/liquid(competitor-validated,优先级最高)
competitor-watch 显示对手做 USDC/USDT、不碰这些长尾。报告里分开写:
```
observed: competitor touched USDC/USDT; did NOT touch sampled longtail tokens
inferred: these longtail opps likely noise; expansion should prioritize liquid/stable venues
```
做法:**从 confirmed competitor-winning tx 提取 pool/token** → 只收 supported adapter → 先 fixture/replay 证明 gross positive → 再加入 candidate graph。比"看到长尾就补长尾"更生产导向。

### 3D template(D:focused>0 但 constraintPass=0,目前无证据)
仅当 PR1 后出现 `focused>0 / constraintPass=0` 才看模板。也是 replay-first(代表 tx + canonical sequence + gross profit + adapter support + failure point),新 template feature flag 默认 off,fixture+dry-run 过了才进 hot path。

## 5. 执行顺序
```
1. PR1: no_candidate 结构化分类(diagnostic only,不改策略)
2. 离线重跑 hybrid redacted events → 分类现有 15 个
3. PR2: 对 0xEcABc504/0x39484A 等高频 token 做链上 venue-count → 拍 A/B
4. 据结果选 3A(早丢)/ 3B(目标化补 venue)/ 3C(competitor-driven liquid)/ 3D(replay-first template)
```
**第一张 PR 只加诊断和报告,不改交易行为。**

## 6. 给 Pro 的一句话
> This run did not discover an executable arb path. It discovered a repeated longtail/WETH impact that the detector surfaces but the planner cannot connect into a non-trivial focused round-trip. `raw=93` only proves global WETH cycles exist; `focused=0` proves none reverse the impacted pool/pair — it does **not** by itself prove the pool is absent from the graph nor that no return venue exists on mainnet (same-pool self-reverse is pruned before focus). The blocker is routing viability / return-venue coverage, not backend, bid, builder, borrowability, or template. Next production-facing fix is diagnostic classification first, then a bounded on-chain venue-count to split "single-pool longtail noise" from "return venue missing from graph," then either suppress unroutable noise or add targeted, competitor-validated liquid return venues. Do not add LP/borrow/v4 templates yet.
