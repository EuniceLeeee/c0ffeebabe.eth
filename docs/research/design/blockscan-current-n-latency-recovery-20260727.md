# Block-scan current-N latency recovery plan

> Status: D0/R1/R2/R6 implemented; all three source-N live rounds failed; degraded N−1 pricing is live-nonzero but scanner consumption is not restored
> Branch: `codex/blockscan-current-n-latency-recovery`
> Base: `origin/main@48fb88e9c0ac7705d1d89f60b060d6ede5c423c2`
> Change class: systemic block-scan correctness/performance
> Promotion track: deterministic gates first, then paired Hermes A/B
> Safety posture: local tests and dry-run only; this document does not authorize broadcast

## 1. Authority and scope

This document is the implementation contract for recovering live block-scan output while preserving the
full adapter-family graph and current-block correctness.

It supersedes the proposed repair mechanism and acceptance thresholds in
`docs/research/reports/live-blockscan-zero-output-20260727.md` §§5–6 where they depend on claims later
refuted by that report's §1a. The incident facts and correction history remain evidence; they are not
deleted.

The work has two distinct outcomes:

1. **Restore output:** current-N pricing publishes non-zero healthy coverage and enumeration runs again.
2. **Meet latency:** the complete positive-candidate path from head observation through final simulation
   has p95 below 10 seconds.

Restoring output is not evidence that latency is solved. A state-only timing below 10 seconds is not
evidence that an atomic opportunity can finish within 10 seconds.

## 2. Corrected diagnosis

### 2.1 Confirmed

- The deployed failure cohort at `137b0f8` produced `priced=0`, no enumeration and no final simulation.
- Incremental families had a previous snapshot; `previous-snapshot-unavailable` was not the observed
  fallback.
- The observed fallback was `mutation-range-failed`.
- Incremental family work starts concurrently, but every mutation-proof transport operation uses one
  `mutationProofSlots` permit.
- The original mutation error is discarded by the coordinator, so the current evidence does not identify
  whether failure occurs while waiting for the permit, reading headers, reading logs, validating the range,
  or performing the final canonical check.
- A proof failure triggers full current-N reads. The measured full-read cost exceeds the 5-second hot
  family settlement boundary.
- The top-level `state` stage includes hot discovery, graph preparation, pricing, funding and execution
  preparation. Family-lane timings do not explain the whole stage.
- Strict hot discovery scans the current source delta and separately re-attests the six enabled declared
  protocol venues. Known DEX pools are filtered by `knownPoolKeys` and are not rebuilt; UniV2
  `getReserves` runs only for newly discovered or retryable candidates.
- In the frozen production venue tree, only UniV2-standard, UniV3-standard and UniV4 declare an
  `incremental` block-scan state capability. The remaining registered pricing capabilities retain a
  direct-current cost floor unless separately upgraded.
- The stopped A live telemetry registered 18 pricing families. Combined with the three verified incremental
  declarations above, 15 registered families retain that direct-current cost floor in this frozen runtime.
- Round 3 deployed the separated mutation header/descriptor/final-CAS transports with the default descriptor
  concurrency raised from one to three and no environment override. Its cold snapshot published
  `priced=29907/30513`, proving that the recovery shell can be repopulated, but the snapshot took
  `126545.06ms` and was startup-only.
- Round 3's first three eligible hot source-N state attempts at `25623642`, `25623645` and `25623648`
  all failed to produce usable pricing. Their state walls were `31564.98ms`, `28548.70ms` and
  `28639.35ms`; the first two did not enumerate and the third enumerated a `priced=0/30521` degraded
  view for `4469.20ms` before `scanner_deadline`.
- The Round-3 mutation proofs still reported `header-read:deadline` with zero header RPCs. The separated
  semaphore did not restore liveness because hot discovery/head queue time had already consumed most of
  the source-N window before state preparation reached those proofs. Transport contention was real in
  Round 2, but it is not the complete live root cause.
- `BlockScanRuntimeLoop.runHead` checks the pass deadline only **after**
  `detectProductionBlockScanOpportunities` returns. A state stage that consumes its budget can therefore
  still enter the synchronous coarse enumeration and spend additional CPU before being classified
  `scanner_deadline`.
- Coarse scanner enumeration consumes graph + pricing mids + configured `pricedTokens`; it does not consume
  the live funding snapshot. Exact refinement, planning and final simulation still require a correctly
  pinned execution/funding context.
- The first R6 live attempts did not restore pricing. The original transport exceeded the fixed `20000ms`
  N−1 state budget; compact raw-header transport still published `priced=0`; a `35000ms` diagnostic proved
  that adding budget alone did not repair the publication path; and a publication-reserve repair still
  discarded all family-local progress.
- The family-local preservation repair at canonical `d685a1e` / diagnostic `d161cbb` proved that safe
  state-key progress survives a sibling timeout and that an outer generation abort still fails closed.
  With the predeclared `10000ms` family-settle allocation, however, the first six hot N−1 attempts remained
  `priced=0`; mutation proofs reached `log-read`/`final-cas` but local family aborts still arrived too early.
