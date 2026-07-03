# Hermes Round R18-20260704 — impl-cycle (pool-scoring arb-relevance EPIC slice-1)

> Scope: authorized, defensive on-chain arbitrage research. Node runs bounded-live inside the
> script-enforced envelope (Safety Rule 1): `.deploy-live` marker + signer wallet ≤ 0.2 ETH +
> `SEARCHER_EV_GATE=1`; flash-arbs are atomic so principal is never at risk. Broadcast outside the
> envelope stays a human gate. Autonomous round (user away — decide + proceed per rules 14/15).

```yaml
cycle_id: R18-20260704
date: 2026-07-04
orchestrator: Fable 5 (autonomous hermes scheduled run)
type: implementation-cycle (lean; the pool-scoring EPIC's slice-1 — rule-13 anti-drift MUST-ship)
generator: Codex (gpt-5.5 xhigh, scripts/codex-run.sh workspace-write)
evaluator: Fable 5 (non-author; ran build + rule-12 flip + planner regression + diff review)
cu_budget: 1000 (per-fire cap)
cu_spent: ~0 (local build/tests + node deploy/re-index over SSM on local reth; no Alchemy)
codex: landed (pool-scoring arb-relevance slice-1; rule-12 gate flips; evaluator re-ran all gates)
searcher_behavior_change: yes (pool universe now prioritizes loop-completing return-venue pools over activity islands)
hermes_gate: n/a (impl-cycle, no new measured window/competitor cross-ref this cycle; gated by the rule-12 replay flip)
```

## Step 0.5 — bounded-live safety valve
- Signer `0xb8578B6…DA3c` = **0.002704 ETH** = baseline. Unchanged (no live submission fired). ≥ 50% →
  **no circuit-break.** `.deploy-live` present; post-deploy mode preserved bounded-LIVE.

## Why this cycle (rule-13 MUST-ship; blocker localized in R17)
R17's arch-review-trigger localization named **Lever A = the pool-scoring epic** as the searcher-side
distance-to-production lever. The dominant `no_candidate_plans` (~52-63% of drops across R14/R15/R17)
classifies as `only_immediate_same_pool_reverse` / `impact_token_no_supported_return_venue`
(`planner.ts:631/637`) — both = `impact_token_return_venues_excluding_impact_pool === 0`: we detect an
opp but the impact token has **no return venue in the graph to close the loop**. Root cause
([[project-pool-scoring-arb-relevance-epic]]): the pool-universe scorer is single-axis raw swap count
(`build-active-pool-universe.ts:195`), so high-activity single-venue **islands** crowd out low-activity
**return-venue** pools. R18 ships the epic's slice-1 (rule-13 anti-drift: no third consecutive
non-shipping round after R17's measurement round).

## Implementation (Codex writes → Fable evaluates + gates)
- **NEW pure `listener/src/searcher/pool-universe-arb-relevance.ts`** — `selectArbRelevantPools`:
  token-degree map over the enriched candidate set + external v4 pools; a pool is a **loop-completer**
  iff BOTH its tokens have `degree >= 2` (a 2nd venue exists to route in AND out). Rank loop-completers
  first, then islands, then `count desc, lastSwapBlock desc`; cut to `maxPools`. Disabled
  (`POOL_UNIVERSE_ARB_RELEVANCE=0`) returns the exact prior count-only slice.
- **`build-active-pool-universe.ts`** (+94/-7): the topN cut previously ran on raw count BEFORE token
  metadata was fetched. Restructured: count-rank → enrich a **bounded oversample** once
  (`maxPools * OVERSAMPLE`, default 2) → `selectArbRelevantPools` (loop-completers first) → fill to
  `maxPools` (**no shrinkage** — islands still fill any remainder). v4 `currency0/1` feed the degree
  map (cross-protocol return venues). Env `POOL_UNIVERSE_RELEVANCE_OVERSAMPLE`.
- **NEW `listener/src/searcher/test/pool-universe-arb-relevance.ts`** + `searcher:arb-relevance` script.

## rule-12 repair-replay gate
- `failing_sample:` candidate set `[I(island MEME/WETH count=100), L(USDC/WETH count=3), U(USDC/DAI
  count=2), D(DAI/WETH count=1)]`, `maxPools=2`.
- `baseline_failure:` disabled (count-only) selects `[I, L]` — the high-count **island I is admitted**
  and the loop-completer U is dropped (the pre-fix behavior; the return-venue gap).
