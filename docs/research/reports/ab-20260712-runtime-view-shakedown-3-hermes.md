# Hermes A/B Canary `20260712-runtime-view-shakedown-3`

> Identical-searcher-code shakedown of the schema-v2 A/B fairness contract. This is an infrastructure
> validation, not a strategy claim.

## Problem + Implementation Brief
- **problem_id:** ab-runtime-view-fairness
- **root cause / causal hypothesis:** pinning one startup discovery block and hashing both the complete
  block-scan pool view and final TokenEdge graph makes identical-code A/B lanes search identical inputs.
- **semantic success criterion:** at least 30 uncensored paired post-warmup blocks, zero runtime view/graph
  drift, zero solved-ring/output mismatch, zero restarts, and no backrun/MEV-Share input.
- **change_class:** correctness
- **one-change scope:** validate the A/B fairness and comparison infrastructure already merged to main
- **deterministic gate + pinned sample:** local universe/hash 9/9 and A/B 19/19
- **not doing:** no searcher strategy, venue, quote, solver, bid, or production posture change

## Implementation + Gate
- **generator / evaluator:** Codex implementation; Godel performed the non-author parser review and
  required legacy `warmedV2V3=` compatibility before approval.
- **diff scope:** report-only challenger; searcher source is byte-identical to champion
- **build:** listener/analysis TypeScript pass
- **replay/fork result:** local pinned discovery, v4 singleton identity, graph hash, ring drift, budget
  censoring, and schema-v2 gate fixtures pass
- **base SHA / challenger SHA:** base `fdad96791accebb1abf233a80d0d4e264bd18aa8`; challenger
  `037654cb2d1b5691c176d9afdf63a55f37ae0e80`

## Paired Live Evidence
- **window / warmup excluded:** 37 uncensored paired blocks, 25514873..25514912; five warmup blocks and
  budget-censored 25514868/25514874 excluded.
- **A/B logs (redacted):** aggregate/ring evidence in
  `ab-20260712-runtime-view-shakedown-3-compare-fixed.json`; raw logs remain node-local.
- **node slot state:** B paused then closed `needs_escalation`; A PID 536150 unchanged; restart deltas zero.
- **fairness evidence:** config/universe/discovery cutoff/runtime pool-view/TokenEdge graph hashes equal and
  stable. The original two ring mismatches were parser misattribution after `block=N+1 skipped=busy`.

## External Production Calibration
- **window / tool artifact:** not used to authorize this retained historical round; shakedown-4 owns the
  calibrated external axis.
- **classifier calibration:** later canonical run passed 14/14; recorded in shakedown-4.
- **coffeebabe + watchlist sweep:** deferred to shakedown-4 after the census matched-vs-analyzed fix.
- **comparable filter:** conserving `atomic_loop` only
- **excluded:** inventory · sandwich · keeper/liquidation · JIT-LP · standing-credit
- **B vs comparable takes:** not adjudicated in this superseded round.
- **next production blocker filed:** complete Coffee corpus calibration follows shakedown-4.

## Agent Manual Analysis (write before reading script assessment)
- **author:** Codex orchestrator
- **verdict:** inconclusive
- **causal evidence:** raw node logs showed both lanes solved the same eight rings; however the original
  canonical script attributed post-busy solve lines to the next block, so this run's original evidence chain
  was not authoritative until the parser changed.
- **why misleading raw metrics do/do not change the semantic verdict:** identical raw behavior is supported,
  but this old branch cannot be promoted after its tested base moved; a fresh exact-base shakedown is required.

## Canonical Script Reconciliation
- **command + real exit code:** patched `ab-canary-compare --expect-equal --require-output-match`, exit 0
- **artifact:** `ab-20260712-runtime-view-shakedown-3-compare-fixed.json`
- **assessment:** supports
- **reconciliation:** inconclusive

## Fresh Non-Author Adversarial Review
- **reviewer:** Godel
- **verdict:** inconclusive
- **evidence:** approved active-pass attribution after a P1 legacy-log fix; old run remains inconclusive as a
  merge decision because the adjudicator changed after capture and `origin/main` no longer equals its base.

## Final Decision
- **verdict:** needs_escalation
- **branch action:** resolved_deleted
- **merge/deploy/cleanup evidence:** active-pass parser fix merged to main at `db71cad`; shakedown-3 raw logs
  replayed to 37 paired blocks with zero semantic/ring mismatch; report and artifact archived on main before
  gate-authorized branch cleanup.
- **stronger-model handoff (if retained):** none; the parser attribution gap is resolved.

