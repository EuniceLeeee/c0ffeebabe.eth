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

## Codex Implementation Pass (2a) — LANDED `d69a316`
- status: **fixed** (deterministic flip gated).
- authored_by: codex gpt-5.5 xhigh; Claude (evaluator) strengthened the gate.
- changed_files (3, in-scope): `token-graph.ts` (`nativeCurrency0/1` on TokenEdge;
  univ4 edge aliases 0x0→WETH graph tokens, keeps real PoolKey + validateV4Pair on the
  real 0x0) · `pool-impact.ts` (uniV4Decoder aliases native ETH→WETH on emitted impact
  tokens; edge-match stays consistent since graph tokens are also WETH) · `test/planner.ts`.
- **non-author review finding (Claude, fixed in this commit):** Codex's test hand-built
  already-aliased edges → it would NOT fail if the alias were reverted (weak gate). Added a
  **true flip**: a RAW native v4 Swap log → `detectImpactFromLogs` → assert impact
  `WETH→USDC` + poolId preserved. Reverting the decoder alias now fails the test.
- verification: `npm run build` tsc clean; planner **12/12 + fixtures 2/2** (native-v4
  decode-alias flip + routing + all pre-existing). Ran via `node --import tsx` (sandbox
  blocks the `tsx` CLI IPC pipe; same source).
- `expected_transition`: native-ETH v4 Swap → (before) impact 0x0 dead-end / 0 plans →
  (after) impact WETH→USDC, planner routes, `candidate_plans>0`. **verdict: fixed.**
- token-graph builder aliasing (4 lines) reviewed-correct; not separately unit-tested
  (needs a backend) — the full native path is exercised by 2b's fork test.

## Slice 2b — execution (split into 2b-i building blocks + 2b-ii wiring/fork)

### 2b-i — LANDED `a5c82d5` (adapters + deterministic gate)
- Three BotVM adapters (no contract change; existing 0x01/0x00 encoders):
  `weth-deposit-value` (wrap exact ETH→WETH), `weth-withdraw-amount` (unwrap exact
  WETH→ETH; distinct from the 0x04 unwrap-all), `univ4-settle-value` (PoolManager
  `settle{value}`). Registered in `index.ts`.
- Gate: `test/v4-native-adapters.ts` decodes the raw `[op][addr:20][value:12][len:3]
  [payload]` layout and asserts op/target/value/selector for all three — **3/3**. tsc
  clean; planner 12/12 + v4-impact regression green. **verdict: fixed** (encode-level).
- authored_by: codex gpt-5.5 xhigh; Claude reviewed + gated.
- minor (non-blocking): `weth-withdraw-amount` shares matchTrace selector `0x2e1a7d4d`
  with `weth-withdraw` — reverse trace-decode only, irrelevant to forward encoding.

### 2b-ii — LANDED `c817cc2` (wiring + quoter direction + fork gate PASS)
- **5-step Opus loop** (this session runs as Opus 4.8): Claude plan → **Codex read-only
  plan-review** (caught 4 real issues before code: native settle needs `sync(0x0)`;
  `realCurrency` must be restricted + pair-validated; reject native/WETH collapse; simpler
  pre-funded fork test) → Claude final plan → Codex impl → Claude review.
- quoter.ts + plan-builder.ts resolve the aliased WETH graph token → real PoolKey currency
  (`realV4Currency` direct-match, else alias WETH→0x0 only when exactly one side native,
  pair-validated; native/WETH pool rejected). Native legs: input =
  `weth-withdraw-amount → univ4-sync(0x0) → univ4-settle-value{value}`; output =
  `univ4-take(0x0) → weth-deposit-value{value}`.
- **FORK GATE PASS (local reth, ZERO Alchemy CU)** — `replay-v4-native-arb.ts` on node
  worktree, fork upstream `127.0.0.1:8545` @ block 25442000, anvil:
  - native input WETH→USDC: on-fork `delta=16195859 == expected` (V4Quoter) ✓
  - native output USDC→WETH: on-fork `delta=15431792511170999 == expected` ✓
  - Both directions execute with EXACT quoted output. **verdict: fixed.**
- Deterministic regressions green: planner 12/12 + fixtures 4/4; v4-adapters 3/3;
  v4-impact / v4-execution-poolkey PASS; tsc clean.
- Infra note: node had no `out/BotVM.sol/BotVM.json` → ran `forge build` once on the node to
  produce it; fork test run from an isolated `/tmp/mev-2bii` worktree (node_modules + out
  symlinked) so the live dry-run searcher was never disturbed.

### 2c — REMAINING to actually catch it live (coverage)
- native-ETH v4 detect→route→quote→execute is now COMPLETE + validated, but **inert in prod
  until a native pool is pinned**. Next: add ETH/USDC (fee-100, poolId `0x00b9edc1…`, verified
  routable+executable above) and top ETH/USDT v4 pools to `pinned-warm-pools.json`. Config-only;
  then a dry-run window should show native-ETH v4 `opportunity_seen` + reaching the solver.
  Broadcast stays human-gated.

### (superseded) 2b-ii original plan — wiring + fork test
- **quoter.ts direction fix (2a fallout):** after 2a aliasing, `v4ZeroForOne` /
  `encodeUniV4QuoteExactInputSingle` are called with the aliased WETH token but the real
  PoolKey has `currency==0x0` → throws "tokens do not match PoolKey". Map aliased WETH→0x0
  when the key has a native currency (derivable from the PoolKey's 0x0 side; no extra flag).
- **plan-builder.ts `univ4-unlock` native path:** same direction mapping for `zeroForOne`;
  input-native leg = `weth-withdraw-amount(amtIn)` → `univ4-settle-value{value:amtIn}`
  (replaces sync+erc20-transfer+settle); output-native leg = `univ4-take(0x0)` →
  `weth-deposit-value{value:amtOut}`. Consume `edge.nativeCurrency0/1`.
- Gate = **anvil fork**: real ETH/USDC v4 swap builds + executes on-fork + output matches
  (mirror `test/replay-v4-arb.ts`). Only after this: pin a native pool (2a+2b inert in prod
  until pinned). Broadcast stays human-gated.
