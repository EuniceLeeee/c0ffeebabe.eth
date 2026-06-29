# MEV 对手分析器 — 实现计划 & 验收标准

> 口径源:[`strategy-taxonomy.md`](./strategy-taxonomy.md)。本文是分阶段实现路径 + 验收。
> 实现中途可重构,但 taxonomy 的口径(四维、排除、PnL、cluster、金标准)不变。

## 不变量(任何阶段不得违反,本身是验收项)
1. `analysis/` 绝不读私钥、绝不广播。**不读 repo root `.env`、不 dotenv 自动加载**;RPC/API 只从显式 CLI 参数或 `READONLY_RPC_URL` 环境变量进来(只读端点)。
2. 生产 `listener/searcher` 绝不 import `analysis/`(静态扫描校验)。
3. 利润数一律用我们自己的 PnL(我们的真相源)。
4. **trace_\* 只在 Phase 5(路径真相)使用;Phase 3/4(P0+分类)不碰 trace**(护 CU)。
5. `analysis/outputs/` 进 `.gitignore`;只提交精选 fixture + markdown。
6. PnL 对象是 **entity cluster**,不是单地址;**raw_deltas** 与 **valued_pnl** 分开,unknown/unpriced token 不进主口径(ratio 用正向可估值利润,见 taxonomy §4)。
7. **外部标签是可选 enrichment,不是依赖**:所有外部源关闭时 P0 仍必须跑通;`external_label` 缺失不影响 `our_label`。**EigenPhi 已停运(2026-06-29 shutdown)→ 不接 live service,仅允许 archived/static import 且默认禁用;mev-inspect-py 已 deprecated → 仅历史参考;ZeroMEV REST 仅 optional,失败即降级为本地 receipt/log 分类。**
8. **候选池高召回、低精度**:`EOA → contract` 可先标 `execution_candidate`,但不得直接计入 MEV/利润口径;只有 `backrun_candidate` / `confirmed_backrun` 才能进入 addressable 分析。

---

## Phase 1 — 口径固化(已产出)
`docs/research/strategy-taxonomy.md`。
**验收**:每大类标注 A/B/C(不混维度);sandwich/cex-dex/backrun 都是可编码布尔;3 个金标准已 pin 全 hash
(wstUSR tx、BEL token borrowable=0、25411620 pre/victim/post full hash + cluster 断言)。✅

## Phase 2 — 共享 registry + 生成脚本
**实现**
- `shared/registry/{addresses,selectors,protocols,taxonomy}.json`
- `scripts/gen-registry.ts`:从 `listener/src/adapters/*`、`ADDR`、`path-template` **生成**(不手抄)。

**验收**
- [ ] `npm run gen-registry` 产出 4 个 json。
- [ ] selectors 覆盖:morpho/balancer/aave/univ3 flash;univ2/v3/v4/curve/balancer swap;LP mint/burn;Fluid/Morpho borrow/repay;PSM。
- [ ] **漂移测试**:CI 跑 gen-registry 后 `git diff` 为空(否则 registry 与 searcher adapter 不一致 → 失败)。
- [ ] registry 是纯数据,无可执行代码、无密钥。

## Phase 3 — Ingest + P0 蛋糕量化(无 trace)
**实现**
- `ingest/txlist.ts`:地址 → 近 N 笔成功 tx;**发现 entity cluster**(executor/funder/receiver)。
- `ingest/seed-profile.ts`:对输入 EOA 先拉 Alchemy/RPC-compatible 分页交易**第一页**,计算
  `eoa_contract_call_ratio` / `contract_reuse_ratio` / `known_venue_touch_ratio` /
  `plain_transfer_ratio`,输出 `seed_profile=executor_like|mixed|low_signal`。
- `ingest/candidates.ts`:高召回候选池分层(见 taxonomy §0.1)。历史批量模式用 `EOA→contract + 便宜 MEV 信号` 控成本;live-shadow/目标区块模式可把同块 `EOA→contract` 全部入池。
- `ingest/external-labels/`:**全部 optional**,缺失/失败即跳过(不影响主流程)。
  - `zeromev.ts`(optional REST,失败降级)· `flashbots-data.ts`(optional 历史 mev-inspect dump)· `eigenphi.ts`(**默认禁用,仅 archived/static import,不接 live service**)。
- `ingest/pnl.ts`:receipt-level PnL,输出 **raw_deltas** + **valued_pnl**(仅可报价 token);记 `net_ex_internal_bribe`(上界,无内部 coinbase)。
- `report/p0.ts`:每 cluster 一张 P0 卡片。

