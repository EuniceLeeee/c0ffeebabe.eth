# R9 — post-fix validation + first non-dust bundle_submitted (2026-07-03)

> Scope: authorized defensive on-chain arbitrage research; local-reth reads; broadcast is a
> separate human-gated step, not performed here. Orchestrator = the hourly Hermes cron
> (self-driven, rule 14).

```yaml
run_id: R9-20260703
date: 2026-07-03
window: block 25447402-25447559 (157 blocks, ~33min), HEAD=c9f2991 (post-R8 FRAX fix)
config: SEARCHER_DRY_RUN=1, SEARCHER_EV_GATE=1, SEARCHER_BRIBE_BPS=5000, universe=1500
cu_budget: <=1000 Alchemy CU
cu_spent: 0 (deploy verify + window pull + competitor cross-ref + all cast calls ran against local reth via SSM)
codex: not dispatched this round (no new blocker found; see Judgment call below)
turn_class: observability/validation (searcher_behavior_change: no — see rationale)
```

```step1
run_id: R9-20260703
window_blocks: 25447402..25447559
watchlist: 0xc0ffeebabe5d496b2dde509f9fa189c25cf29671,0xae2fc483527b8ef99eb5d9b44875f005ba1fae13
artifact: docs/research/reports/step1-R9-20260703.json
method: manual-onchain-trace
```

