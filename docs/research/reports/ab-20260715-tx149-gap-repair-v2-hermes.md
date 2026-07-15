# Hermes A/B Canary `20260715-tx149-gap-repair-v2`

> Capability repair for one production gap cohort. The frozen challenger changes production searcher
> code only; this evidence descendant is not part of the promoted code SHA. Raw node logs remain off Git.

## Problem + Implementation Brief
- **problem_id:** `tx149-goldx-curve-underlying-route-gap`
- **root cause / causal hypothesis:** production excluded provisionally compatible V2 factories and
  Curve `exchange_underlying` pools before capability probing, had no GOLDx conversion edge, and capped
  block-scan candidates before the landed route. Generic capability admission plus a 100-candidate scan
  should let the unchanged scanner self-enumerate and simulate the conserving
  USDT→PAXG→GOLDx→USDx→USDT loop.
- **semantic success criterion:** the exact landed route advances from `not_admitted` on current main to
  `final_sim_success` on the challenger with positive fork net profit and no path/amount injection.
- **change_class:** capability
- **one-change scope:** generic venue/capability discovery, GOLDx conversion, Curve-underlying quote/build,
  scanner candidate refinement, and the generic block-scan candidate default `20→100` needed to retain the
  rank-87 route. The operator accepts the larger candidate set; latency is measured separately.
- **deterministic gate + pinned sample:** tx `0x149df3ec…fde60`, parent block `25535055`; trusted
  `blockscan-hunt.ts` self-enumerates the four ordered edges and fork-simulates `net_profit_raw=442380`.
- **lane mode:** dual (atomic block-scan + public-mempool backrun; MEV-Share off)
- **not doing:** no transaction/pool/rank conditional in production, no hand-injected route or amount, no
  generic replay CLI, no config delta, and no claim that raw latency improves.

## Implementation + Gate
- **generator / evaluator:** Codex implementation; fresh non-author `tx149_final_adversarial` review PASS;
  separate fresh gate review found and closed `tooldef-20260715-production-evidence-call-defined-protocol`
  on main before this candidate was rebased.
- **diff scope:** exactly one frozen production commit, 22 files under `listener/src`; no tests, fixtures,
  analysis, governance, deploy runner, or evidence changes inside the frozen SHA.
- **build:** listener build and focused universe, identity, refinement, scanner, pruning, planner, protocol,
  and hunt-selection suites pass. Main analysis suite passes 215 tests plus Coffee calibration 64/64.
- **replay/fork result:** trusted node replay on the same listener tree reached `final_sim_success`, exact
  four-edge route, and `net_profit_raw=442380`; the deploy wrapper will rerun both base and challenger.
- **base SHA / challenger SHA:** `3d42774a9f0b006a6e84911ec0538ad40c104e1b` /
  `f915295b062679b7353c9f999d94fa976ae61a65`.

## Paired Live Evidence
- **window / warmup excluded:** pending trusted-wrapper run; require at least 120 paired blocks after 10
  warmup blocks and all catch-up/budget/full-warm exclusions.
- **A/B logs (redacted):** pending.
- **node slot state:** B not started at report creation.
- **fairness evidence:** pending wrapper-owned same-block/config/universe/view/graph/restart/CPU evidence.

## External Production Calibration
- **window / tool artifact:** pinned landed block `25535056` for candidate eligibility;
  `ab-20260715-tx149-gap-repair-v2-tools.json`.
- **classifier calibration:** Coffee calibration 64/64 PASS; current indexed candidate tools executed
  successfully.
- **comparable filter:** conserving `atomic_loop`, victim-independent block-scan sample.
- **excluded:** inventory, sandwich, keeper/liquidation, JIT-LP, standing-credit, RFQ/private path.
- **B vs comparable takes:** pending paired live window.
- **next production blocker filed:** pending live evidence.

## Agent Manual Analysis
- **author:** codex-orchestrator
- **verdict:** inconclusive before live pairing.
- **causal evidence:** deterministic evidence isolates a real capability transition and the candidate is
  generic rather than sample-conditioned; paired production distribution evidence is still pending.
- **why misleading raw metrics do/do not change the semantic verdict:** rank-87 retention is intentionally
  allowed. Latency does not erase the deterministic capability fact, but safety, starvation, or semantic
  regression in the paired window can still block promotion.

## Canonical Script Reconciliation
- **command + real exit code:** pending manual seal and indexed paired comparator.
- **artifact:** pending.
- **assessment:** inconclusive.
- **reconciliation:** inconclusive.

