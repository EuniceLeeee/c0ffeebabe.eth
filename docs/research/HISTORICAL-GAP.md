# Historical Gap Repair — pinned transactions without a live research window

Use this runbook when a bounded set of landed historical transactions already identifies a plausible
searcher gap. It is the non-live companion to `HERMES.md`: history proves deterministic capability;
Hermes A/B proves changes whose value depends on live opportunity distribution.

## Scope

Only the current production target is admissible:

- scanner source: victim-independent, position-conserving `DEX↔DEX` or
  `DEX↔permissionless protocol` closed atomic loops at standing state;
- backrun source: position-conserving closed atomic loops caused by one real earlier landed swap or
  oracle-update transaction, with boundary / trigger-only / full-prefix causal replay;
- canonical net PnL must be positive.

Backrun remains valid analysis scope. Its production-gap receipt must bind the complete ordered prefix and
one canonical state anchor; if that evidence is missing, record `implemented_not_validated` and use causal
replay/Hermes rather than weakening the core judgment.

Exclude inventory, keeper/reward, credit, sandwich, JIT-LP, private paths/vaults and any route that leaves
a standing position. A transaction may execute atomically and still be a backrun; its source is decided by
the causal replay, not by the word `atomic` or by its bundle container.

## Promotion Matrix

| Change | Required evidence | Destination |
|---|---|---|
| analysis tool, classifier, gate | build + regression tests + fresh non-author review | merge directly to `main`; never deploy as B |
| `family_execution`: quote-bearing `RouteLeg` family-owned identity/edge, quote, plan/size or execution semantics | stable baseline→candidate Family/Adapter Replay flip, exact family coverage, conformance/isolation and `family_local` boundary | `adapter_merge_ready`; may merge only the family-owned diff, but does not claim production discovery |
| `production_route_stage`: a deterministic route should advance through the production funnel | one target-blind natural six-stage chain with solver sizing, mandatory final sim and positive production EV | `production_gap_fixed`; no branch cleanup or deployment side effect |
| systemic protocol scanner, graph/universe construction, coverage or cross-opportunity distribution/performance | predeclared positive/negative cohort, coverage and output contract, then same-input fairness/resource evidence | route to `HERMES.md`; no per-sample candidate or single-route stage flip |
| flow admission, latency, candidate ranking | pinned replay where applicable, then full Hermes A/B | route to `HERMES.md`; history alone cannot promote |
| build/test only | `implemented_not_validated` | retain; never claim fixed |

## Three tracks, Adapter Replay and Production Replay

Historical work has exactly three claim tracks: `family_execution`, `production_route_stage` and
`systemic_live`. In the schema-v1 historical report these map, without reinterpreting old records, to
component/validation keys `family-execution`, `historical-replay` and `hermes-ab` respectively.
The first two use the same canonical six-stage evidence schema from `gates.md`; the third uses a predeclared
cohort plus Hermes A/B. Do not split adapter execution and solver sizing into separate success verdicts.

| Validation level | Supplied by the fixture | Must be produced by production code | Verdict |
|---|---|---|---|
| **Family/Adapter Replay (`family_execution`)** | The subject quote-bearing `RouteLeg` `ExecutionFamilyId` plus the complete ordered route recovered from the landed trace: route-leg adapter identity, target or pool id, token direction, finite reference-witness rules and lane-correct state anchor. Funding is replay infrastructure, not the subject. | Steps 1–2 explicitly `bypassed`; registry-validated family edges, exact quotes, production planner/solver-selected input amount, encoding, fork final simulation, flash repayment, token conservation and EV satisfy canonical steps 3–6. The baseline miss/failure reproduces and the challenger flips. | `adapter_fixed`; with exact conformance/ownership and `family_local`, `adapter_merge_ready` |
| **Production Replay (`production_route_stage`)** | Only the historical transaction and its lane-correct state anchor. The trace-derived expected route is retained by the verifier and withheld from the production producer until its output is frozen; no amount is supplied. | Discovery/admission/graph, route enumeration, exact quote/refine, plan/size, encoding/fork final simulation, repayment/conservation and production EV satisfy one causal canonical chain across steps 1–6. | `production_gap_fixed` |
| **Systemic cohort (`systemic_live`)** | A predeclared positive/negative cohort and the one behavior variable under test. | Coverage/output, same-input fairness, candidate composition, false-positive and resource/performance evidence over the cohort. | Hermes `win|lose|needs_escalation` |

