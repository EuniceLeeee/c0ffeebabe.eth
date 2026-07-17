# Hermes A/B Canary `20260716-route-leg-adapter-equivalence`

> Production-equivalence and performance comparison of the route-leg adapter refactor. The intervention
> changes architecture, not venue coverage or strategy behavior. All candidate safety/evidence gates remain
> enabled; only the same-sample stage-advance assertion is explicitly disabled for this equivalence run.

## Problem + Implementation Brief

- **problem_id:** route-leg-adapter-architecture-equivalence
- **causal hypothesis:** routing venue identity, quote, warm, planning and encoding through explicit
  registries preserves semantic output while retaining at least 95% of the baseline paired performance.
- **semantic success criterion:** the trusted tx149 GOLDx/Curve-underlying closed-loop replay reaches
  `final_sim_success` on both commits; live paired semantic outputs match; candidate p50 performance is at
  least 95% of baseline, with tail differences explained from paired evidence.
- **change_class:** performance
- **one-change scope:** production searcher architecture only; no test, fixture, dependency, deployment,
  FlashAdapterRegistry, config, universe or harness change in the frozen candidate diff.
- **base listener provenance:** base `69e12b3` has no `listener/src` diff from requested baseline `4392ffc`.
- **frozen candidate:** `2a06229ca5f73280b1707eeb9c43d3aad1b4acf4`.

## Deterministic Evidence

- Existing trusted replay: `npm run searcher:blockscan-hunt-tx149`.
- Existing acceptance: `docs/research/reports/ab-20260715-tx149-gap-repair-v2-hermes.md` records scanner,
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
    "evidence": "unchanged blockscan-hunt self-enumerated USDT-PAXG-GOLDx-USDx-USDT at parent 25535055 and fork-simulated net_profit_raw=442380"
  },
  "resolution_replay": {
    "cwd": "listener",
    "argv": ["npm", "run", "searcher:blockscan-hunt-tx149"],
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
      "reviewer": "Cicero adversarial_code_review (2026-07-17 route-adapter A/B)",
      "evidence": "fresh non-author review confirmed tx149 remains a victim-independent position-conserving dex-permissionless-protocol atomic loop, and audited 69e12b3..2a06229 without finding tx-hash, block, pool or rank special-casing; the registry refactor follows generic production paths"
    },
    "baseline_stage": "final_sim_success",
    "challenger_stage": "final_sim_success",
    "replay": {
      "result": "pass",
      "cwd": "listener",
      "argv": ["node", "--import", "tsx", "src/searcher/test/blockscan-hunt.ts"],
      "evidence": "trusted deployment gate reruns the unchanged tx149 parent-state hunt on both frozen worktrees; equivalence mode expects final_sim_success on both"
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
      "evidence_manifest": "ab-20260715-tx149-gap-repair-v2-tools.json",
      "evidence_manifest_sha256": "f915fe1a0f74124eb296efb13b3fdf46906a7b4a1ce31eb878420a94074d1207"
    }
  },
  "final_verdict": "needs_escalation",
  "branch_action": "retained",
  "b_stopped": false,
  "evidence_bundle": "pending paired node logs, trusted replay and comparator artifacts"
}
```
