# R8 — EV-gate FRAX valuation fix (2026-07-03)

> Scope: authorized defensive on-chain arbitrage research; local-reth reads; broadcast is a
> separate human-gated step, not performed here. Orchestrator = the hourly Hermes cron
> (self-driven, rule 14).

```yaml
run_id: R8-20260703
date: 2026-07-03
window: block 25447128-25447275 (147 blocks, ~30min), HEAD=895ca0f (post-R7 v4 backfill)
config: SEARCHER_DRY_RUN=1, SEARCHER_EV_GATE=1, SEARCHER_BRIBE_BPS=5000, universe=1500
cu_budget: <=1000 Alchemy CU
cu_spent: 0 (window pull + competitor cross-ref + all cast calls ran against local reth via SSM)
codex: landed (2 passes: read-only blocker analysis + workspace-write fix, both via scripts/codex-run.sh)
turn_class: extraction (searcher_behavior_change: yes)
```

```step1
run_id: R8-20260703
window_blocks: 25447128..25447275
watchlist: 0xc0ffeebabe5d496b2dde509f9fa189c25cf29671,0xae2fc483527b8ef99eb5d9b44875f005ba1fae13
artifact: docs/research/reports/step1-R8-20260703.json
method: manual-onchain-trace
```

## R7 carry executed
Deployed latest main (`895ca0f`, includes R7's v4 discovery + backfill) via `scripts/deploy-node.sh`
— confirmed `universe=1500`, `dry_run_env=1`. Ran a fresh ~30min dry-run window (offset line 3233
in `/var/log/mev/events/searcher-live.jsonl`, start epoch 1783023013 UTC) to measure whether R7's
backfill (655/1500 graph slots now v4) changes the funnel, per R7's own next-action.

## Run Facts
103 new events this window: 48 `opportunity_seen`, 51 `pipeline_dropped`, 3 `simulation_result`
(all `ok:true`), 1 `mempool_filter_config`.

`pipeline_dropped` breakdown: `no_candidate_plans`=28, `quote-timeout`=9, `no-profitable-quote`=5,
`candidate-cap`=5, `below_ev_gate`=3, `expired-before-solver`=1.

## Auto Analysis — the 3 simulation_result events
1. Block 25447170, path routes through `univ4-unlock>univ4-swap>univ4-take>univ4-sync>univ4-settle`
   (confirms R7's v4 discovery is live in the planner, not just the graph — a real v4-routed
   candidate reached simulation). Profit token WETH, `simulated_profit`=1699004572 wei (~$0.000004
   at ethUsd=3500) — genuine dust, correctly rejected `below_ev_gate`.
2. Block 25447211, path `curve-exchange-plain>univ2-swap>univ2-swap`, profit token
   `0x853d955aCEf822Db058eb8505911ED77F175b99e` (**FRAX**, confirmed 18 decimals via on-chain
   `symbol()`/`decimals()` on local reth), `simulated_profit`=7604438903976703577 raw units
   (~7.6 FRAX). Rejected `below_ev_gate` with `profitEth=0` — **wrongly**, see below.
3. Block 25447241, path 3-hop `univ3-swap` WETH-DAI-USDC loop, profit token WETH,
   `simulated_profit`=1282405625 wei — genuine dust, correctly rejected.

No `impact_pool_not_in_routing_graph` samples reached simulation this window (the 2/13 that hit
that classifier in R6's window were absent here — insufficient window count to claim the v4
backfill measurably shifted this specific bucket; carried as an open question, see Findings).

## Mandatory competitor cross-reference (local reth, zero Alchemy CU)
`analysis live-loss --watch coffeebabe,0xae2Fc483... --rpc http://127.0.0.1:8545 --from-block
25447128 --to-block 25447275` (147 blocks), run directly on the node (analysis/ toolchain already
deployed there) against the same window's events file.

- **coffeebabe — 0 txs, verified by nonce delta** (nonce 187506 at both block 25447128 and
  25447275; the watch tool independently found 0 matches too). `swept:false, method:nonce_delta,
  txCount:0` — a real "not swept" this window, not an unverified silence.
- **0xae2Fc483... — 41 txs, fully swept** (nonce delta 6430422→6430463 = 41, exactly matching the
  watch tool's 41 matches — every tx this bot sent in-window touched a tracked token/pool).
  Sampled 8/41 in full: dominant pattern `canonicalSequence: ["position.lp.mint"/"position.lp.burn",
  "trade.swap"]`, `pathTemplate: "LP-positioned(partial→arb)"` — JIT-liquidity-plus-arb, the same
  shape reconfirmed from R6 (not a new gap; already an "unsupported strategy shape" per rule-6
  classification). 5/8 sampled are `seenScope: same_pool`/`same_token` + `primaryReason:
  seen_but_lost` (pools we do see, didn't win/route). One sample (block 25447272) is Uniswap v4
  (`poolId 0x19d044e9...`, `pool_in_routing_graph: null`). One sample (block 25447233) trades
  through the **same FRAX token** as our own rejected opportunity #2, via a pool
  (`0xdcef968d...`) we don't have in our seen events at all — a secondary, smaller pool-coverage
  note, not chased further this round (see Findings).

**Classification: reconfirms the JIT-LP strategy-shape gap (not new); does NOT explain this
window's own funnel-internal blocker** — that came from our own `simulation_result` data, below.

## Blocker discovery — dual-blind (Rounds Step 4)
- **Conclusion A (fresh fable-5 sub-agent, full chain+code access, given only raw window data +
  competitor summary, no hint of any hypothesis):** nearest blocker = `valueInEth` in
  `listener/src/searcher/main.ts:153-168` returning `0n` for any profit token outside
  `{WETH, USDC, USDT, DAI}`. This window it zeroed opp #2's real FRAX profit, producing a false
  `below_ev_gate` rejection. Classified **unanticipated (valuation) gap** — pool indexed, path
  routed, sim succeeded, economics real, lost at token valuation. Computed corrected net ≈
  +$2.5 at ethUsd=3500 assumptions.
- **Conclusion B (Codex, read-only pass via `scripts/codex-run.sh`, given the identical raw data
  package as DATA only — no fable conclusion, no Claude-picked facts):** independently identical
  root cause and file:line (`main.ts:153-157` map, `:159`/`:167` zero-return, consumed at `:1634`,
  dropped at `:1659`). Computed net ≈ +698017637280804 wei using the exact live gas/haircut/bribe
  figures from the rejection event.
- **Compare:** A and B converge exactly on root cause, location, and classification — high
  confidence. No disagreement to reconcile.

## Claude Final Decision / Implementation Brief
Fix `valueInEth`'s hardcoded stable-token allowlist gap by adding FRAX (the specific token proven
live this window to cause a false rejection) to `STABLE_DECIMALS`. Narrow, additive, one map entry
+ export the function for testability + one new pure unit test + one script line. Did **not**
add other stables (crvUSD/GHO/USDe/etc., suggested by conclusion A as a "while you're here" — out
of scope per this round's evidence; the general "hardcoded allowlist is fragile" pattern is a
carried finding, not fixed wholesale, to avoid unverified scope creep).

**Judgment call — touching `main.ts` despite the standing concurrent-session caution (PID
77146/77145, resumed opus session on an unrelated `SEARCHER_PAIR_FLOOR` slice):** re-checked
liveness immediately before dispatching Codex — still alive at 18h+, 0.4% CPU, zero open
file-handles on any source file (same test as R7), clean `git status`. The fix touches only
3 lines of `main.ts` (one map entry + `export` keyword) in an unrelated section
(`STABLE_DECIMALS`/`valueInEth`, far from pair-floor logic) — minimal collision surface even in
the unlikely case the other session wakes.

## Codex Implementation Pass
- **status:** landed. **authored_by:** codex (`gpt-5.5 xhigh`, `scripts/codex-run.sh
  workspace-write`, single pass, no stalls).
- **changed_files:** `listener/src/searcher/main.ts` (+2/-1: FRAX map entry + `export` on
  `valueInEth`), `listener/src/searcher/test/value-in-eth.ts` (new, 83 lines), `listener/package.json`
  (+1 script line).
- **verification (Claude, independent, outside Codex's sandbox):**
  - `npm run build` → exit 0, clean.
  - `npm run searcher:valueineth` → `PASS (3/3)`: WETH 1:1 passthrough, FRAX values as
    285714285714285 wei (≈ 1e18/3500, matches expected), unknown token still `0n` (regression
    guard for genuinely-unvaluable tokens).
  - `npm run searcher:planner` → `PASS (12/12) + replay fixtures (12/12)`, unaffected.
  - Manually ran the new test standalone (`node --import tsx .../value-in-eth.ts`) under a
    20s watch to confirm no hang/side-effect risk — the test imports `main.js` (which has no
    entry-guard and unconditionally calls `main()`), relying on an invalid `PRIVATE_KEY=0x00` to
    fail fast before any real network activity. Confirmed: exits cleanly in ~2s, zero stray
    processes (`anvil`/`revm-sim`), zero unexpected filesystem changes.
  - `git diff --stat` / `git status --short`: confirmed scope is exactly the 3 allowed files,
    zero diff against forbidden files (`pool-universe.ts`, `test/pool-universe.ts`).

## Gate + Final Approval
- **kind:** deterministic (economics/valuation input to the EV gate) → replay flip, pure/zero-RPC.
- **failing_sample:** opp `0x8d6936be3e5552003be267472f141905d7f38ef54712f58c6429636798dabb47`,
  block 25447211 (this window, live production data — not synthetic).
- **baseline_failure:** live-observed `pipeline_dropped` `below_ev_gate`, error string
  `"EV gate: net -171061094602248 < 0 (profitEth=0 gas=171061094602248 bribe=0
  token=0x853d955a)"`.
- **replay_command:** `npm run searcher:valueineth` (unit-level flip) + manual full EV-gate
  arithmetic replay using the exact live figures (below).
- **replay_result:** unit test shows `valueInEth(FRAX, 1e18, 3500)` now returns 285714285714285
  (was `0n`). Full-pipeline arithmetic replay on the actual rejected opportunity: `rawProfitEth`
  = 2172696829707629, `expectedProfitEth` (20% haircut) = 1738157463766103, `bidEth` (50% bribe) =
  869078731883051, `gasCostEth` = 171061094602248 (unchanged, gas-only, independent of profit
  valuation) → `netEth` = **+698017637280804 wei** (≈ +$1.2-2.4 depending on ETH/USD), vs the live
  `netEth = -171061094602248`. This exact figure was independently reproduced by conclusion B.
- **expected_transition:** `valueInEth(FRAX) 0→positive` (confirmed) AND `netEth
  negative→positive for the actual rejected opportunity` (confirmed via arithmetic replay).
- **verdict:** **fixed**.
- **fix_commit:** `3ad41a8`.
- **hermes_gate:** `PASS` — `cd analysis && npm run hermes-gate -- ../docs/research/reports/live-run-R8-20260703-hermes.md`
  validates the `step1` block + `docs/research/reports/step1-R8-20260703.json` artifact (window
  overlap, funnel/dominant_drop/events_source, coffeebabe full-mode 0/0 txs, 0xae2Fc483 sample-mode
  4 hand-traced txs with pools classified in/out of graph + gap_class, coverage_kpi consistent).

## Note on the "+EV non-dust simSuccess → stop and flag for human broadcast" rule
This finding is a **retrospective replay proof on a historical opportunity** (block 25447211 has
long since passed; nothing to submit). No live, currently-actionable bundle exists to flag. The
practical effect is forward-looking: future FRAX-denominated (or any newly-covered stable) genuine
opportunities will now correctly reach the EV gate's pass branch instead of being auto-zeroed.
Since the node runs `SEARCHER_DRY_RUN=1` (verified post-redeploy), any future pass still lands in
`DryRunBundleRouter`, not a real broadcast — the human gate (Safety Rule 1) is unaffected by this
change.

## Deploy
Pushed `3ad41a8` to `origin/main`, redeployed via `scripts/deploy-node.sh`: HEAD now `3ad41a8`,
`dry_run_env=1`, universe=1500, pool registry 4652 total. Fix is live for the next measurement
window.

## Findings Ledger
| finding | owner | carry_to | status |
|---|---|---|---|
| `valueInEth` zeroes any profit token outside {WETH,USDC,USDT,DAI} | R8 | — | **done** — FRAX added, gated via unit-test flip + full EV-gate arithmetic replay (`fixed`, commit `3ad41a8`), deployed |
| general "hardcoded stable allowlist is fragile" (other 18-dec stables — crvUSD/GHO/USDe/LUSD — will hit the same zero-valuation bug when they appear as profit tokens) | future | R9+ | open, non-blocking — deliberately NOT fixed wholesale this round (scope discipline); revisit if a live rejection recurs for a different token |
| `0xdcef968d...` pool (competitor block 25447233, same FRAX token, `pool_in_seen_events:false`) | future | R9+ | open, non-blocking — secondary/smaller than the valuation fix, not chased this round |
| v4 backfill's live funnel effect on `impact_pool_not_in_routing_graph` rate vs R6's baseline (31/32 null) | R7→R9 | R9 | open — this window had 0 samples in that specific classifier bucket (too few pipeline_dropped events with that reason to compare); needs another window, ideally longer, to get a real before/after read |
| JIT-LP strategy-shape gap (0xae2Fc483, "LP-positioned(partial→arb)") | future | monitor | reconfirmed, not new — already classified "unsupported strategy shape" (rule 6), no action this round |
| concurrent-session collision (PID 77146/77145) | human | monitor | unchanged — idle 18h+, 0% CPU, zero open file handles, clean tree; safeguard held (only 3 narrowly-scoped `main.ts` lines touched) |

## searcher_behavior_change: yes
The EV gate will no longer auto-reject genuine, non-dust profit opportunities denominated in FRAX.
This is a direct, measured step toward Mission #1 — a real economics bug that was silently
discarding +EV opportunities is now fixed and live on the node.

## Next action
Round complete: measured R7's carry (v4-routed candidate confirmed reaching simulation), ran the
mandatory competitor cross-reference (JIT-LP shape reconfirmed, not new), found and fixed a genuine
economics bug via dual-blind blocker discovery (fable A + Codex B converged exactly), gated it
(`fixed`, full arithmetic replay + unit test), committed (`3ad41a8`), pushed, and redeployed to the
node. Releasing the round lock. Next Hermes work (R9) should run a fresh ~30min window to (a)
confirm the FRAX fix's live effect (a FRAX or other-now-covered-stable opportunity should now show
`simSuccess` passing `below_ev_gate` instead of being rejected) and (b) get a larger sample on
whether R7's v4 backfill shifts the `impact_pool_not_in_routing_graph` rate, per the carried
findings above. External scheduler (`hermes-hourly`, confirmed enabled) is the continuation trigger.
