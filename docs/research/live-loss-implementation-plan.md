# Live Loss Implementation Plan

> 一句话原则：先把“我们为什么输”观测清楚，再决定修 path、bid、builder 还是 latency。不要做平台，不要做全市场 indexer。

## 0. 目标

给实盘 searcher 加一条只读、脱敏、append-only 的 telemetry 流，让 `analysis live-loss` 能在区块落地后生成本地 Markdown/JSON 报告，回答每个 missed opportunity：

- victim 是否真的落地。
- 我们是否生成机会、是否模拟成功、是否提交、是否 included。
- 同 block / 同 victim / 同 pool / 同 token 有没有 competitor。
- competitor 是同 path 更快/更高 bid，还是用了我们没有的 borrow / LP / peg / v4 / 多跳 path。
- 下一步应该修 inclusion，还是修 path template / adapter / pool universe。

## 1. 非目标

- 不做 dashboard。
- 不做长期全市场 indexer。
- 不提交所有 live outputs。
- 不自动 promotion 到生产策略。
- 不在 `listener` 里 import `analysis`。
- 不记录私钥、raw env、完整敏感 calldata、钱包路径。
- 不把 `unknown` 强行猜成 borrow/LP/peg。

## 2. 总体架构

```text
listener/searcher live run
  -> emit 脱敏 JSONL 到 analysis/events/searcher.jsonl
  -> block landed 后运行 analysis live-loss
  -> 生成 analysis/outputs/live-loss/<block>-<victim>.md/json
  -> 人工挑代表性样本复制到 docs/research/reports/live-loss/
  -> 根据 loss reason 分布决定修复方向
```

边界：

- `listener` 只负责写事件，不调用 analysis。
- `analysis` 只读 JSONL + RPC，不读私钥，不广播。
- emitter 失败必须 fail-open，不影响 searcher 下单/模拟。
- `analysis/events/` 和 `analysis/outputs/` 必须 gitignored。

## 3. Telemetry Contract

所有事件必须带：

```json
{
  "type": "event_type",
  "opportunity_id": "stable-id",
  "target_block": 123,
  "victim_hash": "0x...",
  "emitted_at_ms": 123456789
}
```

`opportunity_id` 建议：

```text
keccak256(target_block | victim_hash | pool | sorted(tokens))
```

`opportunity_id` 必须只依赖 detect/opportunity_seen 阶段已经知道的字段。`path_id` / `template_id` 是后续 planner/solver 产物，只能作为事件属性，不能进入 id 公式，否则同一机会在不同阶段会被分成不同 group。可以本地保存 hash 字符串，不需要可逆。

### opportunity_seen

```json
{
  "type": "opportunity_seen",
  "opportunity_id": "0x...",
  "target_block": 123,
  "victim_hash": "0x...",
  "pool": "0x...",
  "tokens": ["WETH", "USDC"],
  "emitted_at_ms": 123456789
}
```

`opportunity_seen` 不带 `path_id` / `template_id` / `simulated_profit`。这些字段在 detect 阶段通常还不存在，应由后续事件补充。

### pipeline_dropped

```json
{
  "type": "pipeline_dropped",
  "opportunity_id": "0x...",
  "target_block": 123,
  "victim_hash": "0x...",
  "stage": "plan",
  "reason": "no_candidate_plans",
  "error": null,
  "pool": "0x...",
  "tokens": ["WETH", "USDC"],
  "plans": 0,
  "emitted_at_ms": 123456850
}
```

`pipeline_dropped` closes the `opportunity_seen -> simulation_result` blind spot. It records why a seen opportunity stopped before submit, without raw calldata or secrets.

### simulation_result

```json
{
  "type": "simulation_result",
  "opportunity_id": "0x...",
  "target_block": 123,
  "victim_hash": "0x...",
  "path_id": "univ3_curve_backrun",
  "template_id": "swap_loop",
  "ok": true,
  "simulated_profit": "420000000000000000",
  "profit_token": "0x...",
  "gas_estimate": "250000",
  "failure_reason": null,
  "emitted_at_ms": 123456900
}
```

### bundle_submitted

```json
{
  "type": "bundle_submitted",
  "opportunity_id": "0x...",
  "target_block": 123,
  "submission_target_block": 124,
  "victim_hash": "0x...",
  "mode": "eth_sendBundle",
  "path_id": "univ3_curve_backrun",
  "template_id": "swap_loop",
  "simulated_profit": "420000000000000000",
  "simulated_profit_eth": "210000000000000000",
  "bid": "105000000000000000",
  "tx_hash": "0x...",
  "calldata_hash": "0x...",
  "builders_sent": ["flashbots", "builder0x69"],
  "bundle_hash": "0x...",
  "accepted": 1,
  "emitted_at_ms": 123456999
}
```

