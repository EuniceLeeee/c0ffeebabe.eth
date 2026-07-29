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
snapshot for checkpoint reruns. First write the freeze request:

```json
{
  "schema_version": 1,
  "request": "trusted-six-step-input-freeze-request",
  "sample_tx_hash": "0x<64 lowercase hex>",
  "lane": "block_scan_standing",
  "universe_path": "/absolute/path/to/full-universe.json",
  "universe_manifest_path": "/absolute/path/to/full-universe.manifest.json"
}
```

```bash
npm run six-step-validation-gate -- \
  --freeze-inputs \
  --request /path/to/freeze-request.json \
  --out /path/to/production-input-snapshot.json
```

The trusted snapshot binds the baseline runtime commit, normalized `SEARCHER_*` configuration,
universe/manifest bytes and provenance, sample receipt, canonical parent header, and source hashes. Creating
the snapshot needs the active trusted process/reth; replaying a checkpoint does not. A family-local rerun may
reuse unchanged content-addressed DEX/other-family shards and recompute only its impacted family shard. The
assembled materialized graph and shard-completeness vector are always rehashed before enumeration.

The controller runs both commits on those same frozen inputs. The rollback target-blind producer must stop
before step 6 and its sealed producer/verifier hashes are recorded in `baseline_route_outcome`; the candidate
must pass steps 1–6 naturally. If rollback already reaches final EV, the checkpoint fails rather than
crediting a no-op or unrelated same-family diff. Final validation reruns and binds the same baseline failure
and deployed success.
Each producer receipt binds the actual universe, universe-manifest and exact runtime-JSON key/SHA tuple.
`budget_exceeded`, incomplete natural ranking or an exact-refinement deadline on either side invalidates the
comparison; it is never accepted as a baseline route miss. The file seals and pre/post hashes detect normal
input drift but do not claim same-UID hostile-code sandboxing.
The legacy `rankComplete` field means completion of the exact frozen **production policy**, including its
configured DFS/path cap; it is not an exhaustive-all-paths claim. The candidate must still enter the natural
production top-K without target injection and pass final sim.
This first result-contract implementation accepts only a route absent from natural output or a naturally
enumerated-but-unsolved rollback failure. Post-solve baseline failures fail closed until a typed domain
witness distinguishes deterministic EVM/policy failure from infrastructure; error text is insufficient.

Run the checkpoint controller from a clean checkout whose `HEAD` is the trusted baseline commit recorded in
the snapshot. It resolves the exact branch tip and creates its own detached candidate worktree. The candidate
does not run or modify the controller.

Request:

```json
{
  "schema_version": 2,
  "request": "trusted-six-step-validation-request",
  "mode": "checkpoint",
  "branch": "codex/<work>",
  "rollback_commit": "<40-char current origin/main commit>",
  "sample_tx_hash": "0x<64 lowercase hex>",
  "lane": "block_scan_standing",
  "trusted_reference_path": "docs/research/references/production-routes/<sample>.json",
  "input_snapshot_path": "/path/to/production-input-snapshot.json",
  "runner_overrides": {
    "wall_clock_timeout_ms": 1800000
  }
}
```

The file paths locate bytes; they are not evidence by themselves. The supplied files must byte-match the
trusted frozen snapshot. `trusted_reference_path` is repository-relative and must already exist in the
rollback/main tree under `docs/research/references/production-routes/`; a family candidate may neither add
nor modify it. It binds the target receipt/call-trace hash, lane-correct anchor, normalized ordered route
and one finite declarative `ReferenceWitness` per leg. The witness binds both route tokens, ABI/argument
relations, call ancestry, receipt transfers and (when distinct from the execution target) `pool-id`.
Bare target/selector sequences are rejected, and one physical call/log cannot satisfy two witness rules or
two route legs. Caller-provided RPC URLs and runtime env files are rejected.

The trusted reference is produced by an independent transaction/trace analysis and merged into main
**before** the adapter branch is cut. There is deliberately no candidate-side CLI that manufactures this
oracle. Its minimal reviewed shape is:

```json
{
  "schemaVersion": 2,
  "artifact": "trusted-production-reference-route",
  "sampleTxHash": "0x<64 lowercase hex>",
  "targetInputSha256": "<64 lowercase hex>",
  "stateAnchor": {
    "opportunityBlock": 123,
    "baseBlock": 122,
    "baseBlockHash": "0x<64 lowercase hex>",
    "baseStateRoot": "0x<64 lowercase hex>"
  },
  "route": [
    {
      "adapterId": "<family-owned adapter id>",
      "target": "0x<40 lowercase hex>",
      "tokenIn": "0x<40 lowercase hex>",
      "tokenOut": "0x<40 lowercase hex>",
      "slotKind": "swap",
      "edgeKind": "<semantic edge kind>",
      "leavesStandingPosition": false,
      "poolId": "<optional normalized opaque pool id>"
    },
    {
      "adapterId": "<closing adapter id>",
      "target": "0x<40 lowercase hex>",
      "tokenIn": "0x<40 lowercase hex>",
      "tokenOut": "0x<same route-start token>",
      "slotKind": "swap",
      "edgeKind": "<semantic edge kind>",
      "leavesStandingPosition": false
    }
  ],
  "routeSha256": "<sha256 of the normalized ordered route>",
  "routeWitnesses": [
    {
      "seq": 1,
      "edgeAdapterId": "<same as route[0].adapterId>",
      "tokenIn": "0x<same as route[0].tokenIn>",
      "tokenOut": "0x<same as route[0].tokenOut>",
      "poolId": "0x<include only when route[0] has poolId>",
      "referenceWitness": {
        "calls": [
          {
            "id": "root",
            "target": "execution-target",
            "signature": "swap(bytes32,address,address,uint256)",
            "args": [
              { "index": 0, "op": "eq", "ref": "pool-id" },
              { "index": 1, "op": "eq", "ref": "token-in" },
              { "index": 2, "op": "eq", "ref": "token-out" },
              { "index": 3, "op": "positive" }
            ],
            "value": null
          }
        ],
        "receiptTransfers": []
      }
    },
    {
      "seq": 2,
      "edgeAdapterId": "<same as route[1].adapterId>",
      "tokenIn": "0x<same as route[1].tokenIn>",
      "tokenOut": "0x<same as route[1].tokenOut>",
      "referenceWitness": {
        "calls": [
          {
            "id": "root",
            "target": "execution-target",
            "signature": "swap(address,address,uint256)",
            "args": [
              { "index": 0, "op": "eq", "ref": "token-in" },
              { "index": 1, "op": "eq", "ref": "token-out" },
              { "index": 2, "op": "positive" }
            ],
            "value": null
          }
        ],
        "receiptTransfers": []
      }
    }
  ]
}
```

The concrete ABI and rules come from independent trace review; the placeholder signatures above are schema
examples, not universal swap ABIs. A leg may add bounded child-call rules with `within`, relational
`call:<id>:from` / `call:<id>:arg:<n>` references, and ERC-20 receipt-transfer rules. Every leg must bind
both route tokens. If `poolId` differs from the execution target, the witness must also use `pool-id`.
Protocols whose identity exists only inside a nested tuple or derived PoolKey intentionally fail closed
until the protocol-neutral witness schema supports that relation; do not add a family-name special case.

The target trace must satisfy these semantic rules. The final-sim trace must satisfy the same rules and each
root call's complete input SHA-256 must equal the calldata independently compiled from the corresponding
solver-selected resolved-plan subtree, including its selected amount and child bytes.

The producer additionally freezes the route-root ActionAdapter, ordered subtree action IDs and every
external call emitted by each subtree. The trusted controller re-derives candidate ownership: the root must
be owned by the route family, descendants must be same-family owned or explicitly required ownerless infra,
and unattributed funding-wrapper siblings must be ownerless and declared. Every external support call must
be covered by a bounded route witness in the target trace and byte-match in final sim; a same-token transfer
is still an execution effect. Owned/foreign or unwitnessed siblings and ambiguous family-owned multi-sibling
route fragments fail closed until a protocol-neutral per-leg provenance capability exists. A later route
root may not be borrowed from an earlier route root's descendant subtree.
The single family changed by the candidate must be among this selected route's required families; an
unrelated already-working route cannot authorize the branch.
An ActionAdapter required as shared infra by any family must remain globally ownerless; a candidate cannot
redeclare it as its owned route root.

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
- `checkpoint-receipt.json.producer.json`: the trusted verifier's raw receipt, which embeds and hash-binds
  the durably sealed candidate target-blind producer output; and
