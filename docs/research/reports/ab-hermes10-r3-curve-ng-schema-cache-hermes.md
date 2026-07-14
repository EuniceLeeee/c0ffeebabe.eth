# Hermes A/B Canary `hermes10-r3-curve-ng-schema-cache`

> Operator closure (2026-07-14): deleted unmerged. This experiment reduced
> Curve warm latency by 294ms but changed no candidate, quote, final-sim, or
> submit outcome and was not tied to a reproducible positive-EV sample. It is a
> performance optimization, not the production blocker required for an A/B
> challenger, so no additional live window is warranted.

> Round 3 of the unattended ten-round production run. This is a predeclared performance experiment;
> metrics are evidence, not merge authority. Raw logs/events/secrets remain node-local.

## Problem + Implementation Brief
- **problem_id:** blockscan-curve-ng-schema-reread-budget
- **root cause / causal hypothesis:** current incremental invalidation correctly refreshes every Curve
  stableswap-NG pool each block because `stored_rates()` can read an external rate provider without a pool
  event. However, invalidation also discards stable pool schema, so every block repeats `coins(0..7)` and
  kind/shape discovery before reading dynamic A, fee, balances, and rates. Persisting only the schema across
  incremental invalidation should collapse warmed NG pools from two Multicall rounds to one without making
  quote state stale.
- **semantic success criterion:** keep per-block dynamic A/fee/offpeg/balance/stored-rate reads byte-equal to
  a fresh full warm while reducing `stage.warm_curve` and increasing pre-solve budget headroom.
- **change_class:** performance
- **one-change scope:** add a separate Curve schema map containing only coins, inferred kind, and plain
  decimal-derived rate multipliers. `hasCurve()` and `this.curve` remain current-block dynamic-state
  authority; incremental invalidation preserves only schema, while `clear()`/full warm refreshes schema.
- **deterministic gate + pinned sample:** a mock two-block NG fixture changes balances and `stored_rates`
  without changing schema. Block N matches the full two-round warm; block N+1 after incremental invalidation
  must use one aggregate round and produce the exact fresh block-N+1 snapshot/quote after changing
  A/fee/offpeg/balances/stored-rates. Plain Curve controls, full-clear schema refresh, cached-kind
  contradiction, and partial dynamic-call failure must also pass; failures leave no fresh local snapshot.
- **not doing:** no event-only NG cache; no stored-rate TTL; no pass-budget/config change; no candidate,
  planner, solver, quote-math, graph, protocol, or submission behavior change.

## Implementation + Gate
- **generator / evaluator:** generator `019f584d-f85b-7e82-9181-2e0a14e0b012`; plan reviewer
  `019f584a-0f22-7211-8c3e-1ceb60f2e424`
  blocked stale-state/schema conflation and required separate authority plus fail-closed fixtures; final fresh
  non-author evaluator `019f5865-1538-7da3-b837-9e33c2693ef5` passed the corrected diff after an
  intermediate review caught stale public authority and the orchestrator caught plain-pool over-refresh.
- **diff scope:** `main.ts` uses a planning-only carried Curve kind; `pool-state-cache.ts` separates schema
  from dynamic state; `curve-warm-batch.ts` adds deterministic two-block/failure controls.
- **build:** listener TypeScript PASS; poolcache 6/6; blockscan scanner 16/16; Curve math 14/14.
- **replay/fork result:** deterministic mock schema-cache gate PASS; live pinned Curve batch equivalence PASS
  for 3pool, sUSDS/USDT NG, and DOLA/sUSDS NG. Known NG block N+1 used one aggregate call versus two for a
  fresh warm and matched its changed dynamic snapshot and quote exactly.
- **base SHA / challenger SHA:** `2bc78e34114417f4c3fc3f99858d79e036c71bb6` /
  `92516b088c0596111f85f6a92a9903fb0f819965`.

## Paired Live Evidence
- **window / warmup excluded:** blocks 25519558..25519857, timestamps 1783895639..1783899239,
  exactly 3600 seconds after ten warmup blocks. The paired set contains 121 fair blocks after excluding 11
  budget-censored and 74 unequal-cache catch-up blocks.