- A single-factor live allocation test kept the total N−1 state budget at `20000ms`, graph, denominator,
  concurrency and every source/hash proof unchanged, and changed only family settlement from `10000ms` to
  `12000ms`. The first two published hot sources were non-zero:
  `25624260 = 14649/30979` in `15879ms` and
  `25624261 = 14640/30981` in `17744ms`. The first source carried 7,327 UniV2 state keys through a complete
  canonical mutation proof. This is evidence that degraded coarse pricing no longer dies as
  `priced=0`; it is not evidence that the production scanner loop is restored.
- The first two immediately adjacent consumers did not enumerate. At head `25624261`, exact
  funding-context preparation was reached with roughly `211ms` left and failed
  `adapter runtime preparation deadline reached`. At head `25624267`, it ran for `2370ms` and again failed
  before enumeration while describing the full graph's flash-loan funding keys. Enumeration,
  planner/solver and final simulation remained `not-run`. Other heads were not exact predecessor joins
  because discovery/state production had fallen behind. No natural positive candidate or final-sim success
  was observed.

### 2.2 Not yet proven

- That semaphore wait is the sole mutation-range failure.
- That mutation-proof recovery alone produces an end-to-end pass below 10 seconds.
- That delaying funding or worker preparation improves a positive-candidate block.
- That one Anvil worker is faster than four under real contention.
- That changed-edge-first enumeration is complete without scan-debt recovery.
- That the solver and final simulation fit into the time left after state and enumeration.
- That a complete source-N state producer for all 18 registered families can fit before the scanner deadline
  on the current eight-core node without a separate state lifecycle.
- That an N−1 coarse producer plus current-N whole-route reprice can produce a positive candidate and reach
  final simulation inside the usable window.
- That the live N−1 producer can publish an exact predecessor view before every next head. The first
  non-zero samples required `15.879–17.744s`, longer than a typical Ethereum block interval.
- That the exact funding/execution context can be prepared early enough for an adjacent N−1 view to enter
  enumeration. The first observed adjacent join failed before enumeration.

No slice may present one of these hypotheses as a fact before its declared measurement.

### 2.3 Adversarial-audit adjudication

- **Confirmed:** a published `PricingView` contains only resolved state keys. A zero-priced publication can
  therefore have an empty `stateByStateKey`; R1 transport recovery by itself cannot carry from that shell.
- **Confirmed:** R2 was missing as an independent attribution factor. §5.2 now orders recovery-base
  isolation before mutation-transport attribution.
- **Confirmed:** the original restore-output wording could be satisfied by increasing budgets, selecting a
  favorable window, or hiding unresolved families behind a positive aggregate count. §6.0 now freezes
  configuration/budgets, fixes the live cohort, and requires family-local coverage reporting.
- **Partially addressed, still a live risk:** `lastGoodByStateKey` is independent of the published shell and
  preserves any state key that has succeeded in the current process. It is not a persistent independent
  StateTracker: a cold process has no recovery base, and state production still settles inside `runHead`.
  The three source-N live rounds must therefore include cold-start behavior.
- **Retained:** complete M→N proofs, latest-target coalescing, scan debt, content-addressed state/funding/
  execution joins, reorg CAS, and the declared UniV3 projected-state proof gap.
- Numerical assertions such as the exact count of families without incremental capability, equality between
  issue and read counts, and enumeration timing ranges remain evidence claims to verify against the frozen
  runtime/log cohort. They are not promoted to design facts merely because they appeared in an audit.

## 3. Non-negotiable invariants

### 3.1 Coverage

- Do not reduce the pool universe, graph, expected edge set, hop limit or candidate cap to manufacture a
  latency improvement.
- Added/removed edges must be reported as an explicit activation delta and reviewed separately.
- A failed family or state key may be excluded from the current pricing view; a healthy sibling must not be
  erased merely to preserve family-wide all-or-nothing presentation.

### 3.2 Freshness

- Dynamic pricing is source-N.
- A carried state is publishable at N only after an adapter-owned mutation/dependency proof covers the
  complete canonical range from its prior source through N.
- `lastGoodByStateKey` is an internal recovery base. It is never a stale mid and never becomes source-N
  merely because it exists.
- Protocol conversions, Curve states with block-progressing/external dependencies, and UniV4 dynamic-fee
  pools remain direct-current by default unless a family supplies a complete proof contract.

#### 3.2.1 Conditional N−1 coarse-pricing fallback

Source-N remains the preferred production path. If the instrumented independent-B run shows that source-N
still cannot produce usable pricing after R1+R2 and the declared concurrency/direct-read attempts, one
completed predecessor snapshot may be used as a degraded liveness fallback for **coarse candidate
enumeration only**:

- the maximum age is exactly one completed predecessor block (`coarseSource=N−1`); N−2 or an unbounded stale
  cache is forbidden;
- it is labeled as N−1 provenance and is never inserted into a source-N `PricingView`;
- mutations observed at N are accumulated as current-block anchors. An affected edge must receive a
  current-N read before its anchor can be scored; the full graph remains available for closing the route;
- adapters with off-event/external dependencies must declare that limitation. If they cannot supply an N
  mutation proof or current read, the degraded lane has an explicit recall gap and cannot claim full
  coverage;
- every coarse candidate is fully repriced at N before exact refinement, planning, solving, EV evaluation or
  submission. The candidate joins only same-block/hash funding and execution state and passes a final
  canonical CAS;