```ab_experiment
{
  "schema_version": 2,
  "experiment_id": "20260712-runtime-view-shakedown-3",
  "problem_id": "ab-runtime-view-fairness",
  "branch": "ab/runtime-view-shakedown-3",
  "base_commit": "fdad96791accebb1abf233a80d0d4e264bd18aa8",
  "challenger_commit": "037654cb2d1b5691c176d9afdf63a55f37ae0e80",
  "change_class": "correctness",
  "hypothesis": "identical code with one pinned discovery cutoff produces identical runtime pool views, TokenEdge graphs, and solved-ring sets",
  "input_mode": "shared",
  "expected_runtime_view_delta": false,
  "allowed_config_delta": [],
  "a": {
    "commit": "fdad96791accebb1abf233a80d0d4e264bd18aa8",
    "config_hash": "8c3a48d49a0022cc142d4f90bc7b9546e3e9630623ec46fcfcc4d6e1ef627a02",
    "universe_hash": "babe924fbfecacdd46cb94d0c4fe9dc94178b37a8903962b1f2cc2634ea8b486",
    "discovery_to_block": 25514837,
    "blockscan_view_hash": "20b45c39a9a47e4db4a070a80e998cccef8569841442180759d827d441519a55",
    "blockscan_graph_hash": "b007c6cf49e5317edfbd37436b26e169f949d7d7ecb2c95e4a4863c0956ed87f"
  },
  "b": {
    "commit": "037654cb2d1b5691c176d9afdf63a55f37ae0e80",
    "config_hash": "8c3a48d49a0022cc142d4f90bc7b9546e3e9630623ec46fcfcc4d6e1ef627a02",
    "universe_hash": "babe924fbfecacdd46cb94d0c4fe9dc94178b37a8903962b1f2cc2634ea8b486",
    "discovery_to_block": 25514837,
    "blockscan_view_hash": "20b45c39a9a47e4db4a070a80e998cccef8569841442180759d827d441519a55",
    "blockscan_graph_hash": "b007c6cf49e5317edfbd37436b26e169f949d7d7ecb2c95e4a4863c0956ed87f"
  },
  "window": { "min_paired_blocks": 30, "warmup_blocks": 5 },
  "fairness": {
    "same_block_window": true,
    "paired_blocks": 37,
    "champion_restart_delta": 0,
    "champion_pid_changed": false,
    "challenger_restarts": 0,
    "a_universe_hash_after": "babe924fbfecacdd46cb94d0c4fe9dc94178b37a8903962b1f2cc2634ea8b486",
    "b_universe_hash_after": "babe924fbfecacdd46cb94d0c4fe9dc94178b37a8903962b1f2cc2634ea8b486",
    "a_blockscan_view_hash_after": "20b45c39a9a47e4db4a070a80e998cccef8569841442180759d827d441519a55",
    "b_blockscan_view_hash_after": "20b45c39a9a47e4db4a070a80e998cccef8569841442180759d827d441519a55",
    "a_blockscan_graph_hash_after": "b007c6cf49e5317edfbd37436b26e169f949d7d7ecb2c95e4a4863c0956ed87f",
    "b_blockscan_graph_hash_after": "b007c6cf49e5317edfbd37436b26e169f949d7d7ecb2c95e4a4863c0956ed87f"
  },
  "deterministic_gate": {
    "result": "pass",
    "evidence": "listener universe/hash 9/9; analysis A/B 19/19; listener and analysis TypeScript pass"
  },
  "analysis": {
    "agent_manual_author": "codex-orchestrator",
    "agent_manual_verdict": "inconclusive",
    "agent_manual_evidence": "raw logs and original comparator conflicted; the active-pass parser changed after capture and the tested base later moved",
    "script_exit_code": 0,
    "script_assessment": "supports",
    "script_artifact": "ab-20260712-runtime-view-shakedown-3-compare-fixed.json",
    "reconciliation": "inconclusive",
    "adversarial_review": {
      "verdict": "inconclusive",
      "evidence": "parser fix approved, but this old branch is not an exact-current-base merge decision; rerun on shakedown-4",
      "reviewer": "Godel"
    }
  },
  "final_verdict": "needs_escalation",
  "branch_action": "resolved_deleted",
  "b_stopped": true,
  "evidence_bundle": "ab-20260712-runtime-view-shakedown-3-compare-fixed.json and node wrapper closed-state evidence",
  "resolution": {
    "resolved_by_commit": "db71cadfc6b3301ecb2fd5697c82e7a2b77b1251",
    "evidence": "main parser fix plus shakedown-3 replay: 37 paired blocks, zero semantic output mismatches, zero solved-ring mismatches; analysis A/B suite 22/22"
  }
}
```

```step1
run_id: 20260712-runtime-view-shakedown-3
window_blocks: 25514873..25514912
watchlist: 0xc0ffeebabe5d496b2dde509f9fa189c25cf29671,0xae2fc483527b8ef99eb5d9b44875f005ba1fae13
artifact: docs/research/reports/step1-20260712-runtime-view-shakedown-3.json
method: manual-onchain-trace
fable_manual: no
```

## Findings Ledger
| finding | owner | carry_to | status |
|---|---|---|---|
| identical-code runtime view/graph equality | A/B infrastructure | shakedown-4 | done |
| census-gap canonical Hermes integration | Coffee analysis | after A/B passes | open |
