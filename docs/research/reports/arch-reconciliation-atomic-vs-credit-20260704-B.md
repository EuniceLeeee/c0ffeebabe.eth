# Architecture reconciliation — atomic-arb EPIC vs credit-venue edge (Reviewer B, 2026-07-04)

> Scope: authorized, defensive on-chain arbitrage research; mainnet fork + dry-run; broadcast is a
> human-gated step. Read-only architecture review — no code edits, no chain calls. Reviewer B of three
> independent, mutually-blind reviewers. Every claim grounded in `file:line` from the working tree.

## VERDICT

**The two workstreams are ~85% COMPOSABLE, not competing — the credit workstream's `strategy_kind × edge_kind`
spine is the correct model, and the atomic-arb EPIC is a clean subset of it (`strategy_kind: block-scan ×
edgeKind: swap`), NOT a rival architecture.** But they were authored blind to each other (the atomic-arb impl
spec contains ZERO references to `strategy_kind` / `VenueEdge` / `edgeKind` / `credit` / `reactive` /
`block-scan` — verified by grep of `coffee-20260704-atomic-epic-impl-plan.md`), so they independently create
the SAME three components (`execution/submission-coordinator.ts`, `analysis/src/learning/learning-case.ts`,
the atomic/block-scan lane) and use two vocabularies for one strategy axis. If implemented separately they WILL
collide in `main.ts`, `execution/`, `analysis/learning/`, `bundle-postmortem.ts`, and `census-report.ts`.

**The credit ADR's SAFETY argument, verified against code, is OVER-STATED: it is naming-hygiene + a latent
future hazard, NOT a live safety bug.** No guard, EV gate, or posture check in the searcher reads a strategy
label named "atomic" as a principal-safety signal (grep of the entire searcher: the only runtime "atomic" is
`writeJsonAtomic` file-I/O and the `winner_style: atomic_loop` analysis label; the EV gate keys on numbers, the
flash-repay guard keys on an adapter id). The rename to `strategy_kind: block-scan` is still the right call —
but as the unification lever + future-proofing, not because `kind: "atomic-arb"` is exploitable today.

Shipped C1 (`sender-flow` / `swap-log-registry` / `tx-shape`) needs **re-labeling only, no rework** — the logic
is generic and correct; only `tx-shape`'s output enum (`"atomic_state_arb" | "backrun"`) is a soon-to-be-renamed
island (it literally computes `strategy_kind` from chain data).

**Single highest-friction collision to resolve before EITHER writes more runtime code:** the **strategy axis
name + the edge type** — both workstreams touch `detector.ts:6` (`Opportunity` union) and the edge model, and one
uses `kind: backrun-arb|atomic-arb` + `seedEdges: TokenEdge[]` while the other uses `strategy_kind: reactive|block-scan`
+ `VenueEdge{edgeKind}` widening `TokenEdge`. These are the same two abstractions under two names; pick one spine
FIRST or every downstream slice forks.

---

## Task 1 — atomic-arb EPIC review (docs 1/2/3)

### (a) As SPECIFIED — SOUND, unusually rigorous.
The architecture is correct and the verification discipline is real, not decorative:
- The `Opportunity` discriminated union (`impl-plan §1.1`) is well-founded: `detector/detector.ts:6` already
  carries `kind: "backrun-arb"`, so the union is a type-only widening, not a rewrite.
- The three genuinely-missing pieces are correctly identified and code-verified (`architecture-plan.md:137-152`):
  (1) a block-triggered opportunity source; (2) the **sizing-seed blocker** — `resolveSearchCenter`
  (`solver/solver.ts:449`) returns `1n` for `victimAmount<=0n`, and `geometricGrid(1n,halfWidth=3)` degenerates
  to `[1,2,4,8]` wei with GSS only firing on an already-positive quote (`solver.ts:196`) — this is a real landing
  blocker most designs would miss; (3) the no-source-swap entry point (`handleHint` is source-swap-parse all the
  way down, `main.ts:965`+).
