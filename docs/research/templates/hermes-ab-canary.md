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
- **production sample:** real tx/block · net +EV evidence · victim-independent block-scan proof
- **stage flip:** not_admitted → path_found → final_sim_success (other stages need a trusted main-side harness first)
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
- **classifier calibration:** capability query + successful tool receipt(s) · pass/fail · sample count
- **coffeebabe + watchlist sweep:**
- **comparable filter:** victim-independent, conserving `block-scan atomic_loop` only
- **excluded:** inventory · sandwich · keeper/liquidation · JIT-LP · standing-credit
- **B vs comparable takes:** not_seen | pool | path | adapter | quote/sim | execution | economics
- **next production blocker filed:**
- **Step-1 `ab_external_calibration`:** competitor · strategy_kind=`block-scan` ·
  comparable_filter=`atomic_loop` · tool_artifact · tool_manifest + SHA-256 ·
  `classifier_calibration{command,status,samples}` ·
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
  "schema_version": 3,
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
  "window": {
    "min_paired_blocks": 120,
    "warmup_blocks": 10,
    "measured_from_block": 0,
    "measured_to_block": 0
  },
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
  "deterministic_gate": { "result": "pass", "evidence": "<gate command/result>" },
  "resolution_replay": {
    "cwd": "listener",
    "argv": ["npm", "run", "searcher:<self-contained-pinned-fixture>"],
    "timeout_seconds": 1200,
    "expected_transition": "<exact old failure bucket -> success bucket>"
  },
  "production_evidence": {
    "searcher_behavior_change": true,
    "strategy_kind": "block-scan",
    "trigger_kind": "standing-state",
    "route_scope": "dex-dex",
    "position_conserving": true,
    "posture": {
      "victim_dependent": false,
      "keeper": false,
      "inventory": false,
      "private_path": false,
      "credit": false,
      "sandwich": false,
      "jit_lp": false
    },
    "sample": {
      "tx_hash": "<full-onchain-tx-hash>",
      "block_number": 0,
      "expected_net_profit_usd": 0,
      "evidence": "<net-profit and strategy-source evidence>"
    },
    "classification_review": {
      "verdict": "pass",
      "reviewer": "<fresh non-author reviewer>",
      "evidence": "<independent target-scope and victim-independence verification>"
    },
    "baseline_stage": "not_admitted",
    "challenger_stage": "path_found",
    "replay": {
      "result": "pass",
      "cwd": "listener",
      "argv": ["node", "--import", "tsx", "src/searcher/test/blockscan-hunt.ts"],
      "evidence": "<same sample stage transition>"
    }
  },
  "analysis": {
    "agent_manual_author": "<orchestrator>",
    "agent_manual_verdict": "inconclusive",
    "agent_manual_evidence": "<independent causal analysis written before script result>",
    "agent_manual_written_at": "<ISO-8601 timestamp when the manual verdict was persisted>",
    "agent_manual_artifact": "ab-<id>-manual.json",
    "agent_manual_artifact_sha256": "<sha256 of exact manual artifact bytes>",
    "comparator_started_at": "<later ISO-8601 timestamp captured before starting the indexed comparator>",
    "script_exit_code": 1,
    "script_assessment": "inconclusive",
    "script_artifact": "<relative redacted compare.json path>",
    "reconciliation": "inconclusive",
    "tool_selection": {
      "capability_query": ["single-transaction", "causality", "pnl", "competitor-window", "classification", "block-scan", "ab", "comparison"],
      "selected_tools": ["<successfully executed current indexed IDs; never copy a fixed tool list>"],
      "catalog_check_exit_code": 0,
      "evidence_manifest": "ab-<id>-tools.json",
      "evidence_manifest_sha256": "<sha256 of exact machine execution manifest bytes>"
    },
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

The deploy wrapper, not the challenger, runs this unchanged harness from both A and B at the sample's
untouched parent block and binds its machine result to the sample's on-chain DEX pool IDs. Test, fixture,
replay-harness, analysis, or governance changes must be merged before B and are rejected in the challenger.
The branch may contain later report/evidence-only commits, but the wrapper deploys and promotion merges only
the frozen `challenger_commit`; it reads evidence from the descendant branch tip without promoting that tip.

Create the manual seal and tool receipts with trusted generic writers rather than hand-authoring chronology:
```bash
cd analysis
npm run ab-manual-verdict -- --experiment <id> --author <agent> --verdict <win|lose|inconclusive> \
  --evidence <causal-evidence> --a-log <exact-a-log> --b-log <exact-b-log> --out ../docs/research/reports/ab-<id>-manual.json
npm run tool-index -- --select <semantic-capability-union> --out ../docs/research/reports/ab-<id>-tools.json --json
npm run tool-run -- --manifest ../docs/research/reports/ab-<id>-tools.json --tool <indexed-id> \
  [--window <from>..<to>] -- <tool-args>
```

When a later main commit resolves a retained experiment, add a main-committed claim under
`docs/research/resolutions/` with the exact retained branch tip and run
`npm run ab-resolution-sweep -- --apply`. The claim cannot replace the replay: the runner uses the
`resolution_replay` frozen in this original report. It sets
`branch_action=resolved_deleted` and adds:
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

The candidate phase is intentionally not a hand-run close command. The trusted node-side
`deploy-ab-challenger.sh deploy ...` wrapper supplies and verifies the frozen deployment identity,
local archive RPC, runtime declarations, and challenger worktree before B can start.
