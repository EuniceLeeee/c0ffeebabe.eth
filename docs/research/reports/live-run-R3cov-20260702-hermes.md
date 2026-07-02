# Hermes Round R3 (post-coverage) — 20260702: pair-completion admission

> Reads R2. Orchestrator = Opus 4.8, self-driven. Blocker-finder A = fresh fable-5 (a61e1ae7, verified
> pure fable-5, no fallback). Scope: authorized arbitrage research; fork/dry-run; broadcast human-gated.

## Blocker (R1/R2 carry → R3) — dual-blind, A's chain-trace DECISIVE
Fable-A (chain-trace) + Codex-B (code-side). Both exonerated DFS/templates. They DIVERGED on primary —
Codex-B guessed PATH-BREADTH (maxHops/fanout); Fable-A's on-chain trace RESOLVED it to COVERAGE/ADMISSION:
the global top-1500 universe cutoff drops a hot lane's low-activity SAME-PAIR alternate venue (v3
fee-10000 14feE680/WETH `0x49bd1fa4`, score 3 < cutoff 11) → `cross_venue_reverse_count=0` → no close.
**Fable-A honesty (crucial):** B2 is partly a scan artifact — of 4 cited competitor takes only 1 is
graph-fixable; 2 are sandwich / 1inch-LOP shapes we don't run, 1 was mislabeled. Traced captures small
($0.25–0.90); the "$200 0x68e77ef1" was NOT traced.

## Fix + gate
`selectPairCompletionPools` (pool-universe.ts) — admit every below-cutoff universe pool whose token PAIR
is already in the runtime set (zero extra RPC, v4 skipped). Gate PASS (deterministic flip, Claude-run):
`b2-14fee-weth-pair-gap` (0 plans) → `b2-14fee-weth-pair-flip` (plans>0 cross-venue); single-venue-longtail
stays 0; planner 12/12 + 10/10, pool-universe 7/7. Deployed: banner **+239 pair-completion → graph 4541**.

## Live (run 6c9a0d65, blocks 25445267–25445413, 72 opps) — MARGINAL, confirms Fable-A caveat
| metric | R2 | R3 |
|---|---|---|
| simSuccess | 2 | **4** |
| sim sizes | $0.04, $0.61 | $0.35 / $0.34 / $0.01 / $0.30 — **all dust** |
| same_pool_reverse (of no_candidate) | 18 (72%) | **26 (81%)** — did NOT drop |
| candidate-cap bail | 12 | 9 (cap still active) |
| latency (expired+timeout) | 12% | 22% (graph 4541) |
- pair-completion is deterministically correct but this window's `same_pool_reverse` were mostly
  **non-closable noise** (sandwich / resting-order, no alternate venue) — exactly Fable-A's caveat. The
  239 admitted alternates didn't flip this window's cases. simSuccess 2→4 but still dust.

## Findings Ledger
| finding | owner | carry_to | status |
|---|---|---|---|
| R3 pair-completion: below-cutoff same-pair alternates admitted | R3 | — | **implemented + gate-flip PASS**; live marginal (this window's cases non-closable) |
| same_pool_reverse bucket dominated by non-closable noise (sandwich/resting-order) | reclassify | next | open — funnel over-counts recoverable loss; reclassify into a distinct bucket |
| **3 rounds: funnel fixed (simSuccess 0→2→4) but ALL DUST; genuine +EV = 0** | ARCH-REVIEW | now | **architecture-review trigger FIRED (rule 13)** |
| economics: dust→−EV (bribeBps=10000, 12M gas) — Codex-B slice-3 spec ready | slice-3 | go-live | open |
