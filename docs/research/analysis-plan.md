# MEV Analysis MVP Plan

> 一句话原则：先做 path profiler + live loss analyzer，不做平台。taxonomy 只作为防误判规则，所有输出都要服务“这个 path 我们能不能学、为什么现在赢不了”。

本文替代平台式 Phase 1-7 计划。目标是两个小而硬的 CLI 工具。

## 0. 目标与非目标

### 目标

1. **Address Path Profiler**
   输入 MEV 地址，输出该 searcher 做过哪些 path、代表交易、动作序列、粗 PnL、我们是否支持、缺什么。

2. **Live Loss Analyzer**
   消费 searcher 脱敏 JSONL，区块落地后找 competitor，输出我们为什么输。

3. **Promotion loop**
   高价值 path 经过 trace → replay → template draft → fixture → searcher，再进生产。

### 非目标

- 不做全市场 MEV 平台。
- 不做 dashboard。
- 不做长期大规模 indexer。
- 不做完整 taxonomy 宇宙。
- 不做外部标签依赖。
- 不做自动策略上线。
- 不做 AA/solver/v4 hook 全覆盖，除非实际样本需要。

## 1. 全局不变量

- `analysis/` 绝不读私钥、绝不广播。
- 不读 repo root `.env`，不自动 dotenv。
- RPC/API 只从 CLI 参数或 `READONLY_RPC_URL` 进来。
- 生产 `listener/searcher` 绝不 import `analysis/`。
- searcher 只 emit 脱敏 JSONL(无私钥 / raw env / 完整敏感 calldata)。
- `builders_sent` 等潜在敏感字段:本地明文可,**报告里 hash 或 redact**。
- `analysis/outputs/` gitignored。
- trace 有预算,不全量 trace;**每次 run 设 CU 上限**(当前 Alchemy 余量紧,默认保守)。
- PnL 粗算与 `net_full` 分开。
- entity cluster != strategy cluster。
- same funder 单条不 merge。
- unknown path 不丢弃。
- 每个报告必须输出 `our_gap` / `next_action`。

## 2. 目录结构

```text
analysis/
  package.json

  src/
    cli/
      address.ts
      live-loss.ts

    rpc/
      client.ts
      txlist.ts
      receipts.ts
      block.ts
      trace.ts

    registry/
      prod-surface.ts       # 从 searcher adapters 生成，表示我们能执行
      decode-surface.ts     # analysis-only，表示我们能识别

    decode/
      logs.ts
      calls.ts
      erc20.ts

    actions/
      vocabulary.ts
      from-logs.ts
      from-trace.ts
      canonicalize.ts

    cluster/
      entity.ts
      strategy.ts

    classify/
      sandwich.ts
      directional.ts
      backrun.ts
      standing.ts
      lp.ts

    pnl/
      raw-delta.ts
      rough-value.ts
      gas.ts
      bid.ts

    report/
      address-report.ts
      live-loss-report.ts

  fixtures/
    wstusr.json
    bel.json
    sandwich-25411620.json
    lp-positioned.json
    router-fp.json

  outputs/
    address/
    live-loss/
```

先不用数据库。本地 JSON / JSONL / Markdown 足够。

## 3. Phase 1 — Minimal registry + action decoder

### 实现

- `registry/prod-surface.ts`
  - 从 searcher adapter / path template 生成。
  - 表示我们当前能执行什么。
- `registry/decode-surface.ts`
  - analysis-only。
  - 可包含我们不能执行但想识别的协议。
- `actions/from-logs.ts`
  - receipt/logs → actions。
- `actions/from-trace.ts`
  - trace → 补全 actions。
- `actions/canonicalize.ts`
  - actions → canonical action sequence。

### v1 支持动作

```text
fund.flashloan
fund.self
fund.flashmint
trade.swap
credit.deposit_collateral
credit.withdraw_collateral
credit.borrow
credit.repay
position.lp.mint
position.lp.burn
position.lp.rebalance
peg.redeem
peg.mint
wrap
unwrap
settlement.profit_transfer
settlement.coinbase_payment
unknown.action
```

### 验收

