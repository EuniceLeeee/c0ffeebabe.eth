# Hermes Live-Run Round R13-20260703

> Scope: authorized, defensive on-chain arbitrage research. Node runs bounded-live inside the
> script-enforced envelope (Safety Rule 1): `.deploy-live` marker + signer wallet ≤ 0.2 ETH +
> `SEARCHER_EV_GATE=1`; flash-arbs are atomic so principal is never at risk. Broadcast outside the
> envelope stays a human gate. This is an autonomous `hermes-hourly` round (user away — decide + proceed
> per rules 14/15).

```yaml
cycle_id: R13-20260703
date: 2026-07-03
orchestrator: Fable 5 (autonomous hermes-hourly scheduled run)
type: live-run-analysis (bounded-live measurement window)
cu_budget: 1000 (per-fire cap)
cu_spent: ~0 (all analysis on local reth + local build; no Alchemy)
codex: not invoked — no closable deterministic gap this window (see verdict)
hermes_gate: PASS
```

## Step 0.5 — bounded-live safety valve
- Signer `0xb8578B6de173C8554FF0390dB5a7effA567DDA3c` = **0.002704 ETH**; baseline persisted this run
  (`/opt/MEV/.live-start-balance-eth` = 0.002704). ≥ 50% of baseline → **no circuit-break**. Balance
  unchanged across the whole window (no loss). `.deploy-live` PRESENT, `SEARCHER_DRY_RUN=0`,
  `SEARCHER_EV_GATE=1` — bounded-live confirmed throughout.

## Deploy + mode-preservation
- Deployed `origin/main` `6eec9e9` via `scripts/deploy-node.sh`. Node HEAD == origin/main, searcher
  restarted fresh (uptime 1:21 at window open), mode **preserved** bounded-LIVE
  (`DRY_RUN=0 EV_GATE=1 BRIBE_ALL_ABOVE_GAS=1`), `universe=1500 forceInclude=1 total=4902`,
  `SEARCHER_EVENTS_PATH=/var/log/mev/events/searcher-live.jsonl` confirmed writing. R12's high-spread
  quota (`highSpreadPairQuota=150 highSpreadMinFee=10000`) + the v4 native-ETH path are live on the node.

## Window facts
- run_id `d3055f19-90b7-4b9b-a638-ab2557120292`, blocks **25452197 → 25452382** (~185 blocks, ~37 min).

## Auto analysis — funnel (pipeline_dropped filtered by run_id)
| stage | count |
|---|---|
| opportunity_seen | 359 |
| pipeline_dropped | 356 |
| — no_candidate_plans | **178 (50%)** |
| — no-profitable-quote | 80 |
| — candidate-cap | 58 |
| — expired-before-solver | 36 |
| — quote-timeout | 4 |
| **simulation_result (ok:true, +EV)** | **1** |
| **bundle_submitted (live, 3 builder accepts)** | **1** |
| bundle_not_included | 1 |

**North-star funnel-depth milestone:** for the first time in recent rounds the funnel reached a
**+EV `simSuccess` that passed the EV gate and was submitted live** in bounded-live — a v4 native-ETH
arb (`path_id` = univ3-swap → univ4-unlock/swap/take → weth-deposit-value → univ4-sync/settle),
`simulated_profit` 0.000279 WETH (≈ $0.49 at the window's ethUsd≈1749), `bid` 0.000136 ETH (≈ $0.24 net
EV), accepted by 3 of {flashbots, titan, rsync, beaverbuild}. Compare R12: sims were sub-cent dust
($0.03–0.06) rejected by the gate. This is real funnel progress (reached `bundle_submitted`), though the
absolute size is small — it does **not** overturn the direction-map's atomic-backrun market-ceiling
conclusion (this $0.49 opp lost to a $1.80 out-of-posture bid; see below).

**Dominant drop unchanged: `no_candidate_plans` 50%.** Sub-shape from `no_candidate_diagnostic`:
`same_pool_reverse_edge_exists=true, cross_venue_reverse_count=0, impact_token_supported_pools=1` — the
impact token exists in only ONE pool we index, so no cross-venue loop can close (the only "plan" is a
same-pool immediate reverse, correctly pruned). This is the **single-pool-token return-venue gap** = the
pool-scoring arb-relevance epic (memory `project-pool-scoring-arb-relevance-epic`); R12's high-spread
quota was slice-1, the single-pool-token return gap persists. Per rule 13, this stays an EPIC — no
per-pool pins.

## Bundle post-mortem — the one live bundle that lost (§6c step-1a)
Ran `bundle-postmortem --tx 0x7e4749aa… --rpc <local reth>` on the node. Verdict:
- **`outbid=true`, `route_gap_decisive=false`, `non_comparable_winner=true`.**
- Triggering swap `0xee408c87…` landed in block 25452199 (builder **Eureka**). Winner
  `0x48b5efd2…` (index 5) backran the same swap but is **`one_leg_inventory` / CEX-DEX**
  (`winner_moved_price_beyond_prestate=true`, profit in unpriceable token `0xcccc…4e8a94` → off-chain
  realization). Winner venue univ3 `0x08a10a8b…` is `in_graph=true`. Winner builder payment
  **0.001027 ETH ($1.80)** vs our bid 0.000136 ETH / our full sim gross 0.000279 ETH.
