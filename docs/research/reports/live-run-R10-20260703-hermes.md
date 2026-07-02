# R10 — fix v4 pool discovery Initialize-window gap (2026-07-03)

> Scope: authorized defensive on-chain arbitrage research; local-reth reads; broadcast is a
> separate human-gated step, not performed here. Orchestrator = the hourly Hermes cron
> (self-driven, rule 14).

```yaml
run_id: R10-20260703
date: 2026-07-03
window: block 25447724-25447874 (150 blocks, ~29min), HEAD=3c0e315 (pre-fix, post-R9)
config: SEARCHER_DRY_RUN=1, SEARCHER_EV_GATE=1, SEARCHER_BRIBE_BPS=5000, universe=1500
cu_budget: <=1000 Alchemy CU
cu_spent: 0 (window pull + competitor cross-ref + all on-chain verification ran against local reth via SSM)
codex: landed (3 passes: read-only blocker analysis (conclusion B) + workspace-write pass 1 + workspace-write pass 2 fix-loop, all via scripts/codex-run.sh)
turn_class: extraction (searcher_behavior_change: yes)
```

```step1
run_id: R10-20260703
window_blocks: 25447724..25447874
watchlist: 0xc0ffeebabe5d496b2dde509f9fa189c25cf29671,0xae2fc483527b8ef99eb5d9b44875f005ba1fae13
artifact: docs/research/reports/step1-R10-20260703.json
method: manual-onchain-trace
```

## R9 carry: this round MUST ship a real searcher_behavior_change
R9 closed as an observability/validation-only turn (turn_class), the one allowed consecutive
turn per rule 13's anti-drift cap. R10 (this round) is therefore required to identify and fix
something that changes searcher behavior, not just relabel or document. Deployed latest main
(`3c0e315`) via `scripts/deploy-node.sh` — confirmed `universe=1500`, `dry_run_env=1`,
`SEARCHER_EV_GATE=1`, `SEARCHER_BRIBE_BPS=5000`, `SEARCHER_EVENTS_PATH` set — and ran a fresh
~29min window.

## Run Facts
92 new events in the window: 47 `opportunity_seen`, 45 `pipeline_dropped`, **0**
`simulation_result` (thinner than R8/R9). `pipeline_dropped`: `no_candidate_plans`=35,
`quote-timeout`=4, `no-profitable-quote`=3, `expired-before-solver`=3.

Of the 35 `no_candidate_plans`: 33/35 classify `only_immediate_same_pool_reverse`
(correctly-pruned), 2/35 classify `impact_pool_not_in_routing_graph` — both NEW pools, not the
R6/R8/R9 recurring CAGA case.

## Own-funnel hand trace: the 2 impact_pool_not_in_routing_graph samples
- **WXMR** (pool `0x14c10b4bdccd9d3f8940fb79e0ee00121391d6de`, 60.59 WETH TVL, block 25447773):
  on-chain trace found a genuine second venue — a UniV3 10000-fee pool
  (`0xAEE71CdE204Ff575e51E6Bf7ef15E454136099fD`, 0.436 WETH balance, `liquidity()` nonzero) —
  real but ~$1,500 TVL, dust-capping any arb through it. A UniV3 3000-fee pool also exists but is
  dead (`liquidity()=0`). This is a genuine one-off pool gap; per rule 13 (already-epic'd v4/v3
  coverage frontier, per-pool pins forbidden) it is NOT chased this round — deprioritized, both by
  our own dual-blind blocker discovery (see below) and independently.
- **MAAT** (pool `0xa8e56206a0ad40997b23bd678b5d68a7d6f7aa4c`, block 25447780):
  `impact_token_return_venues: 0` reconfirmed correct — MAAT's only other listed venue
  (`0x3957cEC3e5dA4d473Ee1f66e28168B761663fCc8`) is drained (0 actual WETH balance despite a
  stale nonzero `reserve1`). Reconfirms the known classifier blind spot (R6/R8/R9), not new.

## Mandatory competitor cross-reference (local reth, zero Alchemy CU)
- **coffeebabe — 0 txs, verified by nonce delta** (187511 at both block 25447724 and 25447874).
  A real "not seen" this window.
