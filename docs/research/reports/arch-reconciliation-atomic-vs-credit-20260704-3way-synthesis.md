# Architecture reconciliation — atomic-arb EPIC vs credit-venue edge (3-way blind synthesis, 2026-07-04)

> Scope: authorized, defensive on-chain arbitrage research; mainnet fork + dry-run; broadcast is a
> human-gated step. Read-only architecture review — no code changed. CANONICAL synthesis of a 3-way
> mutually-blind review (rule 9 / Rounds step-4):
> - Reviewer A (fresh fable): [arch-reconciliation-atomic-vs-credit-20260704-A.md](arch-reconciliation-atomic-vs-credit-20260704-A.md)
> - Reviewer B (fresh fable): [arch-reconciliation-atomic-vs-credit-20260704-B.md](arch-reconciliation-atomic-vs-credit-20260704-B.md)
> - Orchestrator (this session): own code+doc read, folded in below.
> A 4th INDEPENDENT review from a concurrent session (`arch-reconciliation-atomic-vs-credit-20260704.md`,
> left untouched) reached the SAME verdict — so this is effectively a 4-way convergence with zero material
> disagreement. The convergence is the confidence signal.

## VERDICT (4/4 convergence)
The atomic-arb EPIC (docs 1/2/3) and the credit-venue edge (doc 4 + ADRs) are **~85% composable, not
competing.** Every reviewer independently concluded: **adopt the credit workstream's `strategy_kind ×
edge_kind` spine as the shared foundation, and absorb the atomic-arb EPIC as the `strategy_kind: block-scan
× edgeKind: swap` cell** — a naming + type re-parent, NOT a redesign. Its whole engineering body (scanner,
seedEdges planner binding, A-lane isolation, fresh-read gate, telemetry nails, coordinator mechanics)
survives intact. The shipped C1 chain (`0fb1566`/`975ebc2`/`cbbdf1f`) needs **re-labeling only, no rework**.
But the two workstreams were authored blind to each other and independently CREATE the same three components;
**if either writes more runtime code before the spine is chosen, they collide irreversibly** in `main.ts` /
`execution/` / `analysis/learning/` / `bundle-postmortem.ts` / `census-report.ts`.

## The safety claim — DOWNGRADED to naming-hygiene + latent hazard (independently code-confirmed by all)
The credit ADR argues `kind:"atomic-arb"` lets a standing-position credit play launder as principal-safe
"through a name the EV gate/posture guards trust." Every reviewer verified in code that **nothing reads a
strategy label named "atomic" as a principal-safety signal today:**
| reviewer | anchor: the real guard keys on structure/number, not a label |
|---|---|
| Orchestrator | `assert-balance` is an opcode **adapter** (`adapters/assert-balance.ts`, `ASSERT_BALANCE_GTE`) keyed on a balance threshold — the flash token, per the credit doc's own invariant #3 |
| Reviewer A | grep `strategy_kind\|leavesStandingPosition\|abandonExit` over `listener/src`+`analysis/src` = **0 hits**; bounded-live gate keys only on `SEARCHER_EV_GATE=1`+wallet-cap+`DRY_RUN=0` (`deploy-node.sh:88-116`); "atomic" there is a comment |
| Reviewer B | EV gate keys on `netEth` numbers (`main.ts:1793-1823`); flash-repay guard on the `"assert-balance"` adapter id (`main.ts:2069`); the descriptive `strategyType:"atomic/standing"` is a competitor-clustering output (`cluster/strategy.ts:25`), never a runtime gate |
| Concurrent 4th | EV gate `main.ts:1793-1826` reads `netEth` only → re-label/map, no rework |

**Conclusion:** naming-hygiene today; a **latent** hazard that becomes live only when (a) a credit edge with
`leavesStandingPosition:true` is added AND (b) a guard is keyed on the strategy label. The credit landing-plan
already wires the REAL guard off the EDGE flag (invariant #3), not a label — correct by construction. So:
**rename `kind:"atomic-arb"` → `strategy_kind:"block-scan"` as the unification lever + future-proofing — cheap
now (spec-only; C1 does not yet use `kind`), painful after A-contract threads the union through ~6 files — not
because it is exploitable today.**

## Redundancy / friction — converged table
| axis | relationship | collision (file:line) | reconciliation (agreed) |
|---|---|---|---|
| **Strategy taxonomy** | **CONFLICT → COMPOSE** | `detector/detector.ts:6` (`kind:"backrun-arb"`, spec adds `"atomic-arb"`) + events §1.3 + coordinator §1.4 vs credit `strategy_kind:reactive\|block-scan` + edge `leavesStandingPosition` | **credit spine wins.** `backrun-arb→reactive`, `atomic-arb→block-scan`; principal-safety becomes an EDGE flag. Rename before A-contract. |
| **Edge model** | **COMPOSE (clean subset)** | `token-graph.ts:15/:20` `TokenEdge` already has `slotKind:"flash"\|"lend"\|"swap"` (the wired Fluid vault is already a `slotKind:"lend"` edge); atomic `seedEdges:TokenEdge[]` vs credit `VenueEdge{edgeKind}` widening `TokenEdge` | `VenueEdge` = strict SUPERSET; `seedEdges → VenueEdge[]` all-`edgeKind:"swap"`. **Decisive: the no-DFS `planAtomicFromSeedEdges` is a planner branch on the strategy discriminator, orthogonal to edge type** → atomic-arb is a genuine subset. Widen the type ONCE (credit slice 1) before A-contract pins seedEdges. |
| **SubmissionCoordinator** | **DUPLICATE** (greenfield both) | `execution/submission-coordinator.ts` CREATE (§1.4) vs credit slice 7. Dir today: only `bundle-router.ts`+`inclusion-tracker.ts` | Build ONCE; keep atomic-arb §1.4 (concrete sync `offer()` matrix); generalize `strategy`→`strategy_kind`. |
| **Block-scan lane / AtomicView vs A-lane** | **DUPLICATE + 1 CONFLICT (wallet)** | atomic `A-lane` (own `atomic_busy`/cache/sim, shared nonce) vs credit slice 7 (separate fork/sim + **separate EOA/nonce** + process + RPC) | ONE lane (adopt credit's name `AtomicView`). **Wallet conflict resolved (Reviewer A):** swap-atomic is principal-safe → **shared signing nonce + coordinator is correct**; credit's "separate EOA" is really a per-credit-leg position account (`nftId`/sub-account) ORTHOGONAL to the signing EOA → drop separate-EOA from the base lane, add it only on the credit path at credit-live. |
| **LearningCase** | **DUPLICATE-build, CONVERGENT-design** | `analysis/src/learning/learning-case.ts` CREATE (§1.5, dir absent) vs credit slice 2 EXTEND `bundle-postmortem`/census; ADR warns a parallel path = 3×-analyzer drift | **credit PROCESS wins (extend, don't fork)** + atomic-arb §1.5 schema (already strategy-agnostic `strategy:"backrun"\|"atomic"`). Build the schema ONCE; refactor `bundle-postmortem.ts`+`census-report.ts` onto it TOGETHER (credit slice 2 == atomic-arb C2/D). |
| **Analysis extensions** | **DUPLICATE** | both edit `bundle-postmortem.ts`/`census-report.ts`/`live-loss.ts`/`hermes-gate.ts` | ONE owner, ONE PR: shipped C1 → then the shared LearningCase/primaryGap refactor. Never open `bundle-postmortem.ts` twice in parallel. |
| **primaryGap taxonomy** | **CONFLICT → COMPOSE via mapping** | atomic `atomic_*` classes (§C2) vs credit funnel-ordered strategy-agnostic set incl. `non_comparable_winner` + `standing_position_required` (ADR:145-150) | credit converged set wins. Atomic classes map on; keep atomic distinctions as `secondaryGaps[]`, not a parallel enum. |
| **Shipped C1** | **COMPOSE (2 as-is, 1 re-label)** | `sender-flow.ts`/`victim-source.ts`/`swap-log-registry.ts` generic; `tx-shape.ts:20,42` enum | first three reused UNCHANGED; **`tx-shape` re-labels output to `strategy_kind`** (`atomic_state_arb→block-scan`, `backrun→reactive`) — it literally computes `strategy_kind` from chain data; logic untouched, NO rework. |

## The single highest-friction collision (unanimous)
**The strategy-axis name + the edge type, decided together, ONCE.** Both workstreams modify `detector.ts:6`
(the `Opportunity` union) and the edge model from two vocabularies. A-contract (atomic-arb's next runtime
slice) hard-codes `kind:"atomic-arb"` into the union + every event + the coordinator, threaded through the
~640-line `processOpportunities` factor-out of `handleHint`. Ship it first and the credit spine forks or
forces a painful rename back through the whole hot path — and re-creates the latent laundering trap. **This is
a ~1-page ADR decision, not code, but it gates everything.**

## Minimal shared foundation both should build ONCE (before any lane/scanner/credit-adapter runtime)
1. **One edge type** — `VenueEdge{edgeKind, leavesStandingPosition, …}` widening `TokenEdge` (`token-graph.ts:15`); `seedEdges: VenueEdge[]`.
2. **One strategy axis** — `strategy_kind: reactive|block-scan` on the `Opportunity` union (`detector.ts:6`).
3. **One LearningCase** — strategy-agnostic schema at `analysis/src/learning/learning-case.ts` (born with `strategy` + the converged `primary_gap`), `bundle-postmortem.ts` + `census-report.ts` refactored onto it TOGETHER.
4. **One SubmissionCoordinator** — atomic-arb §1.4 spec.
Everything else (block-scan lane, atomic scanner, fresh-read gate, credit adapter) plugs into this without touching the others.

## Resolve-before-more-runtime-code list (ordered)
1. **Decide the spine** — a ~1-page ADR merging `unified-strategy-edge-architecture` + the atomic-arb `Opportunity` union: `strategy_kind: reactive|block-scan` + `VenueEdge{edgeKind}` + edge-level `leavesStandingPosition`; forbid a strategy label named "atomic". **[highest friction — blocks A-contract AND credit slice 1]**
2. **Rename the atomic-arb impl spec** off `kind:"atomic-arb"` onto `strategy_kind:"block-scan"` + `seedEdges: VenueEdge[]` (spec edit only; no code yet).
3. **One owner** for `analysis/src/learning/learning-case.ts` + the `bundle-postmortem`/`census` refactor (credit slice 2 == atomic-arb C2/D). Do NOT let both create it.
4. **One owner** for `execution/submission-coordinator.ts` (atomic-arb §1.4) and ONE for the block-scan lane/`AtomicView` (atomic-arb A-lane/A-universe == credit slice 7); second funded EOA deferred to the credit path + its own Safety-1 gate.
5. **Re-label shipped `tx-shape.ts`** output enum to `strategy_kind` (mechanical; keep `sender-flow`/registry/victim-source as-is).
6. Only then fork into the block-scan runtime slices (atomic-arb A1–A4) and credit-adapter slices (credit 3/5/6/8), which no longer collide.

## Provenance
3-way blind review (rule 9 / Rounds step-4): two fresh fable reviewers produced `-A`/`-B` independently and
blind to each other and to the orchestrator's hypothesis; the orchestrator produced its own code-grounded
read; this doc is the comparison. A 4th independent review from a concurrent session corroborated. Zero
material disagreement across all four — convergence on every axis, with Reviewer A contributing the
wallet-isolation reconciliation and Reviewer B the `slotKind:"lend"`-already-exists grounding. The shipped C1
chain is confirmed correct by all.