- if the N reprice/join cannot finish, disagrees in EV sign, or the head advances again, the candidate is
  discarded. N−1 values never authorize a bundle or transaction.

Activation is allowed only after a live diagnostic records the failed source-N attempts and their phase
telemetry. It is a degraded availability mode, not proof that current-N output, full recall, end-to-end
latency or `fixed` has been achieved.

### 3.3 Atomic join

Scheduling may be decoupled; execution consistency may not.

Every candidate must bind a content-addressed pricing identity containing at least:

```text
source block + source hash
graph identity/edge/metadata/ownership hashes
pricing coverage hash
resolved-mid hash
```

Before exact execution, planning or final simulation consumes a candidate, the runtime must join a funding
view and execution lease for the same source block/hash and re-check canonicality. A process-local generation
number alone is insufficient.

### 3.4 Scheduling and recovery

- Preserve latest-target coalescing. Do not replace it with an unbounded per-head FIFO.
- From last proven source M, the state producer may advance directly to latest target N by proving the full
  canonical range M→N.
- Do not aggressively cancel an in-flight `anvil_reset`; promise cancellation does not stop the reset.
- A changed-edge priority queue must accumulate all mutations since the last successful scan and retain
  scan debt or periodic full sweeps. It must not permanently forget an opportunity first exposed on a
  skipped head.

### 3.5 Existing proof gap

UniV3 carry currently observes Initialize/Mint/Burn/Swap while the projected backrun state also contains
`observationCardinalityNext` and `feeProtocol`. Before widening reliance on carry, either:

- cover every mutation that changes the projected fields; or
- separate coarse pricing state from the execution/backrun overlay state and prove/read them independently.

## 4. Execution slices

Each runtime-behavior slice is a separate commit and rollback point. Do not combine independent performance
hypotheses into one unmeasurable patch.

### D0 — lossless stage instrumentation

**Purpose:** identify the actual critical path without changing scheduling, coverage or state semantics.

**Targets**

- `BlockScanStateCoordinator.prepareIncrementalPlans`
  - preserve a sanitized error classification;
  - record descriptor, permit wait, header, log, validation and final-CAS phases;
  - record direct/carry/unresolved state-key counts.
- `JsonRpcBlockScanStateReadBackend.readCanonicalMutationRange`
  - record request count, bytes where available, queue wait and wall time per phase.
- `AdapterRuntimeCoordinator.prepare`
  - record pricing, funding and execution preparation independently.
- `runDexDiscoveryPass`
  - record swap scan, factory indexing, incumbent attestation and identity retry independently.
- `BlockScanRuntimeLoop.runHead`
  - record every worker reset independently and retain head-observed queue time.

**Gate**

- Existing state/backend/runtime tests pass.
- Added instrumentation test proves emitted phase classification and monotonic timing fields.
- Coverage hashes, graph hashes, result status and scheduling decisions are unchanged for the same fixture.

**Verdict:** observability-only; never `fixed`.

### R1 — mutation-proof transport recovery

**Purpose:** make the existing V2/V3/V4 incremental path succeed within the hot boundary.

**Direction**

- Share the canonical header/path proof for equal `(fromSource, throughSource)`.
- Deduplicate identical mutation descriptors.
- Execute different descriptor log reads with configurable bounded concurrency.
- Keep mutation proof isolated from bulk state-read FIFO.
- Do not union unrelated log filters unless the query planner proves that the union result is a complete
  superset of every original filter.
- Preserve per-descriptor range fingerprints and final canonical verification.
- Keep full direct-current fallback fail-closed.

**Experiment**

- A/B mutation concurrency 1 versus candidate values, initially 2 and 3.
- Do not select the production value without measured permit wait, node latency and current-N parity.

**Deterministic gates**

- Concurrent callers for one range share an identical canonical path.
- Different descriptors retain different query/range fingerprints.
- Reorg between header, log and final CAS rejects publication.
- Abort/deadline releases every permit and does not publish partial proof.
- Quiet-block V2/V3 carry is greater than zero.
- UniV4 dynamic-fee states remain direct.
- Full-direct versus incremental mids and coverage are identical on the same block/hash.

**Rollback:** restore prior proof transport without touching family state contracts.

### R2 — recovery-only state bases

**Purpose:** let a family/state key recover after a failed publication without publishing stale dynamic
state.

**Direction**

- Maintain the last successfully proven state per state key, including source block/hash, schema fingerprint,
  required read keys and freshness proof.
- A later generation may use it only as the `fromExclusive` base of a new complete mutation proof.
- If the gap exceeds the supported range, schema changed, or proof fails, use direct-current fallback or
  leave that key unresolved.
- Current PricingView contains only states proven/direct-read at N.
- Align `blockscan-backrun-state-bridge` isolation with per-state-key health so one failed sibling does not
  clear unrelated healthy state.

**Deterministic gates**

- Inject one family failure at N; healthy siblings publish at N.
- At N+1, the failed family advances from its last proven source across the full range or fails closed.
- No freshness proof claims N without direct-N provenance or a complete range fingerprint.
- Reorg and schema-change controls discard an incompatible recovery base.

### R3 — declared-venue topology re-attestation policy