- `fix_commit:` `91972af`.
- `replay_command:` `cd listener && npm run searcher:arb-relevance`.
- `replay_result:` `PASS enabled_flip=true disabled_baseline=true external_v4=true missing_tokens=true`
  — enabled selects `L` + `U` (loop-completers) and **EXCLUDES the count-100 island I**; external-v4
  token-degree promotes a CFG island to a completer; missing-token pool stays an island. (Evaluator ran
  it locally, not Codex's sandbox stub.)
- `expected_transition:` pool-universe ranking `loop-completer admitted over higher-count island`
  (island excluded → return-venue pool admitted). Downstream link (planner regression, still PASS):
  `pool_in_routing_graph false→true, candidate_plans 0→1` once a return venue is in the graph.
- `verdict:` **fixed** (deterministic ranking flip; positive+disabled asserts prove it is not a no-op).
- **Regression:** `npm run build` clean; `searcher:planner` PASS (14/14 + replay 12/12 + high-spread
  universe).

## Evaluator (Fable, non-author)
- `ran_gate:` built (clean); ran `searcher:arb-relevance` (PASS in my env); read the test (asserts the
  count-100 island is excluded and the low-count completers admitted — a genuine flip, not a no-op);
  ran `searcher:planner` (PASS); reviewed every diff hunk (4 files, only the allowed surface).
- `finding:` (1) enrichment reordering verified — enrich the oversample ONCE, `enriched[i]↔poolsToEnrich[i]`
  index alignment matches the original `mapLimit` order contract; disabled path preserves exact prior
  behavior; no universe shrinkage (islands fill any remainder). (2) mild duplication:
  `countLoopCompleters` re-implements the degree logic for the log line only — not blocking. → approved
  + committed + deployed.

## Deploy + mode-preservation + LIVE effect signal
- Deployed `91972af` with a **forced re-index** (`POOL_UNIVERSE_MAX_STALE_BLOCKS=0`) so the new scorer
  rebuilds the universe: **re-indexed 5104 pools (toBlock=head)**; re-index log:
  `[pool-universe] arb-relevance: enabled=true oversample=2 loopCompleters=3000/3000` — the loop-
  completion ranking filled the **entire** `maxPools` budget with return-venue pools (islands pushed
  out). Startup banner **pair-completion 311→523** (more return-venue pools admitted), total 5159.
- Mode **preserved bounded-LIVE**: node HEAD == origin/main (`91972af`), fresh restart (PID 155237,
  uptime 46s), `SEARCHER_DRY_RUN=0 SEARCHER_EV_GATE=1`, `.deploy-live` present, universe=1500.

## Findings Ledger (carry)
| finding | owner | carry_to | status |
|---|---|---|---|
| Pool-scoring arb-relevance EPIC **slice-1** (loop-completion universe ranking) | R18 | — | **CLOSED (implemented + rule-12 gated + deployed with forced re-index)**; loopCompleters=3000/3000, pair-completion 311→523. **Live no_candidate reduction carried to R19** ([[project-pool-scoring-arb-relevance-epic]]) |
| **Pool-scoring LIVE before/after** — does `no_candidate_plans` (return-venue-gap classes) drop vs R17's 63%, and do genuine +EV `simSuccess` grow? | R19 | R19 | open — measure the new-universe window (non-deterministic funnel metric; before = R17 no_candidate 63%, only_immediate_same_pool_reverse dominant) |
| Victim-source filter live before/after (needs a window with an active serial-reverting sender) | R16→R19 | R19 | open — filter validated (rule-12 + correct live quiet); before/after still pending a qualifying window ([[project-phantom-victim-flow-admission-epic]]) |
| Pool-scoring **slice-2** (per-token-pair 2nd-venue *weighting* not just binary loop-completer; degree-weighted score) | pool-scoring epic | R20 | open — only if slice-1's binary partition proves too coarse in R19 metrics |
| Atomic-backrun market ceiling → posture decision | posture (human gate) | when human decides | open — the production-scale lever; **human gate** ([[project-atomic-backrun-market-ceiling]]) |
| Thin hookless v4 `NotEnoughLiquidity` residual | R14→R19 | R19 | open — measure-first |
| R10 v4 production backfill (systemd `v4-backfill-r14`) | R10→R19 | R19 | open — hookless subset only |

## Verdict + close
- **verdict:** impl-cycle complete — shipped the **pool-scoring arb-relevance EPIC slice-1**
  (loop-completion universe ranking), the R17-localized searcher-side lever, satisfying rule-13
  anti-drift. Generator Codex, evaluator Fable (non-author) ran all gates: **rule-12 flip PASS**
  (count-100 island excluded, low-count return-venue completers admitted), build clean, planner
  regression PASS. Deployed bounded-LIVE with a **forced re-index**: the new scorer rebuilt the
  universe (`loopCompleters=3000/3000`, pair-completion 311→523), mode preserved.
  searcher_behavior_change: **yes.**
- **carry:** pool-scoring live before/after (R19 — does the return-venue-gap `no_candidate` drop from
  63% + do genuine +EV sims grow?), victim-source filter before/after (R19, qualifying window),
  pool-scoring slice-2 (R20, only if needed), posture decision (human gate).