## Fresh Non-Author Adversarial Review
- **reviewer:** `tx149_final_adversarial` (fresh non-author)
- **verdict:** deterministic PASS; live decision pending.
- **evidence:** no P0/P1 in frozen code; no tx/pool/rank production conditional; cap 100 retains rank 87;
  route is conserving; paired distribution validation remains mandatory before merge.

## Final Decision
- **verdict:** needs_escalation (pre-window placeholder)
- **branch action:** retained
- **merge/deploy/cleanup evidence:** none yet; B has not started.
- **stronger-model handoff:** not applicable while the authorized paired run is active.

```ab_experiment
{
  "schema_version": 3,
  "experiment_id": "20260715-tx149-gap-repair-v2",
  "problem_id": "tx149-goldx-curve-underlying-route-gap",
  "branch": "ab/tx149-gap-repair-v2",
  "base_commit": "3d42774a9f0b006a6e84911ec0538ad40c104e1b",
  "challenger_commit": "f915295b062679b7353c9f999d94fa976ae61a65",
  "change_class": "capability",
  "hypothesis": "generic unknown-factory capability admission, GOLDx conversion, Curve-underlying support and a 100-candidate block-scan cap make the unchanged scanner self-enumerate and final-sim the positive-EV tx149 route",
  "input_mode": "challenger",
  "lane_mode": "dual",
  "infrastructure_shakedown": false,
  "expected_runtime_view_delta": true,
  "allowed_config_delta": [],
  "a": {
    "commit": "3d42774a9f0b006a6e84911ec0538ad40c104e1b",
    "config_hash": "pending",
    "universe_hash": "pending",
    "discovery_to_block": 0,
    "blockscan_view_hash": "pending",
    "blockscan_graph_hash": "pending"
  },
  "b": {
    "commit": "f915295b062679b7353c9f999d94fa976ae61a65",
    "config_hash": "pending",
    "universe_hash": "pending",
    "discovery_to_block": 0,
    "blockscan_view_hash": "pending",
    "blockscan_graph_hash": "pending"
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
  "deterministic_gate": {
    "result": "pass",
    "evidence": "unchanged blockscan-hunt self-enumerated USDT-PAXG-GOLDx-USDx-USDT at parent 25535055 and fork-simulated net_profit_raw=442380"
  },
  "resolution_replay": {
    "cwd": "listener",
    "argv": ["npm", "run", "searcher:blockscan-hunt-tx149"],
    "timeout_seconds": 1200,
    "expected_transition": "not_admitted -> final_sim_success"
  },
  "production_evidence": {
    "searcher_behavior_change": true,
    "strategy_kind": "block-scan",
    "trigger_kind": "standing-state",
    "route_scope": "dex-permissionless-protocol",
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
      "tx_hash": "0x149df3ec17a6044e0c66c25aa55ce044abe33bf14cedea26295e1b6d4c9fde60",
      "block_number": 25535056,
      "expected_net_profit_usd": 0.21401122258732488,
      "evidence": "canonical tx-profit and trace show a conserving atomic loop; trusted fork replay returns positive net_profit_raw=442380",
      "expected_route": [
        {
          "adapterId": "univ3-swap",
          "slotKind": "swap",
          "target": "0x7cb85f75e61226060453a997a7733f76707df337",
          "poolId": "0x7cb85f75e61226060453a997a7733f76707df337",
          "tokenIn": "0xdac17f958d2ee523a2206206994597c13d831ec7",
          "tokenOut": "0x45804880de22913dafe09f4980848ece6ecbaf78"
        },
        {
          "adapterId": "goldx-mint",
          "slotKind": "protocol",
          "target": "0x355c665e101b9da58704a8fddb5feef210ef20c0",
          "tokenIn": "0x45804880de22913dafe09f4980848ece6ecbaf78",
          "tokenOut": "0x355c665e101b9da58704a8fddb5feef210ef20c0"
        },
        {
          "adapterId": "univ2-swap",
          "slotKind": "swap",
          "target": "0xef6317e783b22b2a2fc073e68260450236c20779",
          "poolId": "0xef6317e783b22b2a2fc073e68260450236c20779",
          "tokenIn": "0x355c665e101b9da58704a8fddb5feef210ef20c0",
          "tokenOut": "0xeb269732ab75a6fd61ea60b06fe994cd32a83549"
        },
        {
          "adapterId": "curve-exchange-underlying",
          "slotKind": "swap",
          "target": "0xfe0a8e9d60131404ffaee95b48ebf908f4d8d808",
          "poolId": "0xfe0a8e9d60131404ffaee95b48ebf908f4d8d808",
          "tokenIn": "0xeb269732ab75a6fd61ea60b06fe994cd32a83549",
          "tokenOut": "0xdac17f958d2ee523a2206206994597c13d831ec7"
        }
      ]
    },
    "classification_review": {
      "verdict": "pass",
      "reviewer": "tx149_final_adversarial (fresh non-author)",
      "evidence": "independently confirmed the tx is a victim-independent, position-conserving atomic loop and the frozen production diff is generic rather than sample-conditioned"
    },
    "baseline_stage": "not_admitted",
    "challenger_stage": "final_sim_success",
    "replay": {
      "result": "pass",
      "cwd": "listener",
      "argv": ["node", "--import", "tsx", "src/searcher/test/blockscan-hunt.ts"],
      "evidence": "trusted direct-node harness; wrapper regenerates base/challenger universes and reruns the exact landed route without path or amount injection"
    }
  },
  "analysis": {
    "agent_manual_author": "codex-orchestrator",
    "agent_manual_verdict": "inconclusive",
    "agent_manual_evidence": "deterministic capability flip is proven; paired safety, distribution and semantic evidence are pending",
    "agent_manual_written_at": "2026-07-15T17:00:00.000Z",
    "script_exit_code": 1,
    "script_assessment": "inconclusive",
    "script_artifact": "pending",
    "reconciliation": "inconclusive",
    "tool_selection": {
      "capability_query": ["single-transaction", "causality", "pnl", "competitor-window", "classification", "block-scan"],
      "selected_tools": ["analysis:bundle-postmortem", "repo:scripts/census-gap.sh"],
      "catalog_check_exit_code": 0,
      "evidence_manifest": "ab-20260715-tx149-gap-repair-v2-tools.json",
      "evidence_manifest_sha256": "f915fe1a0f74124eb296efb13b3fdf46906a7b4a1ce31eb878420a94074d1207"
    },
    "adversarial_review": {
      "verdict": "inconclusive",
      "evidence": "deterministic review passed; paired live decision review remains pending",
      "reviewer": "tx149_final_adversarial"
    }
  },
  "final_verdict": "needs_escalation",
  "branch_action": "retained",
  "b_stopped": false,
  "evidence_bundle": "pinned replay, indexed tool receipts, and on-chain tx149 evidence; paired live artifacts pending"
}
```

