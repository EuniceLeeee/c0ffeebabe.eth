# Handoff — architecture review #2: dust ceiling (post-coverage-epic + latency fix)

> Scope: authorized, defensive on-chain **arbitrage research** — mainnet fork + dry-run only, reads
> public chain data, targets/harms no user; broadcast stays a hard human gate. "Source swap" /
> "triggering swap" = standard DeFi/MEV nomenclature for the price-moving trade an arbitrage follows.
>
> Trigger: CLAUDE.md rule 13, fired by `docs/research/reports/live-run-R3cov-20260702-hermes.md`
> Findings Ledger — 3 consecutive rounds (R1cov/R2cov/R3cov) closed with genuine +EV `simSuccess` ≈ 0
> (funnel now produces simSuccess 0→2→4, but every sim is DUST, $0.01–$0.65). This is architecture
> review **#2** — the first (`arch-review-20260702-verdict.md`) localized `simSuccess=0` to COVERAGE
> and that epic landed (slice-1 + R3's pair-completion). This review answers the NEXT question: now
> that the funnel reaches profitable sims, why is every one dust, and what is the fixable lever to a
> genuine +EV bundle.

## R1..R3 (post-coverage) round table — the flat/dust evidence that fired this trigger
| round | window (blocks) | opps | no_candidate | simSuccess | sim sizes | fix shipped | +EV needle |
|---|---|---|---|---|---|---|---|
| R1cov | 25444356–25444538 | 68 | 38 (59%) | **0** | — | (measured coverage slice-1 effect only) | no |
| R2cov | 25444933–25445075 | 55/49 | 25 (51%) | **2** | $0.04, $0.61 gross/$0.49 net | candidate-cap 0→6 (latency) | no (dust) |
| R3cov | 25445267–25445413 | 72 | 26 same_pool_reverse (81%) | **4** | $0.35/$0.34/$0.01/$0.30 | pair-completion admission | no (dust) |

Cumulative: coverage epic (universe 0→1500, graph 2928→4295→4541) + latency fix (candidate cap) +
pair-completion (+239 pools) — three real, gate-verified fixes — moved simSuccess 0→2→4 but **every
sim stayed dust**. That flatness in *genuine* +EV (not raw simSuccess count) is what fired rule 13.

## Current repo mechanisms snapshot (so this review doesn't re-propose landed work)
- **Coverage:** `SEARCHER_POOL_UNIVERSE_TOP_N` now defaults `1500` (main.ts:342, was the `topN=0` bug,
  fixed). `selectPairCompletionPools` (pool-universe.ts) admits below-cutoff same-pair alternates
  (R3, +239 pools). Runtime graph ~4541 pools. `discovery-queue.json` exists
  (`listener/searcher/pools/discovery-queue.json`) — a learn→close auto-enqueue mechanism, already landed.
- **Path breadth:** `SEARCHER_MAX_HOPS` defaults **3** (main.ts:301/371, planner internal cap is 8 but
  main.ts overrides to 3 — `planner.setMaxHops(maxHops)`). R1cov's B2 finding: competitors close
  `same_pool_reverse` loops via **3–8 pool multi-hop** paths our planner "can't construct" — but with
  maxHops=3, a ≥4-hop competitor loop is structurally unreachable regardless of graph coverage. This
  was flagged as Codex's "runner-up" hypothesis in arch-review #1 and never tested.
- **Economics (dry-run today):** `SEARCHER_EV_GATE` defaults OFF (`=== "1"` gate, unset in `.env`);
  `SEARCHER_BRIBE_BPS` defaults **10000** (bidEth = 100% of expectedProfitEth → netEth = −gasCostEth if
  gate were on); `SEARCHER_BACKRUN_GAS_USED`/`defaultGasUsed` defaults **12000000** (main.ts:315);
  `SEARCHER_MIN_NET_ETH` defaults `0`. **Anvil sim still returns `gasUsed: 0n` unconditionally**
  (`listener/src/searcher/simulator/botvm-simulator.ts:55,66`, re-verified this firing, unchanged since
  Codex-B's earlier finding) → `main.ts:1655/1693` falls back to the 12M `defaultGasUsed` fallback
  whenever an EV check runs. Minimal slice-3 spec already written (Codex-B,
  `docs/research/reports/epic-coverage-slice1-20260702.md:163-178`): `EV_GATE=1` +
  `BRIBE_BPS<10000` + realistic gas → verified disproof `bribeBps=5000, gas=2M, 1gwei → netEth=+0.002228 ETH`
  on the R1-marathon's 0.01557 WETH lane. **This is dry-run-only — EV gate is OFF live, so economics
  config does NOT explain why R2cov/R3cov's sims were dust; it only bites once a real +EV-sized quote exists.**

## Pinned counterfactual cases (real competitor captures, this window's Step-1 — not dust/revert)
1. **R1cov `0x2a6c340b` (blk 25444402) → competitor `0x03137905…` closed via 6 pools.** Impact pool IS
   in our graph (post-coverage); no direct cross-venue reverse; competitor routed a 6-hop loop. Our
   `maxHops=3` cannot construct a 6-hop path even with full pool coverage.
2. **R1cov `0x629d22e6` (blk 25444453) → competitor `0xfc67b3f5…` closed via 8 pools.** Same shape,
   8-hop. Structurally unreachable at maxHops=3.
3. **R1cov `0xae07459b` (blks 25444464/466/502, repeat lane) → competitor `0x672061b7…` closed via 3
   pools.** This ONE is within maxHops=3 — worth tracing whether it's a coverage residual (missing a
   3rd-leg pool) vs a genuine solver miss, since it's the one case in this batch our planner *should*
   reach.
4. **R3cov `14fee/WETH` `0x49bd1fa4` pair-completion case** — deterministically fixed (gate PASS) but
   this window's live `same_pool_reverse` instances were **non-closable noise** (sandwich / 1inch-LOP
   resting orders per Fable-A's R3 trace) — a negative case: proves not everything in that bucket is a
   graph/path gap, some is a strategy-shape gap (sandwich/LOP) we don't run at all.
5. Reviewer should find ≥1 more independently from raw Step-1 artifacts (competitor-scan JSON /
   watch reports for the R1cov/R2cov/R3cov windows, in scratchpad or regenerate via
   `analysis live-loss --competitor-scan` against the local reth node for the same block ranges).

## The question (four-way split — do NOT skip case #3's "one reachable case" nuance)
Given three real fixes landed (coverage, latency, pair-completion) and simSuccess is dust not zero,
localize the PRIMARY reason the funnel can't yet produce a genuine +EV bundle:
- **path-breadth** — competitor loops need >3 hops (cases #1/#2); our `maxHops=3` cap is the wall,
  independent of pool coverage. (→ fix: raise `SEARCHER_MAX_HOPS`, gated on latency — more hops =
  more candidates = the exact latency tension R2cov just fixed for maxHops=3-sized candidate lists.)
- **strategy-shape gap** — the BIG competitor value (sandwich, 1inch-LOP resting-order fills, v4) is a
  shape we structurally don't run at all, not a graph/path gap (case #4). No amount of coverage/path
  fixes an atomic-arb-only searcher into catching those. (→ epic-scale, out of this loop's reach.)
- **genuine dust ceiling** — the atomic bluechip triangles (WETH/USDC/USDT/DAI) we CAN construct are
  real but structurally small in an efficient market; there is no larger *replicable atomic* opportunity
  hiding behind path/coverage limits, only the $0.01–$0.65 class we're already finding. (→ economics
  slice-3 is the only remaining lever, and it caps out small.)
- **economics-adjacent sim-fidelity** — the `gasUsed=0n` Anvil sim bug means our sim doesn't even see
  the TRUE gas cost of wider/multi-hop bundles; a genuinely +EV wider bundle might look artificially
  cheap in dry-run OR (once EV_GATE=1) artificially killed by the 12M fallback. Either way this
  compounds whichever of the above is primary and should be named as a secondary lever regardless.

## Hard requirements (from template, do not skip)
1. Counterfactual walk on ≥2 real captures (≥1 pinned above + ≥1 self-found) — derive the class, don't
   pick it. State per-case: saw it? planned? solver's best quote? which stage/gate killed it? how far off.
2. Re-derive load-bearing numbers yourself from `file:line` / raw artifacts — R1–R3cov's conclusions
   (including their dual-blind results) are HYPOTHESES from inside the loop you're reviewing, not ground truth.
3. Name a runner-up + the evidence that separates primary from runner-up + a cheap disproof experiment.
4. Before proposing anything as an epic slice, grep/read what's already landed (coverage epic slice-1,
   pair-completion, candidate-cap) — do not re-propose it.

## Deliverable format
`localized_lever: path-breadth | strategy-shape-gap | dust-ceiling | sim-fidelity | <other, named>`
+ evidence + runner-up + cheap disproof + `decision: epic | funnel-fix | accept-dust-ceiling`.