- wstUSR fixture 能输出 `flashloan -> deposit_collateral -> borrow -> swap/redeem -> buyback -> repay` 近似序列。
- LP-positioned:Phase 1 先用**人工 fixture / 代表 tx** 跑通 `mint_lp -> swap/arb -> burn_lp`;**真实链上样本找到后再补 CI,不卡 Phase 1**。
- 未识别 event 不 crash，输出 `unknown.action`。
- prod-surface / decode-surface 都是纯数据，无密钥、无广播。
- report 能标 `prod_supported | decode_only | unknown_observed`。

## 4. Phase 2 — Tool A: Address Path Profiler

### CLI

```bash
pnpm analysis address \
  --seed 0x... \
  --chain mainnet \
  --limit 1000 \
  --rpc $READONLY_RPC_URL \
  --trace-top 5          # 默认保守护 CU(Alchemy 余量紧),需要再调高
```

可选：

```bash
--from-block
--to-block
--force-trace 0xhash1,0xhash2
--output analysis/outputs/address/0x....md
```

### Pipeline

```text
seed address
  -> 拉近 N 笔成功 tx
  -> 识别 executor calls / EOA->contract
  -> 拉 receipts/logs
  -> 轻量 entity evidence graph
  -> logs-first action extraction
  -> rough raw_deltas / rough pnl
  -> 选 representative/high-value/unknown tx 做预算内 trace
  -> trace 补全 action sequence
  -> strategy clustering
  -> address path report
```

### Report 必填字段

```yaml
seed:
chain:
range:
entity_cluster:
  members:
  confidence:
  edges:
  overmerge_risk:

summary:
  total_tx:
  analyzed_tx:
  traced_tx:
  strategy_cluster_count:
  unknown_replayable_count:
  excluded_count:

strategy_clusters:
  - id:
    path_template:
    canonical_sequence:
    tx_count:
    representative_tx:
    tokens:
    venues:
    protocols:
    funding:
    strategy_type:
    rough_pnl:
    net_full:
    our_support:
    prod_support_gap:
    our_gap:
    next_action:

excluded:
  sandwich:
  directional_suspect:
  standing:
  router_or_solver_fp:

unknown_replayable:
  - sequence_hash:
    canonical_sequence:
    representative_tx:
    rough_pnl:
    reason:
    suggested_review:
```

### Strategy cluster key

```text
path_template / canonical_sequence_hash
+ strategy_type
+ token_family
+ venue/protocol_family
+ funding_type
+ revenue_source
+ exclusion_bucket
```

### 验收

- 输入 1 个 MEV 地址，能输出 Markdown + JSON 报告。
- entity → 多 strategy clusters，不给 entity 单一策略标签。
- same funder 单条只记 weak edge，不合并。
- EOA→contract 只标 candidate，不直接等于 MEV/backrun。
- 每个 strategy cluster 有 representative tx。
- 每个 representative tx 有 canonical action sequence。
- 输出 `our_support` / `prod_support_gap` / `our_gap`。
- `unknown_replayable` 不为空时必须列出，不得吞掉。
- sandwich / directional / standing 排除项单独列。
- trace 数量 <= `--trace-top` 或预算阈值。
- 每次 trace 记录 `trace_reason`。

## 5. Phase 3 — Representative tx trace + path truth

### 目标

只对有研究价值的交易 trace，不全量 trace。

### trace 触发条件

任一满足：

```text
strategy cluster representative tx
valued_net top-N
unknown_replayable
LP mint/burn + swap
borrow/repay + swap
peg/redeem/wrap + swap
live-loss competitor
manual force-trace
fixture
```

### 输出

```yaml
path_truth:
  tx_hash:
  trace_reason:
  canonical_sequence_from_logs:
  canonical_sequence_from_trace:
  path_template:
  protocols:
  internal_coinbase_transfer:
  net_full:
  confidence:
```

### 验收

- trace 有预算，不全量 trace。
- 每个 trace 有 `trace_reason`。
- trace 后能修正 logs-only action sequence。
- wstUSR path truth 对齐 `flash→borrow→swap→repay`。
- BEL borrowability=0 能被判不可执行。
- P0 粗 PnL 和 trace `net_full` 差异能解释为内部 bribe / 未报价 token / trace 补全。

