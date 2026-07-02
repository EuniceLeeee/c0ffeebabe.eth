# Architecture Review — 20260702 (Conclusion A, fable chain+code side)

> Independent staff-level review fired by CLAUDE.md rule 13 (≥2 consecutive rounds closed with no
> growth in a genuine +EV `simSuccess`; R1/R2/R3 = 3 flat rounds). Scope: authorized defensive on-chain
> arbitrage research; mainnet fork + local reth dry-run (zero CU); broadcast is a hard human gate.
> This is **conclusion A**. The economics/sim-fidelity re-derivation a parallel Codex **conclusion B**
> would add is noted inline; the orchestrator should compare before finalizing the Findings Ledger.

## localized_lever: **coverage** — runtime routing-graph under-population from a *disabled pool universe* (config/load defect, NOT a discovery gap)

The single biggest structural blocker to a +EV bundle is **not** the tactical failures the per-window
loop kept fixing. It is that **R1/R2/R3 all ran with the curated pool universe (`active-pools.json`)
silently NOT loaded**, so the runtime routing graph was missing ~30% of its edges — exactly the
return/closing venues competitors route their loops through. 78% of every round's losses are
`plan/no_candidate_plans`, and they are dominated by pools we *already have in our universe file* but
that never entered the graph.

This is a coverage failure **in effect** (planner literally classifies these
`impact_pool_not_in_routing_graph`), caused by a **config regression + a code footgun**, not by a
missing-venue discovery gap. The fix is a config flip + hardening, **not** new indexing.

### The load-bearing evidence (re-derived from primary artifacts, not the R*.md)

**A. The R3 hermes / handoff mis-stated the dominant drop.** The structured source of truth
(`/tmp/r3-window.jsonl`, 49 `pipeline_dropped`) is:

| stage/reason | count | note |
|---|---:|---|
| **plan/no_candidate_plans** | **38 (78%)** | 18 `impact_pool_not_in_routing_graph` + 20 `only_immediate_same_pool_reverse` |
| solver/expired-before-solver | 7 | latency (R1's theme) |
| solver/quote-timeout | 2 | latency |
| solver/no-profitable-quote | **2** | — |

The R3 md + handoff claimed "~46 solver/no-profitable-quote." That is **wrong** — it inverts the real
picture. `no-profitable-quote` is 2/49; `no_candidate` is 38/49. This matters because `no-profitable-quote`
is a *solver/economics* signal, while `no_candidate` is a *planner/coverage* signal. The loop chased
the former's story; the data says the latter.

**B. The graph was running crippled.** Live startup banners (`/var/log/mev-live.log`):

| run | `topN` | universe loaded | graph | on-disk `runtime-graph-pools.json` |
|---|---:|---:|---|---:|
| earlier (v3fork) | 1500 | 1500 | **8390 edges / 3597 tokens** (4154 pools) | — |
| **R1/R2/R3 (PID 70758)** | **0** | **0** | **5860 edges / 2901 tokens** (2928 pools) | 2928 (matches → confirms R3 ran topN=0) |

`SEARCHER_POOL_UNIVERSE_TOP_N` defaults to `"0"` (`main.ts:330`), and `loadPoolUniverse` does
`pools.slice(0, maxPools)` with `maxPools = opts.maxPools ?? Infinity` = `0` → **`slice(0,0)` = empty**
(`pool-universe.ts:64,70`). So `0` does not mean "unlimited"; it means **load zero curated pools**. The
whole 3-round marathon lost ~2530 edges / ~700 tokens of routing coverage — the mid-tail return venues.

**C. This was already found once and silently regressed.** The v3fork hermes (lines 81-82, 298)
already diagnosed the `topN=0` footgun and set `=1500` on the node `.env` ("DONE"). But
`scripts/deploy-node.sh`'s env-preservation allowlist (line 23-24) **omits
`SEARCHER_POOL_UNIVERSE_TOP_N`**, so the next deploy reconstructed env from the process and dropped it
back to unset → `0`. The fix was real but non-durable; R1/R2/R3 ran without it and nobody re-checked the
startup banner.

## The counterfactual walk (≥2 real competitor atomic bundles, traced on local reth, zero CU)

For a `competitor_took` on our `pipeline_dropped` victim, the source swap **did** enter our funnel
(`opportunity_seen`); "saw it = yes" by construction. All three below are **status=1, real closed-loop
DEX arbs with WETH landing in the bot contract** — not CEX-DEX, not reverts, not dust.

**Case 1 (pinned) — `0x476548cc…` blk 25443539, bot `0xc46fcd65…`, +0.01557 WETH (~$48).**
- saw it? **yes** (our dropped victim). planned? **NO** — 0 candidates.
- gate that killed it: `plan/no_candidate_plans`, classification **`impact_pool_not_in_routing_graph`**.
- why: the loop is WETH↔token`0xff208177` between two univ2 venues **`0x15e86e6f`** (score 58, **rank 534**)
  and **`0x08650bb9`** (score 25, **rank 923**). Both are **in `active-pools.json` top-1500** and both are
  **absent from the runtime graph** (`topN=0` pruned them). `distinct_pools=7` in cscan; the extra log
  emitters (`0xff208177`, DAI, WETH) are tokens, not pools.
- how much must change: **load those two pools** → the cross-venue return exists → planner emits a candidate.

**Case 2 (self-found) — `0x5aba954d…` blk 25443539, bot `0x65f3443e…`, +0.00874 WETH (~$27).**
- Same block, same WETH/`0xff208177` region, a *different* competitor. Routed `0x15e86e6f` (rank 534,
  pruned) + `0x4e57f830` (**not in universe at all**). Our drop: `no_candidate / impact_pool_not_in_routing_graph`.
- Two independent bots profiting on the same pair in one block = a real, recurring lane, not noise.

**Case 3 (self-found, the biggest) — `0x68e77ef1…` blk 25443460, bot `0x00000000a991…`, +0.06679 WETH (~$200).**
- Source pool `0x01ed36bf` (WETH/`0xb1dd19b5`) **is in the graph**; our drop was
  **`only_immediate_same_pool_reverse`** — we found only the same-pool reverse, no cross-venue return.
  The competitor closed via a second WETH/`0xb1dd19b5` venue we don't route. Consistent with the same
  under-population (a second venue for an in-graph pair, missing from the pruned graph). Treated as
  corroborating, not load-bearing (couldn't fully reconstruct its 2nd venue from logs alone).

**Decision rule outcome:** competitor path contains pools absent from our routing graph → **coverage**
(for cases 1-2 the absent pools are *in our universe file*; the constraint is the load, not discovery).
No case reached a solver best-quote>0 that the EV gate then killed → economics is **not** the binding
constraint at the current dominant drop.

## Why the per-window loop missed it
- It read `no_candidate_plans` as "longtail, don't chase" from a **small manual sample** (R1 traced 5
  flagged takes → "3 router swaps, 1 sandwich, 1 arb $0.05 dust") and stopped — while the structured
  cscan showed competitors profitably took **5 (R1) and 4 (R3)** of exactly those `no_candidate` victims.
- It never checked the **startup banner**, so it didn't notice the universe was off (`0 universe`). It
  optimized the *small* categories it could see inside the funnel (R1 latency ~15% of drops; R2 v4-sim
  accounting) and left the *dominant* upstream category untouched.
- R3's dual-blind concluded "true-negative funnel-internally + coverage upstream (need new AMP/native
  venues)". Half-right: it correctly saw nothing *wrongly rejected inside the visible funnel* — but that
  is because 78% **never entered the funnel** (died at the planner). And it **mis-located the cause** as a
  need for *proactive new-venue indexing* when the real cause is *the universe we already maintain is
  unloaded*. That mislocation is the difference between "hard multi-week epic" and "a config flip."

## size distribution
+EV-sized opportunities **are** admitted into our funnel. The three competitor bundles above
(0.0156 / 0.0087 / 0.0668 WETH gross) were all on **our own seen-and-dropped victims** — the flow reached
us; it died at the planner for lack of graph coverage, not for lack of size. (Limitation: I did not build
a full multi-hour size histogram; the three competitor takes on our dropped victims are already dispositive
that +EV-sized flow enters and is lost upstream of the solver.)

## epic? **YES** — `decision: epic` (owner: coverage/graph-load)

**Do NOT reinvent W3.** W3 (`build-active-pool-universe.ts` learn→close, `discovery-queue.json` →
`active-pools.json`) is landed but **inert under `topN=0`** — everything it enqueues is never loaded. The
epic fixes the **load**, upstream of W3. Only the truly-absent pools (`0x4e57f830`, `0xa17661e7` — not in
`active-pools.json`) are W3's trailing-discovery domain; the dominant miss (in-universe-but-pruned) is a
load defect W3 structurally cannot fix.

### Slices (ordered, each its own rule-12 gate)
1. **Restore + make durable the universe load** (the first slice; gate below).
   - ops: set `SEARCHER_POOL_UNIVERSE_TOP_N=1500` in `/opt/MEV/.env`.
   - persistence: add `SEARCHER_POOL_UNIVERSE_TOP_N` to `scripts/deploy-node.sh` PRESERVE_ENV allowlist
     (line ~23) so it survives deploys (this is the actual regression cause).
   - code footgun: `pool-universe.ts:64` → `const maxPools = opts.maxPools && opts.maxPools > 0 ? opts.maxPools : Infinity;`
     and/or `main.ts:330` default `"0"` → `"1500"`. `0` must never silently mean "empty universe."
2. **Verify the restored graph actually closes the competitor loops** (next dry-run: `no_candidate`
   `impact_pool_not_in_routing_graph` share ↓, `plans>0` on WETH/`0xff208177`-class lanes; competitor-took
   `no_candidate` count ↓).
3. **Then, and only then, economics** (the runner-up becomes the next wall) — see below.
4. **W3 trailing discovery** for the genuinely-absent shapes (`0x4e57f830`, native-ETH/v2-fork) joins the
   existing v4/coverage epic; keep it *after* the load fix, not before.

### First-slice deterministic gate (rule 12 — flips ONE genuine +EV simSuccess on a pinned replay)
- **Planner flip (pure, no anvil):** add a pinned fixture to `listener/src/searcher/test/planner.ts`
  (`npm run searcher:planner`) for block 25443539 WETH/`0xff208177`:
  - baseline graph **without** `0x08650bb9`+`0x15e86e6f` → **0 plans**, classification
    `impact_pool_not_in_routing_graph` (reproduces the live R3 drop);
  - graph **with** both venues loaded → **plans > 0** (cross-venue reverse; harness already asserts this
    shape at `test/planner.ts:124`).
- **+EV sim flip (revm):** a `replay-live-fixtures` case at block 25443539 asserting the loaded graph
  yields `sim.success && netProfit > 0` — competitor gross **0.01557 WETH** is the sanity ceiling; a dust
  or ≤0 result there means the lever is economics/sim-fidelity, not coverage (see falsifier).

## falsifier + runner-up
- **Cheap disproof:** restore `topN=1500` and replay block 25443539 on the WETH/`0xff208177` victim. If
  I'm right → planner emits a cross-venue candidate (`plans>0`, `impact_pool_not_in_routing_graph` gone)
  **and** the solver produces a +EV `simSuccess`. If plans stay 0, **or** the sim is ≤0/dust → coverage is
  not the binding constraint and I'm wrong; look to sim-fidelity/economics next.
- **Runner-up: economics.** `bribeBps=10000` (100% of profit to the builder, `main.ts:335`),
  `minNetEth=0` (`main.ts:338`), `quoteProfitFloorBps=20` dry-run (`main.ts:317`), `quoteSafetyBps=9999`
  (`main.ts:290`), `defaultGasUsed=12000000` (`main.ts:303`). Under this config even a restored +EV path
  may only clear as dust or be bribed to ~0 net.
- **The one piece of evidence separating #1 from #2:** the **drop stage**. 38/49 R3 losses die at
  `stage=plan`, upstream of both the solver and the EV gate (`main.ts:1619`, which only runs *after* a
  positive sim). ~0 drops reached the EV gate. Economics cannot be the binding constraint on a flow that
  never reaches it. Coverage is upstream and dominant; economics is the **next** wall once coverage lands
  (this is where Codex conclusion B — independent re-derivation of the EV gate / `defaultGasUsed` / profit
  floor / `valueInEth` — adds the most, and slice 3 owns it).

## distance-to-production check
Slice 1 is necessary and high-leverage but **not proven sufficient**: the v3fork window ran at
`topN=1500` and still closed `simSuccess=0`. Honest read — that was a thinner, different window whose
competitor takes needed genuinely-absent shapes; it does **not** refute that the R1/R3 WETH/`0xff208177`
lanes (top-1500 pools) become constructible once loaded. So slice 1 is the correct next move because it
(a) is the dominant, competitor-validated drop, (b) is a config/load defect the loop overlooked while
running 3 rounds on a crippled graph, and (c) is cheaply falsifiable. If its +EV-sim gate flips → first
real +EV bundle candidate. If it flips only the planner (`plans>0`) but not the sim → we have *localized
the true wall to economics/sim-fidelity* with a config change, which is itself the progress the 3 flat
rounds failed to make.

## Newly-observed competitor bots (extend WATCHLIST)
Not on the current seed watchlist, each captured ≥1 atomic arb in the R3 window on our dropped victims:
`0xc46fcd651bd6ac11255886feabdcebd58b870c86` (2 takes), `0x65f3443e12982a7180c46a20671ff07f7035629f`,
`0x00000000a991c429ee2ec6df19d40fe0c80088b8` (the +0.0668 WETH take).
