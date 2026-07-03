# Hermes Live-Run Round R14-20260703

> Scope: authorized, defensive on-chain arbitrage research. Node runs bounded-live inside the
> script-enforced envelope (Safety Rule 1): `.deploy-live` marker + signer wallet ≤ 0.2 ETH +
> `SEARCHER_EV_GATE=1`; flash-arbs are atomic so principal is never at risk. Broadcast outside the
> envelope stays a human gate. Autonomous `hermes-hourly` round (user away — decide + proceed per
> rules 14/15).

```yaml
cycle_id: R14-20260703
date: 2026-07-04
orchestrator: Fable 5 (autonomous hermes scheduled run)
type: live-run-analysis + implementation (bounded-live window → dual-blind blocker → deterministic fix)
cu_budget: 1000 (per-fire cap)
cu_spent: ~0 (all analysis on local reth + local build; fable sub-agent used a light Alchemy check <500 CU)
codex: landed (v4 swap-hook admission filter; rule-12 gate flips; evaluator re-ran both gates)
searcher_behavior_change: yes (stops admitting unquotable swap-hooked v4 pools → frees solver TTL/candidate-cap)
hermes_gate: PASS
```

## Step 0.5 — bounded-live safety valve
- Signer `0xb8578B6de173C8554FF0390dB5a7effA567DDA3c` = **0.002704 ETH**; baseline
  (`/opt/MEV/.live-start-balance-eth`) = 0.002704. Unchanged across the whole window (no live submission
  fired). ≥ 50% of baseline → **no circuit-break**. `.deploy-live` PRESENT, `SEARCHER_DRY_RUN=0`,
  `SEARCHER_EV_GATE=1` — bounded-live confirmed at deploy, window, and post-fix redeploy.

## Deploy + mode-preservation
- Opened window on `c7ad3ac` (R13 HEAD) via `deploy-node.sh`; mode preserved bounded-LIVE, universe=1500
  (total 4914 pools), `SEARCHER_EVENTS_PATH=/var/log/mev/events/searcher-live.jsonl` writing, fresh restart.
- Post-fix redeploy to `4c27ead`: node HEAD == origin/main, searcher restarted fresh (uptime 46s),
  mode **preserved** bounded-LIVE (`DRY_RUN=0 EV_GATE=1`, `.deploy-live` present), universe=1500.

## Window facts
- run_id `82f92bf5-338a-4f94-8f50-5972a397e697`, blocks **25452791 → 25452982** (~192 blocks, ~38 min).

## Auto analysis — funnel (pipeline_dropped filtered by run_id)
| stage | R14 | R13 |
|---|---|---|
| opportunity_seen | 244 | 359 |
| pipeline_dropped | 242 | 356 |
| — no_candidate_plans | 93 (**38%**) | 178 (50%) |
| — no-profitable-quote | 78 | 80 |
| — candidate-cap | 41 | 58 |
| — expired-before-solver | 28 | 36 |
| — quote-timeout / below_ev_gate | 1 / 1 | 4 / — |
| simulation_result ok:true | 1 (dust, gate-rejected) | 1 (+EV, submitted) |
| bundle_submitted | 0 | 1 |

The one ok sim was a v3 3-hop (wstETH→USDC→WETH→wstETH) at 6.1e-6 wstETH — sub-cent dust, correctly
`below_ev_gate`. No live submission this window (R13's +EV milestone was a v4 native-ETH opp that did
not recur).

**NEW dominant signal this round — the solver-stage v4 quote poison.** `no-profitable-quote` (78) +
`candidate-cap` (41) drop events carry a verbatim revert payload `0x6190b2b0` on v4-singleton longtail
pools. Decoded (via `cast sig`, both blind analysts independently):
`0x6190b2b0 UnexpectedRevertBytes(bytes)` → `0x90bfb865 WrappedError(address,bytes4,bytes,bytes)` →
inner `0x7a5ed734 NotEnoughLiquidity(bytes32)` (thin hookless pool) OR a hook custom error
(`beforeSwap` → `HookCallFailed` — the **dominant** shape). The solver grid-quotes v4 pools our
hookData-less path can never serve; each trial reverts, is swallowed as FAIL_SCORE, and the wasted work
burns the opportunity TTL → starves later opps into `expired-before-solver` (28).