**Purpose:** measure and, only if material, remove redundant declared-venue topology re-attestation from the
hot path for family-declared immutable topology.

**Precondition:** D0 shows that the six declared-venue re-attestations are material after R1. Current
evidence indicates roughly nine calls, not a full-universe rebuild.

**Direction**

- Default policy remains `current-block`.
- An `admission-only` policy is allowed only where the family proves the relevant topology immutable; the
  policy/version must enter the registry/source fingerprint and GraphView identity.
- Metronome synth membership remains `current-block`.
- Goldx, Rocksolid and PSM are the first admission-only review candidates. Evidence for hgUSDC and wstETH
  is insufficient, so they remain `current-block`.
- Newly observed events/instances, factory deltas and retryable admissions remain current-source work.
- Periodic re-attestation may be diagnostic but cannot substitute for a complete current-block topology
  proof for mutable families.
- Dynamic reserve/rate/fee pricing remains in the source-N state coordinator.
- A newly observed pool at N must be materialized for N; an old T-k topology is acceptable only when the
  complete delta k→N has been applied.
- Mutable topology replacement must compare the exact edge set atomically. The current merge-only check can
  remain degraded forever on an added edge and can incorrectly retain a removed stale edge.
- The protocol-family positive-edge exception in `BlockScanStateCoordinator.prepare` may consume an
  admission-only edge only when the immutable-topology proof is bound into GraphView provenance.

**Deterministic gates**

- No-change head performs zero graph-build calls for `admission-only` declared venues and preserves calls
  for `current-block` venues.
- New-pool, transient retry, exact-set replacement, removal/reorg and mutable-identity fixtures produce the
  same result as the declared full-attestation oracle.
- Positive and negative family controls prove no unsupported pool admission.
- Full declared-venue attestation remains available as an oracle/audit mode.

**Rollback:** restore every declared venue to `current-block`; retained cache format remains backward
compatible.

### R4 — pricing-ready enumeration with exact downstream join

**Purpose:** stop coarse enumeration from waiting for unrelated funding/execution preparation when D0 shows
that wait is material.

**Precondition:** D0 proves funding or worker preparation is on the critical path after R1/R3.

**Direction**

- Publish an immutable `PricingView` after pricing CAS.
- Start coarse enumeration from that view.
- Prepare worker 0 in parallel because exact refinement currently needs it.
- Bind candidates to `PricingViewId`.
- Join candidate + same-source FundingView + same-source ExecutionLease before the first stage that needs
  them; repeat canonical CAS before final simulation.
- Superseded generations cannot overwrite newer caches or acquire a mismatched worker lease.
- Do not shrink funding to the four block-scan priced tokens until the shared backrun planner dependency is
  either proven compatible or separated.

**Deterministic gates**

- Mixed source block/hash/graph/coverage joins are rejected.
- Enumeration result is identical to the current atomic runtime for the same view.
- No-candidate heads need not wait for unused workers.
- Positive-candidate heads preserve exact refine, plan, solve and final-sim results.
- Worker ownership has zero overlap across generations.

### R5 — changed-edge-first scanner priority

**Purpose:** reduce general multi-hop DFS after the state/discovery path is healthy.

**Precondition:** D0 shows enumeration remains material after R1/R3.

**Direction**

- Keep existing protocol-edge anchored enumeration.
- Use accumulated changed swap edges as anchors and close paths through the complete graph.
- Preserve pairwise fast path.
- Retain scan debt and bounded periodic full sweep.
- Compare against an unlimited full-DFS oracle for opportunities that become positive at N.

**Deterministic gates**

- Same positive route set as oracle for single-head, coalesced multi-head, skipped-scan and new-pool cases.
- No graph reduction and no closing-venue restriction.
- Candidate ordering changes are measured and reviewed; final-sim false positives do not increase beyond the
  predeclared bound.

### R6 — one-block-lag coarse fallback

**Purpose:** preserve scanner liveness when the complete source-N producer remains outside the usable
window after R1+R2, without allowing stale prices into execution.

**Precondition:** the independent B diagnostic has exercised the source-N recovery path and recorded its
phase failures. This is not the first-line repair.

**Direction**

- retain a precompleted, immutable N−1 coarse view before head N arrives. Do not first await a failed N
  state pass and then start fallback; by then the opportunity window is already consumed;
- expose the current-N exact execution context independently from completion of the full source-N pricing
  runtime. It must bind the N block/hash, current graph identity, funding view, worker leases and canonical
  CAS without publishing an incomplete normal runtime;
- enumerate from the complete N−1 coarse graph through a branded coarse-only envelope. It must not be
  accepted by any API that consumes a normal source-N `AdapterRuntimeSnapshot`;
- add current-N mutation anchors as described in §3.2.1;
- bind every candidate to both its coarse source and required exact source;
- require whole-route N repricing on the current graph and same-N funding/execution join before planner,
  solver, EV or final simulation;
- reject a route whose edge was removed or whose metadata/ownership identity changed at N;
- repeat the head/hash fence after final simulation and before EV/success publication. Dry-run results are
  subject to the same stale-head rejection as submission mode;
- keep proof-unavailable/off-event families explicit in the fallback coverage report. Their recall loss is
  not repaired by calling the N−1 view complete.

