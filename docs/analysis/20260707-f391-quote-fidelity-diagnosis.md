# 0xf391d0 rule-12 gate → the quote-fidelity loss-attribution axis (F-014)

**Date:** 2026-07-07 · **task_class:** competitor_path · **tx:** `0xf391d0…` (blk 25462190) · **commits:** d2e73ba (silo edge + gate), f17807d (F-013/F-014), ccc9067 (forensics tooling)

Authorized defensive arbitrage research (fork / dry-run; broadcast human-gated).

## Question
Build the rule-12 gate for the just-built srUSDe→sUSDe silo edge — i.e. **confirm 0xf391d0's atomic protocol loop actually reproduces** through our planner+solver, not just that the code compiles. Follow-up to the design round ([20260707-srusde-silo-redeem-edge-design.md](20260707-srusde-silo-redeem-edge-design.md), F-013).

## What happened
The silo edge is **proven**, but building the gate surfaced a **separate, decisive gap** that no prior analysis had a name for.

The gate `searcher:blockscan-fork-solve-f391` @25462190 **PASSes 8/8** on the silo edge itself:
- **Emission (real branch):** srUSDe → exactly ONE `erc4626-redeem-silo` edge (tokenOut=sUSDe, no deposit edge); a flagged vault WITHOUT `redeemTokenOut` → ZERO edges (fail-closed).
- **Quote diff = 0:** `quoteSiloRedeem` reproduces the on-chain sUSDe payout `773988351883794733939` **byte-exact** on the pre-competitor fork.
- **Composition:** the planner composes the 4-leg ring `USDC→srUSDe→sUSDe→USDT→USDC` through the silo leg.

But the **full +EV solve is blocked** — and NOT by the silo edge. The loop's **entry leg** (USDC→srUSDe on v4 pool `0xc069abea`) cannot be quoted: our V4Quoter reverts `NotEnoughLiquidity` for USDC→srUSDe at **every** size (incl. 1 USDC) at the execution state, while the **reverse** srUSDe→USDC quotes fine and the competitor's **real** swap filled 949.49 USDC → 934.46 srUSDe. No JIT (only a Swap, no ModifyLiquidity; slot0 tick −276166 and pool liquidity unchanged pre/post). **Our quoter's tick-traversal diverges from the core PoolManager.swap for this pool's one-sided liquidity** — recorded as **F-014**.

**The reusable outcome:** this is a *quote-fidelity* gap — a distinct loss-attribution axis from pool-gap / path-gap / latency. We had the pool, the edge, and the composed loop; the quoter simply lied about a leg the real swap filled. It was then codified so the next one is caught automatically (ccc9067):
- `validate-v4-quote.ts` → a general quote-**fidelity** harness (classifies quote-vs-real as reproduced / diverged / **reverted**; probes both directions; pins the F-014 divergence — flips when fixed).
- `swap-log-registry.ts` `v4SwapFillFromLog` → the **signed** per-side real fill (the existing decoder kept only a lossy `sizeRaw`).
- `bundle-postmortem.ts` `decodeV4SwapFills` + `detectJitLiquidity` → the real per-leg fills + JIT self-provision flag, wired into the any-tx report.

## Two traps that cost the most time (both are reusable warnings)
1. **Block-number hex.** 25462190 = `0x18485AE`, NOT `0x18452AE` (= 25449134, ~13k blocks earlier). The wrong hex silently forked stale state → the silo quote was off by 1.9e16 and looked like a formula bug. **Always verify the fork-anchor block number, not just the tx hash.**
2. **Vesting-token timestamp.** sUSDe and srUSDe accrue value per-second. `eth_call` on a fork reads the HEAD block timestamp; `evm_setNextBlockTimestamp` only sets the NEXT mined block. So **pin the timestamp AND mine an empty block** to move the head to the competitor's block timestamp — otherwise the quote drifts ~1.9e16 (the red-team predicted exactly this). After the pin: diff = 0.