`no_candidate_plans` (still present, now 38%) is the separate, already-owned single-pool-token
return-venue gap (`impact_token_return_venues_excluding_impact_pool=0`) = the pool-scoring arb-relevance
EPIC ([[project-pool-scoring-arb-relevance-epic]]); no per-pool pins (rule 13).

## Step-1 competitor cross-reference (mandatory; local reth, zero-CU)
```step1
run_id: 82f92bf5-338a-4f94-8f50-5972a397e697
window_blocks: 25452791..25452982
watchlist: 0xc0ffeebabe5d496b2dde509f9fa189c25cf29671,0xae2fc483527b8ef99eb5d9b44875f005ba1fae13
artifact: docs/research/reports/step1-R14-20260703.json
method: manual-onchain-trace
```
- **coffeebabe (our exact atomic class): nonce_delta=0, ZERO txs in 192 blocks.** No comparable atomic
  activity at all this window — reconfirms the atomic-backrun market ceiling on public flow
  ([[project-atomic-backrun-market-ceiling]]).
- **ae2Fc483 (sandwich/inventory bot): 79 txs, 0 failed, all to bot `0x1f2f10d1…f387`.** 25 same-block
  PAIRS (all index-gaps 2–5 = sandwich brackets), 29 singles. Hand-traced single `0xec673e87…`: net
  ERC20 flow to bot+EOA = **0** across all tokens, no coinbase transfer, bot ETH delta +175 wei while
  paying 0.000142 ETH fee — no comparable atomic capture. Out-of-posture per §6c.
- **Coverage KPI:** 14 sampled competitor legs, 3 out-of-graph pools, each touched **once** on the
  out-of-posture flow (single-venue longtail noise; the traced tx netted 0 atomic capture).
  **closable=0.** No coverage gap this window.

## Blocker (dual-blind — converged)
- **Conclusion A (fresh fable sub-agent, code + chain):** solver burns TTL grid-quoting v4 longtail
  pools that revert in V4Quoter — **dominated by swap-hooked pools** our hookData-less path can never
  serve. Chain-verified: the sample pool [USDT, `0xb10cc888…`] = poolId `0x08c43cbd…`, hooks
  `0x0025040F…eEb0fc0` (BEFORE_SWAP+AFTER_SWAP bits set); `eth_call` V4Quoter reverts with the exact
  window payload → `HookCallFailed`. Fix = reject swap-hooked v4 pools at admission via hook address
  bits (`& 0xCC`), zero RPC. gap_class = **quoting-defect** (unquotable-venue admission).
- **Conclusion B (Codex, code + the raw data package, blind to A):** same nearest blocker —
  solver-stage v4 liquidity quote poisoning; decoded the identical selectors incl. inner
  `NotEnoughLiquidity`; proposed decode + per-opportunity v4 poolId quarantine. gap_class =
  quoting-defect.
- **Compare:** converged on blocker + gap_class. A is the more-upstream minimal fix (reject at admission,
  deterministic, zero-RPC, targets the dominant hooked shape with a clean replay flip); B's runtime
  quarantine is a valid complement for the thin-pool `NotEnoughLiquidity` shape (carried, not built this
  round). Finalized: **A's admission filter.**

## Implementation (Codex writes → Fable evaluates + gates)
- **Fix:** `listener/src/searcher/planner/token-graph.ts` `queryPoolEdges` `case "univ4"` — after
  `resolveV4PoolKey`, `if (v4HooksAffectSwap(poolKey.hooks)) break;` (no edges → pool absent from graph).
  `v4HooksAffectSwap = (BigInt(hooks) & 0xCCn) !== 0n` (BEFORE_SWAP|AFTER_SWAP|*_RETURNS_DELTA). Surgical
  (9 lines). Hookless / non-swap-hook v4 pools unaffected.
