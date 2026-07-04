# Design decision — unified strategy × edge × learning architecture

> Scope: authorized, defensive on-chain arbitrage research. Architecture decision record (no code shipped).
> Three-way review (orchestrator + two fable-5 subagents, both majority-fable, partial opus fallback) of
> the operator's unified architecture: two strategy drivers × a unified venue-edge graph × one learning
> loop, with `credit` as a venue-edge family (not a strategy). Builds on
> `credit-venue-edge-20260704.md` (Model-2 abandon-exit settled).

## Verdict (unanimous 3/3): commit the orthogonal CORE; ship a LEAN v1 = analysis/model layer only; DEFER the runtime multi-lane machinery
The `strategy_kind × edge_kind` decomposition is the right spine and it's backed by code we already run
(the wired Fluid vault is already a `slotKind:"lend"` edge through the same DFS + adapter dispatch). But
~60% of the proposed RUNTIME apparatus (three live views, two execution lanes, SubmissionCoordinator, LP
edge) solves a contention problem we do not yet have — the pipeline is single-lane / single-wallet /
single-simulator today, and credit-in-production is a human-gated standing-position play. **The model /
analysis layer is pure upside + near-zero risk; the runtime-execution layer is where over-abstraction,
latency regressions, and posture conflicts all live. Take all of the former, almost none of the latter, in
v1.**

## THE ONE SAFETY-CRITICAL FIX (Fable-1's catch — endorsed): do NOT overload "atomic"
`atomic + credit` is a **naming trap**. In this codebase "atomic" means principal-never-at-risk /
position-closed-in-tx (Safety Rule 1 language, read by the EV gate + posture guards). But Model-2 credit is
DEFINED by leaving a standing position open (profit at open, protocol eats the negative equity). Labeling a
credit path `strategy_kind: atomic` lets a **standing-position leveraged play launder itself as
principal-safe** through a strategy label the guards trust.
- **Rename the strategy axis:** `strategy_kind: reactive | block-scan` (i.e. `backrun | block-scan`), NOT
  `backrun | atomic`.
- **Atomicity / standing-position is an EDGE property, not a strategy label:** `edge_kind:"credit"` carries
  `leavesStandingPosition: true` → forces the human-gated capital path REGARDLESS of which strategy drives
  it. A swap edge is `leavesStandingPosition:false`. Then `{reactive|block-scan} × {swap|credit}` all
  compose, and no credit edge can pass posture guards as "atomic/safe."

## NAILED INVARIANT: the credit edge is STRATEGY-AGNOSTIC (operator, 2026-07-04)
Credit is NOT a strategy and is NOT bound to one. It is a PATH capability — an edge in the graph — that
**EITHER strategy driver may use**. Both cells are first-class:
```
reactive(backrun) + credit:   victim      → FluidCredit(wstUSR→USDC) → swaps → repay flash
block-scan(atomic) + credit:  block-state → FluidCredit(wstUSR→USDC) → swaps → repay flash
```
So the model is exactly: `Strategy Driver {BackrunDriver | BlockScanDriver} → UnifiedOpportunity →
Planner over EdgeGraph {SwapEdge | CreditEdge | LP later} → any strategy can use any ENABLED edge kind.`
Corollary the plan must respect: **"credit goes into analysis/replay first" is a production-ENABLE
ORDER, not a strategy binding.** The credit edge must be architected so BOTH BackrunDriver and
BlockScanDriver can route it the moment its per-view enable flag is on; nothing in the edge, the planner,
or the LearningCase may assume credit belongs to a particular strategy. `ENABLE_CREDIT_EDGES_FOR_BACKRUN`
and `..._FOR_ATOMIC` are independent flags precisely because the edge is shared, not owned.

## Where all three converged
- Orthogonal `strategy_kind × edge_kind`, credit as an edge FAMILY not a strategy — sound + non-redundant.
- Views = **precomputed materialized sets, NOT live predicates** over the registry. A per-opportunity
  `registry.filter(policy)` adds O(registry) to the latency-critical BackrunView, and the registry grows as
  analysis backfills competitor pools (the topN=0-class regression). Keep BackrunView the small materialized
  hot set (`SEARCHER_MEMPOOL_FILTER_TOP_N`/`POOL_UNIVERSE_TOP_N` discipline).
