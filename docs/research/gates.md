# Validation Gates — the repo's test contract

> Scope: authorized defensive on-chain arbitrage research (fork/dry-run; broadcast is a human gate).
> This is where "how do we know a change is actually correct" lives — extracted from the Hermes
> protocol (was governance rule 12) so it reads as a **test contract**, not always-loaded prose.
> `docs/research/HERMES.md` rule 12 is a one-line pointer here. The endgame (distill-kit doctrine): correctness
> rules become **assertions in the harnesses below** and get DELETED from prose — see §Correctness
> properties.

## Rule 12 — repair-replay double-gate (anti-instrument-drift)

Every transaction-bound deterministic turn that claims to improve a specific route ships a pinned sample and
runs the target-blind lightweight checkpoint before merge:
- **single-route correctness / coverage / path** → a deterministic replay asserts the behavior flip
  (`no_candidate → plans>0` / pool now routes / `sim.success`). No flip = not fixed, or the change was
  instrument-only.
- **latency** → replay the SAME fixture before/after, compare per-stage `seg` ms. Relative only
  (harness-bound), valid ONLY if the harness faithfully reproduces the latency source (cold state / real
  backend).

A checkpoint flip proves enough to merge and start bounded-live main; the deterministic claim becomes
`fixed` only after the post-merge/deployed-main full validation below. A systemic protocol scanner,
graph/universe, distribution, or performance change is not proven by one
transaction. It predeclares a representative positive/negative cohort plus coverage/output equivalence,
same-block fairness, CPU/pass-latency, budget-censoring, candidate-composition, and final-sim false-positive
criteria as applicable. Its decisive check is that cohort contract plus Hermes A/B; a single-route six-step
diagnostic is not a deployment, decision, close, or merge switch for that systemic claim.

### Three validation tracks

Every claim selects exactly one track before evidence is produced:

| Track | Claim it may close | Decisive evidence |
|---|---|---|
| `family_execution` | Supporting precheck: every registry-derived quote-bearing `RouteLeg` family affected by the diff can build its family-owned edges, quote, plan/size, encode and execute a trace-proven route safely. Funding-only families are not subjects of this track. | Exact changed-owner-family ↔ fixture-subject coverage, trusted route-pinned Family/Adapter Replay, family conformance/isolation, fork final sim, repayment/conservation and production EV. Production discovery and route enumeration are `bypassed`; the result is `adapter_replay_pass`, not a merge/cleanup verdict. |
| `production_route_stage` | The production funnel can self-discover and advance a particular historical route. | Target-blind Production Replay with no route or amount supplied to discovery, enumeration, pruning, ranking, solve selection or sizing: checkpoint before merge, then full validation against the exact deployed merge. The expected route is an output-only oracle applied after production output is frozen. |
| `systemic_live` | Intake, universe/admission, scanner/ranking, candidate distribution, shared hot-path latency, concurrency, deadlines or resource behavior improved without unacceptable regressions. | Predeclared positive/negative cohort, same-input coverage/output/resource evidence and Hermes paired A/B. A single-route six-step record is diagnostic only. |

`family_execution` never proves that a newly observed instance enters production: its route pin means steps
1–2 are absent by definition. An unchanged identity/probe path may be checked as supporting evidence, but the
verdict remains execution-only. It cannot by itself authorize merge, bounded-live deployment, a `fixed`
claim or branch deletion. A normal adapter-family change uses it as a fast precheck, then uses
`production_route_stage` for both lifecycle validations below. Family-owned discovery/probe and thin
registration are part of a family-local deterministic change when they affect only that family's
instances/edges and leave shared discovery/admission/ranking/resource behavior unchanged. A shared discovery
source, universe-wide admission/cap/ranking rule, central capability, or cross-family cardinality/resource
change is `systemic_live`; one historical route cannot prove that distribution/resource claim.

Manual review chooses the track and may classify a failed check as outside the declared claim. It cannot turn a
machine `fail` into `pass`. A claim may proceed past an out-of-scope failure only when another trusted machine
producer covers every required property of that claim. Identity/probe, quote, plan/size, encoding, final sim,
repayment/conservation, production EV, state/config anchors and safety boundaries are claim-relevant when the
claim names them and are never manually waivable.

### Canonical six-step semantic contract

All route evidence uses one stable, architecture-independent sequence:

1. `discovery_admission_graph`
2. `route_enumeration`
3. `exact_quote_refine`
4. `plan_and_size`
5. `fork_final_sim`
6. `production_ev`

Each ordered stage record has `schema_version`, `profile`, `step`, `stage_id`,
`status=pass|fail|reject|bypassed|not_reached`, canonical input/state anchors,
stage-owned `output` plus `output_sha256`, and optional `metrics` / `extensions`.
Required semantic output is:

- step 1: candidate provenance, identity/admission proof, canonical edge identities and runtime graph membership;
- step 2: canonical ordered route identities emitted by production enumeration;
- step 3: state block/root and exact per-leg input/output, fee and rounding results;
- step 4: canonical plan identity, solver-selected input and resolved per-leg amounts;
- step 5: compiled calldata/script hash, success/revert, gross/net profit, gas, repayment/conservation and
  standing-position result;
- step 6: production valuation inputs, policy inputs, allow/reject, reason and net EV.

Baseline/fix stage advance and equivalence are comparisons over these six records, not a seventh stage.
`family_execution` must truthfully mark steps 1–2 `bypassed`; route pinning must never be relabelled as production
discovery or enumeration. `production_route_stage` must produce the applicable stages without an expected route
or amount entering the production run.

### Canonical state anchor

Every `production_route_stage` receipt binds one lane-aware `StateAnchor`; a block number alone is not an
anchor. The required fields are:

```text
lane
opportunity_block
base_block
base_block_hash
base_state_root
applied_prefix_tx_hashes
trigger_tx_hash
target_tx_index
effective_state_hash
```

The trusted producer/comparator recomputes these values from canonical headers, receipts and the applied
transaction prefix. All six semantic-v4 records bind the same `StateAnchor` hash. The permitted shapes are:

- `block_scan_standing`: opportunity in block `N`, base is canonical `N-1`, with no applied transaction or
  trigger;
- `backrun`: opportunity in block `N`, base is canonical `N-1`, then either the declared trigger-only prefix
  or the complete real prefix before the target is applied in order. The effective state is therefore an
  intermediate state inside `N`, not the untouched parent and not post-entire-`N`;
- `post_block_scan`: a pass built after canonical block `N` for opportunities targeting `N+1` uses `N` as
  its base, with no synthetic prefix.

Wrong-chain same-height state, a reordered/incomplete prefix, a post-winner state, or an anchor that cannot be
recomputed is `infrastructure_missing` or a semantic failure; prose cannot waive it.

### Two-tier six-step lifecycle for deterministic route work

Ordinary adapter-family, quote, plan, encoding and other deterministic route changes use the same six-stage
schema twice. The two runs differ only in lifecycle timing and input strictness; they do not have different
definitions of a stage.

#### Lightweight checkpoint — before merge