**Deterministic gates**

- no candidate can reach plan/solve/final sim with an N−1 mid;
- an EV-sign flip between N−1 and N is rejected;
- N−2 input, N mutation, deleted/changed edges, skipped-head, reorg and head-advance fixtures cannot reuse
  the stale candidate;
- planner, funding, workers, final simulation and success publication consume only the exact N graph/hash;
- a head advance after final simulation produces neither EV nor success output;
- unchanged-block route recall matches the source-N coarse oracle;
- changed/off-event recall losses are measured explicitly and never reported as full coverage.

## 5. Paired A/B contract

Systemic latency requires paired live evidence; one historical transaction cannot prove it.

### 5.1 Fixed inputs

- exact production graph/universe/config;
- same source blocks and hashes;
- equal CPU allocation and local-reth input;
- unchanged graph/edge/candidate/hop caps unless the experiment explicitly targets that dimension;
- no measured-window restart;
- startup/full-warm, budget-censored and unequal catch-up histories reported separately.

### 5.2 Factorial attribution

Run dependency-ordered variants where practical:

```text
A = current baseline
B = recovery-only state bases
C = B + shared mutation-proof transport
D = declared-venue policy only, if D0 proves it material
E = C + D, only after C and D are independently attributable
```

R1 is not tested without R2 because that arm knowingly retains the empty-published-snapshot deadlock. The
B→C delta attributes transport recovery; it must not be reported as an undifferentiated
“proof/carry” factor. Runtime join and scanner-anchor work receive later independent experiments.

Each deterministic micro-benchmark uses at least 20 interleaved repetitions per fixed block/hash. p95 uses
nearest-rank. Timeouts remain in the sample.

### 5.3 Required measurements

- head queue, discovery, graph/hash and publication wall time;
- pool incumbent/delta counts and RPC calls;
- mutation permit wait, header/log/CAS calls and bytes;
- per-family direct/carry/missing/unresolved/read/batch counts;
- pricing/funding/execution timings and funding asset/read counts;
- each worker reset;
- DFS expansions, rings, refine/plan/solve/final-sim counts;
- candidate identities and family composition;
- head-observed through final-decision wall time;
- final-sim positives, negatives and false positives.

## 6. Acceptance

### 6.0 Immediate independent-B live diagnostic

Before the paired latency experiment, freeze A's exact runtime configuration, budgets and universe, then
deploy the production changes as one isolated dry-run B process. The user has authorized stopping the
currently non-producing A process so B can use all eight node CPUs; B must keep
`SEARCHER_DRY_RUN=1` and `SEARCHER_BLOCKSCAN_SUBMIT=0`. This is a restore-output diagnostic, not an A/B win
decision and not the six-step fixed gate.

The source-N cohort is fixed at no more than three live rounds beginning with frozen runtime commit
`df4776b173948273ae7bbc0aa92c8d8873ce964d`:

- a round begins only after the B searcher initializes and starts a real source-N state attempt; checkout,
  dependency, environment or process-start failures do not count;
- each round records the first three eligible state attempts after startup, including timeouts and
  `priced=0`; no later favorable window may replace them;
- after a failed round, use the phase telemetry to make one scoped repair, rerun deterministic controls and
  deploy the new frozen SHA for the next round;
- one live source-N pass with `priced>0/28235` ends the immediate dead-output investigation, while the full
  restore-output label still requires the broader §6.1 coverage checks;
- if all three rounds fail to produce any source-N `priced>0/28235` pass, activate and implement the N−1
  coarse fallback in §3.2.1/R6 and report the delivery explicitly as degraded N−1 coarse pricing.

The immediate diagnostic passes only when one complete, non-startup/non-catch-up B block-scan pass reports:

- `priced > 0` against that generation's frozen expected-edge denominator. `0/28235` is the original
  incident signature, not a license to force the denominator to 28235 as the live graph evolves; the exact
  graph/view hash and denominator must be recorded and may not be reduced by the challenger;
- enumeration runs instead of being marked `not-run` because the state stage failed;
- the source block/hash remains current-N canonical;
- every `SEARCHER_BLOCKSCAN_*_BUDGET_MS` value and all other runtime configuration are inherited unchanged
  from A; increasing a deadline or pass budget cannot satisfy this gate;
- per-lane and per-family `resolved/expected/direct/carry/unresolved` coverage is recorded, and no family
  that passes deterministic current-N parity may be silently removed merely to make aggregate `priced`
  positive;
- no graph, universe, hop or candidate-cap reduction was used.

If B continues to report `priced=0/28235`, this slice has not restored output. Use the new phase telemetry to
locate the live failure, repair it on the same diagnostic branch, rerun deterministic controls, and redeploy
B until the criterion above passes or a genuine external blocker is identified. A passing result earns only
`blockscan_output_restored`; it does not establish the end-to-end latency or `fixed` gates below.

R1 and R2 are one deployment unit for this diagnostic. R1 must not be deployed by itself: a failed live pass
can publish an empty `stateByStateKey`, so transport recovery without the independent recovery-only
`lastGoodByStateKey` base can still produce zero carry.

