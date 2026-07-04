# Unified architecture + implementation spec — atomic-arb EPIC ⋈ credit-venue edge (fusion, 2026-07-04-B)

> Scope: authorized, defensive on-chain arbitrage research; mainnet fork + dry-run; broadcast is a
> human-gated step. This is the SINGLE buildable spec Codex executes against. It merges two workstreams —
> the atomic-arb EPIC (`coffee-20260704-atomic-epic-impl-plan.md`) and the credit-venue edge
> (`credit-venue-landing-plan-20260704.md` + the two credit ADRs) — into ONE model, ONE foundation, then
> a fork into strategy/edge-specific slices. It BUILDS ON the 4-way-converged reconciliation
> (`arch-reconciliation-atomic-vs-credit-20260704-3way-synthesis.md`); it does not re-litigate the spine.
> Author: independent fusion pass B (blind to the other two fusion authors). Every non-trivial anchor
> below was re-verified against the working tree at HEAD (`70c50a5`).

---

## 0. Grounding — what is ALREADY shipped (verified in code, refines the verdict)

The reconciliation synthesis describes C1 as "re-label `tx-shape` output enum only, no rework." **Verified
against code, C1 shipped materially MORE than that** — the taxonomy spine and the edge-widening are already
in the tree. This changes what F1 has left to do (it is smaller than either source spec assumed):

| component | verdict said | actual shipped state (file:line) | fusion consequence |
|---|---|---|---|
| strategy axis type | "add `strategy_kind: reactive\|block-scan`" | **`strategy-taxonomy.ts:1` `StrategyKind = "backrun" \| "block-scan"`** already exported (+ `EdgeKind`, `deriveEdgeTaxonomy`, `edgeKindFromSlotKind`, `strategyKindFromTxShape`, `pathLeavesStandingPosition`) | REUSE this type. Concrete labels are **`backrun`/`block-scan`**, NOT `reactive` — see §5 divergence D1 |
| edge widening | "`VenueEdge{edgeKind, leavesStandingPosition,…}` widens `TokenEdge`" | **`token-graph.ts:16-26` `TokenEdge` ALREADY carries `edgeKind: EdgeKind` + `leavesStandingPosition: boolean`**, derived once via `deriveEdgeTaxonomy(slotKind)` (`token-graph.ts:22`) | `VenueEdge` ≡ `TokenEdge` (already widened). NO new edge class, NO `quote()`/`build()` methods on the edge — see §5 divergence D2 |
| fluid = credit edge | "wired Fluid vault is a `lend` edge" | **`token-graph.ts:112` `FLUID_VAULT_WSTUSR_USDC … fixedSlotKind:"lend"`** → derives `edgeKind:"credit"`, `leavesStandingPosition:true` | the credit edge's data shape exists today; the gap is the QUOTE (`quoter.ts:358` throws) + policy, not the type |
| sender-flow two-axis | "re-label" | **`sender-flow.ts:15-17` already two-axis** (`submission_method` + `source_visibility`, visibility-evaluated-first `:57-61`) — the `:44` private/high bug is FIXED | C1 done; no F2 rework of sender-flow |
| shape classifier | C1 | **`tx-shape.ts:27 classifyTxShape` + `swap-log-registry.ts decodeAnySwapLog`** shipped (`atomic_state_arb`/`backrun`/`unknown`); bridge `strategyKindFromTxShape` (`strategy-taxonomy.ts:5`) | C1 done. tx-shape keeps the chain-observable `shape` enum + a bridge to `strategy_kind` (better than a raw rename — see §5 D3) |

**Still absent (grep over `listener/src` + `analysis/src` = 0 hits):** `Opportunity` discriminated union (still
`detector.ts:6` plain `kind:"backrun-arb"`), `VenueEdge` alias, `EdgeSequence`, `LearningCase`,
`cycle-fingerprint`, `SubmissionCoordinator`, `strategy-views`, `atomic-view-overrides`, `atomic-lane`,
`atomic-scanner`, `atomic-replay`, `analysis/src/learning/`. These are the fusion's build surface.

---

## 1. Unified model (types)

One vocabulary, three homes. **`listener` owns the runtime types** (Opportunity, edges, cycle identity,
coordinator); **`analysis` owns the learning types** (LearningCase) and imports listener relatively (existing
precedent `analysis/src/cli/live-loss.ts:15`). `strategy-taxonomy.ts` is the shared naming law (already
shipped) and is the ONLY place `StrategyKind`/`EdgeKind` are defined.

### 1.1 Strategy axis — reuse the shipped type

```ts
// listener/src/searcher/strategy-taxonomy.ts  (SHIPPED — do not redefine)
export type StrategyKind = "backrun" | "block-scan";   // backrun = reactive/hint-driven; block-scan = per-block state scan
export type EdgeKind     = "swap" | "credit" | "lp" | "flash";
export function deriveEdgeTaxonomy(slotKind): { edgeKind: EdgeKind; leavesStandingPosition: boolean };
export function pathLeavesStandingPosition(edges: {leavesStandingPosition:boolean}[]): boolean;  // the SAFETY predicate
```

Principal-safety is an EDGE property (`leavesStandingPosition`), never a strategy label — enforced by the
fact that `pathLeavesStandingPosition` (already shipped) reads the edge flag, and no guard reads a strategy
string. `block-scan` and `backrun` are both trigger-descriptive; neither implies principal-safety (§5 D1).

### 1.2 `VenueEdge` ≡ the already-widened `TokenEdge` — no new class

```ts
// listener/src/searcher/planner/token-graph.ts  (SHIPPED shape; add ONE alias in F1)
export interface TokenEdge {
  adapterId: string; target: string; tokenIn: string; tokenOut: string;
  slotKind: "flash" | "lend" | "swap";
  edgeKind: EdgeKind;                 // derived (token-graph.ts:22)
  leavesStandingPosition: boolean;    // derived; true ⇔ credit abandon-exit
  curveI?, curveJ?, poolToken0?, poolToken1?, score? ...
}
export type VenueEdge = TokenEdge;    // F1: vocabulary alias ONLY — the widening is already done
```

`quote()`/`build()` are **NOT** methods on the edge. The adapter registry IS the polymorphism (credit ADR
`credit-venue-edge-20260704.md:92-95`): `quoter.ts` dispatches quote by `adapterId`; `plan-builder.ts`
dispatches build by `adapterId`; `edgeKind` drives the POLICY table (enable flag, gas table, failure
taxonomy, risk gate). The credit adapter slice replaces the `quoteFluidVault()` throw (`quoter.ts:358`) with
a real resolver quote — dispatched by `adapterId:"fluid-vault"`, not by a method on `TokenEdge`.

### 1.3 `Opportunity` discriminated union — re-parent onto `strategy_kind`