The trusted baseline freezes the production-equivalent input snapshot once. Creating that snapshot attests
the active main commit/config/universe and canonical sample state; checkpoint reruns consume the immutable
snapshot and do not require the live process to remain online. Content-addressed DEX and unrelated-family
shards may be reused when their source-closure/config/provenance hashes are unchanged; only the impacted
family shard is recomputed. The assembled materialized graph and completeness vector are always rehashed
before natural enumeration.

The development branch then binds:

- candidate SHA and rollback/base SHA;
- the lane-correct `StateAnchor`;
- complete content-addressed input universe, normalized production config, materialized graph,
  per-shard completeness vector, active-family manifest and their hashes;
- the registry-derived relevant-family completeness proofs; and
- the trusted producer/comparator SHA and output.

Before the candidate run, the controller runs the rollback commit's same target-blind producer against the
same anchor, universe, runtime inputs, normalized config and production caps. Its sealed receipt must fail
before completing step 6 and is content-bound into the checkpoint. A rollback route that already reaches
final EV rejects the checkpoint: a no-op/comment-only or unrelated same-family change cannot borrow an
already-working historical route. Final validation reruns and binds this same rollback failure as well as
the deployed candidate success.
The current controller accepts rollback failure only when the target route is absent from natural output or
is naturally enumerated but not solved. A later solver/final-sim/EV baseline failure needs a typed,
infrastructure-distinguishing domain witness before this gate may accept it; error prose or a transient RPC
failure is rejected.
Both producers bind the actual universe, universe manifest and exact runtime-JSON key/SHA set, rehash those
inputs before and after the hunt, and must match the controller's frozen tuple. This is explicit-input
integrity for normal candidate code, not a same-UID hostile-code sandbox. A scanner `budget_exceeded`,
incomplete natural rank or exact-refinement deadline on either side invalidates the comparison rather than
counting as a baseline miss.
Here `rankComplete` is the legacy receipt name for **production-policy completion** under the exact frozen
caps (including the production DFS/path cap); it does not claim exhaustive enumeration of every graph path.
A route must still appear naturally inside that production-policy output. Therefore a family-local change
that moves a route into the real production top-K is an observable production fix, while this receipt makes
no stronger claim that the graph was exhaustively searched.

Production graph construction and enumeration then run naturally. The candidate producer receives only the
canonical parent anchor, normalized config and content-addressed universe; its argv and allowlisted
environment contain neither the sample transaction nor a reference/expected oracle. Every
`AB_EXPECTED_*`/`HUNT_*` target control is stripped and audited. The producer freezes its complete graph,
shard-completeness vector, natural top-K, resolved hop amounts and raw calldata, then exits. The trusted
controller seals that same-directory artifact with file fsync, atomic rename, read-only permissions and
directory fsync. Only after that durable seal may a rollback/main-owned verifier receive the sample and read
the rollback/main-owned reference under `docs/research/references/production-routes/`. The verifier checks
the target receipt/call-trace hash and lane anchor, matches the normalized frozen route, and interprets the
same finite declarative `ReferenceWitness` against both the target and final-sim traces. The witness binds
ABI signatures, token direction, pool identity where it differs from the execution target, argument
relations, receipt transfers and parent/descendant call structure; a bare target/selector sequence is not
evidence. For final sim, every witnessed root input must additionally byte-match the external calldata
independently compiled from that leg's solver-selected resolved-plan subtree (including the selected amount
and real child bytes). The verifier then resolves the frozen funding
action through the rollback registry, runs the frozen raw calldata on a fresh fork, and independently
recomputes repayment/conservation, standing, profit, production policy and EV. It rehashes both producer and
reference artifacts after verification. The disposable producer worktree omits the checked-out trusted
reference directory, and the rollback verifier worktree is created only after the seal. No expected
route/pools/tokens/amount/calldata or derived selection hint enters the producer. This proves only
explicit-input target-late regression: candidate code can still access repository Git objects and the
archive RPC. Even a sample chosen after candidate SHA freeze does not by itself prove generalization.
That stronger claim requires a future hidden reference plus source-filesystem and source-block-limited RPC
isolation. The controller may have a
larger *outer process timeout* so a development checkpoint does not die while waiting for infrastructure;
production thresholds,
ranking, candidate/top-K/refinement/solve caps, EV policy and ordering remain unchanged. Target append,
force-probe, target-specific warm, reduced graph and fixture-only instance injection invalidate the receipt.
Each physical trace call and receipt log is consumed at most once across the whole ordered route; duplicate
declarative rules or two legs cannot reuse one physical item as two pieces of evidence.

The frozen execution surface also binds each graph edge to one family-owned route-root `ActionAdapter`, the
ordered action-id closure of its resolved subtree and every external call emitted by that subtree. The
trusted controller re-derives ownership from the candidate manifest: the root must be owned by the route
family; descendants may only be owned by that family or be ownerless infra explicitly required by it.
Unattributed direct siblings are accepted only as ownerless, declared support actions. Every external call
they emit is frozen, must be covered by one bounded declarative route witness in the target trace, and must
byte-match in final sim; same-token transfer is not treated as token-preserving. An owned/foreign sibling,
unwitnessed support call, ignored non-wrapper child or ambiguous family-owned multi-node fragment fails
closed until production retains explicit per-leg fragment provenance. A later route leg's root also cannot
be borrowed from a prior leg's descendant subtree. The one family changed by a `family_local` candidate must
occur in the selected route's required-family set; an unrelated mature route cannot validate a new adapter
branch.

The candidate manifest must also keep shared infra globally ownerless. An ActionAdapter that appears in any
family's `requiredInfraActionAdapterIds` cannot simultaneously appear in any family's
`ownedActionAdapterIds`; reclassifying `erc20-transfer`-like infra as a new family's owned route root is a
framework failure, not a family-local extension.
Manifest import closure proves dependency reachability but never grants edit authority. A candidate cannot
newly import and claim a pre-existing central/shared runtime file; new family-owned runtime files are limited
to the family venue/action structural zones, while central registration remains the two explicit thin
surfaces.

Completeness is lane-scoped: the DEX shard and every family shard used by the route must be complete. A
DEX-only route needs the complete DEX discovery/identity/graph proof; a DEX-protocol route additionally needs
the actual protocol family's discovery/probe proof. An unrelated incomplete family is recorded as a typed,
isolated shard in the completeness vector; the graph hash still binds the entire graph that was actually
materialized, but the receipt does not falsely call every family globally complete. Conversely, missing
proof for a family on the naturally produced route is a real step-1 failure.

