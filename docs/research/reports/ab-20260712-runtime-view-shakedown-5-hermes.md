# Hermes A/B Canary `20260712-runtime-view-shakedown-5`

> Final identical-searcher-code shakedown after active-pass attribution and immutable champion universe
> inputs landed. Infrastructure validation only; no strategy claim.

## Problem + Implementation Brief
- **problem_id:** ab-runner-equivalence-final
- **root cause / causal hypothesis:** identical code, one pinned discovery cutoff, content-addressed immutable
  universes, exact runtime view/graph hashes, and active-pass-aware attribution produce equivalent paired
  outputs without cron drift or busy-line misattribution.
- **semantic success criterion:** at least 30 uncensored paired post-warmup blocks; zero runtime input/hash,
  solved-ring, semantic output, or restart drift; no backrun/MEV-Share input.
- **change_class:** correctness
- **one-change scope:** validate merged A/B runner infrastructure at exact base `598403b`.
- **deterministic gate + pinned sample:** analysis build; A/B 22/22; shakedown-3 logs 37/37 equivalent;
  real deploy confirms `SEARCHER_POOL_UNIVERSE_PATH` points to a verified content-addressed snapshot.
- **not doing:** no searcher strategy, venue, quote, solver, bid, graph-admission, or posture change.

## Implementation + Gate
- **generator / evaluator:** Codex implementation; Godel non-author review approved parser and snapshot fixes.
- **diff scope:** report-only challenger; listener/searcher source byte-identical to champion.
- **build:** parser/snapshot gates pass; node deploy verified immutable universe hash.
- **replay/fork result:** infrastructure fixtures and prior real-log replay pass.
- **base SHA / challenger SHA:** base `598403bffbe029ad3fb5fba775af60397c42ef42`; challenger
  `a1b9e5c523fde053f91b0c6580d6323af703baa8`.

## Paired Live Evidence
- **window / warmup excluded:** 32 fair paired blocks, 25515179..25515212; five warmup blocks, catch-up
  blocks 25515171/25515176/25515188, and full-warm block 25515168 excluded before pairing.
- **A/B logs (redacted):** original and corrected canonical artifacts:
  `ab-20260712-runtime-view-shakedown-5-compare-{original,fixed}.json`; raw logs remain node-local.
- **node slot state:** B paused before analysis, then the expired paused lease was reaped closed; it was not a
  live process crash. A PID 542417 was unchanged throughout the measured window; restart deltas zero.
- **fairness evidence:** config/universe/discovery cutoff/runtime pool-view/TokenEdge graph hashes equal at
  startup and pause; A's universe is immutable `/opt/MEV-runtime/universe/active-pools-f60472b1....json`.

## External Production Calibration
- **window / tool artifact:** `step1-20260712-runtime-view-shakedown-5.json`
- **classifier calibration:** `ab-20260712-runtime-view-shakedown-5-classifier-calibration.json`, 14/14 pass.
- **coffeebabe + watchlist sweep:** 0 coffeebabe and 6 `0xae2f...` matched transactions.
- **comparable filter:** conserving `atomic_loop` only
- **excluded:** inventory · sandwich · keeper/liquidation · JIT-LP · standing-credit
- **B vs comparable takes:** zero same-window comparable samples; three sandwich + three one-leg inventory
  transactions excluded before gap attribution.
- **next production blocker filed:** `none:no_comparable_sample`; use the separate full Coffee historical
  corpus after this infrastructure gate, never relabel these six non-comparable takes.

## Agent Manual Analysis (write before reading script assessment)
- **author:** Codex orchestrator
- **verdict:** win
- **causal evidence:** before reading the canonical script, raw-log samples at blocks 25515190 and 25515205
  independently showed identical `scannedPairs=808`, candidates=8, quotePositive=0, skippedVenues=490,
  and the exact same ordered eight ring/result identities. The early B-only block 25515175 is unpaired
  startup evidence and is not used.
- **why misleading raw metrics do/do not change the semantic verdict:** small timing deltas are CPU noise;
  the semantic criterion is identical inputs and outputs, not which identical binary is a few ms faster.

## Canonical Script Reconciliation
- **command + real exit code:** `ab-canary-compare --expect-equal --require-output-match`, exit 0 both before
  and after the adjudicator fix.
- **artifact:** original found one mismatch at 25515188; fixed artifact reports 32 fair pairs, zero semantic
  or solved-ring mismatches.
- **assessment:** supports
- **reconciliation:** agree after the tool defect was fixed; the original `contradicts` was preserved as an
  artifact rather than overwritten.

## Fresh Non-Author Adversarial Review
- **reviewer:** Pauli (fresh non-author explorer)
- **verdict:** win
- **evidence:** approved excluding catch-up/full-warm/budget blocks because B's busy skip left a different
  cache history; required catch-up blocks to remain reported and `skippedVenues` to remain a hard semantic
  field on clean pairs. Both requirements are enforced by `b29571c`.

## Final Decision
- **verdict:** needs_escalation
- **branch action:** resolved_deleted
- **merge/deploy/cleanup evidence:** the tested base moved while the adjudicator defect was being repaired,
  so the old report-only challenger could not be merged as a `win`. The comparator fix landed on main at
  `b29571c`; corrected replay plus non-author review validate equivalence. Report/artifacts are copied to
  main before gate-authorized deletion.
