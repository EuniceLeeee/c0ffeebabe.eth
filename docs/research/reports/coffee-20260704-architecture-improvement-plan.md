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
   (which would collide IDs and poison live-loss / Hermes analysis keyed on `victim_hash`).
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
3. **Bundle contract** (`bundle-router.ts:5`): make `victimTxHash` **optional** — the `standalone` path
   already ignores it (`bundle-router.ts:81`) and atomic is standalone-shaped.
4. **Extract `processOpportunities(ctx, opportunities, sourceMeta)`** from the ~900-line `handleHint`
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
- **Gate (refactor-neutral):** all existing backrun `searcher:planner` + `searcher:replay-live-fixtures`
  pass **unchanged**; a new unit test asserts (a) two distinct anchors in the same `source_block` produce
  **distinct** `opportunity_id`s (no source-swap-hash collision); (b) two rotations/directions of the SAME
  ring produce the **same** `cycle_fingerprint` and two genuinely different rings produce different ones
  (canonical-join invariance — the C2 alignment depends on it); (c) a batch of ≥2 profitable atomic
  opportunities in one block yields **exactly one** `bundle_submitted` (top `candidate_rank`), the losers
  emitting `pipeline_dropped` with a visible `dedup_per_block` reason (not silently swallowed).

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
    `maxPools` large, consumed under A2/A4's per-block budget + idle-only.
- **One union graph, two edge-selection views** (not two graphs): the planner gets a hot edge-view for
  backrun; the atomic scanner uses the full union graph (it needs it to find cross-venue loops). Reuses
  the planner's existing top-N edge pruning (`maxPoolsPerToken`), and saves memory vs two graphs.
- **Enforcement point (where "atomic breadth must not pollute backrun speed" bites): the mempool
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
- **Seed from the block's CHANGED pools (delta-driven), not a full re-scan of all ≥2-venue pairs every
  block.** On block N, pull N's swap logs on tracked pools → the set of changed pools → restrict the
  spread scan to pairs touching those pools. This is O(changed pools), not O(all pairs), and it targets
  dislocations *as they form* (a swap in block N creates a standing dislocation from N+1 onward — where
  the race is). The full ≥2-venue sweep stays available as a periodic backstop, but the per-block hot
  path is delta-driven.
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
  **extract the post-detect pipeline** (plan → solve → sim → terminal-verify → submit, `main.ts` ~1275+)
  into a function that takes an `Opportunity[]` directly, and have both `handleHint` and the atomic block
  handler call it. The atomic handler skips detect entirely and passes the scanner's `AtomicOpportunity[]`.
- **Scheduling — respect the single-flight `busy` loop.** The hint loop is single-flight
  (`if (busy) skip hint`, `main.ts:847`); a per-block atomic scan contends for the same slot. Run the
  scan **idle-only** (skip if `busy`) with a per-block time budget, so it never starves backrun hints and
  `expired-before-solver` does not rise. Both behind `SEARCHER_ENABLE_ATOMIC_SCAN` (default 0).
