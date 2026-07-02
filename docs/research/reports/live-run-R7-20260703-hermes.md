# Hermes Impl Cycle `R7-20260703`

> Scope: authorized defensive on-chain arbitrage research; local-reth reads; broadcast is a
> separate human-gated step, not performed here. Orchestrator = the hourly Hermes cron
> (self-driven, rule 14). Lean impl-cycle template — implementation-only, no new dry-run window
> measured this fire (carries R6's already-gated Step-1 competitor cross-reference; see below).

```yaml
cycle_id: R7-20260703
date: 2026-07-03
orchestrator: Sonnet 5 (3-step: plan -> Codex writes -> review; not Opus, no extra plan-review round)
cu_budget: <=1000 Alchemy CU (this cycle spent 0 — implementation is pure/offline, no RPC scan run)
cu_spent: 0
codex: landed
```

## Judgment call: resuming the concurrent-session file-safeguard
R6 downgraded but did not clear the concurrent-session collision risk (PID 77146/77145, a
resumed `claude-opus-4-8 --effort xhigh` session building an unrelated `SEARCHER_PAIR_FLOOR`
slice, alive since 2026-07-02 10:46) and avoided `main.ts`/`pool-universe.ts`/
`test/pool-universe.ts` as a precaution. This fire, before touching any of those files: re-checked
liveness (still alive, now 16h25m, 0.0-0.7% CPU across every sample this fire and R6's) AND ran
`lsof -p 77146` — **zero open file handles on any source file** (only the repo root as cwd). That
is new, stronger evidence than R6 had (idle CPU + clean tree only): the process is not merely
idle, it is not touching disk at all right now. Combined with 6+ consecutive clean-tree checks
across ~2h and R6's own carry note ("next round... should first re-check liveness before touching
`pool-universe.ts`" — implying the intent was to proceed once evidence supported it, not stall
forever), continuing to defer the already-epic'd v4-discovery slice would itself become the rule-13
null-round anti-pattern (a finding "parked as longtail/separate round after round"). **Decision
(rule 14, self-served): proceed**, scoping Codex's brief to explicitly forbid
`pool-universe.ts`/`main.ts`/`test/pool-universe.ts` regardless (the new v4-discovery code needed
none of them — `pool-universe.ts` and `planner/token-graph.ts` already fully support `univ4`
entries), so the file-level safeguard holds even though the liveness gate was relaxed.

## Decision + Implementation Brief
- **goal / root cause:** R6 reconfirmed (31/32 competitor matches that window were v4-routed,
  `pool_in_routing_graph: null`) that our pool-discovery pipeline never enumerates Uniswap v4
  pools — `build-active-pool-universe.ts` only scans per-pool `Swap`/`TokenExchange` topics
  against each pool's own contract address, which doesn't exist for v4 (all v4 pools live inside
  one singleton `PoolManager`, distinguished only by `poolId`). `pool-universe.ts` and
  `planner/token-graph.ts` already fully support `adapter: "univ4"` entries (poolId, currency0/1,
  fee, tickSpacing, hooks, inline-PoolKey zero-RPC resolution) — discovery was the only missing
  piece. Per rule 13's mechanical escalation, this is the epic slice, not another per-pool pin.
- **searcher_behavior_change:** yes — new discovery capability (offline batch tool), gated;
  production searcher behavior changes once the batch is run against real chain data and
  redeployed (carried, see Next Action — this fire ships and gates the code, zero CU spent).
- **allowed files:** `listener/src/searcher/build-active-pool-universe.ts`,
  `listener/src/searcher/test/build-active-pool-universe-v4.ts` (new), `package.json` (one script
  line). **forbidden:** `pool-universe.ts`, `main.ts`, `test/pool-universe.ts`,
  `planner/token-graph.ts`, everything else.
- **changes:** add a v4 `Initialize` event scan (topic
  `Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)`) and a v4 `Swap` event
  scan (topic `Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)`) against
  `ADDR.UNISWAP_V4_POOL_MANAGER` over the existing `[fromBlock, latest]` window; decode
  poolId/currency0/currency1/fee/tickSpacing/hooks from `Initialize`, score by `Swap` count per
  poolId (same `minSwaps` cutoff as v3/v2/curve); export a pure `buildV4PoolEntries(initLogs,
  swapLogs, minSwaps)` function; append inline-PoolKey `univ4` entries to the output file
  (deduped by `poolId`, not address, since all v4 entries share the PoolManager address).
- **gate command(s):** `npm run build`, `npm run searcher:pooluniversev4` (new), `npm run
  searcher:pooluniverse` (regression), `npm run searcher:planner` (broader regression).

## Codex Implementation Pass
- **status:** landed
- **authored_by:** codex (`gpt-5.5 xhigh`, via `scripts/codex-run.sh workspace-write`, rule 11
  protocol; ~13.5 min wall time, no stalls, single pass)
- **changed_files:** `listener/src/searcher/build-active-pool-universe.ts` (+137/-7),
  `listener/src/searcher/test/build-active-pool-universe-v4.ts` (new, 215 lines),
  `listener/package.json` (+1 script line)
- **verification:** Codex's own sandboxed run hit a `tsx`/IPC pipe-bind `EPERM` under its
  workspace-write sandbox on `npm run` (a sandbox artifact, not a code bug — confirmed by Codex
  itself via `node --import tsx ...` passing 0/0 in the same sandbox). Claude (evaluator)
  independently re-ran all three gate commands outside Codex's sandbox:
  - `npm run build` → exit 0, clean.
  - `npm run searcher:pooluniversev4` → `buildV4PoolEntries fixtures: PASS`, `loadPoolUniverse
    round-trip: PASS`, `buildTokenGraph inline PoolKey path: PASS` → `pool-universe-v4 PASS (3/3)`.
  - `npm run searcher:pooluniverse` (regression) → `PASS (7/7)`, no change in existing behavior.
  - `npm run searcher:planner` (broader regression) → `PASS (12/12) + replay fixtures (12/12)`,
    unaffected.
- **diff_scope_check:** `git diff --stat` touches exactly the 3 allowed files/paths; explicitly
  confirmed zero diff against all 4 forbidden files (`git diff --stat -- <forbidden list>` →
  empty). One incidental change beyond the literal brief: the script's `require.main`-equivalent
  guard (`process.argv[1]?.includes("build-active-pool-universe")`) was tightened to an exact
  resolved-path comparison — necessary because the new test file's path
  (`test/build-active-pool-universe-v4.ts`) itself contains the substring
  `"build-active-pool-universe"` and would have wrongly triggered `main()` (a live RPC scan) on
  every test run under the old substring check. Correct catch, still inside the one allowed file.

## Gate + Final Approval
- **kind:** deterministic (coverage/discovery mechanism) → REPLAY flip, pure/zero-RPC (no anvil,
  no live chain data needed for this gate — see CU note below).
- **failing_sample:** before this change, no code path exists to turn a v4 `Initialize` log into
  a `PoolUniverseEntry` at all — `buildV4PoolEntries` did not exist.
- **baseline_failure:** n/a (new capability, not a regression fix) — the "failing" state is
  "v4 pools structurally undiscoverable by this tool."
- **replay_command:** `npm run searcher:pooluniversev4` (fixture: 3 synthetic v4 pools via
  `ethers.Interface.encodeEventLog`, one below `minSwaps`, two above; round-tripped through
  `loadPoolUniverse` then `buildTokenGraph`).
- **replay_result:** `buildV4PoolEntries` returns exactly the 2 above-cutoff entries with every
  PoolKey field (poolId/currency0/currency1/fee/tickSpacing/hooks) matching the fixture input;
  after a `loadPoolUniverse` round-trip, `buildTokenGraph` resolves the entry into **2 directed
  `univ4-unlock` edges with `backendCalls === 0`** — i.e. the inline-PoolKey zero-RPC path Mission
  #1 needs for a cheap live hot path.
- **expected_transition:** `v4_pool_discoverable false->true` AND `pool_in_routing_graph
  null->true` (via `buildTokenGraph`, zero backend calls) — both confirmed.
- **verdict:** **fixed** (the discovery *mechanism*; see Next Action for the separate,
  CU-budgeted step of running it against real historical chain data).
- **fix_commit:** `2f4141a`
- **hermes_gate:** not run this cycle — no new dry-run window was measured this fire (pure
  implementation cycle on top of R6's already-`hermes_gate: PASS`'d Step-1 cross-reference from
  the same window this fix targets). Will apply to the next window that runs with regenerated
  `active-pools.json`.

## Findings Ledger
| finding | owner | carry_to | status |
|---|---|---|---|
| v4 pool discovery/indexing mechanism (Initialize-event scan + inline PoolKey admission) | R6->R7 | — | **done** — code landed, gated via zero-RPC replay flip (`fixed`, commit `2f4141a`) |
| production backfill: run the new discovery scan against real historical v4 Initialize/Swap logs to populate `active-pools.json`, then redeploy | R7 | R8 | **open** — needs an explicit CU-budget decision (a 30-day Alchemy `eth_getLogs` scan over the full PoolManager history is likely well beyond the ~1000 CU/fire cap meant for secondary verification, not batch backfills); alternative is a zero-CU local-reth run, but the local reth node only lives on the EC2 instance (not reachable from this Mac) and running the batch there needs an SSM-executed job — not attempted this fire to avoid rushing an unverified batch/RPC call against shared node infra. R8 should size the window explicitly (e.g. bounded lookback matching the reth node's retained ~10k blocks, run via SSM on-node, zero CU) before running it. |
| concurrent-session collision (PID 77146/77145) | human | monitor | downgraded further — 0 open file handles this fire (stronger than R6's idle-CPU/clean-tree evidence); no collision materialized touching the 3 allowed files |
| classifier blind spot (`impact_pool_not_in_routing_graph` conflates no-venue vs missing-graph-edge) | future | R8+ | open, non-blocking (carried from R4/R6) |
| build-time discovery-queue chicken-egg (`not_closable_in_current_graph`) | future | R8+ | open, non-blocking (carried from R4/R6) |

## Next action
Round complete: v4 discovery mechanism implemented, evaluated, gated (`fixed`), and committed
(`2f4141a`) — zero Alchemy CU spent (pure/offline test only). Not pushed/deployed to the node this
fire since the code alone changes no live behavior until `active-pools.json` is regenerated with
real v4 pool data (carried to R8 as a CU-budgeted or local-reth-via-SSM decision — see Findings
Ledger). Releasing the round lock. Next Hermes work resumes at the next `hermes-hourly` cron fire
(confirmed enabled, `cronExpression: 0 * * * *`, `nextRunAt` after this fire) — external scheduler
is the continuation trigger for this round's stop, per rule 15(a).