- **0xae2Fc483... — 24 txs, fully swept** (nonce delta 6430563→6430587=24, exactly matching the
  watch tool's 24 matches). All 24 aggregated; hand-traced to full depth:
  - **4 events (2 pairs)**: `LP-positioned(partial→arb)` through pool
    `0xe0554a476a092703abdb3ef35c80e0d76d32939f` and others, paired large-swing realized-profit
    entries (JIT-mint-then-arb-then-burn). Same shape as R6/R8/R9 — reconfirmed, not new, already
    epic-classified "unsupported strategy shape," no action.
  - **Block 25447737**: the window's largest non-JIT-LP capture — a single 14-pool, 10-token
    multi-hop sweep tx, `realized_profit_usd=10.01`. 4 of the 14 legs are Uniswap v4 pools
    (poolIds `0x2053fa3e...`/`0xb2b92b56...`/`0x77ef4ec6...`/`0x9b3c4e92...`, all EURC/USDC or
    WETH/UNI), all `pool_in_routing_graph: null`. **This became the dual-blind blocker
    discovery's evidence base.**
  - Remaining ~19 events: dust ($0.03–$0.36), mix of pools we do/don't have, gap_type mostly
    `unknown`/`unknown_replayable`.

## Blocker discovery — dual-blind (Rounds Step 4)
- **Conclusion A (fresh fable-5 sub-agent, chain + code access, raw data only, no hint of any
  hypothesis):** on-chain verification (via v4 PositionManager `poolKeys()` resolution) of 5
  poolIds — including block 25447737's 3 EURC/USDC legs and the **R6-carried gap pool
  `0xce2899b1...`** — found ALL 5 have heavy in-window swap activity (7–484 swaps, well above
  `minSwaps`) but **zero in-window `Initialize` events**. Root cause:
  `build-active-pool-universe.ts:264-269` (`buildV4PoolEntries`) iterates `initLogs` only — any
  poolId whose `Initialize` predates the scan window is silently, permanently invisible
  regardless of swap activity. Classified **systemic class fix** (closes the R6→R8 carried
  finding mechanically, not a one-off pin); explicitly deprioritized the WXMR sibling-pool
  candidate as a genuine one-off not worth fixing (rule 13).
- **Conclusion B (Codex, read-only pass via `scripts/codex-run.sh`, identical raw data as DATA
  only, no chain access):** independently proposed a v3 factory-sibling-completion fix (the WXMR
  candidate) as its primary recommendation, but **explicitly declined** to select the v4
  Initialize-window candidate, stating the supplied data didn't disambiguate "below-minSwaps vs
  old-Initialize" without chain access to verify.
- **Compare:** not a true disagreement — B self-flagged its own uncertainty on exactly the
  question A (with chain access) resolved with hard evidence. A's finding is higher-leverage
  (closes an existing carried finding + explains 3/4 of this window's largest competitor capture)
  and better-evidenced. **Finalized on A's blocker.**

## Claude Final Decision / Implementation Brief
Fix `buildV4PoolEntries` to resolve a missing in-window `Initialize` via a bounded backward walk
instead of silently dropping the pool. Independently verified (before writing the brief) that
fable's proposed PositionManager-address approach was unreliable — the sub-agent itself
transcribed the contract address wrong twice from memory (41/42 hex chars both times) — so
**refined the fix** to reuse a lower-risk, already-proven pattern already in this exact repo:
`analysis/src/registry/v4-poolkeys.ts`'s targeted single-poolId `eth_getLogs` query against the
same PoolManager address already in use, no new external contract dependency.

## Codex Implementation Pass
- **status:** landed, 2 passes (both `scripts/codex-run.sh workspace-write`, no stalls).
- **Pass 1** (`listener/src/searcher/build-active-pool-universe.ts`,
  `listener/src/searcher/test/build-active-pool-universe-v4.ts`): made `buildV4PoolEntries`
  async, added an optional `resolveMissingInit` resolver parameter, restructured to iterate the
  swap-activity map (not just `initLogs`) so any qualifying poolId without an in-window init can
  be backfilled. Wired `main()`'s resolver as a single `eth_getLogs` call.
  Extended the test with an `oldPool` fixture: `baseline_failure` (excluded, no resolver) →
  `expected_transition` (included via stub resolver, `source: "v4-initialize-backfill"`).
  Verified independently: `npm run build` clean, `npm run searcher:pooluniversev4` 4/4 PASS,
  `npm run searcher:planner` 12/12+6/6 unaffected. **Committed `6761995`, pushed.**
- **Pass 2 (fix loop, triggered by Claude's own live verification, not Codex's claim):**
  deploying pass 1 and testing it live against the real node RPC found pass 1's single-shot
  `fromBlock:"0x0"` call **always fails** on this node — local reth enforces a hard 100,000-block
  `eth_getLogs` range cap regardless of topic specificity (the `analysis/` tool's "Alchemy's
  10k-block cap does not bite" assumption does not hold here). A second, distinct
  `"pruned history unavailable"` error also surfaces for genuinely old pools beyond retained
  history. Dispatched a narrow fix: `resolveV4InitBackward` walks backward from the scan's own
  `fromBlock` in 100k-block chunks (env-configurable total lookback,
  `POOL_UNIVERSE_V4_BACKFILL_LOOKBACK_BLOCKS`, default 2,000,000), returns on first match, treats
  a pruned/not-available error as a clean stop (not infinite retry), retries once + warns past a
  single transient chunk failure. Verified independently: build clean, same 4/4 + 12/12+6/6
  unaffected. **Committed `82dce7e`, pushed.**

## Gate + Final Approval
- **kind:** deterministic (pool-discovery/graph coverage) → replay flip, zero-RPC.
- **failing_sample:** `buildV4PoolEntries` given a poolId with in-window swap activity but no
  in-window `Initialize` log (real-world instance: R6-carried gap `0xce2899b1...` and 3/4 of this
  window's block-25447737 legs — all confirmed live via on-chain `poolKeys()` verification during
  blocker discovery).
- **baseline_failure:** `test/build-active-pool-universe-v4.ts` — `oldPool` fixture (swap activity
  present, init log withheld from `initLogs`, no resolver): entry excluded (`0/entries`, matches
  live-observed `pool_in_routing_graph: null` classification).
- **replay_command:** `npm run searcher:pooluniversev4`.
- **replay_result:** WITHOUT resolver → `oldPool` excluded (baseline reproduced). WITH stub
  resolver → `oldPool` included, all fields correct, `source: "v4-initialize-backfill"`
  (`expected_transition` confirmed). 4/4 PASS. Planner regression 12/12+6/6 unaffected.
- **Live safety verification (beyond the unit gate):** ran `resolveV4InitBackward` directly
  against the real node RPC for a known-missing poolId (`0xb2b92b56...`). Confirmed clean,
  bounded termination — walked the full 2M-block default lookback (~181s wall-clock; each 100k
  chunk takes 10-19s on this node's unindexed log scan) and returned `null` without hanging or
  crashing. This poolId's `Initialize` predates the 2M-block default lookback (this node's
  per-query scan speed is the binding constraint on how deep a one-time backfill can practically
  reach, not a defect in the fix). Fixed a real bug found this way during live verification (the
  block-range-cap issue, pass 2) before finalizing.
- **expected_transition:** `buildV4PoolEntries` entry presence for a swap-active,
  init-missing-in-window poolId: `excluded → included` (confirmed, unit level).
- **verdict:** **fixed** (mechanism-level, rule-12 compliant — deterministic replay flip
  confirmed both directions; live safety independently verified against the real RPC).

## Live production backfill — launched, in progress at round close
Deployed `82dce7e` to the node (`scripts/deploy-node.sh`, confirmed `dry_run_env=1`,
universe=1500 intact). Launched a scoped one-off backfill script (matching R7's additive-merge
pattern: import `buildV4PoolEntries` + `resolveV4InitBackward` from the built dist, scan a fresh
150k-block window, merge additively into `active-pools.json`, preserving all existing entries)
as a detached background process on the node (zero Alchemy CU, local reth only).

Progress at round close (~35min after launch): `initLogs=3187`, `swapLogs=739520` scanned
(150k-block window), still in the resolver phase (per-poolId backward walk for any pool with
swap activity but no in-window init — this is the confirmed-slow step, ~10-19s per 100k-block
chunk on this node). **Not yet complete — carried to next round.** The code fix itself is
deployed and live regardless of this one-off backfill's completion: any pool discovered fresh in
a normal-scope future backfill run will benefit from the corrected discovery logic automatically.

## Findings Ledger
| finding | owner | carry_to | status |
|---|---|---|---|
| v4 pool discovery Initialize-window gap (`buildV4PoolEntries` only emits in-window-initialized pools) | R10 | — | **done** — `fixed`, gated via unit-level replay flip (baseline_failure → expected_transition), commits `6761995` + `82dce7e` (pass 2 fix), deployed live |
| R6-carried gap `0xce2899b1...` still uncovered after R7's backfill | R6→R7→R10 | R11 | **root cause found and fixed this round** (confirmed via on-chain verification: 484 in-window swaps, 0 in-window Initialize) — awaiting the live production backfill's completion to confirm the real poolId flips `pool_in_routing_graph: null→true` |
| live production backfill (150k-block window, this round's launch) | R10 | R11 | **in progress, not complete at round close** — check `/tmp/v4-backfill-r10.log` on the node, merge+redeploy if finished, or let it keep running / relaunch with a narrower window if still stuck |
| WXMR pool gap (`0x14c10b4b...`, real but ~$1,500-TVL second venue) | future | monitor | reconfirmed one-off, deprioritized by both dual-blind conclusions independently (dust-capped, not worth a pin per rule 13) |
| MAAT classifier-blind-spot sample (drained secondary venue) | future | non-blocking | reconfirms R6/R8/R9's known finding, not new |
| JIT-LP strategy-shape gap (0xae2Fc483, pool `0xe0554a476...`) | future | monitor | reconfirmed, not new, already epic-classified |
| local reth's ~10-19s/100k-block `eth_getLogs` scan speed (no bloom-filter-friendly indexing observed) | future | if backfill perf matters | new observation from this round's live verification — worth knowing if future backfills need to go deeper/faster; not a blocker to this round's fix |
| classifier blind spot (`impact_pool_not_in_routing_graph` conflates no-venue vs missing-edge) | future | when slack exists | still open, non-blocking, now 6/7 hand-traced samples false-positive-for-"no venue exists" across R6/R8/R9/R10 |

## searcher_behavior_change: yes
The v4 pool-discovery/backfill mechanism no longer silently and permanently drops a pool just
because its `Initialize` event predates whatever scan window happened to run. This is a direct,
measured step toward Mission #2 (closing a pool-coverage gap that competitors were actively
capturing — 4 v4 legs in this window's largest non-JIT-LP capture) and mechanically closes the
R6-carried finding. Fixed and deployed live this round; the one-time production backfill to
promote the specific real-world pools found this round is still running and carried to R11.

## Next action
Round complete: measured a fresh window, ran the mandatory competitor cross-reference (coffeebabe
0 txs verified; 0xae2Fc483 24 txs, dominant JIT-LP shape reconfirmed + one new $10.01 v4-legged
capture), ran dual-blind blocker discovery (fresh fable A + Codex B, reconciled — A's
chain-verified v4 Initialize-window finding selected over B's less-evidenced WXMR proposal),
implemented + gated the fix in 2 passes (pass 2 triggered by Claude's own live-RPC verification
catching a real block-range-cap bug before final approval), committed + pushed both, redeployed,
and launched the live production backfill (still running at round close, zero CU, carried to
R11). `hermes-gate` run below. Releasing the round lock. R11 should: (a) check/merge the
production backfill's results and confirm the real poolIds (`0xce2899b1...` and this window's
EURC/USDC v4 legs) flip `pool_in_routing_graph` from `null` to a real graph entry, (b) run a fresh
measurement window to see if this shifts `simSuccess`/competitor-capture rates, (c) continue
watching for another genuine non-dust `bundle_submitted` following R8/R9's trend.
