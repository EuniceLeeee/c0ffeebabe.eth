# Hermes A/B Canary `20260712-runtime-view-shakedown-4`

> Identical-searcher-code shakedown of the schema-v2 A/B runner, fairness hashes, and active-pass
> comparator. This is infrastructure validation, not a strategy claim.

## Problem + Implementation Brief
- **problem_id:** ab-runner-equivalence
- **root cause / causal hypothesis:** with one pinned discovery cutoff, identical runtime views/graphs, and
  active-pass-aware log attribution, identical searcher code produces identical semantic outputs on paired
  blocks even when a next-block `skipped=busy` line interleaves with the current solve.
- **semantic success criterion:** at least 30 uncensored paired post-warmup blocks; zero runtime
  view/graph drift, solved-ring mismatch, semantic output mismatch, or restart; no backrun/MEV-Share input.
- **change_class:** correctness
- **one-change scope:** validate the A/B infrastructure already merged at base commit `db71cad`.
- **deterministic gate + pinned sample:** analysis build; A/B unit suite 22/22 including current and legacy
  busy-interleaving fixtures; shakedown-3 raw-log replay 37 blocks with zero mismatch.
- **not doing:** no searcher strategy, venue, quote, solver, bid, graph, or production posture change.

## Implementation + Gate
- **generator / evaluator:** Codex implementation; independent Godel review approved after one P1 legacy-log fix.
- **diff scope:** report-only challenger; listener/searcher source is byte-identical to champion.
- **build:** analysis TypeScript pass; A/B test suite 22/22.
- **replay/fork result:** shakedown-3 raw logs replay to identical semantic outputs and ring sets on 37 blocks.
- **base SHA / challenger SHA:** base `db71cadfc6b3301ecb2fd5697c82e7a2b77b1251`; challenger
  `f59c2100c1065c0f12d92f26dd113f2e390b07c2`.

## Paired Live Evidence
- **window / warmup excluded:** 35 uncensored paired blocks, 25515051..25515089; five warmup blocks and
  budget-censored block 25515061 excluded.
- **A/B logs (redacted):** `ab-20260712-runtime-view-shakedown-4-compare.json`; raw logs stay node-local.
- **node slot state:** B paused then closed `needs_escalation`; A PID 540471 unchanged; restart deltas zero.
- **fairness evidence:** config, startup universe, discovery cutoff, runtime pool-view and TokenEdge graph
  hashes matched. A's mutable canonical universe file changed during the window
  `b299a7e1... -> f60472b1...` while both in-memory runtime hashes stayed stable; the current fairness gate
  correctly vetoes a decisive close until A runs from an immutable snapshot.

## External Production Calibration
- **window / tool artifact:** same-window sweep deferred because the local A/B fairness axis was invalid.
- **classifier calibration:** `ab-20260712-runtime-view-shakedown-4-classifier-calibration.json`, 14/14 pass.
- **coffeebabe + watchlist sweep:** moved to the immutable-universe rerun; do not authorize from an invalid
  local comparison.
- **comparable filter:** conserving `atomic_loop` only
- **excluded:** inventory · sandwich · keeper/liquidation · JIT-LP · standing-credit
- **B vs comparable takes:** not adjudicated in this retained run.
- **next production blocker filed:** immutable champion universe input; then full Coffee corpus calibration.

## Agent Manual Analysis (write before reading script assessment)
- **author:** Codex orchestrator
- **verdict:** inconclusive
- **causal evidence:** A/B solved identical ring sets with identical semantic summaries on all 35 valid
  pairs, but the champion universe source file changed underneath the measurement.
- **why misleading raw metrics do/do not change the semantic verdict:** the output equality is encouraging,
  but a fairness hard veto cannot be promoted to a win; rerun from an immutable snapshot.

## Canonical Script Reconciliation
- **command + real exit code:** `ab-canary-compare --expect-equal --require-output-match`, exit 0
- **artifact:** `ab-20260712-runtime-view-shakedown-4-compare.json`
- **assessment:** supports
- **reconciliation:** inconclusive

## Fresh Non-Author Adversarial Review
- **reviewer:** Godel
- **verdict:** inconclusive
- **evidence:** confirmed the mutable canonical file was outside the in-memory graph but violated the
  recorded fairness input; approved the content-addressed `0444` snapshot fix and required a fresh rerun.

## Final Decision
- **verdict:** needs_escalation
- **branch action:** resolved_deleted
- **merge/deploy/cleanup evidence:** immutable content-addressed universe deployment merged to main at
  `598403b`; A restarted from the read-only snapshot and shakedown-5 held identical A/B universe hashes
  `f60472b1...` before/after the measured window. Report/artifacts archived on main before cleanup.
- **stronger-model handoff (if retained):** none; the mutable-universe fairness gap is resolved.