## 6. Phase 4 — Tool B: Live Loss Analyzer

### 前置任务(Tool B 的第 0 步)

Tool B 依赖 searcher emit 这套 JSONL,但 searcher 现在只 `console.log("submitted via…")`。
**所以 Tool B 第一步是给 searcher 加结构化 emit**——这是**唯一一处碰热路径的改动**:只读 append-only、
脱敏、不 import analysis、失败不影响下单。在它落地前,**用历史败例做开发/测试**:

- **历史 seed**:block 25411620(victim `0xaca468a9…`,pre/post 同簇夹子)我们已有全 hash,
  直接构造一条 events fixture,让 Tool B 不必等实盘就能跑通"找 competitor + 归因 loss"。

### searcher JSONL 事件

生产只写脱敏事件，不 import analysis。

#### opportunity_seen

```json
{
  "type": "opportunity_seen",
  "target_block": 123,
  "victim_hash": "0x...",
  "pool": "0x...",
  "tokens": ["WETH", "USDC"],
  "path_id": "univ3_curve_backrun",
  "template_id": "swap_loop",
  "simulated_profit": "420000000000000000",
  "seen_at_ms": 123456789
}
```

#### simulation_result

```json
{
  "type": "simulation_result",
  "target_block": 123,
  "victim_hash": "0x...",
  "path_id": "univ3_curve_backrun",
  "ok": true,
  "simulated_profit": "420000000000000000",
  "gas_estimate": "250000",
  "finished_at_ms": 123456900
}
```

#### bundle_submitted

```json
{
  "type": "bundle_submitted",
  "target_block": 123,
  "victim_hash": "0x...",
  "path_id": "univ3_curve_backrun",
  "bid": "210000000000000000",
  "builders_sent": ["flashbots", "builder0x69"],
  "submitted_at_ms": 123456999
}
```

#### tx_included / tx_not_included

```json
{
  "type": "tx_not_included",
  "target_block": 123,
  "victim_hash": "0x...",
  "path_id": "univ3_curve_backrun",
  "reason_from_searcher": "bundle_not_included"
}
```

不写私钥、raw env、完整敏感 calldata。允许写：

```text
calldata_hash
path_id
template_id
victim_hash
target_block
pool
tokens
bid
builders_sent
```

### CLI

```bash
pnpm analysis live-loss \
  --events ./analysis/events/searcher.jsonl \
  --block 123 \
  --rpc $READONLY_RPC_URL
```

### Pipeline

```text
读取 target block 的 searcher events
  -> 拉 block tx + receipts
  -> 判断 victim 是否 landed
  -> 判断我们 tx 是否 included
  -> 找同 victim / 同 pool / 同 token competitor
  -> competitor logs-first actions
  -> 高价值 competitor 预算内 trace
  -> competitor path summary
  -> bid / gas / bribe 粗估
  -> loss reason
  -> live loss report
```

### Live competitor coverage mode

#### 目标

这个模式回答一个比单笔 loss 更上游的问题:

```text
在同一段 live/dry-run 时间窗口里:
  我们看见了多少 victim / opportunity?
  watchlist MEV bot 实际上链了多少 tx?
  其中多少是 sandwich,多少是非 sandwich path candidate?
  我们没看见的是 pool/router 覆盖问题、private flow、还是策略排除?
```

这不是全市场 MEV indexer,只服务生产 searcher 的 loss observability。
默认只扫本次 JSONL 覆盖的 block range,只看显式 `--watch` 地址簇。

#### CLI

```bash
pnpm analysis live-loss \
  --events ./analysis/events/searcher.jsonl \
  --watch 0xae2Fc483527B8EF99EB5D9B44875F005ba1FaE13,0x1f2f10d1c40777ae1da742455c65828ff36df387 \
  --coverage \
  --trace-top 0 \
  --rpc $READONLY_RPC_URL
```

可选:

```bash
--from-block 25427768
--to-block 25427913
--max-blocks 200
--trace-top 3
--output analysis/outputs/live-loss/coverage-<run>.md
```

