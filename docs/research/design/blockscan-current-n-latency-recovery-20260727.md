# Block-scan current-N latency recovery plan

> Status: D0/R1/R2 implemented and deterministically validated; paired live A/B and fixed gate pending
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
- Coarse scanner enumeration consumes graph + pricing mids + configured `pricedTokens`; it does not consume
  the live funding snapshot. Exact refinement, planning and final simulation still require a correctly
  pinned execution/funding context.

### 2.2 Not yet proven

- That semaphore wait is the sole mutation-range failure.
- That mutation-proof recovery alone produces an end-to-end pass below 10 seconds.
- That delaying funding or worker preparation improves a positive-candidate block.
- That one Anvil worker is faster than four under real contention.
- That changed-edge-first enumeration is complete without scan-debt recovery.
- That the solver and final simulation fit into the time left after state and enumeration.

No slice may present one of these hypotheses as a fact before its declared measurement.

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

Run independent variants where practical:

```text
A = current baseline
B = declared-venue policy only, if D0 proves it material
C = shared mutation proof/carry only
D = B + C, only after B and C are independently attributable
```

Runtime join and scanner-anchor work receive later independent experiments. Do not mix them into B/C/D.

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
| R1 mutation proof | implemented, not live-validated | `a156cf5`, `e59cdd5` | canonical-path sharing, exact-descriptor dedupe, bounded concurrency, abort and reorg controls pass | concurrency 1/2/3 paired A/B pending; default remains 1 |
| R2 recovery bases | implemented, not live-validated | `8f741b4` | degraded-N/healthy-N+1 recovery, sibling isolation, schema and reorg controls pass | pending |
| R3 discovery policy | not started; precondition unmet | n/a | D0 code exists, but no live evidence that the six declared venues are material | pending D0 live attribution |
| R4 runtime join | not started; precondition unmet | n/a | no code change | pending D0/R1 live attribution |
| R5 scanner priority | not started; precondition unmet | n/a | scanner production-boundary control passes unchanged | pending post-R1/R3 live attribution |

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

This evidence establishes **implemented and deterministic parity/recovery coverage only**. No paired live
A/B cohort, natural positive scanner enumeration, production plan/solve, successful final simulation or
end-to-end p95 below 10 seconds has been produced on this branch. Therefore the current verdict is
`implemented_not_validated`, not `blockscan_output_restored` and not `fixed`.

## 8. Stop and rollback rules

- Any stale/mixed-source publication, reorg acceptance or graph reduction stops the slice immediately.
- A micro-benchmark improvement with semantic divergence is a loss, not a tradeoff.
- If R1 restores output but misses the latency gate, retain it as an independently useful recovery patch and
  continue to R3; do not mislabel it as the complete fix.
- If a later slice has no measured critical-path contribution, revert that slice instead of preserving
  speculative architecture.
- No mainnet broadcast occurs during implementation or deterministic validation.
