# Hermes Round R2 (post-coverage) — 20260702: latency fix (candidate cap)

> Reads R1 (post-coverage). Orchestrator = Opus 4.8, self-driven (rule 14/15). Scope: authorized
> arbitrage research; fork/dry-run; broadcast human-gated.

## Blocker (R1 carry → R2) — dual-blind CONVERGED
Fable-A (node+code) + Codex-B (code-side), independent + blind, both localized the SAME latency sink:
the **unbounded serial candidate loop** — `SEARCHER_MAX_CANDIDATES_PER_OPP` defaulted `0=off` (main.ts:324),
so a saturated 20-plan opp grinds ~404ms/candidate × up to 20 ≈ 8.1s > the 5s hint-TTL → expiry at
candidate ~12. Slice-1's bigger graph worsened it (~20% more opps carry saturated 20-plan lists). The bail
code already shipped (cfbf4c4, main.ts:1388) but the default left it inactive. Fable-A empirically: all
profitable sims resolved within the first few candidates → cap loses NO found bundles.

## Fix
main.ts:324 default `SEARCHER_MAX_CANDIDATES_PER_OPP` `0`→`6` (activates the existing bail; env-overridable;
topN-style bad-default). Deployed `origin/main`; node banner universe=1500/graph=4299, DRY_RUN=1.

## Gate — rule-12 latency exemption (before/after live METRICS), PASS
Window run_id `e2f44b72`, blocks 25444933–25445075, 55 opps:
| metric | R1 | R2 | verdict |
|---|---|---|---|
| expired-before-solver + quote-timeout share | **32%** (20/64) | **12%** (6/49) | ✅ < 15% target |
| candidate-cap bails (the fix firing) | 0 | **12** | mechanism active |
| no_candidate | 38 (59%) | 25 (51%) | — |
| **simSuccess** | **0** | **2** | needle off zero (but see below) |
verdict: **latency FIXED** (metrics gate pass). solverEntered non-decreasing; cap did not lose bundles.

## simSuccess 0→2 — but DUST, not genuine +EV (rule: do not celebrate dust)
- Sim1 blk 25444938: +0.0375 DAI ≈ **$0.04** (DAI→WETH→USDC→DAI bluechip triangle) — dust.
- Sim2 blk 25444991: +0.000175 WETH ≈ **$0.61 gross / $0.49 net** (WETH→USDC→USDT→WETH) — small.
The coverage+latency fixes unblocked the funnel to REACH profitable sims (pipeline works end-to-end again),
but these are small bluechip-triangle arbs. The BIG value (competitor $200 longtail multi-hop, e.g.
`0x68e77ef1`) is still blocked by B2; and economics (bribeBps=10000 + 12M gas fallback ≈ 0.024 ETH) makes
even these −EV (Codex-B). **No genuine +EV simSuccess yet.**

## Findings Ledger
| finding | owner | carry_to | status |
|---|---|---|---|
| R2 latency: candidate loop unbounded (MAX_CANDIDATES_PER_OPP=0) | R2 | — | **FIXED** (0→6; expired+timeout 32%→12%; 12 bails) |
| **B2 multi-hop path for same_pool_reverse (18 this window; competitor 3–8 pool loops)** | R3 | **R3** | open → R3 (the BIG longtail value) |
| economics: dust/−EV sims (bribeBps=10000, 12M gas) — Codex-B slice-3 spec ready | slice-3 | go-live | open (make sims +net once B2 sizes them up) |
| runner-up per-candidate quote budget (kills 3.9s cold-quote tail) | after R3 | later | carry (if cap alone leaves latency) |