#### 核心实现

保持小改动,优先复用现有 Tool B 代码:

```text
live-loss.ts
  -> 读取 searcher JSONL,建立 our_seen index:
       seen_by_block
       seen_by_victim_hash
       seen_by_pool
       seen_by_token_pair

  -> scanWatchlist(range, watch):
       每个 block 拉 full transactions
       本地筛 from/to 命中 watchlist EOA / executor
       只对命中 tx 拉 receipt
       不扫描全市场、不中长期存储

  -> decodeCompetitorTx(receipt):
       复用 actions/from-logs.ts
       输出 token transfers、swap legs、borrow/LP/peg/wrap markers
       生成 canonical_sequence / path_template

  -> classifyLocalBundle(block, watchMatches):
       识别同 actor / strongly-linked actor 的 pre-victim-post sandwich
       sandwich 计入 coverage,但不进入 backrun-loss 核心样本
       若 sandwich post 后存在可原子 exit,标记 post_state_opportunity_candidate

  -> compareWithOurSeen(match):
       exact_victim_seen
       same_block_seen
       same_pool_seen
       same_token_pair_seen
       not_seen_by_us

  -> renderCoverageReport()
```

新增模块建议:

```text
analysis/src/watch/scan.ts              # block range + watchlist tx scan
analysis/src/watch/coverage.ts          # our_seen vs competitor_executed 对比
analysis/src/classify/local-sandwich.ts # 同块 pre/victim/post 轻量识别
analysis/src/report/coverage-report.ts  # Markdown + JSON 输出
```

如果为了保持第一刀更小,也可以先把 `watch/scan` 和 `coverage` 放在
`cli/live-loss.ts` 内部,验收通过后再拆模块。

#### Report 必填字段

```yaml
run:
  events_file:
  block_range:
  duration_blocks:

our_coverage:
  opportunity_seen:
  unique_victims_seen:
  unique_blocks_seen:
  submitted:
  included:

competitor_coverage:
  watchlist:
    - address:
      role: eoa | executor | contract
  executed_total:
  executed_blocks:
  exact_victim_seen_by_us:
  same_block_seen_by_us:
  same_pool_seen_by_us:
  same_token_pair_seen_by_us:
  not_seen_by_us:

classification_breakdown:
  sandwich_excluded:
  sandwich_suspect:
  non_sandwich_path_candidate:
  standing_or_atomic:
  directional_suspect:
  unknown_replayable:
  unknown_opaque:

representative_matches:
  - competitor_tx:
    block:
    index:
    actor:
    classification:
    our_visibility:
      exact_victim_seen:
      same_block_seen:
      same_pool_seen:
      same_token_pair_seen:
      not_seen_reason:
    path_summary:
      canonical_sequence:
      path_template:
      legs:
        - tokens:
          venues:
          amounts:
          confidence:
      funding:
      protocols:
    sandwich_evidence:
      pre_tx:
      victim_tx:
      post_tx:
      shared_pool:
      inventory_closed:
      profit_estimate:
    our_gap:
    next_action:
```

#### Sandwich 处理口径

Sandwich 不进入 `pure_backrun_loss` 样本,但必须进入 coverage 统计。
原因:我们不做 sandwich,但它仍然回答"别人执行了多少、我们有没有看见 victim"。

分类结果应区分:

```text
sandwich_excluded
  -> 不算 path gap / bid gap / builder gap
  -> 计入 competitor_executed_total
  -> 计入 visibility gap,如果 our_seen_block=false 或 same_pool_seen=false

excluded_sandwich_but_has_post_state_opportunity
  -> sandwich 本体排除
  -> 额外检查 victim 后状态是否存在 backrun-only 原子 exit
  -> 有 exit:进入 path/pool gap review
  -> 无 exit:标 inventory/sandwich-only,不污染 backrun 样本
```

例子:AI/USDC sandwich:

```text
pre:    bot sells AI -> USDC
victim: user sells AI -> USDC
post:   bot buys AI back with USDC
```

这说明 bot sandwich 有利润,但不自动说明 backrun-only 有闭环利润。
coverage report 要同时输出:

