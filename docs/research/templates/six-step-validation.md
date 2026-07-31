# Core six-step judgment receipt

This template describes the architecture-independent input accepted by:

```bash
cd analysis
npm run six-step-validation-gate -- \
  --input /path/to/semantic-receipt.json \
  --out /path/to/judgment.json
```

The command is a pure result judge. It does not run discovery, replay, simulation,
Git, deployment, or branch cleanup. The embedded receipts must already have been
emitted and authenticated by their trusted producers. A caller-authored object
that merely resembles these receipts is not evidence.

The old `--phase checkpoint|final`, `--request`, `--freeze-inputs`, and
`--finalize-cleanup` controller interface is retired and rejected.

## Adapter-family claim

Use this claim to decide whether an adapter defect is fixed and whether the
family-owned diff may merge. Natural scanner enumeration is intentionally not
part of this claim.

```json
{
  "schema_version": 1,
  "gate": "six-step-judgment",
  "claim": "adapter_merge",
  "promotion_receipt_sha256": "<historical promotion receipt digest>",
  "promotion_receipt": {
    "schema_version": 1,
    "gate": "historical-gap-gate",
    "track": "family-execution",
    "base_commit": "<40-hex SHA>",
    "challenger_commit": "<40-hex SHA>",
    "auth_tag": "<trusted HMAC>",
    "auth_command_id": "<trusted command UUID>",
    "family_execution_artifacts": [
      {
        "fixture_path": "<repo fixture path>",
        "fixture_sha256": "<sha256>",
        "evidence_path": "<repo landed-evidence path>",
        "evidence_sha256": "<sha256>",
        "reference_tx": "<0x tx hash>",
        "execution_family_id": "<family id>",
        "baseline": "<native HistoricalFamilyExecutionSideResult>",
        "challenger": "<native HistoricalFamilyExecutionSideResult>"
      }
    ],
    "family_conformance": "<native conformance attestation>",
    "family_ownership": "<native ownership/coverage attestation>"
  },
  "family_boundary": {
    "schema_version": 1,
    "gate": "adapter-family-boundary",
    "baseline_commit": "<same base>",
    "candidate_commit": "<same challenger>",
    "classification": "family_local",
    "impacted_family_ids": ["<exact replay family set>"],
    "reasons": [],
    "other_family_source_set_baseline_sha256": "<sha256>",
    "other_family_source_set_candidate_sha256": "<same sha256>",
    "receipt_sha256": "<producer-emitted canonical semantic SHA-256>"
  }
}
```

Required result:

```json
{
  "claim": "adapter_merge",
  "verdict": "pass",
  "trust_boundary": "preauthenticated_receipts",
  "adapter_fixed": true,
  "adapter_merge_ready": true,
  "production_gap_fixed": false
}
```

The native family receipt must prove:

- baseline is unregistered, or the same typed family-owned failure reproduces;
- challenger emits `adapter_replay_pass`;
- family steps 1–2 are `bypassed`, and current-schema steps 3–6 pass;
- exact quote, production planning/sizing, calldata, fork final sim,
  repayment/conservation, and positive allowed production EV pass;
- every fixture/evidence/route/state/code digest remains bound;
- ownership covers the exact impacted family set and permits multiple fixtures
  for one family;
- conformance producers are unchanged and the boundary is `family_local`.

`adapter_fixed=true` with `adapter_merge_ready=false` means the execution defect
flipped, but the diff crossed the family boundary. Keep the adapter work; move
the framework files to a separate branch.

## Production-gap claim

Use this claim only when deciding whether a transaction-specific production gap
is actually closed.

```json
{
  "schema_version": 1,
  "gate": "six-step-judgment",
  "claim": "production_gap",
  "candidate_commit": "<40-hex SHA>",
  "producer_contract": {
    "candidate_commit": "<same SHA>",
    "target_blind": true,
    "explicit_route_injected": false,
    "explicit_amount_injected": false,
    "amount_source": "solver",
    "run_id": "<sha256>",
    "state_anchor_sha256": "<sha256>",
    "frozen_output_sha256": "<sha256>",
    "target_late_verifier_sha256": "<sha256>"
  },
  "natural_scan": {
    "outcome": "ran",
    "rank_complete": true,
    "refinement_deadline_exceeded": false,
    "evaluation_complete": true,
    "forced_selection_count": 0,
    "run_id": "<same run>",
    "state_anchor_sha256": "<same anchor>",
    "target_route_sha256": "<same route as all six stages>",
    "route_set_sha256": "<same natural step-2 route set>"
  },
  "production_route_stage": [
    "<six current-schema SemanticSixStepEvidence records>"
  ]
}
```

Required result:

```json
{
  "claim": "production_gap",
  "verdict": "pass",
  "trust_boundary": "preauthenticated_receipts",
  "adapter_fixed": false,
  "adapter_merge_ready": false,
  "production_gap_fixed": true
}
```

The six records must be one causal chain:

1. production graph contains the edge;
2. target-blind natural enumeration contains the route;
3. exact quote consumes that route;
4. solver selects the amount and resolved plan;
5. mandatory final sim executes that plan with repayment/conservation;
6. production EV consumes that final sim and returns `decision=allow` with
   `net_ev_wei > 0`.

The producer output freezes before the target/reference verifier is allowed to
inspect the expected route. Any injected route/amount, incomplete rank,
deadline-truncated refine, forced selection, mixed run/state/route, failed final
sim, rejected EV, or non-positive EV fails the claim.

## Verdict boundaries

| Result | Meaning |
|---|---|
| `implemented_not_validated` | Code/tests only; no decisive receipt flip. |
| `adapter_fixed` | Route-pinned adapter execution defect flipped. |
| `adapter_merge_ready` | `adapter_fixed` plus exact `family_local` boundary; only the family-owned diff may merge. |
| `production_gap_fixed` | Target-blind natural six-step production chain passed. |
| `systemic_live` | Separate cohort + Hermes A/B; this judge does not close it. |

The judge never merges, deploys, rolls back, or deletes a branch.