- **rule-12 repair-replay gate (NEW harness `searcher:v4-hook-admission`):**
  - `failing_sample:` hooked v4 pool `0x08c43cbd…` ([`0xb10cc888…`, USDT], fee 3000, ts 60, hooks
    `0x0025040F…eEb0fc0`).
  - `baseline_failure:` fix disabled → hooked pool yields **2 edges** → test FAILS (evaluator verified by
    temporarily neutering `v4HooksAffectSwap`).
  - `fix_commit:` `4c27ead`.
  - `replay_command:` `cd listener && npm run searcher:v4-hook-admission`.
  - `replay_result:` `PASS hooked_edges=0 hookless_native_edges=2`.
  - `expected_transition:` graph_gap → `pool_in_routing_graph true→false` for the hooked pool, with the
    hookless native control (`0xc8Fb…888888`, hooks 0x0) asserted stays-true (2 edges).
  - `verdict:` **fixed** (deterministic flip confirmed, genuine).
- **Regression:** `searcher:planner` PASS (14/14 + replay 12/12 + high-spread universe); its existing
  "CFG v4 route gap flip: pool_in_routing_graph false→true" still PASS → the fix does NOT over-reject
  hookless v4 pools.
- **Evaluator (Fable, non-author):** `ran_gate:` built + ran v4-hook-admission (PASS), proved baseline
  FAILS with fix disabled, ran planner regression (PASS); reviewed every diff hunk (3 files, +10 lines,
  scope-clean). `finding:` genuine rule-12 flip, no over-rejection, no regression → approved + committed.

## Rule-13 arch-review trigger — NOT fired
Trigger = ≥2 consecutive rounds close with NO growth in a genuine +EV `simSuccess`. R13 grew to a
submitted +EV sim; R14 shipped a searcher_behavior_change (the v4 admission filter) that removes a
concrete quote-poison source — not a null/observability-only round. The next round's live metrics
confirm the funnel effect (solver drops carrying the hook payload → ~0; `expired-before-solver` ↓). If
the next round is flat-zero submitted +EV AND shows no funnel improvement, the trigger arms.

## Findings Ledger
| finding | owner | carry_to | status |
|---|---|---|---|
| Swap-hooked v4 pools admitted but unquotable → burn solver TTL/candidate-cap (quoting-defect) | R14 | — | **CLOSED** — reject-at-admission filter shipped `4c27ead`, rule-12 flip verified, deployed to node ([[project-v4-swaphook-admission-gap]]) |
| Thin hookless v4 pool `NotEnoughLiquidity` grid poison (secondary shape) — Codex's fail-fast/quarantine idea | R14 | R15 | open — smaller residual after the hook filter; measure next window whether it still dominates solver drops before building |
| `no_candidate_plans` 38% — single-pool-token return-venue gap | pool-scoring epic | R15 | open — EPIC (arb-relevance scoring); no per-pool pins |
| coffeebabe = zero atomic activity this window (192 blocks) | R14 | — | closed — reconfirms atomic-backrun market ceiling |
| ae2Fc483 sandwich/inventory = out-of-posture (zero net on traced single) | posture (human gate) | when human decides | open — direction-map posture decision, human gate |
| R12 high-spread quota KPI (hours-scale before/after) | R12→R15 | R15 | partial — two 37-min data points now; longer window still wanted |
| R10 v4 production backfill | R10→R14 | R15 | **relaunched** — prior process was wedged (13h, no IO progress, IO counters frozen); killed + relaunched as systemd unit `v4-backfill-r14` (post-swapLogs, in the slow per-poolId backward-resolve stage at round close). NOTE: many activity-discovered v4 pools are now swap-hooked → rejected at admission by `4c27ead`, so backfill value is now the hookless subset. Check next round |

## Verdict + close
- **verdict:** implementation round complete. Dual-blind converged on a **quoting-defect** (swap-hooked
  v4 pool admission poisoning the solver); shipped the minimal reject-at-admission fix (`4c27ead`),
  rule-12 gate flips genuinely (2→0 edges, baseline-verified), planner regression green, deployed to node
  bounded-live with mode preserved. searcher_behavior_change: **yes**. Competitor cross-ref: no closable
  coverage gap (coffeebabe zero, ae2Fc483 out-of-posture).
- **hermes_gate:** PASS.
- **carry:** thin-pool NotEnoughLiquidity residual (R15, measure-first), single-pool-token return gap
  (epic, R15), R10 backfill (relaunched, R15), R12 quota KPI hours-scale (R15).
