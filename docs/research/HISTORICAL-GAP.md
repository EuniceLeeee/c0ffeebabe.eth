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

Exclude inventory, keeper/reward, credit, sandwich, JIT-LP, private paths/vaults and any route that leaves
a standing position. A transaction may execute atomically and still be a backrun; its source is decided by
the causal replay, not by the word `atomic` or by its bundle container.

## Promotion Matrix

| Change | Required evidence | Destination |
|---|---|---|
| analysis tool, classifier, gate | build + regression tests + fresh non-author review | merge directly to `main`; never deploy as B |
| `family_execution`: quote-bearing `RouteLeg` family-owned identity/edge, quote, plan/size or execution semantics | a registry-derived ownership manifest proves that every changed family owner—and no unchanged family—is represented by a trace-proven fixture; every fixture passes trusted route-pinned Family/Adapter Replay, conformance/isolation and canonical stages 3–6; the replay itself independently proves positive production EV | merge exact frozen SHA as `adapter_fixed`; do not claim production discovery |
| `production_route_stage`: a particular historical route should advance through the production funnel | trusted Production Replay emits the canonical six stages without receiving the expected route or amount as a production input; then the trusted gate itself runs a >=10 minute dual-lane dry-run smoke | merge exact frozen SHA as `production_fixed` after the claimed stage advances |
| systemic protocol scanner, graph/universe construction, coverage or cross-opportunity distribution/performance | predeclared positive/negative cohort, coverage and output contract, then same-input fairness/resource evidence | route to `HERMES.md`; no per-sample candidate or single-route stage flip |
| flow admission, latency, candidate ranking | pinned replay where applicable, then full Hermes A/B | route to `HERMES.md`; history alone cannot promote |
| build/test only | `implemented_not_validated` | retain; never claim fixed or merge as the repair |

## Three tracks, Adapter Replay and Production Replay

Historical work has exactly three claim tracks: `family_execution`, `production_route_stage` and
`systemic_live`. In the schema-v1 historical report these map, without reinterpreting old records, to
component/validation keys `family-execution`, `historical-replay` and `hermes-ab` respectively.
The first two use the same canonical six-stage evidence schema from `gates.md`; the third uses a predeclared
cohort plus Hermes A/B. Do not split adapter execution and solver sizing into separate success verdicts.

| Validation level | Supplied by the fixture | Must be produced by production code | Verdict |
|---|---|---|---|
| **Family/Adapter Replay (`family_execution`)** | The subject quote-bearing `RouteLeg` `ExecutionFamilyId` plus the complete ordered route recovered from the landed trace: route-leg adapter identity, target or pool id, token direction, finite reference-witness rules and lane-correct state anchor. Funding is replay infrastructure, not the subject. | Steps 1–2 explicitly `bypassed`; registry-validated family edges, exact quotes, production planner/solver-selected input amount, encoding, fork final simulation, flash repayment, token conservation (no pre-existing intermediate inventory consumed; positive execution surplus is recorded but excluded from EV) and a positive decision from the pinned production EV policy satisfy canonical steps 3–6. | runner: `adapter_replay_pass`; trusted promotion: `adapter_fixed` |
| **Production Replay (`production_route_stage`)** | Only the historical transaction and its lane-correct state anchor. The trace-derived expected route is retained by the verifier and withheld from the production producer until its output is frozen; no amount is supplied. | Discovery/admission/graph, route enumeration, exact quote/refine, plan/size, encoding/fork final simulation, repayment/conservation and positive production EV satisfy canonical steps 1–6. | `production_fixed` |
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
The standalone command is `npm run searcher:adapter-family-replay -- --fixture <fixture>`; it is diagnostic
evidence and is never a deployment hook or an A/B start condition.

Adapter Replay is always route-pinned equivalence evidence; it makes no claim about production candidate rank,
top-K admission or scanner stage advance. Those claims require Production Replay with no expected route fed to
discovery, graph construction, enumeration, pruning, ranking, candidate retention or solve selection. The
expected route is an output-only oracle: after production output is frozen, the verifier may compare its complete
ordered identity. If the route is not naturally enumerated or selected, the corresponding stage fails or is
`not_reached`; the verifier may not append it to a solve set or force-probe it. The fixture schema has no
rounding/tolerance override: token rounding remains adapter-owned.
Fluid DEX is still the explicit legacy execution switch and is absent from family coverage until a Fluid-specific
fixture passes; moving that switch into a family would not, by itself, discover any additional Fluid instance.
An Adapter Replay failure may be manually triaged as a gate/harness defect and the branch retained while that
defect is repaired, but it cannot be promoted as an adapter fix or relabelled `adapter_replay_pass`. Because the
failed check is directly relevant to an adapter claim, the harness regression and replay must pass before that
claim closes. This is distinct from an unrelated systemic scanner A/B, whose bounded-live deployment does not
depend on this optional checker.