Adapter Replay deliberately bypasses active-pool admission and scanner/backrun discovery so one deterministic
adapter can be validated and merged without being blocked by a separate universe or detector gap. It may pin
the trace-proven route, but it must not inject realized per-leg amounts, quotes, encoded actions, calldata or a
prebuilt plan. Landed amounts are diagnostic references only. The unchanged production planner and solver must
compose the plan and choose a profitable input amount themselves; if the route executes only when the landed
amount is forced, the Adapter Replay fails.
The fixture's landed-profit label qualifies the sample for review but does not establish the execution verdict:
the decisive positive-EV proof is the independent production quote → solve → final-sim → EV replay at the
hash-bound state anchor.

Use the parent block state for a standing block-scan sample. Use the exact trigger-only or full-prefix state for a
backrun sample. A successful Adapter Replay does not claim that production can discover the transaction; only
Production Replay may make that claim. For backrun fixtures the trigger hash must also be present in the
hash-bound classification evidence; Adapter Replay verifies execution at that post-trigger anchor, while
counterfactual trigger causality remains a Production Replay responsibility.

The validation unit is an execution family, not a protocol brand. Multiple protocols or pool instances may
share one family when their quote and execution semantics are identical; registering a new instance does not
create a new adapter verdict. Conversely, a protocol with two execution semantics needs two family fixtures.
That verdict proves execution conformance only and cannot prove a newly observed instance enters production.
Automatic instance intake additionally requires the
family-appropriate identity contract: dynamic protocols declare candidate/evidence matchers plus identity and
probe; swaps provide observation and an identity resolver over the DEX universe; infrastructure singletons use
attested `declaredVenues`. A compat adapter supplies none of those promises. Registering quote/plan code alone
therefore never means that new pools will be discovered automatically.
The standalone command is `npm run searcher:adapter-family-replay -- --fixture <fixture>`. Its raw pass proves
route-pinned execution. The core judgment additionally requires the stable baseline flip, exact family
coverage/conformance and `family_local` receipt before emitting `adapter_merge_ready`. It never claims
production discovery or performs deployment/cleanup.

Adapter Replay is always route-pinned equivalence evidence; it makes no claim about production candidate rank,
top-K admission or scanner stage advance. Those claims require Production Replay with no expected route fed to
discovery, graph construction, enumeration, pruning, ranking, candidate retention or solve selection. The
expected route is an output-only oracle: after production output is frozen, the verifier may compare its complete
ordered identity. If the route is not naturally enumerated or selected, the corresponding stage fails or is
`not_reached`; the verifier may not append it to a solve set or force-probe it. The fixture schema has no
rounding/tolerance override: token rounding remains adapter-owned.
Fluid DEX is still the explicit legacy execution switch and is absent from family coverage until a Fluid-specific
fixture passes; moving that switch into a family would not, by itself, discover any additional Fluid instance.
An Adapter Replay failure may be manually triaged as a gate/harness defect and retained as diagnostic evidence,
but it cannot be relabelled `adapter_replay_pass`. A failed harness does not force production code changes
when another trusted producer covers the same predicate and a fresh review proves the failure is a harness
defect; hard safety predicates are never waived.

Every successful Adapter Replay writes a compact, redacted supporting receipt containing the transaction hash, ordered
route hash, reference-trace route hash, state block and state root, base and adapter commit, execution-family
registry-derived contract fingerprint, runtime-source hash, shared adapter API hash, compiled BotVM
artifact/runtime hash,
solver-selected amount, final-sim gross profit, production-EV result, harness hash and replay command. Raw RPC
logs remain gitignored. A later Production Replay may reuse this receipt only as diagnostic input when the adapter
commit is an ancestor and all recorded code/input hashes still match; it still re-executes all six production
stages. A change to that adapter or the shared planner/solver/quote/encode API invalidates
the receipt. The current runtime-source digest is deliberately conservative and also invalidates on
an unrelated production-runtime source change; rerun the deterministic replay rather than treating that
conservative invalidation as a semantic failure.
The runner derives the family contract fingerprint from the live registry descriptor and separately binds all
runtime sources; it has no per-family source-file table to update when a family is added, moved or split.

