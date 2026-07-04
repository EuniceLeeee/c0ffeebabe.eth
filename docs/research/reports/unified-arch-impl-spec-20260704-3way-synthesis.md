# Unified strategy × edge — fusion implementation spec (3-way blind synthesis, 2026-07-04)

> Scope: authorized, defensive on-chain arbitrage research; mainnet fork + dry-run; broadcast is a
> human-gated step. CANONICAL synthesis of three blind fusion drafts:
> [-A](unified-arch-impl-spec-20260704-A.md) · [-B](unified-arch-impl-spec-20260704-B.md) ·
> [-orchestrator](unified-arch-impl-spec-20260704-orchestrator.md). Builds on the settled reconciliation
> ([-3way-synthesis](arch-reconciliation-atomic-vs-credit-20260704-3way-synthesis.md)). Every non-trivial
> claim grounds in file:line.

## One-line
`Strategy Driver {backrun | block-scan} → Opportunity → Planner over EdgeGraph {swap | credit | lp | flash}
→ SubmissionCoordinator → bundle`. Build the shared FOUNDATION once, THEN fork into strategy/edge slices.
Atomic-arb = the `block-scan × swap` cell. **The type-spine (F1) is ALREADY SHIPPED (uncommitted) by a
concurrent session — reuse it, do not rebuild.**

## ⚠️ Load-bearing correction the 3-way caught (Reviewer B won this, code-verified)
The reconciliation verdict + drafts -A/-orchestrator assumed F1 must be BUILT and the axis renamed to
`reactive`. **Reviewer B checked the code: the spine is already implemented in the working tree (uncommitted,
a concurrent session).** Verified:
- `listener/src/searcher/strategy-taxonomy.ts` (exists, built to `dist/`): `StrategyKind = "backrun" |
  "block-scan"` (`:1`); `EdgeKind = "swap"|"credit"|"lp"|"flash"` (`:2`); `strategyKindFromTxShape` bridge
  (`:5-10`, `atomic_state_arb→block-scan`); `edgeKindFromSlotKind` (`:13-16`, `lend→credit`);
  `deriveEdgeTaxonomy` (`:19-24`, `leavesStandingPosition = edgeKind==="credit"`); `pathLeavesStandingPosition`
  (`:26-30`).
- `listener/src/searcher/planner/token-graph.ts` (status `M`): `TokenEdge` already widened with
  `edgeKind: EdgeKind` + `leavesStandingPosition: boolean`, "Derived at construction via
  `deriveEdgeTaxonomy(slotKind)`, never set independently".

