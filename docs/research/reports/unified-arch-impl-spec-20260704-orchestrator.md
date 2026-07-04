# Unified strategy × edge — fusion implementation spec (orchestrator draft, 2026-07-04)

> Scope: authorized, defensive on-chain arbitrage research; mainnet fork + dry-run; broadcast is a
> human-gated step. One of three blind fusion drafts (two fresh fable + this). Merges the atomic-arb EPIC
> and the credit-venue edge into ONE buildable plan per the settled reconciliation
> ([-3way-synthesis](arch-reconciliation-atomic-vs-credit-20260704-3way-synthesis.md)). Every non-trivial
> claim grounds in file:line. BUILD ON the verdict; do not re-litigate it.

## One-line
`Strategy Driver {reactive | block-scan} → Opportunity → Planner over an EdgeGraph {swap | credit | lp} →
SubmissionCoordinator → bundle`. Build the shared FOUNDATION once (types + one LearningCase + one
coordinator + one lane), THEN fork into strategy/edge slices that no longer collide. Atomic-arb = the
`block-scan × swap` cell; credit = the `credit` edge family either driver may route.

## 1. Unified model (types)

**`listener/src/searcher/venues/edge.ts` (CREATE)** — the widened edge (superset of `TokenEdge`,
`token-graph.ts:15`, which already carries `slotKind:"flash"|"lend"|"swap"` at `:20`; the wired Fluid vault
is already a `lend` edge, so this is name+generalize, not new math):
```ts
export type EdgeKind = "swap" | "credit" | "lp";        // lp = type stub only, build nothing
export interface VenueEdge extends TokenEdge {          // widen, never replace
  edgeKind: EdgeKind;
  leavesStandingPosition: boolean;                      // swap:false; credit(abandon-exit):true
  // quote()/build() stay venue-adapter-dispatched; credit keeps its 2-D (borrow-size) var explicit
}
```
**`listener/src/searcher/detector/detector.ts:6` (MODIFY)** — the discriminated union carries the strategy
axis, NOT a `kind:"atomic-arb"` label:
```ts
export type StrategyKind = "reactive" | "block-scan";   // reactive == backrun; NEVER "atomic"
export type Opportunity = ReactiveOpportunity | BlockScanOpportunity;
// BlockScanOpportunity: no source-swap fields, no hints.impact; seedEdges: VenueEdge[] (all edgeKind:"swap"
// for the atomic-arb cell), pinned flashToken, searchSeed{searchCenter in flashToken units}.
```
**`analysis/src/learning/learning-case.ts` (CREATE — the ONE schema)**:
```ts
export interface LearningCase {
  learning_case_id: string;   // hash(strategy,trigger,competitor_tx,source_block,cycle_fingerprint,primary_gap)
  status: "open"|"proposed_close"|"replay_passed"|"applied"|"live_verified"|"parked_uneconomic"|"manual_required";
  strategy: StrategyKind;
  trigger: "bundle_not_included" | "competitor_not_seen";
  edge_kinds: EdgeKind[];
  primary_gap: PrimaryGap;    // funnel-ordered, strategy-agnostic (below)
  secondary_gaps?: string[];  // atomic/credit specializations live HERE, not a parallel top-level enum
  comparable: boolean;        // one_leg_inventory/sandwich ⇒ false ⇒ short-circuit before auto-close
  competitor_tx?, our_opportunity_id?, source_block?, target_block?, strategy_view_version?,
  atomic_view_hash?, backrun_view_hash?, evidence, close_action, replay_gate;
}
export type PrimaryGap =
  | "source_not_seen" | "view_missing" | "edge_kind_disabled"        // pre-funnel intake
  | "venue_missing" | "path_not_found" | "quote_failed" | "sim_failed"
  | "below_ev" | "gas_underwater" | "liquidity_or_cap_bound"
  | "outbid" | "lost_intra_lane_priority"
  | "non_comparable_winner"           // terminal, no close (CEX-DEX/sandwich/JIT noise)
  | "standing_position_required"      // credit policy gate, not a coverage fix
  | "oracle_not_diverged" | "manual_required";
```

## 2. Shared FOUNDATION slices (build ONCE, before any strategy/edge runtime)

**F1 — unified types (pure).** `edge.ts` (VenueEdge), `detector.ts` StrategyKind union, `learning-case.ts`
schema. = credit slice-1 ∪ atomic-arb A-contract type half.
- Files: CREATE `venues/edge.ts`, `analysis/src/learning/learning-case.ts`; MODIFY `detector/detector.ts:6`.
- Gate (rule-12): compile + `searcher:planner` plan counts UNCHANGED (pure widening; existing `TokenEdge`
  consumers still typecheck). `VenueEdge` assignable everywhere `TokenEdge` was.