An adapter-only challenger may modify only family-owned implementation files plus the thin production
registration surfaces accepted by the mechanical diff gate. A central capability/interface, universe,
scanner, detector, planner, solver or shared coordinator change is an explicit framework/systemic slice and
cannot be hidden inside a family-local verdict. Fixtures/tests may accompany the branch, but trusted producers
and comparators must remain independent of the candidate variable.
The trusted ownership manifest is derived independently in both frozen worktrees from
`PRODUCTION_ADAPTER_FAMILIES`, the active ActionAdapter catalog, imported export bindings and their
family-local source closures. The union of baseline/challenger owners for every changed implementation file
must equal the de-duplicated fixture subject-family set exactly. Shared files therefore require fixtures for
all owning families; an orphan file, hidden central registry/catalog logic change, registry reorder or
funding-only family fails closed. No protocol-name ownership table is maintained.

An unchanged identity/probe path may be exercised against a newly observed instance as supporting evidence,
but `family_execution` still cannot close its production-intake claim because steps 1–2 are route-pinned and
bypassed. Family-owned discovery/probe and thin registration may be covered by target-blind
`production_route_stage` when they affect only that family's instances/edges. A shared discovery source,
universe-wide admission/cap/ranking rule, central capability, or cross-family cardinality/resource change is
`systemic_live`, regardless of whether one pinned instance also passes Adapter Replay.

Manual adjudication owns track/scope classification only. It may preserve a machine failure as an out-of-scope
diagnostic when every required predicate of the selected track is covered by another trusted machine producer.
It cannot convert `fail` to `pass`, waive a required stage, or certify identity/probe, quote, plan/size, encoding,
final sim, repayment/conservation, EV, state/config anchors or safety boundaries from prose.

### Architecture-evolution compatibility

The evidence contract binds stable capability IDs, canonical edge/route identities, state anchors and domain
values—not file paths, function names, classes, module counts or today’s coordinator layout. A family or shared
owner may move, split, merge or become registry-dispatched without changing the six semantic stage meanings.
Evidence producers may add namespaced `extensions` for timing, counters, rank, debug text, source locations or
implementation-specific intermediates; these are retained for diagnosis but excluded from semantic equivalence.
Claims about those metrics use `systemic_live`.

Unknown extension fields are preserved and ignored by semantic comparison. Missing required core fields fail
closed. Adding or changing a required core field requires a schema-version bump and a trusted verifier update
that lands independently of the challenger. Refactors compare normalized core stage records for every affected
family fixture; a shared registry/state/planner/quoter refactor additionally needs a representative positive and
negative family cohort, and any hot-path/resource change routes to Hermes.

For `production_route_stage`, process startup/smoke is supplemental liveness evidence, not a substitute for
the six stages. Challenger-authored log markers do not prove lane activity or a stage pass.
`family_execution` does not bind a production universe because it makes no production-discovery claim. This
runbook grants no new broadcast authority.

A landed backrun transaction is a deterministic causal fixture; the chain cannot prove whether its trigger
was propagated through the public mempool. Historical validation therefore makes no claim about that past
transaction's propagation. `private_path=false` means the execution route itself is permissionless, not that
the trigger's network provenance was reconstructed. Any change to feed visibility, intake, or source
admission is `flow-admission` and must go to Hermes A/B rather than using this historical gate.

## Core deterministic workflow

The authoritative contract is result-scoped, not a two-phase branch/deployment controller:

1. Produce the native baseline and challenger Adapter Replay artifacts for every impacted family fixture.
   A registered baseline failure must reproduce the same typed
   `{ownerFamilyId, stageId, code}`; infrastructure failures do not count.
2. Produce the exact registry-derived ownership/conformance receipt and the mechanical
   `adapter-family-boundary` receipt.
3. Run the core judgment with `claim=adapter_merge`. A pass emits
   `adapter_fixed + adapter_merge_ready` and permits merging only the `family_local` diff. It does not require
   natural enumeration and does not delete the branch.
4. If the claim is that a historical production gap is closed, independently run the target-blind producer,
   freeze its output before the expected route is revealed, and provide one current-schema causal six-stage
   chain. Run the core judgment with `claim=production_gap`.
