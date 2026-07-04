# Architecture Reconciliation Review — Atomic-Arb EPIC vs Credit-Venue Edge (2026-07-04)

> Scope: authorized, defensive on-chain arbitrage research; mainnet-fork/dry-run; broadcast is a
> human-gated step. Read-only architecture review — no code edits, no chain calls, no broadcast.
> Reviewer: fresh Fable architecture pass. Coffee classification DATA trusted as-is (per prompt).
> NOT committed — left in the working tree by instruction.

## Verdict (one line)

**Both workstreams are individually sound, but they are specifying the same four components
(strategy taxonomy, SubmissionCoordinator, isolation lane, LearningCase/analysis layer) under
incompatible names and isolation models; the credit workstream's `strategy_kind × edge_kind` spine
wins the MODEL, the atomic EPIC wins nearly all the concrete ENGINEERING — absorb the atomic EPIC
as `strategy_kind: block-scan × edgeKind: swap`, and do the "atomic"→"block-scan" rename NOW,
before A-contract ships, because A-contract is the commit that would bake `atomic-arb` strings into
events/telemetry/coordinator/env/committed-files and turn a spec-level find/replace into a
live-JSONL schema migration.**

## Top-3 friction points

1. **Strategy-taxonomy naming baked by A-contract** (`detector.ts:6` union values + `events.ts`
   `opportunity_kind` + coordinator `strategy` + env/file names). Atomic spec says
   `backrun-arb|atomic-arb`; credit ADR says `reactive|block-scan` and "never overload atomic".
   Nothing runtime has shipped → the rename is cheap for exactly as long as A-contract has not
   landed. This is the single highest-friction collision (details: Task 4).
2. **Two LearningCase schemas, two philosophies** — atomic impl spec §1.5 CREATEs
   `analysis/src/learning/learning-case.ts` with `strategy: "backrun"|"atomic"` + its own 10-class
   atomic gap taxonomy; credit slice 2 EXTENDs `bundle-postmortem`/census with
   `strategyKind/edgeKinds[]/primaryGap` (its ADR explicitly warns a parallel path recreates the
   3×-analyzer drift). Must merge into ONE schema before C2-minimal or credit slice 2 writes code.
3. **Two isolation-lane architectures + two SubmissionCoordinators** — A-lane (same process, own
   `atomic_busy`/cache/sim, ONE wallet, chunked yields) vs credit slice 7 (separate fork/sim +
   separate EOA/nonce + separate process + 2nd-funded-EOA human gate). Both specs also each define
   a SubmissionCoordinator in `listener/src/searcher/execution/` (verified: neither exists — the
   dir holds only `bundle-router.ts` + `inclusion-tracker.ts`). One lane, phased; one coordinator.

---

## Reviewer method (fixed before reading; kept for auditability)

1. **Safety criterion:** any label TRUSTED by EV gate / posture guards must be derived from
   behavior/edge properties (`leavesStandingPosition` aggregated per plan), never carried by a
   strategy NAME. Verified who consumes "atomic" in code (grep, not theory).
2. **Rule-16 criterion:** analysis capability extends existing tools; a parallel new pipeline loses
   by default.
3. **Rule-13 criterion:** shared infrastructure is built once; the more general abstraction absorbs.

Priors stated up front (credit spine more general; shipped C1 re-label-only) — both **confirmed**
below with file:line, with one refinement: the credit ADR's safety claim is real but *prospective*,
not current (see Task 2).

---

## Task 1 — Atomic-arb EPIC review (as specified + as shipped)

### As specified (docs 2 + 3): sound, exceptionally well-verified — with four real defects, all reconciliation-shaped