```yaml
classification: sandwich_excluded
visibility_gap: true|false
post_state_opportunity_candidate: true|false
reason:
  - sandwich profit depends on pre inventory leg
  - backrun-only requires separate atomic exit route
```

#### Path / leg 摘要口径

Coverage mode 不要求完整 trace 才输出 path。logs-first 必须输出可解释的 leg:

```yaml
legs:
  - type: swap_loop
    tokens: [WETH, ALCX, crvFRAX, USDC, WETH]
    venues: [UniswapV3, Balancer, Curve, UniswapV3]
    confidence: logs

  - type: credit_wrapper_loop
    tokens: [USDC, GHO, waEthLidoGHO, waEthUSDT, USDT, USDC]
    venues: [UniswapV3, Aave-wrapper, Balancer, Aave, Curve]
    confidence: logs
```

如果同一 competitor tx 同时包含 sandwich leg 和 non-sandwich leg,报告必须拆开:

```text
tx classification = mixed
leg[0] = sandwich_excluded
leg[1] = standing_or_atomic / unknown_replayable
```

不得因为 tx 里存在 sandwich 就丢掉其它非 sandwich leg;也不得把 sandwich leg
算成我们没赢的 pure backrun。

### Loss reason

v1 只保留这些：

```text
victim_not_landed
not_submitted
not_included
bid_too_low
builder_not_covered
path_unsupported
capital_unavailable
quote_drift
liquidity_consumed
competitor_borrow_leg
competitor_lp_leg
competitor_peg_or_redeem_leg
competitor_faster_same_path
no_alpha_gross_lower
unknown
```

Coverage mode 额外输出这些 coverage reason,它们不是单笔 loss reason:

```text
not_seen_by_us
seen_block_but_not_pool
seen_pool_but_no_plan
competitor_sandwich_excluded
competitor_standing_not_victim_triggered
competitor_non_sandwich_candidate
watchlist_private_or_builder_only
```

### Report 必填字段

```yaml
block:
our_opportunity:
  victim:
  pool:
  tokens:
  path_id:
  template_id:
  simulated_profit:
  submitted:
  bid:
  builders_sent:
  included:

victim_status:
  landed:
  victim_index:

competitors:
  - tx_hash:
    index:
    from:
    to:
    same_victim:
    same_pool:
    same_tokens:
    canonical_sequence:
    path_template:
    rough_profit:
    effective_bid_estimate:
    competitor_edge:
      - borrow_leg
      - lp_leg
      - higher_bid
      - consumed_liquidity

loss:
  primary_reason:
  secondary_reasons:
  confidence:
  evidence:
  next_action:
```

### 决策树

```text
1. victim 没落地 -> victim_not_landed
2. 我们没有提交 -> not_submitted
3. 我们提交但没进 -> not_included / builder_not_covered / bid_too_low
4. 同 pool/token 有 competitor:
   - competitor 同 path, bid 更高 -> bid_too_low 或 competitor_faster_same_path
   - competitor 多 borrow leg -> competitor_borrow_leg / path_unsupported / capital_unavailable
   - competitor 多 LP leg -> competitor_lp_leg / path_unsupported
   - competitor 多 peg/redeem leg -> competitor_peg_or_redeem_leg / path_unsupported
   - competitor 先消耗流动性 -> liquidity_consumed
5. gross 明显低于 competitor -> no_alpha_gross_lower
6. 否则 unknown
```

### 验收

- 能读取 searcher JSONL。
- 能判断 victim 是否 landed。
- 能判断我们 tx 是否 included。
- 能找同 victim / 同 pool / 同 token competitor。
- competitor 有 canonical action sequence。
- 若 competitor 使用 borrow/LP/peg leg，报告能指出。
- 每个 missed opportunity 必须给 `loss.primary_reason`。
- unknown 允许，但必须统计占比。
- trace 只对同 victim/同 pool/高价值 competitor 触发，不对全块无差别 trace。
- searcher 不 import analysis。
- analysis 不读私钥、不广播。
- Coverage mode 能在同一 run 中输出:
  - 我们 `opportunity_seen / unique_victims_seen`
  - watchlist `competitor_executed_total`
  - `not_seen_by_us`
  - `sandwich_excluded`
  - `non_sandwich_path_candidate`
