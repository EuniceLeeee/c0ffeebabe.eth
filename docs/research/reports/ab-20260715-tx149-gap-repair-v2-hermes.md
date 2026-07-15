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
  rank-89 route in the current production view. The operator accepts the larger candidate set; latency is
  measured separately.
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
  and hunt-selection suites pass. Main analysis suite passes 231 tests plus Coffee calibration 64/64.
- **replay/fork result:** trusted node candidate gate consumed freshly regenerated current
  base/challenger production views, ran the unchanged `blockscan-hunt.ts` on both trees, and observed
  `not_admitted -> final_sim_success`, the exact four-edge route, and `net_profit_raw=442380` without path
  or amount injection.
- **base SHA / challenger SHA:** `840069d9d30b40d0c9585ed5a879091a666aa533` /
  `58f204571a572c3077208ddc27d763a8180a9a36`.

## Paired Live Evidence
- **window / warmup excluded:** no valid measured window. The first B attempt ran for about 249 seconds but
  never completed a `scannedPairs` pass, so zero blocks are admissible for comparison.
- **A/B logs (redacted):** B full-warm passes exhausted the 30-second startup budget; later passes exhausted
  the 11-second pass budget at `protocol_mids` with 241/347/360 external swap mids processed. The prior
  challenger-only revm artifact failure was independently fixed and codified on main before this rerun.
- **node slot state:** B is stopped; A was restored and redeployed at base
  `840069d9d30b40d0c9585ed5a879091a666aa533` with the pinned revm artifact.
- **fairness evidence:** unavailable because readiness never completed. Candidate cap remains 100 by operator
  decision; candidate enumeration latency is explicitly deferred to a separate production decision.

## External Production Calibration
- **window / tool artifact:** pinned landed block `25535056` for candidate eligibility;
  `ab-20260715-tx149-gap-repair-v2-tools.json`.
- **classifier calibration:** Coffee calibration 64/64 PASS; current indexed candidate tools executed
  successfully.
- **comparable filter:** conserving `atomic_loop`, victim-independent block-scan sample.
- **excluded:** inventory, sandwich, keeper/liquidation, JIT-LP, standing-credit, RFQ/private path.
- **B vs comparable takes:** unavailable; no valid paired live window.
- **next production blocker filed:** candidate readiness/latency before `scannedPairs` at the larger generic
  universe; the operator owns the later latency decision and this branch does not reduce coverage.

## Agent Manual Analysis
- **author:** codex-orchestrator
- **verdict:** deterministic capability fixed; production promotion needs escalation.
- **causal evidence:** deterministic evidence isolates a real capability transition and the candidate is
  generic rather than sample-conditioned; paired production distribution evidence is still pending.
- **why misleading raw metrics do/do not change the semantic verdict:** rank-89 retention is intentionally
  allowed. Latency does not erase the deterministic capability fact, but safety, starvation, or semantic
  regression in the paired window can still block promotion.

## Canonical Script Reconciliation
- **command + real exit code:** trusted `ab-canary-gate --phase candidate` on the production node, exit 0.
- **artifact:** `/tmp/mev-ab-candidate-gate-rebased-2.log` on the production node; raw log remains off Git.
- **assessment:** `needs_escalation`.
- **reconciliation:** script and manual analysis agree: the deterministic gap is fixed, while promotion is
  blocked by the absence of a valid paired production window.

## Fresh Non-Author Adversarial Review
- **reviewer:** `tx149_final_adversarial` (fresh non-author)
- **verdict:** deterministic PASS; live decision pending.
- **evidence:** no P0/P1 in frozen code; no tx/pool/rank production conditional; cap 100 retains rank 89;
  route is conserving; paired distribution validation remains mandatory before merge.

## Final Decision
- **verdict:** needs_escalation
- **branch action:** retained
- **merge/deploy/cleanup evidence:** not merged or deployed; B stopped and A healthy on current main.
- **stronger-model handoff:** not required; candidate latency/readiness is an explicit operator-owned decision.

