# Hermes Round R2 — 20260702 (full competitor-driven loop)

> Reads R1 conclusion first (rule 13). Blocker-discovery by a FRESH fable-5 sub-agent.
> Orchestrator = Opus 4.8. Scope: authorized arbitrage research; fork/dry-run; broadcast human-gated.

## Reads from R1 (previous round)
- **R1 FIXED (deterministic flip):** adaptive local-v3 bitmap-word warming removes the ±8
  word-miss → QuoterV2/eth_call fallback (bit-exact vs QuoterV2). Deployed `397bbd7`.
- **R1 carried to R2:** (1) live-metrics validation — does the adaptive warm reduce bluechip
  `quote-timeout`/`expired`? (2) candidate quote ordering by impact + per-candidate budget
  (2nd guardrail, deferred). (3) 33 no_candidate = longtail (closed). (4) D economics (open,
  not top live blocker).

## R2 Run Facts (node dry-run, deployed `397bbd7` incl. R1 fix, PID 68800)
- Window: block **25443098 → 25443230** (~132 blocks / ~30 min, 06:40→07:06 UTC).
- Funnel (cumulative since restart): opportunities 38 · plans 269 · solverEntered 72 ·
  **simSuccess 1** · submitAttempts 1 · expiredBeforeSolver 9 · quoteTimeouts 12.
- **R1 LIVE-VALIDATION (ambiguous — key R2 question):**
  - **`adaptive warmed univ3` fired 1792×** — the ±8 word-miss was hitting nearly every
    bluechip quote; the fix is very active (correctness path works live).
  - **BUT latency drops did NOT improve:** R2 expired 9/38 (24%) + quote-timeout 12/38 (32%)
    vs R1 8.5% / 15%. **Hypothesis:** the adaptive warm does N *sequential* per-word TickLens
    round-trips; a deep bluechip crossing (5–10 words) may cost MORE latency than the single
    QuoterV2 fallback it replaced → R1 fixed correctness but not (maybe worsened) latency.
    Confound: window variance (R2 busier/more competitive). fable-5 must disambiguate.
  - **Progress signal:** R2 produced **2 profitable sims + 2 submit attempts** (dust: 4137 units
    / ~0.00125 WETH) — R1 had 0. `0xadf8047017` WETH-profit path `WETH→USDC→USDT→WETH` (v3).

## Competitor Cross-Reference (fable-5 sub-agent — IN PROGRESS)
- _pending — coffeebabe every tx + 0xae2Fc4 sampled over 25443098→25443230, local reth, zero CU._

## Blocker / Implement / Gate — pending