5. Only `production_gap_fixed` closes that production route gap. Ranking, latency, distribution and shared
   runtime claims still require their systemic cohort/Hermes evidence.

Completeness is route-lane scoped. The DEX shard and every family shard used by the route must be complete. A
DEX-only route is not globally blocked by an unrelated protocol-family watermark; a route using a protocol
family must have that family's real discovery/probe proof. Every unrelated incomplete shard is recorded as a
typed isolation in the completeness vector, while the graph hash binds everything actually materialized.
Protocol family shards may reuse an already verified cache only when its content hash, source range, identity
proof and code/config inputs match. A missing historical graph snapshot cannot be replaced by today's latest
runtime pool file: reconstruct honestly from frozen inputs and bind the builder/output hashes, or record
missing evidence.

Normal family-local work changes only family-owned implementation/identity/discovery/probe, an optional
low-level action encoder, automatically loaded family production descriptors and fixtures/tests. A central
interface/coordinator/planner/solver/quoter change is a separate `framework` slice. `family_execution`
deliberately bypasses production discovery/enumeration; that is why it may prove an adapter merge without
claiming the production gap fixed.

## Workflow

1. **Classify manually first.** Trace every selected transaction and decide scanner vs backrun, DEX-only vs
   DEX+permissionless-protocol, conservation, trigger, and positive net PnL before reading a script verdict.
2. **Reconcile through the generated tool index.** Query capabilities, inspect recommended and related
   tools, execute the selected current tools through `tool-run`, then reconcile. Do not choose diagnostic
   CLIs from memory. Trusted replay/gate runners remain fixed because they validate evidence rather than
   supply the diagnosis.
3. **Repair agreed tooling defects immediately.** If manual analysis and a fresh non-author reviewer agree
   a canonical analyzer is wrong or incomplete, fix it, add a regression, merge it directly to main, and
   rerun the analysis. It is auxiliary work, not the production challenger variable. The same direct-main
   rule applies to the two exact trusted replay gates (`blockscan-hunt.ts`, `backrun-hunt.ts`); it does not
   admit arbitrary listener tests or fixtures.
4. **Audit all old work before branching.** Fetch/prune origin; inventory main, every local ref (heads,
   tags, stash and custom refs), every configured remote's complete ref set, every worktree snapshot, the
   origin-main report/resolution sets, and modified/untracked worktree evidence. Remote-only objects are
   fetched into a temporary audit ref when needed so same-gap reports are inspected rather than skipped.
   Every inventory entry needs an exact fingerprint and an explicit disposition. Inspect actual diffs, SHAs
   and replays. Reuse an existing unmerged fix when it covers the same `gap_id`; do not open a duplicate
   because its branch name differs or because it lacks a report. A reportless ref/worktree whose diff touches
   any candidate runtime path may not be labelled `unrelated`; classify it as reused, superseded or still
   blocking. The trusted inventory command must run
   before branch creation. If that exact branch already exists locally, remotely, or in a worktree, it
   fails closed: inspect that ref, choose a fresh branch name, and keep the old ref visible in the audit.
   The command writes a trusted prepare receipt under the shared Git directory. Its authentication tag is
   computed by root on the node through SSM from `/root/.mev-historical-gap-hmac-v1`; the signing key never
   enters the repository, local user environment or candidate process. Copy its SHA-256 into the report;
   classify/promote reject an inventory printed after the branch appeared or for another gap/base. Candidate
   commands run with an isolated temporary `HOME`, no inherited AWS credential variables and no SSH agent.
   They are also wrapped in a macOS sandbox: only loopback outbound network is allowed, writes are confined to
   the gate-owned temporary directory, and file contents are readable only from the gate-created detached
   worktrees, content-hashed dependency inputs, required system runtimes and the gate-owned universe copy.
   The original repository, other worktrees, logs, shell history, credentials and keychains are therefore not
   candidate-readable even if challenger code prints arbitrary stdout.
   A source marked `reusable` must name a concrete prior commit that is reachable from that inventoried ref,
   absent from the tested base, and present in challenger history. A prose claim of reuse is insufficient.
   This branch-reuse audit applies to searcher behavior gaps. An auxiliary analysis-tool correction goes
   directly through tests/review to main and does not occupy a searcher-gap branch or audit.