- **Codified §6c step-2 filter fired correctly:** a CEX-DEX one-leg-inventory winner is NOT comparable
  to our atomic sim — its value comes from an off-chain inventory leg we don't have, so no bid or
  coverage change could win it profitably. Our atomic sim gross is the correct ceiling. **No coverage /
  path / sizing / bid fix.** (This is exactly `project-cex-dex-inventory-competitor-noise`.)

## Step-1 competitor cross-reference (mandatory; local reth, zero-CU)
```step1
run_id: d3055f19-90b7-4b9b-a638-ab2557120292
window_blocks: 25452197..25452382
watchlist: 0xc0ffeebabe5d496b2dde509f9fa189c25cf29671,0xae2fc483527b8ef99eb5d9b44875f005ba1fae13
artifact: docs/research/reports/step1-R13-20260703.json
method: manual-onchain-trace
```
- **coffeebabe (our exact atomic class): 2 address-matches, 1 real tx (nonce_delta=1).** The one real tx
  `0x631dcbf6df…` (block 25452251) = `trade.swap -> unwrap` (atomic swap→native-ETH, our shape), return
  pool `0xf82d…9f88` (A2B4C0…/WETH) **already `in_routing_graph=true`**, realized $0.06 / builder
  payment **$0.00 = dust**. No coverage gap — the money isn't there. Reconfirms the atomic-backrun
  market ceiling on public flow.
- **ae2Fc483 (sandwich bot): 74 txs (nonce_delta=74), sampled 3.** All out-of-posture sandwiches
  (frontrun+backrun brackets). The window-level `graph_gap=3` counter is the WETH-token-as-pool /
  v4-singleton (manager-only) artifact; the v4-aware venue classifier is the one to trust:
  **`pool_gap=0, execution_adapter_gap=0, detection_gap=16, unknown=20`.** Sampled legs touch the v4
  PoolManager singleton `0x0000…4444c` and a WETH/`0xe015…7ff0` sandwich pool `0x877193…c144` —
  out-of-posture, not a closable atomic-backrun gap.
- **Coverage KPI:** competitor_legs_total=4 sampled, legs_out_of_graph=2, out_pools=1
  (`0x877193…c144`), **closable=0, single_venue_noise=1**. No closable coverage gap this window.

## Blocker / classification (dual-blind not spawned — see rationale)
The §6c postmortem + competitor cross-reference produced a **decisive, tool-codified verdict**: the one
live loss is a non-comparable CEX-DEX winner (correctly filtered), coffeebabe is dust with its return
pool already in graph, ae2Fc483 is out-of-posture sandwiching, and the v4-aware classifier reports
`pool_gap=0 / execution_adapter_gap=0`. **There is no closable pool / path / execution-adapter gap this
window.** Spawning a fresh-fable + Codex dual-blind to re-derive "no closable gap" from the same data
would burn resources to confirm what the codified tooling already concluded (rule-14 self-serve: I judged
this not warranted; recorded here). No Codex fix is written this round — manufacturing one with no
closable gap would violate rule 2 (no invented work) and rule 13 (don't fake progress). This is **not** a
null round: it MEASURED the first live +EV `simSuccess` submission and cleanly attributed the single loss.

## Rule-13 arch-review trigger — NOT fired
Trigger = ≥2 consecutive rounds close with NO growth in a genuine +EV `simSuccess`. This round the funnel
grew from R12's sub-cent dust (gate-rejected) to a +EV `simSuccess` that **passed** the gate and was
**submitted live**. That is growth in funnel depth → trigger does not fire. (The absolute value is small;
if the next round regresses to flat-zero submitted simSuccess again, the trigger arms.)

## Findings Ledger
| finding | owner | carry_to | status |
|---|---|---|---|
| First live +EV `simSuccess` submitted in bounded-live (v4 native-ETH, ~$0.49 gross), lost to non-comparable CEX-DEX winner | R13 | — | **milestone recorded**; loss is out-of-posture, no fix (§6c non_comparable_winner) |
| `no_candidate_plans` still 50% dominant — single-pool-token return-venue gap (impact_token_supported_pools=1, cross_venue_reverse_count=0) | pool-scoring epic | R14 | open — EPIC (arb-relevance scoring); R12 slice-1 (high-spread quota) done, single-pool-token return gap remains; NO per-pool pins (rule 13) |
| coffeebabe = dust ceiling reconfirmed (1 real tx, $0.06/$0.00 builder pay, return pool in graph) | R13 | — | closed — reconfirms `project-atomic-backrun-market-ceiling`; not a capability gap |
| ae2Fc483 sandwich money ($ tips) is out-of-posture | posture (human gate) | when human decides | open — direction-map posture decision, human gate (rule 14 stop condition) |
| proper before/after coverage-KPI for R12 high-spread quota (hours-scale) | R12→R13 | R14 | partial — this 37-min window is one data point (KPI artifact written); a longer window still wanted |
| R10 v4 production backfill pid status | R10→R13 | R14 | not checked this round — carry |
```
```

## Verdict + close
- **verdict:** live-run-analysis round complete. Milestone: first bounded-live +EV `simSuccess`
  submitted (3 builder accepts); single loss cleanly attributed to a non-comparable CEX-DEX competitor
  (no closable gap). Dominant `no_candidate_plans` (50%) traced to the single-pool-token return-venue
  gap = the owned pool-scoring arb-relevance EPIC. No code fix warranted (no invented work).
- **hermes_gate:** PASS (see below).
- **carry:** single-pool-token return gap (epic, R14), R12 quota KPI hours-scale window (R14),
  R10 v4 backfill status (R14).