- The A-contract `processOpportunities` factor-out (`impl-plan §A-contract`) correctly names the biggest risk (a
  ~640-line mechanical move out of `handleHint`) and scopes it as byte-equivalent-replay-gated.
- The seven "nails" + the owner's P0-1..P1-5 blockers are each verified against a live anchor (`impl-plan §0.1`
  re-calibrates every line number at `026d132`). P0-2 (swap logs are TRIGGER-only; fresh-read every candidate
  pool at `source_block` before quote/sim, because non-swap events and eventless transfers also mutate quote
  state) is a genuinely subtle correctness catch, and the revised P0-2 supersedes the unsound R4 "untouched ⇒
  block-invariant" rule correctly.
- P0-1 lane isolation (own `atomic_busy` + own cache + own sim instance; the hint loop `main.ts:858` DROPS on
  busy, so a shared-`busy` atomic scan would silently drop backrun victims) is the right concurrency model and
  the honesty line ("a same-process idle-only atomic is a learning tool, not a competitive searcher") is accurate.

**Real defects / weaknesses (as specified):**
1. **No cross-reference to the credit workstream at all.** The spec builds `execution/submission-coordinator.ts`
   (§1.4), `analysis/src/learning/learning-case.ts` (§1.5), and the atomic/block-scan lane (`A-lane`) as if the
   credit ADR — which defers these exact components as its slice 7 — does not exist. This is the Task-3 friction.
2. **The `kind: "atomic-arb"` axis name.** Not a code-safety bug (Task 2), but it hard-codes the word "atomic" as
   a STRATEGY label across `detector.ts`, `events.ts`, `planner.ts`, `solver.ts`, `main.ts` and the whole
   `LearningCase`/telemetry surface — precisely the overload the credit ADR spends its safety section warning
   against. Every one of those symbols would have to change under the unified model. Cheaper to rename now (spec
   only; C1 not yet using `kind`) than after A-contract lands the union across ~6 files.
3. **The Node event-loop honesty (`A-lane` rule 3) is correct but under-gated.** "Bounded pure chunks with
   cooperative yields" is asserted in a synthetic unit gate (`searcher:atomic-lane`), but the real proof is the
   A4 live `prep_ms p95` regression guard — the doc says this, yet the chunk-size that keeps p95 flat is left as a
   runtime tuning unknown. Acceptable for an OFF-by-default flag, flagged as a live-window risk, not a blocker.

### (b) As SHIPPED — the C1 classifier chain is clean and correct.
- `sender-flow.ts` (`0fb1566`): the two-axis split is real and fixes a real bug. `submission_method` and
  `source_visibility` are independent; `sourceVisibilityFor` (`sender-flow.ts:55-59`) is evaluated and returned
  BEFORE `submissionMethodFor` reads the fee heuristics, so a tx seen in our public feed can never be overridden
  to "private" by a zero tip. This directly kills the coffee correction-#1 bug (`maxPrio=0` ≠ private orderflow).
  Note: the enum no longer even HAS a `"private"` value — the classifier cannot emit the mislabel. Generic and
  strategy-model-agnostic; reusable as-is under either workstream. Also satisfies rule-16's `sender_flow` codify.
- `swap-log-registry.ts` (`975ebc2`): one `decodeAnySwapLog` (`:32-41`) over UniV2/V3/V4 + Curve
  `TokenExchange`(+`_underlying`) + Balancer V2. This is the exact fix for finding #6 (a Curve/Balancer source
  swap would otherwise be invisible → a backrun mislabeled atomic). The multi-token direction caveat is honestly
  documented (`:116-122`). Shared infra both workstreams need; no conflict.