The gate accepts a request, not a caller-authored pass envelope. It resolves the branch tip, recomputes
universe/config/graph/manifest/producer hashes, derives family ownership from the registry and Git diff, runs
the fixed producer, and computes `status` itself. The controller runs from a clean trusted `origin/main`
checkout and creates a disposable detached worktree at the exact candidate SHA; a feature
candidate that changes the controller, lifecycle validator, semantic evidence schema, family manifest
producer or production replay is tooling/framework work and cannot self-certify through this gate. All six
`production_route_stage` semantic-v4 records bind one
`run_id`, `StateAnchor` and target route; route membership, exact quote, resolved plan, final sim and EV form
one checked hash chain. A route-pinned
Adapter Replay may support steps 3–6 but cannot replace steps 1–2. A successful run emits
`checkpoint_pass`, which authorizes merge to `main` and bounded-live deployment under the existing wallet,
signing, EV, position and broadcast envelope. It does not emit `fixed` or authorize branch deletion.
Existing family root identity is immutable for this classification, supplemental paths derive their token
only from the stable family ID, and the trusted producer/manifest/witness paths are an unconditional deny
prefix set covering their helper families. Renaming a candidate export/action—or staging a same-named family
in an earlier commit—can never grant edit authority over the gate that evaluates it.

#### Full final validation — after merge and deployed-main start

After merge and guarded deployment, rerun the same six steps against:

- the exact candidate merge SHA that is actually running;
- the deployed process's normalized effective config and content-addressed full universe/manifest;
- exact production caps, thresholds, ordering and policy; and
- every mechanically impacted family. A family-local change additionally proves the central behavior
  contract is byte-identical and all unchanged-family source closures are unchanged.

The final controller loads and authenticates the retained checkpoint, reads the committed review artifact,
and independently attests the active process's runtime commit, exact caps, universe/manifest hashes and
sample state through the trusted node boundary before and after the run. Caller-provided runtime env or RPC
URLs are not evidence. `origin/main` may be a report-only descendant that adds the independent review; the
controller must prove no runtime/dependency/config source changed after the deployed merge. The receipt binds `branch_tip`,
`candidate_commit`, `merge_commit`, `deployed_commit`, `rollback_commit`, the
retained pre-merge checkpoint receipt, exact deployment/config/graph receipts, all six stage hashes and a
fresh non-author review.
The deployed commit must be a real two-parent merge: parent 1 is the reviewed integration-base main and
parent 2 is the exact candidate tip. The review binds the candidate patch, parent-1→merge patch,
candidate→merge tree delta and the exact sorted overlap between concurrent main and candidate paths. The
trusted validator recomputes those values and reruns the same family boundary on the actual
parent-1→merge delta. Any overlap still requires function-level human review and both sides' regressions;
an empty Git conflict set or a machine hash is not semantic merge approval.
The exact candidate patch, deployed merge, review-only descendant and ancestry remain bound. The branch
remains present locally and remotely until this run emits `final_validated`.

The final validator may, when resource isolation is required, capture the running A SHA/config/posture,
guardedly pause that single searcher, keep B off, use the local reth/CPU/Anvil exclusively, and restore the
same A SHA/posture afterwards. This is an execution option for final validation, not permission to stop a
searcher during planning or documentation work.

Both checkpoint and final may increase only the outer wrapper wall-clock timeout. That ceiling does not
change any production deadline, graph/candidate/refinement/solve cap, rank, ordering, threshold, EV policy or
safety predicate.

Outcomes are deliberately asymmetric:

- `final_validated`: remove the clean candidate worktree, then the cleanup finalizer exact-deletes the
  retained local/remote branch refs;
- semantic failure: stop or keep the live process only as allowed by the hard safety envelope, perform the
  guarded rollback/revert to the frozen rollback SHA, verify the restored running SHA, and retain the branch
  with the failed stage;
- infrastructure failure: do not relabel it as semantic failure or pass. A safe bounded-live process may
  continue, but the branch stays `pending_final_validation` until the same full validation is rerun.

The currently implemented trusted controller accepts `block_scan_standing` only. A `backrun` request fails
closed until a producer can apply and bind the complete ordered prefix; sender-only or trigger-only
reconstruction is not silently promoted to canonical backrun evidence.

The legacy historical/Hermes harnesses remain useful diagnostic producers. Their nonzero exit does not force
feature-code changes or rollback when the canonical full receipt covers every property of the declared
deterministic claim and the legacy failure is independently shown to be unrelated or a same-fingerprint
harness defect. Wallet/signing, anchor, repayment, conservation, standing-position, exact-SHA and other hard
safety failures are never downgraded. Missing canonical evidence still blocks `final_validated` and cleanup.

#### Family-local boundary

A normal new family is a plugin-sized change: its family implementation, family-owned
identity/discovery/probe, optional low-level `ActionAdapter`, registry declaration and fixtures/tests. It must
not change `main`, shared graph/quoter/planner/solver/coordinator behavior, another family, or the central
capability contract. Registration data is not central behavior.

`family_local` is an evidence claim, not a filename guess: it additionally needs independently frozen
baseline and challenger source-closure sets proving every other family unchanged. When that proof is not
available, the trusted controller conservatively emits `framework`; it never compares the challenger graph
to itself or accepts caller-supplied isolation hashes merely to obtain the lighter label.

The minimum existing capability surface remains compositional: identity/discovery is optional;
`buildEdges` is required; `quoteExact` is required for quote-bearing legs; `buildPlanFragment` is required
for executable legs; `blockScanState` and `victimObservation` are optional capabilities. If a family needs a
new central capability, it is not eligible for this controller today: split it into an explicit framework
change and route it to Hermes A/B with a predeclared cross-family cohort instead of hiding it in a
family-local patch. A future deterministic framework-cohort runner may narrow that requirement, but prose
alone cannot. A future stricter TypeScript interface may improve ergonomics,
but it is not a prerequisite for this lifecycle; the mechanical invariant is an empty central-behavior diff,
not an arbitrary file-count limit.

Evidence may include a namespaced `extensions` object for wall time, counters, ranks, debug text, source
locations or producer-specific telemetry. Extensions are retained for diagnosis but excluded from semantic
equivalence. If latency, rank, counters or resource use is the claim, it belongs to the predeclared
`systemic_live` metric/cohort contract instead of being smuggled into route equivalence.
The same exclusion applies to the top-level `metrics` object; neither `metrics` nor `extensions` can satisfy a
missing core output or turn a failed stage into a pass.

For backrun, “victim/raw input not received” and transition/decode/identity/admission/graph failures are step 1;
for block-scan the corresponding input is the source-block/state anchor. A route whose required edges are
present but is not enumerated fails step 2. State/overlay/exact-quote failure is step 3. Planner, borrowability,
sizing and solver-internal simulations performed before a resolved plan is selected belong to step 4. Step 5
is the independent mandatory fork final simulation after the solver returns a resolved plan. If steps 1–6 all
pass but the opportunity misses the block, the remaining claim is `systemic_live` latency/submission/inclusion,
not a seventh deterministic stage.

The contract binds capability IDs and canonical domain values, not file paths, function names, class layout or
the number of internal modules. Producers may move, split, merge or be registry-dispatched without changing
the evidence meaning. Unknown extension fields are preserved and ignored by semantic comparison; a missing
required core field fails closed. Adding or changing a required core field requires a schema-version bump and
a trusted verifier update independent of the challenger.

Step 4 execution identity is derived from the solver-selected resolved subtree, not copied from the expected
edge. Address-backed families use the resolved node target by default. A singleton vault or manager whose
physical call target differs from its logical venue must declare a family-owned projection from that subtree;
the trusted runner independently compares the projected logical target and optional opaque pool id with the
graph edge. This keeps protocol semantics out of the central runner while preventing two pools behind one
singleton from satisfying each other's witness.

