# Unified strategy × edge — fusion architecture + implementation spec (author A, 2026-07-04)

> Scope: authorized, defensive on-chain arbitrage research; mainnet fork + dry-run; broadcast is a
> human-gated step. This is the buildable **HOW** that MERGES the atomic-arb EPIC
> (`coffee-20260704-atomic-epic-impl-plan.md`) and the credit-venue edge
> (`credit-venue-landing-plan-20260704.md` + ADRs) into ONE plan Codex executes against. It BUILDS ON
> the settled 4-way reconciliation verdict
> (`arch-reconciliation-atomic-vs-credit-20260704-3way-synthesis.md`) — it does not re-open it.
> Independent author A of three (two fresh fable + orchestrator), written blind.
> Every non-trivial claim is anchored to `file:line` re-verified against the working tree.

## 0. One-line fusion

**Build ONE spine first (types + learning + coordinator + block-scan lane/view), THEN fork into two
edge/strategy runtimes (block-scan scanner, credit adapter) that plug in without colliding.** Both
source workstreams independently CREATE the same four components (`Opportunity` union, `LearningCase`,
`SubmissionCoordinator`, second execution lane/view); building them once, on the credit
`strategy_kind × edge_kind` spine, is the whole merge. Atomic-arb is absorbed as the
`strategy_kind:"block-scan" × edgeKind:"swap"` cell — a naming + type re-parent, its engineering body
(scanner, seedEdges planner binding, A-lane isolation, fresh-read gate, telemetry) survives intact.

**Ordered FOUNDATION (build once, before any strategy/edge runtime):**
`F1 unified types → F2 LearningCase-by-extension → F3 SubmissionCoordinator → F4 block-scan lane + AtomicView/A-universe views`.
Then FORK: **block-scan scanner** (A0/A1/A2/A3/A4) ∥ **credit adapter** (C3/C5/C6/C8); **backrun**
already exists, re-labelled `strategy_kind:"reactive"`.

