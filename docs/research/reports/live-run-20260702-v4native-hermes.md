# Hermes — Cycle 20260702-v4native: native-ETH v4 routing (the ETH-paired 92%)

> Epic slice. Opens the biggest single extraction lever: competitors route ~92% of
> their v4 MEV through native-ETH pairs (ETH/USDC, ETH/USDT — PoolKey currency == 0x0),
> and **0 of ours ever enter the funnel** because a native-ETH graph node is a dead-end
> (flash + all v2/v3/curve legs are WETH). Authorized arbitrage research; fork/dry-run;
> broadcast human-gated. Generator = Codex gpt-5.5 xhigh; Claude = orchestrator/evaluator.

## Scope correction (carried from handoff — VERIFIED in code 2026-07-02)

Handoff/earlier memory said native-ETH v4 needs a `BotVM.sol` change + redeploy. **False.**
`BotVM.sol` has opcode `0x01` (CALL-with-value, since first commit `f964ae5`), `0x04`
(WETH unwrap), and payable `receive()`; TS `encodeCallValue` + `weth-withdraw` adapter
already exist. **No contract change, no redeploy.** The gap is TS-only and starts UPSTREAM
of execution: native ETH (0x0) is a dead-end graph node. Also corrected: the blocker is
NOT `pool-impact.ts:511` (that's a v2/v3 token0/token1 query) nor `token-graph.ts:287`
(that's curve `coins()`); the real seam is the v4 decoder + the univ4 edge build.

## Claude Final Decision — 2 slices, each independently gated (rule 13 epic slicing)

- **Slice 2a (this cycle): routing unblock.** Alias native ETH (0x0) ↔ WETH in the graph
  NODE space (1:1 via wrap/unwrap), carry `nativeCurrency0/1` on the edge, keep the REAL
  PoolKey (0x0) for quote/exec. Detector emits WETH-aliased impact tokens. **Gate =
  deterministic planner flip** (`test/planner.ts`): a pinned native ETH/USDC v4 pool + a
  v3 WETH/USDC return leg → `candidate_plans > 0` (was 0: dead-end). No anvil. Inert in
  prod until a native pool is pinned (only after 2b).
- **Slice 2b (next): execution legs + fork test.** plan-builder native path — input leg
  `WETH.withdraw(amountIn)` → v4 `settle{value: amountIn}` (encodeCallValue 0x01); output
  leg `take(0x0)` → `WETH.deposit{value: amountOut}`. **Gate = anvil fork**: real
  ETH/USDC fee-100 v4 swap builds + executes + output matches. Broadcast stays human-gated.

- `searcher_behavior_change: yes` (2a makes native-ETH v4 victims routable — a real funnel
  change, proven by the planner flip).
- Allowed files 2a: `detector/pool-impact.ts`, `planner/token-graph.ts`,
  `test/planner.ts`. Brief pinned in the orchestrator scratchpad.

## Codex Implementation Pass (2a)
- status: _dispatched_
- authored_by: codex gpt-5.5 xhigh
- gate: `npm run build` + `npm run searcher:planner` (native-v4 flip case + all pre-existing)