- **Credit edges must be OFF BackrunView's hot iteration** — a credit quote is a resolver `eth_call`
  (oracle/LTV/liquidity), not local reserve math; iterating it every block re-opens the quote-loop
  bottleneck ([[project-v8-quote-loop-bottleneck]]). Credit belongs in AtomicView/AnalysisView, and even in
  BackrunView only DEPEG-GATED (inserted when live), never iterated. Critically: credit edges are curated →
  `score:undefined` → **pinned → exempt from top-N truncation** (`token-graph.ts:474`), so
  `ENABLE_CREDIT_EDGES_FOR_BACKRUN=0` must drop them at **view-projection time**, not rely on scoring to
  prune them (scoring never will).
- **Lane isolation is real infrastructure, not a config flag.** Everything is shared today: one
  `AnvilStateBackend`, one `RevmSimClient`/`BotVMSimulator`, one `ethers.Wallet`/nonce, one fork cycle. For
  AtomicLane to never block BackrunLane you must physically separate, in priority order: (1) the
  simulator/fork instance (a single fork serializes — head-of-line-blocks the backrun); (2) the signing
  wallet/nonce (shared nonce = correctness hazard; a second EOA = a new funded wallet = a Safety-Rule-1
  human gate); (3) CPU/event-loop (Node single-threaded → AtomicLane needs a separate process/worker, not
  just "lower priority"); (4) the reth/RPC throughput (rate-limit atomic to yield to backrun). → strongest
  reason to DEFER AtomicLane from v1.
- **Unified LearningCase must EXTEND the existing tools** (`bundle-postmortem` `winner_style`/
  `route_gap_decisive`/`in_graph`; `hermes-gate` `intake_audit`), NOT a parallel reporting path — else it
  recreates the exact 3×-analyzer drift the operator is killing (rule 16 "one learning system").
- **Add `non_comparable_winner` to the taxonomy — load-bearing** (both fables, independently). Without a
  terminal for "analyzed, winner not comparable (CEX-DEX/sandwich/JIT noise), we correctly did nothing," the
  loop manufactures phantom coverage gaps ([[project-cex-dex-inventory-competitor-noise]]).

## The one divergence (bounded-live coverage) + reconciliation
- Fable-2: bounded-live is compatible — the isolated account holds only an ≈zero-equity abandoned position;
  principal is flash-protected; BotVM holds no standing funds.
- Fable-1: the bounded-live envelope's specific guard (`assert-balance` flash-repay) bounds ATOMIC bundles
  (a bad arb reverts, principal safe); a standing-position credit bundle's worst case (negative equity
  persists / the position can be liquidated later) is NOT bounded by that assert.
- **Reconciliation:** both hold at different layers. WE are principal-safe (isolation + flash-protection,
  Fable-2). But the ENVELOPE's mechanism was designed for atomic reverts, so **credit-LIVE needs an explicit
  new bound**, a distinct authorization of the same class as go-live (Fable-1). **Moot for v1** (credit is
  analysis-only, production flag OFF) — but recorded as the gate before any live credit routing.
- **UNANIMOUS across all THREE reviews (concrete mechanism):** the `assert-balance` flash-repay guard
  (`plan-builder.ts:112`) bounds only the FLASH token delta, NOT the leftover standing position. So the
  bounded-live guard MUST **reject any plan containing an `abandonExit` credit edge unless a SEPARATE
  credit-live human marker is set** (independent of the wallet cap — the wallet cap does not bound a
  standing under-collateralized position). Wire the guard off the edge's `abandonExit`/`leavesStandingPosition`
  flag, never off a strategy label. Plus a per-venue feasibility precondition proven on fork replay BEFORE
  the adapter ships: the venue's health-factor check is oracle-based and admits an oracle-value>market-value
  position with no tx-end solvency revert (exactly the Fluid/wstUSR reference case — verify per venue).
- **Note on the quote interface (fresh review):** Fluid has NO 1-D `quote(amountIn)→amountOut` today —
  `quoteFluidVault()` throws; it is priced by a 2-D solver search (flashAmount × `fluidDebtBps`). A credit
  edge has an EXTRA free variable (borrow size / LTV) a swap edge lacks. The typing-layer slice must NOT
  flatten credit into the swap's 1-D quote — keep the borrow-size variable explicit (the deterministic
  max-safe-borrow under abandonment is the eventual collapse, but prove equivalence before deleting the
  search).

## LEAN v1 (build these — all off-hot-path or gated refactor, all replay-gateable)
1. **Unified data model as TYPES** — `VenueEdge{ edgeKind:"swap"|"credit"|"lp"; venue; tokenIn; tokenOut;
   leavesStandingPosition; quote(); build() }`, `strategy_kind: reactive|block-scan`, `EdgeSequence`,
   `LearningCase`. Pure definitions.