The activated R6 diagnostic has a separate, explicit budget allocation. Its total state budget remains
frozen at `20000ms`; changing family settlement does not change that outer deadline. After six
`10000ms`-settle samples remained zero, one predeclared `12000ms`-settle cohort was allowed because a proof
had reached final CAS at `8969ms`. A move directly to `15000ms` was rejected: the observed abort-drain and
publication tail was `4.4–6.1s`, so that allocation would leave insufficient outer/CAS reserve. The
`12000ms` result may satisfy only the degraded N−1 pricing sub-goal. It cannot satisfy the source-N
immediate diagnostic, §6.1 restore-output gate, §6.2 latency gate or §6.3 fixed gate.

### 6.1 Restore-output gate

All are required:

- `priced > 0` and enumeration runs on healthy hot heads;
- no global `priced=0` caused by one incremental proof failure;
- expected graph/edge set is not below the frozen baseline;
- every published mid has direct-N or complete carry-forward provenance;
- V2/V3 quiet-block carry succeeds; V4 dynamic-fee remains direct;
- injected family failure preserves healthy siblings and recovers/fails closed on the next target;
- reorg and supersession tests pass.

Passing this gate permits only the label `blockscan_output_restored`.

### 6.2 End-to-end latency gate

All are required:

- p95 `head observed → final decision` is `< 10,000 ms`;
- queue time and every timeout/skipped pass count in the distribution;
- a positive-candidate sample reaches final simulation within the same bound;
- no universe/graph/candidate-cap reduction;
- output/route-set equivalence and final-sim false-positive contract pass;
- paired Hermes A/B fairness and reviewer gates pass.

A state or enumeration substage consuming the entire 10 seconds fails this gate even if its own timer does
not expire.

### 6.3 Fixed gate

This systemic change is `implemented_not_validated` until:

1. deterministic parity/recovery/reorg suites pass;
2. the predeclared cohort A/B contract passes;
3. scanner naturally enumerates at least one real positive opportunity;
4. production planner/solver executes it;
5. final simulation succeeds;
6. end-to-end p95 remains below 10 seconds without reducing coverage.

Only then may the result be called `fixed`.

## 7. Execution ledger

| Slice | Status | Commit | Deterministic evidence | Live/A-B evidence |
|---|---|---|---|---|
| Plan | complete | `6aefbf0`, `b13ef45` | implementation contract frozen before behavior changes | n/a |
| D0 instrumentation | implemented | `098e2cb` | backend/coordinator/runtime tests and TypeScript build pass | pending production timing sample |
| R1 mutation proof | implemented, live-insufficient | `a156cf5`, `e59cdd5`, `df397c1` | completed exact-range header reuse, independent header/descriptor/final-CAS transports, bounded descriptor concurrency, off-path log/final-CAS rejection, abort and reorg controls pass | Round 3 still produced three hot source-N failures; proof calls reached `header-read:deadline` after discovery/queue time had already depleted the window |
| R2 recovery bases | implemented; live partial | `8f741b4`, `d685a1e` | degraded-N/healthy-N+1 recovery, sibling isolation, family-local partial publication, generation-abort, schema and reorg controls pass | UniV2 carried 7,327 and 7,324 state keys in the first two non-zero N−1 live publications |
| R3 discovery policy | not started; precondition unmet | n/a | D0 code exists, but no live evidence that the six declared venues are material | pending D0 live attribution |
| R4 runtime join | not started; live precondition met | n/a | no code change | adjacent N−1 consumption failed exact funding-context preparation with about `211ms` left, before enumeration |
| R5 scanner priority | not started; precondition unmet | n/a | scanner production-boundary control passes unchanged | pending post-R1/R3 live attribution |
| R6 N−1 coarse fallback | implemented; pricing live-nonzero; consumer incomplete | `1b486aa`, `6297b4b`, `ef4caa0`, `d685a1e`, `9961b18` | stale coarse-envelope rejection, exact-source join, head/hash fence, compact header proof, publication reserve, family-local partial, outer-abort and live-validated default controls pass | `14649/30979` and `14640/30981` published under the fixed `20000ms` outer budget; adjacent enumeration/planner/final sim did not run |

### 7.1 Implementation evidence

`tool-index --check` passed with 244 indexed tools. A selection manifest was generated with nonce
`14f8baf2-89d2-4e47-8fef-f2291872f8ef`; after execution its SHA-256 is
`bf2d624b82dabd36fc7d2988ad55074b23e6d80081570b543172b3144e6eaa25`.

The following commands were actually invoked through `tool-run`; every recorded receipt has `exit_code=0`:

- `listener:searcher:blockscan-state-backend` (run again after restoring the production concurrency default);
- `listener:searcher:blockscan-state-coordinator`;
- `listener:searcher:v2-v3-incremental-state`;
- `listener:searcher:univ4-incremental-state`;
- `listener:searcher:adapter-runtime-coordinator`;
- `listener:searcher:blockscan-runtime-startup-warm`;
- `listener:searcher:protocol-blockscan-state`;
- `listener:searcher:swap-blockscan-state`;
- `listener:searcher:adapter-family-blind-challenger-runtime`;
- `listener:searcher:blockscan-scanner-production-boundary`;
- `listener:searcher:runtime-defaults`.

The listener TypeScript build also passes.

