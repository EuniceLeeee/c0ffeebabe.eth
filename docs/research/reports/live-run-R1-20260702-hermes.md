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

## Competitor Cross-Reference (fable-5 sub-agent a322374210363503a — IN PROGRESS)
- coffeebabe 0xC0ffeEBABE… every tx in window (manual trace) + 0xae2Fc4… sampled, on local reth
  (zero CU), secondary-validated. → classify our gap (pool/path/unanticipated) + name the blocker.
- _pending sub-agent return._

## Blocker (agree first) — pending
- fable-5 names → Codex reviews the blocker → Claude finalizes + Implementation Brief.

## Implementation / Gate / Findings — pending