Every successful Adapter Replay writes a compact, redacted receipt containing the transaction hash, ordered
route hash, reference-trace route hash, state block and state root, base and adapter commit, execution-family
registry-derived contract fingerprint, runtime-source hash, shared adapter API hash, compiled BotVM
artifact/runtime hash,
solver-selected amount, final-sim gross profit, production-EV result, harness hash and replay command. Raw RPC
logs remain gitignored. A later Production Replay may inherit the `adapter_fixed` finding when the adapter
commit is an ancestor and all recorded code/input hashes still match, but it still re-executes the complete
production quote/sim path. A change to that adapter or the shared planner/solver/quote/encode API invalidates
the inherited receipt. The current runtime-source digest is deliberately conservative and also invalidates on
an unrelated production-runtime source change; rerun the deterministic replay rather than treating that
conservative invalidation as a semantic failure.
The runner derives the family contract fingerprint from the live registry descriptor and separately binds all
runtime sources; it has no per-family source-file table to update when a family is added, moved or split.

An adapter-only challenger may modify only family-owned implementation files plus the thin production
registration surfaces accepted by the mechanical diff gate. Fixtures, landed evidence, review and replay
receipts live in the externally supplied report-only artifact descendant; they are not part of the frozen
challenger code tree. Changes to universe, scanner, detector, planner, solver, shared adapter interfaces,
tests or trusted runners are a separate gap/framework change and cannot be hidden inside an `adapter_fixed`
verdict.
The trusted ownership manifest is derived independently in both frozen worktrees from
`PRODUCTION_ADAPTER_FAMILIES`, the active ActionAdapter catalog, imported export bindings and their
family-local source closures. The union of baseline/challenger owners for every changed implementation file
must equal the de-duplicated fixture subject-family set exactly. Shared files therefore require fixtures for
all owning families; an orphan file, hidden central registry/catalog logic change, registry reorder or
funding-only family fails closed. No protocol-name ownership table is maintained.

An unchanged identity/probe path may be exercised against a newly observed instance as supporting evidence, but
`family_execution` still cannot close its production-intake claim because steps 1–2 are route-pinned and
bypassed. A new or modified discovery source, production registry activation, universe-wide admission rule, or
any change capable of altering cross-opportunity cardinality/resource use is `systemic_live`, regardless of
whether one pinned instance also passes Adapter Replay.

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

For `production_route_stage`, the smoke is not a report-authored receipt. During `promote`, the trusted gate
starts the frozen challenger itself with dry-run forced on, scanner and public-mempool backrun configured on,
and MEV-Share off. It measures wall clock and rejects an early process exit or fatal process output.
Challenger-authored log markers do not prove lane activity and are not promotion predicates; unchanged
scanner/backrun replay gates own that capability proof. It runs from a temporary working directory with no
project `.env`; only the explicitly supplied public BotVM address is admitted. The gate generates a one-run
disposable signer and never reads or passes a production private key; every behavioral setting is fixed by
the gate. `family_execution` does not run this smoke or bind a production universe because it makes no
production-discovery, distribution or liveness claim. This runbook grants no broadcast authority.

A landed backrun transaction is a deterministic causal fixture; the chain cannot prove whether its trigger
was propagated through the public mempool. Historical promotion therefore makes no claim about that past
transaction's propagation. `private_path=false` means the execution route itself is permissionless, not that
the trigger's network provenance was reconstructed. Any change to feed visibility, intake, or source
admission is `flow-admission` and must go to Hermes A/B rather than using this historical gate.

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
   one branch per transaction. Searcher behavior branches are literal `ab/*` so existing lifecycle cleanup
   applies; analysis-only work must not occupy B.
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
7. **Run the historical gate.** It recomputes scope, checks base/branch/ref inventory and actual diff class,
   then reruns repository gates. For `family_execution` it invokes the trusted route-pinned Family/Adapter Replay,
   verifies canonical steps 3–6 with steps 1–2 explicitly `bypassed`, and runs the fixed
   adapter-descriptor/route-registry/token-graph-isolation/shared-surface/ownership conformance inventory.
   The base/challenger ownership manifests, exact retained central-skeleton bytes and exact affected-family
   set are bound into the promotion receipt.
   A registered baseline failure is accepted only when a project-owned deterministic error supplies the exact
   `{ownerFamilyId, stageId, code}` and a second baseline run reproduces the same semantic failure fingerprint;
   timeout, abort, provider/network and unclassified errors are infrastructure evidence and cannot establish a
   flip. Raw error prose, timings and extension fields are excluded. For `production_route_stage` it invokes
   the unchanged trusted Production Replay and verifies canonical steps 1–6 without exposing expected route or
   amount to the production producer. A challenger-authored success string cannot satisfy either track.
   Runtime-path and added/removed diff signals mechanically route intake, ranking,
   threshold, deadline, budget, concurrency and latency behavior to Hermes even if the report labels it
   `detector` or `planner`.
   Historical promotion uses a conservative deterministic-file allowlist, not semantic keyword guessing.
   Mixed orchestration files that own live discovery, detector admission, scanner ranking, planner/solver
   ordering, or strategy views are always Hermes-routed; a deterministic helper must be isolated from that
   live-distribution layer.
   Per-edge protocol validity and quote/amount-domain guards remain `family_execution`; cross-opportunity
   intake, ordering, cardinality caps, timing and resource budgets are live-distribution work. The fresh
   non-author review must explicitly attest `live_distribution_verdict=none` before historical promotion.
   That attestation is bound to the exact base SHA, challenger SHA and SHA-256 of the Git patch; prose about
   an earlier diff cannot authorize a later commit. The reviewer must also commit a separate structured,
   hash-bound artifact covering that exact identity and branch-audit digest. Report-authored reviewer prose
   alone cannot promote.
   For `production_route_stage`, the production pool-universe snapshot, its top-N, source path, capture time
   and runtime commit are bound by a separate provenance artifact and content hash. The gate independently
   reads the active champion's process environment and hashes that exact content-addressed file through SSM
   before and after replay/smoke; caller-selected paths, top-N values and stale runtime commits are rejected.
   Both deterministic tracks reject caller-supplied replay RPC/WS URLs: through SSM the gate reads the active
   champion's own local-reth HTTP/WS ports and opens gate-owned loopback tunnels to those exact ports.
   Readiness requires the gate-owned Session Manager child to report that it opened the exact selected local
   port, not merely that some local process accepts TCP. It records chain ID plus exact winner/trigger receipt
   and parent-block identities. `production_route_stage` additionally rechecks universe and RPC identity after
   replay/smoke; `family_execution` rechecks the RPC identity after its route-pinned replays.