```ts
// listener/src/searcher/detector/detector.ts:6  (MODIFY — union, discriminant renamed kind→strategy_kind)
export interface BackrunOpportunity {          // today's shape; field rename only
  strategy_kind: "backrun";                    // was `kind: "backrun-arb"`
  victimTxHash: string; blockNumber: number;
  affectedPools: string[]; affectedTokens: string[];
  startToken: string; profitToken: string; victimAmountIn: bigint;
  targetNetProfit?: bigint; hints: Record<string, unknown>;
}
export interface BlockScanOpportunity {        // was atomic-arb §1.1 AtomicOpportunity, re-parented
  strategy_kind: "block-scan";
  sourceBlock: number;                         // scan read end-state of this block; target = sourceBlock+1
  stateBlock: number;                          // consistency evidence (§F4 fresh-read gate)
  cycleId: string;                             // canonicalTokenRing(ring).join(",") — block-free identity
  cycleFingerprint: string;                    // cycleFingerprint(sourceBlock, ring) — the F2 join key
  seedEdges: VenueEdge[];                       // the EXACT ordered cycle; planner is BOUND to these
  affectedPools: string[]; affectedTokens: string[];
  startToken: string; profitToken: string;     // === flashToken
  flashToken: string;                          // pinned by scanner; planner MUST NOT rotate
  searchSeed: { searchCenter: bigint; maxInput?: bigint };  // flashToken units, center > 8n
  estSpreadBps: number;                        // telemetry/ranking only — never identity
  leavesStandingPosition?: boolean;            // = pathLeavesStandingPosition(seedEdges); derived, for the safety gate
  targetNetProfit?: bigint;
  hints: Record<string, unknown>;              // MUST NOT contain hints.impact
}
export type Opportunity = BackrunOpportunity | BlockScanOpportunity;
```