## Method Trace
task_class:       competitor_path
tools_used:       - node --import tsx run of a new fork-solve gate (searcher:blockscan-fork-solve-f391): AnvilStateBackend.forkAfterTx(txIndex 85) + real buildTokenGraph emission + planner + solver on archive-fork state
                  - cast eth_call probes of the V4Quoter (0x52F0E24D) at historical blocks 25462189/25462190 in BOTH directions and across sizes (1 USDC → 1200 USDC) to bisect the fillable/quotable boundary
                  - cast receipt-log decode of the competitor's PoolManager Swap events (int128 amount0/amount1 → real per-leg fills + direction) and ModifyLiquidity scan (JIT test)
                  - cast extsload of the v4 pool slot0 (sqrtPriceX96 + tick) and liquidity slot at both blocks (state identical pre/post → rules out state change)
                  - cast keccak / 4byte to identify the revert selector (0x7a5ed734 = NotEnoughLiquidity(bytes32), wrapped in 0x6190b2b0)
                  - direct state.provider.call warming (bypassing state.call's 30s cap) to load cold archive v4 tick state before the solver
                  - npm run test:noise-filter (47/47) + test:swap-log-registry + searcher:validate-v4-quote to gate the codified functions
evidence_order:   1. gate build → solver fails on a v4 eth_call TIMEOUT (cold-fork fetch, not logic) 2. warm via provider.call → solver now fails on a REVERT, not a timeout 3. decode the revert: NotEnoughLiquidity on c069abea at maxInput 4. bisect sizes on the fork → reverts at EVERY size incl. 1 USDC 5. probe historical archive both directions → reverse OK, forward reverts; same at 25462189 and 25462190 6. decode the real Swap fill → competitor filled 949 USDC forward; check ModifyLiquidity → none (no JIT); check slot0/liquidity → unchanged 7. conclude quoter-vs-real divergence (F-014), independent of the silo edge 8. codify: fidelity harness + real-fill/JIT decoders + tests
analysis_frame:   - a rule-12 gate must exercise the REAL emission/quote path, not hand-seeded edges — and must separate what is PROVEN (silo edge) from what is BLOCKED (entry leg), never a false green nor a hard fail on an unrelated gap
                  - a solver "no plan" is not a verdict until you read WHY: timeout (infra) vs revert (logic) vs −EV (economics) are different root causes; drill to the failing eth_call
                  - quote-fidelity is a first-class loss-attribution axis alongside pool-gap / path-gap / latency: having the pool + edge + composed loop does NOT imply the quoter can price the leg
                  - reconcile our quoter against the REAL on-chain fill in BOTH directions — one-sided divergence (reverse ok, forward reverts) is the signature of a tick-traversal/quoter gap, distinct from a genuinely illiquid pool
                  - JIT self-provision (ModifyLiquidity before Swap, same tx) makes a competitor take non-reproducible against standing liquidity — a separate non-comparable signal to check before calling something a gap
sanity_checks:    - timeout vs revert distinguished before diagnosing (warmed the fork to convert the failure mode, proving it was not just cold state)
                  - probed BOTH directions and TWO historical blocks (25462189/25462190) — reverse-ok + forward-revert at both rules out a transient/mid-block state cause
                  - confirmed NO JIT (no ModifyLiquidity on the pool in the tx) and slot0/liquidity identical pre/post — the divergence is the quoter's, not the state's
                  - block-hex re-derived (25462190 = 0x18485AE) after the first fork gave a nonsense 1.9e16 quote diff — caught a wrong-block fork, not a formula bug
                  - timestamp pinned + empty block mined → silo quote diff dropped to 0, confirming the earlier drift was vesting accrual (the red-team's predicted failure mode), not error
                  - the fidelity harness reproduces a KNOWN-GOOD v4 swap (USDC/USDT, diff 0bps) before asserting the c069abea divergence — so a PASS on divergence is not a false positive from a broken harness
tool_gap:         our loss-attribution toolset had NO quote-fidelity axis — validate-v4-quote tested only one hardcoded pool on the happy path and THREW on a revert; swap-log-registry decoded v4 Swaps to a lossy sizeRaw (no signed fill); bundle-postmortem surfaced v4 poolIds but not the real fills or JIT. A competitor loop we can't reproduce could be silently mis-attributed to pool/path/latency.
codify_next:      DONE (ccc9067): quote-fidelity harness (searcher:validate-v4-quote) that classifies reproduced/diverged/reverted + pins F-014; v4SwapFillFromLog (signed fills); decodeV4SwapFills + detectJitLiquidity in bundle-postmortem (wired into the report). OPEN (spawn_task): the actual F-014 fix — a v4 entry-quote path (local tick-math / StateView traversal) that matches the core swap for one-sided pools; the f391 gate's deferred +EV check flips to a real solve once it lands.
distill_for_opus: When reproducing a competitor's loop fails at the SOLVE step, do not stop at "no plan" — drill to the failing eth_call and classify it: a timeout is infra (warm the fork), a revert is logic, −EV is economics. If it's a revert, RECONCILE our quoter against the real on-chain fill in BOTH directions at the execution block: reverse-ok + forward-revert (NotEnoughLiquidity) on a pool the real swap filled is a QUOTE-FIDELITY gap — a distinct loss axis from pool/path/latency, invisible to coverage tools because we DO have the pool. Two mechanical traps that masquerade as logic bugs: a wrong fork-anchor BLOCK (verify the hex, not just the tx hash) and per-second-vesting tokens (pin the timestamp AND mine an empty block, else eth_call reads a drifted head timestamp). Codify the check as a both-directions fidelity harness that pins the known gap and flips when fixed.