The scoped Round-3 R1 repair was reconciled again through generated `tool-index`/`tool-run` manifest
`/private/tmp/blockscan-round3-r1-tools.json`, SHA-256
`09078222c842ebd5bbe95c9285a1a74cc8be09ae2a9d357f5f511938db53acf5`. Its six recorded receipts
(`blockscan-state-backend`, `blockscan-state-coordinator`, `v2-v3-incremental-state`,
`univ4-incremental-state`, `adapter-runtime-coordinator`, `blockscan-runtime-startup-warm`) all have
`exit_code=0`.

The final family-local repair was reconciled through a newly generated manifest
`/private/tmp/blockscan-nminus1-partial-family-tools.json`, nonce
`d164c483-71dd-46ca-8603-24c0476bb021`, final SHA-256
`cd59dd9213c44f970f73e989153f67fd863487d48ea4b68b05ba9c7382227d08`.
Actual `tool-run` receipts for `blockscan-state-coordinator`, `blockscan-runtime-startup-warm`,
`v2-v3-incremental-state`, `univ4-incremental-state`, `adapter-runtime-coordinator` and
`runtime-defaults` all recorded `exit_code=0`; `tool-index --check` still reports 244 tools.

After promoting the successful `12000ms` family allocation into the production default at `9961b18`, a
fresh generated manifest `/private/tmp/blockscan-nminus1-family12-tools.json` requested
`blockscan,state,runtime`, nonce `e10d40c8-2f03-4cb6-bf8e-17dc558329c6`, final SHA-256
`51d95ffc859f3d5c0c62e523295a258239289443a6ca6c8a87a761c79bbb7e1e`.
Actual `tool-run` receipts for `blockscan-runtime-startup-warm`, `blockscan-state-backend`,
`blockscan-state-coordinator` and `runtime-defaults` all recorded `exit_code=0`; both listener TypeScript
builds passed.

This evidence establishes **implemented deterministic controls plus degraded N−1 non-zero pricing**. No
paired live A/B cohort, natural positive scanner enumeration, production plan/solve, successful final
simulation or end-to-end p95 below 10 seconds has been produced on this branch. Therefore the current
verdict is `implemented_not_fixed`; the narrow N−1 pricing liveness sub-goal is restored, but
`blockscan_output_restored` and `fixed` are both forbidden.

### 7.2 Independent-B source-N rounds

| Round | Frozen runtime | Fixed inputs / first cohort | Result | Next action |
|---|---|---|---|---|
| 1 | `df4776b173948273ae7bbc0aa92c8d8873ce964d` | A configuration and budgets (`pass=11000ms`, `largeGraph=30000ms`), frozen universe `active-pools-9dd1…be1.json`; first state attempts at blocks `25623452`, `25623459`, `25623460` | failed before pricing: `state_block=null`, enumeration `not-run`; `canonical header 25620597 fell outside retained journal`. The first attempt spent `92220.97ms`; later attempts failed immediately against the same stale prepared source. | `8e3e32d`: invalidate an out-of-retention prepared DEX/protocol generation and reschedule from the current canonical head. Regression expands startup-warm control to 18/18. |
| 2 | `ea9f3e0f6df34e32a6ff3db4859da601106b1beb` | same budgets; universe SHA-256 `9dd1d403…39be1`; stopped A's 240-instance protocol cache; startup source-N snapshot `25623518`, then first three eligible hot attempts `25623530`, `25623533`, `25623536`; expected denominator `30407` | failed hot source-N output gate. Cold startup eventually published `priced=28893/30401`, but took `166212.74ms`, was already behind the head and intentionally did not enumerate. The first three eligible hot attempts all published `priced=0/30407`, enumeration `not-run`, with state wall `34247.03ms`, `34399.02ms`, and `35046.98ms`. UniV2/UniV4 reported `mutation-range-failed`, detail `header-read:deadline`; their proof telemetry showed zero header RPCs, consistent with waiting behind the shared single proof slot. | repair R1 so the exact `(fromSource, throughSource)` completed header proof remains reusable for the generation and header reads cannot queue behind descriptor log/CAS work; run deterministic controls, then deploy Round 3 with unchanged budgets/coverage |
| 3 | diagnostic `95339d99c624b2552b1b8c957fb5da633a48f5ee` from canonical repair `df397c1` | same budgets and full graph; A stopped; B used all eight CPUs; descriptor concurrency default `3` with no environment override; startup source `25623632`, then eligible hot attempts `25623642`, `25623645`, `25623648`; denominators `30515–30521` | failed source-N output gate. Startup published `priced=29907/30513` in `126545.06ms`. Hot attempts produced `priced=0` with state walls `31564.98ms`, `28548.70ms`, `28639.35ms`; the third enumerated for `4469.20ms` but hit `scanner_deadline`, with no exact refine/plan/final sim. Mutation proofs still failed `header-read:deadline` with zero header RPCs after discovery/queue depleted the deadline. Archived log SHA-256 `b23840a4…6f0f`, events SHA-256 `39c38fd7…aa8`. | activate R6 degraded N−1 coarse fallback; preserve full graph, require current-N whole-route exact reprice and same-N execution join |