- `tx-shape.ts` (`cbbdf1f`): `classifyTxShape` (`:26-47`) — strict `<` on tx index (`:37`) correctly excludes the
  arb tx's own logs; 0 preceding swaps on a shared pool ⇒ `atomic_state_arb`, ≥1 ⇒ `backrun`. Logic is sound.

**Does `tx-shape`'s `atomic_state_arb`/`backrun` map cleanly onto a unified taxonomy, or is it a soon-to-be-renamed
island?** It is a **soon-to-be-renamed island — logic sound, enum names collide.** `classifyTxShape` literally
computes the reactive-vs-block-scan distinction: "was there a preceding swap to follow" IS "reactive (backrun)"
vs "no source to follow → captured from standing block state" IS "block-scan". So `tx-shape` is the analysis-side
producer of `strategy_kind`. Under the credit model its output enum becomes `reactive | block-scan | unknown`
(or it keeps a shape-specific label but MUST map 1:1 onto `strategy_kind`). The detection is model-agnostic; only
the two string literals `"atomic_state_arb"` / `"backrun"` (`tx-shape.ts:20,42`) are the rename surface. No rework.

---

## Task 2 — new opinion in light of doc 4 (the credit safety argument)

**Does doc 4 change my assessment of docs 1/2/3? Yes on model/naming, NO on a live-safety verdict.**

### The credit ADR's safety claim, verified in CODE.
The ADR (`unified-strategy-edge-architecture-20260704.md:19-30`) argues: "labeling a path 'atomic' lets a
standing-position credit play launder as principal-safe through a name the EV gate/posture guards trust." I
grepped the entire searcher for any guard that reads a strategy label named "atomic":

| guard | what it actually keys on | file:line |
|---|---|---|
| EV gate | `netEth = profit − gas − bribe` vs `minNetEth` — pure numbers | `main.ts:1793-1823` (`evGate:415`, `minNetEth:416`) |
| flash-repay / assert-balance guard | the **adapter id** `"assert-balance"` present in the plan's action nodes | `main.ts:2069`; template `FLASH_LEND_SWAP_REPAY`/`FLASH_SWAP_REPAY` `main.ts:53` |
| bounded-live posture gate | `.deploy-live` marker + `SEARCHER_DRY_RUN=1` + wallet ≤ `MEV_LIVE_MAX_WALLET_ETH` + `SEARCHER_EV_GATE=1` | `scripts/deploy-node.sh:13-16,33-104` |
| only runtime "atomic" in the searcher | `writeJsonAtomic` (file I/O) + `winner_style:"atomic_loop"` (analysis label in `auto-close-route-gap.ts:104`) | grep `listener/src/searcher`, tests excluded |

**Nothing reads a strategy label named "atomic" as a principal-safety signal.** Principal safety today rests on
two things, neither of which is a label: (1) the flash-loan STRUCTURE — a bad arb reverts at the assert-balance
node (`main.ts:2069`, the `FLASH_*_REPAY` templates), a property of the plan's action graph; (2) the bounded-live
ENVELOPE — markers + wallet cap + numeric EV gate. The `strategyType` field that DOES take the value
`"atomic/standing"` lives on the analysis side (`analysis/src/actions/canonicalize.ts` → `cli/address.ts:107`,
`cluster/strategy.ts:25`) and is a descriptive competitor-clustering output, never a runtime gate.

### Therefore:
- **Is `kind: "atomic-arb"` a real safety PROBLEM under the credit model? Not today — DOWNGRADE from safety to
  naming-hygiene + latent hazard.** The atomic-arb EPIC introduces NO standing-position edge (it is pure swap-loop
  block-scan; `AtomicOpportunity.seedEdges` are all `slotKind:"swap"`), so there is nothing to launder and no
  guard that would be fooled. The credit ADR's scenario only becomes live IF (a) a credit edge with
  `leavesStandingPosition:true` is added AND (b) someone writes a guard keyed on the strategy label. The credit
  landing plan's own invariant #3 (`credit-venue-landing-plan-20260704.md:23-26`) already wires the REAL guard off
  the EDGE's `leavesStandingPosition`/`abandonExit` flag, not a label — which is the correct fix and makes the
  label irrelevant to safety by construction.
