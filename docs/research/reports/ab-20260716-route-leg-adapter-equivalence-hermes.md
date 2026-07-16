# Hermes A/B Canary `20260716-route-leg-adapter-equivalence`

> Production-equivalence and performance comparison of the route-leg adapter refactor. The intervention
> changes architecture, not venue coverage or strategy behavior. All candidate safety/evidence gates remain
> enabled; only the same-sample stage-advance assertion is explicitly disabled for this equivalence run.

## Problem + Implementation Brief

- **problem_id:** route-leg-adapter-architecture-equivalence
- **causal hypothesis:** routing venue identity, quote, warm, planning and encoding through explicit
  registries preserves semantic output while retaining at least 95% of the baseline paired performance.
- **semantic success criterion:** the trusted RockSolid/Balancer V3 closed-loop replay reaches
  `final_sim_success` on both commits; live paired semantic outputs match; candidate p50 performance is at
  least 95% of baseline, with tail differences explained from paired evidence.
- **change_class:** performance
- **one-change scope:** production searcher architecture only; no test, fixture, dependency, deployment,
  FlashAdapterRegistry, config, universe or harness change in the frozen candidate diff.
- **base listener provenance:** base `69e12b3` has no `listener/src` diff from requested baseline `4392ffc`.
- **frozen candidate:** `2a06229ca5f73280b1707eeb9c43d3aad1b4acf4`.

## Deterministic Evidence

- Existing trusted fixture: `listener/src/searcher/test/fixtures/loops/rocksolid-balancer-v3-7ce631.json`.
- Existing acceptance: `docs/research/reports/tx-gap-7ce631-rocksolid-balancer-v3.md` records scanner,
  planner, quote, fork execution and positive EV closure.
- Candidate uses the unchanged main-side `blockscan-hunt.ts`; no candidate harness or fixture changes.

```ab_experiment
{
  "schema_version": 3,
  "experiment_id": "20260716-route-leg-adapter-equivalence",
  "problem_id": "route-leg-adapter-architecture-equivalence",
  "branch": "ab/route-leg-adapter-equivalence",
  "base_commit": "69e12b30719a7f80403f87d2dd18d8652d0f0865",
  "challenger_commit": "2a06229ca5f73280b1707eeb9c43d3aad1b4acf4",
  "change_class": "performance",
  "hypothesis": "explicit identity, route-leg, quote, warm and encoding registries preserve production semantics while retaining at least 95 percent of baseline paired performance",
  "input_mode": "shared",
  "lane_mode": "dual",
  "infrastructure_shakedown": false,
  "require_stage_advance": false,
  "expected_runtime_view_delta": false,
  "allowed_config_delta": [],
  "a": {
    "commit": "69e12b30719a7f80403f87d2dd18d8652d0f0865",
    "config_hash": "pending",
    "universe_hash": "pending",
    "discovery_to_block": 0,
    "blockscan_view_hash": "pending",
    "blockscan_graph_hash": "pending"
  },
  "b": {
    "commit": "2a06229ca5f73280b1707eeb9c43d3aad1b4acf4",
    "config_hash": "pending",
    "universe_hash": "pending",
    "discovery_to_block": 0,
    "blockscan_view_hash": "pending",
    "blockscan_graph_hash": "pending"
  },
  "window": {
    "min_paired_blocks": 30,
    "warmup_blocks": 5,
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
    "evidence": "unchanged RockSolid/Balancer V3 loop fixture records scanner admission, composed plan, positive quote, successful fork execution and positive net EV"
  },
  "resolution_replay": {
    "cwd": "listener",
    "argv": ["npm", "run", "searcher:loop-fork-gate", "--", "--fixture", "src/searcher/test/fixtures/loops/rocksolid-balancer-v3-7ce631.json", "--with-solver"],
    "timeout_seconds": 1200,
    "expected_transition": "final_sim_success remains final_sim_success with identical closed-loop route semantics"
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
      "tx_hash": "0x7ce631b94570e8ebcaea60e93ccfb808327087405e6f0561450d4bb7f69b3c87",
      "block_number": 25535037,
      "expected_net_profit_usd": 0.198,
      "evidence": "canonical receipt and accepted fork fixture show a victim-independent atomic WETH closed loop with realized gross profit 150817806425095 wei",
      "expected_route": [
        {
          "adapterId": "univ3-swap",
          "slotKind": "swap",
          "target": "0x553e9c493678d8606d6a5ba284643db2110df823",
          "tokenIn": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
          "tokenOut": "0xae78736cd615f374d3085123a210448e74fc6393"
        },
        {
          "adapterId": "rocksolid-sync-deposit",
          "slotKind": "protocol",
          "target": "0x936facdf10c8c36294e7b9d28345255539d81bc7",
          "tokenIn": "0xae78736cd615f374d3085123a210448e74fc6393",
          "tokenOut": "0x936facdf10c8c36294e7b9d28345255539d81bc7"
        },
        {
          "adapterId": "balancer-v3-unlock",
          "slotKind": "swap",
          "target": "0xbb6f701f42a6104deffc041c5c0057b8a9c46bbc",
          "tokenIn": "0x936facdf10c8c36294e7b9d28345255539d81bc7",
          "tokenOut": "0xae78736cd615f374d3085123a210448e74fc6393"
        },
        {
          "adapterId": "univ3-swap",
          "slotKind": "swap",
          "target": "0x553e9c493678d8606d6a5ba284643db2110df823",
          "tokenIn": "0xae78736cd615f374d3085123a210448e74fc6393",
          "tokenOut": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"
        }
      ]
    },
    "classification_review": {
      "verdict": "pass",
      "reviewer": "Cicero adversarial_code_review",
      "evidence": "fresh non-author review of the frozen refactor found no P0/P1, no sample-conditioned branch, and no change to the existing position-conserving RockSolid/Balancer route semantics"
    },
    "baseline_stage": "final_sim_success",
    "challenger_stage": "final_sim_success",
    "replay": {
      "result": "pass",
      "cwd": "listener",
      "argv": ["node", "--import", "tsx", "src/searcher/test/blockscan-hunt.ts"],
      "evidence": "trusted deployment gate reruns the unchanged parent-state hunt on both frozen worktrees; equivalence mode expects final_sim_success on both"
    }
  },
  "analysis": {
    "agent_manual_author": "codex-orchestrator",
    "agent_manual_verdict": "inconclusive",
    "agent_manual_evidence": "candidate deployment pending paired live evidence",
    "script_exit_code": 1,
    "script_assessment": "inconclusive",
    "script_artifact": "pending",
    "reconciliation": "inconclusive",
    "tool_selection": {
      "capability_query": ["single-transaction", "causality", "pnl", "competitor-window", "classification", "block-scan"],
      "selected_tools": ["analysis:bundle-postmortem", "repo:scripts/census-gap.sh"],
      "catalog_check_exit_code": 0,
      "evidence_manifest": "ab-20260716-route-leg-adapter-equivalence-tools.json",
      "evidence_manifest_sha256": "c69041f80da2e694686158053111eec00312b3fcccaee7ba3d689fa77594399e"
    }
  },
  "final_verdict": "needs_escalation",
  "branch_action": "retained",
  "b_stopped": false,
  "evidence_bundle": "pending paired node logs, trusted replay and comparator artifacts"
}
```
