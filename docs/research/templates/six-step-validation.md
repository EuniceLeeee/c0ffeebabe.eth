# Six-step validation request and generated receipt

This template defines the new two-tier lifecycle for **deterministic adapter/route work**. It does not delete
or reinterpret an existing historical/Hermes report. Legacy harnesses remain available as diagnostic and
legacy-record evidence; they are not allowed to veto a complete canonical six-step receipt merely because
their architecture-specific matcher became stale.

The operator writes a small run request. A trusted controller computes all stage records and the verdict.
Neither a feature branch nor a human may submit pre-filled `pass` stages.

The current controller supports `block_scan_standing`. It rejects `backrun` until a trusted producer can
apply and bind the complete ordered prefix before the target transaction.

## 1. Pre-merge lightweight checkpoint

Freeze production-equivalent inputs once from the current trusted main process, then reuse that immutable
snapshot for checkpoint reruns:

```bash
npm run six-step-validation-gate -- \
  --freeze-inputs \
  --sample-tx 0x<64 lowercase hex> \
  --universe /path/to/full-universe.json \
  --universe-manifest /path/to/full-universe.manifest.json \
  --out /path/to/production-input-snapshot.json
```

The trusted snapshot binds the baseline runtime commit, normalized `SEARCHER_*` configuration,
universe/manifest bytes and provenance, sample receipt, canonical parent header, and source hashes. Creating
the snapshot needs the active trusted process/reth; replaying a checkpoint does not. A family-local rerun may
reuse unchanged content-addressed DEX/other-family shards and recompute only its impacted family shard. The
assembled materialized graph and shard-completeness vector are always rehashed before enumeration.

Run the checkpoint controller from a clean checkout whose `HEAD` is the trusted baseline commit recorded in
the snapshot. It resolves the exact branch tip and creates its own detached candidate worktree. The candidate
does not run or modify the controller.

Request:

```json
{
  "schema_version": 1,
  "request": "trusted-six-step-validation-request",
  "mode": "checkpoint",
  "branch": "codex/<work>",
  "rollback_commit": "<40-char current origin/main commit>",
  "sample_tx_hash": "0x<64 lowercase hex>",
  "lane": "block_scan_standing",
  "input_snapshot_path": "/path/to/production-input-snapshot.json",
  "universe_path": "<local copy of the active full production universe>",
  "universe_manifest_path": "<matching provenance sidecar>",
  "runner_overrides": {
    "wall_clock_timeout_ms": 1800000
  }
}
```

The file paths locate bytes; they are not evidence by themselves. The supplied files must byte-match the
trusted frozen snapshot. Caller-provided RPC URLs and runtime env files are rejected.

Only `runner_overrides.wall_clock_timeout_ms` may be supplied. It changes the wrapper wait ceiling, not
production graph size, ranking, top-K, refinement, solve, pass, EV, or safety limits.

Run from `analysis/`:

```bash
npm run six-step-validation-gate -- \
  --phase checkpoint \
  --request /path/to/checkpoint-request.json \
  --out /path/to/checkpoint-receipt.json
```

The controller produces:

- `checkpoint-receipt.json`: the lifecycle envelope; and
- `checkpoint-receipt.json.producer.json`: the fsynced target-blind producer output.

The producer receives no expected route, family, target pool, amount, plan, or calldata hint. It first writes
and hashes the actually materialized graph, shard-completeness vector, and naturally enumerated route set.
Only then may the comparator check the
sample-derived expected route.

`checkpoint_pass` means all six canonical stages passed on the exact candidate and frozen production inputs.
It permits merge and bounded-live main under the existing safety envelope. It does **not** mean `fixed`, and
it does not authorize branch deletion. The branch remains `pending_final_validation`.

## 2. Independent post-merge review

After merging and deploying the candidate code, a fresh non-author reviews the exact binary/full-index patch
from `rollback_commit` to `reviewed_candidate_commit`. The review is committed under
`docs/research/reports/*.json`; an arbitrary uncommitted JSON path is not accepted. This report-only commit
does not require redeploying an identical binary.

```json
{
  "schema_version": 1,
  "artifact": "six-step-independent-review",
  "reviewer_email": "reviewer@example.com",
  "rollback_commit": "<checkpoint rollback commit>",
  "reviewed_candidate_commit": "<checkpoint candidate commit>",
  "reviewed_merge_commit": "<real merge commit containing the candidate>",
  "diff_sha256": "<sha256 of git diff --binary --full-index rollback..candidate>",
  "reviewed_at": "2026-07-28T12:00:00.000Z",
  "evidence": "<concise review evidence and scope, at least 20 characters>",
  "verdict": "pass"
}
```