Discriminant is `strategy_kind` (verdict item 2). TypeScript makes the migration exhaustive: every
`opp.victimTxHash`/`opp.victimAmountIn` access errors until narrowed by `opp.strategy_kind`. Reader surface
to migrate (compile-checked): `main.ts`, `events.ts`, `planner/planner.ts`, `solver/solver.ts`, `detector/*`
+ tests (the union's only current construction site is `detector.ts` `detect()`).

### 1.4 Cycle identity — `listener/src/searcher/detector/cycle-fingerprint.ts` (CREATE, F1)

```ts
export function canonicalTokenRing(ring: readonly string[]): string[];   // rotate lowest-addr first + orient
export function cycleFingerprint(sourceBlock: number, ring: readonly string[]): string;  // keccak(block|ring)
```
Rotation- + direction-invariant; distinct rings ⇒ distinct fingerprints; size/venue/route NOT in identity
(comparison attributes only). Temporal law (user pt 1): a competitor tx executing in block `B` joins at
`cycleFingerprint(B−1, ring)` — the analysis side always aligns `source_block = execution_block − 1`. Lives
in `listener` so both sides share ONE join-key implementation.

### 1.5 `EdgeSequence` — analysis-side venue-by-venue path descriptor

```ts
// analysis/src/learning/edge-sequence.ts (CREATE, F2)  — describes OUR or a COMPETITOR's realized/planned path
export interface EdgeSequence {
  strategy_kind: StrategyKind;
  edge_kinds: EdgeKind[];                       // e.g. ["swap","credit","swap"] — surfaces a credit leg in analysis
  venues: string[];                             // pool ids/addresses in ring order
  tokens: string[];                             // ring token sequence
  leaves_standing_position: boolean;            // any credit edge ⇒ true (posture flag on the analysis side)
}
```
This is a descriptor, not a runtime object — it is how `LearningCase` records "what venue/edge shape did the
winner (or our replay) use", so a credit leg is legible to the learning loop (not force-fit into swap-only).

### 1.6 `LearningCase` — `analysis/src/learning/learning-case.ts` (CREATE, F2)

The ONE strategy-agnostic learning object. `bundle-postmortem` (backrun) AND `strategy-compare` (block-scan)
OUTPUT it; `auto-close-strategy-gap` INPUTs it. Never a per-tool report shape (rule 16, user pt 3).

```ts
export interface LearningCase {
  learning_case_id: string;   // keccak(strategy|trigger|competitor_tx|source_block|cycle_fingerprint|primary_gap)
  status: "open" | "proposed_close" | "replay_passed" | "applied" | "live_verified"
        | "parked_uneconomic" | "manual_required";                    // forward-only; two terminals
  strategy: StrategyKind;
  trigger: "bundle_not_included" | "competitor_not_seen";
  competitor_tx?: string; our_opportunity_id?: string;
  source_block?: number;      // block-scan: execution_block − 1 (user pt 1)
  target_block?: number;      // block-scan: execution_block
  cycle_fingerprint?: string;
  edge_sequence?: EdgeSequence;                                        // §1.5 — venue/edge-kind shape (surfaces credit legs)
  comparable: boolean;        // winner_style atomic_loop only; one_leg_inventory/sandwich ⇒ false (short-circuits close)
  primary_gap: PrimaryGap;    // §1.7 converged taxonomy, FUNNEL-ORDERED (first blocking gap)
  secondary_gaps?: PrimaryGap[];
  our_stage?: "not_scanned"|"cycle_not_found"|"no_plan"|"no_quote"|"sizing_failed"|"sim_failed"
            |"below_ev"|"submitted_lost"|"replay_state_unavailable";
  strategy_view_version?: string; atomic_view_hash?: string; backrun_view_hash?: string;   // P1-5 attributability
  capability_replay_stage?: string; live_admission_stage?: string;    // P1-4 capability vs live-admission
  evidence: Record<string, unknown>;
  close_action?: { kind: string; target_file?: string; entries?: string[] };
  replay_gate?: { command: string; expected_transition: string; before?: string; after?: string };
  created_at: string; updated_at: string;
}
```
Store `analysis/learning-cases/store.json` (committed — small derived JSON, no secrets; same durability
rationale as `force-include-poolids.json`). API `loadCases()/upsertCase()/advanceStatus(id,next)` —
forward-only. `parked_uneconomic` = the dust steady-state terminal (coffee's 8/9 sub-EV land here); re-opens
ONLY on the same `cycleId` reappearing with `estSpreadBps ≥ k×` parked (default k=3). Replay-verdict cache
`analysis/learning-cases/replay-cache/<id>.json` (gitignored; one replay per case-version — CU discipline).

### 1.7 `primary_gap` taxonomy — the converged, funnel-ordered set (credit ADR wins)

```ts
export type PrimaryGap =
  // pre-funnel intake
  | "source_not_seen" | "view_missing" | "edge_kind_disabled" | "atomic_scan_not_triggered"
  // coverage / path
  | "venue_missing" | "path_not_found" | "quote_failed" | "sim_failed"
  // economics
  | "below_ev" | "gas_underwater" | "liquidity_or_cap_bound"
  // auction
  | "outbid" | "lost_intra_lane_priority"
  // terminals (no coverage fix)
  | "non_comparable_winner"          // one_leg_inventory / sandwich / JIT — we correctly did nothing
  | "standing_position_required"     // credit policy gate — human decision, not a coverage fix
  | "oracle_not_diverged"            // credit true-negative (edge inactive)
  | "replay_state_unavailable" | "manual_required";
```
`primary_gap` = FIRST blocking gap in funnel order; the block-scan-specific classes (`atomic_cycle_not_found`,
`atomic_sizing_failed`, `atomic_view_missing_venue`, …) from atomic-epic §C2 MAP onto this set (mapping in
§3.2) and any extra distinctions go in `secondary_gaps[]`, not a parallel enum (verdict: "atomic classes map
on; keep distinctions as secondaryGaps").

---

## 2. Foundation slices (build ONCE, before any strategy/edge runtime)

Order **F1 → F2 → F3 → F4** (F2 may run in parallel with F1 once the types compile). Nothing in §3 may start
until F1–F4 are green — that is the whole point of the reconciliation (two workstreams collide irreversibly in
`main.ts`/`execution/`/`analysis/learning/` if either writes runtime code before the spine lands).

### F1 — Unified types (the spine)

| action | file | change |
|---|---|---|
| MODIFY | `listener/src/searcher/detector/detector.ts:6` | §1.3 `Opportunity` union; discriminant `kind:"backrun-arb"` → `strategy_kind:"backrun"`; add `BlockScanOpportunity` |
| MODIFY | `listener/src/searcher/planner/token-graph.ts` | add `export type VenueEdge = TokenEdge` (§1.2); NO field change (already widened) |
| CREATE | `listener/src/searcher/detector/cycle-fingerprint.ts` | §1.4 |
| MODIFY | `listener/src/searcher/events.ts:38` | `makeOpportunityId` `victimHash` → optional; add `makeAtomicOpportunityId`; widen event fields (§F3 telemetry) — the type/optionality part lands here, emission sites in F3 |
| (reuse) | `listener/src/searcher/strategy-taxonomy.ts` | already exports `StrategyKind`/`EdgeKind`/`pathLeavesStandingPosition` — import, do not redefine |

**Code direction:** pure type work + one alias + one small pure module. The risky part is the `strategy_kind`
rename ripple; lean on TypeScript exhaustiveness (every un-narrowed `opp.victimTxHash` errors) to find every
reader. `detect()` still returns `BackrunOpportunity[]` (zero behavior change).

**Rule-12 gate (deterministic, `searcher:planner` + `searcher:ac3`):** backrun planner suite + wstUSR AC-3
replay pass **unchanged** (type-only change proven behavior-neutral); a new `cycle-fingerprint` unit asserts
rotation-invariance, direction-invariance, distinct-ring-distinct-fp, size-excluded-from-identity.
`expected_transition:` compile-clean union + `searcher:planner` 14/14 unchanged + AC-3 wstUSR delta ≈273 wstUSR
unchanged. `verdict: fixed` requires the suites green, not just `build passes`.

### F2 — LearningCase by EXTENSION over bundle-postmortem / census (never a parallel path)

| action | file | change |
|---|---|---|
| CREATE | `analysis/src/learning/learning-case.ts` | §1.6 schema + `loadCases/upsertCase/advanceStatus` (forward-only) |
| CREATE | `analysis/src/learning/edge-sequence.ts` | §1.5 |
| MODIFY | `analysis/src/cli/bundle-postmortem.ts` | EMIT a `LearningCase` (backrun): map `winner_style` → `primary_gap` (`route_gap_decisive` → `venue_missing`; `non_comparable_winner` stays terminal); `in_graph` → `evidence`; reuse existing pricing |
| MODIFY | `analysis/src/cli/census-report.ts` | EMIT a `LearningCase` per competitor tx: consume C1 `atomic_scan_shape` (`tx-shape.ts`) + `sender-flow` two-axis; `atomic_state_arb` + `comparable` ⇒ block-scan case |
| CREATE | `analysis/src/test/learning-case.ts` + npm `test:learning-case` | the gate |

**Where the two workstreams feed the ONE object (verdict requirement):**
- **C1's `atomic_scan_shape`** (`tx-shape.ts:27` `atomic_state_arb`/`backrun`) → the census `LearningCase.strategy`
  (via `strategyKindFromTxShape`, `strategy-taxonomy.ts:5`) + `trigger:"competitor_not_seen"`.
- **credit's `winner_style` → `primary_gap`** (bundle-postmortem): `non_comparable_winner` (one_leg_inventory /
  sandwich) sets `comparable:false` → short-circuits before any close; `route_gap_decisive` → `venue_missing`.
- **edge-kind legibility:** if a competitor/our path touched a `lend`/credit venue, `edge_sequence.edge_kinds`
  carries `"credit"` and `leaves_standing_position:true` — so the credit workstream's data is first-class in
  the same learning object, not bolted on.

**Rule-12 gate (deterministic, `test:learning-case`, reuses existing postmortem fixtures):** replay pinned
`0xa32b646c…` → `LearningCase{strategy:"backrun", primary_gap:"venue_missing"}`; `0xee7b98ad…` →
`{comparable:false, primary_gap:"non_comparable_winner"}` (never a phantom coverage gap); the 9 coffee txs
(C1 fixtures) → 8 `{strategy:"block-scan", trigger:"competitor_not_seen"}` + 1 `{strategy:"backrun"}`.
`expected_transition:` postmortem/census now OUTPUT `LearningCase`, backrun aggregation byte-unchanged.

### F3 — SubmissionCoordinator + the shared submit entry (the A-contract plumbing)

| action | file | change |
|---|---|---|
| CREATE | `listener/src/searcher/execution/submission-coordinator.ts` | §1.4 of atomic-epic — pure, **sync `offer()`** |
| MODIFY | `listener/src/searcher/events.ts` | emit the widened fields + `atomic_scan_result` + new `pipeline_dropped` reasons |
| MODIFY | `listener/src/searcher/execution/bundle-router.ts:6` | `victimTxHash?: string` (standalone path `:81` already ignores it) |
| MODIFY | `listener/src/searcher/main.ts` | factor out `processOpportunities(ctx, opps, sourceMeta)` from the ~640-line `handleHint` tail; route BOTH submit sites through the coordinator |
| CREATE | `listener/src/searcher/test/atomic-contract.ts` + npm `searcher:atomic-contract` | the gate |

```ts
export interface SubmissionCandidate { strategy: StrategyKind; opportunityId: string;
  targetBlock: number; netEvWei: bigint; deadlineAtMs?: number; }
export type SlotDecision =
  | { admit: true; replaces?: SubmissionCandidate }
  | { admit: false; reason: "submission_arbitration_lost"|"atomic_preempted_by_backrun"; holder: SubmissionCandidate };
export class SubmissionCoordinator {
  constructor(policy?: { atomicPreemptMarginBps?: number });   // default 0 = block-scan never preempts backrun
  offer(c: SubmissionCandidate): SlotDecision;                 // SYNC — atomic within one event-loop tick
  onBlock(latest: number): void;                              // prune slots targetBlock <= latest
}
```
Decision matrix (one slot per `targetBlock`; grounded in `submitter.ts:296` one pending nonce + `:79/:250` one
pinned target block): empty→admit; backrun-vs-backrun→admit (replace, preserves today's serial last-write);
backrun-holder vs block-scan→reject `atomic_preempted_by_backrun`; block-scan-holder vs backrun→admit+replaces
(the displaced block-scan emits `atomic_preempted_by_backrun`); block-scan vs block-scan→admit iff higher
`netEvWei` else `submission_arbitration_lost`. **With `SEARCHER_ENABLE_ATOMIC_SCAN=0` every offer is
backrun-vs-backrun ⇒ always admit ⇒ zero behavior change** (asserted).

**`processOpportunities` factor-out (the single risky move — scope it MECHANICALLY):** extract the
`handleHint` opportunities loop body (detect→plan→solve→sim→terminal-verify→EV-gate→submit + every
`pipeline_dropped`) into `processOpportunities(ctx, opportunities: Opportunity[], sourceMeta)`. `sourceMeta`
is `{strategy_kind:"backrun"; victimTxHash; submissionMode; eventBlockNumber}` or `{strategy_kind:"block-scan";
sourceBlock}` (targetBlock derived = sourceBlock+1, PINNED). Zero logic edits; closures become explicit
params/`ctx` fields; target-block branch: backrun keeps `latest+1` at submit (`main.ts:1834`, unchanged);
block-scan pins `sourceBlock+1` and drops `atomic_stale_target_block` when `latest > sourceBlock`. `handleHint`
delegates with the backrun `sourceMeta` — every existing fixture replays byte-identical.

**Rule-12 gate (deterministic, `searcher:planner` + `searcher:replay-live-fixtures` + `searcher:atomic-contract`):**
backrun suites pass **unchanged** (14/14 + live-fixture profit equivalence 1 wei). New unit asserts (a) two
block-scan anchors in one `sourceBlock` ⇒ distinct `opportunity_id`s (no fabricated victim-hash collision);
(b) same ring 2 rotations × 2 directions ⇒ same `cycle_fingerprint`; (c) ≥2 profitable block-scan opps one
block ⇒ exactly one `bundle_submitted`, losers `pipeline_dropped/dedup_per_block`; (d) backrun + block-scan
same target ⇒ one submitted, block-scan loser `atomic_preempted_by_backrun` (coordinator-only); (e)
atomic-off ⇒ N backrun offers → N admits (neutrality); (f) **R3 compat** — `redact-live-run` +
`route-gap-watcher --dry-run` over a mixed events fixture: no crash, backrun aggregation unchanged.

### F4 — Block-scan lane / AtomicView + A-universe selection views (the isolation infra)

This slice unifies **atomic-epic A-universe + A-lane** with **credit slice 7** (they are the same infra — the
verdict: "ONE block-scan lane / `AtomicView` == credit's deferred slice 7").

| action | file | change |
|---|---|---|
| CREATE | `listener/src/searcher/strategy-views.ts` | `buildStrategyViews` (below) + P1-5 `versions.*` |
| CREATE | `listener/src/searcher/atomic-view-overrides.ts` | loader/appender mirroring `force-include.ts` — `DEFAULT_ATOMIC_VIEW_OVERRIDES_PATH = resolve("searcher","pools","atomic-view-overrides.json")` (cwd-relative `searcher/pools/`, NOT `src/`) |
| CREATE | `listener/searcher/pools/atomic-view-overrides.json` | committed `[]` seed (survives deploy) |
| CREATE | `listener/src/searcher/atomic-lane.ts` | `AtomicLane` — owns `atomic_busy`, its OWN `PoolStateCache` + `PoolStateUpdater` + sim backend instance, chunked scan driver, `lastTriggerBlock` |
| MODIFY | `listener/src/searcher/main.ts` (~`:560-610`) | build views; backrun view feeds planner graph (`:603`) + mempool `toAddress` filter; atomic view feeds the lane; construct lane deps behind `SEARCHER_ENABLE_ATOMIC_SCAN` (construction only — `newHeads` hook is A4) |
| CREATE | `listener/src/searcher/test/universe-split.ts` + npm `searcher:universe-split` | A-universe gate |
| CREATE | `listener/src/searcher/test/atomic-lane.ts` + npm `searcher:atomic-lane` | A-lane gate |

```ts
export interface StrategyViews {
  backrun: PoolEntry[]; atomic: PoolEntry[];
  versions: { strategy_view_version: string; backrun_view_hash: string; atomic_view_hash: string;
              pool_universe_generated_at: string; overrides_hash: string; };   // P1-5
}
export function buildStrategyViews(basePools, universeFile, overrides,
  opts: { atomicMaxPools: number }): StrategyViews;
// backrun = basePools BIT-FOR-BIT today's selection (main.ts:560-603 unchanged in effect)
// atomic  = backrun ∪ selectArbRelevantPools(universeFile) ∪ overrides, capped atomicMaxPools
```

**A-universe rules (the decoupling):** the mempool `toAddress` filter is built from `views.backrun` ONLY —
so an atomic-relevant pool can never displace a source-swap-likely pool from the 200 hot slots (the crowding
hazard). ONE union edge graph; the backrun planner keeps consuming exactly today's edges (`main.ts:603`);
block-scan planning is `seedEdges`-bound so the planner never needs the atomic view. `selectArbRelevantPools`
promotion from build-time (`build-active-pool-universe.ts:238`) to this runtime view IS the arb-relevance-epic
unification (`project-pool-scoring-arb-relevance-epic`).

**A-lane rules (P0-1 contract):** (1) two independent busy flags — the lane NEVER reads/writes the hint loop's
`busy` (`main.ts:680/:858/:870/:906`); a backrun hint arriving mid-scan MUST process (zero new `skip hint`).
(2) shared read-only reth; PRIVATE mutable cache + sim (backrun's cache is mutated by the warm loop mid-hint —
sharing is the R2 corruption hazard). (3) Node event-loop honesty — one JS thread, so the scan runs in bounded
pure chunks with cooperative yields (`setImmediate`-equivalent between pair-batches, budget per chunk); each
chunk stays pure so the F-block-scan C2 replay is exact. (4) `lastTriggerBlock` gap-inclusive trigger fetch.
The ONLY cross-lane objects: `SubmissionCoordinator` (sync `offer()`), append-only events, `blockTracker`
(read-only).

**Rule-12 gate:**
- `searcher:universe-split` (deterministic): (i) `buildMempoolToAddressFilter(views.backrun)` set-equal
  before/after widening the atomic view by 1000 pools (no displacement — decoupling proof); (ii) atomic view
  has ≥1 loop-closure pool absent from the backrun set + the backrun EDGE set excludes it / atomic edge set
  includes it (nail #1); (iii) `appendAtomicViewOverrides([X])` ⇒ X ∈ atomic view AND X ∉ backrun view AND X
  ∉ mempool filter (nail #6 loader gate + Gap-D isolation invariant); (iv) **P1-5** — identical inputs ⇒
  identical `versions.*`; append one override ⇒ `atomic_view_hash` + `strategy_view_version` change,
  `backrun_view_hash` unchanged (the attributability primitive).
- `searcher:atomic-lane` (deterministic): backrun hint injected mid-atomic-scan IS processed — **zero
  `skip hint` attributable to the lane**; hint start-delay ≤ one chunk (event-loop yield proof); own-lane
  overrun ⇒ `atomic_scan_result{outcome:"skipped_busy"}` keyed on `atomic_busy` only; backrun suites unchanged
  with the lane constructed-but-idle (refactor-neutral).

---

## 3. Strategy / edge-specific slices (fork AFTER the foundation)

Three forks, all plugging into F1–F4. **backrun** needs no new runtime work (F1 re-parents it to
`strategy_kind:"backrun"`). **block-scan** = the scanner (A0–A4). **credit** = the adapter (credit 3/5/6/8).

### 3.1 backrun (existing) — now `strategy_kind:"backrun"`

No runtime change beyond F1's rename. Its learning half is F2 (bundle-postmortem → LearningCase). Regression
guard: `searcher:planner` 14/14 + `searcher:replay-live-fixtures` profit equivalence 1 wei + AC-3 unchanged
across F1–F4 (refactor-neutral is the standing gate every foundation slice re-runs).

### 3.2 block-scan scanner (atomic-epic A0–A4, re-parented onto the spine)

`primary_gap` MAP (atomic §C2 class → §1.7 taxonomy): `atomic_view_missing_venue`→`view_missing`;
`atomic_scan_not_triggered`→`atomic_scan_not_triggered`; `atomic_cycle_not_found`→`path_not_found`;
`atomic_sizing_failed`→`path_not_found`(+`secondary:sizing`); `atomic_quote_fidelity_failed`→`quote_failed`;
`atomic_sim_revert`→`sim_failed`; `atomic_below_ev_gate`→`below_ev`; `atomic_budget_skipped`→
`atomic_scan_not_triggered`(+`secondary:budget`); `atomic_competitor_faster_or_outbid`→`outbid`.

| slice | files (CREATE/MODIFY) | code direction | rule-12 gate |
|---|---|---|---|
| **A0** decode fixture (run FIRST — R5 reth-prune window) | C `test/fixtures/atomic-coffee-803a3693.json`, C `test/atomic-a0-replay.ts` + npm `searcher:atomic-a0` | at block 25455023 read the 3 cycle pools' state from local reth (fallback archive), PERSIST states into the fixture, recompute with `solver/v3-math.ts`+CP | `searcher:atomic-a0`: cycle reconstructable from public state, `expectedGrossWei>0` recorded — the A1/A2/A3 fixture |
| **A1** anchor finder (O(pairs) 2-hop) | C `detector/atomic-scanner.ts`, M `planner/planner.ts` (atomic branch), M `solver/pool-state-cache.ts` (`seedBlockOf(pool)`), M `test/planner.ts` | `detectAtomicOpportunities` PURE+SYNC over the warm cache (zero RPC — makes the offline replay exact); delta-restrict to `swapTouched` pairs with ≥2 venues; mid-price v2/v3; `searchCenter` from anchor depth/spread (replaces the `1n` fallback `solver.ts:449`); emit 2-edge `seedEdges`; `plan()` head branches `if strategy_kind==="block-scan" return planAtomicFromSeedEdges(...)` (never `buildTokenPaths`/`focusPathsOnImpact`/`buildBorrowabilityRotations`) | `searcher:planner`: anchor fixture `candidate_plans 0→>0`; every candidate path contains exactly the seed pools; center `>8n` in flashToken units, no rotation; no-spread control ⇒ 0 anchors |
| **A2** bounded 3–4-hop extension (the value band) | M `detector/atomic-scanner.ts`, C `test/bench-atomic.ts` + npm `searcher:bench-atomic` | REUSE `buildTokenPaths(atomicEdges, t, t, {maxHops:4, maxPoolsPerToken:8, maxPaths:2000, deadlineAtMs})` (`token-graph.ts:462`, start===profit enumerates cycles) seeded ONLY from A1 anchor tokens; hard cap `SEARCHER_ATOMIC_MAX_HOPS=4`; budget deadline hard-stops | `searcher:planner`: A0 3-hop fixture ring found, `candidate_plans 0→>0`, all 3 seed pools in path. `searcher:bench-atomic`: full A1+A2 pass < between-block budget @ maxHops≤4 (relative); fallback maxHops=3 (still #2) recorded |
| **A3** no-source-swap solve + sim + standalone build | M `solver/solver.ts` (`resolveSearchCenter` head), M `test/replay-live-fixtures.ts` | `if strategy_kind==="block-scan" return searchSeed.searchCenter` before the `victimAmount` read (TS-enforced narrow; backrun byte-identical); solve (deadline=atomic budget) → terminal verify (`main.ts:1617`) → EV gate → `standalone` bundle (no `victimTxHash`, `bundle-router.ts:81`) | `searcher:replay-live-fixtures`: `sim.success + netEV>0 post-gas + EV gate pass + standalone BundleSubmission`; assert resolved center from `searchSeed` (`center>8n`) — the `1n` dust-grid mode stays dead |
| **A4** live wiring + dry-run window (**BLOCKED**) | M `main.ts` + `atomic-lane.ts` (`newHeads`→lane), C `atomic-breaker.ts`, M `scripts/deploy-node.sh` (env-preserve + banner `atomicScan=on/off atomicView=N overrides=N atomicViewHash=0x…`) | lane driver: TRIGGER (`fetchSwapTouchedVenues` — swap logs TRIGGER-only, never a consistency proof, P0-2) → EXPAND peer/return venues (P0-3) → FRESH-READ every candidate-cycle pool at `blockTag=sourceBlock` into the lane cache → gate `seedBlockOf(pool)===sourceBlock` else drop `atomic_state_inconsistent` → scan (chunked) → submit ONE best/block via coordinator; drop `atomic_stale_target_block` if `latest>sourceBlock` at submit | **metrics (rule-12 non-det exemption)** over a dry-run window flag ON: atomic `opportunity_seen>0`, ≥1 atomic `simSuccess` on a real block (dust labeled dust, EV floor honored), C2-minimal shows a competing candidate for ≥1 coffee atomic tx (script-driven); **regression:** backrun `expired-before-solver` + hint `prep_ms p95` not materially up AND zero lane-attributable `skip hint`; every newHead emits one `atomic_scan_result`; P1-5 view fields present. Thin window ⇒ EXTEND |

Pre-gates BLOCKING A4 (pinned fixtures in `searcher:planner`, green before the window): **P0-3** cold cache +
one swap-touched pool + cold return venue ⇒ peer expanded + fresh-read + candidate found (`0→>0`); **P0-2**
(a) `seedBlockOf<sourceBlock` cycle pool ⇒ dropped `atomic_state_inconsistent`, never quoted; (b) no
"no-swap-so-still-valid" bypass (gate on seed-block alone); (c) spread gone after fresh-read ⇒ dropped, zero
solver entry; (d) unreadable pool ⇒ dropped, never guessed.

### 3.3 credit adapter (credit slices 3/5/6/8) — plugs into the SAME spine

The credit edge is STRATEGY-AGNOSTIC (verdict): EITHER `backrun` or `block-scan` may route it via
`ENABLE_CREDIT_EDGES_FOR_{BACKRUN,ATOMIC}` independent flags. Its natural home is the block-scan lane (a
credit edge decays on the oracle keeper's update, not a victim swap), but nothing binds it there.

| slice | files (CREATE/MODIFY) | code direction | rule-12 gate |
|---|---|---|---|
| **Cr-3** credit recognized in ANALYSIS/replay (prod flag OFF) | M `test/planner.ts` `REPLAY_FIXTURES` (add `0xf88b…`), M `analysis` census/postmortem (surface `edge_kinds:["credit"]`) | recognize the wired fluid `lend` edge (`token-graph.ts:112`) as a credit edge in the planner replay; NO runtime enable | **`searcher:planner`**: `0xf88b…` fixture — credit edge PRESENT ⇒ `candidate_plans 0→≥1`, ABSENT ⇒ 0 (pure, no anvil, like the CFG fixture); optional AC-3 token-delta ≈273 wstUSR |
| **Cr-5** Fluid credit adapter (new runtime, flag OFF, credit-live human gate) | M `solver/quoter.ts:358` (replace `quoteFluidVault()` throw with resolver quote), M `solver/solver.ts` (DELETE `fluidDebtBps` GSS dimension), M `solver/plan-builder.ts` (gas table + credit-live reject guard), M `scripts/deploy-node.sh` (`.credit-live` marker) | resolver `quote()` via `VaultResolver.getVaultEntireData` (zero-CU read) → deterministic max-safe-borrow (out-per-in linear under abandonment, so debt-sizing is degenerate — a solver-contract change) + haircut ε (9999-bps precedent); abandon-by-capability-absence (NO close action — already true, `plan-builder.ts:163-177` `nftId:0`, no close); per-credit-leg isolated `nftId`; **per-adapter GAS TABLE** (credit 250–400k vs ~100k swap; at `gas_estimate=0` credit over-ranks without it); **credit-live reject guard keyed on `pathLeavesStandingPosition(edges)`** (`strategy-taxonomy.ts` — the SHIPPED predicate), not a strategy label; market-priced profit in the EV gate | **`searcher:planner`**: `0xf88b` `candidate_plans 0→1` + deterministic quote sim ≈273 wstUSR; **guard test**: a plan with a `leavesStandingPosition:true` edge is REJECTED unless `.credit-live` set; **gas-table test**: credit leg costed 250–400k, not 0 |
| **Cr-6** credit routing in backrun view (flag OFF) | M `strategy-views.ts` (`projectView` materialized set), M `main.ts` (depeg-gated insertion) | `ENABLE_CREDIT_EDGES_FOR_BACKRUN=0` drops credit at VIEW-PROJECTION time (credit edges are `score:undefined`→pinned→exempt from top-N `token-graph.ts:474`, so scoring never prunes them — must drop at projection); depeg-gated insertion (oracle-vs-DEX-mid spread threshold) so a pinned credit backbone doesn't regrow path-explosion | **`searcher:planner`** flip: flag=1 ⇒ backrun routes credit (proves strategy-agnostic); flag=0 ⇒ absent from the PROJECTED view (proves projection-drop, not scoring) |
| **Cr-8** Aave/Euler + e-mode (new runtime, flag OFF) | C adapters behind the resolver-quote interface | shared-target `marketId` discriminator (Aave = one Pool many reserves, like the v4 singleton — needs a discriminator for `sameDirectedEdge`/dedup); e-mode account-global on Aave (one account can't serve e-mode + non-e-mode legs) | per-protocol `searcher:planner` flip `candidate_plans 0→≥1` + shared-target dedup asserted |

**Credit safety wiring (the 5 invariants, all honored above):** (1) `leavesStandingPosition` on the EDGE
(shipped `token-graph.ts:25`), never a strategy label; (2) strategy-agnostic (independent enable flags); (3)
bounded-live does NOT cover credit — `deploy-node.sh` + submit REJECT any `leavesStandingPosition:true` plan
unless a SEPARATE `/opt/MEV/.credit-live` marker (independent of `.deploy-live`+wallet cap, since
`assert-balance` `plan-builder.ts:113` bounds only the FLASH token, not the standing position) + a
per-credit-leg position account; (4) credit quote is 2-D (borrow-size explicit, not flattened into the swap
1-D quote); (5) per-adapter gas table mandatory.

---

## 4. Ordered build plan + gating

### 4.1 Dependency DAG

```
                 F1 (types/union/cycle-fp)  ──┬──►  F2 (LearningCase over postmortem/census)   [parallel-OK]
                                              │
                                              └──►  F3 (SubmissionCoordinator + processOpportunities)
                                                        │
                                                        ▼
                                              F4 (strategy-views + AtomicLane isolation)
                                                        │
                   ┌────────────────────────────────────┼──────────────────────────────────────┐
                   ▼                                     ▼                                        ▼
   block-scan: A0 (run first, R5) ─► A1 ─► A2 ─► A3 ──► [A4 BLOCKED]        credit: Cr-3 ─► Cr-5 ─► Cr-6 ─► Cr-8
                   │                                                                  (Cr-5+ BLOCKED behind .credit-live + 2nd account)
                   └─► C2-minimal (analysis, BEFORE A4) ─► C2-full + D (close half, after A4)
```
`A0` is dependency-light (a pure replay fixture) and runs FIRST for the reth-prune window (R5), parallel with
F1/F2. `Cr-3` needs only F1 (recognize the shipped fluid `lend` edge in planner replay) — GO early.

### 4.2 GO now vs BLOCKED (owner re-gate 2026-07-04, encoded — do not re-litigate)

| status | slices |
|---|---|
| **GO now** | F1, F2, F3, F4, A0, A1, A2, A3 (offline-fixture scope), Cr-3, C2-minimal (build + REPORT). C1 = **DONE** (shipped) |
| **BLOCKED** | **A4 live wiring** — until F4's `searcher:atomic-lane` + the P0-2/P0-3 fresh-read pre-gates are green. **Cr-5/Cr-6/Cr-8 live routing** — behind the `.credit-live` marker + a per-credit-leg position account + a Safety-1 human gate (their ANALYSIS/replay gates are GO; live enable is not). **C2-as-authoritative-close-input + D acting on it** — until P1-4 (capability/live-admission split) + P1-5 (view versioning) land. **go-live / broadcast** — always a human gate |

**Owner re-gate P0/P1 (block-scan), preserved:** P0-1 lane isolation = F4 `AtomicLane` (own `atomic_busy`/cache/sim);
P0-2/P0-3 merged fresh-read gate = A4 pre-gates; P1-4 capability-vs-live-admission split = C2-minimal; P1-5 view
versioning = F4 `versions.*` + on events/LearningCase. The 5-blocker conditional approval (P0-1/2/3, P1-4/5)
is fully mapped: P0-1→F4, P0-2/3→A4 pre-gates, P1-4→C2-minimal, P1-5→F4.

**Credit 5 safety invariants (§3.3) are the credit analog of the owner re-gate** and BLOCK any live credit
enablement exactly as A4-live is blocked.

### 4.3 Implementation order (linear, one Codex brief per slice, rule 7/11)

`C1 (done) → A0 → F1 → F2 → Cr-3 → F3 → F4 → A1 → A2 → A3 → C2-minimal → [A4 BLOCKED] → Cr-5 → Cr-6 →
C2-full → D → Cr-8`. B-residual (mempool quota buckets) is conditional/evidence-gated (only on a live
truncation log), any time. Each slice = Claude plans → Codex writes → Claude gates + commits.

---

## 5. What changes vs the two source specs (migration note)

| item | source spec | fusion resolution |
|---|---|---|
| **atomic-epic `Opportunity` union** | `kind:"backrun-arb"\|"atomic-arb"` (§1.1) | **RE-PARENT**: discriminant `strategy_kind:"backrun"\|"block-scan"`, `AtomicOpportunity`→`BlockScanOpportunity`. Field/name change only; the whole scanner/planner/solver body survives (naming re-parent, not a redesign — the verdict) |
| **atomic-epic A-universe + A-lane** | separate atomic slices | ABSORBED into **F4** together with **credit slice 7** — ONE block-scan lane/AtomicView (they were the same infra authored blind) |
| **atomic-epic §1.4 SubmissionCoordinator + §1.5 LearningCase** | atomic-owned | promoted to **foundation F3/F2** — strategy-agnostic, built once; `strategy:"backrun"\|"atomic"`→`StrategyKind` |
| **credit slice 1 (unified types)** | credit-owned | FOLDED into **F1** — and mostly already SHIPPED (taxonomy + TokenEdge widening); F1 is now just the union + alias + cycle-fp |
| **credit slice 2 (LearningCase by extension)** | credit-owned | == atomic-epic C2/D refactor → **F2** (one owner, one PR; never open `bundle-postmortem.ts` twice) |
| **credit slices 3/5/6/8** | credit-owned | the **credit fork** (§3.3), plugged into F1–F4; Cr-3 GO early (needs only F1) |
| **shipped C1** | "re-label tx-shape enum" | **kept as shipped** — tx-shape retains its chain-observable `shape` enum + a `strategyKindFromTxShape` BRIDGE (D3 below); sender-flow/swap-log-registry/victim-source reused as-is |
| **primaryGap** | atomic `atomic_*` enum vs credit funnel-ordered set | credit converged set (§1.7) wins; atomic classes MAP on (§3.2); distinctions → `secondary_gaps[]` |

**The single highest-friction item that gates everything (unanimous):** the spine — `strategy_kind` +
`VenueEdge`(`=TokenEdge`) decided together, ONCE, before any runtime code. Ship the atomic-epic A-contract
first with `kind:"atomic-arb"` hard-coded and the credit spine forks / forces a painful rename back through
the ~640-line `processOpportunities` factor-out. **F1 is that decision made concrete.** (Mostly de-risked
because the taxonomy already shipped — the remaining collision is only the `Opportunity` union field name.)

### Divergences where I judged the settled verdict needs adjustment

- **D1 — `strategy_kind` labels are `backrun`/`block-scan`, NOT `reactive`/`block-scan`.** The verdict/ADR
  say `reactive`. But `strategy-taxonomy.ts:1` already SHIPPED `StrategyKind = "backrun" | "block-scan"`.
  Reuse the shipped type (DRY, one source of truth). `backrun` is trigger-descriptive and does NOT imply
  principal-safety, so it satisfies the anti-laundering goal exactly as `block-scan` does; re-renaming shipped
  code to `reactive` is churn with zero safety benefit today (YAGNI — no second reactive strategy exists). If
  one ever does, rename then. **Adjustment: honor the verdict's FIELD name (`strategy_kind`) but its VALUES
  are the already-shipped `backrun`/`block-scan`.**
- **D2 — `VenueEdge` is an alias for the already-widened `TokenEdge`, NOT a new class with `quote()`/`build()`
  methods.** The verdict phrases `VenueEdge{…, quote(), build()}`. But (a) `TokenEdge` already carries
  `edgeKind`+`leavesStandingPosition` (`token-graph.ts:16-26`), and (b) the credit ADR itself
  (`credit-venue-edge-20260704.md:92-95`) says "No Venue class hierarchy — the adapter registry already IS
  the polymorphism." So quote/build stay registry-dispatched by `adapterId`; `VenueEdge` is a one-line
  vocabulary alias. **Adjustment: `export type VenueEdge = TokenEdge`; the credit adapter adds `quote()` in
  the quoter (replacing the `quoter.ts:358` throw), not a method on the edge.** This avoids a needless
  edge-class refactor and matches the codebase's existing dispatch.
- **D3 — C1's `tx-shape` was NOT a raw enum rename; it shipped a bridge, which is better.** The verdict says
  "re-label tx-shape output enum to `strategy_kind`." Shipped code keeps `shape:"atomic_state_arb"|"backrun"|
  "unknown"` (the chain-observable) and maps to `strategy_kind` via `strategyKindFromTxShape`. Keeping the
  chain-observed shape distinct from the strategy label is cleaner (the shape is EVIDENCE; the strategy_kind
  is the DERIVED classification). **No change needed — the shipped bridge is the right call; F2 consumes the
  bridge, not a renamed enum.**

Everything else in the verdict stands and is built on as-is.

---

## 6. Acceptance matrix (every slice → executable rule-12 assertion)

Deterministic where possible (a pinned fixture that FLIPS); metrics-gated only for the non-deterministic
exemptions (latency / inclusion / live mempool / economics — rule 12).

| slice | harness / command | expected transition (rule-12) | type |
|---|---|---|---|
| **C1** (done) | `cd analysis && npm run test:tx-shape && npm run test:sender-flow && npm run test:swap-log-registry` | 9 coffee txs → 8 `atomic_state_arb` + 1 `backrun`; #9 `source_swap_seen_by_us=false`; no `maxPrio=0` forced-private; Curve/Balancer source not mislabeled atomic | det (SHIPPED) |
| **F1** | `cd listener && npm run searcher:planner && npm run searcher:ac3` | union compiles; backrun 14/14 + AC-3 ≈273 wstUSR **unchanged**; cycle-fp rotation/direction-invariant, size excluded | det |
| **F2** | `cd analysis && npm run test:learning-case` | `0xa32b…`→`{backrun, venue_missing}`; `0xee7b98ad…`→`{comparable:false, non_comparable_winner}`; 9 coffee → 8 block-scan + 1 backrun `LearningCase`; backrun aggregation unchanged | det |
| **F3** | `npm run searcher:planner && npm run searcher:replay-live-fixtures && npm run searcher:atomic-contract` | backrun suites unchanged (1-wei equiv); (a) distinct opp_ids; (b) same-ring→same fp; (c) ≥2 opps/block→1 submit + `dedup_per_block`; (d) backrun+block-scan same slot→1 submit + `atomic_preempted_by_backrun`; (e) atomic-off→all admit; (f) R3 mixed-events no crash | det |
| **F4** | `npm run searcher:universe-split && npm run searcher:atomic-lane` | backrun mempool set-equal after +1000 atomic pools (no displacement); atomic view ⊋ backrun; override→atomic-only, not mempool; P1-5 hashes; hint-mid-scan processed, zero lane `skip hint`; backrun suites unchanged, lane idle | det |
| **A0** | `npm run searcher:atomic-a0` | cycle reconstructable from public state, `expectedGrossWei>0` persisted (states, not just block) | det |
| **A1** | `npm run searcher:planner` | anchor `candidate_plans 0→>0`; every candidate path = exactly the seed pools; center `>8n` flashToken units, no rotation; no-spread control → 0 anchors | det |
| **A2** | `npm run searcher:planner && npm run searcher:bench-atomic` | A0 3-hop ring found `0→>0`, 3 seed pools in path; full scan < between-block budget @ maxHops≤4 | det + latency |
| **A3** | `npm run searcher:replay-live-fixtures` | `sim.success + netEV>0 + standalone bundle`; center from `searchSeed` (`>8n`), `1n` mode dead | det |
| **A4** (BLOCKED) | `scripts/deploy-node.sh` window + Step-1 cross-ref + `hermes-gate` | atomic `opportunity_seen>0`, ≥1 atomic `simSuccess` (dust labeled), competing candidate for ≥1 coffee tx; regression: backrun `expired-before-solver`/`prep_ms p95` flat + zero lane `skip hint`; one `atomic_scan_result`/newHead; P1-5 fields; late submit→`atomic_stale_target_block`, zero re-targeted bundles | **metrics** |
| **Cr-3** | `npm run searcher:planner` | `0xf88b…` credit present ⇒ `candidate_plans 0→≥1`, absent ⇒ 0 (pure); optional AC-3 ≈273 wstUSR | det |
| **Cr-5** (analysis GO; live BLOCKED) | `npm run searcher:planner` | `0xf88b` `0→1` + deterministic quote ≈273 wstUSR; `pathLeavesStandingPosition` plan REJECTED without `.credit-live`; credit leg gas 250–400k not 0 | det |
| **Cr-6** (live BLOCKED) | `npm run searcher:planner` | flag=1 ⇒ backrun routes credit; flag=0 ⇒ absent from projected view (projection-drop, not scoring) | det |
| **Cr-8** (live BLOCKED) | `npm run searcher:planner` | per-protocol `candidate_plans 0→≥1`; shared-target `marketId` dedup asserted | det |
| **C2-minimal** (report GO; authoritative BLOCKED) | `cd analysis && npm run strategy-compare` (×2 for idempotency) + offline `replayAtomicScanAt` | each coffee atomic tx aligns `source_block=B−1`, emits `competitor_shape` AND offline-replay `primary_gap`; `learning_case_id`+`status` (nail #5); aged-out → `replay_state_unavailable` not a gap (nail #7); P1-4 sweep-found-not-triggered → `atomic_scan_not_triggered`; P1-5 before/after view-hash change | det |
| **C2-full** (after A4) | `npm run strategy-compare` on A4 window | `competitor_profit vs our_simulated_best` + full taxonomy; `one_leg_inventory`/`sandwich` short-circuit (never closes) | det |
| **D** (after A4, BLOCKED on P1-4/5) | `npm run auto-close-strategy-gap` (×2) + per-gap replay | consumes `LearningCase` only; before→after stage flip (`atomic_view_missing_venue→scanner_found`; `atomic_cycle_not_found→candidate_plans>0`); isolation: `force-include-poolids.json` byte-identical + backrun mempool set-equal (writes `atomic-view-overrides.json` ONLY); idempotent by id; comparable-inconclusive → `pending-manual/<id>.json` | det |
| **B-residual** (conditional) | `npm run searcher:mempool-router-filter` | only if live truncation observed: 500 discovered + 250 hot ⇒ hot ≥ quota; fixed routers all present; deBridge stays admitted | det |

**`fixed` vs `implemented` (rule 12):** every deterministic slice above records the quartet
(`failing_sample / fix_commit / replay_command / expected_transition`) and is `fixed` ONLY when the SAME
sample replayed shows the bucket transition — `build passes` is never enough. A4 + the credit-LIVE enables are
the metrics-gated / human-gated exceptions.

---

## 7. Self-evolution parity — ONE learning loop, both strategies

```
                 BACKRUN                                    BLOCK-SCAN
trigger   bundle_not_included (our submit lost)     competitor atomic tx (census / C1 shape)
          └ route-gap-watcher (checkpointed)        └ strategy-compare (id-idempotent, nail #5)
                     └──────────────┬────────────────────────┘
analyze   bundle-postmortem (winner_style)          cycleFingerprint(B−1, ring) align → live events
                                    │                 else offline replayAtomicScanAt (reth→archive→unavailable)
                                    ▼
                    LearningCase (ONE schema §1.6; store.json; forward-only status;
                                  comparable filter short-circuits one_leg_inventory/sandwich)
                                    │
close     auto-close-strategy-gap (dispatch on strategy):
          backrun → force-include-poolids.json (existing)          [never crosses]
          block-scan → listener/searcher/pools/atomic-view-overrides.json ONLY (nail #6)
          credit → .credit-live human gate; economics → human gate
                                    │
verify    rule-12 flip on the SAME sample (REAL scanner in listener, consumed by analysis) → replay_passed
                                    │
live      next window: atomic_scan_result + funnel → live_verified; sub-EV dust → parked_uneconomic (terminal)
                                    │
blind spot comparable + closed=0 → pending-manual/<id>.json → fresh analyst names the class → CODIFY (rule 16)
```

The harness boundary is explicit: the ONLY scanner implementation lives in `listener`
(`detector/atomic-scanner.ts`, `atomic-replay.ts`); `analysis` imports it (precedent `live-loss.ts:15`) — no
drifting copy. Every step-4 blind-spot escalation is a tracked finding that BLOCKS cycle-close until codified
(rule 16 teeth).