**Verdict adjustments: none.** Two clarifications recorded inline (§5): (i) `edgeKind` is a NEW axis,
not a rename of the existing `slotKind` — they co-exist and `edgeKind` derives from the adapter kind;
(ii) `VenueEdge.quote()/build()` are a **typing/dispatch layer over the existing adapter registry**
(credit slice 4), latency-gated and OPTIONAL in the foundation — the data fields
(`edgeKind`/`leavesStandingPosition`) ship in F1, the methods do not block the foundation. Both are
elaborations consistent with the verdict (the verdict itself flags fluid's 2-D quote as non-flat), not
disagreements.

---

## 1. Unified model (types)

### 1.1 Strategy axis — re-parent the `Opportunity` union onto `strategy_kind` — `detector/detector.ts` (MODIFY)

Verified today (`detector/detector.ts:6`): the union already carries `kind: "backrun-arb"`. The spine
decision **renames the discriminator `kind → strategy_kind`** and the values
`backrun-arb → reactive`, `atomic-arb → block-scan`. Principal-safety is NEVER a strategy value — it is
an edge property (§1.2). This is the single highest-friction change (§4/§5); do it in F1 before any
runtime slice threads `kind:"atomic-arb"` through the hot path.

```ts
// detector/detector.ts
export interface ReactiveOpportunity {          // today's shape; ONLY the discriminator renames
  strategy_kind: "reactive";                    // was: kind:"backrun-arb"
  victimTxHash: string;
  blockNumber: number;
  affectedPools: string[]; affectedTokens: string[];
  startToken: string; profitToken: string;
  victimAmountIn: bigint;
  targetNetProfit?: bigint;
  hints: Record<string, unknown>;
}

export interface BlockScanOpportunity {         // absorbs atomic-arb §1.1 AtomicOpportunity verbatim
  strategy_kind: "block-scan";                  // was: kind:"atomic-arb"
  sourceBlock: number;                          // scan read block; target = sourceBlock+1
  stateBlock: number;                           // per-pool fresh-read evidence (§3 block-scan A4)
  cycleId: string;                              // canonicalTokenRing(ring).join(",") — block-free identity
  cycleFingerprint: string;                     // cycleFingerprint(sourceBlock, ring) — the F2 join key
  seedEdges: VenueEdge[];                        // the EXACT ordered cycle (was TokenEdge[]; widened — §1.2)
  affectedPools: string[]; affectedTokens: string[];
  startToken: string; profitToken: string;      // both === flashToken
  flashToken: string;                           // pinned by scanner; planner MUST NOT rotate
  searchSeed: { searchCenter: bigint; maxInput?: bigint };  // flashToken units, center > 8n
  estSpreadBps: number;                         // ranking/telemetry only — never identity
  targetNetProfit?: bigint;
  hints: Record<string, unknown>;               // MUST NOT contain hints.impact
}

export type Opportunity = ReactiveOpportunity | BlockScanOpportunity;
```

TypeScript makes the migration exhaustive: every `opp.victimTxHash`/`opp.victimAmountIn` read errors
until narrowed by `opp.strategy_kind` (compile-audit surface: `main.ts`, `events.ts`, `planner.ts`,
`solver.ts`, `detector/*`, tests). `BackrunDetector.detect()` still returns `ReactiveOpportunity[]`
(one field rename at the single construction site).

**Note — `strategy_kind` vs shipped C1's `tx-shape` output.** The searcher-side `strategy_kind` is the
RUNTIME discriminator on OUR opportunities. The analysis-side `tx-shape.ts:20` classifies a
COMPETITOR tx as `"atomic_state_arb" | "backrun" | "unknown"`. F2 maps between them
(`atomic_state_arb → block-scan`, `backrun → reactive`); do NOT unify the two enums (one is our intent,
one is a chain observation) — map at the F2 boundary.

### 1.2 Edge model — `VenueEdge` widens `TokenEdge` — `planner/token-graph.ts` (MODIFY) + `venues/edge.ts` (CREATE type home)

Verified today (`token-graph.ts:15` `TokenEdge`; `:20` `slotKind:"flash"|"lend"|"swap"`; the wired
Fluid vault is already a `slotKind:"lend"` edge). `VenueEdge` is a **strict superset** — add two fields,
change no existing one:

```ts
// planner/token-graph.ts — widen TokenEdge in place (superset; refactor-neutral for swap edges)
export interface TokenEdge {
  adapterId: string; target: string; tokenIn: string; tokenOut: string;
  slotKind: "flash" | "lend" | "swap";           // UNCHANGED — mechanical/flash-role axis
  // NEW (F1): the venue-family axis + the principal-safety property
  edgeKind?: "swap" | "credit" | "lp";            // default "swap"; derived from adapterId/slotKind
  leavesStandingPosition?: boolean;               // default false; credit(abandon-exit)=true
  // …existing curveI/curveJ/poolToken0/1/score/v4PoolKey/poolId/nativeCurrency0/1 unchanged…
}
export type VenueEdge = TokenEdge;                 // alias: the name used where edgeKind matters
export type EdgeSequence = VenueEdge[];            // an ordered routed cycle/path (= seedEdges / TokenPath.edges)
```

**Two axes, not one (verdict clarification §5-i):** `slotKind` is the existing flash/lend/swap
mechanical role; `edgeKind` is the new venue-family. They correlate but are distinct — `slotKind:"lend"`
(Fluid) ⇒ `edgeKind:"credit"`, `slotKind:"swap"` ⇒ `edgeKind:"swap"`. `edgeKind`/`leavesStandingPosition`
are POPULATED at graph-build time in `defaultTokenGraph`/`buildTokenGraph` from a single
`adapterId → {edgeKind, leavesStandingPosition, gasEstimate}` table (`venues/edge.ts`). A swap edge is
`{edgeKind:"swap", leavesStandingPosition:false}`; the Fluid credit edge is
`{edgeKind:"credit", leavesStandingPosition:true}`.

**`quote()`/`build()` are a dispatch LAYER, not a foundation blocker (verdict clarification §5-ii).**
The adapter registry (`solver/quoter.ts` dispatch, `solver/plan-builder.ts`, `venues/capability.ts`,
the ActionAdapter registry) already IS the polymorphism. F1 ships only the DATA fields above; adding
literal `edge.quote(amountIn)`/`edge.build(...)` methods is credit slice 4 (§3 credit-adapter), which
is **OPTIONAL and latency-gated** because today's quote path is deliberately non-uniform
(`quoter.ts:358` `quoteFluidVault()` throws — fluid is a 2-D solver search, NOT a 1-D quote). Credit's
extra free variable (borrow size / LTV) must stay explicit; a uniform 1-D `edge.quote()` MUST NOT
flatten it (credit invariant #4).

`atomic-arb.seedEdges: TokenEdge[] → VenueEdge[]` is a no-op widening (all `edgeKind:"swap"`); the
no-DFS `planAtomicFromSeedEdges` (§3) is a planner branch on `opp.strategy_kind`, orthogonal to
`edgeKind` — atomic-arb is a genuine subset of the spine.

### 1.3 `LearningCase` — one strategy-agnostic schema — `analysis/src/learning/learning-case.ts` (CREATE)

Merges atomic-arb §1.5 (already `strategy`-tagged, forward-only status, id-idempotent) with the credit
funnel-ordered `primary_gap` taxonomy (adds `non_comparable_winner` + `standing_position_required`).

```ts
export type LearningCaseStage =
  | "not_scanned" | "cycle_not_found" | "no_plan" | "no_quote" | "sizing_failed"
  | "sim_failed" | "below_ev" | "submitted_lost" | "replay_state_unavailable";

export interface LearningCase {
  learning_case_id: string;   // keccak(strategy|trigger|competitor_tx|source_block|cycle_fingerprint|primary_gap)
  status: "open" | "proposed_close" | "replay_passed" | "applied" | "live_verified"
        | "parked_uneconomic" | "manual_required";
  strategy: "reactive" | "block-scan";            // NOT "backrun"|"atomic" — spine names (verdict)
  edge_kinds: ("swap" | "credit" | "lp")[];        // which edge families the winner/our-route used
  trigger: "bundle_not_included" | "competitor_not_seen";
  competitor_tx?: string; our_opportunity_id?: string;
  source_block?: number;                           // block-scan: competitor_execution_block − 1 (temporal B−1)
  target_block?: number;                           // block-scan: competitor_execution_block
  cycle_fingerprint?: string;
  comparable: boolean;                             // winner_style atomic_loop only; else false
  primary_gap: string;                             // §1.4 converged taxonomy (first blocking gap, funnel order)
  secondaryGaps?: string[];                        // atomic_* distinctions map here, NOT a parallel enum
  our_stage?: LearningCaseStage;
  // P1-5 view attribution (a close is provable only if the stage flip tracks a view change):
  strategy_view_version?: string; atomic_view_hash?: string; backrun_view_hash?: string;
  // P1-4 capability vs live-admission (from AtomicReplayReport):
  capability_replay_stage?: string; live_admission_stage?: string;
  // credit standing-position gate:
  leaves_standing_position?: boolean;
  evidence: Record<string, unknown>;
  close_action?: { kind: string; target_file?: string; entries?: string[] };
  replay_gate?: { command: string; expected_transition: string; before?: string; after?: string };
  created_at: string; updated_at: string;
}
```

Store: `analysis/learning-cases/store.json` (committed — small derived JSON, no secrets; durability
rationale = `force-include-poolids.json`). API `loadCases()/upsertCase(c)/advanceStatus(id,next)` —
forward-only (`open→proposed_close→replay_passed→applied→live_verified`; terminals
`parked_uneconomic`, `manual_required`). `parked_uneconomic` re-opens only on the same `cycleId`
reappearing with `estSpreadBps ≥ k×` parked (default k=3). Replay-verdict cache
`analysis/learning-cases/replay-cache/<id>.json` (gitignored; one replay per case-version — CU cap).

### 1.4 Converged `primary_gap` taxonomy (funnel-ordered, strategy-agnostic)

```
# pre-funnel intake (opportunity never entered the funnel)
source_not_seen | view_missing | edge_kind_disabled | atomic_scan_not_triggered
# routing / quote
venue_missing | path_not_found | atomic_cycle_not_found | quote_failed | atomic_sizing_failed
# simulation / economics
sim_failed | below_ev | gas_underwater | liquidity_or_cap_bound
# submission
outbid | lost_intra_lane_priority | submission_arbitration_lost | atomic_preempted_by_backrun
# terminals (no coverage close)
non_comparable_winner            # winner_style one_leg_inventory/sandwich/JIT — we correctly did nothing
standing_position_required       # credit policy gate — NOT a coverage fix (human authorization)
oracle_not_diverged/edge_inactive   # credit true-negative
replay_state_unavailable | manual_required
```

`primary_gap` = the FIRST blocking gap in funnel order; deeper distinctions go in `secondaryGaps[]`.
**Admission precedes routing (P1-4):** a ring found by full-sweep replay whose source block was not
delta-triggered ⇒ `atomic_scan_not_triggered` (scheduling — owner block-scan A4), NEVER
`atomic_cycle_not_found` (scanner logic — owner A1/A2). `non_comparable_winner` is load-bearing —
without it the loop manufactures phantom coverage gaps
([[project-cex-dex-inventory-competitor-noise]]).

### 1.5 Cycle identity — `listener/src/searcher/detector/cycle-fingerprint.ts` (CREATE)

Lives in **listener** (analysis imports it relatively — precedent `analysis/.../live-loss.ts:15`) so
both sides share ONE join key. Verbatim from atomic-arb §1.2: `canonicalTokenRing(ring)` (rotate
lowest-address-first, orient smaller-2nd-element) + `cycleFingerprint(sourceBlock, ring)`. Temporal
rule (user point 1): a competitor tx executing in block `B` joins at `cycleFingerprint(B−1, ring)`.

---

## 2. Shared FOUNDATION slices (build once, in order, before any strategy/edge runtime)

Each foundation slice = one Codex brief (rule 7/11: Claude plans → Codex writes → Claude gates +
commits). Rule-12 form throughout.

### F1 — unified types (spine decision, first cut) — absorbs credit slice 1 + atomic A-contract types

**Status: GO (first — gates everything).**

| action | path | change |
|---|---|---|
| MODIFY | `listener/src/searcher/detector/detector.ts` | §1.1 union re-parent (`kind→strategy_kind`, values `reactive`/`block-scan`; `BackrunOpportunity→ReactiveOpportunity`, add `BlockScanOpportunity`) |
| MODIFY | `listener/src/searcher/planner/token-graph.ts` | §1.2 widen `TokenEdge` (+`edgeKind?`,`leavesStandingPosition?`); `export type VenueEdge/EdgeSequence` |
| CREATE | `listener/src/searcher/venues/edge.ts` | `adapterId → {edgeKind, leavesStandingPosition, gasEstimate}` table (next to `capability.ts`); populate at graph-build |
| CREATE | `listener/src/searcher/detector/cycle-fingerprint.ts` | §1.5 |
| MODIFY | `listener/src/searcher/events.ts` | optional `victim_hash`; atomic fields; `atomic_scan_result`; `strategy_view_version`/`atomic_view_hash`/`backrun_view_hash`; `makeAtomicOpportunityId`; new `pipeline_dropped` reasons (`atomic_stale_target_block`, `submission_arbitration_lost`, `dedup_per_block`, `atomic_state_inconsistent`, `atomic_preempted_by_backrun`, `credit_infeasible`, `credit_stale_oracle`, `standing_position_required`) |
| CREATE | `analysis/src/learning/learning-case.ts` | §1.3 schema + store API |
| MODIFY | `listener/src/searcher/execution/bundle-router.ts` | `victimTxHash?: string` (standalone path already ignores it, `:81`; today required at `:6`) |
| CREATE | `listener/src/searcher/test/atomic-contract.ts` (`searcher:atomic-contract`) + extend `test/planner.ts` `REPLAY_FIXTURES` | the gate |

Fluid vault edge gets `{edgeKind:"credit", leavesStandingPosition:true}` in the table (its
`slotKind:"lend"` is unchanged). All swap edges default `{edgeKind:"swap", leavesStandingPosition:false}`.

**Code direction:** pure type + emission surface. No behavior change beyond the discriminator rename —
`detect()` still returns `ReactiveOpportunity`; graph-build stamps the two new edge fields; events gain
OPTIONAL fields (backrun emission sites keep passing `victim_hash`, no backrun event changes shape).

**Rule-12 gate (deterministic):**
- `replay_command:` `cd listener && npm run searcher:planner && npm run searcher:replay-live-fixtures && npm run searcher:atomic-contract` + `cd analysis && npm test`
- `expected_transition:` backrun suites pass UNCHANGED (14/14 + live-fixture profit equivalence 1 wei;
  `searcher:ac3` wstUSR replay unchanged); `token-graph` build stamps Fluid edge
  `edgeKind:"credit"/leavesStandingPosition:true` and every swap edge `edgeKind:"swap"/false` (unit
  assert); `cycle-fingerprint` invariants (2 rotations × 2 directions ⇒ same fingerprint; distinct
  rings ⇒ distinct; size/venue not in identity); `LearningCase` store round-trips + forward-only
  status rejects a backward transition. `verdict: fixed` requires all green.

### F2 — LearningCase by EXTENSION over bundle-postmortem/census — absorbs credit slice 2 + atomic C1 (shipped) + atomic C2 build

**Status: GO (after F1). Never a parallel path (rule 16).**

Shipped C1 (`0fb1566`/`975ebc2`/`cbbdf1f`) is the entry and is CORRECT — verified
`analysis/src/pnl/tx-shape.ts:20` already emits `shape:"atomic_state_arb"|"backrun"|"unknown"`; the
only change here is re-labelling its OUTPUT to `strategy_kind` at the F2 map boundary
(`atomic_state_arb→block-scan`, `backrun→reactive`); `sender-flow.ts`/`swap-log-registry.ts`/
`victim-source.ts` reused AS-IS.

| action | path | change |
|---|---|---|
| MODIFY | `analysis/src/cli/bundle-postmortem.ts` | emit a `LearningCase` (reuse `winner_style`/`route_gap_decisive`/`in_graph` → `primary_gap`, incl. `non_comparable_winner`); `strategy:"reactive"` |
| MODIFY | `analysis/src/cli/census-report.ts` | emit `LearningCase` per competitor tx; carry `atomic_scan_shape` (followable vs non-followable) next to `winner_style`; map `tx-shape.shape → strategy_kind` |
| CREATE | `analysis/src/cli/strategy-compare.ts` (`strategy-compare`) | the block-scan comparison CLI (C2 body; see §3 block-scan for the replay half) |
| MODIFY | `analysis/src/pnl/sender-flow.ts` | split single `flow` axis (`:44` bug): `submission_method` + `source_visibility` (`seenInOurPublicFeed` FIRST); migrate `bundle-postmortem`/`census` readers off `flow:"private"` |
| MODIFY | `analysis/src/cli/hermes-gate.ts` | tolerate optional `victim_hash`; `intake_audit` reads the pre-funnel not-seen lens off `LearningCase` |

**Where both source enums feed `primary_gap`:** shipped-C1 `tx-shape.shape`/`census.atomic_scan_shape`
→ decides `comparable` + `strategy` (a followable backrun vs a block-state loop); credit
`bundle-postmortem.winner_style`/`route_gap_decisive` → decides `non_comparable_winner` vs a real
`venue_missing`/`atomic_view_missing_venue`. Both converge into the ONE `LearningCase.primary_gap`.

**Rule-12 gate (deterministic, replay on existing fixtures):**
- `expected_transition:` `0xa32b…8b2f68 → primary_gap=venue_missing` (pool gap, was CLOSED as such);
  `0xee7b98ad… → non_comparable_winner` (terminal, comparable=false); the 9 pinned coffee txs → 8
  `strategy:block-scan` + 1 `strategy:reactive`; `0xf88b… → edge_kinds:["credit"]`; re-run twice ⇒ 0
  new cases / 0 status regressions (idempotency). Command: `cd analysis && npm test` +
  `npm run strategy-compare -- --fixtures coffee-20260704`.

### F3 — `SubmissionCoordinator` — `listener/src/searcher/execution/submission-coordinator.ts` (CREATE)

**Status: GO (after F1). Absorbs atomic §1.4 == credit slice 7's coordinator.** Directory today holds
only `bundle-router.ts`+`inclusion-tracker.ts`.

The coordinator is the SINGLE cross-lane touch point between two producers that (post-F4) run
concurrently, each with its own busy flag + mutable state. It arbitrates ONE wallet nonce
(`submitter.ts:296` `getNonce("pending")`) / ONE pinned target-block slot (`submitter.ts:79/:250`).
`offer()` MUST be **synchronous — no `await`** — so an admission decision is atomic within one
event-loop tick.

```ts
export interface SubmissionCandidate {
  strategy: "reactive" | "block-scan";           // spine names
  opportunityId: string; targetBlock: number;
  netEvWei: bigint;                               // post-EV-gate net (profit − gas − tip), ETH wei
  leavesStandingPosition?: boolean;              // from the plan's edges (credit path)
  deadlineAtMs?: number;
}
export type SlotDecision =
  | { admit: true; replaces?: SubmissionCandidate }
  | { admit: false; reason: "submission_arbitration_lost" | "atomic_preempted_by_backrun"; holder: SubmissionCandidate };
export class SubmissionCoordinator {
  constructor(policy?: { atomicPreemptMarginBps?: number });   // default 0 = block-scan never preempts reactive
  offer(c: SubmissionCandidate): SlotDecision;                 // SYNC; called immediately BEFORE bundleRouter.submit
  onBlock(latest: number): void;                               // prune slots with targetBlock <= latest
}
```

Decision matrix (one slot per `targetBlock`): empty→admit; reactive/reactive→admit (replacement,
preserves today's serial last-write, refactor-neutral); reactive-holder + block-scan→reject
`atomic_preempted_by_backrun` (backrun-first default; a policy change is an economics/human call);
block-scan-holder + reactive→admit+replaces (later bundle supersedes at same nonce; replaced emits
`atomic_preempted_by_backrun`); block-scan/block-scan→admit iff `netEvWei > holder` else reject
`submission_arbitration_lost`. `atomic_preempted_by_backrun` fires ONLY here, never on a scan/read
path. With the scanner disabled every offer is reactive-vs-reactive ⇒ always admit ⇒ **zero behavior
change**.

**Rule-12 gate (deterministic, `searcher:atomic-contract`):** (a) reactive+block-scan same slot ⇒ 1
submit, block-scan loser `atomic_preempted_by_backrun` (both matrix directions); (b) block-scan vs
block-scan loser `submission_arbitration_lost`; (c) scanner off ⇒ N reactive offers ⇒ N admits
(neutrality); (d) `offer()` is sync (no returned Promise); (e) batch of ≥2 profitable block-scan opps
one block ⇒ exactly one submit, losers `dedup_per_block`.

### F4 — block-scan lane + AtomicView / A-universe selection views — absorbs atomic A-universe + A-lane == credit slice 7 infra

**Status: GO for CONSTRUCTION + deterministic gates (after F1/F3). Live `newHeads` wiring is the
BLOCKED block-scan A4 (§3).** This is the "second view + second lane" both specs create; the wallet
conflict is resolved per the verdict (shared signing nonce + coordinator is correct for principal-safe
swap-atomic; the "separate EOA" is a per-credit-leg position account, deferred to the credit-live path,
NOT the base lane).

**F4a — strategy-scoped selection views** (atomic A-universe; owns P1-5 `versions.*`):

| action | path | change |
|---|---|---|
| CREATE | `listener/src/searcher/strategy-views.ts` | `buildStrategyViews(basePools, universeFile, overrides, {atomicMaxPools})` → `{backrun, atomic, versions}` |
| CREATE | `listener/src/searcher/atomic-view-overrides.ts` | loader/appender mirroring `force-include.ts` — `DEFAULT_ATOMIC_VIEW_OVERRIDES_PATH = resolve("searcher","pools","atomic-view-overrides.json")` (cwd-relative `searcher/pools/`, NOT `src/`) |
| CREATE | `listener/searcher/pools/atomic-view-overrides.json` | committed `[]` seed (survives `git reset --hard`) |
| MODIFY | `listener/src/searcher/main.ts` (~`:560–:610`, single graph `:603`) | build views; backrun view feeds planner graph + mempool `toAddress` filter (`:2596` call site); atomic view feeds the scanner |
| CREATE | `listener/src/searcher/test/universe-split.ts` (`searcher:universe-split`) | the gate |

Rules: `backrun = basePools` BIT-FOR-BIT (refactor-neutral: same merge/TOP_N slice/pair-completion,
`main.ts:560–:603` unchanged in effect); `atomic = backrun ∪ selectArbRelevantPools(universeFile) ∪
overrides` capped `atomicMaxPools` (default 6000). ONE union edge graph (`buildTokenGraph(backend,
views.atomic)`); the planner keeps consuming today's edges (block-scan planning is `seedEdges`-bound,
so the planner needs no view arg). Mempool `toAddress` filter built from `views.backrun` ONLY — the
atomic score can never displace a source-swap-likely pool from the 200 hot slots.
`selectArbRelevantPools` promotion from build-time (`build-active-pool-universe.ts:238`) to this runtime
view IS the arb-relevance-epic unification ([[project-pool-scoring-arb-relevance-epic]]). Credit edges
follow the SAME view-projection discipline (verdict): curated ⇒ `score:undefined` ⇒ pinned/exempt from
top-N (`token-graph.ts:474`), so `ENABLE_CREDIT_EDGES_FOR_BACKRUN=0` MUST drop them at
view-projection time, never rely on scoring to prune (scoring won't).

P1-5 `versions.*`: `strategy_view_version = keccak(backrun_view_hash | atomic_view_hash |
pool_universe_generated_at)`; hashes over the sorted view pool ids/addresses (+ overrides content hash
for atomic). Stamped on every atomic event + `atomic_scan_result` + `LearningCase` + `AtomicReplayReport`.

**F4a gate (deterministic, `searcher:universe-split`):** (i) `buildMempoolToAddressFilter(views.backrun)`
set-EQUAL before/after widening the atomic view by 1000 pools (decoupling proof); (ii) atomic view
contains ≥1 loop-closure pool absent from backrun (views differ; nail-#1 assertion); (iii)
`appendAtomicViewOverrides([X])` then rebuild ⇒ X ∈ atomic ∧ X ∉ backrun ∧ X ∉ mempool filter
(loader-reads-written-file + isolation invariant); (iv) identical inputs ⇒ identical `versions.*`;
appending one override ⇒ `atomic_view_hash` + `strategy_view_version` change, `backrun_view_hash`
unchanged.

**F4b — `AtomicLane` isolation** (atomic A-lane, P0-1 — the concurrency-MODEL change, its own gate):

| action | path | change |
|---|---|---|
| CREATE | `listener/src/searcher/atomic-lane.ts` | `AtomicLane` — owns `atomic_busy`, its OWN `PoolStateCache`+`PoolStateUpdater`+sim backend instance, the chunked scan driver, `lastTriggerBlock` |
| MODIFY | `listener/src/searcher/main.ts` | instantiate lane deps behind `SEARCHER_ENABLE_ATOMIC_SCAN` (CONSTRUCTION only; the `newHeads` hook is A4); backrun hot path untouched |
| MODIFY | `listener/src/searcher/solver/pool-state-cache.ts` | add `seedBlockOf(pool): number \| undefined` (per-entry `blockNumber` exists `:115+`, no public accessor today) |
| CREATE | `listener/src/searcher/test/atomic-lane.ts` (`searcher:atomic-lane`) | the gate |

Lane contract (P0-1): (1) TWO independent busy flags — `atomic_busy` private; the hint loop's `busy`
(`main.ts:680/:858/:870/:906`) NEVER read/written by the lane; a hint arriving mid-scan MUST be
processed (zero new `skip hint`). (2) shared read-only chain reads, PRIVATE mutable (own cache +
updater + sim/fork — sharing backrun's cache is the R2 corruption hazard). (3) Node single-thread
honesty: the driver runs `detectAtomicOpportunities` in bounded pure chunks with cooperative yields
(`setImmediate`-equivalent between pair-batches, budget per chunk); if a dry-run window shows hint
`prep_ms p95` regressing, escalate to `worker_threads`/2nd machine — do NOT re-couple. (4) trigger-gap
tracking: `lastTriggerBlock`; after skipped blocks fetch `fromBlock=lastTriggerBlock+1` (correctness
never depends on this — the fresh-read gate holds regardless).

**F4b gate (deterministic, `searcher:atomic-lane`):** a synthetic backrun hint injected mid-atomic-scan
⇒ (a) the hint runs to completion, ZERO `skip hint` attributable to the lane; (b) hint start-delay ≤
one chunk (event-loop-yield proof); (c) a scan overrunning into the next block ⇒
`atomic_scan_result{outcome:"skipped_busy"}` keyed on `atomic_busy` only; (d) a block-scan candidate
losing the slot to a backrun emits `atomic_preempted_by_backrun` and NO scan/read event carries it; (e)
backrun suites re-run unchanged with the lane constructed-but-idle.

---

## 3. Strategy/edge-specific slices (fork AFTER the foundation)

Two independent forks + the existing backrun. They no longer collide (spine + coordinator + view/lane
built once). Each carries its own rule-12 gate.

### FORK 1 — block-scan scanner (atomic-arb A0–A4, re-parented onto the spine)

`AtomicOpportunity → BlockScanOpportunity` (§1.1); `seedEdges: VenueEdge[]` all `edgeKind:"swap"`; the
scanner is the `strategy_kind:"block-scan" × edgeKind:"swap"` cell.

**A0 — decode/verify the sample (run FIRST — R5 reth prune window).** Status GO. CREATE fixture
`test/fixtures/atomic-coffee-803a3693.json` + `test/atomic-a0-replay.ts` (`searcher:atomic-a0`): at
block 25455023 (pre-state of `0x803a3693`, 3 pools, net $0.33) read each cycle pool's state from local
reth (fallback archive per nail #7), PERSIST states into the fixture (replayable post-prune), recompute
gross with existing `solver/v3-math.ts`. Gate: cycle reconstructable from public state alone,
`expectedGrossWei>0` recorded. (Dust is fine as a FIXTURE; §4 enable-criterion never counts dust as
success.)

**A1 — anchor finder: delta-seeded O(pairs) 2-hop scan.** Status GO (offline-fixture scope). CREATE
`detector/atomic-scanner.ts`; MODIFY `planner/planner.ts` (block-scan branch); extend `test/planner.ts`
`REPLAY_FIXTURES`. `detectAtomicOpportunities` is **PURE + SYNC over the warm cache — zero RPC** (the
caller does all reads); this purity makes the C2 offline replay exact. Algorithm: group edges by
unordered pair, keep ≥2-venue pairs; delta-restrict to pairs touching `swapTouched` (trigger-only,
P0-2); per-venue mid-price from cache; `spreadBps` fee-adjusted; `flashToken` = ring token in
`pricedTokens` (prefer WETH); **`searchCenter` derivation** (replaces the `1n` fallback — the verified
landing blocker at `solver.ts:449`): size that moves the cheap venue ~half the spread, clamp to
`[10^3, min(reserveIn/4, maxBorrow)]`, `maxInput` = ceiling.

**Planner binding (nail #1 — one signature, branch on discriminator).** `plan()` head
(`planner.ts:126`, verified `plan(opp, templates, opts)`):
`if (opp.strategy_kind === "block-scan") return this.planAtomicFromSeedEdges(opp, templates, opts);`.
`planAtomicFromSeedEdges` builds the single `TokenPath` directly from `seedEdges` — never calls
`buildTokenPaths`/`focusPathsOnImpact`/`buildBorrowabilityRotations` (rotation disabled ⇒ `searchSeed`
stays in `flashToken` units); `plan.maxFlashAmount := searchSeed.maxInput`. Reactive flow through
`plan()` is one early return away — untouched. Gate (`searcher:planner`): `candidate_plans 0→>0`; every
candidate path contains exactly the seed pools; resolved center `>8n` in flashToken units, no rotation;
a no-spread control yields 0 anchors.

**A2 — bounded 3–4-hop cycle extension.** Status GO (offline-fixture). Extend `atomic-scanner.ts`;
CREATE `test/bench-atomic.ts` (`searcher:bench-atomic`). REUSE `buildTokenPaths(atomicEdges, t, t,
{maxHops: cfg.maxHops, maxPoolsPerToken:8, maxPaths:2000, deadlineAtMs})` (`token-graph.ts:462`;
start===profit enumerates cycles — do NOT write a new DFS). Score rings by `Σ log(mid·(1−fee))`; emit
full ring as `seedEdges`. Gate 1 (`searcher:planner`): A0 fixture 3-hop ring found, `candidate_plans
0→>0`, all 3 seed pools in path. Gate 2 (`searcher:bench-atomic`): A1+A2 at maxHops=4 over the atomic
view < `budgetMs` (relative, harness-bound); measured planner 114ms @ 4216 pools
([[project-topn-latency-curve]]) vs ~12s deadline ⇒ comfortable.

**A3 — no-source-swap solve + sim + standalone build.** Status GO (offline-fixture). MODIFY
`solver/solver.ts` `resolveSearchCenter` head (`:442`):
`if (plan.opportunity.strategy_kind === "block-scan") return plan.opportunity.searchSeed.searchCenter;`
BEFORE the `victimAmount` read (`:449`; the atomic arm has no `victimAmountIn` — TS enforces the
narrow); backrun path byte-identical. MODIFY `test/replay-live-fixtures.ts` to accept an atomic fixture
(no `localVictimApply`; standalone/mined path). End-to-end on A0: `planAtomicFromSeedEdges → solve →
terminal verify → EV gate → standalone BundleSubmission (no victimTxHash)`. Gate
(`searcher:replay-live-fixtures`): `no_candidate → sim.success + netEV>0 + EV-gate pass + standalone
BundleSubmission`; assert resolved center from `searchSeed` (`>8n`).

**A4 — live wiring + dry-run window.** **Status: BLOCKED** until F4b (`searcher:atomic-lane`) + the
merged P0-2/P0-3 fresh-read pre-gate fixtures are green. MODIFY `main.ts` + `atomic-lane.ts` (`newHeads`
→ lane driver); CREATE `atomic-breaker.ts`; MODIFY `deploy-node.sh` (env-preserve + banner
`atomicScan=on/off atomicView=<n> overrides=<n> atomicViewHash=<0x…8>` — the
`SEARCHER_POOL_UNIVERSE_TOP_N` silent-revert precedent, [[project-universe-load-regression]]).

Lane driver (P0-1 own flag; P0-2/P0-3 trigger→expand→fresh-read→gate):
`onBlock(sourceBlock)`: guard `enableAtomicScan`/`breaker.allowed`/`atomicBusy`; `fetchSwapTouchedVenues
(lastTriggerBlock+1 → N)` (TRIGGER-only, gap-inclusive); `expandToPeerVenues(touched, atomicView,
maxPeerSeeds)`; **fresh-read the expanded set at `blockTag=sourceBlock` into the LANE's cache**; if
`blockTracker.latest > sourceBlock` → `stale_state`; `runChunked(detectAtomicOpportunities)`; emit
exactly ONE `atomic_scan_result` per newHead (nail #4); **pre-quote fresh-read gate (merged P0-2/P0-3):
EVERY cycle pool `laneCache.seedBlockOf(pool) === sourceBlock`, else drop
`atomic_state_inconsistent` — never enter the solver on guessed state** (swap-only "unchanged" is
UNSOUND: non-swap events + eventless transfers mutate quote state); one candidate/block →
`processOpportunities(laneCtx, [best], {strategy_kind:"block-scan", sourceBlock})`. Submit-time expiry
(nail #3): `latest > sourceBlock` at submit ⇒ `atomic_stale_target_block`, never a re-targeted bundle.
Full-sweep backstop (`swapTouched:null`) every `SEARCHER_ATOMIC_FULL_SWEEP_BLOCKS` (default 50) — the
only catcher of the liquidity-only miss-class (coverage delay by design, never a correctness hole).

Runtime breaker (`atomic-breaker.ts`): rolling window; TRIP on backrun `expiredBeforeSolver`/hint-rate
above pre-atomic baseline by `BREAKER_EXPIRY_PCT`, OR 5 consecutive `budget_exceeded`, OR hint `prep_ms
p95` regression while the lane is active; tripped ⇒ `atomic_scan_result{outcome:"breaker_open"}` for
`COOLDOWN_BLOCKS`; the breaker only ever DISABLES atomic, never touches backrun.

Deterministic pre-gates (pinned in `searcher:planner`, green BEFORE the window): **P0-3** cold cache +
one swap-touched pool + cold return venue ⇒ peer expanded + fresh-read + candidate found (`0→>0`);
**P0-2** un-fresh cycle pool dropped `atomic_state_inconsistent` (incl. liquidity-change-only/no-swap
state); spread gone after fresh-read ⇒ drop; unreadable ⇒ drop. **Metrics gate (rule-12
non-deterministic exemption)** over a dry-run window flag-ON: ≥1 atomic `opportunity_seen`; ≥1 atomic
`simSuccess` on a real block (net-EV recorded, dust labelled dust); backrun `expired-before-solver` +
hint `prep_ms p95` not materially above baseline AND zero `skip hint` from the lane; exactly one
`atomic_scan_result` per newHead; every atomic event carries consistent `source_block/state_block` +
the P1-5 view fields; `atomic_preempted_by_backrun` only at the coordinator. Thin window ⇒ EXTEND.

### FORK 2 — credit adapter (credit slices 3/5/6/8)

`edgeKind:"credit"`, `leavesStandingPosition:true`, either strategy may route it (strategy-agnostic —
credit invariant #2). All production flags default OFF.

**C3 — CreditEdge recognized in ANALYSIS/replay (prod OFF) — the cheap decisive anchor.** Status GO
(after F1). Recognize `0xf88b…` as `FluidCredit(wstUSR→USDC)`; add the credit edge to the planner graph
behind `ENABLE_CREDIT_EDGES_FOR_ANALYSIS`. Gate (planner `REPLAY_FIXTURES`, pure, no anvil — like the
CFG fixture): credit edge PRESENT ⇒ `candidate_plans 0→≥1` on the reference case; ABSENT ⇒ 0. Optional
AC-3 (`searcher:ac3`): abandon-exit token-delta ≈ 273 wstUSR.

**C5 — Fluid credit adapter (new runtime, prod OFF, credit-live human marker).** Status: build GO,
LIVE BLOCKED behind the credit-live marker + 2nd position account + Safety-1. Replace the
`fluidDebtBps` solver SEARCH (`quoter.ts:358` throws today; `solver.ts` GSS dimension) with a
deterministic max-safe-borrow resolver quote (`VaultResolver.getVaultEntireData`, zero-CU) + haircut ε
(9999-bps precedent); abandon enforced by capability-absence (no close action —
`plan-builder.ts:163-177` `nftId:0` open, no close, already de-facto); isolated `nftId`/leg; **per-adapter
gas table** (credit leg 250–400k vs ~100k swap — `edgeKind` is the hook; without it credit over-ranks
at `gas_estimate=0`, credit invariant #5); profit token valued at executable MARKET price in the EV
gate; failure taxonomy `credit_infeasible`/`credit_stale_oracle`. **credit-live reject guard** (credit
invariant #3): `deploy-node.sh` + the submit path REJECT any plan containing a
`leavesStandingPosition:true` edge unless a SEPARATE `/opt/MEV/.credit-live` marker (independent of
`.deploy-live` + wallet cap) is set — the `assert-balance` guard (`plan-builder.ts:113`) bounds only the
FLASH token, NOT the standing position. Gate: replay `0xf88b` `candidate_plans 0→1` + deterministic
quote sim ≈ 273 wstUSR + guard REJECTS an abandonExit plan when the marker is absent.

**C6 — backrun+credit routing (hot-path-adjacent, prod OFF).** Status GO (after C5). `strategy-views`
`projectView` materialized sets; `ENABLE_CREDIT_EDGES_FOR_BACKRUN=0` drops credit at VIEW-PROJECTION
time (pinned edges won't self-prune, `token-graph.ts:474`); depeg-gated insertion (credit decays on the
ORACLE-keeper update, a different race than swaps). Gate (`searcher:planner` flip): flag=1 ⇒ backrun
routes credit (proves strategy-agnostic); flag=0 ⇒ absent from the projected view (proves
projection-drop, not scoring).

**C8 — Aave/Euler + e-mode behind the resolver-quote adapter (new runtime, prod OFF).** Status GO after
C5/C6. Shared-target `marketId` discriminator (Aave = one Pool many reserves, like the v4 singleton —
so `sameDirectedEdge`/dedup work); e-mode account-global on Aave. Gate: per-protocol replay flip
`candidate_plans 0→≥1` + shared-target dedup asserted.

### FORK 3 — backrun (existing, re-labelled `strategy_kind:"reactive"`)

No new runtime. The F1 discriminator rename + the F3 coordinator route both submit sites through
`offer()`. The `processOpportunities` factor-out of `handleHint`'s ~640-line loop body (`main.ts:1287→
~1905`) is a **mechanical move, zero logic edits** — the risky part, gated hardest (byte-identical
backrun replay):

```ts
type SourceMeta =
  | { strategy_kind: "reactive"; victimTxHash: string; victimRawTx?: string;
      submissionMode: "victim-bundle"|"hash-only"|"standalone"; eventBlockNumber: number }
  | { strategy_kind: "block-scan"; sourceBlock: number };   // targetBlock = sourceBlock+1, PINNED
async function processOpportunities(ctx: HandleCtx, opps: Opportunity[], sourceMeta: SourceMeta): Promise<void>
```

`handleHint` delegates with the reactive `SourceMeta`; every existing fixture replays byte-identically.
Target-block branches on `sourceMeta.strategy_kind`: reactive keeps `latest+1` at submit
(`main.ts:1834`); block-scan pins `sourceBlock+1` + drops `atomic_stale_target_block` when
`ctx.blockTracker.latest > sourceMeta.sourceBlock` (nail #3, exercised in A4). Gate (part of F1's
`searcher:atomic-contract` + `searcher:replay-live-fixtures`): backrun 14/14 + live-fixture profit
equivalence 1 wei UNCHANGED; R3 compat — `redact-live-run` + `route-gap-watcher --dry-run` over a mixed
reactive+block-scan events fixture, no crash, backrun aggregation unchanged.

### Self-evolution parity (one learning loop, both strategies) — the close half (slice D)

**D — strategy-aware close dispatcher.** Status: LAST, BLOCKED until C2's P1-4 (capability vs
live-admission split) + P1-5 (view versioning) are green (D must not ACT on a pre-split verdict).
CREATE `analysis/src/cli/auto-close-strategy-gap.ts` (input = `LearningCase[]` ONLY, never a per-tool
report shape — user point 3); MODIFY `atomic-view-overrides.ts` `appendAtomicViewOverrides` (idempotent,
mirrors `force-include.ts:88`). Dispatch on `case.strategy`:
- `reactive` → today's `auto-close-route-gap` (IMPORTED, not forked; `force-include-poolids.json`).
- `block-scan` + `atomic_view_missing_venue` → `appendAtomicViewOverrides` →
  `listener/searcher/pools/atomic-view-overrides.json` ONLY → pending-deploy marker → `replay_passed`
  only after `replayAtomicScanAt` flips the sample.
- credit / `standing_position_required` / `below_ev` / `outbid` → economics or credit-live human gate,
  never an autonomous close.
- comparable inconclusive (closed=0 on a comparable loss) → `pending-manual/<id>.json` +
  `status:manual_required` (the §6b/§6c meta-loop; an unanalyzed package BLOCKS cycle-close).

**Isolation invariant (user point 4):** closing a block-scan case leaves `force-include-poolids.json`
byte-identical AND `buildMempoolToAddressFilter(views.backrun)` set-equal. Gate: per gap class,
`before→primary_gap X` / `after replay→stage improved`; re-run same `learning_case_id` ⇒ no duplicate
append/escalation.

**C2-minimal (the block-scan analysis+replay half of F2's `strategy-compare`)** is a HARD prerequisite
of A4: CREATE `listener/src/searcher/atomic-replay.ts` (`replayAtomicScanAt` — lives in listener so it
exercises the REAL `detectAtomicOpportunities`+`planAtomicFromSeedEdges`, never a copy). P1-4: run BOTH
`capability_replay_stage` (full sweep `swapTouched:null`) AND `live_admission_stage` (delta-trigger from
retained logs); sweep-found-but-not-triggered ⇒ `atomic_scan_not_triggered`. P1-5: stamp the report's
`atomic_view_hash`/`strategy_view_version` from `buildStrategyViews.versions`. State backend contract
(nail #7): local reth → archive → `replay_state_unavailable` (never a fabricated gap); cache per
`learning_case_id`.

---

## 4. Ordered build plan + gating

### Dependency DAG

```
                 ┌────────────────────────── FOUNDATION (build ONCE) ──────────────────────────┐
F1 unified types ─┬─> F2 LearningCase-by-extension ─┬─> C2-minimal (block-scan analysis+replay)
   (spine)        │     (+ shipped C1 re-label)      │
                  ├─> F3 SubmissionCoordinator       │
                  └─> F4a AtomicView/A-universe ─> F4b AtomicLane
                 └──────────────────────────────────────────────────────────────────────────────┘
                                         │ FORK (no collisions left)
       ┌─────────────────────────────────┼───────────────────────────────────┐
  BLOCK-SCAN (Fork 1)              CREDIT (Fork 2)                       BACKRUN (Fork 3)
  A0 → A1 → A2 → A3                C3 → C5 → C6 → C8                     processOpportunities
        │  (offline-fixture)        │(analysis)(runtime, live-gated)     re-label reactive
   [BLOCKED] A4 live ◄── F4b + P0-2/P0-3 pre-gates green
        │
   C2-full → D (close) ◄── C2 P1-4 + P1-5 green
```

Linear order (each = one Codex brief): **F1 → F2 → F3 → F4a → F4b → C2-minimal → A0 → A1 → A2 → A3 →
[A4 blocked] ; C3 (parallel, after F1) → C5 → C6 → C8 ; D last.** A0 may run any time after F1 (run it
FIRST inside Fork 1 — R5 reth prune window). B-residual (mempool quota buckets) is conditional/anytime
(landed already per R1; quota only on truncation evidence).

### GO now vs BLOCKED

| item | status | gate that unblocks it |
|---|---|---|
| F1, F2, F3, F4a, F4b | **GO** | — (foundation; deterministic gates each) |
| C2-minimal (build + REPORT) | **GO** | authoritative-close use BLOCKED until P1-4 + P1-5 |
| A0, A1, A2, A3 (offline-fixture) | **GO** | — |
| C3 (analysis, prod OFF) | **GO** | — |
| C5 build / C6 / C8 build | **GO to build** | LIVE credit routing BLOCKED behind `/opt/MEV/.credit-live` marker + 2nd position account + Safety-1 human gate |
| **A4 live wiring** | **BLOCKED** | `searcher:atomic-lane` (F4b) + P0-2/P0-3 fresh-read pre-gate fixtures green |
| **C2-as-authoritative-close / D acting** | **BLOCKED** | P1-4 (capability/live-admission split) + P1-5 (view versioning) green |
| **go-live / broadcast (either fork)** | **BLOCKED** | Safety Rule 1 human gate (bounded-live for swap-atomic; a SEPARATE credit-live authorization for standing-position credit) |

### Preserved owner re-gates + safety invariants

**Atomic-arb owner re-gate (P0-1..P1-5) — all folded:** P0-1 lane isolation ⇒ F4b; P0-2/P0-3 merged
fresh-read gate ⇒ A4 pre-gates; P1-4 capability/live-admission split ⇒ C2-minimal; P1-5 view versioning
⇒ F1 events + F4a `versions.*` + `LearningCase`. **Credit 5 safety invariants — all wired:** (1)
`leavesStandingPosition` on the EDGE (F1), (2) credit strategy-agnostic / independent enable flags (C3/C6),
(3) bounded-live does NOT cover credit — credit-live reject guard off the edge flag (C5), (4) 2-D credit
quote kept explicit / not flattened (C5, §1.2), (5) per-adapter gas table mandatory (C5). Broadcast/go-live
stays a hard human gate; nothing here submits outside the bounded-live envelope, and the auto-close chain
only marks pending-deploy — it never flips modes.

---

## 5. What changes vs the two source specs (migration note)

**Atomic-arb slices — renamed / re-parented (engineering body intact):**
- `Opportunity.kind:"atomic-arb"` → `strategy_kind:"block-scan"`; `AtomicOpportunity` →
  `BlockScanOpportunity`; `BackrunOpportunity` → `ReactiveOpportunity`, `kind:"backrun-arb"` →
  `strategy_kind:"reactive"`. Every branch (`planner.ts:126`, `solver.ts:442`, `processOpportunities`
  `SourceMeta`) keys on `opp.strategy_kind`, not `opp.kind`.
- `seedEdges: TokenEdge[]` → `VenueEdge[]` (widened superset, all `edgeKind:"swap"`).
- Atomic §1.4 SubmissionCoordinator, A-universe, A-lane, LearningCase §1.5 → **foundation** F3/F4a/F4b/F2
  (built once, not inside the atomic fork). A-contract's type/event/coordinator surface → F1+F3+F4.
- The atomic `atomic_*` primary_gap classes → mapped onto the converged funnel-ordered taxonomy (§1.4);
  atomic-specific distinctions live in `secondaryGaps[]`, not a parallel enum.

**Credit slices — absorbed / re-homed:**
- Credit slice 1 (types) → F1 (merged with the atomic union re-parent — ONE type PR).
- Credit slice 2 (LearningCase-by-extension) → F2 (merged with shipped C1 + atomic C2 build — ONE owner
  of `bundle-postmortem.ts`/`census-report.ts`; never opened twice in parallel).
- Credit slice 7 (atomic lane + AtomicView + Coordinator) → F3+F4 (the SAME infra the atomic epic
  builds; the "separate EOA" narrows to a per-credit-leg position account on the credit-live path, NOT
  the base lane — the verdict's wallet reconciliation).
- Credit slices 3/5/6/8 → Fork 2 (credit adapter), unchanged in substance.
- Credit slice 4 (VenueEdge quote/build dispatch layer) → OPTIONAL, latency-gated, AFTER the foundation
  (`quoter.ts:358` fluid 2-D search means a uniform `edge.quote()` is not a free no-op).

**Shipped C1 re-label (2 as-is, 1 re-label):** `sender-flow.ts` (split the `:44` flow-axis bug),
`swap-log-registry.ts`, `victim-source.ts` reused UNCHANGED; `tx-shape.ts:20` output MAPPED to
`strategy_kind` at the F2 boundary (`atomic_state_arb→block-scan`, `backrun→reactive`) — logic
untouched, NO rework (it already computes the shape from chain data).

**Single highest-friction item that gates everything (unanimous):** the spine decision in **F1** — the
strategy-axis name (`strategy_kind: reactive | block-scan`) + the edge type
(`VenueEdge{edgeKind, leavesStandingPosition}` widening `TokenEdge`), decided together, ONCE, before
either fork writes runtime code. Ship any runtime slice with `kind:"atomic-arb"` first and the credit
spine forks or forces a painful rename back through the ~640-line `processOpportunities` factor-out —
and re-creates the latent laundering trap. F1 is a small, mechanical, hard-gated slice, but it is the
keystone.

---

## 6. Acceptance matrix (every foundation + strategy slice → executable rule-12 assertion)

| slice | class | executable assertion | command |
|---|---|---|---|
| **F1 types/spine** | deterministic | backrun 14/14 + live-fixture 1-wei + `ac3` UNCHANGED; Fluid edge `edgeKind:"credit"/leavesStandingPosition:true`, swap edges `swap/false`; cycle-fingerprint rotation/direction invariance; `LearningCase` store forward-only | `searcher:planner` + `searcher:replay-live-fixtures` + `searcher:atomic-contract` + `searcher:ac3` + `analysis` `npm test` |
| **F2 LearningCase-by-extension** | deterministic | `0xa32b…→venue_missing`, `0xee7b98ad…→non_comparable_winner`, 9 coffee → 8 block-scan+1 reactive, `0xf88b…→edge_kinds:["credit"]`; re-run ×2 idempotent | `analysis` `npm test`; `strategy-compare --fixtures coffee-20260704` ×2 |
| **F3 SubmissionCoordinator** | deterministic | reactive+block-scan same slot ⇒ 1 submit, loser `atomic_preempted_by_backrun`; block-scan/block-scan loser `submission_arbitration_lost`; scanner-off ⇒ all reactive admit; `offer()` sync; batch dedup `dedup_per_block` | `searcher:atomic-contract` |
| **F4a AtomicView/A-universe** | deterministic | backrun mempool filter set-equal after +1000 atomic pools; atomic view ⊇ ≥1 loop-closure pool ∉ backrun; loader-reads-written-override ∧ override ∉ backrun/mempool; identical inputs ⇒ identical `versions.*`; append flips `atomic_view_hash`+`strategy_view_version` only | `searcher:universe-split` |
| **F4b AtomicLane isolation (P0-1)** | deterministic | hint injected mid-scan IS processed, ZERO `skip hint` from lane; hint start-delay ≤ one chunk; `skipped_busy`=own-lane overrun only; `atomic_preempted_by_backrun` submission-slot-only; backrun suites unchanged with lane idle | `searcher:atomic-lane` |
| **A0** | deterministic | cycle reconstructable from public state alone; fixture persists pool STATES; `expectedGrossWei>0` | `searcher:atomic-a0` |
| **A1 anchor scan + planner binding** | deterministic | `candidate_plans 0→>0`; path = exactly seed pools; center `>8n` flashToken units, no rotation; no-spread control ⇒ 0 anchors | `searcher:planner` |
| **A2 3–4-hop extension** | det. + latency | A0 3-hop ring found (all seed pools in path); A1+A2 maxHops=4 < `budgetMs` | `searcher:planner`; `searcher:bench-atomic` |
| **A3 no-swap solve/sim/build** | deterministic | `no_candidate → sim.success + netEV>0 + EV-gate pass + standalone BundleSubmission`; center from `searchSeed` (`>8n`) | `searcher:replay-live-fixtures` |
| **A4 live wiring** (BLOCKED) | metrics (non-det exemption) | flag-ON window: ≥1 atomic `simSuccess` (net-EV, dust labelled); backrun `prep_ms p95` + `expired-before-solver` within baseline + zero lane `skip hint`; 1 `atomic_scan_result`/newHead; consistent `source_block/state_block`+view fields; `atomic_preempted_by_backrun` coordinator-only. Thin ⇒ EXTEND | `deploy-node.sh` window + Step-1 cross-ref + `hermes-gate` |
| **A4 P0-2/P0-3 pre-gates** (deterministic, green BEFORE window) | deterministic | P0-3 cold return venue expanded+fresh-read ⇒ `0→>0`; P0-2 un-fresh cycle pool ⇒ `atomic_state_inconsistent`, spread-gone-after-fresh-read ⇒ drop, unreadable ⇒ drop | `searcher:planner` pinned fixtures |
| **C2-minimal P1-4** | deterministic | sweep-found ring, source block not delta-triggered ⇒ `primary_gap=atomic_scan_not_triggered`, NOT `atomic_cycle_not_found`; both stages on report+`LearningCase` | `strategy-compare` fixture |
| **C2-minimal P1-5 + nail#7** | deterministic | same case before/after a close shows `atomic_view_hash`+`strategy_view_version` CHANGE + attributable stage flip; unreachable B−1 ⇒ `replay_state_unavailable`, never a gap; cache hit ⇒ 0 RPC | `strategy-compare` fixture |
| **C3 credit analysis** | deterministic | credit edge present ⇒ `candidate_plans 0→≥1` on `0xf88b`; absent ⇒ 0; (opt) AC-3 token-delta ≈ 273 wstUSR | `searcher:planner` `REPLAY_FIXTURES`; `searcher:ac3` |
| **C5 Fluid adapter + guards** | deterministic | replay `0xf88b` `candidate_plans 0→1`; deterministic max-borrow quote sim ≈ 273 wstUSR (search deleted); guard REJECTS an `abandonExit` plan w/o `/opt/MEV/.credit-live`; gas table applied (credit leg ranks below swap at gas=0) | `searcher:planner`; guard unit test |
| **C6 backrun+credit routing** | deterministic | flag=1 ⇒ backrun routes credit (strategy-agnostic); flag=0 ⇒ credit absent from projected view (projection-drop, not scoring) | `searcher:planner` flip |
| **C8 Aave/Euler + e-mode** | deterministic | per-protocol replay flip `candidate_plans 0→≥1`; shared-target `marketId` dedup asserted (v4-singleton analog) | `searcher:planner` per-protocol fixtures |
| **Fork 3 backrun re-label + factor-out** | deterministic | backrun 14/14 + live-fixture 1-wei UNCHANGED; R3 mixed-events `redact-live-run`/`route-gap-watcher` no crash, aggregation unchanged | `searcher:atomic-contract` + `searcher:replay-live-fixtures` |
| **D close dispatcher** | deterministic | per gap class `before→primary_gap X`/`after replay→stage improved`; isolation: atomic close ⇒ `force-include-poolids.json` byte-identical + backrun mempool set-equal; re-run same id ⇒ no dup append/escalation | `strategy-compare` + `auto-close-strategy-gap` ×2 |

`fixed` (deterministic slices) requires the pinned sample replayed locally to show the bucket
transition — "build passes" is NEVER enough (rule 12). Non-deterministic slices (A4 window, latency)
gate on before/after metrics, not a flip.

---

## Provenance

Author A of a 3-way blind fusion (two fresh fable + orchestrator). Built ON the settled 4-way
reconciliation verdict (`arch-reconciliation-atomic-vs-credit-20260704-3way-synthesis.md`) — spine
adopted, not re-litigated. Every `file:line` re-verified against the working tree
(`detector.ts:6`, `token-graph.ts:15/:20/:462/:474`, `planner.ts:126`, `solver.ts:120/:442/:449/:196`,
`plan-builder.ts:113`, `quoter.ts:358`, `bundle-router.ts:6`, `tx-shape.ts:20`, `pool-state-cache.ts`
per-entry `blockNumber`). Verdict adjustments: none material — two elaborations recorded (§5:
`edgeKind` is a new axis co-existing with `slotKind`; `VenueEdge.quote()/build()` are a latency-gated
dispatch layer, not a foundation blocker), both consistent with the verdict's own caveats.
