# Hermes Live-Run Round R19-20260704 — pool-scoring slice-1 live before/after (measured)

> Scope: authorized, defensive on-chain arbitrage research. Node runs bounded-live inside the
> script-enforced envelope (Safety Rule 1): `.deploy-live` marker + signer wallet ≤ 0.2 ETH +
> `SEARCHER_EV_GATE=1`; flash-arbs are atomic so principal is never at risk. Broadcast outside the
> envelope stays a human gate. Autonomous round (user away — decide + proceed per rules 14/15).

```yaml
cycle_id: R19-20260704
date: 2026-07-04
orchestrator: Fable 5 (autonomous hermes scheduled run)
type: live-run measurement — R18 pool-scoring slice-1 live before/after (no new fix shipped this round)
cu_budget: 1000 (per-fire cap)
cu_spent: ~0 (all analysis on local reth over SSM; no Alchemy)
codex: n/a (measurement round; R18 shipped slice-1, R19 measures it, R20 ships slice-2)
searcher_behavior_change: no (valid measurement round after R18 shipped a change — one obs round; R20 MUST ship slice-2)
hermes_gate: PASS
```

## Step 0.5 — bounded-live safety valve
- Signer `0xb8578B6…DA3c` = **0.002704 ETH** = baseline (`/opt/MEV/.live-start-balance-eth`). Unchanged
  (only 1 dust bundle submitted, not included, no on-chain spend). ≥ 50% → **no circuit-break.**
  `.deploy-live` present; node preserved bounded-LIVE.

## Deploy — intentionally NOT redeployed (measure the R18 slice-1 window)
- Node HEAD = `91972af` (R18 pool-scoring slice-1 code); `origin/main` = `d88bd06` is **doc-only**
  (R18 round doc, `git diff 91972af..d88bd06` = 1 md file). A redeploy would restart, **reset the freshly
  re-indexed arb-relevance universe + start a new run_id**, discarding exactly the slice-1 before/after
  this round measures (same reasoning as R17). Measured the continuous R18-deployed run instead.
- Mode preserved bounded-LIVE (verified via `/proc/<pid>/environ` + reth): `SEARCHER_DRY_RUN=0`,
  `SEARCHER_EV_GATE=1`, `.deploy-live` present, `SEARCHER_EVENTS_PATH=/var/log/mev/events/searcher-live.jsonl`.

## Window facts
- run_id `aea4dccf-e1b1-4a86-8d50-77f2739cdac6`, blocks **25454401 → 25454585** (~184 blocks, ~37 min),
  the searcher's continuous run on the R18 slice-1 code + re-indexed arb-relevance universe.

## PRIMARY — pool-scoring slice-1 live before/after (R18→R19 carry)
| funnel metric | R19 (slice-1 live) | R17 (pre-slice-1 baseline) |
|---|---|---|
| opportunity_seen | 186 | 172 |
| **no_candidate_plans** | **86 / 186 = 46%** | **107 / 170 = 63%** |
| candidate-cap | **41** | 27 |
| expired-before-solver | **28** | 23 |
| no-profitable-quote | 14 | 7 |
| below_ev_gate | 9 | 2 |
| quote-timeout | 8 | 4 |
| simulation_result ok:true | 10 | 2 |
| bundle_submitted | 1 (dust, not included) | 0 |

**Reading (honest):** `no_candidate_plans` fell **63% → 46%** on the slice-1 code, and the drop is
corroborated by a **composition shift**, not just flow noise: as `no_candidate` fell (107→86),
`candidate-cap` rose (27→41) and `expired-before-solver` rose (23→28). That is the mechanistic signature
of slice-1 working — more detected opps now clear the return-venue gap into candidate-generation, then
bottleneck **downstream** at the candidate cap / solver latency. `simulation_result ok` also rose 2→10.
**Caveat:** different window/flow than R17, so the magnitude is not exact (flow-confounded); the
**direction + composition shift** are the reliable signal. Slice-1 is validated as directionally
effective. The **new emerging bottleneck is candidate-cap (41) + expired-before-solver (28)** — carried
to R20.

**Residual `no_candidate` (the 46% that remains) is LONG-TAIL impact tokens**, not stables: the
diagnostics show impact tokens `0xF515A333…`, `0xCD0767E2…` with
`impact_token_return_venues_excluding_impact_pool = 0` (classification `only_immediate_same_pool_reverse`).
Slice-1's binary loop-completer partition + raw-count ranking still buries the impact-token-specific 2nd
venue for the long tail → **slice-2 (impact-token-specific loop-completion weighting, degree-weighted, not
binary) is justified for R20** (R18 ledger: slice-2 "only if slice-1 proves too coarse in R19 metrics" —
the long-tail residual proves it).

## Step-1 competitor cross-reference (mandatory; local reth, zero-CU)
```step1
run_id: aea4dccf-e1b1-4a86-8d50-77f2739cdac6
window_blocks: 25454401..25454585
watchlist: 0xc0ffeebabe5d496b2dde509f9fa189c25cf29671,0xae2fc483527b8ef99eb5d9b44875f005ba1fae13
artifact: docs/research/reports/step1-R19-20260704.json
method: manual-onchain-trace
```
- **coffeebabe: 3 txs** (`0x89165cd6`, `0x33e4e9bc`, `0xea818826`, all status 0x1, all to the original-bot
  contract `0xe08d97…`). Every tx hand-decoded: all are **Balancer-flash-funded atomic loops** — Balancer
  Vault `0xba12222…` confirmed **FlashLoan-source-only** (topic `0x0d7d75e0`), **NOT a swap venue**. Swaps
  route mostly **in-graph** UniV3 (`0x48da0965` DAI/USDT, `0x60594a405` DAI/WETH) + `0x014410b9` (WETH/USDT,
  in-graph), plus a few **out-of-graph redundant** venues: `0x1bc6104b` (WETH/USDT UniV2 — **IN pool-universe
  but not ranked into the graph**), `0x2e8b0ba0` (native-ETH/USDT, not in universe), `0x8474ddbe` (Curve
  stable, not in universe). Dust fees (~$0.11–0.33 total gas each) = the **atomic-backrun dust ceiling**
  ([[project-atomic-backrun-market-ceiling]]). The out-of-graph pools are **low-vol/redundant** — WETH↔USDT
  and stable connectivity already exist in-graph via higher-volume venues → **not a needle-moving coverage
  gap**. And they are STABLES, not the long-tail impact tokens driving our `no_candidate`, so they do not
  redirect the pool-scoring lever.
