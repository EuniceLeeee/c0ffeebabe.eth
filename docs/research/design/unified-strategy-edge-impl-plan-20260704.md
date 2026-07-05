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
| D4 | **The Fluid credit edge is ALREADY live-routable today — grandfather it.** `POOL_REGISTRY`'s fluid-vault entry (`token-graph.ts:100-110`) merges into the live graph (`main.ts:571-590`) and the solver prices it via the `fluidDebtBps` search (`solver.ts:396`). Therefore `SEARCHER_ENABLE_CREDIT_EDGES_FOR_BACKRUN` **defaults to 1** (refactor-neutral: the backrun view stays bit-for-bit today's selection at default flags), and the "credit prod-OFF" invariant is re-scoped to what is actually new: the resolver-quote adapter path (CR-5), new credit venues (CR-8), and — the REAL safety line — the submit-time credit-live guard, which lands as its OWN immediate slice **S2** (the FIRST runtime touch, at the existing submit site, ahead of the BS-contract factor-out; §4). Graph membership is not the hazard; submitting a standing-position plan is. | Both blind reviewers found the v1 self-contradiction (backrun view "bit-for-bit today" vs default-0 stripping the fluid edge); orchestrator code-confirmed. Declaring a silent live-graph change was the alternative — rejected as a hidden behavior change. |
| D5 | **`CreditQuote` is NOT an independent PnL system and must never exist. Lending is a credit LEG, not a strategy.** Every edge returns the shared `EdgeQuote { tokenDeltas, positionDeltas, constraints, valuationHints }` (`listener/src/searcher/solver/edge-quote.ts`, §1.7) — swap/protocol-convert edges with EMPTY `positionDeltas`, credit edges with collateral/debt `positionDeltas` + HF/LTV/cap/e-mode `ConstraintResults`. **Protocol/oracle valuation is a CONSTRAINT input (can-borrow / how-much / HF / safety) and NEVER enters EV. Real EV = route-level MARKET PnL** = final portfolio market value − initial − gas − bid; `valuationHints:"protocol-oracle"` are structurally excluded from the route valuator. `leavesStandingPosition` derives from positionDeltas not netting to zero in-tx (D2's `edgeKind==="credit"` rule becomes the graph-time prior, asserted equal at solve time). **Credit is FORBIDDEN as a `strategy_kind`, a lane, or a dispatcher branch** — enforced by a boundary grep-gate (`searcher:lint`), not by review. Implementation = slices EQ-1 (EdgeQuote types + byte-identical swap migration) → EQ-2 (credit evaluator replacing the `fluidDebtBps` grid `solver.ts:396-401` + `bestPerBps` `:226-244`; solver collapses to the single flashAmount dimension) → EQ-3 (route valuator) → EQ-4 (enshrine+lint). This is the honored-principle already at taxonomy/graph/guard/coordinator level (dual-blind verified 2026-07-05); the violation was ONLY the solver/quote layer's fluid special-casing. | Operator directive 2026-07-05 + dual-blind diagnosis: `strategy_kind × edge_kind` is the system; lending is a special edge EVALUATOR, not a third platform. Gates = the 6 acceptance criteria (all-swap byte-identical; `0xf88b` flip; oracle-borrowable-but-market-negative ⇒ fail; market-positive-but-constraint-unsatisfied ⇒ fail; standing-no-marker ⇒ `standing_position_unauthorized`; no credit strategy/lane/auto-close). |

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
export type EdgeKind = "swap" | "credit" | "lp" | "flash" | "protocol";   // "protocol" added 2026-07-04
export type ProtocolAction = "mint" | "redeem" | "wrap" | "unwrap" | "convert" | "stake" | "unstake";
export function strategyKindFromTxShape(shape: "backrun" | "atomic_state_arb" | "unknown"): StrategyKind | "unknown";
export function edgeKindFromSlotKind(slotKind: "flash" | "lend" | "swap"): EdgeKind;   // lend→credit
export function deriveEdgeTaxonomy(slotKind): { edgeKind: EdgeKind; leavesStandingPosition: boolean };
export function pathLeavesStandingPosition(edges: ReadonlyArray<{ leavesStandingPosition: boolean }>): boolean;
```

`canonicalize.ts:38` `strategyType` (legacy third vocabulary, `"atomic/standing"`) is NOT migrated
in v1 — `// legacy, do not extend` comment + ledger TODO.

**Taxonomy amendment (2026-07-04, operator decision — do not re-litigate):**
- **`"protocol"` edge kind added** — the protocol's OWN asset-conversion rule: mint / redeem /
  wrap / unwrap / PSM convert / CDP-style conversion, with the `ProtocolAction` sub-axis. It is NOT
  stuffed into `credit`: `credit`'s risk model is collateral/debt/HF/LTV/standing-position; a
  protocol edge's risk is the protocol's fixed conversion rule. Both can produce a position delta,
  but the risk models differ. (`creditAction`, e.g. `"borrow"`, stays reserved-by-example —
  formalize at the CR slices.)
- **Exemplar labels under the amended taxonomy:** coffee tx #2 `0x803a3693` = `block-scan`,
  edge_kinds `flash + protocol + swap`, protocolAction `mint` (the Liquity BOLD-issuance leg);
  reference tx `0xf88b…` = `backrun`, edge_kinds `flash + credit + swap`, creditAction `borrow`.
- **`"lp"` doctrine (analysis-only, unchanged in production):** lp = add/remove-liquidity legs
  (JIT LP, LP mint→victim swap→burn, share/underlying dislocations). It exists so competitor paths
  with lp legs are classified `edge_kind=lp` + `gap_detail=lp_leg_unsupported` (adapter_missing /
  path_not_found) instead of being misread as pool gaps / quote failures. Capability:
  `{ analysis: true, replay: maybe, liveRouting: false, submit: false }` — planner/quoter/
  plan-builder do NOT route lp; the searcher never submits one. Never a strategy value (D1-adjacent).
- **BS-0 direction note:** the pure-AMM exemplar (tx #3 `0xf2de7499`) WAS found, so BS-0's pure-DEX
  gate stands. Standing rationale recorded: pure-AMM standing loops are usually competed away before
  an atomic scanner gets them ("纯 AMM 一般轮不到原子") — if future windows show the pure-AMM class
  empty, the sanctioned fallback is pivoting BS-0's substantiation to a protocol-leg scan, not
  forcing an AMM-only loop.

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
Phase 0  SPINE        S0 (LANDED) ──> S1 (LANDED) ──> S2 (fail-closed standing-position guard — FIRST runtime touch)
Phase 1  FOUNDATIONS  BS-0 (=A0 fixture) · BS-contract (=A-contract; RELOCATES the S2 guard + adds BundleSubmission.safety) · BS-universe (=A-universe + edge projection) · CR-3 (0xf88b analysis/replay)
Phase 2  OFFLINE      BS-1/BS-2/BS-3 (=A1/A2/A3) · CR-5 (Fluid resolver-quote adapter, prod OFF)
Phase 3  COMPARE+LANE CS-min (=C2-minimal, + blockscan-triggers.ts shared module) → BS-lane (=A-lane; supersedes CR-7) → BS-4 (=A4, BLOCKED until BS-lane + fresh-read pre-gates green)
Phase 4  CLOSE+EXPAND CS-full (=C2-full) · D (dispatcher) · CR-8 (Aave/Euler) · CR-6-live (human gate) · B-residual (evidence-gated)
```

| slice | = source slice | status | delta vs source (beyond the §0 rename) |
|---|---|---|---|
| **S0** | replaces credit slice 1 + A-contract's naming layer | **LANDED** (gated: build + planner 14/14 + replay 12/12 + taxonomy 5/5 + router-filter, all re-run by the evaluator) | as §1.1/§1.2 |
| **S1** | replaces credit slice 2 + impl plan §1.5 creation + C1's deferred census wiring | **LANDED** (gated: tsc + `test:learning-case` 5/5 + C1 suites + cross-package planner 14/14, re-run by the evaluator; census emits `tx_shape:"unknown"` live until CS-min wires same-block log collection — honest plumbing, fixture-gated) | §1.4 schema/store; EXTEND `bundle-postmortem` (`winner_style`→`comparable`+`primary_gap`, `edge_kinds` via the C1b registry) + census (`tx_shape` field); `strategyKindFromTxShape` wiring; **CREATES the pinned postmortem fixtures for `0xa32b…`/`0xee7b98ad…`** — they do NOT exist at HEAD (verified; the credit plan's "existing fixtures" claim was false). Synthetic PostmortemReport-shaped JSON with the decision-relevant fields (winner_style, in_graph, builder payment vs gross), values from the committed report docs; no chain calls |
| **S2** | NEW — split out of BS-contract (2026-07-04 operator-line review, core finding 2: the hard gate must not wait for the risky factor-out; the credit edge is live-routable TODAY with no guard) | **LANDED** (gated: build + `searcher:standing-guard` 4/4 + planner 14/14 + replay 12/12 + taxonomy 5/5, evaluator re-run; deployed to the node same day) | Fail-closed standing-position guard at the EXISTING submit path, using landed S0 helpers: in `main.ts` immediately BEFORE the EV gate (`:1793-1826`; sole live submit site `:1840`), derive `containsStandingPosition = pathLeavesStandingPosition(candidate.tokenPath.edges)` (`CandidatePlan.tokenPath`, `planner.ts:8`) and REJECT — `pipeline_dropped("standing_position_unauthorized")`, no sign, no submit — unless the credit-live marker exists (`/opt/MEV/.credit-live`; path injectable for tests). ~20 lines + test. The AC-3/fixture harness (`hot-path.ts:109`) is a TEST-ONLY second submit site — exempt by construction (no broadcast), stated so nobody "fixes" it |
| **BS-0** | A0 | **NODE READS DONE — only the local harness remains** | ALL chain data captured + persisted to `listener/src/searcher/test/fixtures/blockscan-coffee-803a3693.json`: pre-tx states (block 25455023) + BOTH v4 PoolKeys + token symbols. Cycle finding recorded: the closed loop is the 2-hop CFG spread (WETH/CFG v3 → native-ETH/CFG v4); the 3rd pool (ETH/BOLD) is out-of-cycle. REMAINING is PURE LOCAL CODE (no node): Codex writes `blockscan-a0-replay.ts` + npm `searcher:blockscan-a0`, reconstruct the CFG 2-hop from the fixture, record `expectedGrossWei > 0`. See §9.4 |
| **BS-contract** | A-contract | GO | consumes S0 types; §1.3 union + §1.6 coordinator; **RELOCATES the S2 guard** into `processOpportunities` (same anchors, same drop reason) and adds belt-and-braces (operator-line review): `BundleSubmission.safety: { containsStandingPosition: boolean; edgeKinds: EdgeKind[] }` populated at build time, and a `BundleRouter.submit()` second-reject on `safety.containsStandingPosition` without the marker (bypass-proofing — no future caller can skip the check) |
| **BS-universe** | A-universe | GO | `buildStrategyViews` per §1.5 (EdgePolicy, D4 defaults, `edgeKindFromPoolEntry`); +credit slice 6's flag-flip gate folded in |
| **CR-3** | credit slice 3 | GO (after S1) | planner `REPLAY_FIXTURES` credit flip on `0xf88b` uses S0's `edgeKind:"credit"`; analysis emits an S1 `LearningCase`. **Anti-binding rule (operator-line review): `strategy_kind` comes from SOURCE EVIDENCE, never from the credit leg** — the `0xf88b` reference tx classifies `backrun` (its source swap is tx index 0; the arch plan's verified correction), credit is strategy-agnostic. `"flash"` in `edge_kinds` is the FUNDING wrapper, not a route leg — whether to split a `funding_kinds` field from route edges is decided AT CR-3 (schema-affecting; currently a merged view) |
| **BS-1/2/3** | A1/A2/A3 | GO (offline-fixture scope) | BS-1 planner branch REJECTS seedEdges with a view-disabled `edgeKind` → drop `edge_kind_disabled` |
| **CR-5** | credit slice 5 | prod OFF | resolver `quote()` + deterministic max-borrow (+ equivalence proof before deleting the `fluidDebtBps` search) + per-adapter gas table + EV-gate market-priced profit token (ADR-b must-haves 3/4). Guard already landed (BS-contract); CR-5 adds the Fluid-specific feasibility drops (`credit_infeasible`/`emode_required` → `pipeline_dropped`) |
| **CS-min** | C2-minimal | GO to build/report; BLOCKED as authoritative close input until P1-4+P1-5 green (carried) | emits §1.4 `LearningCase`; **CREATES `listener/src/searcher/blockscan-triggers.ts`** (`fetchSwapTouchedVenues` + `expandToPeerVenues`) as a shared module — CS-min's live-admission replay needs it BEFORE BS-4 exists; BS-4's lane imports it (DAG fix, reviewer-B m6) |
| **BS-lane** | A-lane | GO (hard prereq of BS-4) | same-process/one-EOA is v1 — **the shared signing nonce + coordinator is CORRECT for all-swap plans** (principal-safe). The credit workstream's "separate EOA" was a category mix: per-credit-LEG position isolation is `nftId`/sub-account level (ORTHOGONAL to the signing EOA) and rides the credit path at credit-live; a 2nd SIGNING EOA remains only the CPU/contention escalation (worker/process/2nd machine), Safety-1-gated. Supersedes credit slice 7 |
| **BS-4** | A4 | **BLOCKED** until BS-lane + P0-2/P0-3 fresh-read pre-gates green (carried) | rename only; imports `blockscan-triggers.ts` |
| **CS-full / D** | C2-full / D | follow BS-4 / LAST (carried blocks) | D dispatches on `strategy_kind` (never `"unknown"` — those are `manual_required`); block-scan closes write `blockscan-view-overrides.json` ONLY |
| **CR-8** | credit slice 8 | after CR-5 | unchanged |
| **CR-6-live** | credit slice 6 (live enable) | **human gate** (posture) | mechanism shipped in BS-universe; this item = the depeg-gated insertion decision + flag flip |
| **B-residual** | B-residual | evidence-gated | unchanged |

**Execution order (from today's state; S0/S1 landed):**
`S2 → BS-0 → BS-contract → BS-universe → CR-3 → BS-1 → BS-2 → BS-3 → CR-5 → CS-min → BS-lane →
BS-4 → CS-full → D → CR-8`. After S2 lands + gates: deploy to the node (`scripts/deploy-node.sh`)
so the guard is live — the restart is operator-authorized (2026-07-04).

---

## 3. Acceptance matrix (executable; rule-12 form)

| slice | command | expected transition / assertion |
|---|---|---|
| S0 | (LANDED — gates re-run by evaluator) | build + `searcher:planner` 14/14 + replay 12/12 unchanged; `searcher:taxonomy` 5/5; router-filter regression |
| S2 | new `searcher:standing-guard` + existing suites | a plan whose `tokenPath.edges` contain the fluid credit edge is REJECTED pre-EV-gate with `standing_position_unauthorized` when the (injectable) marker path is absent — no sign, no submit; ADMITTED when the marker exists; an all-swap plan untouched either way; backrun suites unchanged (`searcher:planner` 14/14 + replay 12/12) |
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
- **Credit-live guard (D2-keyed, lands at S2 — the FIRST runtime slice; BS-contract relocates it
  into `processOpportunities` and adds the `BundleSubmission.safety` field + `BundleRouter`
  second-reject):** derive `containsStandingPosition` from `candidate.tokenPath.edges` immediately
  before the EV gate (`main.ts:1793-1826`); reject `standing_position_unauthorized` unless
  `/opt/MEV/.credit-live` exists (independent of `.deploy-live` + wallet cap — `assert-balance`
  (`plan-builder.ts:113`) bounds only the flash token; the wallet cap does not bound a standing
  under-collateralized position). Setting `.credit-live` is a fresh explicit human authorization
  of the go-live class (Safety Rule 1). Until BS-contract lands, the pre-existing exposure
  (fluid edge live-routable with no guard) is bounded by: `quoteFluidVault` throws on the direct
  quote path, the depeg condition required for the debt-bps search to find +EV, and the EV
  gate/bounded-live envelope — recorded honestly, which is WHY the guard is its own FIRST runtime
  slice (S2), ahead of the BS-contract factor-out, deployed to the node as soon as it gates.
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

### 8.4 External operator-line review fold (2026-07-04 ~16:55 — v2.1 → v2.2)
Two "core findings" + a detail list, adjudicated:
- **Finding 1 (Fluid already in the production graph — premise conflict): ALREADY RESOLVED at v2
  (D4 grandfather).** The quoted premise ("credit default OFF, not in the backrun hot path") was
  v1 text; both blind reviewers had found the same blocker and v2 fixed it. No change.
- **Finding 2 (standing-position hard gate must be architectural + immediate): ADOPTED as slice
  S2** — the guard is ~20 lines with no dependency on the risky `processOpportunities` factor-out,
  so it ships FIRST at the existing submit site; BS-contract relocates it and adds
  `BundleSubmission.safety{containsStandingPosition, edgeKinds}` + a `BundleRouter.submit()`
  second-reject (bypass-proofing).
- **`0xee7b98ad…` expected gap → `manual_required`/sim-undervaluation: REJECTED with evidence.**
  The FINAL codified verdict on that case is `winner_style=one_leg_inventory` (CEX-DEX inventory,
  non-comparable noise) — the §6b meta-loop on this very case is what CREATED the non-comparable
  filter (HERMES.md §Competitor-loss step 2; memory `project-cex-dex-inventory-competitor-noise`, Opus+Fable
  dual-analysis converged). "Same-pool under-extraction" was the pre-meta-loop interim framing.
  S1's landed gate (`non_comparable_winner`, `comparable:false`) is correct.
- CR-3 anti-binding (strategy from source evidence; `0xf88b` = backrun) + flash-as-funding note:
  ADOPTED (§2 CR-3 row). No-leak greps: already TYPE-enforced (`PrimaryGap`/`StrategyKind` cannot
  hold atomic values) — not added.

---

## 9. HANDOFF — for the next fresh session (read this first)

**Context.** This doc was driven by a session that has since downgraded to a fallback model; the
operator is opening a NEW window with a fresh Fable to continue the IMPLEMENTATION. The design is
settled (v2.2) — do NOT re-open the architecture. Your job is to keep executing slices in order,
generator/evaluator split, each with its rule-12 gate.

### 9.1 Ground truth: what is LANDED vs what is NOT (verify against git, not this prose)

| slice | commit | acceptance result (re-run by evaluator) |
|---|---|---|
| C1a/b/c | `0fb1566`/`975ebc2`/`cbbdf1f` | sender-flow two-axis, swap-log-registry, tx-shape classifier + 9 coffee fixtures |
| **S0** taxonomy + TokenEdge widening | `75210c5` | build + `searcher:planner` 14/14 + replay 12/12 + `searcher:taxonomy` 5/5 + router-filter |
| **S1** merged LearningCase + postmortem/census fold | `6145931` | tsc + `test:learning-case` 5/5 + C1 suites + cross-package planner unchanged |
| **S2** fail-closed standing-position guard | `a737576` | build + `searcher:standing-guard` 4/4 + planner/replay unchanged; **deployed to the node** (live mode preserved, wallet 0.0027 ETH ≤ cap); runtime check = **0 `standing_position_unauthorized` false-positives** |
| **BS-0** harness | `d29110a` | `searcher:blockscan-a0` **19/19** — legs 1-2 replayed with production `computeSwapStep` from receipt-derived pre-states (amountOut + post-sqrtP bit-exact), leg 3 curve receipt-anchored, leg 4 canonical v2 bit-exact, surplus +270191 USDC, `expectedGrossWei` 157203701650240 recorded + gated; tsc + taxonomy 5/5 + planner 14/14 + replay 12/12 unchanged. Exemplar = `test/fixtures/blockscan-coffee-f2de7499.json` (tx #3, zero-node); `…803a3693.json` retired → future protocol-leg exemplar (protocolAction=mint, §1.1 amendment) |
| **BS-contract Pass A** (mechanical extraction) | `5fadecb` | `processOpportunities` factored out of `handleHint` (main.ts:1311-1968, backrun-only `SourceMeta` + `deps`), ZERO logic edits; byte-identical: planner 14/14 + replay 12/12 + `replay-live-fixtures` finalState buckets (expired:1/no-profitable:1) + taxonomy 5/5 + tsc all unchanged; evaluator re-ran all 4 + hunk-by-hunk diff review (hint→{source} equivalence, read-only threaded locals, fixturePlans write-back verified) |
| **BS-contract Pass B** (SubmissionCoordinator) | `a370612` | `submission-coordinator.ts` (one slot/targetBlock, sync `offer()` D1-matrix, `onBlock` prune) wired behind the backrun submit (offer→admit→submit); behavior-neutral (backrun-only always admits). Gate `searcher:submission-coordinator` 8/8 + planner/replay/replay-live-fixtures/blockscan-a0/taxonomy all unchanged (evaluator re-ran 6) |
| **BS-contract Pass B2** (safety second-reject) | `6ab9b49` | `BundleSubmission.safety` + `standingPositionSafetyReject` in both routers (refuse-before-broadcast on unauthorized standing-position, defense-in-depth behind S2); populated from `containsStandingPosition`/`standingGuard.allowed`; behavior-neutral. Gate `searcher:bundle-router-safety` 4/4 + all suites unchanged |
| **BS-contract Pass C1** (cycle-fingerprint) | `d958e42` | `detector/cycle-fingerprint.ts` (`canonicalTokenRing` + `cycleFingerprint`, §1.2 verbatim) — shared rotation/direction/case-invariant, sourceBlock-scoped join key. Gate `searcher:cycle-fingerprint` 7/7 |
| **BS-contract Pass C2** (union+events plumbing) | `319771b` | `BlockScanOpportunity` + `BackrunOpportunity` alias (detector.ts); `makeBlockScanOpportunityId` (keccak `blockscan\|`) + `block_scan_result` event + optional telemetry fields; `victim_hash` widened to optional (D1-renamed, additive, zero emitters). Gate `searcher:blockscan-contract` 5/5 + all suites unchanged + listener AND analysis tsc clean. **BS-contract layer (A/B/B2/C1/C2) COMPLETE** |
| **BS-universe Pass 1** (views module) | `479fb8b` | `buildStrategyViews` (backrun=basePools bit-for-bit; blockscan=base∪overrides∪universe-score-desc-capped, dedup; P1-5 hashes) + `edgeKindFromPoolEntry` + `blockscan-view-overrides` loader+[]seed. Gate `searcher:universe-split` 6/6 + all suites unchanged. Rule-14: universe ranked by `score` desc (PoolEntry lacks `selectArbRelevantPools`'s RankablePool fields; arb-relevance ranking = pool-scoring epic) |
| **BS-universe Pass 2** (main.ts wiring) | `872ee8b` | graph/tokenIndex/poolMap fed from `strategyViews.backrun` (===allPools, byte-identical); blockscan view + `view_version` computed+logged (BS-1 consumes later); `loadPoolUniverseGeneratedAt` added. Gate byte-identical (planner/replay/universe-split/replay-live-fixtures/taxonomy/tsc all unchanged). **BS-universe COMPLETE.** Phase-1 remaining: CR-3 |
| **CR-3a** (planner credit flip) | `90d6849` | `REPLAY_FIXTURES` + `lend()` helper + `templates?`/`flashLiquidity?`; `0xf88b` pair flips absent→0 (`impact_token_no_supported_return_venue`) / present→≥1 on the Fluid credit edge alone. `searcher:planner` replay 14/14 |
| **CR-3b** (analysis LearningCase) | `a9f8da6` | `test:learning-case` 6/6 — S1 schema carries `edge_kinds:[flash,credit,swap]`, `strategy_kind:backrun` (anti-binding), advances toward close. Follow-up filed (`task_45c7379e`): postmortem producer still hardcodes `["swap"]` |
| **PHASE 1 COMPLETE** | — | BS-0 · BS-contract (A/B/B2/C1/C2) · BS-universe (P1/P2) · CR-3 (a/b) — all landed + gated |
| **BS-1a** (scanner core) | `2498cf0` | `blockscan-scanner.ts` `detectBlockScanOpportunities` — PURE+SYNC 2-hop anchor finder over the warm cache (mid-price v2/v3/curve, spread−fees, WETH flashToken, geometric-mid searchCenter>8n, ranked+capped, cycleFingerprint). `searchSeed` string→`{startToken,searchCenter,maxInput}`. Gate `searcher:blockscan-scanner` 7/7 (anchor w/ correct cheap→rich orientation, no-spread control, single-venue, delta-restrict, priced-token gate, rank+cap, fingerprint) + all suites unchanged. Evaluator hand-verified the algorithm |
| **BS-1b** (planner binding) | `b8d1c12` | `planBlockScanFromSeedEdges` builds a plan DIRECTLY from seedEdges (no rotation, `maxFlashAmount`=searchSeed.maxInput); plan() early-return branch, backrun BYTE-IDENTICAL (planner 15/15 incl new binding test + replay 14/14 + replay-live-fixtures buckets unchanged). **BS-1 complete: scan→BlockScanOpportunity→plan end-to-end** |
| **BS-2** (3–4 hop cycle extension) | `c0e617b` | reuse `buildTokenPaths(t,t)` on anchor tokens, score rings Σln(mid·(1−fee))>0, rotate to flashToken, emit full-ring seedEdges, dedup by cycleFingerprint. Gate `searcher:blockscan-scanner` 10/10 (3-hop found, unprofitable control, dedup) |
| **BS-3a** (solver center) | `7f66cb7` | `resolveSearchCenter` block-scan branch → `searchSeed.searchCenter` (no victim/1n-dust). Gate `searcher:blockscan-solver-center` 2/2 + backrun byte-identical |
| **SCANNER OFFLINE-COMPLETE** | — | detect (BS-1a 2-hop + BS-2 cycles) → route (BS-1b) → size (BS-3a), all tested. **Remaining needs the LIVE NODE / real fork state → OPERATOR-gated:** BS-3 full-pipeline sim→standalone bundle (needs a profitable block-scan fixture on a fork), BS-lane (concurrent lane in the live process), BS-4 (live dry-run window). CR-5 gate needs archive (0xf88b fork replay, block 24710788 past prune). CS-min/CS-full/D/CR-8 are later Phase-3/4 slices |

**STATUS (2026-07-05, supersedes the pre-implementation line below):** Phase 0 (S0/S1/S2) + Phase 1
(BS-0, BS-contract A/B/B2/C1/C2, BS-universe P1/P2, CR-3 a/b) + the block-scan scanner OFFLINE body
(BS-1a 2-hop core, BS-1b planner binding, BS-2 3–4-hop cycles, BS-3a solver center) are all LANDED +
gated. The 2026-07-05 R-2b relay added: BS-0-curve node-state verification, `edge-kinds` receipt
derivation (chip `task_45c7379e` closed), the `blockscan-fork-solve` probe (which fork-verified the
BS-0 exemplar `0xf2de7499` as **−EV / oracle-trigger, NOT a standing dislocation** → BS-3 full pipeline
is EPIC-blocked on a genuinely-viable +EV exemplar), CR-3 secondary AC-3-archive validation, and CR-5
decomposition (a–e; CR-5b escalated — no deterministic Fluid quote path). **Dual-blind arch review
(R-2b-6) verdict: the production needle-mover is FLOW-ADMISSION — the MEV-Share submit flag
`SEARCHER_SUBMIT_HASHONLY_MEVSHARE` (95% of +EV sims self-drop at submit_gate because it is unset) — a
HUMAN-GATE config flip (chip `task_3deb3186`), not more Phase-2b scaffolding.** Still unwritten / gated:
BS-3 full pipeline (viable-exemplar-blocked), CR-5 adapter (archive + Fluid-quote-gated), BS-lane/BS-4
(live node/window), CS-min/CS-full/D/CR-8 (Phase 3/4).

_(historical, pre-implementation:)_ Everything from `BS-contract` onward is unwritten. Total: **3 of 16
runtime slices landed; the block-scan scanner body (BS-1/2/3), the credit adapter (CR-5), and all of
Phase 3/4 do not exist.**

### 9.2 The node is in bounded-LIVE-BROADCAST mode RIGHT NOW (critical safety note)

`/opt/MEV/.deploy-live` is set; the searcher signs + sends real mainnet bundles on the bounded test
wallet `0xb8578B6…` (≤ 0.2 ETH cap, EV_GATE=1). This is operator-authorized (2026-07-03). Implications:
- **`scripts/deploy-node.sh` will restart it in LIVE mode** — the guard is inside the script (marker
  + wallet cap + EV gate + mode-preservation verify). A deploy is safe by that envelope, but it IS a
  live restart — expect a ~1-min competitiveness gap; analyze events across the `run_id` boundary.
- **Do NOT create `/opt/MEV/.credit-live`** — that authorizes standing-position (credit) submissions
  and is a FRESH human gate (Safety Rule 1). Its absence is why S2 is currently fail-closed on the
  fluid edge. Leave it absent unless the operator explicitly authorizes credit-live.
- Bounded-live safety valve: if the test wallet drops below 50% of its start balance, STOP,
  `rm /opt/MEV/.deploy-live`, report.
- The searcher only picks up new code on RESTART; deploy before relying on any measurement.

### 9.3 Tooling / process gotchas that will bite you (learned this session)

- **Codex is the generator (rule 11).** ALWAYS invoke via the wrapper, never hand-write the codex
  line: `scripts/codex-run.sh <read-only|workspace-write> /tmp/codex-<slice>.brief.md /tmp/codex-<slice>`
  run in the background; judge success by the `-o` output file + `git diff --stat`, NOT stdout. A
  PreToolUse hook BLOCKS a raw `codex … exec` without the wrapper.
- **You are the non-author evaluator (rule 9/12).** Re-RUN every gate yourself; read the full
  `git diff` hunk-by-hunk (Codex over-scopes). Commit only the verified surface. `git diff --stat`
  first — S0 legitimately touched 13 files (mechanical TokenEdge literal updates), so a wide diff is
  not automatically wrong, but confirm each hunk is in-scope.
- **NEVER `rg -rn`/`-rln`** — `-r` is `--replace` and corrupts reads (memory `project-buildernet-auction-loss-anatomy`).
- **Fable subagents auto-fallback to Opus mid-run on arbitrage content** — designed, not a bug; a
  fresh-Fable review that comes back partly Opus is still valid.
- **Analysis imports listener relatively** (`analysis/src/cli/live-loss.ts:15` precedent) — the
  shared `strategy-taxonomy.ts` / `cycle-fingerprint.ts` live in `listener`, `analysis` imports them.
- Package test scripts were switched to `node --import tsx --test` (the `tsx` CLI IPC pipe is blocked
  in this sandbox); keep that style for new test scripts.
- Stray untracked `listener/src/searcher/venues/capability.js` sits beside `capability.ts` — delete
  or gitignore it (a shadowing hazard); not auto-removed because this session didn't create it.

### 9.3b Chain-dependency map — ALL node/live/broadcast work is PRE-CLEARED (stay pure-code)

The operator's directive: front-load everything needing node/live/broadcast so the next session
stays on pure code (live/arbitrage chain work is what tends to trigger the safety-classifier
downgrade). Done. Per-slice chain dependency:

| slice | chain dependency | status |
|---|---|---|
| BS-0 | NONE — exemplar re-selected to tx #3 `0xf2de7499`; poolKeys + pre-states all receipt-derived locally (see `blockscan-coffee-f2de7499.json` `_provenance`) | **pure-local**; ONE optional operator upgrade: curve pool `0x6206ca31` state at block 25455296 (TIME-SENSITIVE, prune window ~2026-07-05/06) |
| BS-contract, BS-universe, BS-1/2/3 | none — gates are `searcher:planner` + `searcher:replay-live-fixtures` (persisted) + unit tests | pure-local |
| CR-3 | PRIMARY gate = local planner `REPLAY_FIXTURES` flip; OPTIONAL secondary = AC-3-style ~273 wstUSR delta needs `MAINNET_RPC_URL` archive (block 24710788, past reth prune) | do the LOCAL primary gate; DEFER the archive half to the operator |
| CR-5 / BS-lane / BS-4 / CS-min / D / CR-8 | BS-4 is a live dry-run window (operator-run); the rest are local until then | later slices; not the next session's concern |

**Rule for the next session: if a slice appears to need node / archive / broadcast, STOP and hand
back to the operator — do not touch the node yourself.** S2 is already deployed + live-verified;
nothing you write next needs a deploy until BS-4 (operator-gated).

### 9.4 EXACT next actions, in order

> **⭐ PRIORITY REORDER 2026-07-05 (operator-directed) — PROTOCOL/CREDIT LEG EV-UNLOCK moves to the
> FRONT, ahead of the blocked block-scan/CR-5 tail.** Rationale (all verified this session): EV is the
> binding constraint. (1) The MEV-Share submit flag is a **STRUCTURAL posture ceiling, not a code/latency
> bug** — dual-blind: 20/20 mev_sendBundle relay-rejected "backrun not found", 19/20 hints never land,
> 102ms fast submits still rejected; targetBlock/latency proven inert (`project-mevshare-submit-flag-lever`).
> (2) Pure-DEX atomic loops are **dust** (census: 14 atomic_loop, all $0.10–0.58). (3) Coffee's real EV
> is in legs we neither SEE nor ROUTE — non-uni swaps (Pancake-v3 `0x19b47279`, DODO `0xc2c0245e`),
> PROTOCOL legs (Liquity mint / ERC4626 wrap / PSM-reverse), Fluid CREDIT — and `edge-kinds.ts:51`
> literally says *"Protocol-leg detection … is future work."* Full synthesis (3 code-verified fable-agent
> landing plans, sequencing) = `docs/research/reports/coffee-ev-protocol-credit-plan-20260705.md`.
>
> **NEW ORDER (front-loaded):**
> - **PHASE 0 — classification unblock (offline, zero-node, DO FIRST):** extend `analysis/src/learning/
>   edge-kinds.ts` + `analysis/src/registry/protocols.ts` with protocol topics (Liquity Trove*, ERC4626
>   Deposit/Withdraw, Sky PSM), missing swap topics (Pancake-v3, DODO), Fluid credit topic, +
>   `deriveProtocolActionsFromLogs`; `STABLE_ORDER`→`[flash,swap,credit,lp,protocol]`; drop the `:51`
>   future-work comment; fix the LearningCase `["swap"]` hardcode. Gate (rule-12 flip): tx-2
>   `["flash","swap"]`→`["flash","swap","protocol"]`+action `["mint"]`; tx-4 swap obs include pancake+dodo.
> - **TRACK A — protocol/credit EXECUTION** (deterministic-local quotes; node only at fork-sim):
>   A0 taxonomy (`slotKind:"protocol"` + `protocolAction` + leavesStandingPosition table: mint=true→S2,
>   wrap/convert/redeem=false) → A1 PSM reverse (buyGem) + fee-aware quote (flip fixture) → A2 build →
>   A3/A4 ERC4626 (sUSDS/wstUSR) → **A5 wstETH (adapters ALREADY exist in `adapters/wrap.ts` — cheapest
>   win, just wire graph+quote+builder)** → A6 live-enable `SEARCHER_ENABLE_PROTOCOL_EDGES` (operator window).
> - **TRACK B — discovery scanner** (`venue-discovery-scan`: scan bot tx → log/trace reverse-infer venue
>   → classify edge_kind/protocolAction → venue-registry.json [candidate→approved→routable, human gate] →
>   feeds graph + classifier). Track A consumes the registry.
> - **Corrections that change the plan (agent-verified):** PSM is **already routed** (add reverse+fee, don't
>   rebuild); planner needs **zero change** (edge-kind-agnostic DFS, slot order unenforced); Liquity BOLD
>   mint = **DEFER** (its exemplar is $0.33/fee-negative); census `tx_shape` is **broken at scale**
>   (`sameBlockSwapLogs` never populated) — fix in PHASE 0; EV metric = **builder_payment** not realized_usd.
> - **DEFERRED behind the above (don't let them gate it):** BS-3 full-pipeline (discovery-blocked on a
>   viable +EV exemplar), CR-5 Fluid resolver-quote (archive + research), Aave/Morpho credit (credit-live
>   human gate), CS-min/CS-full/D/CR-8. MEV-Share flag disposition = operator call (harmless if left on).
>
> The historical block-scan next-actions below (BS-0…BS-3, all LANDED per §9.1) are kept for provenance.
>
> **TRACK A/B EXECUTION STATUS (2026-07-05, this relay — all offline slices landed + gated):**
> - **PHASE 0** — landed pre-relay (`e17316e` + `2ea2646`); re-verified green (`test:learning-case` 11/11).
> - **A0** protocol taxonomy (`31bbec5`): `slotKind:"protocol"` + `protocolAction`; leavesStandingPosition
>   FAIL-CLOSED (unguarded only for wrap/unwrap/convert/redeem/stake/unstake; `mint`/undeclared stay
>   S2-guarded — stricter than the bare "mint=true" table). PSM reclassified protocol/convert,
>   planner byte-identical.
> - **A1** PSM fee-aware quote + reverse routing (`3933eaa`): quotePSM async, LitePSM `tin`/`tout` WAD
>   math (buyGem exact-in inverted, floor-conservative), fallback 0 on read failure;
>   `psm-reverse-absent/present` flip pair; `searcher:psm-quote` 5/5. No live reverse edge (A6).
> - **A2** PSM buyGem build (`8b586a0`): direction-aware encode (USDC-side = gemAmt), matchTrace accepts
>   both selectors; plan-builder amount = amtIn(sell)/amtOut(buy); `searcher:psm-build` 3/3.
>   **OPERATOR gate outstanding: anvil fork buyGem round-trip.**
> - **A5** wstETH wiring (`7eac27f`): graph wsteth case (wrap/unwrap protocol edges), Lido rate quotes,
>   build cases, template ids; flip pair `wsteth-absent/present`; `searcher:wsteth-quote` 3/3.
>   **Live-gated OFF: `SEARCHER_ENABLE_PROTOCOL_EDGES` (default 0) filters wsteth from the live merge
>   (PSM grandfathered). OPERATOR gates: cast-verify WSTETH/STETH, fork-sim round-trip (stETH rebasing
>   1-2 wei quirk), then the A6 flip + dry-run window.**
> - **B2** venue-discovery-scan (`198003b`): `analysis/src/discovery/venue-evidence.ts` +
>   `venue-discovery-scan` CLI (log-only offline) + `test:venue-discovery` 2/2 — coffee tx-2 surfaces the
>   Liquity venue `0xa2895d6a` (protocol), excludes WETH/PoolManager/Balancer/bot; tx-3 pure-swap control
>   clean. Feeds B4 (venue-registry, next Track-B slice) + Track A consumption.
> - **A3/A4 ERC4626 — NOT landed, address-blocked offline:** USDS (sUSDS `asset()`) + wstUSR's underlying
>   are not repo-verifiable; spec (incl. the sUSDS-first priority — its Curve return venues
>   `CURVE_SUSDS_USDT`/`CURVE_DOLA_SUSDS` are ALREADY in-graph ⇒ loop-closable today) =
>   `docs/research/design/erc4626-a3a4-spec-20260705.md`. Needs one operator `cast` pass, then the
>   A5-shaped slice is mechanical.
> - **A3/A4 ERC4626 (sUSDS + wstUSR) — LANDED + LIVE (`4eacc5f`).** Addresses cast-verified
>   (USDS `0xdC035D45…`, USR `0x66a1E37c…`); adapter/quote/graph/build mirror A5; fork-sim on node
>   passed BIT-EXACT (deposit shares == previewDeposit, redeem USDS == previewRedeem, diff=0).
> - **A6 GO-LIVE DONE (operator "全部同意" 2026-07-05).** `SEARCHER_ENABLE_PROTOCOL_EDGES` is now a
>   `.protocol-edges` marker (deploy-node.sh `04d10ce`, mirrors `.bribe-all-above-gas`). Node deployed
>   `4eacc5f`, bounded-live (wallet 0.0027 ETH ≤ cap, EV_GATE=1); banner `protocolEdges=enabled`,
>   **5 protocol entries** (PSM+fluid+wsteth+sUSDS+wstUSR) all in the live graph + planner-evaluated.
>   0 protocol-edge candidates fired (conversions near-NAV; capability live for a dislocation), wallet
>   unchanged = no loss. Node fork-sims: wstETH ✓ (wrap bit-exact, unwrap −1 wei) + sUSDS ✓ (bit-exact).
> - Remaining operator/human gates: A2 PSM buyGem fork-sim (code landed but PSM reverse NOT live-wired —
>   forward-only registry entry; buyGem unreachable live until a reverse entry is added); BS-3 exemplar,
>   CR-5 archive, BS-lane/BS-4, CR-6-live (Aave credit-live = separate `.credit-live` gate), broadcast
>   scope changes (Safety Rule 1). To disable protocol edges: `rm /opt/MEV/.protocol-edges` + redeploy.

1. **Finish BS-0 — EXEMPLAR RE-SELECTED (2026-07-04, operator-approved).** The original exemplar
   tx #2 `0x803a3693` was mischaracterized: its "CFG 2-hop loop" is fee-negative in both directions
   (0.32% tick spread vs ~1.3% round-trip fee) and lost −0.0000023 ETH in the real execution; the
   profit rides a **Liquity V2 BOLD-issuance leg** (the "out-of-cycle" ETH/BOLD pool is integral).
   It is RETAINED as the future protocol-leg exemplar (strategy=block-scan, edge_kinds=flash+
   protocol+swap, protocolAction=mint — §1.1 amendment) but NOT for the BS-0 pure-DEX gate. The new exemplar is **tx #3 `0xf2de7499`**
   (block 25455297): a genuine 4-leg pure-AMM loop (Balancer-flash USDC → v4 USDC/USDT fee=7 [the
   edge, +8.1bps USDT premium] → v4 USDT/D166 → Curve D166→USDC → repay, +0.270191 USDC surplus →
   v2 →WETH, +157203701650240 wei realized). Everything was derived with ZERO node access from the
   committed receipt fixture (poolKeys keccak-recovered; v4 pre-states single-tick-inverted with
   diff=0 out cross-check; v2 pre-reserves exact from Sync; curve leg receipt-anchored) — see
   `blockscan-coffee-f2de7499.json`. Codex writes `listener/src/searcher/test/blockscan-a0-replay.ts`
   + npm `searcher:blockscan-a0` replaying legs 1/2/4 with local math (v3-math engine + canonical v2),
   asserting bit-exact leg outputs vs realized, loop surplus > 0, `expectedGrossWei > 0` (record it
   into the fixture). Gate: cycle reconstructable from public block-boundary state alone
   (substantiates "contestable with a scanner, no private info"). This is the ONLY gate other
   slices' fixtures depend on.
2. **BS-contract** (the biggest, riskiest slice — the ~640-line `processOpportunities` factor-out from
   `handleHint`). Follow impl plan §A-contract + this doc §1.3/§1.6. **DECOMPOSED into gated passes
   (2026-07-04, autonomous scoping per rule 14 — one narrow patch each, rule 11):**
   - **Pass A (in flight): the mechanical extraction only.** Extract `main.ts:1311–1968` (the
     opportunities loop + trailing fall-through `recordFinalState`) into
     `async function processOpportunities(ctx, opportunities, sourceMeta, deps)` — `sourceMeta` is the
     **backrun-only** `SourceMeta` arm; per-hint closures (`recordFinalState`/`segMark`/`segStr`) +
     the loop-mutated `fixturePlans` (via an `addFixturePlans` callback) go in `deps`;
     `lastTerminalState/Error` become locals. main.ts ONLY, ZERO logic edits. Gate: `searcher:planner`
     14/14 + replay 12/12 BYTE-IDENTICAL + tsc + taxonomy 5/5. (Boundary confirmed by grep: `emitEvent`
     + all helpers are module-level imports — no threading; `fixtureOpportunities` set pre-loop, stays.)
   - **Pass B:** SubmissionCoordinator (`submission-coordinator.ts`) + `bundle-router.ts` `victimTxHash`
     + `BundleSubmission.safety` + route the (single, backrun) submit site through the coordinator's
     second-reject; RELOCATE the S2 standing guard into `processOpportunities`.
   - **Pass C:** detector union rename (type-only) + `events.ts` atomic fields + `cycle-fingerprint.ts`
     + the `atomic-contract.ts` gate (§A-contract acceptance a–f). The atomic `SourceMeta` arm is added
     when BS-1 (the scanner) needs it — not before, to keep Pass A's byte-identical gate clean.
   Each pass = its own rule-12 record + commit.
3. **BS-universe** (§1.5, `buildStrategyViews` + `edgeKindFromPoolEntry` + D4 defaults), then **CR-3**
   (`0xf88b` credit flip, strategy from source evidence). Then the scanner slices BS-1/2/3.

Full order (§2, block-scan spine — mostly LANDED): `BS-0 → BS-contract → BS-universe → CR-3 → BS-1 →
BS-2 → BS-3 → CR-5 → CS-min → BS-lane → BS-4 → CS-full → D → CR-8`.
**SUPERSEDED FRONT (2026-07-05, see the PRIORITY REORDER block above):** `PHASE 0 (classification) →
TRACK A (protocol/credit execution: A0 taxonomy → PSM-reverse → ERC4626 → wstETH → live-enable) +
TRACK B (discovery scanner) → [then the deferred tail: BS-3 full-pipeline · CR-5 · BS-lane · BS-4 ·
CS-min · CS-full · D · CR-8]`. Statuses/blocks per §2.

### 9.5 Invariants you must not break (the whole point of the merge)

- **D1:** strategy values are `"backrun" | "block-scan"` ONLY. "atomic" is BANNED as a strategy value
  (kept only in `winner_style:"atomic_loop"` + tx-shape's `"atomic_state_arb"` observation label).
  Any new `/atomic/i` identifier must be in the §0 rename map or carry a written justification.
- **D2:** `edgeKind` + `leavesStandingPosition` on the EDGE (one derivation, `deriveEdgeTaxonomy`);
  the plan flag is DERIVED (`pathLeavesStandingPosition`); posture guards key on the derived flag,
  never a strategy name. ONE edge type (`TokenEdge` widened in place) — no second `VenueEdge` class.
- **D3:** ONE `LearningCase` (`analysis/src/learning/learning-case.ts`); emitters EXTEND
  postmortem/census; the dispatcher (D) consumes ONLY `LearningCase`. No parallel analyzer pipeline.
- **D4:** the fluid credit edge is grandfathered live in the backrun graph
  (`ENABLE_CREDIT_EDGES_FOR_BACKRUN=1` default); the hazard is SUBMITTING a standing-position plan,
  gated by S2/the credit-live marker — not graph membership.
- This doc is the naming/schema/slice-plan AUTHORITY; slice-detail authority stays with the source
  specs (`coffee-20260704-atomic-epic-impl-plan.md` etc.). Resolve any conflict by amending THIS doc
  first (one authority, no drift).