**F2 — one LearningCase by EXTENSION (analysis; off hot path).** Refactor `analysis/src/cli/bundle-postmortem.ts`
(`winner_style`/`route_gap_decisive`/`in_graph` → `primary_gap`, incl. `non_comparable_winner`) AND
`analysis/src/cli/census-report.ts` to BOTH OUTPUT `LearningCase`. Shipped C1 feeds it: `tx-shape.shape`
re-labeled (`atomic_state_arb→block-scan`, `backrun→reactive`) supplies `strategy` + `edge_kinds`;
`sender-flow.source_visibility` supplies `source_not_seen`; `swap-log-registry` decodes competitor swaps.
- Files: MODIFY `bundle-postmortem.ts`, `census-report.ts`, `live-loss.ts`, `hermes-gate.ts` (ONE coordinated
  pass — never open `bundle-postmortem.ts` twice); MODIFY `analysis/src/pnl/tx-shape.ts` (enum re-label only).
- Gate (rule-12): replay existing postmortem fixtures — `0xa32b…→venue_missing`, `0xee7b98ad…→
  non_comparable_winner`, coffee 9 → 8 `block-scan` + 1 `reactive`; double-run idempotency (0 dup cases).

**F3 — one `SubmissionCoordinator` (`execution/submission-coordinator.ts` CREATE).** Adopt atomic-arb §1.4
concrete spec (sync `offer(candidate)`, group by `targetBlock`, rank `strategy_priority/net_ev/deadline`,
one winner, loser emits `submission_arbitration_lost`), generalizing the `strategy` field to `StrategyKind`.
Directory today has only `bundle-router.ts` + `inclusion-tracker.ts` — greenfield.
- Gate (rule-12): reactive + block-scan candidates for the SAME target block ⇒ exactly one `bundle_submitted`,
  loser `submission_arbitration_lost`; both strategies off ⇒ zero behavior change vs today.

**F4 — one block-scan lane + `AtomicView` (isolation infra).** atomic-arb A-lane == credit slice-7. Own
`blockScan_busy` (never shares the reactive hint `busy`, `main.ts:858`), own `PoolStateCache` + own sim
instance (a single fork head-of-line-blocks the reactive lane); **shared signing nonce + the F3 coordinator**
(swap-atomic is principal-safe → a second EOA is NOT needed here; the credit position account is a separate
per-leg concern deferred to the credit path). Node single-thread → bounded cooperative-yield chunks.
`AtomicView` = the A-universe atomic selection view (loop-closure scored, `selectArbRelevantPools`).
- Gate: metrics (non-deterministic) — a hint injected mid-block-scan is processed, ZERO new `skip hint`
  attributable to the lane; reactive `stageMs` p95 flat under block-scan load.

## 3. Strategy / edge-specific slices (fork AFTER the foundation)

- **Block-scan swap scanner (atomic-arb A0–A4 re-parented).** A0 decode/verify fixture; A1 anchor scan
  (delta-seeded O(pairs), emits `seedEdges: VenueEdge[]`, planner branch `planFromSeedEdges` skips
  `buildTokenPaths`/rotation, `planner.ts:126`/`token-graph.ts:462`); A2 bounded 3–4-hop; A3 solve+sim
  (search center from `searchSeed`, not the `1n` fallback, `solver.ts:449`); A4 live wiring.
  **Merged P0-2/P0-3 fresh-read gate** (swap logs TRIGGER-only → fresh-read every candidate-cycle pool at
  `source_block` before quote, drop if stale/unreadable), **submit-time stale-target** drop, **per-newHead
  `block_scan_result`**, **runtime breaker** (auto-off block-scan if reactive p95/expired regresses).
  Gates: A0–A3 deterministic `searcher:planner`/`searcher:replay-live-fixtures` flips; A4 metrics.
  **Status: A0/A1–A3-offline GO; A4-live BLOCKED until F4 lane + fresh-read gate green.**