The spec quality is the best in the repo: every anchor re-verified at a pinned commit (impl plan
§0.1 table), honest GO/BLOCKED gating (P0-1/P0-2/P0-3, P1-4/P1-5 at impl plan §0.3), the sizing-seed
blocker caught in code (`solver.ts:449` `1n` → the `[1,2,4,8]` wei dust grid, arch plan "missing
piece #2"), the `handleHint` non-entry finding (arch plan A4), the A-lane two-way `busy` hazard
(R2 → P0-1 supersession, impl plan §0.2/§0.3), and rule-12 flip gates per slice. The Opportunity
union (impl plan §1.1), coordinator decision matrix (§1.4), cycle-fingerprint canonicalization
(§1.2), and the capability-vs-live-admission split (P1-4) are all correct engineering I would not
change in substance.

Real defects, in severity order:

1. **The taxonomy is a soon-to-be-renamed island — answering the prompt's direct question: YES.**
   `kind: "backrun-arb" | "atomic-arb"` (impl plan §1.1), `SubmissionCandidate.strategy:
   "backrun" | "atomic"` (§1.4), `LearningCase.strategy: "backrun" | "atomic"` (§1.5), the whole
   `atomic_*` namespace (event `atomic_scan_result`, drop reasons `atomic_stale_target_block` /
   `atomic_preempted_by_backrun` / `atomic_state_inconsistent`, env `SEARCHER_ENABLE_ATOMIC_SCAN` +
   9 more knobs, committed file `atomic-view-overrides.json`, census field `atomic_scan_shape`)
   all encode "atomic" as a STRATEGY name. Under the credit model (Task 2) that axis must be
   `reactive | block-scan`. None of it has shipped, so this is a spec-text fix today and a
   schema-migration after A-contract.
2. **LearningCase §1.5 conflicts with credit slice 2's extend-don't-fork doctrine — two schemas
   exist in two docs.** The atomic plan does intend one loop ("bundle-postmortem and the atomic
   census both OUTPUT LearningCase", arch plan §C2), so the *intent* is aligned; but the schema
   (`strategy: backrun|atomic`, atomic-only taxonomy) and the credit schema
   (`strategyKind/edgeKinds[]/primaryGap` incl. `non_comparable_winner`,
   `standing_position_required`) are incompatible as written. Merge required (Task 3 axis 4).
3. **No edge-kind guard on the block-scan opportunity.** `AtomicOpportunity.seedEdges:
   TokenEdge[]` (impl plan §1.1) is typed against today's `TokenEdge` (`token-graph.ts:15`). The
   moment credit slice 1 widens `TokenEdge` with `edgeKind/leavesStandingPosition` and
   `ENABLE_CREDIT_EDGES_FOR_ATOMIC` turns on, a block-scan opportunity can carry a
   standing-position edge with **zero type- or plan-level guard** in the atomic spec — the spec
   predates the credit model and assumes all edges are swaps. Fix: derive
   `leavesStandingPosition = seedEdges.some(e => e.leavesStandingPosition)` on the plan and key the
   credit-live reject guard (credit invariant 3, `plan-builder.ts:113` assert-balance bounds only
   the flash token) on that derived flag. One guard then serves both strategies — exactly the
   strategy-agnostic invariant.
4. **Minor:** the planned census field name `atomic_scan_shape` (impl plan C1 table) propagates the
   overloaded word into a fourth analysis vocabulary; name it `tx_shape` (it already is the
   module name).

Also noted in passing (hygiene, not architecture): `listener/src/searcher/venues/capability.js` is
an untracked stray `.js` sitting beside `capability.ts` (git status `??`, not gitignored) — a
shadowing hazard for ESM/tsx resolution; delete or ignore it.

### As shipped (C1a `0fb1566`, C1b `975ebc2`, C1c `cbbdf1f`): sound, no rework needed

- **C1a `sender-flow.ts`** — the two-axis split is implemented exactly as specified:
  `source_visibility` is derived from `seenInOurPublicFeed` alone (`sender-flow.ts:55-59`) and
  computed BEFORE the fee heuristics; `submission_method` (`sender-flow.ts:61-75`) returns at most
  `"bundle"` from 0-tip/coinbase signals — the word "private" no longer exists in the result type
  (`sender-flow.ts:15-29`). The `:44` fee-over-visibility bug is dead. Strategy-agnostic; the
  credit workstream's intake-audit needs consume it unchanged.
- **C1b `swap-log-registry.ts`** — one `decodeAnySwapLog` for v2/v3/v4/Curve/Balancer; v4
  poolId-aware. This is shared venue-decode infrastructure BOTH workstreams need; credit slice 2's
  `EdgeSequence` extraction will need to EXTEND it with credit-event decoders (Fluid
  `LogOperate`-class events — a credit leg emits no swap log), which the registry shape supports.
- **C1c `tx-shape.ts`** — `classifyTxShape` (`tx-shape.ts:26-47`) is a clean, fixture-locked
  implementation of the followability classifier (strict `<` boundary `tx-shape.ts:37`, v4
  poolId-keyed identity via the registry — not `log.address`, so v4-heavy atomic txs aren't
  mis-scored). **Does it map cleanly onto a unified taxonomy? Yes — via a mapping, and only via a
  mapping:** `shape: "backrun" → strategy_kind: "reactive"`, `shape: "atomic_state_arb" →
  strategy_kind: "block-scan"`. The label is an OBSERVATIONAL trigger-shape fact about a competitor
  tx ("no preceding source swap on any shared pool"), not a principal-safety claim, and nothing
  guard-side consumes it (verified: no `atomic` branch anywhere in `listener/src/searcher` hot
  path; the EV gate `main.ts:1793-1826` reads `netEth` only). Verdict: **re-label/map, no rework.**
  Renaming the value string (`atomic_state_arb` → e.g. `state_arb_no_source`) is optional and cheap
  today (one module + one test, no consumers yet — census wiring was explicitly deferred to C2);
  do it opportunistically when C2 wires the consumer, mandatory only if the string would otherwise
  leak into `LearningCase.strategy_kind` unmapped.

---

## Task 2 — New opinion in light of doc 4: the "atomic" naming/safety question

**Does the credit workstream change my Task-1 assessment? Yes — in one specific, decisive place.
Is `kind: "atomic-arb"` a real safety problem? Yes, prospectively — and "prospectively" has a
date: the A-contract merge. Must it become `strategy_kind: block-scan`? Yes.**

The precise mechanics, because precision matters here:

1. **Today the laundering channel does not exist.** No searcher guard consumes any "atomic" label:
   the EV gate is strategy-blind (`main.ts:1793-1826`, `netEth < minNetEth` only), the bounded-live
   envelope is enforced by `deploy-node.sh` + wallet cap + `SEARCHER_EV_GATE`, and
   `detector.ts:6-17` carries only `kind: "backrun-arb"`. The credit ADR's phrasing ("read by the
   EV gate + posture guards") overstates the *current* code; the trust it describes is today
   doc-level (Safety Rule 1's "flash-loan arbs are atomic → principal never at risk" reasoning).
2. **The channel is created by the two workstreams' committed plans intersecting.** ADR-a nails
   credit as strategy-agnostic — `block-scan × credit` is a first-class cell, and its sequencing
   note says credit's *natural home* is the block-scan lane (`0xf88b` IS the block-scan+credit
   case; operator override: the lane is a committed deliverable). The atomic impl spec ships
   `kind: "atomic-arb"` on the union that same lane consumes. Once
   `ENABLE_CREDIT_EDGES_FOR_ATOMIC=1`, an opportunity NAMED atomic can carry a
   `leavesStandingPosition: true` edge — and every future guard, telemetry consumer, or operator
   that reads "atomic" as "reverts whole, principal safe" (the Safety-Rule-1 reading) is wrong at
   exactly the moment it matters: when a standing-position credit play rides the block-scan lane
   into the bounded-live envelope whose `assert-balance` (`plan-builder.ts:113`) bounds only the
   flash token. That is the laundering argument, and it is correct.
3. **The overload is not hypothetical — it is already live in the analysis layer, three ways.**
   `canonicalize.ts:43` emits `"atomic/standing"` (conflating the two concepts in one string!);
   `bundle-postmortem.ts:41` `winner_style: "atomic_loop"` means the EXECUTION property (loop
   closed in-tx, back to a priced token); shipped `tx-shape.ts:20` `"atomic_state_arb"` means the
   TRIGGER property (no source swap to follow). The impl spec would add a fourth meaning (strategy
   name). This is the exact vocabulary drift rule 16 exists to kill.
4. **Therefore:** the strategy axis becomes `strategy_kind: "reactive" | "block-scan"` (credit
   ADR naming), and "atomic" is RESERVED for the derived execution/principal-safety property:
   `winner_style: "atomic_loop"` legitimately keeps it (it *measures* the loop closing), and the
   plan-level derived flag is expressed as `leavesStandingPosition` (false = atomic in the safety
   sense) — computed from edges, never asserted by a name. The rename is cheap **now** (spec text +
   one shipped-analysis mapping) and expensive **after A-contract** (live events JSONL schema,
   `redact-live-run`/`route-gap-watcher`/hermes-gate compat — the R3 surface — plus committed
   config filenames and env vars on the node).

One counter-nuance, recorded for fairness: nothing in the atomic EPIC's *behavior* is unsafe as
specified — every A-slice opportunity is genuinely all-swap and revert-safe; the defect is naming a
lane-level type after a property of its current cargo. The fix is a rename plus one derived flag,
not a redesign. That is exactly why it should happen before, not after, the type ossifies.

---

## Task 3 — Redundancy & friction table

| # | Axis | Verdict | Collision site (file:line) | Reconciliation |
|---|---|---|---|---|
| 1 | Strategy taxonomy | **CONFLICT** | `detector.ts:6` (`kind` values, impl plan §1.1 would set `"backrun-arb"\|"atomic-arb"`); `events.ts` `opportunity_kind` (§1.3); coordinator `strategy` (§1.4); `LearningCase.strategy` (§1.5) — vs credit `strategy_kind: reactive\|block-scan` (ADR-a "THE ONE SAFETY-CRITICAL FIX"). Pre-existing third/fourth vocabularies: `canonicalize.ts:38-45`, `bundle-postmortem.ts:41`, `tx-shape.ts:20` | Adopt `reactive\|block-scan` everywhere strategy is meant; "atomic" banned as a strategy value, reserved for the derived execution property. One mapping module for the analysis vocabularies (`tx_shape`/`winner_style`/`strategyType` → `strategy_kind`) |
| 2 | SubmissionCoordinator | **DUPLICATE** (spec-level; neither built) | Both target `listener/src/searcher/execution/` — verified the dir holds only `bundle-router.ts` + `inclusion-tracker.ts`. Atomic §1.4 is fully specified (sync `offer()`, decision matrix, `onBlock` prune, backrun-first default); credit slice 7 names it with zero design | Build ONCE from atomic §1.4, relabeled `strategy: "reactive"\|"block-scan"`. Credit correctly never appears as a strategy value (it's an edge kind) — the invariant holds by construction |
| 3 | Isolation lane: A-lane vs credit slice 7 (AtomicView/block-scan lane) | **CONFLICT** (isolation depth + timing) | Impl plan A-lane rules 1-4: same process, own `atomic_busy` + own `PoolStateCache` + own sim instance, ONE wallet (coordinator arbitrates the shared nonce `submitter.ts:296`), chunked cooperative yields, escalation path to worker/2nd machine — vs credit slice 7: separate fork/sim + separate EOA/nonce + separate process + RPC fairness, 2nd-funded-EOA human gate; ADR-a lists Node single-thread as the "strongest reason to DEFER" the lane | ONE lane, PHASED: A-lane's same-machine design is v1 (no new human gate needed; the coordinator exists precisely because the nonce is shared). Measured contention (hint `prep_ms p95` regression despite chunking — the impl spec's own escalation trigger) upgrades to worker/process/2nd EOA, and THAT is when the 2nd-EOA Safety-1 gate fires. Credit slice 7 collapses to "project credit edges into the existing block-scan view + credit-specific guards" — it must NOT build a second lane |
| 4 | LearningCase | **CONFLICT** (two schemas) → merge | Atomic §1.5 CREATE `analysis/src/learning/learning-case.ts` (verified: `analysis/src/learning/` does not exist) vs credit slice 2 EXTEND `bundle-postmortem.ts` (`winner_style`/`route_gap_decisive`/`in_graph` kernel, `:41/:106/:512`) + census/live-loss/hermes-gate | ONE schema = credit's spine (`strategy_kind`, `edgeKinds[]`, funnel-ordered `primaryGap` + terminals `non_comparable_winner`/`standing_position_required`/`oracle_not_diverged`) **+** atomic's operational machinery, which credit's schema lacks and which is genuinely superior: `learning_case_id` idempotency + forward-only status + `parked_uneconomic` terminal (nail #5), `source_block = B−1` join (user pt 1), `capability_replay_stage` vs `live_admission_stage` (P1-4), view hashes (P1-5). A single new FILE for the shared schema is fine — "extend not fork" binds the EMITTERS (postmortem/census emit `LearningCase`; no parallel analyzer pipeline), which the atomic plan already honors (arch plan §C2 "both OUTPUT LearningCase") |
| 5 | Analysis extensions overlap | **COMPOSE** (one overlap map needed) | Both touch: `bundle-postmortem.ts` (atomic adds `atomic_scan_shape`; credit maps `winner_style`→`primaryGap` + `EdgeSequence`), `census-report.ts`, `live-loss.ts`, `hermes-gate.ts:133` (`intake_audit`, credit). Shared shipped foundation: `sender-flow.ts` / `victim-source.ts` / `swap-log-registry.ts` / `tx-shape.ts` | One combined analysis slice: `winner_style`→`primaryGap` mapping + `tx_shape`→`strategy_kind` mapping + `EdgeSequence` extraction. `swap-log-registry.ts` grows credit-event decoders (a credit leg emits no swap log — Fluid operate-class events) → it becomes the venue-EVENT registry both need. `strategy-compare.ts` (atomic C2) is census-shaped (competitor-tx-driven): build it as the census extension, not a third enumerator |
| 6 | Edge model: Opportunity union + `seedEdges` vs `VenueEdge{edgeKind}` | **COMPOSE** (with two nails) | `token-graph.ts:15` `TokenEdge` already has `slotKind: "flash"\|"lend"\|"swap"` (the fluid vault is the `lend` precedent); credit slice 1 widens with `edgeKind`+`leavesStandingPosition` ("widen, don't replace"); atomic `seedEdges: TokenEdge[]` (§1.1) consumes whatever `TokenEdge` becomes; `token-graph.ts:474` pinned-exemption (score===undefined never pruned) | Nail 1: do NOT end up with two competing kind tags — pin the derivation (`slotKind:"lend"` ⇒ `edgeKind:"credit"`; `swap`/`flash` ⇒ `swap`) or migrate outright, in slice 1. Nail 2: `BlockScanOpportunity` carries derived `leavesStandingPosition` from its edges, and view projection drops credit edges when `ENABLE_CREDIT_EDGES_FOR_BLOCKSCAN=0` — the `:474` pinned-exemption means scoring can never prune a curated credit edge (credit's own point about the backrun view, applying equally to the block-scan view) |
| 7 | primaryGap taxonomy | **CONFLICT** → two-level merge | Atomic's 10-class `atomic_*` taxonomy (arch plan §C2 table) vs credit's converged funnel spine (ADR-a "LearningCase primaryGap taxonomy") | Credit's funnel-ordered spine is the primary axis; atomic's classes become owner-routing DETAIL under it. The symmetry that makes this clean: `source_not_seen` (reactive intake gap) ≅ `atomic_scan_not_triggered` (block-scan intake gap) — both are pre-funnel admission classes, so the spine holds: intake → view (`view_missing` ⊃ `atomic_view_missing_venue`) → path (`path_not_found` ⊃ `atomic_cycle_not_found`) → quote/sizing → sim → economics → auction → terminals. P1-4's load-bearing distinction (`scan_not_triggered` ≠ `cycle_not_found`) survives intact as two different spine positions (intake vs path) |
| 8 | Shipped C1 placement | **COMPOSE** — reusable as-is | `sender-flow.ts` (two-axis), `victim-source.ts` (delegating), `swap-log-registry.ts`, `tx-shape.ts` + fixtures | No rework. Mandatory: the `tx_shape → strategy_kind` mapping at LearningCase construction; `sender-flow` feeds intake evidence unchanged; registry gains credit-event decoders when slice 2 needs `EdgeSequence`. Optional: rename `atomic_state_arb` value while it still has zero consumers; rename the planned census field `atomic_scan_shape` → `tx_shape` (do this one — it's still unbuilt) |

---

## Task 4 — Recommendation: the unified path

**Which model wins per axis:** credit's `strategy_kind × edge_kind` spine wins the taxonomy, the
edge model, and the primaryGap spine (axes 1, 6, 7); the atomic impl spec wins every concrete
component design — Opportunity union field-set, SubmissionCoordinator §1.4, lane mechanics
(A-lane rules, fresh-read gate, stale-target gate), LearningCase operational machinery
(idempotency/status/B−1/P1-4/P1-5), and all rule-12 gates (axes 2, 3, 4-machinery, 5). The shipped
C1 chain is shared foundation for both.

**Should atomic-arb be absorbed as `strategy_kind: block-scan × edgeKind: swap` under the credit
spine? Yes — absorption of the NAME, not the work.** The atomic EPIC's slices, ordering
(C1→A0→A-contract→A-universe→A1-A3→C2-minimal→A-lane→A4), gates, and GO/BLOCKED statuses all stand
unchanged; they simply produce the `block-scan` strategy of the unified model instead of a
parallel "atomic" one.

**Exactly what the atomic impl spec must change (the naming/safety fix first):**

1. **Rename the strategy axis throughout** (§1.1/§1.3/§1.4/§1.5, event names, drop reasons, env
   vars, committed filenames): `AtomicOpportunity` → `BlockScanOpportunity`, `kind:
   "block-scan-arb"`, coordinator/LearningCase `strategy: "reactive" | "block-scan"`,
   `atomic_scan_result` → `block_scan_result`, `atomic_*` drop reasons → `blockscan_*`,
   `SEARCHER_ENABLE_ATOMIC_SCAN` → `SEARCHER_ENABLE_BLOCK_SCAN`, `atomic-view-overrides.json` →
   `blockscan-view-overrides.json`, `atomic-lane.ts` → `blockscan-lane.ts`. "Atomic" survives only
   in `winner_style: "atomic_loop"` (a measured execution property) and prose about revert-safety.
2. **Add the derived safety flag to the union:** `leavesStandingPosition` computed from
   `seedEdges` (and for reactive plans from the planned path's edges); the credit-live reject
   guard (credit invariant 3) keys on it. This makes the guard strategy-agnostic and closes Task-1
   defect 3 before it can exist.
3. **Replace §1.5 with the merged LearningCase schema** (Task 3 axis 4) and the two-level
   primaryGap (axis 7); rename `atomic_scan_shape` → `tx_shape`.
4. **A-universe's `buildStrategyViews` absorbs credit's view projection:** per-view, per-edge-kind
   policy (`ENABLE_CREDIT_EDGES_FOR_{REACTIVE,BLOCKSCAN,ANALYSIS}`) applied at projection time
   (the `token-graph.ts:474` pinned-exemption makes score-based pruning impossible for curated
   credit edges — projection is the only drop point). Credit slice 6's `projectView` and the
   atomic spec's `strategy-views.ts` are ONE module.
5. **A-lane gains the phasing note** (Task 3 axis 3): same-process/one-EOA is v1; the escalation
   trigger already in the spec (hint `prep_ms p95` regression despite chunking) is ALSO the
   trigger for the 2nd-EOA human gate. Credit slice 7 is re-scoped to "credit edges into the
   existing lane's view + guards".

**Does the SHIPPED C1 code need rework or only re-labeling? Re-labeling/mapping only** (Task 1 /
Task 3 axis 8). Nothing shipped encodes the wrong architecture; one value-string rename is optional
while its consumer (C2) is still unbuilt; the `tx_shape → strategy_kind` mapping is mandatory and
lives in the merged LearningCase construction.

**The single highest-friction collision to resolve BEFORE either workstream writes more runtime
code:** the strategy-taxonomy + Opportunity-union naming that A-contract would ossify
(`detector.ts:6`, `events.ts`, `execution/submission-coordinator.ts`). A-contract is the next GO
slice in the atomic pipeline and every downstream artifact inherits its strings — telemetry JSONL
read by `redact-live-run`/`route-gap-watcher`/`hermes-gate` (the R3 compat surface), the committed
override filename that survives deploys, node env vars preserved by `deploy-node.sh`, and the
LearningCase store. Renaming before = editing two spec docs + one census field name. Renaming
after = a live-events schema migration with compat shims across every analyzer, twice the R3
surface, plus a node-side env/file rename through the deploy guard.

**The minimal shared foundation both workstreams build ONCE (the "spine slice", replacing atomic
A-contract's naming layer + credit slice 1):**

1. Taxonomy module: `strategy_kind: "reactive" | "block-scan"` + the mapping functions from the
   three existing analysis vocabularies (`tx_shape`, `winner_style`, `canonicalize.strategyType`).
2. Widened `TokenEdge` (`edgeKind` + `leavesStandingPosition`, derivation from `slotKind` pinned)
   — `token-graph.ts:15`.
3. The Opportunity union with atomic §1.1's field-set under the new names, + derived
   `leavesStandingPosition`.
4. The merged `LearningCase` schema + store (atomic §1.5 machinery, credit spine).
5. `SubmissionCoordinator` per atomic §1.4, relabeled.
6. ONE strategy-views module: atomic A-universe's `buildStrategyViews` + view-hash versioning
   (P1-5) + credit's per-edge-kind projection flags.

Then: atomic slices A0–A4 proceed under the new names with their existing gates; credit slices 2–3
proceed on the shared analysis layer (v1 cut unchanged: types + learning loop + `0xf88b` credit
recognition, production OFF); credit 5–8 follow their own gates, with slice 7 re-scoped.

---

## Resolve-before-more-code (ordered)

1. **Strategy-axis rename decision** (`reactive|block-scan`; "atomic" reserved for the execution
   property) — binds BOTH specs; must land before **A-contract** (the next GO runtime slice).
2. **`TokenEdge` widening contract** (`edgeKind` derivation from `slotKind`;
   `leavesStandingPosition` on the edge; derived flag on the plan/opportunity) — before A-contract
   (whose union references `TokenEdge`) and before credit slice 1 lands as code.
3. **ONE `LearningCase` schema + two-level primaryGap** — before C2-minimal AND before credit
   slice 2 (they would otherwise create two stores/schemas in the same week).
4. **ONE SubmissionCoordinator + the lane phasing decision** (same-EOA v1; 2nd EOA = measured
   escalation with its Safety-1 gate) — before A-lane and before any credit slice-7 work.
5. **ONE strategy-views/projection module** (edge-kind flags + view hashes) — before A-universe
   and credit slice 6.
6. **Census/postmortem field naming** (`tx_shape`, not `atomic_scan_shape`) — with C2/slice 2.
7. Hygiene: remove or ignore the stray untracked `listener/src/searcher/venues/capability.js`.

Items 1–3 are blocking (they change what the next committed slice writes); 4–6 are ordering
constraints; 7 is free.