**P0 字段**
```
cluster_id, member_addresses, active_range,
total_tx, mev_labeled_tx,
seed_profile, eoa_contract_call_ratio, contract_reuse_ratio,
execution_candidates, mev_candidates, backrun_candidates, confirmed_backrun,
sandwich_excluded{count, valued_net_share},
directional_excluded{count, valued_net_share, avg_confidence},
unknown_unpriced_excluded{count, raw_delta_note},
pure_backrun_candidates,
pure_backrun_net_ex_internal_bribe,   # 上界
median_net,
top_tokens, top_venues, top_path_shapes(粗),
trace_needed_count,
addressable_profit_ratio,  # 同源同估值,分母=正向可估值利润 Σmax(valued_net,0);见 taxonomy §4
losing_valued_net, unpriced_raw_delta_notes  # 单独披露,不进主分母;全为零利润时 ratio=n/a
```

**验收**
- [ ] 输入 1 个地址 → 自动归簇 → 产出 P0 卡片,**全程不调 trace_\***。
- [ ] 第一页预筛输出 `seed_profile`;`executor_like` 地址继续归簇/P0,`low_signal` 默认不深挖但仍可人工强制。
- [ ] 第一页预筛只作为优先级/召回控制,不得把 `executor_like` 直接当 MEV 或 backrun。
- [ ] `EOA→contract` 只进入 `execution_candidate`;报告明确它不是 MEV 真相,不得计入 addressable ratio。
- [ ] PnL **按 cluster 聚合**(executor/EOA/receiver),不是单地址。
- [ ] `net_ex_internal_bribe` **明确标注为上界**(漏内部 coinbase bribe);报告不得声称是 net_full。
- [ ] `valued_pnl` 只含可报价 token;unknown token 单列、不进 ratio;`raw_deltas` 始终保留。
- [ ] `addressable_profit_ratio` 分子分母**同源 + 同估值**;代码有断言禁止混入 zeromev profit。
- [ ] **每个 excluded bucket 输出 count + valued_net_share**(sandwich / directional / unknown)。
- [ ] PnL 对照:10 笔人工 Etherscan 核对 token delta + gas,与自动值一致。
- [ ] CU 上报:单 cluster(~5000 tx)P0 总消耗 < 阈值(无 trace 应很低)。
- [ ] `ratio < 10%`(或 `n/a`)→ 标 `observe-only`,**不进 Phase 5**。
- [ ] **外部源全部关闭时 P0 仍跑通**;`external_label` 缺失不影响 `our_label`;EigenPhi 不作为必需依赖;ZeroMEV 失败降级为本地分类。

## Phase 4 — 四维分类 + 排除(无 trace)
**实现**
- `classify/cluster.ts`:实体簇归并(taxonomy §3)。
- `classify/sandwich.ts`:基于 cluster 的同块夹击检测(§2.1),含退化的 `sandwich_suspect`。
- `classify/directional.ts`:`directional_suspect`(不成环+无 victim+无 flash),带 confidence。
- `classify/dimensions.ts`:从 receipt/logs 能定的维度 A/部分 B(有无 flash/LP/borrow event)、是否紧跟大额 victim。
- 输出每 tx `{A, B粗, C, D}` + `our_label` vs `external_label` 对照。

**验收**
- [ ] **金标准回归**:block 25411620 的多地址夹子被正确归簇并标 `sandwich` 排除(断言 idx0/idx2 同簇、victim 居中)。
- [ ] **backrun 因果可编码**:`backrun_candidate` 严格按 taxonomy §2.3 五条;standing/atomic(无同块前序 victim 但成环获利)归 excluded,不混入 pure-backrun(单测覆盖)。
- [ ] 三态输出 `backrun_candidate / excluded / unknown`,不做二元过激 false。
- [ ] `our_label` 与 zeromev `external_label`(若可用)一致率统计;不一致样本人工抽查确认我们对;**external 缺失时分类不退化**。
- [ ] directional 桶非空且抽查正确(单向 swap 不被误判成 pure-backrun);报告显示 `excluded_confidence`。
- [ ] 仍**不碰 trace**。

## Phase 5 — 路径形态(维度 B 真相,trace 在此且仅此)
**实现**
- 仅对 Phase 4 标 `pure-backrun / backrun+LP / peg` 且高利润、且 cluster 非 `observe-only` 的样本调 `trace_transaction`。
- `path/builder.ts`:用 shared registry 解码调用树 → 有序协议序列。
- `pnl/full.ts`:trace 后补 **net_full**(含内部 coinbase transfer)。

**验收**
- [ ] **金标准**:wstUSR 参考 tx 还原形态 = `flash→borrow→swap→repay`(对齐 CLAUDE.md 真实路径)。
- [ ] **金标准**:BEL token borrowable=0 → flashToken=BEL 路由判不可执行(与诊断一致)。
- [ ] 形态串复用 shared registry,无独立硬编码协议表。
- [ ] `net_full` 出现后,P0 的 `net_ex_internal_bribe` 与 `net_full` 差额(=内部 bribe)被记录,验证 P0 上界假设。
- [ ] trace 仅本阶段触发,实际调用数 = `trace_needed_count`(无超额 trace)。

