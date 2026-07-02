# Hermes Round R3 — 20260702 (first round on the DUAL-frame + DUAL-blind method)

> Reads R2 conclusion first. Orchestrator = Fable 5 (user switched mid-marathon). Scope:
> authorized arbitrage research; fork/dry-run; broadcast human-gated.
> **First round to use: (a) the dual-frame question** (primary = nearest blocker to a genuine
> +EV simSuccess; complementary = competitor coverage) **and (b) dual-blind blocker-discovery**
> (fable-5 conclusion A hidden from Codex; Codex gets raw material only → independent B; compare).

## Reads from R2 (previous round)
- **R2 FIXED (deterministic flip):** v4 `take()`/native-deposit use RAW pre-haircut output → no
  nonzero PoolManager delta → no `unlock` revert. Deployed `cf88459`.
- **R2 carried to R3:** live-metrics validation (v4 sim-rejected 79/window → ?; simSuccess ↑?);
  candidate ordering / per-candidate budget (deferred); D economics (open).

## R3 Run Facts (node dry-run, deployed `cf88459` incl. R2 fix, PID 70758)
- Window: block **25443431 → 25443564** (~133 blocks / ~30 min, 07:46→08:12 UTC).
- Funnel: opportunity_seen 54 · plans 159 · solverEntered 81 · **simSuccess 0** · submitAttempts 0
  · **simReverts 0** · expiredBeforeSolver 7 · quoteTimeouts 8. In-window drops include ~46
  `solver/no-profitable-quote`.
- **R2 LIVE-VALIDATED:** v4 `unlock` sim reverts **79/window (R2) → 1 (R3)**, `simReverts=0`. The
  v4 take-haircut fix works live — v4 execution is unblocked.
- **BUT simSuccess is STILL 0.** So the v4 revert was NOT the blocker to a profitable sim. Under
  the OLD "which opp did we lose" framing R2 looked like "the blocker"; under the new PRIMARY
  frame, R3 asks the honest question: **why does nothing produce a +EV simSuccess** even though
  opps reach the solver (81) and v4 no longer reverts? ~46 die at `no-profitable-quote` — the opps
  we see + solve are not profitable for us, yet competitors backran the same public-mempool source
  swaps profitably (R1/R2 evidence). Candidates: economics (profit floor / safety haircut / bribe)
  vs coverage (we route a worse pool subset than competitors) vs pricing.
- Latency this window OK (expired 7/54 ≈ 13%, quote-timeout 8/54 ≈ 15%).

## Competitor Cross-Reference (fable-5 a45a43599926480ae — IN PROGRESS, dual-frame)
- _pending — primary: root-cause simSuccess=0 (+EV); complementary: for opps we dropped at
  no-profitable-quote where a competitor took the same source swap, compare their path/pools
  (in-graph vs out-of-graph) + realized profit vs our best quote. Local reth, zero CU._

## Blocker (dual-blind) → Final → Implement → Gate — pending
- fable-5 → conclusion A (hidden). Then Codex gets raw material only → independent conclusion B.
  Compare A vs B → final blocker.
