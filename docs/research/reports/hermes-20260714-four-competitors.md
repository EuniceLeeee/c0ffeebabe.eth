# Hermes Live Run `hermes-20260714-four-competitors`

```yaml
run_id: hermes-20260714-four-competitors
date: 2026-07-14
window: 25528974..25529120 (147 blocks / 30 minutes)
config: bounded-live A; block-scan=1; mempool=0; backrun=0; EV_GATE=1
cu_budget: local reth only
cu_spent: 0 remote CU
codex: landed
turn_class: observability-only
inputs:
  redacted_log: node exact-window blockscan slice SHA-256 6780d42203c1f2e284c2156131a1933b9475f6c25691b9a17751d3c3baad532a
  redacted_events_summary: production JSONL byte count unchanged during the measured window
  competitor_cross_reference: four-entity live profile, manual raw sweep before indexed canonical reconciliation
  key_tx_links: []
```

```step1
run_id: hermes-20260714-four-competitors
window_blocks: 25528974..25529120
watchlist: 0xc0ffeebabe5d496b2dde509f9fa189c25cf29671, 0x3e00d14c2fc4bada34f57fdadb8e2fb2341eae90, 0x567ccffad113f74357fc54863e5fcda75e190819, 0x7adac85639050c1dea443889e3b4c4adb26ec593
watchlist_profile: live-competitors-20260714-v1
artifact: docs/research/reports/step1-hermes-20260714-four-competitors.json
method: direct local-reth block sweep first; generated capability index; tool-run census-gap receipt
fable_manual: no
```

## Run Facts

| fact | result |
|---|---:|
| fair blocks accounted | 147 / 147 |
| completed block-scan passes | 85 |
| busy skips | 50 |
| pass-budget exits | 12 |
| candidates entering solve | 680 |
| quote-positive / final-sim / submit | 0 / 0 / 0 |
| completed-pass runtime | 11031ms min / 36095ms max |
| A restarts during window | 0 |
| B state | inactive |

The measured A commit was `a5ba0ccf8c1f046af707b6dca9b57b4f5bece189`. The first five
post-deploy blocks were excluded as warmup. Every measured block had a block-scan record: 85 completed,
50 skipped busy, and 12 exited at the 11000ms pass budget before solving.

## Manual-First Analysis

The analyst read raw local-reth blocks and the exact live log slice before generating a tool manifest.
No transaction in `25528974..25529120` had a `from` or `to` matching any of the four EOAs or four
executors. The A lane repeatedly showed three symptoms:

1. 84 completed passes sent the same structurally oversized amount to the V4 quoter and failed the
   `uint128` domain check.
2. A persistent route reverted without data, while another repeatedly consumed the remaining quote
   deadline.
3. Long warm/solve passes caused 50 busy skips; 12 additional passes exhausted the budget in
   `warm_curve` or `protocol_mids`.

These are real production symptoms, but the window contains no target-scope competitor transaction and
no positive quote. Therefore none has evidence that it blocked a reproducible positive-EV sample. Under
the production-candidate gate, none is eligible as this round's B variable.

## Indexed Reconciliation

- Catalog check before selection: `PASS`, 150 tools.
- Capability query: `competitor-window,classification,block-scan,competitor-loss,causality`.
- Generated selection recommended the window aggregator and the single-transaction causal analyzer.
  The latter was correctly not run because there was no transaction sample.
- Executed through the generic runner: `repo:scripts/census-gap.sh`.
- Exact receipt window: `25528974..25529120`; exit code `0`.
- Result: `matched_txs=0`, `qualifying_txs=0`, all four EOA/executor entities present in
  `watch_profile=live-competitors-20260714-v1`.
- Machine manifest: local ignored artifact
  `logs/hermes-20260714-four-competitors/hermes-20260714-four-competitors-tools.json`, SHA-256
  `0662b45405efecca78aa5be7f650918dcab6bfc5c3017eb8b93bc9a25de79f8c`.

The canonical result agrees with the independent manual sweep. There is no semantic disagreement to
adjudicate.

## Same-Round Tooling Defect

The first node execution failed before analysis because `tool-index --check` treated the macOS AppleDouble
file `analysis/src/cli/._live-loss.ts` as an unregistered CLI. Local and node checkouts were at the same
source commit, proving a node-only metadata false positive. Fresh non-author reviewer
`019f5f5a-35bd-7413-9de8-68afc90c4e16` agreed.

- LearningCase: `tooldef-20260714-tool-index-appledouble`.
- Codify commit: `b420a293e7fe81c42d014eb297d541fc9f1c6b77`.
- Fix: reserve only the `._*` metadata namespace in CLI/script discovery; preserve ordinary orphan-CLI
  detection; remove those sidecars from the two indexed source roots after deploy backup.
- Gates: analysis build, tool-index `10/10`, local catalog `150`, deployed-node catalog `150`, and the
  same node `tool-run` window now exits `0`.
- Durable main/deploy evidence tip: `c8e6c5a`.

## Final Decision

- **decision:** close as a null round with no challenger.
- **rationale:** the four-entity comparison profile and its machinery are working, but this exact window
  has no real positive-EV competitor sample. Deploying an amount guard, cache optimization, or failure
  filter would violate the requirement that B advance the same pinned positive-EV sample by a production
  stage.
- **searcher behavior change:** no.
- **branch/B action:** no `ab/*` branch created; B remained inactive.
- **not doing:** no resurrection of the old V4 amount-domain challenger based only on cleaner metrics.

## Findings Ledger

| finding | class | owner | status |
|---|---|---|---|
| V4 oversized amount occupies one solve slot in 84/85 completed passes | unproven production symptom | next competitor-bearing round | open; requires pinned +EV causality |
| 50 busy skips and 12 budget exits | unproven latency symptom | next competitor-bearing round | open; cannot justify B alone |
| AppleDouble metadata blocks node canonical analysis | tooling defect | this round | codified and node-verified |
| Four-entity live profile yields no take in this window | external sample fact | next round | continue profile; not a gap |

## Final Approval

- **approved:** yes, as an honest no-challenger close.
- **production merge:** only the comparison-profile and tooling fixes already on `origin/main`; no searcher
  behavior experiment was merged.

## Method Trace

task_class: competitor_path
tools_used: manual local-reth from/to sweep and exact blockscan slice; generated tool-index capability query; tool-run census-gap; fresh non-author tooling-defect review
evidence_order: 1. freeze exact A window 2. independently inspect every block and A funnel 3. generate current tool catalog and select by capability 4. execute selected window tool 5. reconcile and codify the node-only failure
analysis_frame: require target-scope conserving atomic evidence before naming a production gap; distinguish stable symptoms from sample-proven blockers; keep analysis fixes outside the B variable
sanity_checks: exact window shared by manual and tool receipt; all 147 blocks accounted; four EOAs plus executors swept; A commit and restart count verified; no empty single-tx tool run
tool_gap: tooldef-20260714-tool-index-appledouble caused node-only catalog failure on AppleDouble metadata
codify_next: tooldef-20260714-tool-index-appledouble codified by b420a293e7fe81c42d014eb297d541fc9f1c6b77 and verified on node
distill_for_opus: A stable failure metric is not a production challenger until the same real positive-EV sample is shown to stall there and replay advances after the change.