For step 5, only an explicit EVM/domain witness (for example a typed revert or `CALL_EXCEPTION`) may establish a
stable family-owned failure. Timeout, abort, provider/network errors and structured errors with no recognized
domain classification are non-promotable infrastructure evidence. Error prose alone can neither attribute a
failure to a family nor establish a baseline-to-challenger flip.

### `fixed` vs `implemented` (the definition of "fixed")
For a transaction-bound deterministic searcher change (path / pool / decoder / template / planner / adapter / graph):
- `implemented` = code written + build/tests pass.
- `checkpoint_pass` = the same failing sample advances through the target-blind six-stage checkpoint; merge
  and bounded-live main are allowed, but the branch remains.
- **`fixed` / `final_validated` = the same sample passes again against the exact deployed merge SHA,
  normalized production config and attested full production universe/manifest, with the independent review
  bound by a report-only `origin/main` descendant that does not require redeployment.**
  **Build or one local replay is never enough.**

Final Approval MUST record both receipts, or the verdict remains `pending_final_validation` or
`implemented_not_validated` (not `fixed`):
```
failing_sample: / baseline_failure: / candidate_commit: / checkpoint_receipt: /
merge_commit: / deployed_commit: / final_receipt: / expected_transition: /
verdict: final_validated | pending_final_validation | implemented_not_validated | deferred
```
Systemic changes instead record the predeclared cohort identity, positive/negative controls, before/after
coverage/output/resource results, same-block fairness evidence, and reviewer verdict; they do not fabricate
the fields above for an unrelated transaction.
The branch-deletion hook defaults to blocking raw `codex/*` cleanup. For an explicitly human-authorized
non-route branch (for example already accepted observability-only tooling), the operator may set
`MEV_NON_ROUTE_CODEX_CLEANUP=1`; this bypasses only the local accident guard and cannot manufacture
`checkpoint_pass`, `final_validated`, or authorization for a deterministic route branch.
Example `expected_transition`s: graph_gap → `pool_in_routing_graph false→true`; no_candidate_plans →
`candidate_plans>0` (ideally `solverEntered>0`); v4 decode → poolId→token pair emitted; pricing → old
wrong number gone + auditable artifact.

### Backrun causal replay (thin three-state contract)

A backrun fixture is `fixed` only when the trusted harness freezes the same winner/trigger/config/graph and
records all three states:

- `boundary`: untouched parent-block state, with no same-block prefix;
- `trigger_only`: only the selected raw swap/oracle trigger, without nonce/balance rewriting, then the real
  detector → planner → solver → final-sim path; no pre-seeded impact or route;
- `full_prefix`: every real transaction before the winner, followed by the same declared route check.

The gate does not discover or bisect victims. It only requires the candidate stage to advance, the trusted
pipeline replay to pass, and `trigger_only`/`full_prefix` to match on route signature, final-sim result, and
EV-sign bucket. `diverge` or `unverified` means `implemented_not_validated` with
`manual_followup_required`; Hermes must select another trigger or record a multi-transaction dependency and
rerun. A positive `boundary` disqualifies the sample as a causal backrun and sends it to block-scan analysis.
If the change is before the detector (websocket/router/filter intake), `backrun-hunt` alone is insufficient;
a trusted intake-specific harness must also flip. A dust replay may validly end after final sim at
`below_ev_gate`; it need not submit.

### Exempt from replay — gate on before/after METRICS instead
pure latency, builder inclusion, live mempool visibility, external-RPC/network instability, competitive
bid → gate on `prep_ms p50/p95` / `solverEntered` / `pendingReceived` / `cuProxyRpcCalls` / `not_seen`
rate before vs after. A turn with no flippable / speed-up fixture is `turn_class: observability-only`
and does NOT count as improving extraction. **Replay gates the FIX; live dry-run still gates
competitiveness** — never conflate ([[feedback-validate-live-not-backtest]]).

## Evidence producers and supporting harnesses

| gate | command | what it asserts |
|---|---|---|
| deterministic route lifecycle | `npm run six-step-validation-gate -- --request <request.json> --out <generated-receipt.json> --phase checkpoint|final` (from `analysis/`) | trusted controller runs the fixed target-blind producer, recomputes frozen inputs, emits one causally chained semantic-v4 six-stage receipt and binds the exact branch/SHA lifecycle; caller-authored pass envelopes are rejected and `--finalize-cleanup` is final-only. |
| correctness / coverage / path | `npm run searcher:planner` | plan count + `no_candidate` classification (pure, deterministic, no anvil). Pin real cases as named `REPLAY_FIXTURES`. |
| latency / full pipeline | `npm run searcher:replay-live-fixtures` | per-stage `stageMs` p50/p95 (incl. preSolver) + revm profit equivalence (1 wei). Record live first with `SEARCHER_RECORD_LIVE_FIXTURES=1`. |
| quote / math equivalence | `npm run searcher:finaloverlayequiv` / `:curvemath` / `:balanceslots` | local-quote vs on-chain quoter bit-exactness. |
| final verify / bundle safety | `npm run searcher:finalverifygate` / `:bundle-router-safety` | terminal balance-assert flash-repay guard; standing-position rejection. |
| execution-family Adapter Replay (`family_execution`; route-pinned, independent, never deploy-blocking) | `npm run searcher:adapter-family-replay -- --fixture <fixture>` | a trace-bound route contains one registered quote-bearing `RouteLeg` family under test; canonical steps 1–2 are `bypassed`, while production quote, plan/size, encode, fork sim, repayment/conservation and EV satisfy steps 3–6 without fixture amounts, tolerance or calldata. Funding is replay infrastructure, not the subject family. Conservation forbids consuming pre-existing intermediate inventory; positive safety-margin surplus is recorded and conservatively excluded from EV. It does not prove discovery, candidate rank or production stage advance. Emits `adapter_replay_pass`, not `adapter_fixed`. |
| reference arb (Foundry fork) | `forge test --match-test testReplayArbitrage --fork-url $MAINNET_RPC_URL --fork-block-number 24710787` | the wstUSR replay (see `test/WstUSRArb.t.sol`, `test/BotVM.t.sol`). |

## Correctness properties — MUST be test assertions, not prose (the #4 migration)

The reproduction-correctness checks (from the `mev-review` skill, 阶段3) are the properties that should
live as **assertions**, not as prompt rules. Their home is `test/WstUSRArb.t.sol` (+ a future
`test/replay/`) and the searcher harnesses above. Migration is phased (owner: correctness-test epic); a
property still marked *prose-only* is a tracked gap, not "done".

