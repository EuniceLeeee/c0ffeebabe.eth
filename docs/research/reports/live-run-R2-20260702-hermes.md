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

## Competitor Cross-Reference (fable-5 a4ce4230b9e2f0674 — DONE, ~1 Alchemy CU)
- **R1 VERDICT: NEUTRAL — the adaptive warm is NOT the latency killer (my hypothesis DISPROVEN
  by measurement).** TickLens round-trip p50 **3.0ms** (max 44); worst opp did 112 warms ≈ 336ms
  of its 5011ms. Decisive counter-case: v4 victim `0x7563f458` expired at 6534ms with **ZERO**
  adaptive warms (pure sim cost). The R2 rate rise vs R1 = **window variance** (more v4-heavy /
  competitive: 46 watchlist txs in 132 blocks), not R1. **Keep the adaptive warm.**
  *(This is exactly the deterministic round-trip/latency measurement that the latency-gate
  optimization calls for — it resolved the R1 question pre-emptively.)*
- **Where the 5s TTL actually goes:** `match+fork+prep+detect+plan ≈ 150ms`; the remaining
  ~5000ms is the **candidate quote+sim loop** (7 grid pts + sim-top-3 per candidate,
  candidatesTried up to 15/20). Window logged **126 sim-rejected, 79 of them on the v4 singleton**.
  **Sims dominate; warms don't.**
- **Competitor takes of our exact expired victims (public mempool, pools we index):**
  `0x89c0a738` (pool 0xE0554a47) → bot 0x06cff708 idx 88; `0x7563f458` (v4 singleton) → bot
  0x28b1dc1a idx 186 (Alchemy-validated); `0xa4568aa5` (0x11b815ef) → 0xe0137c50; `0xa1c960eb`
  (v4 singleton) → 0x96b558a4. Victims `to` = public routers (1inch/Uniswap) → **we saw them
  (`src=mempool`) and lost to pre-solver latency.** Faster solving competes.

## Blocker (fable-5 named; Codex review next)
- **core_blocker:** the pre-solver **candidate quote+sim loop exceeds the 5s hint-TTL** on
  multi-hop (esp Uni v4) candidates → ~12/38 opps expire/timeout before the solver commits, and
  competitors take those exact public-mempool victims. The sink is **sims (esp 79 v4-singleton
  reverts/window), not R1's warms.**
- **gap_class: unanticipated-gap (latency).**
- **fix_direction:** (1) fix or fast-skip the **v4-singleton sim-revert path** (79 reverts/window,
  wasted seconds); (2) **cap sims-per-candidate / candidates-tried as hint age nears TTL** so ≥1
  full solver pass completes; (3) tighten the geometric grid's max flash amount (probes crossing
  the whole book bloat warms + produce reverting sims).
- **not_this:** R1 adaptive warm (~3ms/call, keep); no_candidate_plans (17, separate pool set).
- **carry-in note:** Cycle-1 added a per-OPP slice (planBudgetMs/oppMinSliceMs) but the
  **per-candidate SIM loop is still not TTL-budgeted** — this is the refinement R2 targets.

## Codex Blocker-Review (b7dx4jgji) — CONFIRMED + REFINED (found a real v4 bug)
Codex did the code-side independent verification (its unique value vs fable-5's chain side) and
**refined the blocker from "latency" to a deterministic v4 accounting BUG:**
- **Root of the 79 v4 sim reverts = the quote-safety haircut applied to the v4 `take()` amount.**
  `SEARCHER_QUOTE_SAFETY_BPS=9999` (main.ts:290) → `propagateAmounts` haircuts every hop output
  (amount-propagation.ts:48) → the v4 plan-builder uses the haircutted `amtOut` as the PoolManager
  `take()` amount (plan-builder.ts:281). For v4 exact-input, **taking LESS than the real output
  leaves a nonzero PoolManager delta at unlock end → `unlock` reverts.** Selector `0x48c89491` =
  `unlock(bytes)` (outer wrapper). The R2 v4-native fork gate passed with EXACT quoted output, so
  it never exercised this safety-haircut live path.
- **Latency (2nd):** `solver.solve()` checks the deadline BEFORE sim, but `await probe.simulate()`
  has no in-flight timeout (solver.ts:256/318); Cycle-1's per-opp slice bounds candidate BOUNDARIES
  only, not an in-flight sim. `candidatesTried` is the real multiplier (maxCandidatesPerOpp=0=unlimited).

## Final Blocker (Claude) + Implementation Brief — drives code
- **Blocker (final):** two coupled issues on v4 candidates: **(A, primary) a real v4 execution bug**
  — the safety haircut on the v4 `take()` amount leaves a nonzero PoolManager delta → `unlock`
  reverts (79/window), wasting seconds of sim time AND making v4 arbs unexecutable; **(B, secondary)**
  the per-candidate sim loop is not TTL-budgeted (one slow/reverting sim burns the hint TTL).
- **searcher_behavior_change: yes** — v4 sims stop reverting (catch v4 MEV) + sim loop bails in budget.
- **Fix (this round = A, the deterministic bug; B as a bounded guardrail):**
  - **A:** in the v4 `univ4-unlock` build, `take()` the RAW v4 quote output (full amount owed by the
    PoolManager), and apply the safety haircut ONLY to the downstream spendable amount — never take
    less than the pool owes. Files: `plan-builder.ts` (univ4 take amount ~281),
    `amount-propagation.ts` (haircut boundary ~48). Keep non-v4 behavior identical.
  - **B (guardrail):** cap `candidatesTried` / bail the sim loop when hint age nears TTL so ≥1 full
    solver pass completes. Small, in `main.ts` candidate loop / `solver.ts`.
- **GATE (deterministic repair-replay flip):** a pinned v4 fixture with `quoteSafetyBps=9999` —
  **baseline: full BotVM sim REVERTS at `unlock`; after fix: sim SUCCEEDS, no revert** (fork gate,
  local reth, zero CU). Plus op-count: v4 candidates no longer emit the take<output condition.
  Live confirm (carry): v4 sim-rejected drops from 79/window; expired/quote-timeout ↓; simSuccess ↑.
- **not_this:** R1 adaptive warm (measured fine); grid tightening (3rd, defer).
- **verdict:** pending Codex impl + gate.
