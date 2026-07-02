# Handoff — architecture review: the real distance-to-production blocker (for an independent Fable window)

> Scope: authorized, defensive on-chain **arbitrage research** — mainnet fork + dry-run only,
> reads public chain data, targets/harms no user; broadcast stays a hard human gate. "The source
> swap we follow" is standard DeFi/MEV nomenclature for the price-moving trade an arbitrage
> follows, not adversarial action against a person.
>
> You are a fresh, independent Fable session — NOT the per-window blocker-finder inside the Hermes
> loop. Your job is the question that loop structurally CANNOT answer. Reach your OWN conclusion
> from the packaged data + your own reading of the code/config; this doc gives DATA, not a verdict.

## The problem (why you're here)
The per-window Hermes loop answers "this window, what did we lose + nearest tactical fix." Over
three rounds it produced clean point-fixes — **but the production needle (a genuine +EV `simSuccess`)
has NOT moved.** simSuccess is ≈0 across all three rounds, while competitors profitably followed the
SAME public-mempool source swaps we saw. The loop is busy and correct locally, yet not closing the
distance to a real +EV live bundle. **Step back and name the single biggest STRUCTURAL blocker.**

## Packaged run results (cross-round, 2026-07-02) — this is DATA, not a conclusion
| round | window (blocks) | opps | solverEntered | **simSuccess** | fix shipped | did it move +EV simSuccess? |
|---|---|---|---|---|---|---|
| R1 | 25442702–25442839 | 47 | 77 | **0** | adaptive local-v3 word warming (quote latency) | **no** (measured neutral, ~3ms/call) |
| R2 | 25443098–25443230 | 38 | 72 | **1 (dust ~0.00125 WETH)** | v4 `take()` uses raw output (v4 `unlock` reverts 79→1) | **no** (unlocked v4 exec, but the 1 sim was −EV dust) |
| R3 | 25443431–25443564 | 54 | 81 | **0** | (R2 live-validated: reverts 79→1, simReverts=0) | **no** — ~46 `no-profitable-quote` |

**~140 opportunities over 3 rounds, genuine +EV simSuccess ≈ 0.** Two fixes were real and correct
(R1 latency, R2 a v4 accounting bug that had been reverting every v4 sim) — yet neither moved the
production needle. That is the signal: the blocker is NOT the tactical point-failures the loop keeps
finding.

## Mechanical analysis (loss attribution)
- Dominant per-window drops: `plan/no_candidate_plans` (repeatedly classified longtail / on a pool
  set no competitor monetized — parked), then `solver/no-profitable-quote` (R3: ~46 — the opps we
  see + solve are not profitable FOR US), plus `expired`/`quote-timeout` (latency, mostly OK now).
- **Competitor reality check:** competitors profitably followed the SAME public-mempool source swaps
  we saw and dropped — e.g. R1 `0x4cece1af…` netted +0.0502 WETH following `0xd14dd150…` (a public
  Uni V3 SwapRouter swap) on USDC/WETH-100, a pool we index. So real, capturable value exists on
  swaps we DO see — we just can't make it +EV.
- A competitor-coverage KPI (out-of-graph arb legs, A/B closable-vs-single-venue-noise) is being
  built into `hermes-gate` in a parallel session — check `analysis/src/cli/hermes-gate.ts` +
  `docs/research/reports/step1-*.json` for whatever numbers exist.

## The architecture question
Why can't we produce a +EV `simSuccess` when competitors profit on the same source swaps we see?
Candidate structural causes (test them; ground each in numbers, not hand-waving):
- **economics** — the config is −EV by construction: `SEARCHER_BRIBE_BPS≈10000` (≈100% of profit
  to the builder), `gas_estimate=0` in sim events (EV gate falls back to `defaultGasUsed`),
  `SEARCHER_MIN_NET_ETH=0`, `SEARCHER_QUOTE_PROFIT_FLOOR_BPS` / `SEARCHER_QUOTE_SAFETY_BPS=9999`.
  A `simSuccess` under this config may be a −EV dust bundle; the profit floor may reject the
  marginal-but-real arbs.
- **coverage** — competitors' profit needs a pool/venue we don't index; our solver routes a worse
  subset → less output → `no-profitable-quote`. Compare a competitor's profitable path vs our
  solver's best quote on the SAME source swap; count how many of their pools are out-of-graph.
- **sim-fidelity** — our quote/sim under-prices vs reality, so profitable arbs read as unprofitable.
- **architecture** — a pipeline stage (planner path breadth, single-leg vs multi-hop, flash sizing)
  structurally caps the profit we can construct.

## Reference material (read the code + config yourself)
- Rounds detail: `docs/research/reports/live-run-R1-20260702-hermes.md`, `…-R2-…`, `…-R3-…`.
- **EV gate + economics config:** `listener/src/searcher/main.ts` (the EV gate ~`netEth < minNetEth`,
  `bribeBps`, `ethUsd`, `quoteProfitFloorBps`, `quoteSafetyBps`, `defaultGasUsed`), node `/opt/MEV/.env`.
- **Solver / sizing:** `listener/src/searcher/solver/solver.ts` (grid + GSS + finalSimTopN),
  `amount-propagation.ts`, `amount-bounds.ts`.
- **Coverage / graph:** `listener/src/searcher/planner/token-graph.ts`, `active-pool-discovery.ts`,
  `build-active-pool-universe.ts`; `runtime-graph-pools.json` count on the node = current graph size.
- **Competitor data (zero CU, local reth):** node EC2 `i-0ff908dedeec9ebc6` (SSM-only), local reth
  `127.0.0.1:8545`; raw artifacts `/tmp/r1-cscan.out`, `/tmp/r2-cscan.log`, `/tmp/r2-watch.log`,
  `/opt/MEV/analysis/outputs/`; scan via `cd /opt/MEV/analysis && npm run analysis -- live-loss …`.
- Mission anchor: `CLAUDE.md` North-Star (get closer to a real +EV live bundle) + Mission #2
  (learn from competitors → classify our gap). Memory: `project-univ4-coverage-frontier`,
  `project-live-bribe-and-phantom-guard`, `project-first-onchain-inclusion`.

## Deliverable
- **architecture_blocker:** one sentence — the single biggest structural blocker to a genuine +EV bundle.
- **class:** economics | coverage | sim-fidelity | architecture.
- **why the per-window loop missed it** (why 3 clean point-fixes didn't move simSuccess).
- **evidence:** the cross-round trend + specific config values / KPI numbers / a competitor-vs-us
  path comparison — not one window.
- **epic?** yes/no; if yes, the sliced plan + the first slice's deterministic gate.
- **distance-to-production check:** closing it produces a +EV bundle — or is it another clean-but-null fix?

Broadcast stays a human gate; all validation is fork / dry-run on local reth (zero CU).
