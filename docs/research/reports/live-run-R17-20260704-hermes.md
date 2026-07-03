# Hermes Live-Run Round R17-20260704 — filter live-validation + arch-review-trigger localization

> Scope: authorized, defensive on-chain arbitrage research. Node runs bounded-live inside the
> script-enforced envelope (Safety Rule 1): `.deploy-live` marker + signer wallet ≤ 0.2 ETH +
> `SEARCHER_EV_GATE=1`; flash-arbs are atomic so principal is never at risk. Broadcast outside the
> envelope stays a human gate. Autonomous round (user away — decide + proceed per rules 14/15).

```yaml
cycle_id: R17-20260704
date: 2026-07-04
orchestrator: Fable 5 (autonomous hermes scheduled run)
type: live-run measurement + validation (R16 filter before/after) — no new fix shipped this round
cu_budget: 1000 (per-fire cap)
cu_spent: ~0 (all analysis on local reth; no Alchemy)
codex: n/a (no code cycle this round)
searcher_behavior_change: no (measurement/validation round after R16 shipped a change)
hermes_gate: PASS
```

## Step 0.5 — bounded-live safety valve
- Signer `0xb8578B6…DA3c` = **0.002704 ETH** = baseline (`/opt/MEV/.live-start-balance-eth`). Unchanged
  (no live submission fired). ≥ 50% → **no circuit-break.** `.deploy-live` present, bounded-LIVE.

## Deploy — intentionally NOT redeployed
- Node was already on `d53cdac` (R16 fix; the searcher filter code) with the searcher up ~34 min
  running `victimSourceFilter enabled=on`. `origin/main` `e42e9fb` is **doc-only** (R16 round doc), no
  searcher code change. **Redeploy was intentionally skipped:** a restart resets the in-memory
  `VictimSourceTracker` learned state + starts a new run_id, discarding exactly the accrued outcome
  data + the before/after window this round measures. Measured the current continuous run instead.

## Window facts
- run_id `47e8be66-d0aa-451c-984e-b52a47d030ca`, blocks **25453957 → 25454128** (~171 blocks, ~34 min),
  the searcher's continuous run since the R16 deploy (filter live the whole window).

## PRIMARY goal — victim-source filter live before/after (carried from R16)
| metric | R17 | R15 (pre-filter) |
|---|---|---|
| opportunity_seen | 172 | 264 |
| bundle_submitted | **0** | 14 |
| submitted-victim reverted on-chain | 0 (n=0) | **14 / 14** |
| `victim_source_low_landrate` fired | **0** | (filter not deployed) |
| simulation_result ok:true | 2 | 16 |

**Reading (honest):** the filter is deployed + enabled but **fired 0 times this window — and that is
CORRECT, not a bug.** The R15 serial-reverting senders were essentially absent: nonce deltas this
window were `0x295fc34f=1, 0x8ca0a5d1=1, 0x95ef63fe=1, 0x0dcfbef3=0` — **≤1 tx each**, so a ≥3
in-window revert streak is not even possible → the filter has nothing to skip. (The rule-12 test
`searcher:victim-source-filter` already proves the logic fires when a streak exists; the R15 burst was
episodic, not persistent.) `bundle_submitted=0` gives 0 phantom submits vs R15's 14/14, but that drop
is **flow-confounded** (the reverting-sender burst did not recur; flow was thin — only 2 sims), NOT
attributable to the filter. **Before/after remains inconclusive; carried to a window where a serial-
reverting sender is active** (`carry_to R18`).

## Auto analysis — funnel
`no_candidate_plans` is again the dominant drop: **107/170 = 63%** (candidate-cap 27, expired-before-solver
23, no-profitable-quote 7, quote-timeout 4, below_ev_gate 2). This is the single-pool-token
return-venue gap (`impact_token_return_venues_excluding_impact_pool=0`) = the **pool-scoring
arb-relevance EPIC** ([[project-pool-scoring-arb-relevance-epic]]). No `0x6190b2b0` v4 hook-poison
(R14 filter holding).

## Step-1 competitor cross-reference (mandatory; local reth, zero-CU)
```step1
run_id: 47e8be66-d0aa-451c-984e-b52a47d030ca
window_blocks: 25453957..25454128
watchlist: 0xc0ffeebabe5d496b2dde509f9fa189c25cf29671,0xae2fc483527b8ef99eb5d9b44875f005ba1fae13
artifact: docs/research/reports/step1-R17-20260704.json
method: manual-onchain-trace
```
- **coffeebabe: 1 tx** (`0xb713739f`, status 0x1) — a single atomic arb through an in-graph pool
  (`0xcfa70c6e…`, inGraph=true). Dust-class, atomic market ceiling. Not overlapping our funnel.
