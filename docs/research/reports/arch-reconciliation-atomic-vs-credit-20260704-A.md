# Architecture reconciliation — atomic-arb EPIC vs credit-venue edge (Reviewer A, 2026-07-04)

> Scope: authorized, defensive on-chain arbitrage research; mainnet fork + dry-run; broadcast is a
> human-gated step. Read-only architecture review — no code edits, no chain calls. This is ONE of three
> blind reviews. Every claim grounded in file:line from the working tree.

## VERDICT (one line)
Both workstreams are individually sound, but they are building the SAME spine twice: **adopt the credit
workstream's `strategy_kind × edge_kind` model as the shared foundation, absorb the atomic-arb EPIC as
`strategy_kind: block-scan × edgeKind: swap` (its engineering — scanner / seedEdges planner binding /
A-lane / fresh-read gate — survives the reframe intact), and rename `kind:"atomic-arb"` BEFORE A-contract
writes the discriminator into the hot path.** Shipped C1 needs re-labeling only, not rework.

## Top-3 friction points
1. **Strategy discriminator (SPINE, decisive):** atomic-arb bakes `kind:"backrun-arb"|"atomic-arb"` into
   the `Opportunity` union + every event + the coordinator (`detector.ts:6`, spec §1.1/§1.3/§1.4); credit
   uses `strategy_kind:reactive|block-scan` + edge-level `leavesStandingPosition` (ADR line 25-30). A-contract
   is the NEXT runtime slice and threads this discriminator through `main.ts`/`events.ts`/`planner.ts` — if
   it lands as `kind:"atomic-arb"` the two spines collide irreversibly. **Resolve first.**
2. **LearningCase — one schema or a parallel path:** atomic-arb CREATES `analysis/src/learning/learning-case.ts`
   (spec §1.5) with an atomic-prefixed primaryGap taxonomy; credit slice-2 EXTENDS `bundle-postmortem`/census
   with a strategy-agnostic taxonomy (landing-plan slice 2; ADR "must EXTEND … NOT a parallel reporting path
   — else it recreates the exact 3×-analyzer drift"). Two designs for one object.
3. **SubmissionCoordinator + block-scan/atomic lane built twice:** `execution/submission-coordinator.ts` +
   `atomic-lane.ts`/`AtomicView` are defined by BOTH (spec §1.4/A-lane; landing-plan slice 7), and they
   DISAGREE on wallet isolation (atomic-arb shares one nonce + arbitrates; credit slice-7 wants a separate
   funded EOA behind a Safety-1 gate).

---

## Task 1 — atomic-arb EPIC: architecture + shipped C1

### (a) As SPECIFIED — sound; no fatal architectural defect
The plan/impl-spec pair is unusually rigorous and I confirmed its load-bearing code claims against the tree:
- **Planner binding is correctly root-caused.** `affectedPools` is ignored and focusing keys off
  `hints.impact` — verified: `detector.ts:6` union, and the spec's anchor re-calibration (`planner.ts:126`,
  `impactFromOpportunity :413`, `focusPathsOnImpact` no-impact returns all paths `:449`). So the
  `seedEdges`-constrained, no-`buildTokenPaths` atomic branch (A1) is the right fix, not a passthrough of
  `affectedPools`.
- **The sizing-seed blocker is real and well-caught.** `resolveSearchCenter` returns `1n` for
  `victimAmount<=0n` (`solver.ts:449`), GSS only fires on a positive grid point (`solver.ts:196`) → a 1–8 wei
  probe rounds to zero. Requiring `searchSeed.searchCenter` in flashToken units (A1/A3) is correct; the gate
  asserting `center>8n` is the right guard.
- **A-lane isolation is correctly justified.** The hint loop DROPS on busy (`main.ts:858` `skip hint`, no
  queue), so an atomic scan holding `busy` silently drops backrun victims — P0-1's own-`atomic_busy` + own
  cache + own sim is the correct model, and the Node single-thread caveat (chunked cooperative yields,
  A-lane rule 3) is honestly stated.
- **P0-2 fresh-read gate is a genuinely good correction.** "Swap logs are TRIGGER-only, never a consistency
  proof" (non-swap events + eventless transfers mutate quote state) is correct and supersedes the unsound R4
  "untouched ⇒ block-invariant" rule.
- **Cycle-fingerprint identity is right.** Canonical token-RING (not token-pair, undefined for the 3-4-hop
  paying case) + size-excluded-from-identity (size is a per-searcher choice) — both corrections are sound
  (spec §1.2).