Round 1 used an empty diagnostic-worktree protocol cache while A's stopped cache contained 240 verified
instances. That mismatch did not cause the observed pre-pricing canonical-journal failure, but Round 2 pins
the stopped A cache so graph coverage is not silently reduced. A's denominator had evolved from the earlier
`28235` incident value to approximately `29937–30007` immediately before shutdown; each round therefore
records its exact graph identity and denominator instead of hardcoding an obsolete total.

Round 2 also exposed two distinct liveness facts that must not be conflated:

- the recovery-only bases work after a successful cold snapshot (`missingPreviousStateKeys=0` on the hot
  Uni families), so the former empty-shell deadlock is no longer the immediate blocker;
- the R1 backend shares only an in-flight header Promise and deletes it as soon as that read settles, while
  one `mutationProofSlots` semaphore still serves headers, descriptor logs and final CAS. A family starting
  after the first header settled can therefore enqueue a redundant header behind another family's
  `eth_getLogs`, exhaust its family deadline, and force a full current-N fallback. This is the scoped Round-3
  repair target; increasing a budget is forbidden.

Round 3 closed that experiment:

- the completed-header cache and separate transports are deterministic improvements, but they did not
  restore live source-N output under the frozen budgets;
- the first three eligible hot source-N attempts are the predeclared stopping point. Later favorable heads
  cannot replace them;
- R6 is therefore activated exactly as the user-authorized degraded fallback. This does not waive the
  current-N exact-reprice, same-N join, final canonical fence or fixed-gate requirements.

### 7.3 Independent-B N−1 fallback rounds

All rows used the same full production universe (`active-pools-9dd1…be1.json`), all eight CPUs with A
stopped, dry-run, submission/backrun/mempool disabled, and no graph/hop/candidate-cap reduction.

| Frozen diagnostic runtime | Fixed N−1 allocation | First declared evidence | Verdict |
|---|---|---|---|
| `4bcf1d9` | total `20000ms` | source `25623860`: `priced=0/30645`, wall `27368ms` | failed outer deadline; compact canonical-header transport required |
| `c55f614` | total `20000ms` | source `25623976`: `priced=0/30853`, wall `10366ms` | transport improved, publication still empty |
| `c55f614` | diagnostic total `35000ms` | source `25624025`: `priced=0/30845`, wall `11244ms` | increasing budget did not repair the empty publication; this row cannot satisfy an acceptance gate |
| `057669f` | total `20000ms`, publication reserve `1500ms` | source `25624139`: `priced=0/30911`, wall `22782ms` | family results settled after the boundary and were discarded |
| `d161cbb` | total `20000ms`, family settle `10000ms` | first six hot attempts all `priced=0`; representative source `25624216`: `0/30933`, wall `14289ms` | safe partial mechanism implemented, but local proof/direct-read starvation remained |
| `d161cbb` | total `20000ms`, family settle `12000ms` | sources `25624260`: `14649/30979` in `15879ms`; `25624261`: `14640/30981` in `17744ms`; later source `25624266`: `27717/30985` in `15829ms` with V2/V3/V4 carry | degraded N−1 pricing live-nonzero; two adjacent exact-context attempts failed before enumeration, so not output-restored/fixed |

Immutable archived evidence:

- pre-raw log/event SHA-256:
  `5d863caca75035d3124c097b7e953fe3d187ef3ca7d08385ed71c6a390f9a5ea` /
  `eddbc5aeaff667dd58cb785a14db9a6911e264ae887a4c8a081ec4455d19eba8`;
- raw-20 log/event:
  `4b635cace7a470f517aacd6e616a566920711bf2d1580c94671c6691d0c57dac` /
  `98c1093e227128f6a603b4c7abb216d87e8ea37002952672acc1cf71c1760082`;
- raw-35 log/event:
  `1d688341b0fdd3c3b6ac25bc5fd786ab065541fb766572ec4da7d4a203974142` /
  `e09b6d8547ce733dd075f2666e2822b2cd2de89c08fecf16bd476b2d8870d1f9`;
- publication-reserve log/event:
  `0d62337575749d892f955bea4b00b255fd4d424f6ed59ddd7e3fa97daf3b8e52` /
  `e92570d9533a88eaa59c07cae91ebac17f948007876673e4408bbdda72d4df29`;
- family-10 log/event:
  `a625895752b8e9269917bc773323054bc0b9534c2ae8e8982f9ce4e83d5d5a5a` /
  `9fe11c1c8cc2303db205893e4dc86c096e74810f4ed2e40b1753554f819c631a`;
- successful family-12 log/event:
  `d8e4b27a1508bb574ed28128935b9cb2841065f2bb6fe486d8c9cac601fef0ce` /
  `0247a8991f9d43e528525b842e8b02c22542e625f82732c8fca9ac60135eda99`.

Both A and diagnostic B were inactive when the successful family-12 evidence was sealed.

## 8. Stop and rollback rules

- Any stale/mixed-source publication, reorg acceptance or graph reduction stops the slice immediately.
- A micro-benchmark improvement with semantic divergence is a loss, not a tradeoff.
- If R1 restores output but misses the latency gate, retain it as an independently useful recovery patch and
  continue to R3; do not mislabel it as the complete fix.
- If a later slice has no measured critical-path contribution, revert that slice instead of preserving
  speculative architecture.
- No mainnet broadcast occurs during implementation or deterministic validation.