Git email is an auditable attribution, not cryptographic personal identity. The controller still requires
that the reviewer did not author or commit any commit in the candidate range, that the review commit is a
report-only descendant of the deployed merge, and that the committed artifact binds the exact candidate
patch and merge ancestry.

## 3. Post-merge/deployed-main full validation

The final run validates the exact deployed merge commit. `origin/main` may be a report-only descendant that
adds the independent review; the controller verifies that no runtime/dependency/config source changed between
the deployed commit and the review commit, so no redundant deployment is required.

```json
{
  "schema_version": 1,
  "request": "trusted-six-step-validation-request",
  "mode": "final",
  "branch": "codex/<work>",
  "rollback_commit": "<same checkpoint rollback commit>",
  "sample_tx_hash": "0x<same sample>",
  "lane": "block_scan_standing",
  "universe_path": "<local copy of the exact deployed full universe>",
  "universe_manifest_path": "<matching deployed provenance sidecar>",
  "checkpoint_receipt_path": "/path/to/checkpoint-receipt.json",
  "review_commit": "<origin/main report-only descendant containing the review>",
  "review_artifact_path": "docs/research/reports/<review>.json",
  "runner_overrides": {
    "wall_clock_timeout_ms": 1800000
  }
}
```

Final validation permits the same single non-semantic override: the outer wrapper wall-clock timeout. All
internal production deadlines, caps, ranking, ordering, and policy remain exact.

```bash
npm run six-step-validation-gate -- \
  --phase final \
  --request /path/to/final-request.json \
  --out /path/to/final-receipt.json
```

The controller reruns all six stages. It does not promote or copy checkpoint stage results. Before and after
the run it independently attests the deployed process/config/universe/sample identity and rejects drift. It
also verifies that the review-only descendant changed no runtime surface and validates the retained
checkpoint's exact branch/candidate/rollback/sample, state anchor, route, and family scope.

Only `final_validated` means the deterministic claim is `fixed`.

After removing any clean candidate worktree, rerun the same final request with cleanup:

```bash
npm run six-step-validation-gate -- \
  --phase final \
  --request /path/to/final-request.json \
  --out /path/to/final-receipt.json \
  --finalize-cleanup
```

The cleanup path revalidates the just-generated receipt and exact local/remote refs, then deletes with an
exact lease. The branch-delete hook prevents accidental raw deletion; it is not the source of authorization.

## 4. Stable six-step evidence

Every successful lifecycle receipt contains one causally linked semantic-v4 sequence:

1. `discovery_admission_graph`
2. `route_enumeration`
3. `exact_quote_refine`
4. `plan_and_size`
5. `fork_final_sim`
6. `production_ev`

All six bind the same code/input/config/graph hashes and lane-aware `StateAnchor`. Step 2 commits the natural
route set; step 3 commits exact quote amounts; step 4 consumes that quote and commits the resolved plan; step
5 consumes that plan and commits calldata/simulation; step 6 consumes the final-sim economics. The first
`fail`, `reject`, or `not_reached` is the real stopping point; a reviewer may classify scope or a legacy
harness defect, but may not rewrite it to `pass`.

For `block_scan_standing` opportunity block `N`, the base state is canonical `N-1`. A future `backrun`
producer must instead bind canonical `N-1` plus the complete ordered in-block prefix required by the declared
trigger/target.

## 5. Scope and coexistence with the old flow

- A family-local deterministic change may include its family-owned discovery/probe and thin registration
  when central behavior and every unrelated family source closure are unchanged.
- A shared discovery source, global admission/cap/ranking rule, central capability/framework change, or
  cross-family resource/cardinality change is not supported by this controller today and must use Hermes A/B
  with a predeclared cross-family cohort.
- Intake, universe/admission distribution, ranking, latency, concurrency, deadline, and shared-resource
  changes remain `systemic_live` and use Hermes A/B.
- Existing `historical-gap-gate`, Adapter Replay, historical reports, and Hermes acceptance commands remain
  readable and runnable. They supply diagnostics or close their own legacy records; this new controller does
  not retroactively mutate them.
- Backrun remains on the legacy causal replay/Hermes path and cannot receive `checkpoint_pass` or
  `final_validated` until the canonical controller supports a complete ordered prefix.
- Hard safety failures—wrong state/SHA/config, missing repayment/conservation, standing position,
  wallet/signing violations—are never manually waived.