## Phase 6 — 画像聚合 + 三层报告 + 人工验证 + 晋升流程
**实现**
- 三层报告:`cluster 总览` / `策略簇` / `代表交易拆解(3-5 笔)`。
- 选 2-3 个 cluster 手动 review。
- 文档化**晋升流程**:`research 路径 → fork replay → 抽象 searcher template → 进 test/ fixture → 才上生产`。

**验收**
- [ ] 3 个 cluster 报告产出,各含 `addressable_profit_ratio` + top path shapes + 全部 excluded bucket 占比。
- [ ] 人工对 1 个 cluster 的策略簇划分,与自动结果方向一致。
- [ ] 至少 1 个"高 alpha 低竞争"形态(`flash→borrow→swap` 或 peg 类)被识别且 fork replay 成功。
- [ ] 晋升流程文档化;一个代表 tx 走完 `replay → template 草稿` 作流程验证。

## Phase 7 — Live Shadow / 失败归因(实盘同区块只读分析)
**目标**
当真实 searcher 运行时,同步记录我们看到/模拟/提交过的机会;区块落地后,用 `analysis`
只读分析同区块竞争 MEV,回答"我们为什么输"。

**边界**
- `listener/searcher` 只 emit 脱敏事件(JSONL/append-only),**不 import analysis**。
- `analysis/live-shadow` 作为 sidecar 消费事件;失败不影响生产 searcher。
- live-shadow 只做 post-block 归因,**绝不改报价、改路径、改广播决策**。
- 不输出私钥、raw env、完整敏感 calldata;允许输出 `calldata_hash` / `path_id` / `victim_hash` / `target_block`。

**实现**
- searcher emit:`opportunity_seen` / `simulation_result` / `bundle_submitted` / `tx_included|not_included`。
- block 落地后,analysis 拉该 block receipt/logs,用 taxonomy §0.1 将同块 `EOA→contract`
  高召回入池,优先筛同 victim / 同 pool / 同 token 的 competitor。
- 对 competitor 打标签:`confirmed_backrun` / `backrun_suspect` / `sandwich_excluded` /
  `directional_suspect` / `standing_arb` / `unknown`。
- 输出 loss attribution:
  `not_submitted` / `victim_not_landed` / `not_included` / `bid_too_low` /
  `latency_or_order_lost` / `path_unsupported` / `quote_drift` /
  `liquidity_consumed` / `competitor_borrow_or_lp_leg` / `unknown`。

**验收**
- [ ] searcher 只写脱敏只读事件;静态扫描确认不包含私钥、`.env`、raw secret、完整敏感 calldata。
- [ ] analysis sidecar 可在生产外单独运行;sidecar 崩溃不影响 searcher。
- [ ] 对每个 target block 产出 post-block report,列出我们机会、落块状态、同块 competitor candidates。
- [ ] 若存在同 pool/token competitor,报告其 tx、cluster、strategy label、粗 path、gas/bribe 估计。
- [ ] 每个 missed opportunity 必须给 `loss_reason`;`unknown` 允许但必须统计占比。
- [ ] trace 只对同 victim/同 pool/高价值 competitor 触发;不对全块无差别 trace。
- [ ] 任何 live-shadow 洞察进入生产前,仍必须走 Phase 6 晋升流程(`research → replay → template → test → prod`)。

---

## 总验收(DoD)
- [ ] `npm run build` 通过;`analysis/` 独立 package,生产测试不受影响。
- [ ] 静态扫描:`listener/searcher` 无 `import .*analysis`。
- [ ] grep 校验:`analysis/` 无 `.env`/私钥/广播引用。
- [ ] `outputs/` 在 `.gitignore`;repo 不被原始 trace 撑大。
- [ ] 三个金标准都成 fixture(wstUSR 成功、BEL 不可借、25411620 多地址夹子),进 CI。
- [ ] 每个 excluded bucket(sandwich / directional / unknown)都报 count + 利润占比。
- [ ] Live Shadow 为只读 sidecar;生产 searcher 与 `analysis/` 仍保持单向隔离。

## 目录结构
```
MEV/
  docs/research/{strategy-taxonomy.md, analysis-plan.md}
  shared/registry/{addresses,selectors,protocols,taxonomy}.json
  scripts/gen-registry.ts
  analysis/
    package.json
    src/{ingest,decode,classify,path,pnl,report,live-shadow}/
    fixtures/{wstusr.json, bel.json, sandwich-25411620.json}
    outputs/        # gitignored
    notebooks/      # 可选 Python 统计/可视化,只读 outputs
```