- **stronger-model handoff (if retained):** none; A/B runner equivalence is validated. Continue with full
  Coffee corpus calibration and real blocker experiments.

```ab_experiment
{
  "schema_version": 2,
  "experiment_id": "20260712-runtime-view-shakedown-5",
  "problem_id": "ab-runner-equivalence-final",
  "branch": "ab/runtime-view-shakedown-5",
  "base_commit": "598403bffbe029ad3fb5fba775af60397c42ef42",
  "challenger_commit": "a1b9e5c523fde053f91b0c6580d6323af703baa8",
  "change_class": "correctness",
  "hypothesis": "identical code and immutable runtime inputs produce identical semantic paired outputs",
  "input_mode": "shared",
  "expected_runtime_view_delta": false,
  "allowed_config_delta": [],
  "a": {
    "commit": "598403bffbe029ad3fb5fba775af60397c42ef42",
    "config_hash": "315d12c67ce4c8003fe23d34ecfa062f6351971550b50b3f5dd016badabaf7a6",
    "universe_hash": "f60472b1e3e76ac14016f43b634b3d9f70433c49729be7af1070be952b3cad40",
    "discovery_to_block": 25515144,
    "blockscan_view_hash": "e86eec487bb0f9b5753778bfd16dcb4f46a7c3799904acdaca90797601fa8c4a",
    "blockscan_graph_hash": "24e9a0a7e68470da7336d67618a2110a1a533f90d65d95593073d34aeb61c89e"
  },
  "b": {
    "commit": "a1b9e5c523fde053f91b0c6580d6323af703baa8",
    "config_hash": "315d12c67ce4c8003fe23d34ecfa062f6351971550b50b3f5dd016badabaf7a6",
    "universe_hash": "f60472b1e3e76ac14016f43b634b3d9f70433c49729be7af1070be952b3cad40",
    "discovery_to_block": 25515144,
    "blockscan_view_hash": "e86eec487bb0f9b5753778bfd16dcb4f46a7c3799904acdaca90797601fa8c4a",
    "blockscan_graph_hash": "24e9a0a7e68470da7336d67618a2110a1a533f90d65d95593073d34aeb61c89e"
  },
  "window": { "min_paired_blocks": 30, "warmup_blocks": 5 },
  "fairness": {
    "same_block_window": true,
    "paired_blocks": 32,
    "champion_restart_delta": 0,
    "champion_pid_changed": false,
    "challenger_restarts": 0,
    "a_universe_hash_after": "f60472b1e3e76ac14016f43b634b3d9f70433c49729be7af1070be952b3cad40",
    "b_universe_hash_after": "f60472b1e3e76ac14016f43b634b3d9f70433c49729be7af1070be952b3cad40",
    "a_blockscan_view_hash_after": "e86eec487bb0f9b5753778bfd16dcb4f46a7c3799904acdaca90797601fa8c4a",
    "b_blockscan_view_hash_after": "e86eec487bb0f9b5753778bfd16dcb4f46a7c3799904acdaca90797601fa8c4a",
    "a_blockscan_graph_hash_after": "24e9a0a7e68470da7336d67618a2110a1a533f90d65d95593073d34aeb61c89e",
    "b_blockscan_graph_hash_after": "24e9a0a7e68470da7336d67618a2110a1a533f90d65d95593073d34aeb61c89e"
  },
  "deterministic_gate": {
    "result": "pass",
    "evidence": "A/B 22/22; real deploy verified immutable universe path/hash; prior raw-log equivalence 37/37"
  },
  "analysis": {
    "agent_manual_author": "codex-orchestrator",
    "agent_manual_verdict": "win",
    "agent_manual_evidence": "raw blocks 25515190 and 25515205 have identical summaries and exact eight-ring result sets; all startup/runtime hashes are equal and stable",
    "script_exit_code": 0,
    "script_assessment": "supports",
    "script_artifact": "ab-20260712-runtime-view-shakedown-5-compare-fixed.json",
    "reconciliation": "agree",
    "adversarial_review": {
      "verdict": "win",
      "evidence": "fresh reviewer approved excluding explicitly reported catch-up/full-warm blocks and confirmed skippedVenues remains mandatory on clean pairs",
      "reviewer": "Pauli"
    }
  },
  "final_verdict": "needs_escalation",
  "branch_action": "resolved_deleted",
  "b_stopped": true,
  "evidence_bundle": "original/fixed compare JSON; classifier calibration; same-window Step-1 artifact; node closed-state evidence",
  "resolution": {
    "resolved_by_commit": "b29571c66bdb19eec979a3d6a064ac1a4bdc91f3",
    "evidence": "corrected comparator excluded three catch-up and one full-warm block, then matched semantic outputs and solved-ring sets on 32 paired blocks; fresh non-author review approved"
  }
}
```

```step1
run_id: 20260712-runtime-view-shakedown-5
window_blocks: 25515168..25515211
watchlist: 0xc0ffeebabe5d496b2dde509f9fa189c25cf29671,0xae2fc483527b8ef99eb5d9b44875f005ba1fae13
artifact: docs/research/reports/step1-20260712-runtime-view-shakedown-5.json
method: manual-onchain-trace
fable_manual: no
```

## Findings Ledger
| finding | owner | carry_to | status |
|---|---|---|---|
| identical-code A/B equivalence | A/B infrastructure | this round | done |
| complete Coffee corpus calibration | Coffee analysis | after pass | open |