- **Must `kind: "atomic-arb"` become `strategy_kind: block-scan`? YES — but for unification + future-proofing, not
  as a bug-fix.** Two reasons stand independent of the (downgraded) safety claim: (1) it is the single shared axis
  both workstreams must agree on, and `reactive|block-scan` is strictly better-factored because it does not
  overload "atomic" (which the codebase already uses for atomicity/`atomic_loop`); (2) it removes the trap BEFORE
  a credit edge + any label-keyed guard can ever be introduced — cheap now (spec-only), expensive after the union
  is threaded through `detector.ts`/`events.ts`/`planner.ts`/`solver.ts`/`main.ts`/`LearningCase`.

Net: doc 4 does not invalidate docs 1/2/3 — it RE-FRAMES the atomic-arb EPIC as the `block-scan × swap` cell of a
larger `strategy_kind × edge_kind` grid, and the ONE mandated change is the axis rename (+ the C1 enum re-label),
which is mechanical.

---

## Task 3 — ARCHITECTURE REDUNDANCY & FRICTION CHECK

### Redundancy / friction table

| axis | duplicate / conflict / compose | collision file:line | reconciliation |
|---|---|---|---|
| **Strategy taxonomy** | CONFLICT (naming) → resolves to COMPOSE | `detector/detector.ts:6` (`kind:"backrun-arb"`, spec adds `"atomic-arb"`) vs ADR `strategy_kind: reactive\|block-scan` (`unified…:25`) | Adopt `strategy_kind: reactive\|block-scan`; map `backrun-arb→reactive`, `atomic-arb→block-scan`. Rename once, before A-contract threads the union across ~6 files. |
| **SubmissionCoordinator** | DUPLICATE (same component, same path, both CREATE) | atomic-arb `impl §1.4` CREATE `execution/submission-coordinator.ts`; credit slice 7 "its OWN SubmissionCoordinator" (`landing-plan:43`). Dir today: only `execution/bundle-router.ts` + `inclusion-tracker.ts` — neither exists yet | Build ONCE. The atomic-arb §1.4 spec is the concrete one (sync `offer()`, per-`targetBlock` slot, matrix). Credit consumes it unchanged — a `block-scan+credit` candidate is just another `SubmissionCandidate{strategy}`. |
| **Block-scan lane / AtomicView vs A-lane** | DUPLICATE (same isolation infra, two specs) | atomic-arb `A-lane` (`atomic-lane.ts`: own `atomic_busy`/cache/sim) vs credit slice 7 (`AtomicView` + "separate fork/sim + EOA/nonce + process + RPC fairness", `landing-plan:43`) | ONE lane. The atomic-arb `A-lane` is the buildable spec of credit's deferred slice 7. Credit's `AtomicView` = the atomic-arb `A-universe` atomic selection view; unify the names (`AtomicView`). |
| **LearningCase** | DUPLICATE-build, CONVERGENT-design | atomic-arb `impl §1.5` CREATE `analysis/src/learning/learning-case.ts` (dir does NOT exist yet); credit slice 2 "EXTEND bundle-postmortem/census, one learning system" (`landing-plan:38`). Credit ADR warns a parallel path recreates the 3×-analyzer drift (`unified…:68-70`) | **Credit's framing wins the PROCESS** (extend, don't fork), but the atomic-arb §1.5 `LearningCase` schema is the concrete one and already says the SAME thing (bundle-postmortem + census both OUTPUT `LearningCase`). Build the schema once at `analysis/src/learning/learning-case.ts`; refactor `bundle-postmortem.ts` + `census-report.ts` onto it in ONE slice (credit slice 2 == atomic-arb C2/D LearningCase work). |
| **Analysis extensions** | DUPLICATE (both edit the same analyzers) | both touch `bundle-postmortem.ts`, `census-report.ts`, `live-loss.ts`, `hermes-gate.ts`. atomic-arb C1 adds `atomic_scan_shape` to `census-report.ts`+`bundle-postmortem.ts`; credit slice 2 maps `winner_style→primaryGap` in the same files | Single owner for the analysis-extension slice. Sequence: C1 (shape classifier, already shipped) → the shared `LearningCase`/`primaryGap` refactor (credit slice 2 + atomic-arb C2) as ONE PR, not two touching `bundle-postmortem.ts` in parallel. |
| **Edge model** | COMPOSE (decisive — clean subset) | `planner/token-graph.ts:15` `TokenEdge` already has `slotKind:"flash"\|"lend"\|"swap"`; atomic-arb `seedEdges: TokenEdge[]` (`impl §1.1`) uses it directly; credit slice 1 WIDENS `TokenEdge` → `VenueEdge{edgeKind}` (`landing-plan:37`, "widen, don't replace") | `VenueEdge` is a superset of `TokenEdge`. atomic-arb's `seedEdges: TokenEdge[]` becomes `VenueEdge[]` (all `edgeKind:"swap"`, `leavesStandingPosition:false`) with zero semantic change. Widen the type ONCE (credit slice 1) before atomic-arb A-contract pins `seedEdges`. |
| **seedEdges no-DFS semantics under VenueEdge** | COMPOSE (VenueEdge expresses it trivially) | atomic-arb A1 planner binding: `plan()` branches on `opp.kind`, builds path DIRECTLY from `seedEdges`, skips `buildTokenPaths` (`token-graph.ts:462`)/`focusPathsOnImpact`/rotations (`impl §A1`) | The no-DFS constraint is a PLANNER dispatch on `opp.kind`, orthogonal to the edge TYPE. `VenueEdge[]` holds a concrete ordered cycle exactly as `TokenEdge[]` does. Atomic-arb is a clean `block-scan × swap` subset; no edge-model change needed to support it. |
| **primaryGap taxonomy** | CONFLICT (two vocabularies) → COMPOSE via mapping | atomic-arb atomic classes `atomic_view_missing_venue`/`atomic_scan_not_triggered`/`atomic_cycle_not_found`/… (`impl §C2`, `architecture-plan §Gap C`) vs credit converged funnel-ordered set `source_not_seen\|view_missing\|venue_missing\|path_not_found\|…\|non_comparable_winner\|standing_position_required` (`unified…:145-150`) | Adopt the credit CONVERGED set as the spine (funnel-ordered, strategy-agnostic, includes `non_comparable_winner` + `standing_position_required`). Atomic's classes are the `block-scan` specialization: `atomic_view_missing_venue`→`view_missing`, `atomic_cycle_not_found`→`path_not_found`, `atomic_scan_not_triggered`→`source_not_seen`/a new `scan_not_triggered`, etc. Keep atomic sub-labels as `secondaryGaps[]`, not a parallel enum. |
| **Shipped C1 placement** | COMPOSE (2 reusable as-is, 1 re-label) | `sender-flow.ts` (two-axis), `swap-log-registry.ts` (v2/v3/v4/curve/balancer), `victim-source.ts` — all generic; `tx-shape.ts:20,42` enum `"atomic_state_arb"\|"backrun"` | `sender-flow` + `swap-log-registry` + `victim-source` = shared infra, reusable under either model with ZERO change. `tx-shape` = re-label its output enum to align with `strategy_kind` (`backrun→reactive`, `atomic_state_arb→block-scan`); logic untouched. No conflict with credit slice 2. |