- **A/B logs (redacted):** raw logs remain node-local; the A side was reconstructed from the rotated log
  segments covering the exact block window.
- **node slot state:** B was deployed through the trusted wrapper; A PID 584929 and restart count remained
  unchanged. The host stopped processing automation wakeups before close, the 90-minute lease expired, and
  the next trusted status/reap closed B as `crashed_needs_escalation`.
- **fairness evidence:** same config, universe, discovery cutoff, blockscan view and graph hashes; same block
  stream; A/B CPU split; no champion restart. Cold-start, catch-up and budget-censored blocks are excluded.
- **performance delta:** `stage.warm_curve` p50 2423 to 2129 ms (-294 ms, -12.13%); total p50 10052 to
  9763 ms (-289 ms). Solve p50 remained 3437 ms on both sides.
- **funnel delta:** rings, solve results, candidates, scanned pairs, quote-positive blocks, warmed V2/V3,
  protocol mids and best-net values were equal. Both sides had zero positive quote, final-sim success and
  submit.
- **unresolved output delta:** all 121 pairs differ on `skippedVenues` (A 127, B 115). Fewer skips are
  consistent with avoiding Curve warm failures/deadline omissions, but the current strict output-match gate
  treats this diagnostic coverage delta as a semantic contradiction. No merge claim is made.

## External Production Calibration
- **window / tool artifact:** same block window 25519558..25519857; raw trace and sweep artifacts remain
  node-local.
- **classifier calibration:** competitor calibration 16/16 PASS.
- **coffeebabe + watchlist sweep:** five successful Coffee transactions: four `atomic_loop` and one
  `manual_required` unknown.
- **comparable filter:** conserving `atomic_loop` only.
- **excluded:** inventory, sandwich, keeper/liquidation, JIT-LP, standing-credit.
- **B vs comparable takes:** neither side submitted. Three low-value atomic loops were classified as
  token-overlap/no-submit or hooked-v4/routing cases. The highest-value comparable transaction was
  `0x5f78b29827e4858f662c30964d2bc2d0a60f2a00226851e851d2025f0336d427`, net
  approximately $1.65.
- **manual trace of the highest-value sample:** Balancer flash 2003.051656 USDC; Curve-style
  `add_liquidity` into AID/USDC; `remove_liquidity_one_coin` into AID; permissionless AID
  `redeem(uint256)` back to 2004.910626 USDC; UniV3 converts the 1.858970 USDC asset surplus to WETH.
- **next production blockers filed:** the transaction is a same-block backrun while current production has
  backrun/mempool disabled. Independently, the graph/execution path lacks the Curve-liquidity plus AID redeem
  legs. The canonical external-analysis path decoded only the final UniV3 swap and therefore emitted
  `scan_token_overlap_no_submit`, so it hid both the admission and protocol-path gaps.

## Agent Manual Analysis
- **author:** codex-orchestrator.
- **verdict:** inconclusive.
- **causal evidence:** the deterministic cache gate proves fresh dynamic Curve authority and the paired
  performance sample shows a clean 294 ms `warm_curve` reduction with no solver/funnel change. However, the
  12-venue skip delta is present on every fair block and has not received a fresh semantic adjudication.
- **why misleading raw metrics do not decide:** lower latency is not merge authority when a declared
  no-output-change performance experiment changes a coverage diagnostic on every block. The recovery also
  ran the canonical comparator before this formal manual verdict, violating the required ordering.

## Canonical Script Reconciliation
- **command + real exit code:** `ab-canary-compare` performance-only comparison completed, but strict
  `--require-output-match` rejected the 121-pair sample because `skippedVenues` differed.
- **artifact:** node-local recovery artifact; no raw log or secret committed.
- **assessment:** inconclusive; the strict run rejected the sample because its declared no-output-delta
  invariant failed, while the performance-only run supported the latency hypothesis.
- **reconciliation:** manual inconclusive versus script contradiction. The required fresh adjudicator was
  not run before the user stopped the sequence after round 3, so the branch is retained.