- **State-block consistency — a hard gate, not an assumption (finding #5).** Atomic state-arb depends
  entirely on the end-of-block state. But the per-block warm + state-update are async/debounced listeners
  on the same `block` event (`main.ts:764 / :809`), so a scan firing on `block N` can read a
  `PoolStateCache` still seeded at `N-1` → false positives/negatives that also make replay non-reproducible.
  Require: the scanner reads a `state_block`, all changed-pool reads use the **same `blockTag`**, and the
  scan only proceeds when `state_block === source_block` — otherwise **skip the block** (do not enter the
  solver on stale state). Record both `source_block` and `state_block` on every atomic event so a drift is
  visible in the dry-run, not silent.

Hook the scan into `provider.on("block")` in `main.ts` under those two constraints. Deploy
(`scripts/deploy-node.sh`), run a dry-run window, run the mandatory Step-1 competitor cross-reference
over coffee's blocks.
- **Gate (metrics, non-deterministic per rule 12 exemption):** atomic `opportunity_seen>0` in the
  window, ≥1 atomic `simSuccess` on a real block, and Step-1 shows we now generate a competing
  candidate for ≥1 of coffee's atomic txs. **Regression guard: backrun `expired-before-solver` must not
  rise materially vs the pre-atomic baseline** (proves idle-only scheduling didn't starve backrun).
  Carry to the next round if the window is thin (extend the window, do not conclude a true negative —
  the R3 trap).

### Gap-A sequencing note
Order: **A0 (decode) + A-contract (contracts/refactor) + A-universe (pool-selection split) → A1 → A2 →
A3 → A4.** A-contract and A-universe are both prerequisites — nothing atomic ships before them, or the hot
path forks (A-contract) and backrun-speed/atomic-breadth fight through one universe (A-universe). The real
engineering surfaces are **A-contract** (the shared `processOpportunities` extraction from the ~900-line
`handleHint`), **A-universe** (two selection views + mempool-filter-from-backrun-view; overlaps the
arb-relevance epic), **A2** (bounded 3–4 hop cycle cost, policed by the latency gate; hop cap 4→3 is the
lever), and **A4** (block wiring + idle-only scheduling + state-block consistency). A1's O(pairs) scan is
cheap. A4 is flag- + dry-run-gated; go-live stays a human gate. **Per-pool force-include pins for this
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

### C2 — strategy comparison report (the self-evolution half; build AFTER A ships atomic telemetry)

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

- **Sequencing (refinement, verified):** the competitor side of C2 (shape + `cycle_fingerprint`) is
  computable from chain data alone and can precede A. But `our_atomic_seen` / `our_stage` need **our
  atomic events**, which don't exist until A ships — so pre-A, every atomic competitor tx maps to
  `our_stage=not_scanned` (i.e. "build A"), and the full report only lights up after A4. **C1 (classifier)
  ships first; C2's self-evolution half is gated on A's telemetry.** Do not build the full comparison
  platform before A0 proves atomic is a real +EV opportunity and not pure dust (economics honesty).
- **Gate (rule-12):** on coffee's 8 atomic samples, C2 emits **both** `competitor_shape=atomic_state_arb`
  **and** a per-tx atomic `primary_gap` — never just `atomic_state_arb` with no diagnosis of *our* gap.

---

## Gap D — strategy-aware auto-close loop (the close half; build with/after A)

The current closer `auto-close-route-gap.ts:72` is strategy-**blind**: it appends the missing pool to
`force-include-poolids` (`auto-close-route-gap.ts:10` → `appendForceIncludePoolIds`), which feeds the
**shared** graph and therefore the backrun mempool `toAddress` set. **Verified consequence: a
strategy-blind close on an atomic miss would force-include the pool into backrun's hot set — exactly the
A-universe pollution ("atomic breadth must not pollute backrun speed").** So D is not cleanup; it is the
close-side *enforcement* of A-universe's decoupling.

**Fix — wrap the closers in a strategy-aware dispatcher `auto-close-strategy-gap`:**
- `backrun` miss → backrun view / router universe / route-gap close (today's `auto-close-route-gap`, unchanged).
- `atomic` miss → **atomic** view / venue scorer / atomic scanner only — **never** the backrun view.
- `shared adapter missing` → the venue-adapter epic (touches neither view's ranking).
- A **strategy-agnostic trigger**: not just our `bundle_not_included` (which atomic never emits), but also
  the C2 `not_seen` / `our_stage != submitted` result on a competitor `atomic_state_arb` tx. It writes a
  pending task per gap class (marks `pending-deploy`; never auto-broadcasts — go-live is a human gate).
- **Gate (rule-12, the self-evolution flip — this is the whole point):** each atomic gap close records
  `before: <competitor sample> → our gap X` and `after replay: same sample → stage improved`, e.g.
  `atomic_cycle_not_found → candidate_plans>0` or `atomic_sizing_failed → sim.success && netEV>0`.
  **AND** the A-universe safety assertion: closing an `atomic_view_missing_venue` updates the atomic view
  only and leaves the backrun-scored mempool `toAddress` set unchanged. A close with no before→after stage
  flip does not count as closed (rule 13 — no orphan findings).

---

## Verification summary (the gates, in order)

| slice | harness / command | expected transition (rule-12) |
|---|---|---|
| A0 | fork replay at pre-tx state (`docs/historical-replay.md` pattern) | atomic cycle reproduced from public state, gross > 0 |
| A-contract | `searcher:planner` + `searcher:replay-live-fixtures` (refactor-neutral) | backrun tests pass unchanged; two anchors in one `source_block` → **distinct `opportunity_id`s**; **same ring in 2 rotations/directions → same `cycle_fingerprint`** (canonical-join invariance); **≥2 profitable atomic opps in one block → exactly one `bundle_submitted`** (losers `dedup_per_block`) |
| A-universe | new `searcher:universe-split` unit test | widening the atomic universe leaves the backrun-scored mempool `toAddress` **set unchanged** (no atomic displacement); atomic view has ≥1 loop-closure pool absent from the backrun hot set |
| A1 | `npm run searcher:planner` | anchor flips `candidate_plans 0→>0`; **every candidate path contains the seed pools** (anchor-constrained, not whole-graph); center `>8` in `flashToken` units |
| A2 | `searcher:planner` + new `searcher:bench-atomic` | #2 3-hop cycle found (`candidate_plans 0→>0`); full scan < between-block budget at `maxHops≤4` |
| A3 | `npm run searcher:replay-live-fixtures` | `sim.success + net-EV>0 + standalone bundle built`; **search center from `searchSeed`, not `1n` (`center>8`)** |
| A4 | dry-run window + Step-1 cross-ref | atomic `opportunity_seen>0`, ≥1 atomic `simSuccess`, competing candidate for a coffee atomic tx; **backrun `expired-before-solver` not materially higher**; **every atomic event has `state_block === source_block`** |
| B | `npm run searcher:planner`-style fixture on committed reth logs | `0x663dc15d ∈ mempool filter` (under quotas) → admission `false→true`; hot-pool quota preserved |
| C1 | `analysis` classifier test | coffee 9 txs → 8 `atomic_state_arb` + 1 `backrun`; `#9 source_swap_seen_by_us=false`; **no `maxPrio=0` tx labeled private**; **classifier decodes v2/v3/v4/Curve/Balancer** (a Curve/Balancer source swap is not mislabeled atomic) |
| C2 (after A) | `analysis` comparison test | each coffee atomic tx emits **both** `competitor_shape` **and** a per-tx atomic `primary_gap` (never `atomic_state_arb` with no diagnosis of our gap); alignment by `cycle_fingerprint`, not `victim_hash` |
| D (with/after A) | replay per gap class | before→after stage flip (e.g. `atomic_cycle_not_found → candidate_plans>0`); closing `atomic_view_missing_venue` updates the atomic view only, backrun mempool `toAddress` set **unchanged** |

## Governance / sequencing

- **Gap A = EPIC** (rule 13): `decision: epic`, owner `atomic-scanner-epic`, ordered slices
  **A0 + A-contract + A-universe → A1 → A2 → A3 → A4**, each with its own gate; **A-contract (no-source-swap
  contracts + `processOpportunities` extraction) and A-universe (shared venue registry + strategy-specific
  selection views; mempool filter from the backrun view only) are hard prerequisites — no atomic logic
  ships before them.** A-universe overlaps `project-pool-scoring-arb-relevance-epic` (same scorer). Per-pool
  pins for this class are now forbidden inside the 30-min loop.
- **Gap B, C1 = single-cycle rule-12 fixes**, parallelizable with A0/A1. **C2 + D are the strategy-aware
  learning loop** — one shared framework (census / classifier / gap ledger / replay gate) with **split**
  taxonomy / `opportunity_id` / venue-view / close-action; do NOT build two parallel platforms. Their
  self-evolution half is gated on A's atomic telemetry (see C2/D), so they land **with/after A**, not before.
- **Recommended order:** **C1 first** (cheapest; makes every future round auto-measure followability, so
  we stop hand-classifying) → **B** (cheap coverage + unblocks measuring wider flow) → **A** as the epic
  (the real capability, highest ceiling especially over MEV-Share flow) → **C2 + D** (close the atomic
  learning loop once A emits telemetry).
- Each slice is generator/evaluator split (rule 7): Claude briefs → Codex writes → Claude gates. Go-live
  stays a hard human gate (Safety Rule 1); A4 is dry-run + flag-gated only.
