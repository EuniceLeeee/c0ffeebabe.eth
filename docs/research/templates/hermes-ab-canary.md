# Hermes A/B Canary `<experiment_id>`

> Unattended bounded-live champion/challenger cycle. Metrics are evidence, not merge authority. Raw
> logs/events/secrets stay off Git; link only redacted evidence.

## Problem + Implementation Brief
- **problem_id:**
- **root cause / causal hypothesis:**
- **semantic success criterion:**
- **change_class:** performance | correctness | capability
- **one-change scope:**
- **deterministic gate + pinned sample:**
- **not doing:**

## Implementation + Gate
- **generator / evaluator:**
- **diff scope:**
- **build:**
- **replay/fork result:**
- **base SHA / challenger SHA:** challenger = frozen deployed code commit, not a later report-only tip

## Paired Live Evidence
- **window / warmup excluded:**
- **A/B logs (redacted):**
- **node slot state:**
- **fairness evidence:** same blocks · restart deltas · config/universe hashes · pinned discovery cutoff ·
  runtime pool-view + TokenEdge graph hashes before/after · budget-censored blocks · CPU split

## External Production Calibration
- **window / tool artifact:**
- **classifier calibration:** `npm run competitor-calibration` · pass/fail · sample count
- **coffeebabe + watchlist sweep:**
- **comparable filter:** conserving `atomic_loop` only
- **excluded:** inventory · sandwich · keeper/liquidation · JIT-LP · standing-credit
- **B vs comparable takes:** not_seen | pool | path | adapter | quote/sim | execution | economics
- **next production blocker filed:**
- **Step-1 `ab_external_calibration`:** competitor · strategy_kind=`block-scan` ·
  comparable_filter=`atomic_loop` · tool_artifact · `classifier_calibration{command,status,samples}` ·
  comparable_txs[] · excluded_counts{} · gap_counts{} · next_problem_id
  (`none:no_comparable_sample` is valid)

## Agent Manual Analysis (write before reading script assessment)
- **author:**
- **verdict:** win | lose | inconclusive
- **causal evidence:**
- **why misleading raw metrics do/do not change the semantic verdict:**

## Canonical Script Reconciliation
- **command + real exit code:**
- **artifact:**
- **assessment:** supports | contradicts | inconclusive
- **reconciliation:** agree | disagree | inconclusive

## Fresh Non-Author Adversarial Review
Required for every capability win and every conflict/inconclusive/artifact concern.
- **reviewer:**
- **verdict:** win | lose | inconclusive
- **evidence:**

## Final Decision
- **verdict:** win | lose | needs_escalation
- **branch action:** pending_merge | pending_delete | merged_deleted | deleted_unmerged | retained | resolved_deleted
- **merge/deploy/cleanup evidence:**
- **stronger-model handoff (if retained):**
- **later resolution (if resolved_deleted):** resolved_by_commit · replay/A/B evidence · report-on-main commit

```ab_experiment
{
  "schema_version": 2,
  "experiment_id": "<id>",
  "problem_id": "<learning-case-or-finding-id>",
  "branch": "ab/<problem>",
  "base_commit": "<40-char-sha>",
  "challenger_commit": "<40-char-sha>",
  "change_class": "capability",
  "hypothesis": "<causal hypothesis and semantic success criterion>",
  "input_mode": "shared",
  "expected_runtime_view_delta": false,
  "allowed_config_delta": [],
  "a": {
    "commit": "<40-char-sha>",
    "config_hash": "<sha256>",
    "universe_hash": "<sha256>",
    "discovery_to_block": 0,
    "blockscan_view_hash": "<64-char-keccak-without-0x>",
    "blockscan_graph_hash": "<64-char-keccak-without-0x>"
  },
  "b": {
    "commit": "<40-char-sha>",
    "config_hash": "<sha256>",
    "universe_hash": "<sha256>",
    "discovery_to_block": 0,
    "blockscan_view_hash": "<64-char-keccak-without-0x>",
    "blockscan_graph_hash": "<64-char-keccak-without-0x>"
  },
  "window": { "min_paired_blocks": 120, "warmup_blocks": 10 },
  "fairness": {
    "same_block_window": false,
    "paired_blocks": 0,
    "champion_restart_delta": 0,
    "champion_pid_changed": false,
    "challenger_restarts": 0,
    "a_universe_hash_after": "unavailable",
    "b_universe_hash_after": "unavailable",
    "a_blockscan_view_hash_after": "unavailable",
    "b_blockscan_view_hash_after": "unavailable",
    "a_blockscan_graph_hash_after": "unavailable",
    "b_blockscan_graph_hash_after": "unavailable"
  },
  "deterministic_gate": { "result": "not_applicable", "evidence": "<gate command/result>" },
  "analysis": {
    "agent_manual_author": "<orchestrator>",
    "agent_manual_verdict": "inconclusive",
    "agent_manual_evidence": "<independent causal analysis written before script result>",
    "script_exit_code": 1,
    "script_assessment": "inconclusive",
    "script_artifact": "<relative redacted compare.json path>",
    "reconciliation": "inconclusive",
    "adversarial_review": {
      "verdict": "inconclusive",
      "evidence": "<fresh non-author evidence>",
      "reviewer": "<fresh reviewer distinct from agent_manual_author>"
    }
  },
  "final_verdict": "needs_escalation",
  "branch_action": "retained",
  "b_stopped": false,
  "evidence_bundle": "<redacted evidence paths>"
}
```

When a later main commit resolves a retained experiment, set `branch_action` to `resolved_deleted` and add:
```json
"resolution": {
  "resolved_by_commit": "<40-char main ancestor>",
  "evidence": "<later replay/A/B validation already committed on main>"
}
```

```step1
run_id: <experiment_id>
window_blocks: <from>..<to>
watchlist: 0xc0ffeebabe5d496b2dde509f9fa189c25cf29671,0xae2fc483527b8ef99eb5d9b44875f005ba1fae13
artifact: docs/research/reports/step1-<experiment_id>.json
method: manual-onchain-trace
fable_manual: no
```

## Findings Ledger
| finding | owner | carry_to | status |
|---|---|---|---|
|  |  |  | open / done / killed |

## Close Gates
```bash
cd analysis
npm run ab-canary-gate -- ../docs/research/reports/ab-<id>-hermes.md --phase decision
npm run ab-canary-gate -- ../docs/research/reports/ab-<id>-hermes.md --phase close
npm run hermes-gate -- ../docs/research/reports/ab-<id>-hermes.md
```