- **Credit edge adapter (credit slices 3/5/6/8).** Fluid resolver `quote()` (`quoter.ts:358` throws today →
  `getVaultEntireData`, zero-CU) → deterministic max-safe-borrow + haircut (deletes the `fluidDebtBps`
  search) + abandon-exit isolated `nftId` + **per-adapter gas table** (credit 250–400k vs ~100k swap) +
  **credit-live reject guard off the edge `leavesStandingPosition`/`abandonExit` flag** (not a strategy
  label). Either driver may route a `credit` edge (`ENABLE_CREDIT_EDGES_FOR_{REACTIVE,BLOCK_SCAN}`).
  Gate: replay `0xf88b…` credit edge `candidate_plans 0→1` + deterministic quote == ~273 wstUSR + guard
  rejects an abandonExit plan w/o the credit-live marker. **Status: analysis/replay (slice 3) GO, flag OFF;
  runtime credit routing BLOCKED behind the credit-live marker + Safety-1.**
- **Reactive (backrun) — existing, now `strategy_kind: reactive`.** No behavior change beyond the rename +
  routing through F3.

## 4. Ordered build plan + gating

Dependency DAG: `F1 → F2 → {F3, F4}` → then fork: `block-scan A0..A4` and `credit 3/5/6/8` (each depends on
F1–F4, independent of each other). GO now: F1, F2, block-scan A0/A1–A3-offline, credit slice-3 (analysis,
flag OFF). BLOCKED: A4-live (until F4 + fresh-read gate); credit runtime (until credit-live marker + 2nd
account + Safety-1 human gate); **go-live/broadcast stays a hard human gate**. Preserve the atomic-arb owner
re-gate P0-1..P1-5 and the credit 5 safety invariants (esp. #3 bounded-live rejects `leavesStandingPosition`
plans without a separate marker).

## 5. What changes vs the two source specs (migration)
- **atomic-arb impl spec:** `kind:"backrun-arb"|"atomic-arb"` → `strategy_kind:"reactive"|"block-scan"`
  (detector/events/coordinator/LearningCase); `seedEdges: TokenEdge[]` → `VenueEdge[]`; §1.5 new-file
  LearningCase → the shared F2 extension; §C2 `atomic_*` gaps → `secondary_gaps[]` under the converged
  `PrimaryGap`. Engineering (scanner/lane/fresh-read/coordinator/nails) UNCHANGED in behavior.
- **credit landing-plan:** slice-1 types = F1; slice-2 = F2; slice-7 coordinator+lane = F3+F4 (built by the
  atomic-arb engineering); slices 3/5/6/8 = the credit-edge fork. `strategy_kind: reactive|block-scan` already
  matches; nothing to rename.
- **shipped C1:** `tx-shape` enum re-label only; `sender-flow`/`swap-log-registry`/`victim-source` unchanged.
- **Single highest-friction item that gates everything:** the spine decision (F1) — pick `strategy_kind` +
  `VenueEdge` BEFORE A-contract threads a `kind:"atomic-arb"` union through ~6 files.

## 6. Acceptance matrix
| slice | command | rule-12 transition |
|---|---|---|
| F1 types | `searcher:planner` + compile | plan counts unchanged; `VenueEdge` assignable for `TokenEdge` |
| F2 LearningCase | `analysis` postmortem/census replay | fixtures → `primary_gap` (`0xa32b→venue_missing`, `0xee7b98ad→non_comparable_winner`, coffee 8 block-scan+1 reactive); idempotent double-run |
| F3 coordinator | `searcher:coordinator` unit | reactive+block-scan same block → 1 submit, loser `submission_arbitration_lost` |
| F4 lane | metrics window | hint mid-scan processed, 0 new `skip hint`; reactive p95 flat |
| A0–A3 (block-scan swap) | `searcher:planner`/`searcher:replay-live-fixtures` | anchor `candidate_plans 0→>0`; center from `searchSeed` (`>8`); `sim.success + netEV>0 + standalone` |
| A4 live | dry-run window | block-scan `simSuccess>0`; every newHead `block_scan_result`; `state_block===source_block`; reactive `expired` flat — BLOCKED until F4 |
| credit slice-3 | `searcher:planner` | `0xf88b` credit `candidate_plans 0→1`, quote ≈ 273 wstUSR; abandonExit plan rejected w/o marker |
| C1 re-label | `analysis` tx-shape test | 8 block-scan + 1 reactive (was atomic_state_arb/backrun), logic unchanged |

## Verdict-adjustments I'd flag
None material — the reconciliation holds. One emphasis: F2 (the shared LearningCase-by-extension) is the
slice with the real 3×-drift risk and should have a SINGLE named owner before either workstream touches
`bundle-postmortem.ts`; it is also the cheapest high-value unification (pure/off-hot-path) and should ship
right after F1.
