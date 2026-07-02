# Hermes Round R1 (post-coverage) — 20260702

> First round after the coverage epic slice-1 (universe load fix) deployed. Orchestrator = Opus 4.8,
> self-driven (rule 14, marker active). Scope: authorized arbitrage research; fork/dry-run; broadcast human-gated.
> Reads: arch-review verdict (coverage lever) + slice-1 Pass A (coverage_planning_fixed, deployed).

## Run Facts (node dry-run, run_id 9a20d602, universe=1500 / graph=4295 pools)
- Window: block **25444356 → 25444538** (~182 blocks / ~36 min).
- Funnel: opportunity_seen **68** · pipeline_dropped 64 · **simSuccess 0** · submitAttempts 0.
- Drops: **38 plan/no_candidate_plans (59%)** · 12 expired-before-solver · 8 quote-timeout · 6 no-profitable-quote.
- no_candidate split: **23 only_immediate_same_pool_reverse** + 15 impact_pool_not_in_routing_graph.

## Coverage slice-1 effect (deployed cf. Pass A + banner fix)
- universe **0 → 1500**, graph **2928 → 4295** pools (the ~1367 return venues the marathon missed).
- no_candidate share **78% (R3) → 59% (R1)**; `impact_pool_not_in_routing_graph` share **47% → 39%**.
- **Necessary but NOT sufficient — simSuccess still 0** (exactly conclusion-A's caveat: topN=1500 alone did not move the needle).

## Competitor cross-reference (competitor-scan, local reth, zero CU) — MANDATORY
The remaining drops ARE competitor-captured (not noise):
- **same_pool_reverse → competitors close via MULTI-HOP:** pool `0x2a6c340b` blk 25444402 → competitor `0x03137905…` **6 pools**; `0x629d22e6` blk 25444453 → `0xfc67b3f5…` **8 pools**; `0xae07459b` blk 25444464/466/502 → `0x672061b7…` **3 pools** (repeat lane). So these are **CLOSABLE multi-hop loops** our planner can't construct (we only see the single impact pool + no direct cross-venue reverse), NOT single-venue noise.
- **latency (quote-timeout) concentrated on `0xe0554a47` (USDC/WETH-100, IN our graph):** competitors `0x28b1dc1a`, `0x0000…1ff3`, `0xccc88a9d` took blk 25444357/25444527 etc. — **recoverable value on pools we already route, lost to solve latency** (worsened by the bigger 4295-pool graph).
- Sophisticated multi-pool bots dominate (0x28b1dc1a, 0x1f2f10d1, 0x00000000a991, 0xc46fcd65, 0x0000…1ff3) running 3–16 pool arbs, incl. Uni v4 (`0x000000000004444c…`).

## Blocker (two competitor-confirmed, self-driven decision)
- **B1 — latency on in-graph pools (PRIMARY for R2):** 20/64 drops are expired/quote-timeout, heavily on `0xe0554a47` and other pools ALREADY in our graph; competitors captured them. This is **recoverable value we can already route**, and slice-1's bigger graph made solve latency worse (the coverage↔latency tension). Fixing it is the fastest path to a first genuine +EV `simSuccess`.
- **B2 — multi-hop path for same_pool_reverse (carry):** 23 loops competitors close via 3–8 pool multi-hop that our planner can't construct. Deeper (planner path-breadth / pair-neighborhood coverage). carry_to_round: R3.

## Findings Ledger
| finding | owner | carry_to | status |
|---|---|---|---|
| coverage slice-1 lowered no_candidate 78%→59% but simSuccess still 0 | R1 | — | measured (necessary-not-sufficient) |
| **B1 latency on in-graph pools (0xe0554a47), worsened by 4295-pool graph** | R2 | R2 | open → R2 fix |
| B2 multi-hop path for same_pool_reverse (competitor 3–8 pool loops) | R3 | R3 | open (carry) |
| economics wall (Codex-B slice-3 spec ready) | slice-3 | go-live | open |
