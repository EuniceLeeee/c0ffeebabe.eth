# Unified architecture — implementation plan (strategy_kind × edge_kind; block-scan absorption)

> Scope: authorized, defensive on-chain arbitrage research; mainnet fork + dry-run; broadcast is a
> human-gated step. **NORMATIVE merge** of the two parallel workstreams per the reconciliation
> review (`docs/research/reports/arch-reconciliation-atomic-vs-credit-20260704.md`, working tree).
> Sources it merges: `coffee-20260704-atomic-epic-impl-plan.md` (block-scan mechanics — still the
> detail source for its slices), `credit-venue-landing-plan-20260704.md` + the two ADRs
> (`unified-strategy-edge-architecture-20260704.md`, `credit-venue-edge-20260704.md`).
>
> **Precedence:** where this doc conflicts with a source spec, THIS doc wins (the conflicts are
> exactly the reconciliation's collision axes; enumerated in §6). Where it is silent, the source
> spec's mechanics/gates stand unchanged. Shipped C1 (`0fb1566`/`975ebc2`/`cbbdf1f`) needs no
> rework — S1 adds its consumers.

---

## 0. The three normative decisions (settled here, do not re-litigate)

| # | decision | rationale (one line) |
|---|---|---|
| D1 | **Strategy axis = `"backrun" \| "block-scan"`. "atomic" is BANNED as a strategy value** — reserved for the derived execution property (`winner_style:"atomic_loop"` keeps it; principal-safety is expressed ONLY as `leavesStandingPosition:false`, computed from edges, never asserted by a name). | The safety fix (ADR-a) requires killing "atomic"-as-strategy, NOT renaming "backrun": every shipped artifact (`detector.ts:6` `kind:"backrun-arb"`, `tx-shape.ts`, route-gap-watcher, census) already speaks "backrun". "reactive" stays a prose synonym. Deviation-with-reason from ADR-a's cosmetic half. |
| D2 | **`edgeKind` + `leavesStandingPosition` live on the EDGE** (`TokenEdge` widened in place, `token-graph.ts:15`); the plan/opportunity carries a DERIVED `leavesStandingPosition = edges.some(...)`; every posture guard keys on the derived flag. One kind-derivation, no second competing tag. | Credit invariant 1 + reconciliation Task-1 defect 3: a block-scan opportunity must not be able to carry a standing-position edge past a name-trusting guard. |
| D3 | **ONE LearningCase schema** = credit's spine (`strategy_kind`, `edge_kinds[]`, funnel-ordered `primary_gap` + terminals) + the block-scan spec's machinery (`learning_case_id` idempotency, forward-only status, `parked_uneconomic`, `source_block = B−1`, P1-4 dual verdicts, P1-5 view hashes). Emitters EXTEND existing tools (postmortem/census); the schema lives in one new shared module. | Rule 16 / the 3×-analyzer drift both docs warn about; the atomic machinery is strictly superior operationally and credit's schema lacks it. |

**Rename map (D1, applied to every not-yet-shipped identifier from the block-scan spec):**

| old (atomic impl plan) | new (this doc) |
|---|---|
| `AtomicOpportunity` / `kind:"atomic-arb"` | `BlockScanOpportunity` / `kind:"block-scan-arb"` |
| coordinator/LearningCase `strategy:"atomic"` | `"block-scan"` (backrun value unchanged) |
| `atomic_scan_result` event | `block_scan_result` |
| `atomic_stale_target_block` / `atomic_state_inconsistent` / `atomic_preempted_by_backrun` | `blockscan_stale_target_block` / `blockscan_state_inconsistent` / `blockscan_preempted_by_backrun` |
| `SEARCHER_ENABLE_ATOMIC_SCAN` + `SEARCHER_ATOMIC_*` knobs | `SEARCHER_ENABLE_BLOCK_SCAN` + `SEARCHER_BLOCKSCAN_*` |
| `atomic-lane.ts` / `atomic_busy` / `atomic-breaker.ts` | `blockscan-lane.ts` / `blockscanBusy` / `blockscan-breaker.ts` |
| `atomic-view-overrides.json` / `atomic-view-overrides.ts` | `blockscan-view-overrides.json` / `blockscan-view-overrides.ts` |
| `atomic_view_hash` / views key `atomic` | `blockscan_view_hash` / `blockscan` |
| census field `atomic_scan_shape` | `tx_shape` (module name already) |
| gap classes `atomic_*` (C2 taxonomy) | spine + `gap_detail` per §1.4 (e.g. `blockscan_scan_not_triggered`) |
| `atomic-replay.ts` / `replayAtomicScanAt` | `blockscan-replay.ts` / `replayBlockScanAt` |
| `detectAtomicOpportunities` / `planAtomicFromSeedEdges` | `detectBlockScanOpportunities` / `planBlockScanFromSeedEdges` |

Shipped-analysis labels stay (observational, no guard consumes them): `tx-shape.ts`
`"atomic_state_arb"` (mapped at LearningCase construction, §1.1), `bundle-postmortem.ts:41`
`winner_style:"atomic_loop"` (measures the loop actually closing — the legitimate "atomic").

---

## 1. The spine — shared contracts (built once; every slice references these)

### 1.1 Strategy taxonomy + mapping — `listener/src/searcher/strategy-taxonomy.ts` (CREATE)

```ts
export type StrategyKind = "backrun" | "block-scan";
export type EdgeKind = "swap" | "credit" | "lp" | "flash";

/** Analysis-vocabulary mappings — the ONLY sanctioned bridges (D1). */
export function strategyKindFromTxShape(shape: "backrun" | "atomic_state_arb" | "unknown"): StrategyKind | "unknown";
// backrun → "backrun"; atomic_state_arb → "block-scan"; unknown → "unknown"
export function edgeKindFromSlotKind(slotKind: "flash" | "lend" | "swap"): EdgeKind;
// lend → "credit"; flash → "flash"; swap → "swap".  "lp" reserved (type stub only, ADR-a).
```

Lives in `listener` (analysis imports relatively — precedent `live-loss.ts:15`), so both sides
share one vocabulary. `canonicalize.ts:38` `strategyType` (the third legacy vocabulary,
`"atomic/standing"`) is NOT migrated in v1 — it gains a `// legacy, do not extend` comment and a
mapping TODO tracked in the ledger.

### 1.2 Edge model — `token-graph.ts` `TokenEdge` widened IN PLACE (MODIFY)

```ts
export interface TokenEdge {
  // ...existing fields unchanged (token-graph.ts:15-35)...
  /** Derived at edge construction from slotKind (edgeKindFromSlotKind). Never set independently. */
  edgeKind: EdgeKind;
  /** true ⇔ executing this edge leaves an open position after the tx (credit abandon-exit).
   *  Fluid/Aave/Euler credit edges: true. swap/flash/psm: false. */
  leavesStandingPosition: boolean;
}
```

- Single-derivation law (D2): `edgeKind` is a pure function of `slotKind` (+ future credit
  adapters); code review rejects any second independent kind tag.
- **Plan-level derived flag:** wherever a `TokenPath`/plan is scored or submitted, compute
  `leavesStandingPosition = path.edges.some(e => e.leavesStandingPosition)`. This is the ONLY
  input to the credit-live guard (§4) — never a strategy name, never `opp.kind`.
- The `token-graph.ts:474` pinned exemption (`score === undefined` never pruned) means a curated
  credit edge can NEVER be dropped by scoring → the ONLY drop point is view projection (§1.5).

### 1.3 Opportunity union — block-scan spec §1.1 field-set, renamed (MODIFY `detector.ts`)

Exactly the impl plan's §1.1 contract with: `BackrunOpportunity` unchanged (shipped),
`BlockScanOpportunity` replacing `AtomicOpportunity` (same fields: `sourceBlock`, `stateBlock`,
`cycleId`, `cycleFingerprint`, `seedEdges: TokenEdge[]`, pinned `flashToken`, `searchSeed`,
no `hints.impact`), plus ONE addition (D2):

```ts
export interface BlockScanOpportunity {
  kind: "block-scan-arb";
  // ...impl plan §1.1 fields...
  /** Derived from seedEdges at construction; re-derived (never trusted) at submit. */
  leavesStandingPosition: boolean;
}
```

`cycle-fingerprint.ts` (§1.2 of the impl plan) is unchanged — name, invariants, B−1 temporal rule.

### 1.4 Merged LearningCase — `analysis/src/learning/learning-case.ts` (CREATE; supersedes both source schemas)

```ts
export type PrimaryGap =
  // intake (pre-funnel) — note the symmetry: source_not_seen is backrun's intake gap,
  // scan_not_triggered is block-scan's (P1-4 lives here, not in path):
  | "source_not_seen" | "scan_not_triggered" | "edge_kind_disabled"
  // view/graph:
  | "view_missing" | "venue_missing"
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
  | "non_comparable_winner" | "standing_position_required" | "oracle_not_diverged"
  | "replay_state_unavailable" | "manual_required";

export interface LearningCase {
  learning_case_id: string;   // keccak(strategy_kind|trigger|competitor_tx|source_block|cycle_fingerprint|primary_gap)
  status: "open" | "proposed_close" | "replay_passed" | "applied" | "live_verified"
        | "parked_uneconomic" | "manual_required";          // forward-only (impl plan §1.5 rules)
  strategy_kind: StrategyKind;                              // D1 values
  edge_kinds: EdgeKind[];                                   // observed in competitor path / our plan
  trigger: "bundle_not_included" | "competitor_not_seen";
  competitor_tx?: string;
  our_opportunity_id?: string;
  source_block?: number;      // block-scan: competitor_execution_block − 1 (user pt 1)
  target_block?: number;
  cycle_fingerprint?: string;
  comparable: boolean;        // winner_style atomic_loop only; one_leg_inventory/sandwich ⇒ false
  primary_gap: PrimaryGap;    // funnel-ordered spine — FIRST blocking gap
  gap_detail?: string;        // owner routing, e.g. "blockscan_cycle_not_found", "credit_infeasible",
                              // "emode_required", "blockscan_budget_skipped"
  our_stage?: string;
  strategy_view_version?: string;                            // P1-5
  backrun_view_hash?: string; blockscan_view_hash?: string;  // P1-5
  capability_replay_stage?: string;  live_admission_stage?: string;   // P1-4
  evidence: Record<string, unknown>;
  close_action?: { kind: string; target_file?: string; entries?: string[] };
  replay_gate?: { command: string; expected_transition: string; before?: string; after?: string };
  created_at: string; updated_at: string;
}
```

Gap-taxonomy fold (both source taxonomies map INTO the spine; the distinction P1-4 protects
survives as two different spine positions):

| source class | spine `primary_gap` | `gap_detail` |
|---|---|---|
| `atomic_view_missing_venue` | `view_missing` | `blockscan_view_missing_venue` |
| `atomic_scan_not_triggered` | `scan_not_triggered` | — |
| `atomic_cycle_not_found` | `path_not_found` | `blockscan_cycle_not_found` |
| `atomic_sizing_failed` | `sizing_failed` | — |
| `atomic_quote_fidelity_failed` | `quote_failed` | `blockscan_quote_fidelity` |
| `atomic_sim_revert` | `sim_failed` | — |
| `atomic_below_ev_gate` | `below_ev` | — (economics = human gate) |
| `atomic_budget_skipped` | `scan_not_triggered` | `blockscan_budget_skipped` |
| `atomic_competitor_faster_or_outbid` | `outbid` | — |
| credit `credit_infeasible` / `emode_required` / `credit_stale_oracle` | `quote_failed` | same string |
| backrun `router_not_watched` / `source_swap_not_seen` | `source_not_seen` | same string |
| backrun `pool_not_in_graph` | `venue_missing` | — |
| backrun `path_no_plan` | `path_not_found` | — |

Store/API/lifecycle: exactly impl plan §1.5 (committed `analysis/learning-cases/store.json`,
gitignored replay-cache, `parked_uneconomic` re-open rule k=3). Emitters: `bundle-postmortem`
(backrun trigger) + `strategy-compare` (block-scan trigger) — both EXTEND existing tools;
the dispatcher (slice D) consumes ONLY `LearningCase` (compile-level).

### 1.5 Strategy views + edge-kind projection — `strategy-views.ts` (CREATE; absorbs credit slice 6's mechanism)

Impl plan §A-universe's `buildStrategyViews` with two changes:

```ts
export interface EdgePolicy {          // ENABLE_CREDIT_EDGES_FOR_* flags, all default 0
  creditForBackrun: boolean;           // SEARCHER_ENABLE_CREDIT_EDGES_FOR_BACKRUN
  creditForBlockscan: boolean;         // SEARCHER_ENABLE_CREDIT_EDGES_FOR_BLOCKSCAN
  creditForAnalysis: boolean;          // SEARCHER_ENABLE_CREDIT_EDGES_FOR_ANALYSIS (replay/compare only)
}
export interface StrategyViews {
  backrun: PoolEntry[];
  blockscan: PoolEntry[];              // renamed from `atomic`
  versions: { strategy_view_version: string; backrun_view_hash: string;
              blockscan_view_hash: string; pool_universe_generated_at: string; overrides_hash: string };
}
export function buildStrategyViews(basePools, universeFile, overrides,
  opts: { blockscanMaxPools: number; edgePolicy: EdgePolicy }): StrategyViews
```

- **Edge-kind policy applies at PROJECTION time** (per-view filter on `edgeKind`), because scoring
  can never prune pinned credit edges (`token-graph.ts:474`, §1.2). `creditForBackrun=0` ⇒ no
  credit edge in the backrun view/graph/mempool filter; same per view. This IS credit slice 6's
  `projectView` — one module, not two.
- View hashes (P1-5) cover the edge-policy state too (a flag flip changes
  `strategy_view_version`), so a close/replay is attributable across policy changes.
- Everything else from A-universe stands: backrun view bit-for-bit today's selection; mempool
  `toAddress` filter built from `views.backrun` only; `selectArbRelevantPools` promotion.

### 1.6 SubmissionCoordinator — impl plan §1.4, values renamed (CREATE `execution/submission-coordinator.ts`)

Unchanged in substance: sync `offer()`, one slot per `targetBlock`, decision matrix, backrun-first
default, `onBlock` prune. `SubmissionCandidate.strategy: StrategyKind`; loser reasons
`submission_arbitration_lost` / `blockscan_preempted_by_backrun` (coordinator-only). Credit never
appears as a strategy value — by construction (D1: credit is an edge kind). This is the ONE
coordinator both lanes and any future producer feed; credit slice 7 must not create another.

---

## 2. Slice plan (merged DAG; statuses carry over from the source specs' owner re-gates)

```
Phase 0  SPINE        S0 (types/taxonomy/projection) ──ships with──> S1 (learning layer)
Phase 1  FOUNDATIONS  BS-0 (=A0 fixture) · BS-contract (=A-contract) · BS-universe (=A-universe, absorbs CR-6 mechanism) · CR-3 (0xf88b analysis/replay)
Phase 2  OFFLINE      BS-1/BS-2/BS-3 (=A1/A2/A3, offline-fixture scope) · CR-5 (Fluid adapter + guard, prod OFF)
Phase 3  COMPARE+LANE CS-min (=C2-minimal) → BS-lane (=A-lane; supersedes CR-7) → BS-4 (=A4, BLOCKED until BS-lane + fresh-read pre-gates green)
Phase 4  CLOSE+EXPAND CS-full (=C2-full) · D (dispatcher) · CR-8 (Aave/Euler) · CR-6-live (depeg-gated backrun insertion — human gate) · B-residual (evidence-gated)
```

| slice | = source slice | status | delta vs source (beyond the §0 rename) |
|---|---|---|---|
| **S0** | replaces credit slice 1 + the naming layer of A-contract | **GO — FIRST** | §1.1 taxonomy module; §1.2 TokenEdge widening + derived plan flag; `lp` type stub only. Pure types; ships WITH S1 (no bare observability turn, rule 13) |
| **S1** | replaces credit slice 2 + the impl plan's §1.5 creation + C1's deferred census wiring | **GO — WITH S0** | §1.4 merged schema/store; EXTEND `bundle-postmortem` (`winner_style`→`primary_gap`+`comparable`, `edge_kinds` via the C1b registry), census (`tx_shape` field, NOT `atomic_scan_shape`), `strategyKindFromTxShape` wiring; sender-flow axes → `evidence` |
| **BS-0** | A0 | GO (R5: run early, prune window) | fixture names only |
| **BS-contract** | A-contract | GO | consumes S0 types instead of defining them; +gate (g): a `BlockScanOpportunity` whose `seedEdges` contain a `leavesStandingPosition` edge derives the plan flag `true` (unit); coordinator per §1.6 |
| **BS-universe** | A-universe | GO | `buildStrategyViews` per §1.5 (edgePolicy param; views key `blockscan`); +credit slice 6's gate folded in (see matrix) |
| **CR-3** | credit slice 3 | GO (after S0) | planner `REPLAY_FIXTURES` credit-edge flip on `0xf88b` uses `edgeKind:"credit"` from S0; analysis recognition emits a `LearningCase` (S1 schema) |
| **BS-1/2/3** | A1/A2/A3 | GO (offline-fixture scope) | BS-1 adds the edge-policy guard: `planBlockScanFromSeedEdges` REJECTS (drop reason `edge_kind_disabled`) any seedEdge whose `edgeKind` is disabled for the blockscan view — cheap, closes the D2 hole at the planner boundary too |
| **CR-5** | credit slice 5 | prod OFF; **credit-live guard mandatory** | guard keys on the DERIVED plan flag (§4), never a label; + per-adapter gas table + EV-gate market-priced profit token (ADR-b must-haves 3/4) land HERE |
| **CS-min** | C2-minimal | GO to build/report; **BLOCKED as authoritative close input until P1-4+P1-5 green** (carried) | emits §1.4 `LearningCase`; `replayBlockScanAt` stamps `blockscan_view_hash` |
| **BS-lane** | A-lane | GO (hard prereq of BS-4) | + the phasing note: same-process/one-EOA is v1; the spec's own escalation trigger (hint `prep_ms p95` regression despite chunking) is ALSO the trigger for worker/process/**2nd-EOA (Safety-1 human gate)**. **Supersedes credit slice 7** — no second lane/coordinator/view stack |
| **BS-4** | A4 | **BLOCKED** until BS-lane + P0-2/P0-3 fresh-read pre-gates green (carried) | rename only |
| **CS-full / D** | C2-full / D | follow BS-4 / LAST (carried blocks) | D dispatches on `strategy_kind`; block-scan closes write `blockscan-view-overrides.json` ONLY |
| **CR-8** | credit slice 8 | after CR-5 | unchanged |
| **CR-6-live** | credit slice 6 (live enable) | **human gate** (posture) | the MECHANISM shipped in BS-universe; this item is only the `creditForBackrun=1` + depeg-gated insertion decision |
| **B-residual** | B-residual | evidence-gated (truncation log) | unchanged |

**Recommended execution order (next actions from today's state, C1 already shipped):**
`S0+S1 → BS-0 → BS-contract → BS-universe → CR-3 → BS-1 → BS-2 → BS-3 → CR-5 → CS-min → BS-lane →
BS-4 → CS-full → D → CR-8`. Each slice = one Codex brief (Claude plans → Codex writes → Claude
gates + commits; ≤3 files core surface where possible; BS-contract stays the gated-hardest
exception).

---

## 3. Acceptance matrix (executable; rule-12 form — deterministic ⇒ pinned fixture flip, else metrics)

| slice | command | expected transition / assertion |
|---|---|---|
| S0 | `cd listener && npm run build && npm run searcher:planner`; new `searcher:taxonomy` unit | backrun suites pass UNCHANGED (widening is additive); `edgeKindFromSlotKind(lend)==="credit"` + fluid registry edge gets `leavesStandingPosition:true`, every univ2/3/4/curve/psm edge `false`; `strategyKindFromTxShape` total mapping incl. `unknown`; derived plan flag: a path containing the fluid edge ⇒ `true`, all-swap path ⇒ `false` |
| S1 | new `analysis` `test:learning-case` (+ existing `test:tx-shape` 19/19 unchanged) | pinned postmortem fixtures fold to ONE schema: `0xa32b…` ⇒ `{strategy_kind:"backrun", primary_gap:"venue_missing", comparable:true}`; `0xee7b98ad…` ⇒ `{primary_gap:"non_comparable_winner", comparable:false}` (short-circuits, no close); coffee 9-tx fixture ⇒ 8 `{strategy_kind:"block-scan"}` + 1 `{strategy_kind:"backrun", primary_gap:"source_not_seen", gap_detail:"router_not_watched"}`; double-run ⇒ 0 new cases, 0 status regressions (id idempotency); census emits `tx_shape` (grep asserts `atomic_scan_shape` absent) |
| BS-0 | `searcher:blockscan-a0` | impl plan A0 gate verbatim (cycle reconstructable, `expectedGrossWei>0`, states persisted) |
| BS-contract | `searcher:planner` + `searcher:replay-live-fixtures` + `searcher:blockscan-contract` | impl plan A-contract gates (a)–(f) verbatim under new names; +(g) standing-position derivation (§2 row); coordinator matrix asserted both directions; atomic-off ⇒ zero behavior change |
| BS-universe | `searcher:universe-split` | impl plan A-universe gates (i)–(iv) verbatim (views key `blockscan`); +(v) **edge-policy projection (folds credit slice 6's gate):** `creditForBackrun=1` ⇒ fluid credit edge present in backrun view (proves strategy-agnostic routing); `=0` ⇒ absent from the PROJECTED view while still pinned in the registry (proves projection-drop, not scoring); flag flip changes `strategy_view_version` |
| CR-3 | `searcher:planner` (REPLAY_FIXTURES) | credit landing plan slice-3 gate verbatim: `0xf88b` fixture — credit edge present ⇒ `candidate_plans 0→≥1`, absent ⇒ 0; optional AC-3 token-delta ≈ 273 wstUSR; analysis side emits the S1 `LearningCase` with `edge_kinds:["flash","credit","swap"]` |
| BS-1 | `searcher:planner` | impl plan A1 gate verbatim + the edge-policy reject: a seed cycle containing a credit edge with `creditForBlockscan=0` ⇒ dropped `edge_kind_disabled`, never planned |
| BS-2 / BS-3 | `searcher:planner` + `searcher:bench-blockscan` / `searcher:replay-live-fixtures` | impl plan A2/A3 gates verbatim (renamed) |
| CR-5 | credit landing plan slice-5 gate + new guard test | slice-5 gate verbatim (deterministic max-borrow, ~273 wstUSR sim, `fluidDebtBps` search deleted with equivalence proof); **guard: a plan with derived `leavesStandingPosition:true` is REJECTED at submit unless `/opt/MEV/.credit-live` exists** (rejected-path unit — never exercised live in v1); gas table: credit leg ranked with 250–400k vs swap ~100k (a dust-regime fixture where credit over-ranked at gas=0 now under-ranks); EV gate values the profit token at executable market price (depeg fixture: peg-valued profit fails the gate, market-valued passes only when genuinely +EV) |
| CS-min | `strategy-compare` fixtures | impl plan C2-minimal gates verbatim (B−1 join, both P1-4 stages, `replay_state_unavailable` honesty, idempotency ×2) on the §1.4 schema |
| BS-lane | `searcher:blockscan-lane` | impl plan A-lane gate verbatim: hint injected mid-scan IS processed, zero lane-attributable `skip hint`, chunk-bounded start-delay, `skipped_busy`=own-lane only, preemption reason submission-slot-only, backrun suites unchanged lane-idle |
| BS-4 | dry-run window + Step-1 + `hermes-gate` | impl plan A4 metrics gate verbatim (renamed events/fields); thin window ⇒ EXTEND |
| D | `auto-close-strategy-gap` ×2 + replay | impl plan D gate verbatim + isolation invariant: block-scan close writes `blockscan-view-overrides.json` ONLY, `force-include-poolids.json` byte-identical, backrun mempool `toAddress` set-equal; input type = `LearningCase` only (compile-level) |
| CR-8 | per-protocol replay | credit landing plan slice-8 gate verbatim (flip `0→≥1` + shared-target `marketId` dedup) |

---

## 4. Safety envelope (merged; all defaults safe)

- **Flags:** `SEARCHER_ENABLE_BLOCK_SCAN=0` (master), `SEARCHER_BLOCKSCAN_{MAX_HOPS=4,
  MIN_SPREAD_BPS=10, SCAN_BUDGET_MS=2000, MAX_CANDIDATES=8, FULL_SWEEP_BLOCKS=50,
  VIEW_MAX_POOLS=6000, MAX_PEER_SEEDS=64}`, breaker knobs (impl plan §4 renamed);
  `SEARCHER_ENABLE_CREDIT_EDGES_FOR_{BACKRUN,BLOCKSCAN,ANALYSIS}=0`.
- **Credit-live guard (D2-keyed, lands in CR-5, checked at the single submit path):** any plan
  whose DERIVED `leavesStandingPosition` is true is rejected unless `/opt/MEV/.credit-live`
  exists — independent of `.deploy-live` + the wallet cap, because `assert-balance`
  (`plan-builder.ts:113`) bounds only the flash token, and the wallet cap does not bound a
  standing under-collateralized position. Setting `.credit-live` is a fresh explicit human
  authorization of the go-live class (Safety Rule 1); no autonomous process may create it.
- **Bounded-live envelope unchanged** for all-swap plans (`leavesStandingPosition:false` —
  genuinely atomic in the execution sense: a bad arb reverts, principal never at risk).
- **Breaker** (impl plan §4, renamed): only ever disables block-scan, never touches backrun.
- **Deploy preservation:** `deploy-node.sh` preserves + banners
  `blockScan=<on|off> blockscanView=<n> overrides=<n> blockscanViewHash=<0x…8>
  creditEdges=<b/bs/a flags>` — the `SEARCHER_POOL_UNIVERSE_TOP_N` silent-revert precedent.
- **Production enable-criteria** carry over verbatim: block-scan (impl plan §4 — ≥3 windows,
  net-EV clearing the same `evGate` floor, dust does not qualify, `parked_uneconomic` is a
  sanctioned outcome); credit-live (credit landing plan — marker + 2nd-EOA gates at their
  escalation points). Broadcast/go-live stays a hard human gate.

---

## 5. Module inventory (end state; ONE implementation per component)

**listener:** `strategy-taxonomy.ts` (S0), `token-graph.ts` widened (S0),
`detector/detector.ts` union (BS-contract), `detector/cycle-fingerprint.ts` (BS-contract),
`detector/blockscan-scanner.ts` (BS-1/2), `blockscan-lane.ts` (BS-lane), `blockscan-replay.ts`
(CS-min), `blockscan-view-overrides.ts` + committed `listener/searcher/pools/
blockscan-view-overrides.json` (BS-universe/D), `strategy-views.ts` (BS-universe, incl.
EdgePolicy), `execution/submission-coordinator.ts` (BS-contract), `blockscan-breaker.ts` (BS-4),
credit adapters in the existing quoter/plan-builder/ActionAdapter registry (CR-5/8), events/
planner/solver/main modifications per source specs.
**analysis:** `learning/learning-case.ts` (S1), `pnl/{sender-flow,swap-log-registry,tx-shape,
victim-source}.ts` (shipped C1 — registry gains credit-event decoders when S1/CR-3 need
`edge_kinds`), `cli/strategy-compare.ts` (CS-min), `cli/auto-close-strategy-gap.ts` (D),
postmortem/census field additions (S1).
Harness boundary unchanged: the ONLY scanner/replay implementation lives in `listener`;
`analysis` imports it.

---

## 6. Supersession table (what this doc overrides in the sources)

| source item | disposition |
|---|---|
| credit slice 1 (unified types) | **superseded by S0** |
| credit slice 2 (analysis LearningCase) | **superseded by S1** (same intent, merged schema) |
| credit slice 4 (VenueEdge typing layer) | unchanged — still OPTIONAL, latency-double-gated, post-v1 |
| credit slice 6 (projectView + flags) | mechanism **absorbed into BS-universe** (§1.5); live enable = CR-6-live (human gate) |
| credit slice 7 (lane + AtomicView + coordinator) | **superseded by BS-lane + BS-universe + §1.6** — no second lane/coordinator; 2nd-EOA = BS-lane's escalation path with its Safety-1 gate |
| atomic impl plan §1.5 LearningCase | **superseded by §1.4** (machinery kept, spine adopted) |
| atomic impl plan naming (`atomic-*`) | **renamed per §0** — mechanics/gates otherwise verbatim |
| atomic C2 taxonomy (10 `atomic_*` classes) | folded into spine + `gap_detail` (§1.4 table) |
| census field `atomic_scan_shape` | renamed `tx_shape`, lands in S1 |
| ADR-a `strategy_kind: reactive` string | canonical value `"backrun"` (D1 deviation-with-reason; "reactive" = prose synonym) |
| impl plan A-contract §1.1/§1.4 types | now defined here (§1.3/§1.6); A-contract implements them |

Everything not listed (all P0/P1 blockers, fresh-read gate, B−1 rule, view hashes, GO/BLOCKED
statuses, dust honesty, R1–R5, owner re-gates) **carries over unchanged**.

---

## 7. Governance

- Each slice: generator/evaluator split (Codex writes, Claude gates + commits); rule-12 quartet
  recorded per slice (`failing_sample / replay_command / expected_transition / verdict`).
- S0+S1 together are the mandatory FIRST implementation turn (they are what stops the next
  runtime slice from ossifying the wrong names — the reconciliation's blocking items 1–3).
- Hygiene rider on S0's brief: delete or gitignore the stray untracked
  `listener/src/searcher/venues/capability.js`.
- This doc is the naming/schema authority; slice-detail authority stays with the source specs.
  Any future conflict discovered during implementation is resolved by amending THIS doc first
  (one authority, no drift).