- 给定 block `25427813` 的 Jared 样本,能识别:
  - `0xad639...` + `0x9aac...` + `0x498e...` 的 AI/USDC sandwich leg;
  - 该 leg 标 `sandwich_excluded`,不进入 pure backrun loss;
  - 同一 tx 内其它 WETH/ALCX/GHO/Aave/Curve/Balancer legs 单独列为 non-sandwich / standing / unknown_replayable candidate。
- Coverage report 中每个 representative competitor tx 必须有 `legs/path_summary`。
- `--watch` 为空时 coverage mode 不运行,现有 live-loss 行为不回归。
- 默认 `--trace-top 0`,logs-first 可用;只有 representative non-sandwich candidate 才允许预算内 trace。
- block range 超过 `--max-blocks` 时拒跑,除非显式 override。
- 不写 raw calldata / raw trace / 私钥 / RPC URL / builder 明文到 docs/reports。

## 7. Phase 5 — Manual promotion loop

### 目标

把 Address Profiler / Live Loss Analyzer 发现的高价值 path 变成 searcher template。

### 流程

```text
发现高价值 path
  -> representative tx trace
  -> fork replay
  -> 写 path note
  -> 添加 searcher template 草稿
  -> 添加 fixture
  -> shadow / dry-run
  -> prod
```

### path note 模板

```yaml
path_name:
representative_tx:
canonical_sequence:
required_protocols:
required_tokens:
required_capital:
required_flash_or_borrow_source:
entry_condition:
exit_condition:
expected_profit_source:
main_failure_cases:
our_current_gap:
implementation_tasks:
fixtures:
```

### 验收

每个 promoted path 必须有：

- representative tx。
- canonical action sequence。
- replay result。
- expected opportunity condition。
- required capital / flash source。
- required adapter。
- failure cases。
- fixture。
- searcher template draft。

## 8. 总 DoD

MVP 完成的标准不是 taxonomy 完整，而是：

1. 跑 10 个 MEV 地址，Address Path Profiler 能说清楚每个 searcher 的 3-5 个主要 path。
2. 跑 20 次实盘 missed opportunity，Live Loss Analyzer 至少 70% 给出有用 loss reason。
3. 至少发现 1-2 个高价值 path，完成 trace + replay + template draft。
4. CI 通过：
   - wstUSR。
   - BEL borrowability=0。
   - sandwich-25411620。
   - LP-positioned(真实样本补后入 CI;Phase 1 先用人工 fixture,不卡)。
   - router false positive(同上,真实样本补后入 CI)。
5. 静态扫描通过：
   - `listener/searcher` 无 `import analysis`。
   - `analysis/` 无私钥 / 广播 / root `.env` 引用。
6. outputs gitignored。
7. CU 纪律:每次 profiler/live-loss run 有 CU 上限并在报告里上报实际用量;trace 受 `--trace-top`/预算约束。

## 9. Production contract

本节是 event / coverage 的**权威契约**。本文前面的内联 JSONL 示例是示意,可能过时;**与本节冲突时以本节为准**,真实源是 [`listener/src/searcher/events.ts`](../../listener/src/searcher/events.ts)。这一刀不是大改,只是把"方向正确"收紧成"可按它实现"。

### 9.1 Event envelope(每条事件都带)

```text
type, opportunity_id, target_block, victim_hash, emitted_at_ms
schema_version   # 整数;任何 breaking 字段变更就 +1
run_id           # 每个 searcher 进程一个,绑定一次 run 的所有事件
chain_id         # mainnet=1
```

- schema_version 策略(轻量):analyzer 读它;遇到未知/更高 major → 警告 + 跳过,**不静默错解析**。无需向后改写——emitter 和 analyzer 一起发版。

### 9.2 Event 形状(对齐 events.ts,不是旧示例)