## Fresh Non-Author Adversarial Review
- **reviewer:** `019f5865-1538-7da3-b837-9e33c2693ef5`.
- **verdict:** win for deterministic deployment eligibility; live performance verdict remains pending.
- **evidence:** schema/dynamic authority separated; no-log plain carry remains restampable; NG stays
  block-fresh; full clear refreshes schema; aggregate/field failures leave no local snapshot; changed pools
  are excluded from restamp; focused build and gates pass.

## Final Decision
- **verdict:** needs_escalation
- **branch action:** retained
- **merge/deploy/cleanup evidence:** B was deployed from the frozen challenger, completed the exact
  60-minute measured window, and was later stopped by trusted stale-lease reap. No challenger code was
  merged. The literal branch remains at the frozen code SHA plus report-only commits.
- **stronger-model handoff:** rerun the same A/B with an awake-host continuation guarantee, decide whether
  `skippedVenues` is a semantic output invariant or an expected diagnostic consequence of the performance
  change, and obtain a fresh non-author decision review before merge. Separately fix the Coffee call-trace
  leg extractor before using its gap verdict as production authority.

```ab_experiment
{
  "schema_version": 2,
  "experiment_id": "hermes10-r3-curve-ng-schema-cache",
  "problem_id": "blockscan-curve-ng-schema-reread-budget",
  "branch": "ab/round3-curve-ng-schema-cache",
  "base_commit": "2bc78e34114417f4c3fc3f99858d79e036c71bb6",
  "challenger_commit": "92516b088c0596111f85f6a92a9903fb0f819965",
  "change_class": "performance",
  "hypothesis": "persisting only Curve pool schema across incremental invalidation preserves fresh NG quote state while removing one Multicall round from each block warm",
  "input_mode": "shared",
  "expected_runtime_view_delta": false,
  "allowed_config_delta": [],
  "a": {
    "commit": "2bc78e34114417f4c3fc3f99858d79e036c71bb6",
    "config_hash": "04ee47a758b9835045b0748596cb102cc9e901b9f83aed5e7a3c5ea2e794a9de",
    "universe_hash": "5d445c88d8cf1ccd5e562a72c8f0a2f5e610311f86a4360a0098c497234d2d05",
    "discovery_to_block": 25519235,
    "blockscan_view_hash": "2053defda123aee82ec50416024fa2186e6e8da6b7cee9ef2820cc5c834e8019",
    "blockscan_graph_hash": "3edb01e25fb80b329f425dcf10b0a27e49ec051f1f71f0bbb5c3ca564e72b15d"
  },
  "b": {
    "commit": "92516b088c0596111f85f6a92a9903fb0f819965",
    "config_hash": "04ee47a758b9835045b0748596cb102cc9e901b9f83aed5e7a3c5ea2e794a9de",
    "universe_hash": "5d445c88d8cf1ccd5e562a72c8f0a2f5e610311f86a4360a0098c497234d2d05",
    "discovery_to_block": 25519235,
    "blockscan_view_hash": "2053defda123aee82ec50416024fa2186e6e8da6b7cee9ef2820cc5c834e8019",
    "blockscan_graph_hash": "3edb01e25fb80b329f425dcf10b0a27e49ec051f1f71f0bbb5c3ca564e72b15d"
  },
  "window": {
    "min_paired_blocks": 120,
    "warmup_blocks": 10,
    "start_block": 25519558,
    "end_block": 25519857,
    "start_epoch": 1783895639,
    "end_epoch": 1783899239,
    "measured_seconds": 3600
  },
  "fairness": {
    "same_block_window": true,
    "paired_blocks": 121,
    "champion_restart_delta": 0,
    "champion_pid_changed": false,
    "challenger_restarts": 0,
    "a_universe_hash_after": "5d445c88d8cf1ccd5e562a72c8f0a2f5e610311f86a4360a0098c497234d2d05",
    "b_universe_hash_after": "5d445c88d8cf1ccd5e562a72c8f0a2f5e610311f86a4360a0098c497234d2d05",
    "a_blockscan_view_hash_after": "2053defda123aee82ec50416024fa2186e6e8da6b7cee9ef2820cc5c834e8019",
    "b_blockscan_view_hash_after": "2053defda123aee82ec50416024fa2186e6e8da6b7cee9ef2820cc5c834e8019",
    "a_blockscan_graph_hash_after": "3edb01e25fb80b329f425dcf10b0a27e49ec051f1f71f0bbb5c3ca564e72b15d",
    "b_blockscan_graph_hash_after": "3edb01e25fb80b329f425dcf10b0a27e49ec051f1f71f0bbb5c3ca564e72b15d"
  },
  "deterministic_gate": {
    "result": "pass",
    "evidence": "two-block mock: known NG two aggregate rounds to one while changed A/fee/offpeg/balances/stored_rates and quote equal fresh; plain carry/full-clear/kind contradiction/partial failure controls pass; live representative pools 3/3"
  },
  "analysis": {
    "agent_manual_author": "codex-orchestrator",
    "agent_manual_verdict": "inconclusive",
    "agent_manual_evidence": "deterministic freshness gate passes and fair live p50 improves by 294ms in warm_curve, but skippedVenues changes 127 to 115 on all 121 pairs and requires semantic adjudication",
    "script_exit_code": 2,
    "script_assessment": "inconclusive",
    "script_artifact": "node-local round-3 recovery comparison",
    "reconciliation": "inconclusive",
    "adversarial_review": {
      "verdict": "inconclusive",
      "evidence": "fresh decision adjudication was not completed before the user stopped after round 3",
      "reviewer": "not_run"
    }
  },
  "final_verdict": "needs_escalation",
  "branch_action": "retained",
  "b_stopped": true,
  "evidence_bundle": "deterministic schema/dynamic freshness gates; exact 60-minute paired window; redacted performance summary; Coffee calibration; raw logs remain node-local"
}
```

