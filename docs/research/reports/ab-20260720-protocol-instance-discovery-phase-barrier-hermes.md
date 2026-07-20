# Hermes A/B Canary `20260720-protocol-instance-discovery-phase-barrier`

## Problem + Implementation Brief

- **problem_id:** `protocol-instance-discovery-phase-barrier`
- **base / challenger:** `27f499c3780db8390c291b4cbfe2160ffd46d6bb` / `fdc88d4cc2a10f9676e862462da6c74694221765`
- **causal hypothesis:** The prior protocol-discovery challenger introduced a refinement-local `Promise.race` that returned at the soft deadline while as many as 24 exact quotes remained active. Four solver workers then entered the same block-scan Anvil. Waiting for every started probe promise, refusing to start a later hop after the deadline, and skipping solver whenever refinement crossed its reserved deadline removes that same-block 24+4 overlap.
- **one-change scope:** Preserve the existing protocol-instance-discovery challenger and replace only its false refinement cancellation with a strict refinement-to-solver phase barrier.
- **current architecture scope:** This remains the C1 observed-withdraw discovery slice plus canonical identity/probe/projection. It does **not** claim the later final architecture's independent protocol-worker cadence, persistent cursor, fork-simulated C2 evidence, specificity arbitration, behavior-evidence comparison, or verified/negative disk caches.
- **not doing:** No additional port, RPC cancellation framework, adapter semantics, graph policy, config, universe, harness, six-step gate, credit, inventory, private-flow, sandwich, JIT-LP, or flash-adapter change.

## Deterministic Gate

- The new regression holds a UniV2 exact quote beyond the refinement deadline and asserts that refinement does not settle until the owned quote settles, does not start the next hop after expiry, returns `deadlineHit=true`, and reports no quote failure.
- The test fails on frozen challenger `dd55dc3` at `deadline must not detach an in-flight quote` and passes on the corrected implementation.
- `npm run searcher:blockscan-candidate-refinement`, the related block-scan suites, protocol-edge admission, runtime defaults, and `npm run build` pass. A fresh non-author adversarial review reports P0/P1/P2 = 0.
- Honest residual: `AnvilStateBackend.call` still has an existing 30-second wrapper timeout that cannot cancel its underlying provider RPC. This change proves zero refinement-owned quote promises before same-block solver entry; it does not claim transport-level cancellation or zero possible carry-over into a later scan pass.

## Predeclared Live Acceptance

- Deploy only B through the trusted wrapper; A must remain at the exact base SHA with PID and restart count unchanged.
- Exclude startup/full-warm/catch-up/budget-censored blocks using the existing A/B rules.
- Observe at least 10 ordinary B block-scan passes after readiness.
- For every B block with `exactRouteProbes ... deadline=1`, require `skip solve reason=refinement_deadline inFlightProbePromises=0` and no later `solve ring=` for that same block.
- Record solve/refine/total stage distributions, B restarts, subsequent-pass recovery, and any low-level RPC carry-over. A new long pass is classified by its first long stage rather than attributed to solver by total wall time.
- This is a systemic resource/liveness check. The optional transaction-bound six-step diagnostic is `not_applicable` and must not gate deployment.

```ab_experiment
{
  "schema_version": 3,
  "experiment_id": "20260720-protocol-instance-discovery-phase-barrier",
  "problem_id": "protocol-instance-discovery-phase-barrier",
  "branch": "ab/protocol-instance-discovery-phase-barrier",
  "base_commit": "27f499c3780db8390c291b4cbfe2160ffd46d6bb",
  "challenger_commit": "fdc88d4cc2a10f9676e862462da6c74694221765",
  "change_class": "capability",
  "hypothesis": "A strict refinement-to-solver phase barrier removes the same-block 24+4 quote overlap while preserving the identity-attested protocol discovery challenger.",
  "input_mode": "shared",
  "lane_mode": "dual",
  "infrastructure_shakedown": false,
  "expected_runtime_view_delta": true,
  "allowed_config_delta": [],
  "a": {
    "commit": "27f499c3780db8390c291b4cbfe2160ffd46d6bb",
    "config_hash": "pending",
    "universe_hash": "pending"
  },
  "b": {
    "commit": "fdc88d4cc2a10f9676e862462da6c74694221765",
    "config_hash": "pending",
    "universe_hash": "pending"
  },
  "window": {
    "min_paired_blocks": 10,
    "warmup_blocks": 1
  },
  "fairness": {
    "same_block_window": false,
    "paired_blocks": 0,
    "champion_restart_delta": 0,
    "champion_pid_changed": false,
    "challenger_restarts": 0,
    "a_universe_hash_after": "pending",
    "b_universe_hash_after": "pending"
  },
  "deterministic_gate": {
    "result": "pass",
    "evidence": "Old dd55 fails and corrected code passes the owned-in-flight-quote and no-next-hop deadline regression; build and related suites pass."
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
    }
  },
  "analysis": {
    "agent_manual_author": "Codex",
    "agent_manual_verdict": "inconclusive",
    "agent_manual_evidence": "Predeploy: deterministic phase-barrier regression passes; live B evidence pending.",
    "script_exit_code": 1,
    "script_assessment": "inconclusive",
    "script_artifact": "pending",
    "reconciliation": "inconclusive",
    "adversarial_review": {
      "verdict": "inconclusive",
      "evidence": "Predeploy code review P0/P1/P2=0; live resource result pending.",
      "reviewer": "phase_barrier_adversarial"
    }
  },
  "final_verdict": "needs_escalation",
  "branch_action": "retained",
  "b_stopped": true,
  "evidence_bundle": "predeploy deterministic evidence; live bundle pending"
}
```