**Consequences (adopt Reviewer B's D1/D2/D3, all code-correct):**
- **D1 — the strategy axis is `backrun | block-scan`, NOT `reactive | block-scan`.** Reuse the shipped values
  (DRY). `backrun` is trigger-descriptive and satisfies the anti-laundering goal (safety lives on the edge, not
  the label); renaming to `reactive` is churn with zero safety benefit. The verdict's FIELD name (`strategy_kind`)
  stands; its VALUES are what shipped.
- **D2 — `VenueEdge` is the already-widened `TokenEdge`, not a new class with `quote()/build()` methods.**
  `edgeKind`/`leavesStandingPosition` are DERIVED from `slotKind` (`deriveEdgeTaxonomy`); quote/build stay
  registry-dispatched by `adapterId` (the credit adapter replaces the `quoter.ts:358` throw — NOT an edge
  method). No edge-class refactor. (Reviewer A independently reached the same on quote/build: a latency-gated
  dispatch layer, credit slice-4 OPTIONAL, never a foundation blocker.)
- **D3 — shipped C1 already ships the bridge** (`strategyKindFromTxShape`), keeping the chain-observable
  `tx-shape.shape` distinct from the derived strategy label — better than the verdict's "raw enum rename". No
  change to `tx-shape.ts` needed.

**Everything else in the reconciliation holds.** The three fusion drafts CONVERGE on the same
foundation→fork architecture; the only divergence was F1's build-state, which B resolved against code.

## The unified model (F1 — ALREADY SHIPPED; verify + finish + commit, do not rebuild)
- Strategy axis: `StrategyKind = "backrun" | "block-scan"` (`strategy-taxonomy.ts:1`). `Opportunity` union
  re-parented onto it (`detector.ts:6` already carries `kind:"backrun-arb"` — finish the union as
  `BackrunOpportunity | BlockScanOpportunity` keyed on `StrategyKind`).
- Edge: `TokenEdge` widened with `edgeKind`/`leavesStandingPosition` (`token-graph.ts`, derived via
  `deriveEdgeTaxonomy`). `VenueEdge` = this widened `TokenEdge` (type alias, if a name is wanted). `seedEdges`
  are `TokenEdge[]` all `edgeKind:"swap"`.
- Safety-on-edge: `pathLeavesStandingPosition(edges)` (`strategy-taxonomy.ts:26`) is the guard input — a
  bundle whose path has any `leavesStandingPosition` edge is the credit-live-gated shape. Wire the reject guard
  off THIS, never a strategy label (already the design).
- **Remaining F1 work:** finish the `Opportunity` union split + `LearningCase` schema (still greenfield) +
  optional `cycle-fingerprint.ts`. Gate: `searcher:planner` plan counts unchanged; `pathLeavesStandingPosition`
  true iff a credit edge present.

## Shared FOUNDATION slices (build once; F1 mostly shipped)
| slice | state | files | gate (rule-12) |
|---|---|---|---|
| **F1 types** | **~80% SHIPPED** (uncommitted concurrent) | `strategy-taxonomy.ts` (done), `token-graph.ts` (widened, `M`), `detector.ts:6` (finish union), `analysis/src/learning/learning-case.ts` (TODO) | compile + `searcher:planner` counts unchanged; `pathLeavesStandingPosition` correct |
| **F2 LearningCase-by-extension** | greenfield | MODIFY `bundle-postmortem.ts` (`winner_style`→`primary_gap`+`non_comparable_winner`), `census-report.ts`, `live-loss.ts`, `hermes-gate.ts`; C1's `tx-shape`/`sender-flow` feed it via the shipped bridge | replay postmortem fixtures → `primary_gap` (`0xa32b→venue_missing`, `0xee7b98ad→non_comparable_winner`, coffee 8 block-scan+1 backrun); idempotent double-run |
| **F3 SubmissionCoordinator** | greenfield (dir has only `bundle-router`+`inclusion-tracker`) | CREATE `execution/submission-coordinator.ts` (sync `offer()`, group by targetBlock, backrun-first/net-EV rank, loser `submission_arbitration_lost`) + the `processOpportunities` factor-out from `handleHint` | backrun+block-scan same target block → 1 submit, loser `submission_arbitration_lost`; both off → zero change |
| **F4 block-scan lane / AtomicView** | greenfield | CREATE `strategy-views.ts` (A-universe views + P1-5 `versions.*`/view hashes), `atomic-lane.ts` (own `blockScan_busy`+cache+sim, shared nonce + F3), `atomic-view-overrides.ts` (`listener/searcher/pools/…`, cwd-relative) | metrics: hint mid-scan processed, 0 new `skip hint`; backrun p95 flat |

## Strategy / edge forks (after F1–F4)
- **Block-scan swap scanner** = atomic-arb A0→A1→A2→A3→[A4 BLOCKED]: anchor scan emits `seedEdges`; planner
  branch `planFromSeedEdges` skips `buildTokenPaths` (`token-graph.ts:462`)/rotation; search center from
  `searchSeed` not `1n` (`solver.ts:449`); merged **P0-2/P0-3 fresh-read gate** (fresh-read every candidate
  cycle pool at `source_block` before quote, drop if stale/unreadable), **submit-time stale-target**,
  **per-newHead `block_scan_result`**, **runtime breaker**. A0/A1–A3-offline GO; **A4-live BLOCKED** until F4 +
  fresh-read gate green.
- **Credit edge fork** = credit slices 3/5/6/8: resolver `quote()` replaces the `quoter.ts:358` throw →
  deterministic max-safe-borrow + haircut (deletes `fluidDebtBps` search) + abandon-exit `nftId` + per-adapter
  **gas table** + **credit-live reject guard** off `pathLeavesStandingPosition`. Slice-3 (analysis, `0xf88b`
  replay) GO flag-OFF; **credit runtime BLOCKED** behind `/opt/MEV/.credit-live` + per-leg position account +
  Safety-1 human gate.
- **Backrun** = `strategy_kind:"backrun"` re-parent only, routes through F3. No behavior change.
- **D (close dispatcher)** last: consumes `LearningCase`, strategy-aware close (atomic → `atomic-view-overrides`,
  never backrun force-include); inconclusive comparable loss → `pending-manual-analysis`.

## THE now-highest-friction item (changed by the F1 discovery): concurrent-session coordination
The spine-naming decision the reconciliation called "highest friction" is **effectively resolved in code**
(`strategy-taxonomy.ts` shipped `backrun|block-scan` + edge widening). The real risk is now **two sessions
editing the same foundation files simultaneously**: `token-graph.ts` is `M` (concurrent), `detector.ts:6` +
`execution/` + `bundle-postmortem.ts` are next for BOTH. **Before any more runtime code: (1) commit/merge the
concurrent F1 work (strategy-taxonomy.ts + token-graph widening) so it is the shared base; (2) assign a SINGLE
owner to each remaining foundation slice (F1-finish, F2, F3, F4); (3) build on the shipped `backrun|block-scan`
+ `deriveEdgeTaxonomy`, do NOT re-introduce `reactive` or a new edge class.**

## Ordered plan (corrected)
1. **Commit/merge the shipped F1** (strategy-taxonomy.ts + token-graph widening) as the shared base; finish the
   `Opportunity` union split + `LearningCase` schema. [was "decide the spine" — now "adopt+finish the shipped spine"]
2. **F2** LearningCase-by-extension (single owner; the real 3×-drift risk; cheapest high-value; pure/off-hot).
3. **F3** SubmissionCoordinator + `processOpportunities` factor-out.
4. **F4** block-scan lane + AtomicView/views.
5. Fork: block-scan A0–A3 (GO) ∥ credit slice-3 (GO, flag OFF) ∥ backrun re-parent; then A4-live / credit-runtime
   only after their human/isolation gates.

## Acceptance matrix
(Per the table above for F1–F4; forks:) block-scan A0–A3 → `searcher:planner`/`searcher:replay-live-fixtures`
flips (`candidate_plans 0→>0`, center `>8` from `searchSeed`, `sim.success+netEV>0+standalone`); A4 → metrics
(`block_scan_result` per newHead, `state_block===source_block`, backrun `expired` flat); credit slice-3 →
`0xf88b` `candidate_plans 0→1` + quote ≈ 273 wstUSR + abandonExit rejected w/o marker; C1 bridge → coffee
8 block-scan + 1 backrun via `strategyKindFromTxShape` (no tx-shape code change).

## Provenance
3-way blind (rule 9 / Rounds step-4): two fresh fable authors (-A/-B) + orchestrator (-orchestrator),
mutually blind. CONVERGENCE on the foundation→fork architecture; the ONE divergence — F1's build-state and the
`reactive` vs `backrun` value + the `VenueEdge`-as-class question — was resolved AGAINST the reconciliation
verdict by Reviewer B, code-verified here (`strategy-taxonomy.ts`, `token-graph.ts`). Reviewer A contributed the
`edgeKind`≠`slotKind` axis distinction + the quote/build-is-latency-gated refinement (both confirmed by
`edgeKindFromSlotKind`). This synthesis adopts the shipped spine as the base and flags concurrent-session
coordination as the operative risk.