- `opportunity_seen`:`+ pool?, tokens?`。**没有 `path_id` / `template_id` / `simulated_profit`**——detect 阶段还不知道 path/利润。(修正旧示例。)
- `simulation_result`:`+ path_id?, template_id?, ok, simulated_profit?, profit_token?, gas_estimate?, failure_reason?`。
- `pipeline_dropped`:`+ stage, reason, error?, pool?, tokens?, path_id?, template_id?, plans?, no_candidate_diagnostic?`。
- `bundle_submitted`:`+ submission_target_block?, mode, path_id?, template_id?, simulated_profit?, simulated_profit_eth?, bid?, tx_hash(签名后的 backrun tx hash), calldata_hash, builders_sent?, bundle_hash?, accepted?`。
- **没有 `tx_included` / `tx_not_included` searcher 事件。** inclusion 由 **analyzer 推导**:用 `bundle_submitted.tx_hash` +(`submission_target_block ?? target_block` 及小幅向后看几块)在落块里查。热路径绝不轮询 inclusion。

### 9.3 opportunity_id(稳定、seen 阶段可算)

```text
opportunity_id = keccak256(target_block | victim_hash | pool | sorted(tokens))
```

**不得含 path_id/template_id**(seen 时未知 → 会把同一机会在不同阶段拆成不同 group)。seen / sim / dropped / submitted 全程同一个 id。

### 9.4 Watch-miss 根因(not_seen 分桶 —— 让它可执行)

每个 `not_seen_by_us` 必须带确定性根因,映射到**单一 owner/修复**:

```text
router_not_watched            # victim.to ∉ filtered-mempool 的 toAddress 列表  → 修:把 router 加进 mempool filter
pool_not_in_graph             # impacted pool ∉ routing graph                   → 修:把 pool 加进 graph
token_pair_not_in_universe    # pair 不在 token graph                           → 修:扩 universe
private_or_builder_only       # 从未进公开 mempool                              → mempool 修不了
seen_pool_but_no_plan         # 看到了但 planner 没建出 plan                    → planner/template gap
standing_not_victim_triggered # 无同块 victim                                   → 另一类策略(见 9.6)
unknown
```

每个 miss 必填:`victim_to`(tx.to)、`matched_watch_rule`(本该匹配它的 filter 规则,或 null)。**这就是把"加一个 router"和"加一个 pool"分开的关键。**

### 9.5 Actor-linking / sandwich 阈值(确定性 v1)

v1 confirmed sandwich 必须**全部**满足:

```text
同 executor 或 同 sender(不靠跨 actor 的 "linked")
AND 同 block
AND 同 pool
AND 反向腿(pre 卖 X→Y,post 买 Y→X)
AND inventory 在容差内闭合(|净 token delta| ≤ 腿规模的 ~1%)
```

跨 actor 的 "strongly-linked"(共享 funder/builder)→ 只标 `sandwich_suspect`,**永不 confirmed**(避免误合并假阳性)。经验:这套 same-actor 规则把某 bot 的 116 笔拆成 80 夹子对 / 17 独立 / 19 多笔块——确实能分腿。

### 9.6 Standing-arb-no-victim 是终态

`standing_not_victim_triggered` = competitor leg 无同块 victim → 它是**扫链上 state 的 standing/inventory arb,我们 victim-trigger 的 mempool 模型按设计就抓不到**。这类的 `next_action` **必须**写"另一类策略,不是 coverage/latency/bid 能修的"——不得归成 missed backrun,也别去"补覆盖"。

### 9.7 Partial-scan completeness(轻量 degraded 行为)

coverage / watch 报告必须输出:

```text
scanned_blocks / total_blocks / completeness_pct / omitted_blocks[]
```

`completeness_pct < 100` 时标 `partial: true`。(这个离线单机工具**不需要** reorg/retry/backoff 全套——只要别把截断扫描误读成完整即可。)

### 9.8 两个新增 CI fixture(对应 9.4 / 9.5)

- `false-sandwich-linkage`:两个无关 actor、同 pool/block,**不得**被合并成 sandwich(保持 `sandwich_suspect`)。
- `router-miss`:competitor victim 的 `to` 不在 filter 里 → 必须分类 `router_not_watched` 且 `victim_to` 已填。
