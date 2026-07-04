# Architecture improvement plan — from the coffee 2026-07-04 classification

> Scope: authorized, defensive on-chain arbitrage research; mainnet fork + dry-run; broadcast is a
> human-gated step. This plan takes the three gaps named in
> [`coffee-atomic-arb-classification-20260704.md`](coffee-atomic-arb-classification-20260704.md)
> (data trusted as-is, not re-verified) and maps each to a concrete change in *this* repo, with a
> repair-replay (rule-12) gate for each. It does NOT itself change searcher behavior — it is the
> design + verification contract the implementation cycles execute against.

## The three gaps (from the source doc)

| # | competitor evidence | our gap | class | size |
|---|---|---|---|---|
| A | 8/9 of coffee's txs = **atomic chain-state arbitrage** (a standing cross-pool spread captured in one tx; **no pending source swap** to follow) | our pipeline is **backrun-only** — it triggers exclusively on a pending mempool swap; a standing spread never enters the funnel | strategy / architecture | **largest — EPIC** |
| B | 1/9 = a **public backrun** whose source swap `to=0x663dc15d…` (custom router) was dropped **before** the funnel | mempool admission is a fixed ~14-router allowlist; a swap via an unlisted router that touches our pools is invisible | flow-admission | small, cheap |
| C | the per-round comparison never checked "did we SEE the source swap" nor "is the competitor atomic- or backrun-shaped" (built by hand: `coffee-backrun-verify.mjs`) | the followability classifier is a hand analysis, not a permanent tool | analysis-tooling (rule 16) | cheapest |

Economics honesty (carried from memory, not re-litigated): coffee's atomic take is **dust** on public
flow ($0–0.33/tx, ~$23/2.5h) — but that ceiling was measured on ~1.4% of flow, and MEV-Share flow (72×
volume) was just flipped on. Gap A is a **capability** we lack regardless of today's dust; its EV must
still clear the gate. Do not celebrate dust (Hermes "simSuccess must be +EV" rule).

> **User second-review (2026-07-04) — 5 remaining self-evolution closures folded in.** The atomic side must
> be a self-analyzing / self-evolving / comparison-driven loop identical in KIND to backrun's. A prior pass
> already fixed the `cycle_fingerprint` identity (canonical token-RING, size excluded — the user's point 5).
> The five still open (numbered per the user's review; their point 5 = the already-landed token-ring fix),
> folded into the slices named — top three load-bearing are 1, 3, 4:
> 1. **Comparison temporal off-by-one** — align a competitor atomic tx by `source_block =
>    competitor_execution_block − 1` (we scan `B-1` end-state, submit to `B`); aligning on `B` reports our
>    real `B-1` scan as `not_seen`. → A-contract `cycle_fingerprint`, C2, A4.
> 2. **Offline counterfactual replay in C2/D** — not only live events; historical / pre-telemetry samples
>    replay the scanner at `B-1` to drive `our_stage`, or early learning stalls at `not_scanned`. → C2.
> 3. **Unified `LearningCase` schema** — backrun postmortem AND atomic census both emit ONE object; D
>    consumes only `LearningCase`, never a per-tool report shape (else atomic is a bypass). → C2, D.
> 4. **Atomic close writes `atomic-view-overrides.json`**, NEVER backrun's `force-include-poolids.json` —
>    else the close crowds out backrun slots in the shared graph + mempool `toAddress` hot path. → D.
> 6. **A minimal C2 ships BEFORE A4** — A4's gate ("we now generate a competing candidate") is hand
>    analysis without it. Order → C1 → B → A-contract/A-universe → A1–A3 → **C2-minimal → A4** → D. → Governance.

> **Second-review architecture nails (2026-07-04, verified against the repo) — folded into the slices
> below; these are prerequisites, not optional polish.** Seven items that must be pinned or the atomic side
> implements as "runs a bit" but is not productionizable and cannot self-explain why it didn't run. The
> detail lives at each slice; this is the index.
> 1. **Planner strategy-view interface — pin the mechanism, not just "two views" (→ A-universe / A1).**
>    `planner.plan` keeps ONE signature; the edge-view is selected by `opp.kind` (backrun → hot edge-view;
>    atomic → union graph, `seedEdges`-constrained), or via an explicit `graphView` arg. Gate: under one
>    union graph the backrun view EXCLUDES an atomic-only venue and the atomic view INCLUDES it.
> 2. **Cross-strategy `SubmissionCoordinator` — not just atomic top-1 (→ A-contract).** A-contract #5 dedups
>    atomic-INTERNALLY, but backrun and atomic are two producers feeding ONE wallet / nonce / target-block
>    slot. Add a coordinator both feed: group `SubmissionCandidate`s by target block, rank by
>    `strategy_priority / net_ev / deadline`, admit one, losers emit `submission_arbitration_lost`. Without
>    it atomic seizes backrun's send slot (last-write-wins on the shared nonce, not best-EV-wins).
> 3. **Atomic target-block expiry — a SUBMIT-time gate (→ A4).** State-block consistency is scan-time only.
>    Atomic pins `target = source_block + 1`; if `latest` advanced past `source_block` at submit, drop as
>    `atomic_stale_target_block` (atomic must NOT re-target latest+1 the way backrun does — its EV assumes
>    the `source_block` state).
> 4. **Per-newHead `atomic_scan_result` event — not only opportunity events (→ A-contract §2 / A4).**
>    Skip / budget / busy paths produce NO opportunity, so scanner suppression is invisible to self-analysis.
>    Emit one `atomic_scan_result{ source_block, state_block, scanned_edges, candidates, skipped_reason }`
>    per newHead regardless of outcome (`ran` / `skipped_busy` / `stale_state` / `budget_exceeded`).
> 5. **`LearningCase` idempotent lifecycle — id + state machine (→ C2).** The census is competitor-tx-driven
>    (no events-offset checkpoint like the backrun watcher), so without identity it re-closes / re-escalates
>    the same case every run. Add `learning_case_id =
>    hash(strategy, trigger, competitor_tx, source_block, cycle_fingerprint, primary_gap)` + a `status`
>    machine (`open → proposed_close → replay_passed → applied → live_verified` | `parked_uneconomic` |
>    `manual_required`). `parked_uneconomic` is the dust-steady-state terminal (re-open only if the spread
>    materially widens) — else the loop re-fires on coffee's sub-EV dust every window.
> 6. **`atomic-view-overrides.json` path correction — a real defect in this md (→ Gap D).** The runtime
>    config root is cwd-relative `searcher/pools/` (mirror `force-include.ts`
>    `resolve("searcher","pools",…)`) → the file is `listener/searcher/pools/atomic-view-overrides.json`,
>    NOT under `src/`. A `src/` path = a file the searcher never loads (analysis writes it, searcher ignores
>    it). Gate: the atomic loader actually READS the written file.
> 7. **Offline-replay state-backend contract (→ C2).** Pin the state source: recent window → local reth;
>    aged-out case → archive RPC / fork provider; unavailable → emit `replay_state_unavailable` (NEVER
>    mislabel unavailable state as a path/pool gap). Cache the verdict per `learning_case_id` (one replay per
>    case-version) so the self-evolution loop is not an archive-CU sink (rule 10 cap).

> **FINAL owner re-review (2026-07-04) — CONDITIONAL APPROVAL: 5 blockers + ONE architecture evolution
> (two-lane), all folded.** The impl spec (`coffee-20260704-atomic-epic-impl-plan.md` §0.3) carries the
> concrete contracts + acceptance; this doc records the WHY. Index:
> 1. **P0-1 (EVOLUTION) — atomic is its own LANE, never a tenant of backrun's `busy`.** The A4 draft had
>    the scan take the global `busy`; but the hint loop DROPS on busy (`main.ts:858` `skip hint` — no
>    queue), so an atomic scan holding the slot 1–2s silently drops backrun victims — and the naive
>    inverse ("atomic always yields") starves atomic on nearly every block in high flow. Decision: two
>    independent lanes (`busy` / `atomic_busy`) sharing ONLY read-only chain reads + ONE
>    `SubmissionCoordinator` (one wallet nonce / one target-block slot — the cross-strategy arbiter);
>    atomic owns its mutable state (own `PoolStateCache` + own sim instance). Honesty: a same-process
>    idle-only atomic is a **learning/measurement tool, not a competitive atomic searcher** — lane
>    isolation is what makes it production-parallel. Same-machine dual-lane first; a 2nd machine only if
>    CPU/IO contends. → impl spec slice **A-lane** (new hard prerequisite of A4) + §1.4.
> 2. **P0-2 (REVISED v1) — swap logs are TRIGGER-only; consistency comes from a fresh-read, not event
>    enumeration.** Swap logs answer "which venues MIGHT have a spread this block", never "all other pools
>    unchanged" — non-swap events (v2 `Sync`/mint/burn, v3 `Mint`/`Burn`, v4 `ModifyLiquidity`/donate,
>    Curve/Balancer add/remove-liquidity) and even eventless direct transfers mutate quote state, and
>    chasing an all-events registry is a bottomless pit. Rule: once the scanner FORMS a candidate cycle,
>    **fresh-read ALL its pools at `source_block` before quote/sim** — spread gone ⇒ drop; any pool
>    unreadable ⇒ drop, never guess. Cost = a few extra local-reth reads (we have reth). Trade recorded:
>    a liquidity-only dislocation triggers no scan until the periodic full sweep (coverage delay by
>    design, never a correctness hole). → impl spec A4.
> 3. **P0-3 (MERGED with P0-2) — return-venue pre-warming.** Delta-updating only swap-touched pools
>    starves the comparison side: the atomic view ≫ backrun's warm set, so a real cycle's RETURN venue is
>    often cold → "have the graph + path, skip on missing state". Bounded neighborhood expansion (touched
>    pool → peer venues on the same pair/ring) forms the cycle; its fresh-read at `source_block` IS
>    P0-2's gate — ONE mechanism, not two seeding rules. → impl spec A4.
> 4. **P1-4 — C2 must split capability vs live-admission.** Full-sweep replay answers "COULD the scanner
>    find it in theory"; live A4 is delta-triggered — a ring whose source block triggered nothing we
>    watch is found by the sweep yet never scanned live. Conflating them misdirects the close action →
>    `capability_replay_stage` + `live_admission_stage`; sweep-found-but-not-triggered ⇒
>    `primary_gap = atomic_scan_not_triggered`, never `atomic_cycle_not_found`. → impl spec C2-minimal.
> 5. **P1-5 — restore view versioning (this doc specified `venue_view_version` in A-contract §2; the impl
>    spec had dropped it — a real regression).** Atomic events AND `LearningCase` carry
>    `strategy_view_version` + `atomic_view_hash`/`backrun_view_hash` (fallback minimum:
>    `pool_universe_generated_at` + `overrides_hash`), else replay-now ≠ live-then, a close can't be
>    proven to have fixed THIS gap, and re-runs confuse "missing-then" vs "fixed-now". → impl spec
>    §1.3/§1.5/A-universe.
> **Re-gated ordering (owner):** **GO now** = C1, A0, A-contract, A-universe, offline-fixture A1–A3
> (+ A-lane). **BLOCKED** = A4 live wiring (until the A-lane gate + the merged P0-2/P0-3 fresh-read gate
> are green) and C2 as the AUTHORITATIVE auto-close judgment (until P1-4 + P1-5 land). Explicitly NOT
> gating: B-residual as scoped, A0's dust fixture, C1's direction.

---

## What is already reusable (do NOT rebuild)

The backrun pipeline is already source-swap-*agnostic* below the trigger. An atomic (no-source-swap) opportunity
reuses almost all of it:

| stage | file:line | source-swap-dependence today | reuse for atomic |
|---|---|---|---|
| block-driven pool-state freshness | `main.ts:764 / :809` (`provider.on("block")` warm + state update), `solver/pool-state-updater.ts` | none — already per-block | **trigger + state source for the scan** |
| cycle enumeration | `planner/token-graph.ts:462` `buildTokenPaths(start,profit)` | none — DFS start→profit is generic | seed with `start===profit` (a cycle) |
| candidate planning | `planner/planner.ts:86` `TemplatePlanner.plan(opp,…)` | pins the impact pool from `opp.hints.impact` (via `impactFromOpportunity`, `planner.ts:413`) — **NOT** `opp.affectedPools`; with no `hints.impact`, `focusPathsOnImpact` returns all paths | plan from a synthetic `Opportunity` that **omits `hints.impact`** (clearing `affectedPools` alone does nothing) |
| amount sizing | `solver/solver.ts:442` `resolveSearchCenter` | ⚠️ `if (victimAmount<=0n) return 1n` does **NOT** fall back to a useful search — see the sizing-seed blocker below | requires a real `searchCenter` seed (missing piece #2) |
| execution / submission | `execution/bundle-router.ts:81` `standalone` → `submitStandaloneBundle` (single next-block tx, **no source-swap rawTx**) | already exists for the mined-source-swap Path C (`main.ts:1139`) | **atomic bundle == standalone bundle** |
| EV / final-verify gate | `main.ts:1606` terminal verify + `evGate` (`main.ts:404`) | none | unchanged |

So the **genuinely missing pieces for Gap A** are three (not two — the sizing seed was missed):
1. a block-triggered *opportunity source* whose search is cheap by construction — an O(pairs) 2-hop
   spread scan to find anchors, then a depth-bounded (≤4 hop) cycle search seeded only from those
   anchors — NOT a whole-graph DFS. See "Path length" below.
2. **an amount-search seed for the no-source-swap path (blocker, verified in code).** The reuse claim that
   `victimAmountIn:0n` "already falls back to the geometric grid + GSS" is **false**. `resolveSearchCenter`
   returns `1n` (`solver.ts:449`); `geometricGrid(1n, halfWidth=3)` is anchored on that center and the
   negative shifts floor to 0 → the grid is exactly **`[1, 2, 4, 8]` wei**. GSS only fires when a grid
   point already quotes a **positive** profit (`solver.ts:196`) and its bracket is only `[bestX/2, 2·bestX]`
   with **no boundary expansion** — so a 1–8 wei probe is rounded to zero and the solver throws
   "no profitable plan". Atomic sizing therefore needs a real `searchCenter` (derive it in A1/A2 from the
   anchor pool depth / spread), not `victimAmountIn:0n`. This is a hard landing blocker, folded into the
   slices below.
3. a no-source-swap **entry point** into the post-detect pipeline (A4) — `handleHint` cannot be fed a synthetic
   hint (see A4); the plan→solve→sim→submit tail must be reachable without a source-swap tx.

---

## Gap A — per-block atomic chain-state scanner (EPIC)

**Root cause (verified in code):** `BackrunDetector.detect` runs only inside `handleHint`, which fires
only on an `OrderflowEvent` from the mempool (`main.ts:1245`). There is **no block-driven scan**. A
standing cross-pool spread with no pending swap produces no hint → no opportunity → never seen. This
matches the doc exactly: "our pipeline never triggers; there is nothing to follow."

**Correction (do NOT re-add the "wstUSR is atomic" claim — verified against `docs/historical-replay.md`):**
the founding wstUSR depeg reference tx (`0xf88b498b…`, block 24710788) is a **backrun, NOT atomic**. The
replay doc shows its source swap is **tx index 0** — a user swap selling 2,800 wstUSR → DOLA that *creates*
the depeg — and the reference bot at index 8 is literally labeled "Reference MEV bot backrun" (indices
2/6/7 are competing partial backruns of the same depeg; the replay must apply tx 0..7 to reach the
dislocated pre-state). So the reference tx has a source swap and is within our **existing** backrun
posture — it is **not** a Gap A example. Gap A's justification is the coffee data (8/9 atomic with no
preceding swap on a shared pool), not this tx. (An earlier merged draft mislabeled it atomic.)

Escalated to an **EPIC** per rule 13 (too big for one 30-min round; ordered slices, each with its own
rule-12 gate). Owner: `atomic-scanner-epic`. Default OFF (`SEARCHER_ENABLE_ATOMIC_SCAN=0`) until A4.

### Path length — from the data (this drives the whole design)

Our searcher's edge is **speed, and short on-chain paths** (fewer hops = less gas, less revert risk,
faster to build/sign/submit). A per-block whole-graph cycle scan is the natural enemy of that. So before
designing the scanner, count coffee's actual atomic path lengths (doc "arb pools" = distinct swap venues
≈ hop count):