```ab_experiment
{
  "schema_version": 2,
  "experiment_id": "20260712-runtime-view-shakedown-4",
  "problem_id": "ab-runner-equivalence",
  "branch": "ab/runtime-view-shakedown-4",
  "base_commit": "db71cadfc6b3301ecb2fd5697c82e7a2b77b1251",
  "challenger_commit": "f59c2100c1065c0f12d92f26dd113f2e390b07c2",
  "change_class": "correctness",
  "hypothesis": "identical searcher code and runtime inputs produce identical semantic outputs under active-pass-aware attribution",
  "input_mode": "shared",
  "expected_runtime_view_delta": false,
  "allowed_config_delta": [],
  "a": {
    "commit": "db71cadfc6b3301ecb2fd5697c82e7a2b77b1251",
    "config_hash": "64bac1f866e9f86a344d8e305a0bac16408121625d3be7c6ce487c762eec0905",
    "universe_hash": "b299a7e11f61a3c8877f78d975bda8b19ae7d43ce0666538f809e606bb0a053e",
    "discovery_to_block": 25515021,
    "blockscan_view_hash": "99c7555e50cd618cc0ec1c2acd48803ff7625eb325d52c41ce15124db2175e01",
    "blockscan_graph_hash": "0535b3235c073aae7e91cc73207206e9eb07f91e566fb26a64fd2897b561a8e0"
  },
  "b": {
    "commit": "f59c2100c1065c0f12d92f26dd113f2e390b07c2",
    "config_hash": "64bac1f866e9f86a344d8e305a0bac16408121625d3be7c6ce487c762eec0905",
    "universe_hash": "b299a7e11f61a3c8877f78d975bda8b19ae7d43ce0666538f809e606bb0a053e",
    "discovery_to_block": 25515021,
    "blockscan_view_hash": "99c7555e50cd618cc0ec1c2acd48803ff7625eb325d52c41ce15124db2175e01",
    "blockscan_graph_hash": "0535b3235c073aae7e91cc73207206e9eb07f91e566fb26a64fd2897b561a8e0"
  },
  "window": { "min_paired_blocks": 30, "warmup_blocks": 5 },
  "fairness": {
    "same_block_window": true,
    "paired_blocks": 35,
    "champion_restart_delta": 0,
    "champion_pid_changed": false,
    "challenger_restarts": 0,
    "a_universe_hash_after": "f60472b1e3e76ac14016f43b634b3d9f70433c49729be7af1070be952b3cad40",
    "b_universe_hash_after": "b299a7e11f61a3c8877f78d975bda8b19ae7d43ce0666538f809e606bb0a053e",
    "a_blockscan_view_hash_after": "99c7555e50cd618cc0ec1c2acd48803ff7625eb325d52c41ce15124db2175e01",
    "b_blockscan_view_hash_after": "99c7555e50cd618cc0ec1c2acd48803ff7625eb325d52c41ce15124db2175e01",
    "a_blockscan_graph_hash_after": "0535b3235c073aae7e91cc73207206e9eb07f91e566fb26a64fd2897b561a8e0",
    "b_blockscan_graph_hash_after": "0535b3235c073aae7e91cc73207206e9eb07f91e566fb26a64fd2897b561a8e0"
  },
  "deterministic_gate": {
    "result": "pass",
    "evidence": "analysis build; A/B 22/22; shakedown-3 raw-log replay 37 blocks with zero semantic/ring mismatch"
  },
  "analysis": {
    "agent_manual_author": "codex-orchestrator",
    "agent_manual_verdict": "inconclusive",
    "agent_manual_evidence": "semantic outputs matched, but A's mutable universe file changed during the measured window",
    "script_exit_code": 0,
    "script_assessment": "supports",
    "script_artifact": "ab-20260712-runtime-view-shakedown-4-compare.json",
    "reconciliation": "inconclusive",
    "adversarial_review": {
      "verdict": "inconclusive",
      "evidence": "confirmed the fairness input drift and approved immutable content-addressed snapshots; this window remains inconclusive",
      "reviewer": "Godel"
    }
  },
  "final_verdict": "needs_escalation",
  "branch_action": "resolved_deleted",
  "b_stopped": true,
  "evidence_bundle": "ab-20260712-runtime-view-shakedown-4-compare.json; classifier calibration; wrapper closed-state evidence",
  "resolution": {
    "resolved_by_commit": "598403bffbe029ad3fb5fba775af60397c42ef42",
    "evidence": "deploy-node pins a read-only content-addressed universe; guarded node deployment and shakedown-5 measured A/B both at universe hash f60472b1e3e76ac14016f43b634b3d9f70433c49729be7af1070be952b3cad40 with no during-window drift"
  }
}
```

```step1
run_id: 20260712-runtime-view-shakedown-4
window_blocks: 25515051..25515089
watchlist: 0xc0ffeebabe5d496b2dde509f9fa189c25cf29671,0xae2fc483527b8ef99eb5d9b44875f005ba1fae13
artifact: docs/research/reports/step1-20260712-runtime-view-shakedown-4.json
method: manual-onchain-trace
fable_manual: no
```

## Findings Ledger
| finding | owner | carry_to | status |
|---|---|---|---|
| identical-code A/B equivalence | A/B infrastructure | shakedown-5 | open |
| mutable champion universe invalidates fairness | deploy-node | shakedown-5 | open |
| complete Coffee corpus calibration | Coffee analysis | after A/B passes | open |