```ab_experiment
{
  "schema_version": 3,
  "experiment_id": "20260715-tx149-gap-repair-v2",
  "problem_id": "tx149-goldx-curve-underlying-route-gap",
  "branch": "ab/tx149-gap-repair-v2",
  "base_commit": "840069d9d30b40d0c9585ed5a879091a666aa533",
  "challenger_commit": "58f204571a572c3077208ddc27d763a8180a9a36",
  "change_class": "capability",
  "hypothesis": "generic unknown-factory capability admission, GOLDx conversion, Curve-underlying support and a 100-candidate block-scan cap make the unchanged scanner self-enumerate and final-sim the positive-EV tx149 route",
  "input_mode": "challenger",
  "lane_mode": "dual",
  "infrastructure_shakedown": false,
  "expected_runtime_view_delta": true,
  "allowed_config_delta": [],
  "a": {
    "commit": "840069d9d30b40d0c9585ed5a879091a666aa533",
    "config_hash": "pending",
    "universe_hash": "pending",
    "discovery_to_block": 0,
    "blockscan_view_hash": "pending",
    "blockscan_graph_hash": "pending"
  },
  "b": {
    "commit": "58f204571a572c3077208ddc27d763a8180a9a36",
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
      "expected_net_profit_usd": 0.22099604616880186,
      "evidence": "canonical tx-profit and trace show a conserving atomic loop; trusted fork replay returns positive net_profit_raw=442380",
      "expected_route": [
        {
          "adapterId": "univ3-swap",
          "slotKind": "swap",
          "target": "0x7cb85f75e61226060453a997a7733f76707df337",
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
          "tokenIn": "0x355c665e101b9da58704a8fddb5feef210ef20c0",
          "tokenOut": "0xeb269732ab75a6fd61ea60b06fe994cd32a83549"
        },
        {
          "adapterId": "curve-exchange-underlying",
          "slotKind": "swap",
          "target": "0xfe0a8e9d60131404ffaee95b48ebf908f4d8d808",
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
    "agent_manual_verdict": "needs_escalation",
    "agent_manual_evidence": "deterministic capability flip is proven; B did not complete readiness, so no paired safety or distribution window exists",
    "agent_manual_written_at": "2026-07-15T19:20:44.000Z",
    "script_exit_code": 0,
    "script_assessment": "needs_escalation",
    "script_artifact": "/tmp/mev-ab-candidate-gate-rebased-2.log",
    "reconciliation": "script and manual analysis agree: deterministic fixed, production promotion blocked by readiness latency",
    "tool_selection": {
      "capability_query": ["single-transaction", "causality", "pnl", "competitor-window", "classification", "block-scan"],
      "selected_tools": ["analysis:bundle-postmortem", "repo:scripts/census-gap.sh"],
      "catalog_check_exit_code": 0,
      "evidence_manifest": "ab-20260715-tx149-gap-repair-v2-tools.json",
      "evidence_manifest_sha256": "f915fe1a0f74124eb296efb13b3fdf46906a7b4a1ce31eb878420a94074d1207"
    },
    "adversarial_review": {
      "verdict": "needs_escalation",
      "evidence": "deterministic review passed; no valid paired live window exists because B never completed a scan",
      "reviewer": "tx149_final_adversarial"
    }
  },
  "final_verdict": "needs_escalation",
  "branch_action": "retained",
  "b_stopped": true,
  "evidence_bundle": "pinned current-view replay, indexed tool receipts, on-chain tx149 evidence, and invalid-readiness attempt; no paired live window"
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
| tx149 route self-enumerates at rank 89 in the current production view when the generic candidate cap is 100 | this experiment | paired production window | done |
| call-defined GOLDx evidence was dropped by the production gate | main `58be1f3` / `3d42774` | LearningCase | done |
| challenger lacked the champion revm-sim artifact | main `8984c39` / `840069d` | LearningCase | done |
| candidate readiness stalls before `scannedPairs` at the larger production view | operator latency decision | future production adjudication | deferred |

## Method Trace
```text
task_class: implementation
tools_used: bundle-postmortem, census-gap, trusted blockscan-hunt, Anvil fork, ab-canary gate, Coffee calibration
evidence_order: on-chain tx facts; canonical tool reconciliation; exact scanner replay; fresh non-author code review; paired A/B pending
analysis_frame: prove a conserving positive-EV route first, then locate the production stage loss, then require the unchanged scanner to self-enumerate before live distribution validation
sanity_checks: no sample conditional; exact ordered route and token continuity; successful trace-defined protocol leg; 100-candidate generic cap; final fork sim positive
tool_gap: tooldef-20260715-production-evidence-call-defined-protocol; tooldef-20260715-ab-revm-artifact-parity
codify_next: production evidence codified by 58be1f3dbc045f9824a256c0d08c7479541e7720; A/B revm artifact parity codified by 8984c39431d9276a715845aaa750acf14cf8d802 and closed by 840069d9d30b40d0c9585ed5a879091a666aa533
distill_for_opus: call-defined protocol conversions require target-plus-selector trace evidence in both analysis and production gates; landed route capability is not fixed until the unchanged scanner self-enumerates it
```

## Close Gates
```bash
cd analysis
npm run ab-canary-gate -- ../docs/research/reports/ab-20260715-tx149-gap-repair-v2-hermes.md --phase decision
npm run ab-canary-gate -- ../docs/research/reports/ab-20260715-tx149-gap-repair-v2-hermes.md --phase close
npm run hermes-gate -- ../docs/research/reports/ab-20260715-tx149-gap-repair-v2-hermes.md
```