| metric | value |
|---|---|
| atomic txs (#1–8) hop counts | `{1, 3, 4, 5, 2, 1, 0, 1}` |
| **average** | **≈2.1 hops** |
| median | 1–2 |
| ≤2 hops | 5/8 (63%) **but each nets ~$0 — dust / likely undercounted** (a 1-pool "arb" is not a closed spread) |
| **3–4 hops** | 2/8 — **#2 (3-pool, $0.33) + #3 (4-pool, $0.18) = ~82% of all realized value** |
| 5 hops | 1/8 (#4) — netted **$0.00** |

**Two conclusions that reshape the plan:**
1. **Cap hops at ~4.** Everything with value sits in the 2–4 band; the one 5-hop netted nothing. A live
   cap `SEARCHER_ATOMIC_MAX_HOPS=4` matches the data and stays inside our short-path posture. (Backrun
   live already runs a small `maxHops`; atomic must be at least as tight.)
2. **Do NOT DFS from every token, then pre-filter.** That is O(cycles) and slow — the opposite of our
   speed edge. The scanner must be cheap **by construction**: find the *anchor* (where a spread exists)
   with an O(pairs) price scan first, and only expand short cycles from anchors. This flips my original
   A1/A2 ordering (the pairwise scan IS the detector, not a post-enumeration filter).

### Ordered slices

**A0 — decode/verify (analysis-decode).**
Fork-replay one coffee atomic tx at its pre-tx state and prove the cycle is reconstructable from public
chain state alone. Pick **#2 `0x803a3693`** (block 25455024, 3 pools, net $0.33 — the richest clean
atomic sample). Reuse the historical-replay harness pattern (`docs/historical-replay.md`).
- **Gate:** replay at pre-tx state reproduces a profitable closed cycle returning to a priced token,
  gross ≈ the doc's figure. Substantiates "contestable with a scanner, no private information" (the
  doc's recommended next step, §Caveats).
- **Deliverable:** a pinned fixture `{block, startToken, cyclePools[], expectedGrossWei}` for A1/A3.

> **2026-07-04 architecture re-review (verified in code) — 6 structural gaps folded in below.** The
> earlier draft under-specified how an `AtomicOpportunity` actually constrains the planner/solver; left
> as-was it would ship a scanner that "sees" the opportunity while the planner/solver still run on backrun
> assumptions. The four load-bearing ones (#1 planner constraint, #2 seed/rotation token unit, #3
> telemetry/bundle contract, #4 shared pipeline entry) become the **A-contract** prerequisite slice;
> #5 (state-block consistency) lands in A4; #6 (classifier venue coverage) in Gap C.

**A-contract — no-source-swap contracts + shared pipeline entry (PREREQUISITE, before any atomic logic).**
Four current contracts are source-swap-shaped; generalize them first or atomic forks a parallel hot path that
drifts from backrun's EV gate / drop-reasons / submission.
1. **`Opportunity` discriminated union** (`detector.ts:6`): `BackrunOpportunity | AtomicOpportunity`.
   `BackrunOpportunity` = today's shape. `AtomicOpportunity` (`kind:"atomic-arb"`) carries **no source-swap
   fields, no `hints.impact`**, and — critically (finding #1) — a **concrete cycle the planner is bound
   to**, not just telemetry: `seedEdges: TokenEdge[]` (the exact anchor cycle), a pinned `flashToken`,
   and `searchSeed:{ searchCenter: bigint; maxInput?: bigint }` in **`flashToken` units** (finding #2).
   Non-test consumers are just `main.ts / events.ts / planner.ts / solver.ts / detector.ts`.
2. **Telemetry contract** (`events.ts:38-109`): `makeOpportunityId` **and every event** currently require
   `victim_hash` (verified). Add `opportunity_kind:"backrun-arb"|"atomic-arb"`, `source_block`,
   `cycle_id`; make `victim_hash` **optional**. Atomic `opportunity_id =
   keccak(source_block | cycle_id | startToken | seedPools)` — **never a fake/empty source-swap hash**
   (which would collide IDs and corrupt live-loss / Hermes analysis keyed on `victim_hash`).
   **Also design the atomic scanner funnel fields NOW (forward-compatible; Gap C/D — the Strategy Learning
   Loop below reads them).** Emit atomic-only:
   `state_block`, `cycle_fingerprint`, `seed_venues`, `venue_view_version`, `strategy_view_used`,
   `scanner_stage`, `scanner_skip_reason?`, `scanner_budget_ms`, `candidate_rank`, `search_center`. Without
   these you can only see "not submitted", never *where* it stalled (no venue in the view / not scanned /
   spread below threshold / sizing seed / quote-fidelity / sim revert / EV gate / lost). Designing them
   into A now (cheap, forward-compatible) avoids re-running windows to backfill telemetry after A ships.
   `cycle_fingerprint` (the cross-searcher JOIN key C2 aligns on — distinct from the internal
   `opportunity_id` above, which may stay route/startToken-specific) = **economic-core, canonicalized,
   route-fuzzy**. Two hard corrections vs the naive `token-pair + rounded size` form, both load-bearing for
   the paying case:
   - **Key on the canonical token-RING, not a "token-pair".** The realized value is in 3–4-hop cycles
     (A0/A2: #2 @3 tokens, #3 @4 tokens = ~82% of value), and a ring of 3–4 distinct tokens has **no single
     pair**. A ring is also rotation- and direction-sensitive — our `startToken`/orientation need not equal
     the competitor's for the *same* loop. So identity = `keccak(source_block | canonicalTokenRing)`, where
     `canonicalTokenRing` is the cycle's token sequence rotated to start at the lowest-address token and
     oriented by a fixed rule (e.g. first hop toward the lexically smaller neighbor) → rotation/direction
     invariant. Plain `token-pair` collapses distinct 3-hop rings that share two tokens into one id (false
     match) and is simply undefined for the 3–4-hop paying case.
   - **Do NOT put size in identity.** `rounded size` is a per-searcher CHOICE (capital, slippage tolerance,
     flash token), not a property of the standing spread — two searchers close the same spread at different
     sizes, so size-in-identity re-introduces the exact `cycle_match=false` false-gap the route-fuzzy choice
     was meant to avoid, just on a new axis. Size, `seed_venues`, and route are **comparison attributes**
     (they feed `primary_gap` and `competitor_profit vs our_simulated_best` in C2), never the join key.
   - **Temporal semantics of `source_block` for a COMPETITOR tx (the alignment off-by-one — mandatory,
     user point 1).** A competitor's atomic tx *executes* in block `B`; to have contested it we scan the
     **end state of `B-1`** and submit targeting `B`. So OUR live atomic event for that same opportunity
     records `source_block = B-1` (and `target_block = B`). C2 MUST therefore align a competitor tx by
     `source_block = competitor_execution_block − 1`, **never by `B` directly** — else our real `B-1` scan
     is joined against the wrong block and reported as `not_seen` when in fact we saw it. Both models agree:
     the delta-driven case (a swap in `B-1` creates the standing dislocation captured in `B`) and a pure
     standing spread both give `source_block = B-1`. The `LearningCase` (C2) carries `source_block = B-1`
     and `target_block = B` explicitly so the join is unambiguous.
3. **Bundle contract** (`bundle-router.ts:5`): make `victimTxHash` **optional** — the `standalone` path
   already ignores it (`bundle-router.ts:81`) and atomic is standalone-shaped.
4. **Factor out `processOpportunities(ctx, opportunities, sourceMeta)`** from the ~900-line `handleHint`
   (the detect→plan→solve→sim→submit tail: detect at `main.ts:1245`, the opportunities loop at
   `main.ts:1275+`), telemetry fields driven by `sourceMeta.kind`.
   Backrun `handleHint` calls it; the atomic block handler (A4) calls it. This is the single shared entry
   that prevents two divergent hot paths (finding #4).
5. **Submission model — atomic is BATCH-per-block, backrun is one-at-a-time (new constraint, verified).**
   Backrun is single-flight: one source swap → one opportunity → one bundle (`busy` guard, `main.ts:847`).
   The atomic scanner emits a **batch** of opportunities per block (A1 many anchor pairs, A2 many rings).
   But the signer nonce is `wallet.getNonce("pending")` (`submitter.ts:296`) and a `standalone` bundle pins
   ONE target block (`blockNumber:0x{targetBlock}`, `submitter.ts:250`) — so **N atomic bundles for block B
   share one nonce + one target block and at most one can land**; concurrent submits merely collide/replace.
   So the atomic caller must **rank by `candidate_rank` and submit only the single best atomic opportunity
   per block** (multi-submission would need explicit nonce-sequencing of a bundle-of-bundles — heavier,
   defer). This is a *contract* decision, not an A4 detail: `processOpportunities` accepts a batch, but the
   atomic caller reduces to one submission/block. (Not a backrun concern — hints arrive serially.)
6. **Cross-strategy `SubmissionCoordinator` — the arbiter both producers feed (nail #2, verified).**
   Point 5 only dedups atomic-vs-atomic; the deeper constraint is that **backrun and atomic are two
   independent producers** (hint-driven vs block-driven) contending for **one wallet, one pending nonce, one
   target-block slot** (`wallet.getNonce("pending")` + a bundle pins ONE target block). The `busy` flag
   serializes CPU but NOT the nonce/target-block slot across the ~12s interval: atomic submits for `N+1`
   (nonce K), then a hint's backrun submits for `N+1` (same pending nonce K) → two live bundles, one nonce,
   **last-write-wins, not best-EV-wins**. So introduce a single arbiter both callers route through: each
   emits a `SubmissionCandidate{ strategy, targetBlock, netEvWei, confidence, deadlineMs }`; the coordinator
   groups by `targetBlock`, ranks by `strategy_priority / net_ev / deadline`, admits **one** per slot, and
   the loser emits `pipeline_dropped` reason `submission_arbitration_lost` (final re-review refinement:
   an atomic candidate/holder losing the slot to a backrun emits the more specific
   `atomic_preempted_by_backrun` — which fires ONLY at this submission slot, never on the scan/read
   path; impl spec §1.4). This is a first-class component,
   not an A4 detail — without it, shipping atomic can DEGRADE backrun (the proven revenue path) rather than
   add a second earner. `strategy_priority` default = backrun-first (protect the working strategy) unless
   atomic `net_ev` exceeds backrun's by a recorded margin; a change to that policy is an economics/human call.
- **Gate (refactor-neutral):** all existing backrun `searcher:planner` + `searcher:replay-live-fixtures`
  pass **unchanged**; a new unit test asserts (a) two distinct anchors in the same `source_block` produce
  **distinct** `opportunity_id`s (no source-swap-hash collision); (b) two rotations/directions of the SAME
  ring produce the **same** `cycle_fingerprint` and two genuinely different rings produce different ones
  (canonical-join invariance — the C2 alignment depends on it); (c) a batch of ≥2 profitable atomic
  opportunities in one block yields **exactly one** `bundle_submitted` (top `candidate_rank`), the losers
  emitting `pipeline_dropped` with a visible `dedup_per_block` reason (not silently swallowed); (d) a
  backrun candidate and an atomic candidate for the **same** target block yield **exactly one**
  `bundle_submitted` and the loser emits `submission_arbitration_lost` — the atomic-loses-to-backrun
  case as `atomic_preempted_by_backrun`, coordinator-only (the cross-strategy arbiter, nail #2).

**A-universe — strategy-scoped pool selection (PREREQUISITE, alongside A-contract, upstream of A1).**
Backrun wants **fast** (few hot pools); atomic wants **broad** (loop-closure coverage). Today they are
**coupled through one universe + one score axis** (verified): `main.ts:592` builds ONE
`graph = buildTokenGraph(allPools)` that feeds BOTH the planner (`main.ts:603`) AND the mempool
`toAddress` filter (`main.ts:2509`), and the single `SEARCHER_POOL_UNIVERSE_TOP_N=1500` (`main.ts:391`)
is simultaneously the backrun latency cap and the planning-breadth cap.
**The real coupling is displacement, not list-size explosion** (correction — the raw-size blowups are
already capped): `buildMempoolToAddressFilterWithRouters` already self-caps to top-200 hot + 300 max
(`main.ts:2820`), and the live planner already prunes to top-8 edges/token (`maxPoolsPerToken=8`,
`main.ts:431`). So widening the universe does NOT inflate the `toAddress` list or explode the DFS. What
DOES break: those capped slots (200 hot / 8 edges) are filled by **one shared score** — atomic-relevant
pools (loop-closure but not source-swap-likely) with high scores **displace** backrun-relevant hot pools →
backrun coverage silently degrades; and conversely the same caps throttle atomic's breadth. **Split them:
`shared venue registry + strategy-specific selection views`, each with its OWN score. The boundary is
venue / admission / scorer level, NOT pool level.** The per-consumer cap machinery already exists
(`maxPoolsPerToken`, the mempool filter's own topN) — this is a **parameterization** (two scored views),
not new infrastructure.
- **Registry stays strategy-agnostic DATA** (`active-pools.json`: address / adapter / tokens / fee /
  score / source). Do **not** tag pools `backrun`/`atomic` — a strategy label is a scorer **output**, not
  a pool property; tagging freezes selection at generation time and explodes maintenance.
- **Per-venue × per-strategy runtime policy is a SEPARATE config** (like `force-include-*.json`), never
  embedded in the regenerated pool JSON (else each discovery rebuild clobbers policy):
  - `backrun`: selection = hot / recent / high-liquidity / source-swap-likely, `maxPools≈1500` (latency-bound).
  - `atomic`: selection = **cross-venue loop-closure = the existing `selectArbRelevantPools`**, promoted
    from build-time (`build-active-pool-universe.ts:238`) to a runtime view — this **unifies with
    `project-pool-scoring-arb-relevance-epic`** (atomic's "does this pool close a loop" scorer IS
    arb-relevance; `main.ts:563` `selectPairCompletionPools` is the nascent runtime seed of it).
    `maxPools` large, consumed under A2/A4's per-block budget inside the atomic lane (P0-1 — its own
    `atomic_busy`, never backrun's slot).
- **One union graph, two edge-selection views** (not two graphs): the planner gets a hot edge-view for
  backrun; the atomic scanner uses the full union graph (it needs it to find cross-venue loops). Reuses
  the planner's existing top-N edge pruning (`maxPoolsPerToken`), and saves memory vs two graphs.
  - **Pin the planner interface, not just the concept (nail #1, verified).** Today `planner.plan(opp,
    templates, opts)` takes NO strategy/view arg and runs one graph set via `setGraph` — so "two views"
    stays doc-only unless the mechanism is fixed. Keep the ONE signature and select the edge-view by
    `opp.kind` (backrun → hot edge-view + `hints.impact` focusing; atomic → full union graph +
    `seedEdges`-constrained, no full-graph DFS), or add an explicit `graphView` opt. Either way, backrun
    and atomic never share one edge set. **Gate:** under a single union graph, the backrun view EXCLUDES an
    atomic-only venue and the atomic view INCLUDES it, asserted independently (ties to the A1 seedEdges gate).
- **Enforcement point (where "atomic breadth must not crowd out backrun speed" bites): the mempool
  `toAddress` filter ranks its 200 hot slots by the BACKRUN score, never the atomic score** — so an
  atomic-relevant-but-not-source-swap-likely pool can never displace a source-swap-likely pool from the mempool
  filter. (Not "hide the 8000 from it" — the filter already self-caps; the point is *which* score orders
  the capped slots.)
- **Gate (rule-12):** widening the atomic universe leaves the backrun mempool `toAddress` **set
  unchanged** (assert the backrun-scored hot slots are not displaced by atomic pools — the decoupling
  proof); AND the atomic view contains ≥1 loop-closure pool absent from the backrun hot set (proves the
  views actually differ).

**A1 — anchor finder: O(pairs) 2-hop spread scan (emits a CONSTRAINED cycle, not a start token).**
Add `detector/atomic-scanner.ts` → `detectAtomicOpportunities(cache, pricedTokens)`: iterate only
**token pairs that have ≥2 venues** in the runtime graph; compare mid-prices from the warm
`PoolStateCache` (constant-product for v2, `sqrtPriceX96` for v3) and flag pairs whose spread exceeds
fees. A flagged pair yields the concrete 2-hop cycle + a `searchCenter` derived from anchor pool
depth/spread (NOT `1n`). **No DFS, no per-token enumeration.**
- **Seed from the block's swap-TOUCHED pools (delta-driven), not a full re-scan of all ≥2-venue pairs
  every block.** On block N, pull N's swap logs on tracked pools → the trigger set → restrict the
  spread scan to pairs touching those pools. This is O(touched pools), not O(all pairs), and it targets
  dislocations *as they form* (a swap in block N creates a standing dislocation from N+1 onward — where
  the race is). The full ≥2-venue sweep stays available as a periodic backstop, but the per-block hot
  path is delta-driven. **(P0-2, final re-review: swap logs are TRIGGER-only — they never prove other
  pools unchanged; the consistency proof is the A4 fresh-read of every candidate-cycle pool at
  `source_block` before quote/sim.)**
- **Emit the cycle as `seedEdges`, and constrain the planner to it (finding #1 — the biggest fix).**
  Verified: the planner ignores `affectedPools`; with no `hints.impact` it re-enumerates the whole graph
  `startToken→profitToken` (`planner.ts:163`) and `focusPathsOnImpact` returns all paths
  (`planner.ts:451`). So an anchor passed only as `affectedPools` would **not** constrain planning — the
  candidate set explodes and drifts off-anchor. Fix: `planner.plan` for `kind:"atomic-arb"` **builds the
  candidate directly from `seedEdges`** (skip `buildTokenPaths` entirely; A2's cycle search is likewise
  emitted as `seedEdges`), or enforces "every path must contain all `seedEdges`". Atomic never triggers
  the full-graph DFS.
- **Pin one `flashToken`, disable rotation for atomic (finding #2).** `buildBorrowabilityRotations`
  (`planner.ts:321`) clones the opp to other flash tokens (`startToken/profitToken := borrowable.token`,
  `planner.ts:358`); a single `searchCenter` would then be applied in the wrong token unit. So an
  `AtomicOpportunity` pins the scanner-chosen `flashToken` and the planner **does not rotate** atomic
  candidates → `searchSeed.searchCenter` is unambiguously in `flashToken` units. (Multi-flash later ⇒
  make `searchSeed` per-token.)
- **Gate (rule-12, `npm run searcher:planner`, deterministic, no anvil):** the anchor fixture flips
  `candidate_plans 0→>0`; **every returned candidate's path contains the seed pools** (assert
  anchor-constrained, not whole-graph); the resolved center is `>8` **and in `flashToken` units** (no
  rotation). (This class is mostly dust in the data; it ships first as the cheapest unblock — value is A2.)

**A2 — bounded short-cycle extension to 3–4 hops (where the value is).**
The paying arbs (#2 @3, #3 @4) are triangles/quads a 2-hop scan can't see. Catch them with a
**depth-bounded negative-cycle search** (Bellman-Ford on `−log(mid-price)` over the warm cache), hard
capped at `SEARCHER_ATOMIC_MAX_HOPS=4` and seeded only from the A1-anchored tokens — NOT a whole-graph
DFS from every token. Bounded depth + anchored seeds keep it inside the between-block budget.
- **Gate 1 (rule-12 correctness, `searcher:planner`):** pin the A0 fixture (#2, 3-hop) → the cycle is
  found and `candidate_plans 0→>0`.
- **Gate 2 (rule-12 latency, new `searcher:bench-atomic`):** full per-block scan (A1+A2) cost stays
  under the between-block warm budget at `maxHops=4` (relative, harness-bound per rule 12). If it can't,
  drop to `maxHops=3` (still captures #2, the richest) and record the trade-off — never widen hops past
  what the budget allows just to chase the 5-hop tail that netted $0.
  - **Headroom is real (measured):** the atomic deadline is the **next block (~12s)**, far looser than the
    5s backrun TTL, and a full planner pass measured **114ms @ 4216 pools** (`project-topn-latency-curve`).
    So the budget lever is comfortable; the delta-driven seeding (A1) keeps the common case far under it.

**A3 — no-source-swap solve + sim + standalone build (end-to-end on fork).**
Teach `resolveSearchCenter` (`solver.ts:442`) to read `AtomicOpportunity.searchSeed.searchCenter` instead
of the `1n` fallback (dispatch on `opp.kind`; backrun path unchanged). The seed is in `flashToken` units
and atomic rotation is disabled (A1), so the center is unambiguous. Then run the A0 fixture through
`solver.solve` (no `localVictimApply` → sims on the current fork directly, exactly like the
standalone/mined path) → terminal verify → `standalone` bundle build.
- **Gate (rule-12, `npm run searcher:replay-live-fixtures`):** `sim.success=true`, net-EV > 0 after
  gas, EV gate passes, a `standalone` `BundleSubmission` is produced (DryRun signs it). **The gate must
  also assert the solver's search center came from `searchSeed`, not `1n`** (else A1's dust-grid failure
  mode is silently reintroduced — log the resolved center and assert `center > 8` for this fixture).
  Records the rule-12 quartet (`failing_sample / fix_commit / replay_command / expected_transition:
  atomic_scan no_candidate→sim.success+standalone`).

**A4 — live wiring + dry-run window.**
Two design constraints the earlier draft got wrong (verified in code):
- **Entry point — do NOT feed a synthetic hint to `handleHint` (missing-piece #3).** `handleHint`
  (`main.ts:954`) is source-swap-parse all the way down: Path A needs hint logs + `enableHashOnly`, Path B
  needs a rawTx, Path C calls `getTransaction(txHash)` (a fabricated hash throws), and the tail is
  `detector.detect(event)` (`main.ts:1245`), which produces opportunities from **swap logs** — a
  log-less synthetic event yields 0 and exits at "no matching graph pool". The correct wiring is to
  **factor out the post-detect pipeline** (plan → solve → sim → terminal-verify → submit, `main.ts` ~1275+)
  into a function that takes an `Opportunity[]` directly, and have both `handleHint` and the atomic block
  handler call it. The atomic handler skips detect entirely and passes the scanner's `AtomicOpportunity[]`.
- **Scheduling — EVOLVED by the final owner re-review (P0-1): atomic is its OWN lane, never a tenant
  of the hint loop's `busy`.** The earlier "idle-only (skip if `busy`)" design here was wrong twice
  over: the hint loop DROPS on busy (`if (busy) … skip hint`, `main.ts:858` — it does not queue), so
  any atomic scan holding `busy` 1–2s silently drops backrun victims; and an atomic that always
  yields on a shared hot path never runs in high flow. Neither producer may gate the other's read
  path:

  ```
  newHeads ──> AtomicLane  ── scan/solve/sim (atomic_busy, OWN cache + sim instance) ──┐
                                                                                       ├─ SubmissionCoordinator ─ submit
  mempool  ──> BackrunLane ── detect/solve/sim (busy, today's hot path — unchanged)   ┘
  ```

  The lanes share the read-only local reth and nothing mutable; the single coordinator (one wallet
  nonce / one target-block slot) is the ONLY cross-lane arbitration point, and
  `atomic_preempted_by_backrun` fires only there — at the submission slot, never on the read/scan
  path. Same-machine dual-lane first; split to a 2nd machine only if CPU/IO contends. Behind
  `SEARCHER_ENABLE_ATOMIC_SCAN` (default 0). The concrete lane contract — plus the Node event-loop
  caveat (one JS thread: a sync scan still blocks hint processing, so the scan runs in bounded pure
  chunks with cooperative yields) — is the impl spec's **A-lane** slice, now a hard prerequisite of
  A4.
- **State-block consistency — a hard gate, not an assumption (finding #5).** Atomic state-arb depends
  entirely on the end-of-block state. But the per-block warm + state-update are async/debounced listeners
  on the same `block` event (`main.ts:764 / :809`), so a scan firing on `block N` can read a
  `PoolStateCache` still seeded at `N-1` → false positives/negatives that also make replay non-reproducible.
  Require: the scanner reads a `state_block`, all changed-pool reads use the **same `blockTag`**, and the
  scan only proceeds when `state_block === source_block` — otherwise **skip the block** (do not enter the
  solver on stale state). Record both `source_block` and `state_block` on every atomic event so a drift is
  visible in the dry-run, not silent.
  **Sharpened by the final re-review (P0-2 revised + P0-3, merged):** the swap-touched set is a
  TRIGGER, never a consistency proof (non-swap events + eventless transfers also mutate quote state —
  do NOT chase an all-events registry). The implementable form is ONE rule: expand the touched pools
  to their peer/return venues (bounded — the atomic view ≫ the warm set, so the return venue is
  usually cold), **fresh-read every candidate-cycle pool at `blockTag=source_block` into the atomic
  lane's own cache BEFORE quote/sim**; spread gone after fresh-read ⇒ drop, any cycle pool unreadable
  ⇒ drop (`atomic_state_inconsistent`), never guess. Accepted trade: a liquidity-only dislocation
  (no swap in N) waits for the periodic full sweep — a coverage delay, never a correctness hole.
- **Submit-time target-block expiry — a hard drop, not a re-target (nail #3, verified).** Backrun recomputes
  `target = latest + 1` at submit (`main.ts:1832`), self-correcting if a block arrived mid-processing. Atomic
  must NOT: its EV assumes the `source_block` state, so `target` is fixed at `source_block + 1`. If `latest`
  advanced past `source_block` between scan and submit, the pinned target is stale and the state assumption is
  void → **drop and emit `atomic_stale_target_block`**, never submit to a re-targeted block.
- **Per-newHead `atomic_scan_result` telemetry (nail #4, verified).** The `busy` / budget / stale-state skips
  produce NO opportunity, so scanner suppression is otherwise invisible. Emit exactly one
  `atomic_scan_result{ source_block, state_block, scanned_edges, candidates, skipped_reason }` per newHead
  regardless of outcome (`ran` / `skipped_busy` / `stale_state` / `budget_exceeded`) — so self-analysis can
  distinguish "no spread existed" from "scanner was starved by backrun".
- **Runtime circuit-breaker (extends the merge-time regression guard into production).** The A4 gate below
  is a one-time merge check; production also needs a runtime breaker: if backrun `expired-before-solver` /
  hot-path p95 crosses a threshold in a live window, auto-disable the atomic scan for that window and alert
  (the scanner-scoped analog of the bounded-live safety valve, Safety Rule 1) — never let atomic silently
  degrade the proven backrun path.

Hook the scan into `provider.on("block")` in `main.ts` under those constraints. Deploy
(`scripts/deploy-node.sh`), run a dry-run window, run the mandatory Step-1 competitor cross-reference
over coffee's blocks.
- **Gate (metrics, non-deterministic per rule 12 exemption):** atomic `opportunity_seen>0` in the
  window, ≥1 atomic `simSuccess` on a real block, and Step-1 shows we now generate a competing
  candidate for ≥1 of coffee's atomic txs. **Regression guard (P0-1): backrun `expired-before-solver`
  + hint `prep_ms p95` must not rise materially vs the pre-atomic baseline AND zero `skip hint`
  emissions attributable to the atomic lane** (proves lane isolation held under live flow — neither
  producer gated the other's read path).
  **Every newHead emits an `atomic_scan_result` (nail #4); every atomic event has
  `state_block === source_block`; any submit with `latest > source_block` shows `atomic_stale_target_block`,
  never a bundle to a re-targeted block (nail #3).**
  Carry to the next round if the window is thin (extend the window, do not conclude a true negative —
  the R3 trap).

### Gap-A sequencing note
Order: **A0 (decode) + A-contract (contracts/refactor) + A-universe (pool-selection split) → A1 → A2 →
A3 → A-lane (P0-1 lane isolation) → A4.** A-contract and A-universe are both prerequisites — nothing
atomic ships before them, or the hot
path forks (A-contract) and backrun-speed/atomic-breadth fight through one universe (A-universe); A-lane
is the third hard prerequisite, of A4 specifically — no LIVE wiring before lane isolation. The real
engineering surfaces are **A-contract** (the shared `processOpportunities` split-out from the ~900-line
`handleHint`), **A-universe** (two selection views + mempool-filter-from-backrun-view; overlaps the
arb-relevance epic), **A2** (bounded 3–4 hop cycle cost, policed by the latency gate; hop cap 4→3 is the
lever), **A-lane** (own `atomic_busy`/cache/sim + chunked cooperative yields), and **A4** (lane wiring +
trigger→expand→fresh-read consistency). A1's O(pairs) scan is
cheap. A4 is flag- + dry-run-gated (and BLOCKED until the A-lane + fresh-read pre-gates are green);
go-live stays a human gate. **Per-pool force-include pins for this
class are forbidden once epic'd (rule 13); only these slices touch it.**

---

## Gap B — mempool flow-admission (bounded router widening)

**Root cause (verified):** `MEMPOOL_ROUTER_ADDRESSES` is a fixed ~14-address set (`main.ts:208`);
`buildMempoolToAddressFilter` (`main.ts:2809`, impl `buildMempoolToAddressFilterWithRouters` `main.ts:2816`)
= those routers + pinned pools + top-N hot pools. The subscription is a **server-side
`alchemy_pendingTransactions` `toAddress` filter** (`main.ts:2859`), so we cannot "admit by pool-touch"
at subscribe time — we don't know the touched pool until we fork the tx. The code explicitly refuses the
hash-firehose fallback (`main.ts:2870`). So the only correct fix is
to **widen the address set in a bounded, evidence-based way**, not go unfiltered.

**Fix — a discovered-router set (mirrors the pool-universe / force-include pattern):**
1. `listener/src/searcher/discover-routers.ts` + `npm run discover-routers`: offline/periodic scan of
   recent blocks on the **local reth** (zero-CU) for `to` addresses that emit swap logs on our indexed
   pools, above a min-frequency threshold. Persist to a committed `discovered-routers.json` (survives
   deploy, like `force-include-poolids.json`).
2. Merge `discovered-routers.json` into the `toAddress` set at load. **Budget in buckets, not first-come
   (verified concern):** in `buildMempoolToAddressFilter` the fixed routers sit at the head of
   `candidates` and win the 300 cap first-come, so hardcoded routers are never evicted — but discovered
   routers and hot pools then fight over the remainder, and a large discovered set can starve hot pools
   (or vice-versa). Give each class its own quota (fixed routers → discovered top-K → hot pools top-N),
   so widening admission does not silently drop hot-pool coverage. Raise
   `SEARCHER_MEMPOOL_FILTER_MAX_ADDRESSES` only as needed for the quotas.
   - **Precondition, not just a bigger cap:** confirm the Alchemy server-side `alchemy_pendingTransactions`
     `toAddress` list length limit before raising the cap — exceeding it makes the whole filtered
     subscription fatal (`FatalMempoolSubscriptionError`), which is worse than a truncated list.
   - **CU/latency abort criterion:** more admitted routers ⇒ more pending txs ⇒ more forks ⇒ CU + hot-path
     latency. Measure `pendingFilteredReceived` and hot-path p50/p95 before/after in the A3-style window;
     keep discovered top-K tunable; **abort = a hot-path p95 regression.** Widen only while the wider flow
     measurably pays.
- **Gate (rule-12, deterministic, from committed reth logs):** pin #9's source-swap tx `0x8e0c59b4…`
  (`to=0x663dc15d…`) as a fixture; assert after discovery `0x663dc15d` ∈ merged set AND
  `buildMempoolToAddressFilter` would include it under the quotas → admission flip `false→true`. Also
  assert hot-pool coverage is not reduced below its own quota by the merge.
- **Honesty:** #9 netted **−$0.19** (a lower bound, understated) → low value on this one sample. Do it
  because it is a cheap, genuine coverage hole and it unblocks *measuring* whether the wider flow pays —
  not because this tx pays. **Bounded widening only** (evidence-gated addresses, capped count).

Connects to memory `project-mempool-router-allowlist-blindspot`.

---

## Gap C — strategy comparison layer + classifier + self-evolution report (rule 16)

**Root cause:** the followability judgment (atomic vs backrun; "did we see the source swap") was done by
hand (`coffee-backrun-verify.mjs`). Rule 16 requires a hand analysis that exposes a tooling gap to become
a one-command capability, or the cycle does not close. **The classifier is only step 1.** backrun already
has a learning loop (bundle-postmortem → `route_gap_decisive` → `auto-close-route-gap` → pending-deploy;
entry `route-gap-watcher.ts:73`, close `auto-close-route-gap.ts:72`), but that loop keys **only** on our
own `bundle_not_included` (`route-gap-watcher.ts:148`) — i.e. "we submitted and lost". The dominant atomic
failure is different: **a competitor captured a standing spread and we never generated an atomic
opportunity at all** — no bundle, so it never enters that loop. This is the already-acknowledged-but-unwired
`not_seen` bridge (memory `project-coffeebabe-census-notseen-bridge`: "auto-close of not_seen NOT wired";
CLAUDE.md §6c defines the `not_seen` branch but stops at census). Gap C builds the **comparison** half of
one strategy-aware learning loop; Gap D builds the **close** half.

### C1 — the classifier (step 1, standalone; can ship first)
- Extend `analysis` `live-loss` / census with a per-competitor-tx **shape** field: for each arb pool in
  the tx, `eth_getLogs` the same block for a preceding swap at a **lower tx index** → 0 preceding =
  `atomic_state_arb`, ≥1 = `backrun`, indeterminate = `unknown` (the exact `coffee-backrun-verify.mjs`
  logic, made permanent). Emit `source_swap_hash`, `source_swap_seen_by_us`, `source_router`.
- **Decode via a unified swap-log registry, not three hardcoded topics (finding #6).** Verified:
  `victim-source.ts:124` `decodeSwapLog` handles only UniV2/V3/V4 topics — no Curve `TokenExchange` /
  Balancer. If the shape classifier inherits that, a backrun whose source swap sat on a Curve/Balancer
  pool finds **0 preceding swaps** and is **mislabeled `atomic_state_arb`** (a followable opp wrongly
  called non-followable). The classifier must decode the full set the analysis layer already claims to
  support — **UniV2 / V3 / V4 / Curve / Balancer** — via one shared swap-log registry, so the verdict is
  production-general, not valid only for coffee's 9 v2/v3/v4 txs.
- **Fix the `sender-flow.ts` bug (verified — this is a real defect, not just a reframe).**
  `classifySenderFlow` (`analysis/src/pnl/sender-flow.ts:44-49`) currently returns `("private","high")`
  on `coinbaseTransferWei>0` **or** `maxPriorityFeePerGas===0 || priorityTip===0`, and those branches sit
  **above** the `seenInOurPublicFeed===true` check — so a tx we literally saw in our public feed gets
  stamped `private/high` if it has a zero tip. That directly contradicts coffee correction #1 (0 tip +
  coinbase transfer = bundle submission, universal to MEV searchers, **not** proof of private orderflow).
  Split the single `flow` axis into two independent ones:
  - `submission_method = bundle | public_mempool | unknown` — 0 tip + coinbase transfer ⇒ at most
    `bundle` (never "private"; a bundle can carry public-mempool-origin flow).
  - `source_visibility = seen_by_us | not_seen_by_us | unknown` — driven by `seenInOurPublicFeed` /
    `victim-source.ts`, and **evaluated before** the fee heuristics so a seen tx is never overridden.
  Migrate every reader of the old `flow:"private"` (bundle-postmortem, census) to the two-axis result.
- Reuse `pnl/victim-source.ts` (source visibility) as the `source_visibility` driver. `bundle-postmortem`
  already has `winner_style` — add `atomic_scan_shape` so the census reports **followable vs
  non-followable** per competitor automatically.
- **Gate (rule-12, `analysis` test):** pin coffee's 9 txs (from the source doc's table) as a fixture;
  assert the classifier returns **8 `atomic_state_arb` + 1 `backrun`**, `#9`
  (`0xc9ad7160…`) resolves `source_swap_hash=0x8e0c59b4…` with `source_swap_seen_by_us=false`, and
  **no tx with `maxPriorityFeePerGas=0` is labeled `source_visibility=private`** (the regression the
  bug would reintroduce). Deterministic.

Also records the doc's two corrections so they aren't repeated: "private" overstated (`maxPrio=0` is
just bundle+coinbase), "dust" imprecise (report per-tx net USD vs the $0.1 line).

### C2 — strategy comparison report (minimal C2 BEFORE A4; full self-evolution with/after A)

Today's census (`census-report.ts:150`) is **coverage-only**: it flags a competitor's touched venues that
are out-of-graph (`in_graph === false`, `census-report.ts:170`) to feed the backrun route-gap close. That
is blind to atomic "we never generated it". Upgrade census from a coverage report to a **strategy
comparison report**: for every competitor tx classified `atomic_state_arb`, align it to our side by
`cycle_fingerprint` (economic-core-exact + route-fuzzy, per A-contract — NOT `victim_hash`) and emit:
```
competitor_shape   = atomic_state_arb
our_atomic_seen    = true | false          (did any of our atomic events share the cycle_fingerprint)
cycle_match        = true | false
our_stage          = not_scanned | cycle_not_found | no_plan | no_quote | sizing_failed |
                     sim_failed | below_ev | submitted_lost
primary_gap        = <one atomic gap class, below>
next_action        = <owner + close action>
competitor_profit  vs  our_simulated_best
```
- **Atomic gap taxonomy (its OWN, not backrun's).** backrun's classes (`router_not_watched /
  source_swap_not_seen / pool_not_in_graph / path_no_plan / outbid`) don't fit — atomic has no source swap
  to miss and no first-mover to be outbid by in the same way. Atomic classes, each with owner + close action:

  | atomic gap class | owner / close action |
  |---|---|
  | `atomic_venue_disabled` / `atomic_venue_adapter_missing` | venue-adapter epic (shared) |
  | `atomic_view_missing_venue` | atomic venue selection / scorer (A-universe) |
  | `atomic_scan_not_triggered` | scanner wiring / scheduling (A4) |
  | `atomic_cycle_not_found` | scanner cycle search / hop cap / anchor logic (A1/A2) |
  | `atomic_sizing_failed` | `searchSeed` / amount search (A1/A3) |
  | `atomic_quote_fidelity_failed` | quote/sim adapter |
  | `atomic_sim_revert` | plan-builder / sim |
  | `atomic_below_ev_gate` | economics (human gate — a bid-posture change is not autonomous) |
  | `atomic_budget_skipped` | scanner budget / scheduling (A4) |
  | `atomic_competitor_faster_or_outbid` | economics / latency (human gate) |

- **Two comparison sources — live AND offline counterfactual replay (user point 2, mandatory).**
  `our_atomic_seen` / `our_stage` must NOT depend only on live atomic events. Many key samples are
  historical, or predate atomic telemetry, so a live-only C2 stalls every early case at
  `our_stage=not_scanned` — useful for round 1, useless for localization after. Support BOTH sources:
  ```
  live comparison:        competitor tx  vs  our live atomic events   (cycle_fingerprint align at B-1)
  offline counterfactual: competitor tx → replay the atomic scanner at prestate source_block (B-1)
                          → observe exactly where OUR pipeline would stop
  ```
  The offline path drives `our_stage` from an ACTUAL scanner replay (scanner_found? candidate_plans?
  solver_quote? sim.success?), exactly like backrun's rule-12 replay — so an atomic gap closes
  deterministically instead of waiting for the same standing spread to recur live. Pre-A the replay
  reports `atomic_scan_not_triggered` (build A); once each slice lands, the SAME historical sample must
  show the stage flip.
  - **Capability vs live-admission — two verdicts, never one (P1-4, final owner re-review).** A
    full-sweep replay answers "COULD the scanner find it in theory"; live A4 is delta-triggered, so a
    ring whose source block triggered no venue we watch is found by the sweep yet never scanned live.
    The replay therefore reports BOTH `capability_replay_stage` (full sweep) and
    `live_admission_stage` (given the then-current swap-trigger set at `B−1`, the sweep cadence, and
    the budget). Sweep-found but not delta-triggered ⇒ `primary_gap = atomic_scan_not_triggered`
    (scheduling/admission — an A4-class fix), NEVER `atomic_cycle_not_found` (scanner logic — an
    A1/A2-class fix). Conflating them misdirects the close action. **C2's verdict is not an
    authoritative auto-close input until this split (and P1-5's view versioning) lands.**
  - **State-backend contract (nail #7, mandatory — offline replay needs B-1 pool state).** The scanner
    reads pool reserves / `sqrtPriceX96` at `source_block = B-1`; our reth is `--full`/pruned (~10k blocks),
    so aged-out cases have NO local state. Pin the source explicitly: recent window → **local reth** (zero
    CU); aged-out pinned case → **archive RPC / fork provider**; if NEITHER can serve `B-1` → emit
    `replay_state_unavailable` and STOP — never let missing state be silently classified as a path/pool gap
    (a false self-evolution conclusion on historical samples). **CU discipline:** cache the replay verdict
    per `learning_case_id` (one replay per case-version), so re-running the census does not re-hit archive
    RPC and blow the daily CU cap (rule 10).
  - **Gate (rule-12, offline replay):** given a competitor atomic tx at block `B`, replay the scanner at
    `B-1`; the report records `scanner_found / candidate_plans / solver_quote / sim_success` → `primary_gap`,
    and the same sample flips once the owning slice ships (`atomic_cycle_not_found → candidate_plans>0`,
    `atomic_sizing_failed → sim.success`).
- **Unified `LearningCase` schema — one learning loop, not two report shapes (user point 3, mandatory).**
  Both strategies' analyzers emit ONE object; D consumes ONLY `LearningCase`, never a per-tool report
  shape — else atomic becomes a bypass the moment auto-close understands only one report:
  ```
  LearningCase {
    learning_case_id:    string     // hash(strategy,trigger,competitor_tx,source_block,cycle_fingerprint,primary_gap)
    status:              "open" | "proposed_close" | "replay_passed" | "applied" |
                         "live_verified" | "parked_uneconomic" | "manual_required"
    strategy:            "backrun" | "atomic"
    trigger:             "bundle_not_included" | "competitor_not_seen"
    competitor_tx?:      string
    our_opportunity_id?: string
    source_block?:       number     // atomic: competitor_execution_block − 1
    target_block?:       number     // atomic: competitor_execution_block
    comparable:          boolean    // atomic_loop only; one_leg_inventory / sandwich ⇒ false
    primary_gap:         string
    strategy_view_version?: string  // P1-5 (+ atomic_view_hash / backrun_view_hash): which live view
                                    // was in effect / which view the replay ran against — a close is
                                    // provable only if the stage flip is attributable to a view change
    capability_replay_stage?: string   // P1-4: full sweep — "could the scanner find it"
    live_admission_stage?:    string   // P1-4: delta replay — "would live have scanned it then"
    evidence:            {...}
    close_action:        {...}
    replay_gate:         {...}
  }
  ```
  - **Idempotent lifecycle (nail #5, mandatory — this is what makes the atomic loop safe to re-run).**
    The backrun watcher is idempotent for free via its events-stream checkpoint offset; the atomic census is
    **competitor-tx-driven** (re-analyzes the same historical txs every cycle) and has NO such checkpoint, so
    without `learning_case_id` + `status` it re-emits closes and re-packages `pending-manual-analysis` for
    the same case on every run. Persist a processed-case store keyed by `learning_case_id`; a case only
    advances its `status` forward. `parked_uneconomic` is the **dust-steady-state terminal** (coffee's 8/9
    sub-EV atomic txs land here): it does NOT re-open, does NOT block cycle-close (rule 13), and re-opens
    ONLY if the same `cycle_fingerprint` reappears with a materially wider spread — else the loop generates
    infinite noise on known dust.
  `bundle-postmortem` (backrun) and the atomic census both OUTPUT `LearningCase`; `auto-close-strategy-gap`
  (Gap D) / the route-gap-watcher INPUT `LearningCase`. This is a refactor of the existing backrun outputs
  onto the shared object (done with D), NOT a second platform — it is what makes "one strategy-aware loop"
  real instead of aspirational. `comparable=false` (a `one_leg_inventory` / `sandwich` winner, reusing the
  existing `winner_style` filter) short-circuits before auto-close so the atomic loop never manufactures a
  false coverage gap from a CEX-DEX inventory op.
- **Ordering — a MINIMAL C2 ships BEFORE A4 (user point 6).** A4's gate literally reads "Step-1 shows we
  now generate a competing candidate for a coffee atomic tx"; without C2 that Step-1 is a HAND analysis and
  atomic's first live round has no real self-analysis. So a minimal C2 — read atomic events + competitor
  tx, align by `cycle_fingerprint` at `B-1`, emit an offline-replay-driven `primary_gap` — is a **hard
  prerequisite of A4**, not an after-A add-on. The competitor side (shape + `cycle_fingerprint`) is
  computable from chain data alone; the full report (`competitor_profit vs our_simulated_best`, the whole
  taxonomy) fills in with/after A. **C1 first; C2-minimal before A4; D (close half) after.** Do not build
  the full comparison platform before A0 proves atomic is a real +EV opportunity, not pure dust.
- **Gate (rule-12):** on coffee's 8 atomic samples, C2 emits **both** `competitor_shape=atomic_state_arb`
  **and** a per-tx atomic `primary_gap` — never just `atomic_state_arb` with no diagnosis of *our* gap;
  and every emitted `LearningCase` carries `source_block = competitor_block − 1` (the point-1 join key).

---

## Gap D — strategy-aware auto-close loop (the close half; build with/after A)

The current closer `auto-close-route-gap.ts:72` is strategy-**blind**: it appends the missing pool to
`force-include-poolids` (`auto-close-route-gap.ts:10` → `appendForceIncludePoolIds`), which feeds the
**shared** graph and therefore the backrun mempool `toAddress` set. **Verified consequence: a
strategy-blind close on an atomic miss would force-include the pool into backrun's hot set — exactly the
A-universe crowding ("atomic breadth must not crowd out backrun speed").** So D is not cleanup; it is the
close-side *enforcement* of A-universe's decoupling.

**Fix — wrap the closers in a strategy-aware dispatcher `auto-close-strategy-gap` (input: `LearningCase`;
dispatch on `strategy`):**
- `backrun` miss → backrun view / router universe / route-gap close (today's `auto-close-route-gap`, unchanged).
- `atomic` miss → **atomic** view / venue scorer / atomic scanner only — **never** the backrun view.
- `shared adapter missing` → the venue-adapter epic (touches neither view's ranking).
- **Durable close target — a SEPARATE atomic artifact, never backrun's force-include (user point 4,
  mandatory).** D states the principle ("atomic view only") but pins no FILE, so an implementer will
  reflexively reuse `force-include-poolids.json` — which feeds the shared graph + the backrun mempool
  `toAddress` set and crowds out backrun slots in the hot path (the exact A-universe violation, now on the close side). Pin
  the atomic durable close target explicitly, a strategy-view policy file parallel to `force-include-*.json`
  (per A-universe "per-strategy runtime policy is a SEPARATE config"):
  **`listener/searcher/pools/atomic-view-overrides.json`** — the runtime config root is cwd-relative
  `searcher/pools/` (mirror `force-include.ts` `resolve("searcher","pools",…)`), **NOT** `src/searcher/pools/`
  (nail #6 — a `src/` path is a file the searcher never loads: analysis writes it, searcher ignores it).
  Committed, survives deploy; loaded ONLY into the atomic selection view. **Loader gate: the atomic view
  must actually read the written file.** Rule:
  ```
  atomic_view_missing_venue
    → write atomic-view-overrides.json ONLY
    → does NOT touch force-include-poolids.json / any backrun force-include
    → does NOT change the mempool toAddress set
  ```
- A **strategy-agnostic trigger**: not just our `bundle_not_included` (which atomic never emits), but also
  the C2 `not_seen` / `our_stage != submitted` result on a competitor `atomic_state_arb` tx. It writes a
  pending task per gap class (marks `pending-deploy`; never auto-broadcasts — go-live is a human gate).
- **Gate (rule-12, the self-evolution flip — this is the whole point):** each atomic gap close records
  `before: <competitor sample> → our gap X` and `after replay: same sample → stage improved`, e.g.
  `atomic_cycle_not_found → candidate_plans>0` or `atomic_sizing_failed → sim.success && netEV>0`.
  **AND** the A-universe safety assertion: closing an `atomic_view_missing_venue` writes
  `atomic-view-overrides.json` only and leaves `force-include-poolids.json` + the backrun-scored mempool
  `toAddress` set unchanged. A close with no before→after stage flip does not count as closed (rule 13 —
  no orphan findings).
- **Inconclusive atomic loss → the §6b/§6c manual-escalation meta-loop (not a dead `our_stage`).** When
  C2 marks a COMPARABLE (`comparable=true`) atomic_loop competitor we demonstrably lost yet the dispatcher
  closes 0 (a scanner blind spot coverage-close cannot fix — the atomic analog of the `0xee7b98ad`
  same-pool under-capture), package `{LearningCase + close result(closed=0) + our sim/bid + winner
  flows}` as a `pending-manual-analysis` for a fresh analyst (Fable priority, Opus 4.8 fallback) → name the
  missed class → CODIFY it back into the tool (rule 16). Same teeth as backrun: a package left unanalyzed
  BLOCKS closing the cycle.

---

## Verification summary (the gates, in order)

| slice | harness / command | expected transition (rule-12) |
|---|---|---|
| A0 | fork replay at pre-tx state (`docs/historical-replay.md` pattern) | atomic cycle reproduced from public state, gross > 0 |
| A-contract | `searcher:planner` + `searcher:replay-live-fixtures` (refactor-neutral) | backrun tests pass unchanged; two anchors in one `source_block` → **distinct `opportunity_id`s**; **same ring in 2 rotations/directions → same `cycle_fingerprint`** (canonical-join invariance); **≥2 profitable atomic opps in one block → exactly one `bundle_submitted`** (losers `dedup_per_block`); **backrun+atomic for the SAME target block → exactly one submitted, atomic loser `atomic_preempted_by_backrun` (coordinator-only; atomic-vs-atomic loser `submission_arbitration_lost` — nail #2 cross-strategy arbiter)** |
| A-universe | new `searcher:universe-split` unit test | widening the atomic universe leaves the backrun-scored mempool `toAddress` **set unchanged** (no atomic displacement); atomic view has ≥1 loop-closure pool absent from the backrun hot set; **planner backrun view EXCLUDES / atomic view INCLUDES an atomic-only venue (nail #1 interface)** |
| A1 | `npm run searcher:planner` | anchor flips `candidate_plans 0→>0`; **every candidate path contains the seed pools** (anchor-constrained, not whole-graph); center `>8` in `flashToken` units |
| A2 | `searcher:planner` + new `searcher:bench-atomic` | #2 3-hop cycle found (`candidate_plans 0→>0`); full scan < between-block budget at `maxHops≤4` |
| A3 | `npm run searcher:replay-live-fixtures` | `sim.success + net-EV>0 + standalone bundle built`; **search center from `searchSeed`, not `1n` (`center>8`)** |
| **A-lane (NEW, P0-1)** | new `searcher:atomic-lane` unit test | backrun hint injected mid-atomic-scan IS processed — **zero `skip hint` attributable to the atomic lane**; hint start-delay bounded by one scan chunk (event-loop yield proof); `skipped_busy` = own-lane overrun only; `atomic_preempted_by_backrun` fires ONLY at the submission slot; backrun suites unchanged with the lane constructed-but-idle |
| A4 (**BLOCKED until A-lane + the P0-2/P0-3 fresh-read pre-gates are green**) | dry-run window + Step-1 cross-ref | atomic `opportunity_seen>0`, ≥1 atomic `simSuccess`, competing candidate for a coffee atomic tx; **backrun `expired-before-solver` not materially higher AND zero lane-attributable `skip hint` (P0-1)**; **every atomic candidate entering solve/sim has ALL cycle pools fresh-read at `source_block` (P0-2/P0-3 merged gate — un-fresh or unreadable ⇒ drop, never quote)**; **every newHead emits `atomic_scan_result` (nail #4)**; **a scan whose `latest>source_block` at submit shows `atomic_stale_target_block`, never a bundle (nail #3)**; atomic events carry the P1-5 view fields |
| B | `npm run searcher:planner`-style fixture on committed reth logs | `0x663dc15d ∈ mempool filter` (under quotas) → admission `false→true`; hot-pool quota preserved |
| C1 | `analysis` classifier test | coffee 9 txs → 8 `atomic_state_arb` + 1 `backrun`; `#9 source_swap_seen_by_us=false`; **no `maxPrio=0` tx labeled private**; **classifier decodes v2/v3/v4/Curve/Balancer** (a Curve/Balancer source swap is not mislabeled atomic) |
| C2-minimal (BEFORE A4; **not an authoritative auto-close input until P1-4 + P1-5 are green**) | `analysis` comparison test + offline scanner replay (harness lives in `listener`, reused by `analysis`) | each coffee atomic tx aligns at `source_block = B−1`, emits **both** `competitor_shape` **and** an offline-replay-driven `primary_gap` (never `atomic_state_arb` with no diagnosis of our gap); alignment by `cycle_fingerprint`, not `victim_hash`; every `LearningCase` carries `source_block=B−1`, a `learning_case_id` + `status` (nail #5); **an aged-out case with no B−1 state emits `replay_state_unavailable`, never a false path/pool gap (nail #7)**; **P1-4: a sweep-found ring whose source block triggered no delta scan ⇒ `primary_gap=atomic_scan_not_triggered`, NOT `atomic_cycle_not_found`**; **P1-5: the same case replayed before/after a close shows the `atomic_view_hash` change and the stage flip attributable to it** |
| C2-full (with/after A) | `analysis` comparison test | `competitor_profit vs our_simulated_best` + full taxonomy; `comparable=false` (one_leg_inventory/sandwich) short-circuits before auto-close |
| D (with/after A) | replay per gap class | consumes `LearningCase` (both strategies); before→after stage flip (e.g. `atomic_cycle_not_found → candidate_plans>0`); closing `atomic_view_missing_venue` writes **`listener/searcher/pools/atomic-view-overrides.json` only** (nail #6 — cwd-relative `searcher/pools/`, NOT `src/`; loader-reads-it asserted) — backrun `force-include` + mempool `toAddress` set **unchanged**; re-running the closer on the same `learning_case_id` is idempotent (no duplicate override/escalation, nail #5); inconclusive comparable loss → `pending-manual-analysis` package |

## Governance / sequencing

- **Gap A = EPIC** (rule 13): `decision: epic`, owner `atomic-scanner-epic`, ordered slices
  **A0 + A-contract + A-universe → A1 → A2 → A3 → A-lane → A4**, each with its own gate; **A-contract
  (no-source-swap contracts + `processOpportunities` split-out), A-universe (shared venue registry +
  strategy-specific selection views; mempool filter from the backrun view only) and A-lane (P0-1 lane
  isolation — own `atomic_busy`/cache/sim; final owner re-review) are hard prerequisites — no atomic
  logic ships before the first two, no LIVE wiring before the third.** A-universe overlaps `project-pool-scoring-arb-relevance-epic` (same scorer). Per-pool
  pins for this class are now forbidden inside the 30-min loop.
- **Gap B, C1 = single-cycle rule-12 fixes**, parallelizable with A0/A1. **C2 + D are the strategy-aware
  learning loop** — one shared framework (census / classifier / gap ledger / replay gate) with **split**
  taxonomy / `opportunity_id` / venue-view / close-action; do NOT build two parallel platforms. Their
  self-evolution half is gated on A's atomic telemetry (see C2/D), so they land **with/after A**, not before.
- **Recommended order (explicit, user point 6; re-gated by the final owner re-review):** **C1**
  (cheapest; auto-measures followability, stops hand-classifying) → **B** (cheap coverage + unblocks
  measuring wider flow) → **A-contract / A-universe** (prerequisites) → **A1–A3** (deterministic
  scanner + solver, fork-gated, offline-fixture scope) → **C2-minimal** (align at `B-1`,
  offline-replay `primary_gap` — REQUIRED before A4 so its gate is script-driven, not hand analysis)
  → **A-lane** (P0-1 lane isolation — hard prerequisite of A4) → **A4** (dry-run window) →
  **C2-full + D** (the close half + `LearningCase` dispatcher, once A emits telemetry).
  C2-minimal-before-A4 is the point-6 correction; D stays last.
- **Owner re-gate (2026-07-04, conditional approval — encode, don't re-litigate):** **GO now** = C1,
  A0, A-contract, A-universe, offline-fixture A1/A2/A3, A-lane, C2-minimal (build + report).
  **BLOCKED** = **A4 live wiring** until the A-lane gate + the merged P0-2/P0-3 fresh-read pre-gates
  are green; **C2 as the AUTHORITATIVE auto-close judgment** (and D acting on it) until P1-4
  (capability/live-admission split) + P1-5 (view versioning) land. Not gating: B-residual, A0's dust
  fixture, C1's direction.
- Each slice is generator/evaluator split (rule 7): Claude briefs → Codex writes → Claude gates. Go-live
  stays a hard human gate (Safety Rule 1); A4 is dry-run + flag-gated only.
- **Second-review nails (2026-07-04) are prerequisites, not optional.** #1 planner-view interface + #2
  cross-strategy `SubmissionCoordinator` bind into **A-contract / A-universe** (must land before any atomic
  logic — they protect the working backrun path from the new producer). #3 stale-target + #4
  `atomic_scan_result` + the runtime circuit-breaker bind into **A4**. #5 `LearningCase` id/lifecycle + #7
  offline-replay state-backend bind into **C2**; #6 `atomic-view-overrides.json` path correction binds into
  **Gap D**. **Package boundary:** the offline atomic-replay harness lives in **`listener`** (reuses the
  `searcher:planner` infra so it exercises the REAL scanner, not a drifting copy); `analysis` emits the
  competitor `LearningCase` that harness consumes — do NOT reimplement the scanner inside `analysis`.