- **SubmissionCoordinator correctly identifies the shared-nonce hazard** (`submitter.ts:296`
  `getNonce("pending")` + one pinned target block ⇒ last-write-wins, not best-EV-wins).

**Real defects as specified — all naming/placement, not engineering:**
- D1. The strategy discriminator overloads "atomic" (Task 2 / friction #1).
- D2. `LearningCase` as a NEW `analysis/src/learning/learning-case.ts` risks the parallel-path drift the
  credit ADR names (friction #2).
- D3. The atomic gap taxonomy is `atomic_`-prefixed (spec §C2 table) — strategy embedded in every value, an
  island vs a strategy-agnostic funnel taxonomy.
- D4. Coordinator matrix row "atomic holder ← backrun candidate ⇒ admit+replaces (later bundle supersedes at
  builders on the same nonce)" (spec §1.4) assumes builder last-nonce-wins semantics; reasonable but worth an
  explicit note, not a blocker.

### (b) As SHIPPED — C1 chain (0fb1566, 975ebc2, cbbdf1f) is correct
- `sender-flow.ts`: two-axis split is correct — `source_visibility` is derived from `seenInOurPublicFeed`
  FIRST (`:33` → `sourceVisibilityFor` `:55-59`), BEFORE the fee heuristics in `submissionMethodFor`
  (`:66-71`), and `submission_method` can never return "private" (0-tip/coinbase ⇒ at most `"bundle"`
  `:66-71`). This kills the verified `:44` branch-order bug. SOUND.
- `swap-log-registry.ts`: unified v2/v3/v4/Curve/Balancer decoder; v4 and Balancer key on the bytes32
  `poolId` (`:89`, `:138`) not `log.address` — correct for the singleton-target disambiguation. Known gap
  (Curve NG/crypto uint256-id topic → null) is documented and harmless (`:120-122`). SOUND.
- `tx-shape.ts`: strict `<` boundary excludes the arb tx's own logs (`:37`), pool identity via
  `decodeAnySwapLog().poolId` (v4-aware, `:27/:34`), 0 preceding ⇒ `atomic_state_arb` / ≥1 ⇒ `backrun`
  (`:42`). SOUND.

### tx-shape's `atomic_state_arb/backrun` in a unified taxonomy — soon-to-be-renamed island? (mild)
`tx-shape.shape` classifies a **competitor observation** (did their tx follow a same-block source swap), NOT
our own plan's principal-safety. It maps 1:1 onto the strategy axis: `backrun ↔ strategy_kind:reactive`,
`atomic_state_arb ↔ strategy_kind:block-scan`. It is therefore a **comparison attribute that feeds
`strategy_kind` on the LearningCase**, not a competing taxonomy. The only issue is the literal string
`"atomic_state_arb"` reuses the overloaded word "atomic". **Verdict: re-label (map to the block-scan/reactive
vocabulary, or rename to a `competitor_shape` axis) — not rework.** The classifier logic stays.

---

## Task 2 — new opinion in light of the credit ADR (the "atomic" safety argument)

**The credit ADR's safety claim (ADR lines 19-30):** labeling a path `atomic` lets a standing-position credit
play launder as principal-safe through a name "the EV gate + posture guards trust."

**Verified in code — nothing reads a strategy label as a principal-safety signal (today):**
- `grep -rn "strategy_kind|leavesStandingPosition|abandonExit"` over `listener/src` + `analysis/src` →
  **0 hits**. Neither discriminator exists in code yet.
- `grep -rn "atomic" listener/src/searcher/` → only `writeJsonAtomic` (file-write atomicity,
  `route-gap-watcher.ts:333/:352/:364`) and a comment in `auto-close-route-gap.ts:104`. No guard branches on
  an "atomic" strategy label.
- The bounded-live guard (`deploy-node.sh:88-116`) keys ONLY on `SEARCHER_EV_GATE=1` + wallet-balance ≤
  `MEV_LIVE_MAX_WALLET_ETH` + `SEARCHER_DRY_RUN=0`. It reads **no** strategy/opportunity label. The word
  "atomic" appears once as a COMMENT (`deploy-node.sh:16`, "flash-loan arbs are atomic → worst-case loss is
  bounded") describing the economic property, not a field read.
- `evGate` is an env flag (`main.ts:414`, `SEARCHER_EV_GATE === "1"`), not a per-opportunity strategy read.
- `plan-builder.ts:114` `assert-balance` bounds the flash token delta only (credit ADR safety invariant 3
  correctly notes this does NOT bound a standing position).

**Opinion — DOWNGRADE from safety to naming-hygiene, with a real latent dimension:**
- **Today it is naming-hygiene, not an active vulnerability.** No guard reads the label, so no credit play
  can "launder" through it right now. The claim "a name the EV gate + posture guards trust" is true of the
  Safety-Rule prose and the deploy COMMENT (human/operator reasoning), **false at the code level**.
- **It is nonetheless a must-fix-before-more-code naming decision**, because the risk becomes real exactly
  when the two workstreams meet: (1) the credit workstream's entire point is to eventually wire an
  edge-level `leavesStandingPosition`/`abandonExit` reject guard into submit/deploy (ADR "reconciliation";
  landing-plan slices 3/5); (2) the credit ADR explicitly wants credit routed through the **same
  block-scan/atomic lane** (`block-scan(atomic) + credit`, ADR line 37). So the moment credit lands on the
  block-scan lane, an opportunity carrying `kind:"atomic-arb"` while holding a credit edge is precisely the
  laundering shape — and the fix (put safety on the EDGE, name the strategy `block-scan`) is free if done
  now and painful once `kind:"atomic-arb"` is threaded through `main.ts`/`events.ts`/`planner.ts` by
  A-contract.
- **Shipped C1 is NOT implicated.** `tx-shape.shape:"atomic_state_arb"` is a competitor-observation string,
  not a strategy label on our plan or a principal-safety assertion — it never reaches a guard. No safety
  concern there.

**Does this change my assessment of docs 1/2/3?** Yes, on ONE axis: the atomic-arb impl spec's
`kind:"atomic-arb"` discriminator MUST become `strategy_kind:"block-scan"` (with atomicity/principal-safety
expressed as an edge property, not a strategy name) — adopt the credit ADR's rename. The rest of docs 1/2/3
(the scanner, planner binding, lane isolation, fresh-read gate, telemetry nails, coordinator mechanics) is
sound and orthogonal to the credit model; it survives the reframe unchanged.

---

## Task 3 — REDUNDANCY & FRICTION check (per axis)

| axis | relationship | collision file:line | reconciliation |
|---|---|---|---|
| **Strategy taxonomy** | **CONFLICT** | atomic `kind:"backrun-arb"\|"atomic-arb"` on the union (`detector.ts:6`; spec §1.1) + event `opportunity_kind` (§1.3) + coordinator `strategy:"backrun"\|"atomic"` (§1.4) **vs** credit `strategy_kind:reactive\|block-scan` + edge `leavesStandingPosition` (ADR :25-30) | Credit spine WINS. Rename `kind:"atomic-arb"` → `strategy_kind:"block-scan"`; atomicity/principal-safety becomes an EDGE flag (`leavesStandingPosition:false` for swap). Do this IN A-contract (before it's threaded through the hot path), not after. |
| **SubmissionCoordinator** | **DUPLICATE** (same component) | `listener/src/searcher/execution/submission-coordinator.ts` CREATE (spec §1.4) **vs** landing-plan slice 7 "SubmissionCoordinator … land WITH the atomic lane" | Build ONCE. Keep atomic-arb's concrete sync `offer()` matrix (§1.4) — it is the fuller spec. Generalize its `strategy:"backrun"\|"atomic"` field to `strategy_kind:"reactive"\|"block-scan"`. |
| **Block-scan lane / AtomicView vs A-lane** | **DUPLICATE + one CONFLICT** | `atomic-lane.ts` own busy/cache/sim, ONE shared wallet nonce (spec A-lane, §1.4) **vs** landing-plan slice-7 isolation incl. **separate EOA/nonce** (ADR lane-isolation item 2, "second funded EOA = Safety-1 gate") | ONE lane. Reconcile the wallet split: atomic swap-arb is principal-safe → **shared signing nonce + coordinator is correct** (atomic-arb). Credit's need is a fresh isolated **credit-leg position account** (nftId/sub-account, credit-venue-edge doc lines 63-69) — ORTHOGONAL to the signing EOA. So a second funded EOA is NOT required for swap-atomic; it becomes a per-credit-leg concern gated at credit-live. Drop slice-7's "separate EOA" from the base lane; add it only on the credit path. |
| **LearningCase** | **CONFLICT (parallel-path risk)** | `analysis/src/learning/learning-case.ts` CREATE + new `strategy-compare.ts`/`auto-close-strategy-gap.ts` (spec §1.5/§C2/§D) **vs** credit slice-2 EXTEND `bundle-postmortem.ts`/`live-loss.ts`/`census-report.ts` (landing-plan slice 2; ADR :68-70) | Credit approach WINS (EXTEND, don't fork) — it is exactly the rule-16 "one learning system" the operator mandates. Put the ONE `LearningCase` schema in a shared module; have `bundle-postmortem` (backrun) AND the atomic/credit census both OUTPUT it (atomic-arb §3 already agrees "bundle-postmortem and atomic census both OUTPUT LearningCase" — so converge on credit's location + taxonomy). |
| **Analysis extensions** | **DUPLICATE** | Both touch `bundle-postmortem.ts` (`winner_style` :41/:106/:512), `live-loss.ts`, `hermes-gate.ts`, `census-report.ts` (atomic adds `atomic_scan_shape`; credit maps `winner_style→primaryGap` + `non_comparable_winner`) | One coordinated pass over these four files. `atomic_scan_shape` (from shipped `tx-shape.ts`) and credit's `primaryGap`/`EdgeSequence` are complementary fields on the SAME extended report — merge the field sets; do not open the files twice. |
| **Edge model** | **COMPOSE (clean subset)** | atomic `seedEdges: TokenEdge[]` (spec §1.1; `token-graph.ts:462` buildTokenPaths) **vs** credit `VenueEdge{edgeKind}` widening `TokenEdge` (`token-graph.ts:15`, ADR :101) | Compatible. `VenueEdge` is a strict SUPERSET of `TokenEdge` (add `edgeKind`, `leavesStandingPosition`, `quote()/build()`); a swap edge is `edgeKind:"swap", leavesStandingPosition:false`. atomic-arb's `seedEdges` become `VenueEdge[]` all-swap. **Decisive: `VenueEdge` CAN express the seedEdges-constrained no-DFS planner semantics** — the no-DFS behavior is a planner branch on the strategy discriminator (A1 `planAtomicFromSeedEdges` skips `buildTokenPaths`), independent of the edge type. So atomic-arb is a clean `block-scan × swap` subset. |
| **primaryGap taxonomy** | **CONFLICT (two taxonomies)** | atomic `atomic_view_missing_venue / atomic_scan_not_triggered / atomic_cycle_not_found / atomic_sizing_failed / atomic_below_ev_gate / …` (spec §C2 table) **vs** credit strategy-agnostic `source_not_seen / view_missing / path_not_found / quote_failed / sim_failed / below_ev / non_comparable_winner / standing_position_required / …` (ADR :145-150) | Credit's strategy-agnostic set WINS (one taxonomy serves backrun + atomic + credit). Atomic's classes map onto it: `atomic_view_missing_venue↔view_missing`, `atomic_scan_not_triggered↔source_not_seen`, `atomic_cycle_not_found↔path_not_found`, `atomic_sizing_failed/atomic_sim_revert↔sim_failed`, `atomic_below_ev_gate↔below_ev`, `atomic_quote_fidelity_failed↔quote_failed`. Keep the atomic distinctions (e.g. scan_not_triggered vs cycle_not_found, the P1-4 split) as a `secondaryGaps[]`/sub-code, not a parallel top-level set. |
| **Shipped C1** | **COMPOSE (reuse; tx-shape re-label)** | `sender-flow.ts` (two-axis), `victim-source.ts`, `swap-log-registry.ts`, `tx-shape.ts` | `sender-flow`/`victim-source`/`swap-log-registry` reusable AS-IS — orthogonal to strategy/edge kind; `source_visibility`→credit `source_not_seen` primaryGap; registry decodes competitor swaps for both. `tx-shape.shape` re-labeled/mapped to `strategy_kind` (competitor-shape axis feeding the LearningCase). NO rework. |

---

## Task 4 — recommendation (unified path)

**Which model wins, per axis:** strategy taxonomy → **credit** (`strategy_kind:reactive|block-scan` +
edge-level `leavesStandingPosition`). Edge model → **credit** (`VenueEdge` superset of `TokenEdge`).
LearningCase + primaryGap → **credit** (extend bundle-postmortem, strategy-agnostic taxonomy).
Coordinator + lane infra → **atomic-arb's concrete spec** (fuller: sync `offer()` matrix, own-cache/sim
isolation, chunked yields), re-labeled onto the credit spine and with the second-EOA requirement moved to
the credit path only. Scanner / seedEdges planner binding / fresh-read gate / telemetry nails →
**atomic-arb** (no credit equivalent; sound as-is).

**Absorb atomic-arb as `strategy_kind: block-scan × edgeKind: swap`.** It is a clean subset of the credit
spine (edge-model axis is COMPOSE). Its whole engineering body survives; only three renames are needed.

**Exactly what the atomic-arb impl spec must change to align (the "atomic" naming/safety fix FIRST):**
1. `AtomicOpportunity.kind:"atomic-arb"` → `strategy_kind:"block-scan"` on the opportunity; keep `seedEdges`
   but type them `VenueEdge[]` (all `edgeKind:"swap", leavesStandingPosition:false`). (spec §1.1)
2. Event `opportunity_kind:"backrun-arb"|"atomic-arb"` → `strategy_kind:"reactive"|"block-scan"`; coordinator
   `strategy:"backrun"|"atomic"` likewise. (spec §1.3/§1.4)
3. `LearningCase` → the shared schema location + the strategy-agnostic `primaryGap` taxonomy; atomic's
   `atomic_*` classes become `secondaryGaps[]`/sub-codes. `analysis/src/learning/learning-case.ts` becomes
   the shared module ONLY if credit slice-2 co-locates there; otherwise fold into the bundle-postmortem
   extension. (spec §1.5/§C2/§D)
4. `tx-shape.shape` (shipped): document/map `atomic_state_arb → strategy_kind:block-scan`,
   `backrun → strategy_kind:reactive` where it feeds the LearningCase (re-label, no code rework).

**Does shipped C1 need rework?** No — only re-labeling of `tx-shape.shape` output at the point it feeds the
unified LearningCase. `sender-flow`/`victim-source`/`swap-log-registry` are reused unchanged.

### The single highest-friction collision to resolve BEFORE either writes more runtime code
**The strategy discriminator name.** A-contract (atomic-arb's next runtime slice) hard-codes
`kind:"backrun-arb"|"atomic-arb"` into the `Opportunity` union, every event in `events.ts`, and the
coordinator — threaded through the ~640-line `processOpportunities` factor-out of `handleHint`. If it lands
as `kind:"atomic-arb"`, the credit spine (`strategy_kind` + edge `leavesStandingPosition`) either forks or
forces a painful rename back through the entire hot path — AND re-creates the latent laundering trap the
credit ADR flags. Decide `strategy_kind:reactive|block-scan` + edge-level safety NOW, before A-contract.

### Minimal shared foundation both should build ONCE (in order)
1. **One type module** — `strategy_kind:reactive|block-scan` on the opportunity + `VenueEdge{edgeKind,
   leavesStandingPosition,…}` widening `TokenEdge` (`token-graph.ts:15`; seedEdges become `VenueEdge[]`).
   = credit slice-1 ∪ atomic-arb A-contract union, merged. Pure types, `searcher:planner` unchanged.
2. **One LearningCase + strategy-agnostic primaryGap taxonomy**, emitted by `bundle-postmortem` AND the
   atomic/credit census, consumed by ONE `auto-close-strategy-gap` dispatcher. = credit slice-2 ∪ atomic-arb
   §1.5/§C2/§D. Extend the existing analyzers; do not fork.
3. **One block-scan lane + SubmissionCoordinator** (build only when the second producer exists) — atomic-arb's
   spec, re-labeled; second funded EOA deferred to the credit path + its own Safety-1 gate.

### Resolve-before-more-runtime-code list (ordered)
1. **Adopt `strategy_kind:reactive|block-scan` + edge-level `leavesStandingPosition`; forbid a strategy label
   named "atomic".** (Blocks A-contract; fixes friction #1 + Task-2 latent safety.)
2. **Fix the LearningCase location + taxonomy to ONE strategy-agnostic schema (extend bundle-postmortem, not
   a new parallel path).** (Blocks atomic C2/D and credit slice-2; fixes friction #2.)
3. **Declare `VenueEdge` (superset of `TokenEdge`) as the one edge type; atomic `seedEdges:VenueEdge[]`.**
   (Foundation-1; unblocks both planners.)
4. **Designate ONE `SubmissionCoordinator` + ONE block-scan lane spec; move the second-EOA requirement to the
   credit-live path only.** (Blocks atomic A-lane/A4 and credit slice-7; fixes friction #3.)
5. **Re-label shipped `tx-shape.shape` → `strategy_kind` mapping where it feeds the LearningCase.** (Cheap;
   no rework.)
