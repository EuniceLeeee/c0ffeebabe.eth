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
| B | 1/9 = a **public backrun** whose victim `to=0x663dc15d…` (custom router) was dropped **before** the funnel | mempool admission is a fixed ~14-router allowlist; a swap via an unlisted router that touches our pools is invisible | flow-admission | small, cheap |
| C | the per-round comparison never checked "did we SEE the source swap" nor "is the competitor atomic- or backrun-shaped" (built by hand: `coffee-backrun-verify.mjs`) | the followability classifier is a hand analysis, not a permanent tool | analysis-tooling (rule 16) | cheapest |

Economics honesty (carried from memory, not re-litigated): coffee's atomic take is **dust** on public
flow ($0–0.33/tx, ~$23/2.5h) — but that ceiling was measured on ~1.4% of flow, and MEV-Share flow (72×
volume) was just flipped on. Gap A is a **capability** we lack regardless of today's dust; its EV must
still clear the gate. Do not celebrate dust (Hermes "simSuccess must be +EV" rule).

---

## What is already reusable (do NOT rebuild)

The backrun pipeline is already victim-*agnostic* below the trigger. An atomic (no-victim) opportunity
reuses almost all of it:

| stage | file:line | victim-dependence today | reuse for atomic |
|---|---|---|---|
| block-driven pool-state freshness | `main.ts:762 / :807` (`provider.on("block")` warm + state update), `solver/pool-state-updater.ts` | none — already per-block | **trigger + state source for the scan** |
| cycle enumeration | `planner/token-graph.ts:462` `buildTokenPaths(start,profit)` | none — DFS start→profit is generic | seed with `start===profit` (a cycle) |
| candidate planning | `planner/planner.ts:86` `TemplatePlanner.plan(opp,…)` | pins the impact pool from `opp.hints.impact` (via `impactFromOpportunity`, `planner.ts:413`) — **NOT** `opp.affectedPools`; with no `hints.impact`, `focusPathsOnImpact` returns all paths | plan from a synthetic `Opportunity` that **omits `hints.impact`** (clearing `affectedPools` alone does nothing) |
| amount sizing | `solver/solver.ts:442` `resolveSearchCenter` | ⚠️ `if (victimAmount<=0n) return 1n` does **NOT** fall back to a useful search — see the sizing-seed blocker below | requires a real `searchCenter` seed (missing piece #2) |
| execution / submission | `execution/bundle-router.ts:81` `standalone` → `submitStandaloneBundle` (single next-block tx, **no victim rawTx**) | already exists for the mined-victim Path C (`main.ts:1134`) | **atomic bundle == standalone bundle** |
| EV / final-verify gate | `main.ts:1583` terminal verify + EV gate | none | unchanged |

So the **genuinely missing pieces for Gap A** are three (not two — the sizing seed was missed):
1. a block-triggered *opportunity source* whose search is cheap by construction — an O(pairs) 2-hop
   spread scan to find anchors, then a depth-bounded (≤4 hop) cycle search seeded only from those
   anchors — NOT a whole-graph DFS. See "Path length" below.
2. **an amount-search seed for the no-victim path (blocker, verified in code).** The reuse claim that
   `victimAmountIn:0n` "already falls back to the geometric grid + GSS" is **false**. `resolveSearchCenter`
   returns `1n` (`solver.ts:448`); `geometricGrid(1n, halfWidth=3)` is anchored on that center and the
   negative shifts floor to 0 → the grid is exactly **`[1, 2, 4, 8]` wei**. GSS only fires when a grid
   point already quotes a **positive** profit (`solver.ts:196`) and its bracket is only `[bestX/2, 2·bestX]`
   with **no boundary expansion** — so a 1–8 wei probe is rounded to zero and the solver throws
   "no profitable plan". Atomic sizing therefore needs a real `searchCenter` (derive it in A1/A2 from the
   anchor pool depth / spread), not `victimAmountIn:0n`. This is a hard landing blocker, folded into the
   slices below.
3. a no-victim **entry point** into the post-detect pipeline (A4) — `handleHint` cannot be fed a synthetic
   hint (see A4); the plan→solve→sim→submit tail must be reachable without a victim tx.

---

## Gap A — per-block atomic chain-state scanner (EPIC)

**Root cause (verified in code):** `BackrunDetector.detect` runs only inside `handleHint`, which fires
only on an `OrderflowEvent` from the mempool (`main.ts:1240`). There is **no block-driven scan**. A
standing cross-pool spread with no pending swap produces no hint → no opportunity → never seen. This
matches the doc exactly: "our pipeline never triggers; there is nothing to follow."

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

**A1 — anchor finder: O(pairs) 2-hop spread scan (this IS the detector, not a filter).**
First make `Opportunity` a **discriminated union** so atomic never fakes a victim (`detector.ts:6`):
`type Opportunity = BackrunOpportunity | AtomicOpportunity`. `BackrunOpportunity` keeps today's shape
(`kind:"backrun-arb"`, `victimTxHash`, `victimAmountIn`, `hints.impact`). `AtomicOpportunity`
(`kind:"atomic-arb"`) carries **no victim fields and no `hints.impact`**, plus a required
`searchSeed: { searchCenter: bigint; maxInput?: bigint }` (the sizing seed, missing-piece #2). The only
non-test consumers of `Opportunity` are `main.ts / events.ts / planner.ts / solver.ts / detector.ts`, and
`"backrun-arb"` is a literal in just two spots in `detector.ts` — so the union is a small, contained change.

Add `detector/atomic-scanner.ts` → `detectAtomicOpportunities(cache, pricedTokens)`: iterate only
**token pairs that have ≥2 venues** in the runtime graph; for each, compare mid-prices from the warm
`PoolStateCache` (constant-product ratio for v2, `sqrtPriceX96` for v3) and flag pairs whose spread
exceeds fees. A flagged pair directly yields the 2-hop seed (start token + the two pools) — **no DFS,
no per-token enumeration** — and a `searchCenter` derived from the anchor pools' depth/spread (NOT `1n`).
Emit an `AtomicOpportunity{ startToken, profitToken:start, affectedPools:[poolA,poolB], searchSeed }`.
This is inherently short-path and cheap.
- **Gate (rule-12, `npm run searcher:planner`, deterministic, no anvil):** pin a 2-venue spread fixture;
  assert the pair is flagged and yields `candidate_plans 0→>0` — same flip shape as the CFG v4 fixture
  (`test/planner.ts:829`). (From the data this class is mostly dust here; it ships first because it is
  the cheapest and unblocks the pipeline — the value comes in A2.)

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

**A3 — no-victim solve + sim + standalone build (end-to-end on fork).**
Teach `resolveSearchCenter` (`solver.ts:442`) to read `AtomicOpportunity.searchSeed.searchCenter` instead
of the `1n` fallback (dispatch on `opp.kind`; backrun path unchanged). Then run the A0 fixture through
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
  (`main.ts:953`) is victim-parse all the way down: Path A needs hint logs + `enableHashOnly`, Path B
  needs a rawTx, Path C calls `getTransaction(txHash)` (a fabricated hash throws), and the tail is
  `detector.detect(event)` (`main.ts:1244`), which produces opportunities from **swap logs** — a
  log-less synthetic event yields 0 and exits at "no matching graph pool". The correct wiring is to
  **extract the post-detect pipeline** (plan → solve → sim → terminal-verify → submit, `main.ts` ~1250+)
  into a function that takes an `Opportunity[]` directly, and have both `handleHint` and the atomic block
  handler call it. The atomic handler skips detect entirely and passes the scanner's `AtomicOpportunity[]`.
- **Scheduling — respect the single-flight `busy` loop.** The hint loop is single-flight
  (`if (busy) skip hint`, `main.ts:846`); a per-block atomic scan contends for the same slot. Run the
  scan **idle-only** (skip if `busy`) with a per-block time budget, so it never starves backrun hints and
  `expired-before-solver` does not rise. Both behind `SEARCHER_ENABLE_ATOMIC_SCAN` (default 0).

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
A0→A1 are pure/deterministic and land fast (A1's O(pairs) scan is cheap and short-path by construction).
**A2 (bounded 3–4 hop cycle search) is the only real engineering risk** — its per-block cost is what the
latency gate polices, and the hop cap is the lever (drop 4→3 before ever exceeding budget). A4 is gated
behind the flag and the dry-run — go-live stays a human gate. **Per-pool force-include pins for this
class are forbidden once epic'd (rule 13); only these slices touch it.**

---

## Gap B — mempool flow-admission (bounded router widening)

**Root cause (verified):** `MEMPOOL_ROUTER_ADDRESSES` is a fixed ~14-address set (`main.ts:206`);
`buildMempoolToAddressFilter` (`main.ts:2755`) = those routers + pinned pools + top-N hot pools. The
subscription is a **server-side `alchemy_pendingTransactions` `toAddress` filter** (`main.ts:2794`), so
we cannot "admit by pool-touch" at subscribe time — we don't know the touched pool until we fork the
tx. The code explicitly refuses the hash-firehose fallback (`main.ts:2805`). So the only correct fix is
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
- **Gate (rule-12, deterministic, from committed reth logs):** pin #9's victim tx `0x8e0c59b4…`
  (`to=0x663dc15d…`) as a fixture; assert after discovery `0x663dc15d` ∈ merged set AND
  `buildMempoolToAddressFilter` would include it under the quotas → admission flip `false→true`. Also
  assert hot-pool coverage is not reduced below its own quota by the merge.
- **Honesty:** #9 netted **−$0.19** (a lower bound, understated) → low value on this one sample. Do it
  because it is a cheap, genuine coverage hole and it unblocks *measuring* whether the wider flow pays —
  not because this tx pays. **Bounded widening only** (evidence-gated addresses, capped count).

Connects to memory `project-mempool-router-allowlist-blindspot`.

---

## Gap C — codify the atomic-vs-backrun classifier (rule 16)

**Root cause:** the followability judgment (atomic vs backrun; "did we see the source swap") was done by
hand (`coffee-backrun-verify.mjs`). Rule 16 requires a hand analysis that exposes a tooling gap to become
a one-command capability, or the cycle does not close.

**Fix — fold the classifier into the standing tools:**
- Extend `analysis` `live-loss` / census with a per-competitor-tx **shape** field: for each arb pool in
  the tx, `eth_getLogs` the same block for a preceding swap at a **lower tx index** → 0 preceding =
  `atomic_state_arb`, ≥1 = `backrun`, indeterminate = `unknown` (the exact `coffee-backrun-verify.mjs`
  logic, made permanent). Emit `source_swap_hash`, `source_swap_seen_by_us`, `source_router`.
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

---

## Verification summary (the gates, in order)

| slice | harness / command | expected transition (rule-12) |
|---|---|---|
| A0 | fork replay at pre-tx state (`docs/historical-replay.md` pattern) | atomic cycle reproduced from public state, gross > 0 |
| A1 | `npm run searcher:planner` | 2-venue spread pair flagged → `candidate_plans 0→>0` (O(pairs), no DFS) |
| A2 | `searcher:planner` + new `searcher:bench-atomic` | #2 3-hop cycle found (`candidate_plans 0→>0`); full scan < between-block budget at `maxHops≤4` |
| A3 | `npm run searcher:replay-live-fixtures` | `sim.success + net-EV>0 + standalone bundle built`; **search center from `searchSeed`, not `1n` (`center>8`)** |
| A4 | dry-run window + Step-1 cross-ref | atomic `opportunity_seen>0`, ≥1 atomic `simSuccess`, competing candidate for a coffee atomic tx; **backrun `expired-before-solver` not materially higher** |
| B | `npm run searcher:planner`-style fixture on committed reth logs | `0x663dc15d ∈ mempool filter` (under quotas) → admission `false→true`; hot-pool quota preserved |
| C | `analysis` classifier test | coffee 9 txs → 8 `atomic_state_arb` + 1 `backrun`; `#9 source_swap_seen_by_us=false`; **no `maxPrio=0` tx labeled private** |

## Governance / sequencing

- **Gap A = EPIC** (rule 13): `decision: epic`, owner `atomic-scanner-epic`, ordered slices A0→A4 each
  with its own gate; per-pool pins for this class are now forbidden inside the 30-min loop.
- **Gap B, C = single-cycle rule-12 fixes**, parallelizable with A0/A1.
- **Recommended order:** **C first** (cheapest; makes every future round auto-measure followability, so
  we stop hand-classifying) → **B** (cheap coverage + unblocks measuring wider flow) → **A** as the epic
  (the real capability, highest ceiling especially over MEV-Share flow).
- Each slice is generator/evaluator split (rule 7): Claude briefs → Codex writes → Claude gates. Go-live
  stays a hard human gate (Safety Rule 1); A4 is dry-run + flag-gated only.
