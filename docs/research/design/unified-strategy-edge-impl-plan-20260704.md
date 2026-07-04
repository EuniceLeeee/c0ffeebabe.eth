# Unified architecture — implementation plan (strategy_kind × edge_kind; block-scan absorption) — v2

> Scope: authorized, defensive on-chain arbitrage research; mainnet fork + dry-run; broadcast is a
> human-gated step. **NORMATIVE merge** of the two parallel workstreams per the reconciliation
> review (`docs/research/reports/arch-reconciliation-atomic-vs-credit-20260704.md`, working tree).
> Sources it merges: `coffee-20260704-atomic-epic-impl-plan.md` (block-scan mechanics — still the
> detail source for its slices), `credit-venue-landing-plan-20260704.md` + the two ADRs
> (`unified-strategy-edge-architecture-20260704.md`, `credit-venue-edge-20260704.md`).
>
> **v2 (2026-07-04): post dual-blind implementation-review revision.** Two fresh-fable reviewers
> (blind to each other) reviewed v1 (`7993fc7`) at implementation level; both found the SAME
> blocker (§1.5 self-contradiction, code-confirmed by the orchestrator) and 3 overlapping majors;
> v2 folds all adopted findings (fold record: §8). Also folded: the concurrent session's committed
> 4-way reconciliation synthesis (`arch-reconciliation-atomic-vs-credit-20260704-3way-synthesis.md`,
> commit `61b8979`) — convergent on all fundamentals; its three cosmetic divergences are resolved
> in §8.3.
>
> **Precedence:** where this doc conflicts with a source spec, THIS doc wins (the conflicts are
> exactly the reconciliation's collision axes; enumerated in §6). Where it is silent, the source
> spec's mechanics/gates stand unchanged. Shipped C1 (`0fb1566`/`975ebc2`/`cbbdf1f`) needs no
> rework — S1 adds its consumers.

---

## 0. The normative decisions (settled; do not re-litigate)

| # | decision | rationale (one line) |
|---|---|---|
| D1 | **Strategy axis = `"backrun" \| "block-scan"`. "atomic" is BANNED as a strategy value** — reserved for the derived execution property (`winner_style:"atomic_loop"` keeps it; principal-safety is expressed ONLY as `leavesStandingPosition:false`, computed from edges, never asserted by a name). **"reactive" is an accepted prose synonym for `backrun`; it is NOT a code value.** | The safety fix (ADR-a) requires killing "atomic"-as-strategy, NOT renaming "backrun": every shipped artifact (`detector.ts:6` `kind:"backrun-arb"`, `tx-shape.ts`, route-gap-watcher, census) already speaks "backrun", and S0 (landed) implements these values. Re-labeling shipped fixture-locked code for cosmetics contradicts the unanimous "re-label only, no rework" C1 verdict. Divergence vs the concurrent synthesis recorded + resolved in §8.3. |
| D2 | **`edgeKind` + `leavesStandingPosition` live on the EDGE** (`TokenEdge` widened IN PLACE, `token-graph.ts:15` — no new parallel edge type); the plan carries a DERIVED `leavesStandingPosition = tokenPath.edges.some(...)`; every posture guard keys on the derived flag. ONE kind-derivation (`deriveEdgeTaxonomy(slotKind)`, landed in S0), no second tag. | Credit invariant 1 + reconciliation defect 3. In-place widening (not `VenueEdge extends TokenEdge`) keeps ONE edge type — two edge types is itself the drift D2 bans (§8.3). |
| D3 | **ONE LearningCase schema** = credit's spine (`strategy_kind`, `edge_kinds[]`, funnel-ordered `primary_gap` + terminals) + the block-scan spec's machinery (`learning_case_id` idempotency, forward-only status, `parked_uneconomic`, `source_block = B−1`, P1-4 dual verdicts, P1-5 view hashes). Emitters EXTEND existing tools (postmortem/census); the schema lives in one new shared module. | Rule 16 / the 3×-analyzer drift both docs warn about. |
| D4 | **The Fluid credit edge is ALREADY live-routable today — grandfather it.** `POOL_REGISTRY`'s fluid-vault entry (`token-graph.ts:100-110`) merges into the live graph (`main.ts:571-590`) and the solver prices it via the `fluidDebtBps` search (`solver.ts:396`). Therefore `SEARCHER_ENABLE_CREDIT_EDGES_FOR_BACKRUN` **defaults to 1** (refactor-neutral: the backrun view stays bit-for-bit today's selection at default flags), and the "credit prod-OFF" invariant is re-scoped to what is actually new: the resolver-quote adapter path (CR-5), new credit venues (CR-8), and — the REAL safety line — the submit-time credit-live guard, which moves EARLY (BS-contract, §4). Graph membership is not the hazard; submitting a standing-position plan is. | Both blind reviewers found the v1 self-contradiction (backrun view "bit-for-bit today" vs default-0 stripping the fluid edge); orchestrator code-confirmed. Declaring a silent live-graph change was the alternative — rejected as a hidden behavior change. |