`target_block` stays the same detect-time block used by `opportunity_id`. For mined-victim or standalone submission, `submission_target_block` records the intended builder target block as context.

`tx_hash` must be the signed backrun transaction hash, not only a bundle hash or calldata hash.

### inclusion_result

The searcher should not poll post-block inclusion in the hot path. `tx_included` / `tx_not_included` are analyzer-derived states, not required searcher events.

The only hard requirement is: `bundle_submitted` must include the signed backrun `tx_hash`. After the block lands, `analysis live-loss` calls `eth_getTransactionByHash(tx_hash)` and treats a non-null `blockNumber` as included. This avoids false `not_included` reports when a builder lands the backrun later than `submission_target_block`.

## 4. Redaction Rules

允许写入 JSONL：

- `opportunity_id`
- `target_block`
- `submission_target_block`, if different from `target_block`
- `victim_hash`
- `pool`
- token symbols 或 token addresses
- `path_id`
- `template_id`
- `mode`
- `simulated_profit`
- `simulated_profit_eth`
- `profit_token`
- `gas_estimate`
- `failure_reason`
- `bid`
- `tx_hash`
- `calldata_hash`
- `builders_sent`
- `bundle_hash`
- `accepted`
- timing metrics

禁止写入 JSONL：

- private key / mnemonic / wallet path
- raw env
- full sensitive calldata
- RPC URL
- signing payload
- builder auth secret
- strategy threshold secret

报告输出规则：

- `builders_sent` 在 Markdown 中 hash/redact。
- `calldata_hash` 可以显示，raw calldata 不显示。
- local JSONL 可以明文记录 builder name，但不提交。

## 5. Live Loss Pipeline

```text
read events for target block / opportunity_id
  -> group opportunity_seen / simulation_result / bundle_submitted
  -> fetch target block + receipts
  -> victim landed?
  -> derive whether our tx_hash was included
  -> find competitor after victim:
       same pool first
       same token second
       same victim only when same pool/token evidence exists
  -> decode competitor logs
  -> trace only top-N competitor
  -> classify competitor edge
  -> emit loss report
```

competitor ranking v1：

```text
same_pool_after_victim
  > same_tokens_after_victim
  > higher rough value
  > LP/borrow/peg edge
```

trace policy：

- Default `--trace-top 3`.
- Trace same-pool competitor first.
- Do not trace whole block.
- Every traced tx must record `trace_reason`.

## 6. Loss Reason Taxonomy

v1 reasons：

```text
victim_not_landed
not_seen
simulation_failed
not_submitted
tx_included_but_bad_pnl
not_included
bid_too_low
builder_not_covered
competitor_faster_same_path
competitor_borrow_leg
competitor_lp_leg
competitor_peg_or_redeem_leg
path_unsupported
capital_unavailable
quote_drift
liquidity_consumed
no_alpha_gross_lower
unknown
```

决策口径：

- victim 不在目标 block：`victim_not_landed`
- 没有 `opportunity_seen`：`not_seen`
- sim 失败：`simulation_failed`
- sim 成功但没有提交：`not_submitted`
- 提交但未 included，且无 competitor：`not_included`
- 同 path competitor effective bid 明显更高：`bid_too_low`
- competitor 有 borrow leg：`competitor_borrow_leg`
- competitor 有 LP leg：`competitor_lp_leg`
- competitor 有 peg/redeem leg：`competitor_peg_or_redeem_leg`
- competitor path 我们没有 support：`path_unsupported`
- 同 pool 被 competitor 先消耗：`liquidity_consumed`
- 无法归因：`unknown`

## 7. Report Required Fields

```yaml
block:
opportunity_id:

our_opportunity:
  victim:
  pool:
  tokens:
  path_id:
  template_id:
  simulated_profit:
  simulation_ok:
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
    same_pool:
    same_tokens:
    canonical_sequence:
    path_template:
    rough_profit:
    effective_bid_estimate:
    competitor_edge:
      - borrow_leg
      - lp_leg
      - peg_or_redeem_leg
      - same_token_or_pool_execution

loss:
  primary_reason:
  secondary_reasons:
  confidence:
  evidence:
  missing_evidence:
  next_action:

stats:
  block_tx:
  receipts_analyzed:
  competitors_found:
  unknown_competitors:
  traced_tx:
  trace_top:
```

## 8. Implementation Phases

### Phase A — Emitter Contract

Add a tiny `listener` emitter module:

- Append-only JSONL writer.
- Configured by env/path, default local path under `analysis/events/`.
- No import from `analysis`.
- Fail-open on write error.
- Unit test with temp file.

Acceptance:

- Searcher can emit `opportunity_seen`, `simulation_result`, `bundle_submitted`.
- Event schema has `opportunity_id`.
- `opportunity_id` uses only detect-time fields: `target_block`, `victim_hash`, `pool`, `tokens`.
- `bundle_submitted` includes signed backrun `tx_hash`.
- Emitter failure does not throw into searcher flow.
- Static check: `listener` has no `import ... analysis`.

### Phase B — Analyzer Adapter

Update `analysis live-loss` to group events by `opportunity_id` and target block.

Acceptance:

- Reads JSONL with multiple opportunities in one block.
- Can run one block or one `opportunity_id`.
- Generates one Markdown/JSON per selected opportunity.
- Report includes all required fields in section 7.

### Phase C — Historical Fixture

Add one historical JSONL fixture for a known missed/sandwich-like block.

Acceptance:

- Fixture does not need private RPC to parse.
- `analysis live-loss --events fixture --block ...` runs with read-only RPC.
- Report identifies victim landed status.
- Report finds at least one same-pool or same-token competitor.
- If competitor has LP/borrow/peg leg, report names it.

### Phase D — Live Dry Run

Run live searcher in dry-run or guarded mode with telemetry enabled.

Acceptance:

- Produces JSONL in `analysis/events/`.
- Produces at least 5 missed-opportunity reports.
- No private key/RPC URL/raw calldata appears in JSONL or Markdown.
- `analysis/outputs/live-loss/` remains ignored.
- Dry-run reports may be used for path gap / not_seen / simulation gap analysis, but not for final `bid_too_low`, `builder_not_covered`, or `not_included` conclusions.
- At least 70% of reports are actionable:
  - useful `primary_reason`, or
  - `unknown` with concrete `missing_evidence` and next telemetry/analyzer task.

### Phase E — Gap Triage

After 10-20 real missed opportunities, summarize loss distribution.

Acceptance:

- A tracked review snapshot exists under `docs/research/reports/live-loss/` for 2-3 representative misses.
- A short gap summary identifies top 1-2 fixes:
  - path gap: missing LP/borrow/peg/v4/template/pool.
  - inclusion gap: bid/builder/latency.
  - data gap: telemetry missing required field.
- No production strategy change is made without replay/template/fixture.

## 9. Done Definition

This work is done when:

1. Live searcher emits safe JSONL without importing `analysis`.
2. `analysis live-loss` can generate Markdown/JSON from real live events.
3. Reports clearly separate:
   - path gap
   - inclusion gap
   - simulation/data gap
   - unknown
4. At least 10 live missed opportunities have been analyzed.
5. At least 70% of reports are actionable:
   - useful `primary_reason`, or
   - `unknown` with concrete `missing_evidence` and next telemetry/analyzer task.
6. At least one high-value competitor path has:
   - representative tx
   - canonical sequence
   - replay task
   - next implementation task
7. No secrets, raw env, RPC URL, private key, or full calldata are committed.

## 10. Production Guardrails

This remains a loss-observability layer, not an analysis platform.

Still on track:

- Minimal JSONL only.
- No analysis import from hot path.
- Telemetry failure does not affect simulation/submission.
- No automatic strategy change.
- Every report points to a concrete `next_action`.
- Only 2-3 representative reports are curated into docs.
- Replay and fixture before production promotion.

Off track:

- Dashboard work.
- Long-running full-market indexing.
- Whole-block tracing by default.
- Auto-labeling every competitor in a block.
- Forcing `unknown` into a fancy strategy label.
- Directly promoting analysis results into production.
- Recording raw calldata, secrets, full env, or private builder config.

## 11. Loss-To-Fix Mapping

Use live-loss distribution to decide what to fix:

```text
path gap high        -> replay competitor tx, then add template/adapter/pool support
same path not landed -> tune bid / builder coverage / latency
not_seen high        -> expand pool universe / pending detection / opportunity trigger
simulation_failed    -> fix simulator / quote model / calldata builder
unknown high         -> add telemetry field or decoder, not a guessed label
```

## 12. Priority Order

```text
P0 safe telemetry; never affect searcher
P1 live-loss lifecycle loop
P2 same-pool / same-token competitor detection
P3 top-N trace + conservative classification
P4 10-20 live misses -> gap summary
P5 replay/template only for highest-frequency or highest-value gap
```

Do not fix LP / borrow / v4 production code before live-loss shows those gaps matter in our real missed opportunities.

## 13. First Cut Recommendation

Do this first:

```text
1. Add listener JSONL emitter.
2. Emit opportunity_seen / simulation_result / bundle_submitted with stable `opportunity_id`.
3. Update analysis live-loss to group by opportunity_id.
4. Run 5 live missed opportunities.
5. Read loss distribution before touching LP/borrow/v4 production code.
```