8. **Close by exact SHA.** Freeze executable code at `challenger_commit`; later candidate reports live only
   in a report-only descendant supplied externally as `--artifact-ref`. The report cannot contain its own
   commit SHA (that would be a self-referential Git object). The gate resolves the external ref, requires the
   branch tip to equal it, and compares the local report byte-for-byte with the committed artifact.
   `promote` authorizes an exact no-ff merge of the still-current tested base and frozen challenger, never the
   report descendant. Only after the track-required trusted replay and, for `production_route_stage`, smoke
   subprocesses finish does the gate create and
   authenticate a durable receipt under the shared Git directory using the same node-root SSM signer. It binds
   the artifact ref, review, diff,
   toolchain, lockfiles, replay reports/manifests, family conformance script/source/output hashes and
   trusted-reth attestations; production-universe and smoke posture/log are bound only on the production-route
   track. Close obtains a second node-root authentication
   tag that covers `closed_at` and `merge_commit`;
   editing an open receipt into a closed one is invalid. Close rejects unsigned, edited, wrong-track, incomplete or stale receipts and revalidates the
   track-specific evidence instead of trusting report prose.
   The merge commit tree must exactly equal the frozen challenger tree; an `ours` strategy or manual conflict
   resolution cannot close the gap. Commit the final report plus every candidate report, tool manifest, review
   and universe-provenance artifact byte-identically
   on main; then delete the local/remote branch and remove every
   challenger/evidence worktree,
   then run close phase. A promoted gap is not closed and the next gap must not start until close phase passes.
   The inventory command mechanically refuses a new gap while any promotion receipt remains open. A change
   routed to Hermes emits no historical promotion receipt and closes only through the Hermes A/B lifecycle. If any
   condition fails, keep `implemented_not_validated` or route the branch to Hermes. A later fix may close it
   through the existing resolution sweep.

## Commands

For a searcher repair, execute the gate from a clean checkout of current `origin/main`. The report argument
may point into the candidate evidence worktree; `--report-repo-path` binds where those bytes live at the
external artifact ref. `--base-root` and `--challenger-root` are clean detached worktrees at the exact code
SHAs, not the report-tip checkout.

```bash
cd analysis

# Before branch creation; paste refs_sha256 and adjudicated matches into the report.
node --import tsx src/cli/historical-gap-gate.ts --print-ref-inventory \
  --gap-id <gap-id> --branch ab/<gap-id>

# Scope, branch reuse and diff-class check.
node --import tsx src/cli/historical-gap-gate.ts ../docs/research/reports/<report>.md --phase classify \
  --artifact-ref origin/ab/<gap-id> \
  --report-repo-path docs/research/reports/<report>.md

# Promotion. Family-execution omits universe and smoke arguments; production-route supplies them.
# Searcher replay RPC/WS tunnels are gate-owned and accept no CLI override.
node --import tsx src/cli/historical-gap-gate.ts ../docs/research/reports/<report>.md --phase promote \
  --artifact-ref origin/ab/<gap-id> \
  --report-repo-path docs/research/reports/<report>.md \
  --botvm-address "$BOTVM_ADDRESS" \
  --base-root /path/to/base-worktree \
  --challenger-root /path/to/challenger-worktree \
  --universe /path/to/frozen-universe.json \
  --smoke-anvil-port 8655 \
  --smoke-blockscan-anvil-port 8656

# After exact merge, report archive, branch/worktree deletion and push.
node --import tsx src/cli/historical-gap-gate.ts ../docs/research/reports/<report>.md --phase close
```

Trusted promotion uses these direct Node invocations. `npm run historical-gap-gate` is only an interactive
convenience alias and cannot serve as promotion evidence because npm shell configuration can replace a
package script before the gate starts.

Use `docs/research/templates/historical-gap.md`. Raw RPC URLs, keys and unredacted logs remain off Git.
