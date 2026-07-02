# Hermes Round R1 — 20260702 (full competitor-driven loop)

> Canonical live-run loop (CLAUDE.md Rounds). Blocker-discovery this round is done by a
> FRESH fable-5 sub-agent (Agent tool model:fable, id a322374210363503a). Scope: authorized
> arbitrage research; fork/dry-run; broadcast human-gated. Orchestrator = Opus 4.8 (5-step).

## Reads from previous conclusion (this session, pre-R1)
- **Latency starvation: FIXED + deployed** (expired-before-solver 16.4%→4.1%; per-opp time
  budget). Regression-watch only.
- **native-ETH v4: COMPLETE + deployed** (2a route + 2b exec + 2c pin ETH/USDC fee100).
  LIVE-confirmed: native v4 victims reach the SOLVER (drops all solver-stage, zero plan/graph).
- **Open findings carried in:** D go-live economics (bribeBps=10000, gas_estimate=0,
  minNetEth=0 → simSuccess structurally hard); native coverage breadth (only 1 native pool
  pinned); concurrent-session node restarts disrupting windows.

## R1 Run Facts (node dry-run, deployed `e55f152` via deploy-node.sh)
- Window: block **25442702 → 25442839** (~137 blocks / ~30 min, 05:21→05:47 UTC).
- Funnel: hints 18271 · **opportunity_seen 47** · plans 218 · solverEntered 77 · **simSuccess 0**
  · submitAttempts 0 · expiredBeforeSolver 4 · quoteTimeouts 11 · mempoolOpportunitySeen 47.
- **pipeline_dropped (loss attribution, all 47 opps dropped):**
  - **33 plan/no_candidate_plans (70%)**
  - 7 solver/quote-timeout
  - 4 solver/expired-before-solver
  - 3 solver/no-profitable-quote
- Note: latency regression OK (expired 4/47 ≈ 8.5%, in line). Dominant loss = no_candidate_plans,
  same shape as prior runs → the R1 question is whether these are REAL missed MEV (a competitor
  took them) or longtail noise, resolved by the competitor cross-reference below.

## Competitor Cross-Reference (fable-5 sub-agent a322374210363503a — DONE, ~26 CU)
- **coffeebabe made 0 txs** in the window; `0xae2fc483` made 50 txs, all v4 inventory/CEX-DEX
  pair-trades + sandwich pairs, net ≈ **+$179** — nothing for our backrun-arb shape.
- **The one class competitors monetized = our own SEEN-but-DROPPED bluechip v3 opps:**
  - Take `0x4cece1af354576c623267417fc88a5b50d08621e6e6a63271f4d2746299eb71a` (block 25442793,
    idx 31, bot `0x06cff70886…`): 6 v3 + 2 v4 loop, net **+0.0502 WETH**, backran **OUR EXACT
    victim** `0xd14dd150…` (public Uni V3 SwapRouter `0xe592427a…`, idx 30→31 same block).
    **Our matching drop:** target_block 25442793, pool `0xE0554a476A092703abdB3Ef35c80e0D76d32939F`
    (USDC/WETH fee100), reason **expired-before-solver**. Secondary-validated on Alchemy
    (identical block/idx/swap-count, wethDelta +0.0502).
  - Corroborating: 25442796 `quote-timeout` (same USDC/WETH-100, competitor-taken); 25442765
    double `quote-timeout` (USDC/USDT-100 + USDC/WETH-500, 14-venue taker followed).
- **no_candidate (33) proven longtail:** manual trace of the 5 script-flagged "takes" → 3 plain
  user router swaps, 1 sandwich (not our shape), 1 real arb = **$0.05 dust**. Zero material miss.

## Blocker (fable-5 named; Codex review next)
- **core_blocker:** the solver **doesn't finish quoting bluechip v3 opps inside the TTL** — we
  SEE + PLAN them, then die at `quote-timeout` / `expired-before-solver`, and competitors take
  the exact same victims. USDC/WETH fee100 `0xE0554a47…` alone: killed us 3×, competitor-took 2×.
- **gap_class: unanticipated-gap** (pool in graph, victim = our victim_hash, candidates planned;
  lost in the solver quote stage — not a pool/path gap).
- **fix_direction (fable-5):** prioritize quote order by pool liquidity / victim impact
  (USDC/WETH + USDC/USDT lanes first); per-candidate quote budget with early exit; route these
  bluechip pools through the **already-bit-exact LOCAL v3 quote path** so they never block on
  `eth_call`. Replay fixture: block 25442793 (victim `0xd14dd150`, pool `0xE0554a47`); expected
  transition `expired/quote-timeout → quotes complete + sim.success`.
- **not_this:** the 33 no_candidate (longtail, don't chase); not a v4 pool-gap round.
- **carry-in check:** this REFINES the carried "D economics" assumption — the top live loss is
  NOT economics-gating, it's **solver quote latency on bluechip lanes**; economics matters only
  after we finish quoting. Latency-class blocker (rule 12 → metrics gate, + a replay fixture that
  flips the drop bucket).

## Codex Blocker-Review → Final Blocker → Brief → Implement → Gate — pending