- **ae2Fc483: 69 txs** (all status 0x1, all to router `0x1f2f10d1…`) — sandwich/inventory, **out of our
  atomic posture**; sampled legs route the in-graph v4 singleton `0x0000…8a90`.
- **Coverage KPI:** 10 competitor legs, **3 out-of-graph, closable = 0** (all 3 = dust-ceiling redundant
  venues). No coverage gap to close this window; the searcher-side lever remains the pool-scoring epic.

## Rule-13 arch-review trigger — remains ARMED; localized lever actively pursued (no re-run)
Trigger = ≥2 consecutive rounds with NO growth in a genuine non-dust landable +EV `simSuccess`. R19 had
1 submit but it was **dust** (`$0.33`, not included) → still 0 non-dust landable across R15→R19 → the
trigger stays **ARMED.** Per R17's recorded disposition (rule 14): the arch-review's OUTPUT — localize the
distance-to-production lever — was performed in R15 (fable A + Codex B, dual-blind) and re-confirmed;
**Lever A = pool-scoring epic** is being **actively pursued with measured progress** this round
(`no_candidate` 63%→46%), and **Lever B = posture (human gate)** is flagged. Re-running a full dual-blind
arch-review would re-derive the same two levers, so it is not repeated — the localized lever is executing,
not stalled. (If R20's slice-2 does NOT move the funnel toward a genuine non-dust +EV simSuccess, re-run
the full dual-blind arch-review then.)

## Findings Ledger (carry)
| finding | owner | carry_to | status |
|---|---|---|---|
| **Pool-scoring slice-1 live before/after** | R19 | — | **VALIDATED directionally**: `no_candidate` 63%→46% + composition shift (candidate-cap 27→41, expired 23→28, sims 2→10) = slice-1 routing opps past the return-venue gap into candidate-gen. Flow-confounded magnitude caveat; direction reliable ([[project-pool-scoring-arb-relevance-epic]]) |
| **Pool-scoring slice-2** — impact-token-specific loop-completion weighting (degree-weighted, not binary count-rank) for the LONG-TAIL residual | pool-scoring epic | **R20 (MUST ship — rule-13 anti-drift; R19 was the one obs round)** | open — R19 metrics prove slice-1's binary partition is too coarse for long-tail impact tokens (return_venues_excluding_impact_pool=0 on 0xF515A333/0xCD0767E2) |
| **NEW downstream bottleneck** — candidate-cap (41) + expired-before-solver (28) rose as no_candidate fell; the funnel bottleneck is shifting from "can't build a loop" to "built loops, cap/latency-limited" | R19 | R20 | open — measure-first; may need candidate-cap tuning or latency once slice-2 lands |
| Victim-source filter live before/after (needs a window with an active serial-reverting sender) | R16→R20 | R20 | open — filter validated (rule-12 + correct live quiet); qualifying window still pending; 0 fires this window ([[project-phantom-victim-flow-admission-epic]]) |
| Atomic-backrun market ceiling → posture decision | posture (human gate) | when human decides | open — production-scale lever; **human gate**; R19 coffeebabe reconfirms dust ceiling ([[project-atomic-backrun-market-ceiling]]) |
| Thin hookless v4 `NotEnoughLiquidity` residual | R14→R20 | R20 | open — no `0x6190b2b0` hook-poison this window (R14 filter holding) |
| R10 v4 production backfill (systemd `v4-backfill-r14`) | R10→R20 | R20 | open — hookless subset only |

## Verdict + close
- **verdict:** measurement round. **R18's pool-scoring arb-relevance slice-1 is live and directionally
  validated** — `no_candidate_plans` fell **63% → 46%** with a corroborating composition shift
  (candidate-cap ↑, expired ↑, sims 2→10), the mechanistic signature of opps clearing the return-venue gap
  into candidate-generation. Magnitude is flow-confounded (different window); direction is reliable.
  Competitor cross-ref: coffeebabe = 3 Balancer-flash-funded dust atomic loops (out-of-graph venues are
  low-vol/redundant, **closable = 0**), ae2Fc483 = 69 out-of-posture sandwich/inventory. The **arch-review
  trigger stays ARMED** (R19's 1 submit was dust, not included) but the localized Lever A (pool-scoring
  epic) is **actively pursued with measured progress**, so no re-run. The residual `no_candidate` is
  **long-tail impact tokens**, proving slice-1's binary partition is too coarse → **slice-2 justified.**
- **searcher_behavior_change:** no (valid measurement round after R18 shipped; **R20 MUST ship slice-2** —
  rule-13 anti-drift, no second consecutive obs round).
- **hermes_gate:** PASS.
- **carry:** slice-2 (R20, MUST ship — impact-token-specific weighting for the long-tail), NEW downstream
  candidate-cap/latency bottleneck (R20, measure-first), victim-source filter before/after (R20, qualifying
  window), posture decision (human gate).