## 14. Competitor-Watch Mode（not_seen 覆盖缺口）

### 动机

JSONL-based live-loss 只能分析「我们已经 `opportunity_seen` 的机会」。但最重要的损失类别是**我们压根没看见**的套利——某个我们盯的 MEV bot 上链做了 arb，而我们这个 block 连 `opportunity_seen` 都没有。`competitor-watch` 模式补这个盲区：给定 watch 地址，在 JSONL 的 block range 内扫它们是否上链，凡是它们上了、我们没看见的，出 `not_seen` 报告，并带上它们走的 path。

这是把分析从「看见的机会里为什么输」翻转到「真实发生的 arb 里我们漏了多少」。

### 为什么是小改动

复用 live-loss 已有的：`analyzeCompetitor` / `actionsFromLogs` / `canonicalSequence` / `pathTemplate` / `competitorEdges` / 报告渲染。新逻辑只有三块：**range 扫描 + watch 筛选 + seen 交叉比对**。约 100-150 行，单文件，作为 live-loss 的第二入口模式（`--watch` 非空时触发）。

### CLI

```bash
npm run live-loss -- \
  --events ./events/searcher-XXXX.jsonl \
  --watch 0xE08D97...,0xc0ffeebabe... \
  --trace-top 0
# 可选：--from-block / --to-block 覆盖默认 range
```

### Pipeline

```text
读 JSONL -> 建 seen-set: { block -> { pools, tokens } }（来自 opportunity_seen）
range = JSONL min..max target_block（或 --from/--to）
for block in range:
  getBlockByNumber(block, full=true)            # 1 次/块，本地拿到所有 tx 的 from/to
  matches = txs where from∈watch OR to∈watch     # 纯本地过滤，无 per-tx RPC
  for tx in matches:
    getReceipt(tx)                              # 只对命中的几笔，不是全块
    decode logs -> pools/tokens/canonical_sequence/path_template（复用）
    if 该 block 的 seen-set 不含这些 pool/token:
       primary_reason = not_seen                # 核心：我们没看见这个池的机会
    else:
       primary_reason = seen_but_lost           # 交给现有 loss 分析
    写报告
```

### not_seen 判定粒度

**v1 池级**：该 block 我们的 seen-set 不含 competitor 解码出的 pool/token → `not_seen`。
competitor 解不出池时回退**块级**（该 block 我们有没有任何 `opportunity_seen`）。
池级能区分「整块没看见」vs「看见了别的池、漏了这个池」，对定位覆盖缺口更有用。

### 输出

`outputs/live-loss/watch-<block>-<txhash>.md/json`：

```yaml
block:
competitor_tx:
competitor_addr:           # 命中的 watch 地址
primary_reason: not_seen | seen_but_lost
canonical_sequence:        # 它走的 path
path_template:
pools:
tokens:
pool_in_our_graph:         # 关键：漏的是不是因为池没索引
competitor_edge:           # [lp_leg | borrow_leg | peg_leg | ...]
our_gap:
next_action:
```

### CU 关键设计

- 扫描只用 `getBlockByNumber(full)`（每块 1 次）+ **本地按 from/to 过滤**，命中的才 `getReceipt`。
- 与现有「整块每笔 getReceipt」的 competitor 检测**完全不同**——watch 模式天然便宜（已知地址，不扫全块）。
- range 超过上限（默认 200 块）且未给 `--from/--to` 时**报错拒跑**，防止误扫大范围。

### 边界（明确不做，保持小）

- 不做全块任意套利检测（mev-inspect 级别）。只认 `--watch` 名单。
- 不做因果 / 夹子判定（另一刀）。
- watch 命中：`from` 或 `to` 命中即可（bot EOA + executor 合约），不做 bytecode/factory 聚类。

### 验收

- `--watch` 为空 → 行为同现在，不回归。
- 给 `--watch` + events，不传 `--block` 自动用 JSONL block range。
- **核心用例**：`--watch 0xc0ffeebabe... --from-block 25422215 --to-block 25422343`，因 JSONL 无 25422231 且该地址那笔在该块上链 → 输出一份 `primary_reason: not_seen`。
- watch tx 落在**有** `opportunity_seen` 的块 → 标 `seen_but_lost`，不误报 not_seen。
- 每份 not_seen 报告含 `canonical_sequence` + `path_template` + `pool_in_our_graph`。
- CU：扫描期每块 1 次 `getBlockByNumber`；`getReceipt` 仅对 watch 命中 tx；range 超限拒跑。
- 只读、不读私钥、不 import searcher、不碰热路径。
- 汇总行新增 `not_seen` 计数，与 `victim_not_landed / not_submitted` 并列。