### Notes per the decisive axes
- **Edge model is the reason the two workstreams COMPOSE rather than compete.** `TokenEdge.slotKind` already
  distinguishes `flash`/`lend`/`swap` (`token-graph.ts:20`), and the one wired Fluid vault is already a
  `slotKind:"lend"` edge (credit ADR `credit-venue-edge-20260704.md:10-13`). So the credit workstream is
  "name + generalize what we have", and the atomic-arb workstream lives entirely in the `slotKind:"swap"` slice
  of the same graph. `VenueEdge{edgeKind}` widening `TokenEdge` subsumes both cleanly.
- **The LearningCase is the one place a genuine 3×-analyzer DRIFT risk exists** (rule 16). Both specs independently
  create `analysis/src/learning/learning-case.ts` (which does not exist yet). If atomic-arb ships its `LearningCase`
  first as an atomic-only object and credit later "extends" it, you get exactly the parallel-path drift the credit
  ADR names (`unified…:68-70`). The schema must be born strategy-agnostic (it already is in atomic-arb §1.5:
  `strategy: "backrun"|"atomic"`), built once, with bundle-postmortem + census refactored onto it together.

---

## Task 4 — recommendation (unified path)

### Which model wins per axis
| axis | winner | why |
|---|---|---|
| strategy axis name | **credit** (`strategy_kind: reactive\|block-scan`) | does not overload "atomic"; the shared spine |
| edge type | **credit** (`VenueEdge{edgeKind}` widening `TokenEdge`) | superset; atomic-arb's `seedEdges` is a `VenueEdge[]` subset |
| SubmissionCoordinator | **atomic-arb §1.4** (the concrete buildable spec) | sync `offer()`, per-slot matrix, coordinator-only preempt reason — credit only names it |
| block-scan lane / AtomicView | **atomic-arb A-lane/A-universe** (buildable) = credit's deferred slice 7 | atomic-arb is the concrete build-out; adopt credit's name `AtomicView` |
| LearningCase / analysis extension | **credit PROCESS** (extend, one loop) + **atomic-arb SCHEMA** (§1.5) | born strategy-agnostic, built once, postmortem+census refactored together |
| primaryGap taxonomy | **credit converged set** (funnel-ordered, strategy-agnostic) | atomic classes become `block-scan` specializations / `secondaryGaps[]` |
| C1 shipped code | **keep as-is** (sender-flow/registry/victim-source) + **re-label** tx-shape enum | logic is model-agnostic and correct |