- **ae2Fc483: 38 txs** (all status 0x1) — sandwich/inventory, out of our atomic posture; sampled legs
  route the in-graph v4 singleton.
- **Coverage KPI:** 3 competitor legs, **0 out-of-graph.** **closable = 0.** No coverage gap.

## Rule-13 architecture-review trigger — ARMED; localization recorded (not a redundant re-run)
Trigger = ≥2 consecutive rounds with NO growth in a genuine (non-dust, landable) +EV `simSuccess`.
R15 = 14 phantom submits (0 landable); R16 = impl-cycle (no window); R17 = 2 sims / 0 submissions
(0 landable). Genuine landable +EV has stayed **0 across R15→R17 → the trigger is ARMED.**

Per rule 14 (autonomous) the arch-review's job — localize the distance-to-production lever in a fresh
dual-blind context — was **already performed in R15** (fable A + Codex B + the on-chain mechanism trace)
and is re-confirmed by R17's data. Re-running a full dual-blind arch-review would re-derive the same
two levers, so it is recorded here rather than repeated:
- **Lever A — funnel / pool-scoring (searcher-side, PURSUABLE autonomously):** `no_candidate_plans` 63%
  is the single largest funnel drop, and it is a REAL EXISTING-flow lever — closing the single-pool-token
  return-venue gap could route detected opps into closed loops and produce genuine landable +EV WITHOUT
  a posture change. This is the **pool-scoring arb-relevance EPIC**; **R18 should advance its first
  slice** (design + a rule-12-gateable slice), and per rule 13 no per-pool pins.
- **Lever B — `no-replicable-atomic-EV` / posture (HUMAN GATE):** on public flow our atomic-backrun
  posture has a dust/zero landable ceiling (coffeebabe = dust; contended swaps revert). The
  production-scale lever is the **posture decision** (private orderflow / a different strategy class),
  which is a human gate ([[project-atomic-backrun-market-ceiling]]). **Flagged for the human.**

Point-fixing on the atomic +EV theme PAUSES in favor of Lever A (pool-scoring epic) per rule 13.

## Findings Ledger
| finding | owner | carry_to | status |
|---|---|---|---|
| Victim-source filter live before/after — INCONCLUSIVE (filter correct-quiet: R15 senders ≤1 tx each, no streak; 0 phantom submits but flow-confounded) | R16→R18 | R18 | open — measure in a window with an active serial-reverting sender; the filter itself is validated (rule-12 flip + correct live quiet) ([[project-phantom-victim-flow-admission-epic]]) |
| **Pool-scoring arb-relevance EPIC — no_candidate_plans 63% (the localized searcher-side lever)** | pool-scoring epic | R18 | **open — R18 advances slice-1** (design + rule-12-gateable slice; no per-pool pins) ([[project-pool-scoring-arb-relevance-epic]]) |
| Arch-review trigger ARMED (0 landable +EV R15→R17) — localization = Lever A (pool-scoring, pursue) + Lever B (posture, human gate) | R17 | — | recorded — Lever B flagged for human; Lever A → pool-scoring epic |
| Atomic-backrun market ceiling → posture decision | posture (human gate) | when human decides | open — the production-scale lever; **human gate** ([[project-atomic-backrun-market-ceiling]]) |
| Thin hookless v4 `NotEnoughLiquidity` residual | R14→R18 | R18 | open — measure-first; no `0x6190b2b0` this window |
| R10 v4 production backfill (systemd `v4-backfill-r14`) | R10→R18 | R18 | open — hookless subset only |

## Verdict + close
- **verdict:** measurement + validation round. R16's victim-source filter is **deployed, enabled, and
  validated correct-quiet** (rule-12 flip earlier + live: 0 fires because the R15 serial-reverting
  senders sent ≤1 tx each, no streak possible); the phantom-submit before/after is **inconclusive/
  flow-confounded** and carried to a qualifying window. Dominant funnel drop reverts to
  `no_candidate_plans` 63% = the pool-scoring epic. Competitor cross-ref: coffeebabe 1 dust arb,
  ae2Fc483 38 out-of-posture, **closable=0.** The **rule-13 arch-review trigger is ARMED** (0 landable
  +EV R15→R17); localization recorded — **Lever A = pool-scoring epic (R18 advances slice-1), Lever B =
  posture (human gate, flagged).**
- **searcher_behavior_change:** no (valid measurement round after R16 shipped a change; **R18 MUST ship**
  — the pool-scoring epic slice-1 — per rule-13 anti-drift, no third consecutive non-shipping round).
- **hermes_gate:** PASS.
- **carry:** filter before/after (R18, qualifying window), pool-scoring epic slice-1 (R18, MUST ship),
  posture decision (human gate).