| correctness property | assertion home | status |
|---|---|---|
| trace diff = 0 (replay trace vs on-chain, per-call; every diff explained) | `test/WstUSRArb.t.sol` / `test/replay/` | ⏳ audit per-property; reference arb final-state covered, per-call trace-diff assertion is the gap |
| gas consistency (total + key sub-calls within tolerance) | `test/WstUSRArb.t.sol` | ⏳ prose-only until asserted |
| final-state consistency (touched accounts' balances/slots vs chain) | `test/WstUSRArb.t.sol` | ✅ reference arb asserts profit/final-state; extend to all touched slots |
| numeric precision (rounding direction matches contract logic) | `searcher:curvemath` / `:finaloverlayequiv` | ✅ local-quote bit-exact vs quoter (curve + v3); V4 pending |
| counterfactual (remove X → the diff disappears) | replay fixture per finding | ⏳ prose-only; encode as a paired before/after fixture |

**Rule:** when adding a new correctness/coverage rule, first ask *"can this be an assertion here?"* — if
yes, write the assertion and do NOT add the prose rule (distill-kit sunset doctrine). Only irreducibly
**judgment/process** doctrine (dual-blind, frame-audit, null-round, epic-escalation) stays as prose in
`docs/research/HERMES.md` — those have no single "correct" answer to assert.

## A/B canary gate — mechanical veto, never merge authority

`analysis/src/cli/ab-canary-compare.ts` pairs A/B by exact block and emits facts plus only
`supports | contradicts | inconclusive`. It never emits `win`. `ab-canary-gate` validates the report's
thin `ab_experiment` journal:
- exact tested commits; normalized config and universe fairness; same-block sample; no measured-window
  restarts; one pinned startup-discovery block; stable runtime pool-view and TokenEdge graph hashes
  (unless a graph delta was explicitly predeclared and replay-proven); B stopped; real script
  artifact/exit status;
- budget-censored, full-warm, and catch-up-range blocks are excluded before warmup/pairing because they do
  not share equivalent cache history; exact solved-ring identities remain part of semantic output matching;
- identical-code infrastructure shakedowns use the explicit equivalence goal; they never cherry-pick a
  noisy latency direction to manufacture a verdict;
- schema-v3 decision/close records bind a write-once standalone manual-verdict artifact by SHA-256 into the
  comparator output. The artifact seals the exact A/B log hashes and byte counts; the comparator must bind
  the same hashes plus seal nonce and start later than the artifact. Timestamps typed into prose or a seal for
  different log bytes cannot satisfy the gate;
- the predeclared hypothesis-specific deterministic/cohort check passes before any correctness/capability
  win; only route-stage/equivalence claims require the pinned single-route replay;
- agent-manual evidence written independently; a distinct fresh reviewer for every capability win and
  every manual/script conflict or inconclusive result;
- branch lifecycle: decisive win/lose may clean only literal `ab/*`. A retained route-stage/equivalence
  report can later use a main-committed resolution claim, its unchanged report-owned replay, and
  `ab-resolution-sweep -- --apply`. A retained systemic report instead requires a fresh normal A/B retest of
  its original cohort contract; it cannot be deleted through a fabricated route replay.
- external comparator calibration: the pinned coffee corpus must still separate source shape from
  position-conserving winner style; `hermes-gate` reruns it and rejects an A/B close on classifier drift.

The agent's causal judgment owns `win|lose|needs_escalation`. A raw metric can contradict a valid semantic
fix (for example, filtering a high-scoring honeypot); in that case a fresh reviewer may confirm the win.
Hard safety/correctness/fairness failures can only veto or escalate. They cannot create a win.

### Legacy optional A/B six-step diagnostic (schema v3)

`deploy-ab-challenger.sh deploy` does **not** invoke or wait for historical replay. It runs only the fast
`--phase binding` check (report/experiment/branch/base/challenger/input/config/lane identity) plus the hard
bounded-live safety/fairness preflight, then starts B. If the predeclared hypothesis is a route-stage or
equivalence claim, pause B after the paired live window and optionally run
`deploy-ab-challenger.sh acceptance <id>`. This invokes the legacy-named `ab-canary-gate --phase acceptance`
checker from trusted tooling against the frozen A/B commits and immutable universes. The status
`not_run|running|pass|fail|not_applicable` is diagnostic evidence for that claim only; it is never a deploy, decision, close, or
promotion switch **inside the legacy A/B lifecycle**. It is not the canonical checkpoint/final validator
defined above and cannot issue `checkpoint_pass` or `final_validated`. Scanner, universe, distribution, and
performance changes use their own predeclared A/B criteria.
The check may use the latest report/JSON-only descendant of the frozen B SHA and the then-current trusted
`origin/main` checker (which must descend from A and retain dependency compatibility). Therefore correcting
an acceptance report or external checker never requires a new B deployment or another warmup. A
runtime-coupled hunt-harness change still needs an explicitly compatible harness.

When invoked, the six-step check requires a fully populated `production_evidence` object proving:

- `analysis.tool_selection` records a successful generated catalog check, the capability query made only
  after independent manual analysis, successfully executed tool IDs, and a machine execution-manifest path
  + SHA-256. Every receipt binds the current descriptor fingerprint, redacted argv hash, output hashes/byte
  counts, timestamps, and real exit code; live-window tools must bind the exact measured range. Acceptance
  evidence must cover single-transaction causality/PnL plus competitor-window classification/block-scan.
  Decision/close independently require the common competitor-window/classification/block-scan and A/B
  comparison capabilities plus whatever the hypothesis predeclared; they do not inherit the optional
  acceptance check's single-transaction/causality/PnL requirements. The checker validates successful receipt capability
  union from the current generated inventory, never a fixed executable name, fixture-only substitute, or
  self-reported command;

- a real on-chain transaction whose successful receipt, block, positive net PnL and canonical
  `winner_style=atomic_loop` are recomputed from the champion's configured private archive endpoint during
  acceptance. This endpoint is evidence-only; both live A/B runtimes remain pinned to the same local reth.
  Block-scan requires
  `source_shape=atomic_state_arb`; dual backrun additionally verifies its declared earlier victim and exact
  pre/post counterfactual;
- a fresh non-author classification review confirming the sample is in scope;
- current strategy scope: position-conserving `dex-dex` or `dex-permissionless-protocol`, with either
  `block-scan`/`standing-state` or dual `backrun`/`victim-swap|oracle-update`;
- every new production Hermes candidate declares `lane_mode=dual`: A/B observe atomic block-scan and
  public-mempool backrun concurrently (MEV-Share off). The single B behavior change and replay sample may
  belong to either lane; the other lane is a no-regression/safety observation, not a second required win;
- no keeper/reward, inventory, private path, credit, sandwich, or JIT-LP posture; victim dependency is valid
  only for the declared, replay-proven dual backrun;
- `searcher_behavior_change=true`, `deterministic_gate.result=pass`, and the trusted, unchanged
  trusted hunt harness invoked directly by Node (not through challenger npm configuration). The wrapper runs
  `blockscan-hunt.ts` from the untouched sample parent block and `backrun-hunt.ts` across the exact
  boundary/trigger-only/full-prefix states,
  with the same frozen universe. The verifier retains the sample's expected pool/route identity outside the
  production process and compares it only after output is frozen. Harness/test/fixture changes in B are
  forbidden. The measured A/B canonical stage records, not a challenger-authored success string, must show the
  same sample advances past its declared first failing stage. A backrun
  `final_sim_success` additionally requires trigger-only and full-prefix route/sim/EV buckets to match, the
  full-prefix route transaction to land at the winner index, and no historical sender balance/nonce rewrite;
  oracle victims require an
  independent trusted quote delta on the declared route edge. A later quote-only or submit-only stage
  requires its own trusted harness before it may satisfy acceptance.

Block-scan now emits the canonical semantic schema directly. Backrun retains read compatibility with its
legacy diagnostics until its trigger-only/full-prefix producer is migrated; the verifier must not relabel the
legacy slots as canonical plan/sim/EV evidence. Once migrated, lane-specific facts such as a raw trigger,
trigger-only/full-prefix anchors and counterfactual quote belong in the canonical input/state anchors and
stage-owned fields; they do not renumber or replace the six stages. Trigger-only/full-prefix equivalence is
then a comparison over the complete six-stage records, not a backrun-specific sixth-stage meaning.
For a stage-advance change the challenger must emit the ordered diagnostics through its declared stage and the baseline must fail at its
declared stage; for an equivalence refactor both sides must emit one ordered `pass` result for steps 1..6.
The canonical human evidence contract remains `.claude/commands/tx-gap.md`.

Inside the optional checker, `require_stage_advance` is a narrow, fail-closed switch for equivalence
refactors. It defaults to `true` when absent. An explicitly reviewed report may set it to `false`; this
disables only the `challenger_stage > baseline_stage` assertion in that check. It is read only when
`acceptance <id>` runs and cannot block deployment. Wallet, port, runtime, lane and posture protections are
independent hard boundaries.

This legacy checker is diagnostic and cannot block starting a bounded-live B or an unrelated
`systemic_live` cohort/A-B decision. A nonzero result remains recorded with its exact failed stage and logs;
manual review may classify it as outside the declared track or as a suspected gate/harness defect and continue
the dry-run/diagnosis. It may not rewrite the result or satisfy a required stage. If the failed predicate belongs
to the claimed track, repair the trusted producer/verifier and add its regression, or supply another independently
trusted machine producer for the same predicate, then rerun before promotion or a `fixed` verdict.
Wallet/signing/broadcast posture, target SHA, port/process stability, shared-input fairness and the other hard
safety boundaries remain non-overridable.

Only this legacy `require_stage_advance=false` equivalence replay receives the closed-loop search budget:
the already-frozen A/B universe is reused, at most 20,000 pools are loaded, 512 coarse candidates may be
exact-refined, the final admitted set may extend through rank 300, and scan/pass budgets are 600/1,200 seconds.
The expected route may be compared only after each side's production enumeration and solve output is frozen. It
must not be supplied to enumeration, pruning, ranking, candidate retention, top-K or solve-set selection. If the
route is outside the naturally selected solve set, the stage is `not_reached`; the checker must not append or
force-probe it. Shared-input runs first require byte-identical universe snapshots, and the report must declare
the 3,600-second per-side timeout.
Standalone historical repair, ordinary stage-advance acceptance, and live searcher defaults keep their
production-shaped limits. These widened values are acceptance-only and never change live searcher defaults.

### Strict blind timing sentinel for the universal AdapterFamily refactor

The universal AdapterFamily/block-scan-state refactor additionally pins
`0x02a8b803ed975ebc944d61a218c9438f5ae62615969434046a5d53ab4d1966af` as a mandatory,
target-blind six-stage timing sentinel. It is a task-specific merge/acceptance contract chosen by the user,
not a deploy-start switch and not a substitute for the systemic cohort/paired A/B contract.

Its producer receives only source block `25599789` (hash
`0xbdaf5f6640f784373f4e6d644e27dd447f0914db43affbe2f9bc16f7e5bb062a`, state root
`0xdffdabeabb966c54a3023f332531c0d384d884034a5569318723e621cdf1808e`), the complete
content-addressed production universe/config/active-family manifest, the normal production policy, backend
and output path. It must not receive the winner hash, expected route/pools/tokens/factory, amount, rank,
search center or calldata. An independently sealed receipt/call-trace oracle is visible only to a trusted
post-run comparator after producer output is immutable. The producer runs with repository `.env` loading
disabled or from a clean working directory without that file; after every config loader completes, the
normalized effective config is sealed and checked again. Clearing only the parent shell environment is not
evidence of isolation.

The current expected-route acceptance path does **not** satisfy this profile: `AB_EXPECTED_*`, expected-pool
inputs, top-K target append, acceptance-only candidate/rank widening, forced probes/selections, fixture
preload, target pin/force-include, target-specific warm or a reduced graph invalidate the result. The target
must naturally enter production admission, enumeration, refinement and solve limits; failure to do so is a
real failed stage, not permission to append it. An early threshold/rank drop cannot stand in for final sim
and EV in this strict profile. The solver chooses amounts and the production compiler creates calldata.
Acceptance-only changes to min-spread/EV, candidate/rank caps or deadlines are forbidden; a real production
parameter change requires its own candidate-distribution, resource and paired A/B evidence.

All six canonical semantic stages emit monotonic `stage_ms` and `cumulative_ms` extensions, timed from
`source_head_seen` before runtime preparation through the production EV decision. Their machine boundaries
are `state_ready`, `enumeration_done`, `exact_refine_done`, `planner_solver_done`, `final_sim_done` and
`ev_decision`; boundary names and timing fields are producer telemetry, not alternate stage meanings or semantic
equivalence fields. Every boundary is mandatory, but there are no target-tuned per-stage pass budgets. The only
hard timing gate is steady-process/fresh-source-state p95 `<10,000ms` end to end. If it misses, retain the
real breakdown and report `implemented_not_validated`; never reduce the graph, reuse target dynamic caches,
force a candidate or loosen production policy to manufacture a pass.

Semantic and timing verdicts are recorded independently, so `semantic_status=pass` with
`timing_status=fail` is a valid honest intermediate result. After the profile freezes, do not select a
favorable window/percentile, move timer boundaries, keep only the fastest warm blocks or discard slow
"outliers". A human may approve a new target for a later run after reviewing the evidence; it never
retroactively converts the failed run into a pass.

At least 20 measured runs retain every result. Process startup and one-time historical data download are
recorded but excluded from the hot-path timer. Before the first run, the manifest commits an exact
`run_count >= 20`, seeded interleaved A/B order, nearest-rank
`p95 = sorted[ceil(0.95*n)-1]` algorithm and timeout accounting. Every attempted run remains in the report;
do not add fast runs after seeing the result. Additional runs form a new experiment. Static
schema/decimals/codehash/call-descriptor caches may be warm, but each run restores the same sealed N-1
input, clears or generation-bumps every N-dependent state/mid/refine/amount/plan/sim/EV cache, resets its
clean fork and rechecks the pre-state root. Fresh current-N reads/batches and cache-generation counters are
recorded on every run; target-specific prewarming and reuse of a prior run's N result are forbidden.

For this sentinel, the production base topology completeness watermark is `25599788`; processing its
current-block delta to source N=`25599789` is inside the timer. A universe already prebuilt through N can
diagnose route/state behavior but cannot pass the strict full-pipeline timing profile. The runner wraps the
actual production entry and deployment config resolver, rather than copying pipeline logic, and its manifest
binds the production-entry SHA, generic universe-builder SHA/range/input hashes, independently rebuilt
universe hash, normalized config, active manifest, backend, state root and outputs. Outside the timer the
harness may only clean up and restore N-1; `forkAt(N)`, any source-N snapshot/sync/pre-state materialization
and all production per-head backend preparation start after `source_head_seen`.

The normalized config is the effective resolved-config dump captured from the current standard live A after
all environment/config loaders, not source-code fallback defaults. Its capture hash binds universe top-N/view
limits, candidate/refine/solve caps, deadlines, concurrency, active manifest and universe-builder inputs/hash.
Baseline and challenger use byte-identical values except declared historical source/backend substitutions and
predeclared activation additions. The common baseline-active manifest remains byte-identical; the challenger
addition manifest is separately sealed.
Secret values never enter the report; bind only redacted provider class/endpoint identity and a
secret-presence hash.

Before timing, only the N-1 base expected sets are sealed. The producer consumes N delta inside the timer and
builds `GraphView(N)` without an expected-N hint. A trusted independent builder may privately construct N's
exact `expected_required_state_keys` and `expected_priced_edges` hashes, but the comparator reveals them only
after producer output is immutable. `state_ready` is valid only after every production-required key in
GraphView(N) is resolved at N and atomically published with the expected coverage hash.
Timeout/unresolved/incomplete in any slow family remains a failed full-profile run; it may be reported as a
degraded diagnostic but cannot make the effective pricing graph smaller and still pass.

An EV `reject` may be the correct decision for this sample. A passing sixth-stage record is
`execution_status=pass` plus independently reproduced `decision=allow|reject` and `decision_reason`; it
does not force submission. A `bypassed/not_reached` stage is a correctness failure in this strict
`production_route_stage` profile and remains in the report.

Pure refactors require exact ordered edge identity, metadata/ownership, funding-provider, action-encoder and
resolved-state coverage parity. A predeclared activation may add edges but may not delete baseline edges;
semantic parity is evaluated on the common baseline-active manifest. Activation additions are reported
separately, never credited as speedup, and their full runtime cost remains in challenger timing. The trusted producer/comparator and
fixture must land on main before the challenger freezes and cannot appear in its diff. The challenger
production-closure diff must add no sentinel tx/block hash/state root, target pools/poolId/tokens, landed
amounts, calldata, `25599788/25599789/25599790`, landed tx index `68`, or encoded/derived fixture-metadata
conditions. A pre-existing generic production pin may remain unchanged only after explicit review.
Fixture/force/static instance seeds cannot be the sole admission evidence for a target venue. After
challenger freeze, the same trusted runner also executes undisclosed neighboring/held-out block controls;
fixture-metadata branching is a failure.

An approved removal of a baseline-active semantic is a separate product/coverage deactivation change, not an
activation delta inside this equivalence/performance gate. It cannot receive an equivalence verdict and its
edge reduction cannot be credited as a resource or latency improvement. Any later refactor comparison keeps
the same non-reduced baseline-active manifest on both sides.

Paired live uses the same production policy and exact-block denominator, but each side runs its own actually
deployed complete manifest: baseline runs the baseline manifest; challenger runs baseline plus every declared
addition. Addition costs remain in challenger latency/resource accounting while their output gains remain a
separate activation delta. After warm/catch-up and before inspecting outcomes, the exact eligible paired-block
hashes/range are frozen as the denominator. Every block must produce either `scanner_done(no_candidate)` or
`block_ev_done(candidate)` within 10 seconds.
`skipped_busy`, timeout, incomplete and missing terminal remain failed samples in that denominator;
candidate/no-candidate classification cannot be decided by selecting only blocks that finished. The
historical sentinel remains necessary but cannot substitute for this live timing evidence.

This sentinel is necessary, not sufficient: it covers a UniV3/V4 route and the critical path, not every
Curve/DODO/receipt/flash family. Full-family conformance, positive/negative cohort output equivalence,
same-input resource metrics and paired live A/B remain required for the systemic refactor.

### Held-out conversion update-block freshness sentinel

The universal AdapterFamily/state-coordinator refactor also requires one real conversion-lane update-block
sentinel. This closes a gap that tx02 cannot cover: proving that current-block protocol rates are actually
observed instead of merely declaring that dynamic mids have no TTL.

Before challenger freeze, the trusted runner publishes and seals the chain range, eligibility
predicate/version, `minEligibleCardinality >= 32` and deterministic selection algorithm. A root-only trusted
oracle retains `secretSeed + salt` and publishes only
`SHA256(secretSeed || salt || rangeHash || predicateHash)`. After freeze it reveals seed/salt, verifies the
commitment and resolves one real ERC4626 donation/harvest/loss or wstETH oracle-report source block N under
the sealed algorithm. Too few eligible samples or no qualifying sample yields
`freshness_evidence=missing`; the challenger must not be able to enumerate a tiny set or choose a sample after
inspecting output.

Eligibility requires the trusted reference's natural candidate to reach all six canonical production stages and
excludes updates that also touch the target active DEX/routes. If that exclusion cannot prove isolation, the
trusted oracle supplies a fixed-boundary causal pair: the same prefix immediately before/after the update, or
fixed N state with only the conversion update reverted. Removing the conversion update must remove the target
mid/candidate delta. This oracle-only counterfactual remains hidden from the producer; the synthetic-state
ban below applies to the tested producer, not to this independent causal proof.

Baseline and challenger each wrap the real production-entry closure from their own frozen SHA. Byte identity
applies to the sealed N-1 base, source N, current live A normalized effective config except declared activation
additions, universe, common baseline-active manifest, backend and output schema; the challenger addition
manifest is separately sealed and included in its complete graph. For each side,
the N-1 control and N measured run use the same static-cache snapshot but independent generations/clean forks,
with dynamic state/mid/refine/amount/plan/sim/EV caches reset. The N-1 control cannot become target-specific
prewarming for N. Each side runs N delta and all current-N state reads inside the N timer and seals full-graph
N-1/N mids, candidates/ranks, exact quotes, plan/final-sim and EV raw outputs before the trusted comparator
reveals the oracle.

A pass requires natural family admission, a fresh N stateKey read, same-block `deriveMids` change, the
causally isolated oracle-predicted candidate/rank delta, all six canonical production stages for that natural
candidate, and same-input baseline/challenger output and resource differences within the declared A/B
contract. Producer-side synthetic state overrides, target prewarming, fixture/route injection, candidate
append, graph reduction, TTL fallback and acceptance-only policy changes invalidate the result. A synthetic
fixture or a claim that the code "should refresh" cannot pass.

This is a conversion-lane sentinel only. Curve/DODO/external-swap current-N behavior still requires its
family cohort, fork fixtures and paired-live coverage.

Full-family conformance separately invokes every active `deriveMids` with a valid sealed snapshot while all
provider/backend/call entrances are poisoned to count and throw; any I/O or nonzero counter fails. It also
asserts one coordinator scheduling identity per generation/stateKey. Registry-derived AST/import-closure
checks cover shared orchestration/consumer surfaces rather than using a literal grep; registry-owned family
modules and low-level ActionAdapters are excluded so their legitimate protocol IDs and ABIs are not
misclassified as shared-code branches. A family production module over 200 LOC requires a recorded
framework/duplication review; LOC is a review trigger, never a correctness shortcut or standalone failure.
Separately, this refactor requires one Eigenpie before/after pressure-test report as a one-time framework
completion check, regardless of any individual module's LOC.

The trusted deploy wrapper's fast binding checks the report against the requested experiment, branch, tested base, frozen
challenger code SHA, input mode, runtime-view declaration, and cheap static bounded-live scope/posture fields.
It performs no archive lookup, tool discovery, historical classification or replay. Candidate config deltas are forbidden. The
branch tip may advance beyond the code SHA only through the named report; the wrapper deploys the code SHA,
not that report tip. It requires a deployable listener runtime diff (tests and
fixtures do not count and may not change) and rejects analysis, governance, dependency-script, or runner changes in the
challenger diff. Tool corrections are same-round auxiliary work: fix, review, merge to trusted main, and
rerun the optional acceptance when relevant; they may land after the B window without changing or redeploying B, and never
count as the B variable.
Historical schema-v1/v2 reports remain readable; only schema-v3 can pass new deployment binding or invoke
the optional six-step checker.

## Historical transaction repair gate

`docs/research/HISTORICAL-GAP.md` is the non-live entry to this same validation contract. New deterministic
family/route work uses `six-step-validation-gate`:

- analysis tools/classifiers/gates: build, regression tests and fresh review, then direct-to-main without B;
- `family_execution` uses route-pinned Family/Adapter Replay and conformance/isolation as a supporting
  steps-3–6 precheck. It cannot promote or clean up a branch;
- `production_route_stage` uses all six stages twice: `checkpoint_pass` before merge and
  `final_validated` against the exact deployed merge SHA before cleanup. A report-only review descendant
  does not require redeploying identical runtime code. No expected route/amount enters the
  producer;
- systemic scanner/graph/universe work uses its predeclared cohort/coverage/equivalence contract and proceeds
  to the paired Hermes A/B window instead of this deterministic lifecycle;
- flow admission, latency and candidate ranking: historical evidence may classify the gap, but merge authority is
  rejected and the branch routes to Hermes A/B.

`historical-gap-gate` remains a legacy report reader and supporting replay/conformance runner. It is not the
new deterministic family promotion/cleanup authority.

The direct-main gate surface includes only `analysis/src` implementation files, same-named analysis tests,
script-only changes to `analysis/package.json`, archived report artifacts, and the exact trusted
`blockscan-hunt.ts` / `backrun-hunt.ts` replay harnesses. Fixtures, dependencies/lockfiles, lifecycle scripts,
governance documents, hooks, deploy/guard scripts and arbitrary listener tests remain ineligible.

The only accepted samples are position-conserving `DEX↔DEX` or `DEX↔permissionless protocol` closed loops,
from either scanner standing state or a real swap/oracle backrun trigger. Every sample binds one complete
ordered route (`adapterId`, `slotKind`, `target`, `tokenIn`, `tokenOut`, optional `poolId`) to canonical
on-chain swap order/direction, factory-backed V2/V3 venue identity, and one successful state-changing call
trace that matches every DEX and protocol leg in the declared interleaved order. A hash-bound, finite
reference-witness declaration supplies ABI signatures, exact empty-calldata value calls and relational
token/call constraints; the trusted
interpreter rejects arbitrary code, family-name branches and bare `target+selector` protocol matches. Swap
direction remains independently bound by receipt-level family observation. For every leg, the landed root
selector must also equal the selector independently decoded from the solver-selected final resolved-plan
subtree compiled with its real child bytes and selected amount; final-sim calldata must match that resolved
plan byte-for-byte. A probe-time fragment or challenger-authored permissive `matchTrace` cannot create the binding. Protocol token flow and the exact
trusted replay route are checked separately. A protocol target equal to
the winner's private caller/executor is rejected; pool-set membership alone is insufficient. Build/test
without sample replay is
always `implemented_not_validated`. Before a new searcher branch is accepted, the gate binds an inventory of
main, all local heads/tags/stash/custom refs, all refs from every configured remote, worktrees, durable
reports/resolutions and local uncommitted evidence so a
prior unmerged fix is inspected rather than duplicated. Every entry requires an exact fingerprint and an
explicit resolved disposition; remote-only objects are fetched temporarily for same-gap inspection. A
reportless ref/worktree that overlaps a candidate runtime path cannot be dismissed as unrelated; it must be
reused, superseded or left blocking. A
family-local candidate may contain its implementation, family-owned identity/discovery/probe, optional
low-level action encoder, thin registration and fixtures/tests. It may not change trusted validation
producers/runners or shared central behavior. Framework changes declare that scope explicitly; mixed
orchestration owners affecting intake, ranking, caps, thresholds, budgets, deadlines, concurrency or latency
route to Hermes regardless of identifier names.
The non-author review separately attests that an allowlisted diff contains no cross-opportunity intake,
ordering, cardinality, timing or resource-budget change. The report binds that review to the exact base,
challenger and Git-patch SHA-256 and the gate requires the separate committed review artifact. Historical
replay also binds the exact production pool-universe snapshot/top-N to a provenance artifact and independently
attests the active champion's runtime commit, content-addressed path, hash and top-N through SSM before and
after replay/smoke. It also attests the active champion's local-reth chain ID, exact winner/trigger receipts
and parent block hashes. It rejects caller RPC/WS endpoints and creates SSM loopback tunnels to the exact
HTTP/WS ports read from that champion process. A tunnel is accepted only after the gate-owned Session Manager
child reports ownership of that exact local port and the port answers; identical facts are checked before and after the run.
Caller-provided paths, endpoints or top-N cannot establish production equivalence.
The short smoke uses
a disposable signer and never receives a production private key. It proves full-duration process liveness,
not lane activity from challenger-authored stdout; unchanged replay gates provide the lane capability proof.
A historical causal backrun fixture does not prove public/private network propagation. Any visibility or
source-intake claim is flow-admission work and routes to Hermes.

The lifecycle envelope binds the candidate/rollback branch identity, lane-aware state anchor, complete
universe/config/graph/family manifest, registry-derived family scope, six semantic records and trusted
producer/comparator hashes. Final evidence additionally binds merge/deployed SHA, deployment/config receipts
and fresh non-author review. The finalizer revalidates Git ancestry and exact refs; raw branch/update-ref/
remote-delete commands are blocked by the hook as an accidental-misuse defense, not as cleanup
authorization. There is no replayable marker; the finalizer's just-generated receipt plus exact-ref lease is
the authority. Remove a clean candidate
worktree, then invoke the finalizer from another checkout. `checkpoint_pass` may merge/deploy but cannot
delete. A true semantic failure rolls back and retains the branch; infrastructure failure retains it for
rerun. Hermes-routed work emits no six-step lifecycle cleanup receipt and closes through the A/B gate.