- `checkpoint-receipt.json.baseline.producer.json`: the rollback verifier's raw failure receipt.

The candidate producer receives neither the sample transaction nor the trusted reference through argv or
environment, and receives no expected route, family, target pool, amount, plan, or calldata hint. It first
writes and hashes the actually materialized graph, shard-completeness vector, naturally enumerated top-K,
resolved hop amounts and raw calldata. After the producer exits, the controller seals that artifact in the
same directory with file fsync, atomic rename, read-only permissions and directory fsync. Only then may the
rollback/main verifier read the sample transaction and trusted reference, match the frozen route, execute
the frozen calldata on a fresh fork, and recompute repayment/conservation, standing, profit, policy and EV.
Both the sealed producer artifact and trusted reference are rehashed after verification.

This is explicit-input target-late isolation, not a hostile-code sandbox. The disposable producer checkout
omits the reference directory and the rollback verifier checkout is created only after sealing, but candidate
code can still read repository Git objects and the archive RPC. Public or post-freeze samples are regression
evidence only; a generalization claim additionally needs a future hidden reference plus source-filesystem and
source-block-limited RPC isolation.

`checkpoint_pass` means rollback failed before step 6 and all six canonical stages passed on the exact
candidate under the same frozen production inputs.
It permits merge and bounded-live main under the existing safety envelope. It does **not** mean `fixed`, and
it does not authorize branch deletion. The branch remains `pending_final_validation`.

## 2. Independent post-merge review

After merging and deploying the candidate code, a fresh non-author reviews the exact binary/full-index patch
from `rollback_commit` to `reviewed_candidate_commit`. The review is committed under
`docs/research/reports/*.json`; an arbitrary uncommitted JSON path is not accepted. This report-only commit
does not require redeploying an identical binary.

```json
{
  "schema_version": 2,
  "artifact": "six-step-independent-review",
  "reviewer_email": "reviewer@example.com",
  "rollback_commit": "<checkpoint rollback commit>",
  "reviewed_candidate_commit": "<checkpoint candidate commit>",
  "reviewed_merge_commit": "<real merge commit containing the candidate>",
  "integration_base_commit": "<first parent: latest main used for integration>",
  "diff_sha256": "<sha256 of git diff --binary --full-index rollback..candidate>",
  "merge_patch_sha256": "<sha256 of git diff --binary --full-index integration-base..merge>",
  "candidate_tree_delta_sha256": "<sha256 of git diff --binary --full-index candidate..merge>",
  "overlap_paths": [
    "<sorted path changed by both rollback..candidate and rollback..integration-base>"
  ],
  "reviewed_at": "2026-07-28T12:00:00.000Z",
  "evidence": "<semantic disposition for every overlap and the retained regressions>",
  "verdict": "pass"
}
```

Git email is an auditable attribution, not cryptographic personal identity. The controller still requires
that the reviewer did not author or commit any commit in the candidate range, that the review commit is a
report-only descendant of the deployed merge, and that the committed artifact binds the exact candidate
patch and merge ancestry. The deployed commit must be a real two-parent merge whose first parent is
`integration_base_commit` and second parent is the exact candidate tip. The validator recomputes both tree
diff hashes and the exact sorted overlap set, then reruns the family boundary on first-parent→merge. Hashes
do not replace human review: every overlap must be reviewed function by function and its disposition named
in `evidence`.

## 3. Post-merge/deployed-main full validation

The final run validates the exact deployed merge commit. `origin/main` may be a report-only descendant that
adds the independent review; the controller verifies that no runtime/dependency/config source changed between
the deployed commit and the review commit, so no redundant deployment is required.

```json
{
  "schema_version": 2,
  "request": "trusted-six-step-validation-request",
  "mode": "final",
  "branch": "codex/<work>",
  "rollback_commit": "<same checkpoint rollback commit>",
  "sample_tx_hash": "0x<same sample>",
  "lane": "block_scan_standing",
  "trusted_reference_path": "docs/research/references/production-routes/<same sample>.json",
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
checkpoint's exact branch/candidate/rollback/sample, state anchor, route, family scope, and the same trusted
reference artifact SHA.

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
