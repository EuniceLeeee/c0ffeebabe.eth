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

## Live Result

- **Deployment lifecycle:** The trusted wrapper started exact runtime SHA `fdc88d4cc2a10f9676e862462da6c74694221765` as B with PID `1156445`, restart count `0`, the dual/public-only posture, and the existing isolated B ports. A remained exact SHA `27f499c3780db8390c291b4cbfe2160ffd46d6bb`, PID `1136234`, restart count `0`. B did not reach the wrapper's first-`scannedPairs` readiness condition, so the in-progress deploy was cancelled and the trusted `cancel-pending` path stopped B; it verified champion PID `1136234` unchanged.
- **Phase-barrier flip:** Startup block `25573051` attempted 512 probes (`positive=214 negative=267 failed=10`), hit the refinement deadline, emitted `skip solve reason=refinement_deadline inFlightProbePromises=0`, and recorded `solve_planner/solver/quote/sim/submit=0ms`. Catch-up block `25573074` repeated the same invariant after 442 probes (`positive=180 negative=235 failed=5`), again with no solver work.
- **Remaining runtime blocker:** Strict ownership exposed the underlying cost instead of mislabeling it as solve: block `25573051` spent `89246ms` in refinement (`239303ms` total startup full-warm), and block `25573074` spent `87888ms` in refinement (`98796ms` total). With up to 512 exact RPC route probes, waiting for every started probe prevents the 24+4 overlap but leaves no ordinary pass able to reach `scannedPairs` under the current structure.
- **Architecture evidence:** At the same fixed discovery cutoff, this restart produced `instances=0 would_admit=0 protocol_edges=53->53`, whereas the prior process had `instances=222` and `53->497`. This confirms that the current code does not implement the attachment's persisted verified/negative caches, reload re-attestation, or fork-simulated C2 evidence; pruned historical payout evidence can collapse discovery recall after restart.

## Decision

- **Verdict:** `needs_escalation`; do not merge this challenger as the protocol-discovery solution.
- **What is fixed:** The refinement-local false cancellation and same-block refinement→solver overlap have a deterministic red/green test and a live behavior flip.
- **What is not fixed:** The two-stage algorithm still performs hundreds of exact RPC probes before an exact solver. Under a real phase barrier this consumes roughly 88 seconds and prevents readiness. The next design must remove duplicate exact work—coarse/cache-only refinement followed by one bounded exact solver queue—rather than add another timeout, arbitrary concurrency knob, or deployment exception.

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
    "agent_manual_evidence": "Live B proved the phase barrier twice: deadline blocks 25573051 and 25573074 emitted skip-solve and zero solve-stage work. It also exposed 89s/88s refinement cost, preventing first-scannedPairs readiness; B was stopped through trusted cancel-pending and A PID 1136234 remained unchanged.",
    "script_exit_code": 1,
    "script_assessment": "inconclusive",
    "script_artifact": "pending",
    "reconciliation": "inconclusive",
    "adversarial_review": {
      "verdict": "inconclusive",
      "evidence": "Code review P0/P1/P2=0. Live behavior confirmed zero same-block solver work after refinement deadline, but strict barrier exposed an unresolved 88s exact-refinement workload and no readiness pass.",
      "reviewer": "phase_barrier_adversarial"
    }
  },
  "final_verdict": "needs_escalation",
  "branch_action": "retained",
  "b_stopped": true,
  "evidence_bundle": "trusted wrapper startup/cancel-pending receipts plus redacted blockscan summaries for blocks 25573051, 25573071, and 25573074"
}
```