```step1
run_id: hermes10-r3-curve-ng-schema-cache
window_blocks: 25519558..25519857
watchlist: 0xc0ffeebabe5d496b2dde509f9fa189c25cf29671
artifact: docs/research/reports/step1-hermes10-r3-curve-ng-schema-cache.json
method: manual-onchain-trace
fable_manual: yes
```

## Findings Ledger
| finding | owner | carry_to | status |
|---|---|---|---|
| Curve NG dynamic state remains block-fresh while stable schema survives invalidation | round 3 | deterministic gate | done |
| `warm_curve` p50 improved 2423 to 2129 ms, but `skippedVenues` changed on all 121 pairs | stronger model | retained branch | open |
| Coffee AID/USDC loop is under-decoded as final-UniV3 token overlap | future tooling round | call-trace leg extractor | open |
| host slept through the lease close and trusted reap retained B | Hermes process | continuation/lease enforcement | open |

## Method Trace
```text
task_class: implementation
tools_used: raw rotated A/B block-scan logs, ab-canary-compare, competitor-calibration, local reth call trace, bundle-postmortem, census-gap, Curve replay and cache fixtures
evidence_order: manual current-main stage analysis; deterministic schema/dynamic replay; fresh code review; trusted B deploy; recovered exact paired window; Coffee manual trace; canonical reconciliation
analysis_frame: separate quote-state freshness, hot-path performance and semantic funnel equality; require position-conserving competitor legs before gap attribution
sanity_checks: exact 3600-second block window; 121 fair pairs after warmup/catch-up/budget exclusion; same config/universe/view/graph; no champion restart; dynamic Curve controls fail closed
tool_gap: tooldef-20260713-round3-coffee-leg-extractor - Coffee call-trace/leg extraction missed Curve add/remove-liquidity and AID redeem, causing scan_token_overlap_no_submit to hide the admission and protocol-path gaps
codify_next: tooling_defect tooldef-20260713-round3-coffee-leg-extractor was human_killed when the user stopped the unattended sequence after round 3; the exact defect remains recorded for a later authorized tooling round
distill_for_opus: performance wins require semantic output adjudication, and unattended leased experiments require a host-awake continuation guarantee rather than relying on the next interactive wake
```

## Close Gates
```bash
cd analysis
npm run ab-canary-gate -- ../docs/research/reports/ab-hermes10-r3-curve-ng-schema-cache-hermes.md --phase decision
npm run ab-canary-gate -- ../docs/research/reports/ab-hermes10-r3-curve-ng-schema-cache-hermes.md --phase close
npm run hermes-gate -- ../docs/research/reports/ab-hermes10-r3-curve-ng-schema-cache-hermes.md
```