```step1
run_id: 20260715-tx149-gap-repair-v2
window_blocks: pending
watchlist: 0xc0ffeebabe5d496b2dde509f9fa189c25cf29671,0x3e00d14c2fc4bada34f57fdadb8e2fb2341eae90,0x567ccffad113f74357fc54863e5fcda75e190819,0x7adac85639050c1dea443889e3b4c4adb26ec593
watchlist_profile: live-competitors-20260714-v1
artifact: docs/research/reports/step1-20260715-tx149-gap-repair-v2.json
method: canonical-indexed-tools
fable_manual: no
```

## Findings Ledger
| finding | owner | carry_to | status |
|---|---|---|---|
| tx149 route self-enumerates at rank 87 when the generic candidate cap is 100 | this experiment | paired production window | done |
| call-defined GOLDx evidence was dropped by the production gate | main `58be1f3` / `3d42774` | LearningCase | done |
| candidate latency and distribution effect | paired A/B | final adjudication | open |

## Method Trace
```text
task_class: implementation
tools_used: bundle-postmortem, census-gap, trusted blockscan-hunt, Anvil fork, ab-canary gate, Coffee calibration
evidence_order: on-chain tx facts; canonical tool reconciliation; exact scanner replay; fresh non-author code review; paired A/B pending
analysis_frame: prove a conserving positive-EV route first, then locate the production stage loss, then require the unchanged scanner to self-enumerate before live distribution validation
sanity_checks: no sample conditional; exact ordered route and token continuity; successful trace-defined protocol leg; 100-candidate generic cap; final fork sim positive
tool_gap: tooldef-20260715-production-evidence-call-defined-protocol
codify_next: codified by 58be1f3dbc045f9824a256c0d08c7479541e7720 and closed by 3d42774a9f0b006a6e84911ec0538ad40c104e1b
distill_for_opus: call-defined protocol conversions require target-plus-selector trace evidence in both analysis and production gates; landed route capability is not fixed until the unchanged scanner self-enumerates it
```

## Close Gates
```bash
cd analysis
npm run ab-canary-gate -- ../docs/research/reports/ab-20260715-tx149-gap-repair-v2-hermes.md --phase decision
npm run ab-canary-gate -- ../docs/research/reports/ab-20260715-tx149-gap-repair-v2-hermes.md --phase close
npm run hermes-gate -- ../docs/research/reports/ab-20260715-tx149-gap-repair-v2-hermes.md
```