5. **Group by root cause.** One gap class gets one branch and may carry multiple transactions. Do not create
   one branch per transaction. Deterministic family work uses a short-lived `codex/*` branch and the core
   result judgment; only a `systemic_live` experiment occupies literal `ab/*` and B.
6. **Build the evidence artifact for the selected track.** For `family_execution`, place one strict schema-v3
   Adapter Replay fixture plus its independently produced landed evidence for every sample in the report-only
   artifact descendant; bind both by SHA-256 in the historical report. Every leg carries a finite
   reference-witness declaration interpreted by the trusted runner. The declaration may express ABI signatures,
   exact empty-calldata value calls, parent/descendant call relations, token/caller/target equality, positive
   amounts and receipt transfers; it
   cannot execute code, inject a replay amount, or fall back to a family-name-specific `target+selector` rule.
   The root target/selector is additionally derived from the solver-selected final resolved-plan subtree,
   compiled with its real child bytes and selected amount, and must equal the landed call; a probe-time
   fragment or `matchTrace` alone is not an execution-semantic oracle. The final simulator calldata must
   byte-match the calldata compiled from that same resolved plan. Ordinary address-backed families bind the
   final subtree through its resolved node target. Singleton vault/manager families declare their own
   deterministic projection from the final subtree to the logical route target and optional pool id; the
   trusted runner compares that projection with the graph edge without passing the expected edge into the
   family callback.
   For `production_route_stage`, build one schema-v3 candidate report per sample. That
   report's `production_evidence` owns the on-chain
   classification and trusted replay declaration. Both block-scan and backrun samples must declare one complete,
   ordered, closed `expected_route`; every edge binds `adapterId`, `slotKind`, `target`, `tokenIn`, `tokenOut`
   and optional `poolId`. That route is verifier-owned expected output, not a production input. The gate keeps it
   outside graph construction, enumeration, pruning, ranking, candidate retention, top-K, solve selection and
   sizing, then checks the ordered swap pool/direction sequence against canonical receipt
   logs and matches the entire interleaved DEX/protocol route against one successful state-changing call trace.
   Every swap must also match the attested production-universe adapter, target, token direction and,
   for factory-backed V2/V3 venues, factory-established identity. Every protocol leg must appear in order in
   the successful state-changing call trace and satisfy its hash-bound witness; bare target/selector matches
   are insufficient. Its execution target is derived from production plan semantics, cannot be the winner's
   private caller/executor, and its input/output token causality must be bound by scoped calls or landed
   receipt flows. The entire route must then match the trusted replay byte-for-byte. Pool membership or a two-pool
   signature alone cannot identify a route. The
   historical report only groups those sample reports and declares the promotion track. Systemic protocol
   scanner, graph/universe, coverage, distribution or performance work does not create these per-sample
   candidate reports. It predeclares a representative positive/negative cohort plus coverage, output,
   fairness and resource criteria, then proceeds through Hermes A/B.
7. **Judge the adapter result.** Feed the authenticated native family-execution promotion receipt and exact
   boundary receipt to the core gate. `adapter_merge_ready` permits merging only the family-owned diff.
   A registered deterministic baseline failure must have a stable
   `{ownerFamilyId, stageId, code}`; timeout, abort, provider/network and unclassified errors remain
   infrastructure evidence.
8. **Judge production separately when claimed.** Run the target-blind natural producer with exact production
   caps and freeze its output before comparison. `production_gap_fixed` requires all six current-schema
   stages, solver-selected sizing, mandatory final sim and positive allowed EV. Failure here does not undo an
   already proven adapter fix; classify the remaining enumeration/ranking/state/runtime stage. Systemic work
   closes through the Hermes A/B lifecycle.

## Commands

Run the trusted evidence producers first, then judge their native receipts using the stable input contract in
`docs/research/templates/six-step-validation.md`.

```bash
cd analysis

npm run six-step-validation-gate -- \
  --input /path/to/semantic-receipt.json \
  --out /path/to/judgment.json
```

Use `docs/research/templates/six-step-validation.md` for the result contract and
`docs/research/templates/historical-gap.md` for human context. Raw RPC URLs, keys and unredacted logs remain
off Git. The `historical-gap-gate` remains the trusted producer/authenticator for native family-execution
promotion receipts; the core judgment does not replace its evidence production and does not own cleanup.