**Rename map (D1, applied to every not-yet-shipped identifier from the block-scan spec).**
Completeness rule: **any identifier in new code matching `/atomic/i` must appear in this table or
carry a written justification** (the only sanctioned survivors: `winner_style:"atomic_loop"`,
`tx-shape`'s `"atomic_state_arb"` value, prose about revert-safety).

| old (atomic impl plan) | new (this doc) |
|---|---|
| `AtomicOpportunity` / `kind:"atomic-arb"` | `BlockScanOpportunity` / `kind:"block-scan-arb"` |
| coordinator/LearningCase `strategy:"atomic"` | `"block-scan"` (backrun value unchanged) |
| `atomic_scan_result` event | `block_scan_result` |
| `atomic_stale_target_block` / `atomic_state_inconsistent` / `atomic_preempted_by_backrun` | `blockscan_stale_target_block` / `blockscan_state_inconsistent` / `blockscan_preempted_by_backrun` |
| `SEARCHER_ENABLE_ATOMIC_SCAN` + `SEARCHER_ATOMIC_*` knobs | `SEARCHER_ENABLE_BLOCK_SCAN` + `SEARCHER_BLOCKSCAN_*` |
| `atomic-lane.ts` / `atomic_busy` / `atomic-breaker.ts` / class `AtomicLane` | `blockscan-lane.ts` / `blockscanBusy` / `blockscan-breaker.ts` / `BlockScanLane` |
| `atomic-view-overrides.json` / `atomic-view-overrides.ts` / `load/appendAtomicViewOverrides` / `DEFAULT_ATOMIC_VIEW_OVERRIDES_PATH` | `blockscan-view-overrides.json` / `blockscan-view-overrides.ts` / `load/appendBlockScanViewOverrides` / `DEFAULT_BLOCKSCAN_VIEW_OVERRIDES_PATH` |
| `atomic_view_hash` / views key `atomic` | `blockscan_view_hash` / `blockscan` |
| `makeAtomicOpportunityId` + id preimage `"atomic\|…"` | `makeBlockScanOpportunityId` + preimage `"blockscan\|…"` |
| event field `strategy_view_used: "backrun" \| "atomic"` | `"backrun" \| "blockscan"` |
| `AtomicScanConfig` / `AtomicScanOutcome` / `detectAtomicOpportunities` / `atomic-scanner.ts` | `BlockScanConfig` / `BlockScanOutcome` / `detectBlockScanOpportunities` / `blockscan-scanner.ts` |
| `AtomicReplayReport` / `replayAtomicScanAt` / `atomic-replay.ts` | `BlockScanReplayReport` / `replayBlockScanAt` / `blockscan-replay.ts` |
| coordinator policy `atomicPreemptMarginBps` | `blockscanPreemptMarginBps` |
| `planAtomicFromSeedEdges` | `planBlockScanFromSeedEdges` |
| census field `atomic_scan_shape` | `tx_shape` (module name already) |
| gap classes `atomic_*` (C2 taxonomy) | spine + `gap_detail` per §1.4 (e.g. `blockscan_scan_not_triggered`) |

---

## 1. The spine — shared contracts (built once; every slice references these)

### 1.1 Strategy taxonomy + mapping — `listener/src/searcher/strategy-taxonomy.ts` (LANDED in S0)

```ts
export type StrategyKind = "backrun" | "block-scan";
export type EdgeKind = "swap" | "credit" | "lp" | "flash";
export function strategyKindFromTxShape(shape: "backrun" | "atomic_state_arb" | "unknown"): StrategyKind | "unknown";
export function edgeKindFromSlotKind(slotKind: "flash" | "lend" | "swap"): EdgeKind;   // lend→credit
export function deriveEdgeTaxonomy(slotKind): { edgeKind: EdgeKind; leavesStandingPosition: boolean };
export function pathLeavesStandingPosition(edges: ReadonlyArray<{ leavesStandingPosition: boolean }>): boolean;
```

`canonicalize.ts:38` `strategyType` (legacy third vocabulary, `"atomic/standing"`) is NOT migrated
in v1 — `// legacy, do not extend` comment + ledger TODO.

### 1.2 Edge model — `TokenEdge` widened IN PLACE (LANDED in S0)

`TokenEdge` gained REQUIRED `edgeKind` + `leavesStandingPosition`, set at every construction site
via `deriveEdgeTaxonomy(slotKind)` (spread), including the psm/fluid `fixedSlotKind` path and
`defaultTokenGraph`. Honesty note (both reviewers): the widening is **compile-breaking for every
`TokenEdge` literal** (required fields) — additive in runtime semantics only; all literal updates
are mechanical via the helper (this is exactly what S0 shipped; `searcher:planner` 14/14 + replay
12/12 unchanged prove behavior-neutrality).

**Pool-level classification (NEW in v2 — closes the "views are `PoolEntry[]`, not edges" gap):**

```ts
/** strategy-taxonomy.ts addition (BS-universe): PoolEntry → EdgeKind, BEFORE edges exist. */
export function edgeKindFromPoolEntry(p: { adapter: string; fixedSlotKind?: "lend" | "swap" }): EdgeKind;
// adapter "fluid-vault" (or any future credit adapter) → "credit"
// otherwise fixedSlotKind === "lend" → "credit"; else "swap".
```

View projection (§1.5) filters `PoolEntry[]` with this function; edge-level
`deriveEdgeTaxonomy` remains the runtime truth after graph build. The two MUST agree — asserted in
the BS-universe gate.

### 1.3 Opportunity union — block-scan spec §1.1 field-set, renamed (MODIFY `detector.ts` at BS-contract)

`BackrunOpportunity` unchanged (shipped). `BlockScanOpportunity` = impl plan §1.1 fields
(`sourceBlock`, `stateBlock`, `cycleId`, `cycleFingerprint`, `seedEdges: TokenEdge[]`, pinned
`flashToken`, `searchSeed`, no `hints.impact`) plus:

```ts
  kind: "block-scan-arb";
  /** Derived from seedEdges at construction; RE-DERIVED (never trusted) at submit (§4). */
  leavesStandingPosition: boolean;
```

Id derivation: `makeBlockScanOpportunityId` with preimage `"blockscan|" + sourceBlock + "|" +
cycleId + "|" + startToken + "|" + sortedSeedPools`. `cycle-fingerprint.ts` (§1.2 of the impl
plan) unchanged — invariants + B−1 temporal rule.

### 1.4 Merged LearningCase — `analysis/src/learning/learning-case.ts` (CREATE at S1; supersedes both source schemas)

```ts
export type PrimaryGap =
  // intake (pre-funnel): source_not_seen = backrun's intake gap; scan_not_triggered = block-scan's:
  | "source_not_seen" | "scan_not_triggered" | "edge_kind_disabled"
  // view/graph:
  | "view_missing" | "venue_missing"
  // execution capability (NEW in v2 — the venue-adapter-epic dispatch key both reviewers found missing):
  | "adapter_missing"
  // path/plan:
  | "path_not_found"
  // pricing/sizing:
  | "quote_failed" | "sizing_failed"
  // sim:
  | "sim_failed"
  // economics:
  | "below_ev" | "gas_underwater" | "liquidity_or_cap_bound"
  // auction:
  | "outbid" | "lost_intra_lane_priority"
  // terminals (no close action):
  | "non_comparable_winner" | "standing_position_required" | "oracle_not_diverged" | "edge_inactive"
  | "replay_state_unavailable" | "manual_required";

export interface LearningCase {
  learning_case_id: string;
  status: "open" | "proposed_close" | "replay_passed" | "applied" | "live_verified"
        | "parked_uneconomic" | "manual_required";          // forward-only (impl plan §1.5 rules)
  /** "unknown" is legal ONLY on competitor-observation cases; an "unknown" strategy_kind
   *  short-circuits to manual_required — no close action may consume it. */
  strategy_kind: StrategyKind | "unknown";
  edge_kinds: EdgeKind[];
  trigger: "bundle_not_included" | "competitor_not_seen";
  competitor_tx?: string;
  our_opportunity_id?: string;
  source_block?: number;      // block-scan: competitor_execution_block − 1 (user pt 1)
  target_block?: number;
  cycle_fingerprint?: string;
  comparable: boolean;
  primary_gap: PrimaryGap;    // FIRST blocking gap, funnel order
  gap_detail?: string;        // owner routing (single string)
  secondary_gaps?: PrimaryGap[];   // optional additional funnel positions (ADR-a's secondaryGaps)
  our_stage?: string;
  strategy_view_version?: string;
  backrun_view_hash?: string; blockscan_view_hash?: string;
  capability_replay_stage?: string;  live_admission_stage?: string;
  evidence: Record<string, unknown>;
  close_action?: { kind: string; target_file?: string; entries?: string[] };
  replay_gate?: { command: string; expected_transition: string; before?: string; after?: string };
  created_at: string; updated_at: string;
}
```

Gap-taxonomy fold (v2 — now lossless; every source class mapped, owner routing preserved):

| source class | spine `primary_gap` | `gap_detail` |
|---|---|---|
| `atomic_view_missing_venue` | `view_missing` | `blockscan_view_missing_venue` |
| `atomic_scan_not_triggered` | `scan_not_triggered` | — |
| **`atomic_venue_disabled`** | `edge_kind_disabled` | `blockscan_venue_disabled` |
| **`atomic_venue_adapter_missing`** | `adapter_missing` | — (owner: venue-adapter epic — D's dispatch key) |
| `atomic_cycle_not_found` | `path_not_found` | `blockscan_cycle_not_found` |
| `atomic_sizing_failed` | `sizing_failed` | — |
| `atomic_quote_fidelity_failed` | `quote_failed` | `blockscan_quote_fidelity` |
| `atomic_sim_revert` | `sim_failed` | — |
| `atomic_below_ev_gate` | `below_ev` | — (economics = human gate) |
| `atomic_budget_skipped` | `scan_not_triggered` | `blockscan_budget_skipped` |
| `atomic_competitor_faster_or_outbid` | `outbid` | **`blockscan_competitor_faster_or_outbid`** (owner split latency-vs-bid preserved) |
| credit `credit_infeasible` (caps/liquidity/frozen — a QUOTE-stage feasibility drop) | `quote_failed` | `credit_infeasible` |
| credit `emode_required` / `credit_stale_oracle` | `quote_failed` | same string |
| credit economic size-bound (position smaller than +EV needs) | `liquidity_or_cap_bound` | — |
| credit true-negatives (ADR-b: no divergence / edge parked between depegs) | `oracle_not_diverged` / `edge_inactive` | — |
| backrun `router_not_watched` / `source_swap_not_seen` | `source_not_seen` | same string |
| backrun `pool_not_in_graph` | `venue_missing` | — |
| backrun `path_no_plan` | `path_not_found` | — |
| intra-lane dedup losses (`dedup_per_block` / same-strategy `submission_arbitration_lost`) | `lost_intra_lane_priority` | the drop reason string |

Store/API/lifecycle: impl plan §1.5 verbatim (committed store.json, gitignored replay-cache,
`parked_uneconomic` k=3 re-open). Emitters extend existing tools; slice D consumes ONLY
`LearningCase` (compile-level).

### 1.5 Strategy views + edge-kind projection — `strategy-views.ts` (CREATE at BS-universe; absorbs credit slice 6's mechanism)

```ts
export interface EdgePolicy {
  creditForBackrun: boolean;    // SEARCHER_ENABLE_CREDIT_EDGES_FOR_BACKRUN — DEFAULT 1 (D4 grandfather)
  creditForBlockscan: boolean;  // SEARCHER_ENABLE_CREDIT_EDGES_FOR_BLOCKSCAN — default 0
}
export interface StrategyViews {
  backrun: PoolEntry[];
  blockscan: PoolEntry[];
  versions: { strategy_view_version: string; backrun_view_hash: string;
              blockscan_view_hash: string; pool_universe_generated_at: string; overrides_hash: string };
}
export function buildStrategyViews(basePools, universeFile, overrides,
  opts: { blockscanMaxPools: number; edgePolicy: EdgePolicy }): StrategyViews
```

- Projection filters `PoolEntry[]` via `edgeKindFromPoolEntry` (§1.2) — the only drop point for
  pinned credit entries (`token-graph.ts:474` score-exemption means scoring never prunes them).
- **D4:** at DEFAULT flags (`creditForBackrun=1`) the backrun view is **bit-for-bit today's
  selection** (fluid edge included — refactor-neutral). Setting it to 0 is a deliberate,
  bannered live-graph change (the flag exists so the operator CAN make it, not to make it
  silently).
- `creditForAnalysis` (v1's third flag) is **not a view flag** — analysis/replay harnesses build
  their own view via `buildStrategyViews` with an explicit policy arg (CS-min passes
  `{creditForBlockscan:true}` when replaying credit rings). Env flag dropped; two flags remain.
- View hashes (P1-5) cover the edge-policy state (a flag flip changes `strategy_view_version`).
- Everything else from A-universe stands: mempool `toAddress` filter from `views.backrun` only;
  `selectArbRelevantPools` promotion; the planner keeps consuming exactly today's edges.

### 1.6 SubmissionCoordinator — impl plan §1.4, values renamed (CREATE at BS-contract)

Unchanged in substance: sync `offer()`, one slot per `targetBlock`, decision matrix, backrun-first
default (`blockscanPreemptMarginBps=0`), `onBlock` prune. `SubmissionCandidate.strategy:
StrategyKind`. Credit never appears as a strategy value — by construction. ONE coordinator; credit
slice 7 must not create another.

---

## 2. Slice plan (merged DAG; statuses carry over from the source specs' owner re-gates)

```
Phase 0  SPINE        S0 (LANDED: taxonomy + TokenEdge widening) ──> S1 (learning layer)
Phase 1  FOUNDATIONS  BS-0 (=A0 fixture) · BS-contract (=A-contract + credit-live guard) · BS-universe (=A-universe + edge projection) · CR-3 (0xf88b analysis/replay)
Phase 2  OFFLINE      BS-1/BS-2/BS-3 (=A1/A2/A3) · CR-5 (Fluid resolver-quote adapter, prod OFF)
Phase 3  COMPARE+LANE CS-min (=C2-minimal, + blockscan-triggers.ts shared module) → BS-lane (=A-lane; supersedes CR-7) → BS-4 (=A4, BLOCKED until BS-lane + fresh-read pre-gates green)
Phase 4  CLOSE+EXPAND CS-full (=C2-full) · D (dispatcher) · CR-8 (Aave/Euler) · CR-6-live (human gate) · B-residual (evidence-gated)
```

| slice | = source slice | status | delta vs source (beyond the §0 rename) |
|---|---|---|---|
| **S0** | replaces credit slice 1 + A-contract's naming layer | **LANDED** (gated: build + planner 14/14 + replay 12/12 + taxonomy 5/5 + router-filter, all re-run by the evaluator) | as §1.1/§1.2 |
| **S1** | replaces credit slice 2 + impl plan §1.5 creation + C1's deferred census wiring | **LANDED** (gated: tsc + `test:learning-case` 5/5 + C1 suites + cross-package planner 14/14, re-run by the evaluator; census emits `tx_shape:"unknown"` live until CS-min wires same-block log collection — honest plumbing, fixture-gated) | §1.4 schema/store; EXTEND `bundle-postmortem` (`winner_style`→`comparable`+`primary_gap`, `edge_kinds` via the C1b registry) + census (`tx_shape` field); `strategyKindFromTxShape` wiring; **CREATES the pinned postmortem fixtures for `0xa32b…`/`0xee7b98ad…`** — they do NOT exist at HEAD (verified; the credit plan's "existing fixtures" claim was false). Synthetic PostmortemReport-shaped JSON with the decision-relevant fields (winner_style, in_graph, builder payment vs gross), values from the committed report docs; no chain calls |
| **BS-0** | A0 | GO (R5 prune window — run early) | fixture names only |
| **BS-contract** | A-contract | GO | consumes S0 types; §1.3 union + §1.6 coordinator; **+ the credit-live guard lands HERE, not CR-5 (D4 corollary — the credit edge is live-routable TODAY with no guard):** inside `processOpportunities`, immediately BEFORE the EV gate (`main.ts:1793-1826`; sole live submit site `:1840`), derive `leavesStandingPosition = candidate.tokenPath.edges.some(e => e.leavesStandingPosition)` (`CandidatePlan.tokenPath`, `planner.ts:8`) and REJECT (drop reason `standing_position_unauthorized`) unless the credit-live marker exists (`/opt/MEV/.credit-live`; path injectable for tests). The AC-3/fixture harness (`hot-path.ts:109`) is a TEST-ONLY second submit site — exempt by construction (no broadcast), stated here so nobody "fixes" it |
| **BS-universe** | A-universe | GO | `buildStrategyViews` per §1.5 (EdgePolicy, D4 defaults, `edgeKindFromPoolEntry`); +credit slice 6's flag-flip gate folded in |
| **CR-3** | credit slice 3 | GO (after S1) | planner `REPLAY_FIXTURES` credit flip on `0xf88b` uses S0's `edgeKind:"credit"`; analysis emits an S1 `LearningCase` |
| **BS-1/2/3** | A1/A2/A3 | GO (offline-fixture scope) | BS-1 planner branch REJECTS seedEdges with a view-disabled `edgeKind` → drop `edge_kind_disabled` |
| **CR-5** | credit slice 5 | prod OFF | resolver `quote()` + deterministic max-borrow (+ equivalence proof before deleting the `fluidDebtBps` search) + per-adapter gas table + EV-gate market-priced profit token (ADR-b must-haves 3/4). Guard already landed (BS-contract); CR-5 adds the Fluid-specific feasibility drops (`credit_infeasible`/`emode_required` → `pipeline_dropped`) |
| **CS-min** | C2-minimal | GO to build/report; BLOCKED as authoritative close input until P1-4+P1-5 green (carried) | emits §1.4 `LearningCase`; **CREATES `listener/src/searcher/blockscan-triggers.ts`** (`fetchSwapTouchedVenues` + `expandToPeerVenues`) as a shared module — CS-min's live-admission replay needs it BEFORE BS-4 exists; BS-4's lane imports it (DAG fix, reviewer-B m6) |
| **BS-lane** | A-lane | GO (hard prereq of BS-4) | same-process/one-EOA is v1 — **the shared signing nonce + coordinator is CORRECT for all-swap plans** (principal-safe). The credit workstream's "separate EOA" was a category mix: per-credit-LEG position isolation is `nftId`/sub-account level (ORTHOGONAL to the signing EOA) and rides the credit path at credit-live; a 2nd SIGNING EOA remains only the CPU/contention escalation (worker/process/2nd machine), Safety-1-gated. Supersedes credit slice 7 |
| **BS-4** | A4 | **BLOCKED** until BS-lane + P0-2/P0-3 fresh-read pre-gates green (carried) | rename only; imports `blockscan-triggers.ts` |
| **CS-full / D** | C2-full / D | follow BS-4 / LAST (carried blocks) | D dispatches on `strategy_kind` (never `"unknown"` — those are `manual_required`); block-scan closes write `blockscan-view-overrides.json` ONLY |
| **CR-8** | credit slice 8 | after CR-5 | unchanged |
| **CR-6-live** | credit slice 6 (live enable) | **human gate** (posture) | mechanism shipped in BS-universe; this item = the depeg-gated insertion decision + flag flip |
| **B-residual** | B-residual | evidence-gated | unchanged |

**Execution order (from today's state):**
`S1 → BS-0 → BS-contract → BS-universe → CR-3 → BS-1 → BS-2 → BS-3 → CR-5 → CS-min → BS-lane →
BS-4 → CS-full → D → CR-8`.

---

## 3. Acceptance matrix (executable; rule-12 form)

| slice | command | expected transition / assertion |
|---|---|---|
| S0 | (LANDED — gates re-run by evaluator) | build + `searcher:planner` 14/14 + replay 12/12 unchanged; `searcher:taxonomy` 5/5; router-filter regression |
| S1 | new `analysis` `test:learning-case` (+ existing C1 suites — sender-flow/registry/tx-shape — pass unchanged; do not cite fixed counts) | S1-CREATED pinned fixtures fold to ONE schema: `0xa32b…` ⇒ `{strategy_kind:"backrun", primary_gap:"venue_missing", comparable:true}`; `0xee7b98ad…` ⇒ `{primary_gap:"non_comparable_winner", comparable:false}` (short-circuits, no close); coffee 9-tx fixture ⇒ 8 `{strategy_kind:"block-scan", primary_gap:"scan_not_triggered"}` (pre-BS-4 honest state: no scanner existed) + 1 `{strategy_kind:"backrun", primary_gap:"source_not_seen", gap_detail:"router_not_watched"}`; a `tx_shape:"unknown"` synthetic ⇒ `strategy_kind:"unknown"` + `status:"manual_required"`, closer refuses it; double-run idempotency; census emits `tx_shape` (grep: `atomic_scan_shape` absent) |
| BS-0 | `searcher:blockscan-a0` | impl plan A0 gate verbatim |
| BS-contract | `searcher:planner` + `searcher:replay-live-fixtures` + `searcher:blockscan-contract` | impl plan A-contract gates (a)–(f) verbatim under new names; +(g) derived-flag: seedEdges containing a `leavesStandingPosition` edge ⇒ plan flag true; **+(h) credit-live guard: a plan whose `tokenPath.edges` contain the fluid credit edge is REJECTED at the pre-EV-gate check with `standing_position_unauthorized` when the (injectable) marker path is absent, ADMITTED when present; an all-swap plan is untouched either way; backrun suites byte-identical** |
| BS-universe | `searcher:universe-split` | impl plan A-universe gates (i)–(iv) with D4 semantics: (i) at DEFAULT policy the backrun view is set-equal to today's selection INCLUDING the fluid entry (grandfather proof); (v) flag-flip: `creditForBackrun=0` ⇒ fluid entry absent from the projected backrun view + mempool filter while still pinned in the registry (projection-drop proof) + `strategy_view_version` changes; `creditForBlockscan` symmetric; `edgeKindFromPoolEntry` agrees with edge-level `deriveEdgeTaxonomy` for every registry entry |
| CR-3 | `searcher:planner` (REPLAY_FIXTURES) | credit slice-3 gate verbatim: `0xf88b` credit edge present ⇒ `candidate_plans 0→≥1`, absent ⇒ 0; analysis emits `LearningCase{edge_kinds:["flash","credit","swap"]}` |
| BS-1 | `searcher:planner` | impl plan A1 gate verbatim + `edge_kind_disabled` reject fixture |
| BS-2 / BS-3 | `searcher:planner` + `searcher:bench-blockscan` / `searcher:replay-live-fixtures` | impl plan A2/A3 gates verbatim (renamed) |
| CR-5 | slice-5 gate + guard-wiring assertion | slice-5 gate verbatim (deterministic max-borrow ≈ 273 wstUSR + search-delete equivalence); gas table dust-regime fixture (credit leg 250–400k vs swap ~100k — over-ranking at gas=0 now under-ranks); EV gate values profit token at executable market price (peg-valued fails, market-valued passes only when genuinely +EV); **guard WIRING re-asserted end-to-end on the real submit path (not unit-only): fork replay of the `0xf88b` plan reaches the pre-EV-gate check and is rejected without the marker** |
| CS-min | `strategy-compare` fixtures | impl plan C2-minimal gates verbatim (B−1 join, P1-4 dual stages, `replay_state_unavailable`, idempotency ×2) on the §1.4 schema; `blockscan-triggers.ts` consumed by the replay (import asserted) |
| BS-lane | `searcher:blockscan-lane` | impl plan A-lane gate verbatim |
| BS-4 | dry-run window + Step-1 + `hermes-gate` | impl plan A4 metrics gate verbatim (renamed events/fields); thin window ⇒ EXTEND |
| D | `auto-close-strategy-gap` ×2 + replay | impl plan D gate verbatim + isolation invariant (blockscan overrides file only; force-include byte-identical; backrun mempool set-equal); input type `LearningCase` only; an `"unknown"` strategy_kind case is refused (manual_required) |
| CR-8 | per-protocol replay | slice-8 gate verbatim |

---

## 4. Safety envelope (merged; all defaults safe)

- **Flags:** `SEARCHER_ENABLE_BLOCK_SCAN=0` (master), `SEARCHER_BLOCKSCAN_{MAX_HOPS=4,
  MIN_SPREAD_BPS=10, SCAN_BUDGET_MS=2000, MAX_CANDIDATES=8, FULL_SWEEP_BLOCKS=50,
  VIEW_MAX_POOLS=6000, MAX_PEER_SEEDS=64}`, breaker knobs (impl plan §4 renamed);
  `SEARCHER_ENABLE_CREDIT_EDGES_FOR_BACKRUN=1` (**D4 grandfather — documented, bannered**),
  `SEARCHER_ENABLE_CREDIT_EDGES_FOR_BLOCKSCAN=0`.
- **Credit-live guard (D2-keyed, lands at BS-contract, single live check site):** derive
  `leavesStandingPosition` from `candidate.tokenPath.edges` in `processOpportunities` immediately
  before the EV gate (`main.ts:1793-1826`); reject `standing_position_unauthorized` unless
  `/opt/MEV/.credit-live` exists (independent of `.deploy-live` + wallet cap — `assert-balance`
  (`plan-builder.ts:113`) bounds only the flash token; the wallet cap does not bound a standing
  under-collateralized position). Setting `.credit-live` is a fresh explicit human authorization
  of the go-live class (Safety Rule 1). Until BS-contract lands, the pre-existing exposure
  (fluid edge live-routable with no guard) is bounded by: `quoteFluidVault` throws on the direct
  quote path, the depeg condition required for the debt-bps search to find +EV, and the EV
  gate/bounded-live envelope — recorded honestly, which is WHY the guard is Phase-1, not Phase-2.
- **Position-account isolation (credit) ≠ signing EOA:** per-credit-leg isolation is
  `nftId`/sub-account level (quote purity + deposit-absorption trap, ADR-b) and ships with CR-5;
  a 2nd SIGNING EOA is only the lane-contention escalation (BS-lane), Safety-1-gated.
- **Breaker** (impl plan §4, renamed): only ever disables block-scan.
- **Deploy preservation:** banner `blockScan=<on|off> blockscanView=<n> overrides=<n>
  blockscanViewHash=<0x…8> creditEdges=<backrun:1|0,blockscan:1|0>`.
- **Production enable-criteria** carry over verbatim (block-scan: impl plan §4; credit-live:
  landing plan). Broadcast/go-live stays a hard human gate.

---

## 5. Module inventory (end state; ONE implementation per component)

**listener:** `strategy-taxonomy.ts` (S0 ✅; + `edgeKindFromPoolEntry` at BS-universe),
`token-graph.ts` widened (S0 ✅), `detector/detector.ts` union + `detector/cycle-fingerprint.ts`
(BS-contract), `detector/blockscan-scanner.ts` (BS-1/2), `blockscan-triggers.ts` (CS-min),
`blockscan-lane.ts` (BS-lane), `blockscan-replay.ts` (CS-min), `blockscan-view-overrides.ts` +
committed `listener/searcher/pools/blockscan-view-overrides.json` (BS-universe/D),
`strategy-views.ts` (BS-universe), `execution/submission-coordinator.ts` (BS-contract),
`blockscan-breaker.ts` (BS-4), credit adapters in the existing quoter/plan-builder/ActionAdapter
registry (CR-5/8).
**analysis:** `learning/learning-case.ts` (S1), shipped C1 modules (registry gains credit-event
decoders when S1/CR-3 need `edge_kinds`), `cli/strategy-compare.ts` (CS-min),
`cli/auto-close-strategy-gap.ts` (D), postmortem/census field additions (S1).
Harness boundary unchanged: the ONLY scanner/replay implementation lives in `listener`.

---

## 6. Supersession table (what this doc overrides in the sources)

| source item | disposition |
|---|---|
| credit slice 1 (unified types) | **superseded by S0 (LANDED)** |
| credit slice 2 (analysis LearningCase) | **superseded by S1** |
| credit slice 4 (VenueEdge typing layer) | still OPTIONAL, latency-double-gated, post-v1 — **with the D2 rider: if ever built, its dispatch layer consumes `TokenEdge.edgeKind`; it must NOT define a second kind tag** |
| credit slice 6 (projectView + flags) | mechanism **absorbed into BS-universe**; live enable = CR-6-live (human gate) |
| credit slice 7 (lane + view + coordinator + 2nd EOA) | **superseded by BS-lane + BS-universe + §1.6**; the 2nd-EOA requirement was a position-account/signing-EOA category mix (§2 BS-lane row) |
| credit plan's "existing postmortem fixtures" claim (slice 2 gate) | **false at HEAD (verified)** — S1 creates them |
| atomic impl plan §1.5 LearningCase | **superseded by §1.4** |
| atomic impl plan naming (`atomic-*`) | **renamed per §0** (map now covers ids/preimages/config keys — completeness rule in force) |
| atomic C2 taxonomy | folded into spine + `gap_detail` (§1.4 — v2 lossless, incl. `adapter_missing` + `edge_inactive`) |
| census field `atomic_scan_shape` | renamed `tx_shape` (S1) |
| ADR-a `strategy_kind: reactive` string | canonical value `"backrun"` (D1; "reactive" = prose synonym) |
| impl plan A-contract §1.1/§1.4 types | defined here (§1.3/§1.6); A-contract implements them |
| impl plan §A4 `fetchSwapTouchedVenues` (lane-internal) | promoted to shared `blockscan-triggers.ts` at CS-min |

Everything not listed (P0/P1 blockers, fresh-read gate, B−1 rule, view hashes, GO/BLOCKED
statuses, dust honesty, R1–R5, owner re-gates) **carries over unchanged**.

---

## 7. Governance

- Each slice: generator/evaluator split (Codex writes, Claude gates + commits); rule-12 quartet
  recorded per slice.
- **S1 is the next implementation turn.**
- Hygiene ledger item (open): stray untracked `listener/src/searcher/venues/capability.js` —
  delete or gitignore (owner decision; not auto-deleted because this session did not create it).
- This doc is the naming/schema authority; slice-detail authority stays with the source specs;
  conflicts resolve by amending THIS doc first.

---

## 8. Review-fold record (v1 → v2 provenance)

### 8.1 Dual-blind implementation review (two fresh fable reviewers, blind to each other)
Raw reviews: scratchpad `fable-review-A.md` / `fable-review-B.md` (session-local).
**Convergent findings — all adopted:** the §1.5 self-contradiction BLOCKER (→ D4);
taxonomy-fold lossiness (`venue_disabled`/`adapter_missing` → §1.4 v2); rename-map gaps (→ §0
completeness rule + 8 added rows); guard derivation/check-site unpinned (→ BS-contract, exact
anchors); PoolEntry-level edge classification (→ `edgeKindFromPoolEntry`); `creditForAnalysis`
orphan flag (→ dropped; explicit policy arg); S1 block-scan cases' emitter/primary_gap
(→ pinned `scan_not_triggered`); `"unknown"` strategy_kind handling (→ legal + close-refused);
"additive" wording (→ compile-breaking-but-mechanical); `edge_inactive` + `faster_or_outbid`
owner-split restoration; slice-4 second-kind-tag rider.
**Reviewer-B unique — verified then adopted:** `0xa32b…`/`0xee7b98ad…` fixtures do not exist at
HEAD (S1 creates them); phantom "19/19" count removed; `blockscan-triggers.ts` DAG fix;
`credit_infeasible` vs `liquidity_or_cap_bound` boundary; `lost_intra_lane_priority` producers.
**Rejected:** none material; optimization-class remarks were out of scope by instruction.

### 8.2 Orchestrator code verifications backing the adoptions
Fluid entry in the live graph: `token-graph.ts:100-110` (POOL_REGISTRY) → `main.ts:571-590`
(merge) — D4. Guard anchors: EV gate `main.ts:1793-1826`, live submit `:1840`,
`CandidatePlan.tokenPath` `planner.ts:8`, test-only submit `hot-path.ts:109`. Fixture absence:
`grep 0xa32b|ee7b98ad analysis/src/test` = 0 hits.

### 8.3 Concurrent-line convergence (commit `61b8979` 3-way synthesis + its fusion drafts)
Fundamentals: 4-way convergent with this doc (absorb as block-scan×swap; spine first; one
coordinator/lane/LearningCase; rename before A-contract; safety claim = latent, guard on the edge
flag). Divergences resolved:
- `reactive` vs `backrun` code value → **`backrun`** (D1 rationale; "reactive" prose synonym).
- `VenueEdge extends TokenEdge` (new type) vs in-place widening → **in-place** (one edge type;
  S0 landed + gated).
- `secondaryGaps[]` vs `gap_detail` → **both** (§1.4: `gap_detail` for owner routing,
  `secondary_gaps?` for extra funnel positions).
- their "adopt the name `AtomicView`" → **rejected** (naming residue; views key = `blockscan`).
- their Reviewer-A wallet reconciliation (2nd EOA = position-account category mix) → **adopted**
  (§2 BS-lane row, §4).
**Resolution landed (`d1655a2`, same day):** the concurrent line's final fusion synthesis
(`unified-arch-impl-spec-20260704-3way-synthesis.md`) independently CONVERGED onto this doc's
decisions — its Reviewer B found the S0 spine in the working tree, verified it, and adopted
`backrun | block-scan` ("renaming to `reactive` is churn with zero safety benefit"), `VenueEdge`
= the already-widened `TokenEdge` (type alias at most, no new class), and the credit-live reject
guard wired off `pathLeavesStandingPosition`. Zero decision-level divergence remains between the
two lines. Per §7, THIS doc stays the slice-plan/naming authority; the concurrent line's spec
stands as corroborating provenance (its F1–F4 foundation→fork framing maps 1:1 onto
S0/S1 → BS-contract/BS-universe → BS-lane here).