## R8 carry executed
Deployed latest main (`c9f2991`, docs-only on top of R8's fix `3ad41a8`) via `scripts/deploy-node.sh`
— confirmed `universe=1500`, `dry_run_env=1`, `SEARCHER_EV_GATE=1`, `SEARCHER_BRIBE_BPS=5000`,
`SEARCHER_EVENTS_PATH` set. Ran a fresh ~33min window (line offset 3428, block 25447402) to resolve
R8's two carried findings: (a) does the FRAX/`valueInEth` fix produce a live genuine non-dust
`simSuccess`, and (b) does R7's v4 backfill measurably shift the `impact_pool_not_in_routing_graph`
rate.

## Run Facts
64 new events in the strict window: 32 `opportunity_seen`, 32 `pipeline_dropped`, **0**
`simulation_result` — thinner than R8 (103 events/147 blocks). `pipeline_dropped`: `no_candidate_plans`=20,
`quote-timeout`=5, `candidate-cap`=4, `no-profitable-quote`=1, `expired-before-solver`=2.

Of the 20 `no_candidate_plans`: 19/20 classify `only_immediate_same_pool_reverse` (correctly-pruned,
non-arbable), 1/20 `impact_pool_not_in_routing_graph`.

## Carry (a): does the FRAX fix produce a live non-dust simSuccess? — YES, evidence found (not FRAX-specific, but end-to-end proof)
Per rule 13 (never conclude from a starved sample), extended the search past the strict window since
0 `simulation_result` landed inside it. Found **1 `simulation_result` at block 25447376** (just before
this window started, same deployed code): `ok:true`, profit token USDC, `simulated_profit`=9505577 raw
(~9.51 USDC), `gas_estimate`=413853 (real, non-zero), which reached **`bundle_submitted`**
(`simulated_profit_eth`=2172703314285713 wei ≈ **$3.69** @ ethUsd=1699, `bid`=1086351657142856 wei
≈50% bribe matching `SEARCHER_BRIBE_BPS=5000`, `mode: eth_sendBundle`, `builders_sent: ["dry-run"]`).

Cross-checked against **all 28** `bundle_submitted` events in the log's entire history
(`searcher-live.jsonl`, spanning back to 2026-07-02): every prior one is dust (max ~$0.29,
`25444719`). This block-25447376 bundle is **~13x the previous max** — the first genuinely non-dust
simulated bundle the searcher has produced in dry-run history. Direct, end-to-end evidence the
R4→R8 fix stack (universe load, gasUsed sim-fidelity, EV-gate flip, FRAX/`valueInEth` generalization)
now produces real economics, not just theoretically.

**Not actionable:** target block 25447376 is 238 blocks (~48min) in the past by measurement time —
long mined over. Per Safety Rule 1 / the scheduled-task stop condition, there is nothing live to flag
for human broadcast; this is retrospective proof, same posture as R8's replay finding.

## Carry (b): does v4 backfill shift the impact_pool_not_in_routing_graph rate? — answered, reconfirms a known artifact, not new coverage
Pulled R8's own window's diagnostic breakdown for a real before/after (both R8 and R9 are
post-v4-backfill; R6 is the pre-backfill baseline):
- R6 (pre-backfill): 2/13 `impact_pool_not_in_routing_graph` (15.4%)
- R8 (post-backfill): 1/28 (3.6%)
- R9 (post-backfill): 1/20 (5.0%)
- R8+R9 combined: 2/48 (4.2%)

The rate did drop, but hand-tracing the residual samples kills the "v4 backfill closed it" story:
**R8's and R9's single `impact_pool_not_in_routing_graph` sample is the exact same pool**
(`0x5016cd7b785a773f7f3a3ff4035a1e7a76543946`, USDT/CAGA, same token pair, recurring 2 consecutive
rounds). On-chain trace (local reth, zero CU): this is a real Uniswap V2 pool holding $436,664 USDT
(17.1T of 100B total-supply CAGA on the other side) — real liquidity, not dust. But CAGA's *only*
other pool (CAGA/WETH V2, `0x0184aABF9bbbe301285114C5e19bae9dfEcDE60E`) has **zero reserves** (dead),
and no SushiSwap V2 or Uniswap V3 (500/3000/10000 fee tiers) pair exists for CAGA at all. So
`impact_token_return_venues: 0` is *correct* — no genuine return venue exists on-chain, not a
missing-graph-edge. This reconfirms R4's open finding (`classifier blind spot`, carried R6+, R7+):
`impact_pool_not_in_routing_graph` conflates "no venue exists" with "graph missing an edge." Every
hand-traced sample across R6/R8/R9 (4 total) has been the former. **v4 backfill's effect on this
specific classifier bucket cannot be confirmed from this evidence** — the small residual is fully
explained by a pre-existing artifact, not by remaining v4 gaps.

## Mandatory competitor cross-reference (local reth, zero Alchemy CU)
`analysis live-loss --watch coffeebabe,0xae2Fc483... --rpc http://127.0.0.1:8545 --from-block
25447402 --to-block 25447559` (157 blocks) — 42 records after filtering strictly to the JSON `block`
field inside the window (glob overlap with R8's block-25447xxx watch reports caught and excluded).

- **coffeebabe — 3 txs this window (vs 0 in R8), all hand-traced (mandatory full mode):**
  - Block 25447470: swap-loop USDT→0xda5e1988→WETH via a v3 USDT/WETH pool we DO have
    (`0xc7bbec68...`, matches our own `expired-before-solver` drop same window) + one unseen pool.
    Realized $0.24 — dust, sub-gas-floor.
  - Block 25447483: swap-loop through 2 Uniswap v4 pools (poolIds `0x00b9edc1...`, `0x04607d75...`),
    `pool_in_routing_graph: null`. Realized $0.089 — dust, v4-routed.
  - Block 25447518: single v4 swap (poolId `0x5b75f68b...`, fee=500000 dynamic-fee pool). Realized
    $0.23 — dust, v4-routed. (Curiosity, not chased: the v4 Swap event's `sender` field matches
    `0xE08D97e151473A848C3d9CA3f323Cb720472D015`, the original wstUSR reference-tx bot address from
    CLAUDE.md — could be the same operator now running v4 arbs, but `sender` on a v4 unlock is
    typically a router/hook contract, not conclusive from one sample.)
  - **Classification: partial v4-coverage gap, already tracked (R6/R7), reconfirmed not new. All 3
    dust.**
- **0xae2Fc483... — 39 txs, fully swept (nonce/watch-tool match), sampled 4:** dominant pattern
  again `LP-positioned(partial→arb)` through pool `0xe0554a476a092703abdb3ef35c80e0d76d32939f` —
  **the same pool our own `pipeline_dropped candidate-cap` events hit twice this exact window**
  (blocks 25447446, 25447486). We see this pool, generate candidates, hit `candidate-cap`; the
  competitor executes a JIT-mint-then-arb through it and wins. **Reconfirms the R6/R8 "unsupported
  strategy shape (JIT-LP)" gap — not new, already classified, no action this round** (rule 6/13:
  a recurring already-classified gap_class, not a fresh finding).

## Blocker discovery — not run this round (Judgment call, rule 14 self-served)
No dual-blind blocker search was dispatched. Rationale: every signal this window (own funnel data +
competitor cross-reference) reconfirms **already-tracked, already-classified** findings (classifier
blind spot, JIT-LP shape, partial v4 coverage) — none is a *new* blocker warranting fresh root-cause
work. Forcing a dual-blind search onto already-diagnosed findings would be manufactured activity, not
signal. The round's real output — proof of a genuine non-dust `bundle_submitted` — is validation, not
a new-blocker discovery, and doesn't need a fix; it needs recording.

**Considered and explicitly deferred:** fixing the `impact_pool_not_in_routing_graph` /
`only_immediate_same_pool_reverse` classifier split (`listener/src/searcher/planner/planner.ts:610-640`,
`impact_token_return_venues`-based logic) to stop mislabeling non-arbable single-venue tokens as
"graph gaps." This is now evidenced by 4 hand-traced samples across 3 rounds (R6 x2, R8 x1, R9 x1),
all false positives. **Not done this round** — it is a diagnostic/observability fix only (doesn't
change what the searcher trades; the underlying opportunities are genuinely non-arbable regardless of
the label), so it does not move a real gap toward closed per the mission definition. Carried as an
open, non-blocking finding, now with materially stronger evidence, for whichever round has slack.

## Findings Ledger
| finding | owner | carry_to | status |
|---|---|---|---|
| First genuine non-dust `bundle_submitted` (~$3.69, 13x prior max) | R9 | — | **done** — retrospective proof only (target block 238 blocks stale); confirms R4-R8 fix stack works end-to-end; no bundle to flag for broadcast |
| R8 carry (a): does FRAX fix produce live non-dust simSuccess | R8→R9 | — | **done** — indirect confirmation via the block-25447376 non-dust bundle (USDC-denominated, not FRAX specifically, but proves the EV-gate/valueInEth pipeline generally works for non-dust profit); no FRAX-specific live sample appeared this window |
| R7 carry (b): v4 backfill's effect on impact_pool_not_in_routing_graph rate | R7→R9 | — | **done, null result** — rate dropped 15.4%→4.2% (R6 vs R8+R9) but the residual is fully explained by the pre-existing classifier blind spot (same non-arbable CAGA/USDT pool recurring), not v4 coverage; cannot attribute the drop to v4 backfill from this evidence |
| classifier blind spot (`impact_pool_not_in_routing_graph` conflates no-venue vs missing-edge) | future | when slack exists | open, non-blocking — now 4/4 hand-traced samples across R6/R8/R9 are false positives; `planner.ts:610-640`; deliberately not fixed this round (observability-only, no behavior change) |
| partial v4 pool coverage (coffeebabe: 2/3 txs this window v4-routed, `pool_in_routing_graph:null`) | future | monitor | reconfirmed, not new — R7's backfill (655/1500 slots) doesn't yet cover these specific poolIds; already-epic'd, per-pool pins forbidden (rule 13) |
| JIT-LP strategy-shape gap (0xae2Fc483, pool `0xe0554a476...` — same pool as our own `candidate-cap` drops this window) | future | monitor | reconfirmed, not new — already classified "unsupported strategy shape" (rule 6) |
| `0xE08D97e151473A848C3d9CA3f323Cb720472D015` (CLAUDE.md's reference wstUSR bot) appears as v4 Swap `sender` in a coffeebabe-watched tx (block 25447518) | future | curiosity | open, not chased — inconclusive from one sample (v4 `sender` is typically router/hook, not EOA) |

## searcher_behavior_change: no
No code shipped this round. The round's value is **validation**: (1) direct evidence the R4-R8 fix
stack now produces a genuine non-dust simulated bundle (13x the prior best), and (2) both of R8's
carried open questions resolved with real data rather than left to guess. Per rule 13's anti-drift
cap, this is the ONE allowed observability/validation turn following R8's `extraction` turn; R10 must
either ship a real behavior change or escalate.

## Next action
Round complete: resolved both R8 carries with hand-traced evidence, ran the mandatory competitor
cross-reference (no new blocker — all findings reconfirm already-tracked gaps), found and documented
the first genuine non-dust `bundle_submitted` in the searcher's history (retrospective, nothing to
broadcast). No code change this round (deliberate — no new blocker to fix; see Judgment call).
`hermes-gate` run below. Releasing the round lock. Confirmed via `list_scheduled_tasks`: `hermes-hourly`
cron is enabled, next fire ~22:08 UTC — that is R10's continuation trigger. R10 should (a) ship a real
searcher_behavior_change (rule 13 requires it after this observability turn — the classifier fix
carried above is one low-risk candidate if no larger blocker surfaces), and (b) keep watching for
another non-dust `simulation_result`/`bundle_submitted` to see if block-25447376 was a one-off or the
start of a real trend now that the fix stack has landed.