2. **Analysis-side EdgeSequence + LearningCase FIRST** (fables recommend doing this BEFORE the hot-path
   wrap): every competitor tx → `{strategyKind, edgeKinds[], primaryGap}`, by EXTENDING
   `bundle-postmortem`/`live-loss`/census (they already emit `winner_style`/`route_gap_decisive`/`in_graph`
   — a rename+generalize, not new machinery). Zero hot-path risk, immediately useful for the competitor
   cross-ref. Gate: replay against existing postmortem fixtures.
3. **CreditEdge in the ANALYSIS/replay path only, production flag OFF** — `0xf88b…` recognized as
   `FluidCredit(wstUSR→USDC)`. **The key cheap gate:** replay `0xf88b…` → credit edge → assert the
   abandon-exit token-delta profit matches the on-chain ~273 wstUSR (a deterministic flip that validates the
   whole credit-edge correctness claim for near-zero cost). Do this early.
4. **(Optional) a `VenueEdge` typing/dispatch layer over current backrun adapters** — dispatch-only,
   preserving every fast path byte-for-byte, gated by BOTH a correctness replay (`searcher:planner` plans
   unchanged) AND a **latency replay** (`searcher:replay-live-fixtures` per-stage `stageMs` p50/p95 not
   regressed). Today's quote path is deliberately non-uniform for latency (v3/curve warm local math +
   eth_call fallback; fluid = a solver `fluidDebtBps` SEARCH, not a `quote()`), so a uniform `edge.quote()`
   is NOT a free no-behavior-change — do it last, latency-gated, or split it out.

Net v1 = model + learning-loop on the analysis side + credit recognized in analysis (production OFF) +
one optional latency-gated typing layer. **Nothing new running in production.** Captures the operator's real
goal (one model, one learning loop; kill 3× planners/analyzers) at ~1/3 the surface.

## SEQUENCING of the runtime layer (operator override 2026-07-04: +EV is CONFIRMED, do NOT re-gate on "prove there's water")
The reviews recommended deferring the atomic lane until an offline scan proves +EV. **The operator
OVERRULED that gate: the reference tx `0xf88b…` IS the proof of water** — atomic+credit is a confirmed,
valuable target (and `0xf88b` is itself a standing-dislocation / block-state capture through the Fluid
credit edge, i.e. the atomic+credit cell). So the atomic lane is an IN-SCOPE committed deliverable, NOT
gated behind re-proving +EV.
- It is still **SEQUENCED after** the analysis/model foundation (steps 1–3) — but for an ENGINEERING
  reason, not an evidence reason: lane isolation is genuine infra (separate fork/sim instance + separate
  EOA/nonce + separate process/worker + RPC fairness — everything is single-instance today), and a second
  funded EOA is a Safety-Rule-1 human gate. Build the foundation first, then the lane.
- **SubmissionCoordinator** + **AtomicView** land WITH the atomic lane (nothing to coordinate / no second
  view until the second lane exists), not before.
- Note the cell nuance (informs which lane credit lives in, not whether to build it): `backrun+credit` is
  the THIN cell — a credit edge decays on the ORACLE keeper's update, not on the victim swap — so credit's
  natural home is the atomic/block-scan lane; `0xf88b` is the atomic+credit case. This makes the atomic
  lane MORE central to credit, not a deferrable afterthought.
- **LP edge** — reserve `edgeKind:"lp"` as a type stub; build nothing (LP/JIT is a bundle-SHAPE strategy the
  in→out edge can't express anyway).
- **Credit-in-BACKRUN production routing** — flag exists OFF; enabling it live = the standing-position
  capital + envelope-extension human gate.

## LearningCase primaryGap taxonomy (converged)
`source_not_seen | view_missing | edge_kind_disabled` (pre-funnel intake) · `venue_missing | path_not_found
| quote_failed | sim_failed` · `below_ev | gas_underwater | liquidity_or_cap_bound` · `outbid |
lost_intra_lane_priority` · **`non_comparable_winner`** (terminal, no close) · `standing_position_required`
(credit policy gate, not a coverage fix) · `oracle_not_diverged/edge_inactive` (credit true-negative) ·
`manual_required`. Keep `primaryGap` = first blocking gap (funnel order) + optional `secondaryGaps[]`.

## File anchors
`main.ts` (single shared graph :603 / wallet+nonce :347 / simulator :457 / fork :379; hot filters :2911,
:402), `token-graph.ts:474` (pinned score=undefined exemption), `quoter.ts:358` (fluid = search not quote),
`bundle-postmortem.ts` (winner_style/route_gap_decisive/in_graph = the primaryGap kernel), `hermes-gate.ts`
(intake_audit = the pre-funnel not-seen lens).