### Should atomic-arb be absorbed under the credit `strategy_kind × edge_kind` spine? YES.
The atomic-arb EPIC is exactly the **`strategy_kind: block-scan × edgeKind: swap`** cell. Absorbing it:
- renames `kind: "backrun-arb"|"atomic-arb"` → `strategy_kind: "reactive"|"block-scan"` on the `Opportunity` union
  (`detector.ts:6`) and everywhere the union threads;
- types `seedEdges` as `VenueEdge[]` (all `edgeKind:"swap"`) instead of a bare `TokenEdge[]`;
- routes its `LearningCase`/`primaryGap` through the credit converged taxonomy;
- keeps EVERY runtime slice (scanner, lane, coordinator, fresh-read gate, breaker) unchanged in behavior — the
  absorption is a naming + type re-parent, not a redesign. The atomic-arb EPIC is what actually BUILDS credit's
  deferred slice 7 (minus the credit edge itself).

### Exactly what the atomic-arb impl spec must change to align (in order)
1. **Rename the strategy axis FIRST** (the "atomic" naming fix): `kind: "atomic-arb"` → `strategy_kind:
   "block-scan"`; `"backrun-arb"` → `"reactive"`, across `impl §1.1` (`detector.ts`), `§1.3` (`events.ts`
   `opportunity_kind`, `strategy_view_used`), `§1.4` (`SubmissionCandidate.strategy`), `§1.5` (`LearningCase.strategy`).
   Reserve "atomic" for the edge/execution invariant per the credit ADR. Cheap now (C1 does not yet use `kind`).
2. **Adopt `VenueEdge` as the edge type** (credit slice 1): `AtomicOpportunity.seedEdges: VenueEdge[]` with every
   edge `edgeKind:"swap"`, `leavesStandingPosition:false`. No planner-semantics change (A1's `seedEdges`-bound,
   no-DFS dispatch is edge-type-agnostic).
3. **Route `LearningCase`/`primaryGap` through the credit converged taxonomy** — keep the atomic sub-classes as
   `secondaryGaps[]`, not a parallel enum.
4. **Re-label `tx-shape.ts` output** to align with `strategy_kind`.

### Does the SHIPPED C1 need rework or only re-labeling?
**Only re-labeling, and only `tx-shape`.** `sender-flow.ts`, `swap-log-registry.ts`, `victim-source.ts` are
generic and reusable under either model untouched. `tx-shape.ts`'s enum (`:20,42`) re-labels to `strategy_kind`;
its detection logic is correct and model-agnostic. No rework.

### The SINGLE highest-friction collision to resolve BEFORE either writes more runtime code
**The strategy-axis name + the edge type — decided together, once.** Both workstreams modify `detector.ts:6`
(the `Opportunity` union) and the edge model, from two vocabularies. Until one spine is chosen, every downstream
slice (A-contract's union across ~6 files, credit slice 1's `VenueEdge`, both `LearningCase`s, both taxonomies)
forks. This is a 1-page ADR decision, not code — but it gates everything.

### The minimal shared foundation both should build ONCE (before any lane/scanner/credit-adapter runtime)
A single "unified model + analysis" foundation = **credit v1 slices 1+2 == atomic-arb A-contract's type/telemetry
half + C1/LearningCase**, specifically:
1. `VenueEdge{edgeKind, leavesStandingPosition}` widening `TokenEdge` (`token-graph.ts:15`) — one type.
2. `strategy_kind: reactive|block-scan` on the `Opportunity` union (`detector.ts:6`) — one axis.
3. `analysis/src/learning/learning-case.ts` — one strategy-agnostic schema (born with `strategy` + the converged
   `primary_gap` taxonomy), with `bundle-postmortem.ts` + `census-report.ts` refactored onto it TOGETHER.
4. `execution/submission-coordinator.ts` — one coordinator (atomic-arb §1.4 spec).
Everything else (the block-scan lane, the atomic scanner, the fresh-read gate, the credit adapter) is a strategy-
or edge-specific slice that plugs into this foundation without touching the others.

### Resolve-before-more-code list (ordered)
1. **Decide the spine** (strategy axis name `reactive|block-scan` + `VenueEdge{edgeKind}` edge type) — 1-page ADR
   merging `unified-strategy-edge-architecture` + the atomic-arb `Opportunity` union. Blocks A-contract + credit
   slice 1. **[highest friction]**
2. **Rename the atomic-arb impl spec** off `kind: "atomic-arb"` onto `strategy_kind: block-scan` + `VenueEdge[]`
   seedEdges (spec edit only; no code yet).
3. **Assign ONE owner** to `analysis/src/learning/learning-case.ts` + the `bundle-postmortem.ts`/`census-report.ts`
   refactor (credit slice 2 == atomic-arb C2/D LearningCase). Do NOT let both workstreams create it.
4. **Assign ONE owner** to `execution/submission-coordinator.ts` (atomic-arb §1.4) and ONE to the block-scan lane /
   `AtomicView` (atomic-arb A-lane/A-universe == credit slice 7). Credit consumes both, does not re-create them.
5. **Re-label shipped `tx-shape.ts`** output enum to `strategy_kind` (mechanical; keep `sender-flow`/registry
   as-is).
6. Only then: build the foundation (items 1–4 of "minimal shared foundation"), THEN fork into the block-scan
   runtime slices (atomic-arb A1–A4) and the credit-adapter slices (credit 3/5/6/8), which no longer collide.
