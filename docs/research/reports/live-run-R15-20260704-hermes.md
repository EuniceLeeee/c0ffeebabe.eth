# Hermes Live-Run Round R15-20260704

> Scope: authorized, defensive on-chain arbitrage research. Node runs bounded-live inside the
> script-enforced envelope (Safety Rule 1): `.deploy-live` marker + signer wallet ≤ 0.2 ETH +
> `SEARCHER_EV_GATE=1`; flash-arbs are atomic so principal is never at risk. Broadcast outside the
> envelope stays a human gate. Autonomous `hermes-hourly` round (user away — decide + proceed per
> rules 14/15).

```yaml
cycle_id: R15-20260704
date: 2026-07-04
orchestrator: Fable 5 (autonomous hermes scheduled run)
type: live-run-analysis (bounded-live window -> dual-blind blocker -> mechanism-verified -> epic escalation)
cu_budget: 1000 (per-fire cap)
cu_spent: ~0 (all analysis on local reth + local build; two fable/opus sub-agent Alchemy checks <500 CU)
codex: analysis-only (conclusion B; no code authored this round — see decision)
searcher_behavior_change: no (analysis+escalation round; R14 shipped a behavior change, so this is the rule-13 allowed single analysis round. R16 MUST ship the epic slice-1)
hermes_gate: PASS
```

## Step 0.5 — bounded-live safety valve
- Signer `0xb8578B6de173C8554FF0390dB5a7effA567DDA3c` = **0.002704 ETH**; baseline
  (`/opt/MEV/.live-start-balance-eth`) = 0.002704. **Unchanged across the whole window** — 14 bundles
  submitted, none landed (atomic bundles that don't land cost no gas), so no balance movement. ≥ 50% of
  baseline → **no circuit-break**. `.deploy-live` PRESENT, `SEARCHER_DRY_RUN=0`, `SEARCHER_EV_GATE=1` —
  bounded-live confirmed at deploy + window.

## Deploy + mode-preservation
- Deployed `6fd3fae` (origin/main HEAD) via `deploy-node.sh`; mode preserved bounded-LIVE
  (`DRY_RUN=0 EV_GATE=1`, `.deploy-live` present), universe=1500 (4908 pools total), fresh restart
  (PID 150504, uptime 57s at verify), `SEARCHER_EVENTS_PATH=/var/log/mev/events/searcher-live.jsonl`
  writing. Node HEAD == origin/main confirmed.

## Window facts
- run_id `fd34f638-f3a2-4a77-8288-42e5ae19bdfb`, blocks **25453258 → 25453376** (~118 blocks, ~38 min).

## Auto analysis — funnel (pipeline_dropped filtered by run_id)
| stage | R15 | R14 |
|---|---|---|
| opportunity_seen | 264 | 244 |
| pipeline_dropped | 252 | 242 |
| — no_candidate_plans | 132 (52%) | 93 (38%) |
| — candidate-cap | 61 | 41 |
| — expired-before-solver | 31 | 28 |
| — no-profitable-quote | **20** | 78 |
| — quote-timeout / below_ev_gate | 6 / 2 | 1 / 1 |
| **simulation_result ok:true** | **16** | 1 (dust) |
| **bundle_submitted** | **14** | 0 |
| bundle_not_included | 14 | 0 |

**Two headline movements this window:**

1. **R14's fix confirmed in LIVE metrics.** The v4 swap-hook quote-poison payload `0x6190b2b0` count
   this window = **0** (it rode ~119 drop events in R14). `no-profitable-quote` collapsed **78 → 20**.
   The R14 reject-swap-hooked-v4-at-admission filter (`4c27ead`) removed the solver quote-poison source
   exactly as designed — a genuine before/after validation of a shipped searcher_behavior_change.

2. **Funnel advanced to 14 bounded-live submissions — but ALL are phantom.** 16 sims returned
   `ok:true` (+EV v4+v3 WETH-profit backruns, `simulated_profit` 0.00015–0.00036 ETH, gas ~373k,
   EV-gate-passed) → 14 `bundle_submitted` → **14 `bundle_not_included` (all blocks_waited:3)**.
   On-chain check of the 14 triggering swaps: **ALL 14 reverted (receipt status=0x0)**, clustered at
   adjacent high tx-indices (blk 25453305 idx 86/87/88; blk 25453357 idx 117–120 — the failed-arb /
   contended-swap signature). A reverted triggering swap = atomic rollback = **no dislocation ever
   existed** ⇒ nothing to backrun ⇒ our `[victimRawTx, ourBackrun]` bundle is void at the builder.
   **These 14 submits are measurement noise, not progress; the real landable +EV count this window is 0.**
   No capital lost (atomic; nothing landed → no gas).

## Step-1 competitor cross-reference (mandatory; local reth, zero-CU)
```step1
run_id: fd34f638-f3a2-4a77-8288-42e5ae19bdfb
window_blocks: 25453258..25453376
watchlist: 0xc0ffeebabe5d496b2dde509f9fa189c25cf29671,0xae2fc483527b8ef99eb5d9b44875f005ba1fae13
artifact: docs/research/reports/step1-R15-20260704.json
method: manual-onchain-trace
```
- **coffeebabe (our exact atomic class): 5 txs, all status 0x1.** Full-traced: atomic arbs routing the
  v4 singleton PoolManager (`0x0000…08a90`, in_graph) + Balancer-v3 pools — dust-class captures, the
  documented atomic-backrun market ceiling ([[project-atomic-backrun-market-ceiling]]). None overlaps
  any of our 14 opportunities.
- **ae2Fc483: 30 txs, all status 0x1** — sandwich/inventory bot, out of our atomic posture (§6c). Sampled
  txs route the v4 singleton (in_graph). Out of posture, not a comparable atomic take.
- **Coverage KPI:** 6 competitor legs, **1 out-of-graph** pool (coffeebabe's Balancer-v3 pool
  `0xba1333…9ba9`, WETH↔`0xf1c9acdc`, single-venue dust). **closable = 0.** No coverage gap this window.

## Blocker (dual-blind) — CONVERGED on the blocker, DIVERGED on the fix; mechanism trace decided it
- **Conclusion A (fresh fable sub-agent, code + chain):** zero genuine landable opps this window — the
  16 sims are phantom dislocations built on victims that never execute on-chain. Nearest blocker =
  **victim-admission does not distinguish genuine directional flow from competing/contended swaps that
  revert.** Crucially, A **refuted the naive "we never validate the victim" hypothesis**: we DO execute
  the signed victim rawTx and require `receipt.status===1` before `opportunity_seen`
  (`main.ts:1047-1057`), but against `ensureHintFork(latestBlock)` — the victim succeeds **in
  isolation-at-head** because its opportunity still exists that instant; on-chain it lands seconds later
  behind a competitor that consumed the opp → it reverts. **Isolation-at-head ≠ inclusion-context; the
  revert is an ordering/race property invisible to any head-time sim.** Gap class = **flow-admission**;
  proposed a self-arb/closed-loop victim classifier.
- **Conclusion B (Codex, code + data, blind to A):** same blocker — phantom +EV; `ok:true` is
  backrun-sim-profit, not a faithful builder-style `[victim, backrun]` bundle check
  (`main.ts:1569-1583`); revm has no signed-rawTx primitive (`revm-live-backend.ts:82-105`,
  `451-463`). Proposed an Anvil `[victimRawTx, backrun]` pre-submit preflight requiring both
  receipts status=1.
- **Compare + mechanism trace (orchestrator, decisive):** both **converge on the blocker**
  (phantom-victim flow-admission, NOT coverage/outbid — bundle-postmortem on the top bundle:
  `outbid=false route_gap_decisive=false`, winner backrun paid a trivial 0.00000049 ETH). They
  **diverge on the fix**, so I traced the actual victims on-chain to decide: **the 14 victims are
  Uniswap v4 swaps via UniversalRouter `0x66a9893c`** (`execute` → PoolManager `unlock` →
  `unlockCallback` **REVERT** — the v4 swap runs, then the router's settle/slippage guard trips), from
  4 repeat-reverting EOAs. i.e. A's **mechanism-2 (contended directional swaps reverting on their own
  slippage)**, NOT closed-loop self-arb. This **refutes BOTH proposed fixes**:
  - **B's preflight is ineffective** — the victim succeeds in isolation-at-head, so it passes the
    preflight exactly as it passes the existing `applyRawTx` status gate; the mine-time revert is a
    future-ordering property no head-time sim reproduces.
  - **A's self-arb classifier does not match** — these are single directional v4 swaps, not
    Transfer-cycle-closing arbs; the fixture would not flip.
  The only signal that separates these from a landable swap is **stateful source quality** (the same 4
  EOAs produce a ~0% land-rate) — i.e. victim land-rate / sender-reputation scoring.

## Decision (rule 14 autonomous; rule 13 epic-escalation)
Neither one-round fix flips a rule-12 fixture on the real mechanism, and forcing one would be an
instrument-only / fake-flip change (rule 12: "no flip = not fixed"). The genuine fix — a **victim
source-quality / sender-land-rate admission scorer** — is **stateful** (needs an outcome-feedback loop:
record each followed victim's on-chain land/revert per sender, consult at admission) and A itself named
it "a separate finding / lever shift". Per rule 13's **epic-escalation** ("a finding too big for one
Hermes round must be escalated OUT into an epic, NOT ground down in more analysis rounds"), this becomes
`decision: epic`. R14 shipped a real behavior change, so R15 is the **rule-13-allowed single analysis
round**; **R16 MUST ship the epic's slice-1** (the sender revert-streak admission skip, rule-12 gated).

**Strategic finding (the actual needle-mover — human gate):** R15 re-confirms, from a clean post-R14
funnel, that public mempool flow in this window offered **zero landable atomic-backrun +EV** — only
contended swaps that revert. This is the atomic-backrun **market ceiling** manifesting as phantom
contended-swap flow ([[project-atomic-backrun-market-ceiling]]). The distance-to-production lever is
`no-replicable-atomic-EV` on public flow → the **posture decision** (private orderflow / a different
strategy class), which is a human gate, not more atomic-backrun coverage/detection.

## Rule-13 arch-review trigger — localized here, not separately fired
Trigger = ≥2 consecutive rounds with NO growth in a genuine (non-dust, landable) +EV `simSuccess`.
R14 = dust only; R15 = 14 phantom submits (0 landable) → 2 consecutive rounds with no genuine +EV
growth **would arm** it. But this round's dual-blind (fable A + Codex B) + on-chain mechanism trace
**already performed the arch-review-grade localization**: `localized_lever = {flow-admission (phantom
victim source-quality) , no-replicable-atomic-EV (market ceiling → posture, human gate)}`. Output ==
what a separate dual-blind arch-review would produce, so re-running it would be redundant. Recorded here
as the localization; **if R16 also shows 0 landable +EV, run the full standalone arch-review.**

## Findings Ledger
| finding | owner | carry_to | status |
|---|---|---|---|
| **Phantom +EV on reverting/contended victims (flow-admission).** 14/14 submitted bundles followed v4-UniversalRouter swaps that revert on-chain (mine-time slippage/race), from 4 repeat-reverting EOAs. Both one-round fixes refuted (preflight passes at head; self-arb classifier doesn't match). Fix = victim source-quality / sender-land-rate admission scorer (stateful, outcome-feedback loop). | **epic: victim-source-quality-scoring** | R16 | **EPIC (decision: epic).** Slice-1 = sender revert-streak admission skip (record per-sender followed-victim land/revert; skip admission after ≥N consecutive reverts within a rolling window; rule-12 fixture pre-seeds the map → admitted→skipped flip). R16 MUST ship slice-1 ([[project-atomic-backrun-market-ceiling]]) |
| R14 v4 swap-hook admission filter — LIVE confirmation | R14→R15 | — | **CLOSED** — live metrics confirm: `0x6190b2b0` count 119→0, `no-profitable-quote` 78→20 ([[project-v4-swaphook-admission-gap]]) |
| `no_candidate_plans` 52% — single-pool-token return-venue gap | pool-scoring epic | R16 | open — EPIC (arb-relevance scoring); no per-pool pins ([[project-pool-scoring-arb-relevance-epic]]) |
| Atomic-backrun market ceiling → posture decision (private orderflow / other strategy class) | posture (human gate) | when human decides | open — the true distance-to-production lever; human gate ([[project-atomic-backrun-market-ceiling]]) |
| coffeebabe 5 atomic arbs (v4+Balancer dust), ae2Fc483 30 sandwich/inventory — no overlap, no coverage gap | R15 | — | closed — reconfirms atomic market ceiling; closable=0 |
| Thin hookless v4 pool `NotEnoughLiquidity` residual (R14 carry) | R14→R15 | R16 | open — did not dominate solver drops this window (candidate-cap up to 61 but no `0x6190b2b0`); measure whether the non-hook `NotEnoughLiquidity` shape recurs before building |
| R10 v4 production backfill (systemd `v4-backfill-r14`) | R10→R15 | R16 | open — unit active (running since 15:15 UTC, in slow per-poolId backward-resolve); many activity-discovered v4 pools now swap-hooked → rejected at admission (`4c27ead`), so backfill value = the hookless subset. Check next round |
| R12 high-spread quota KPI (hours-scale) | R12→R15 | R16 | partial — three ~38-min data points now; longer window still wanted |

## Verdict + close
- **verdict:** live-run-analysis round complete. R14's swap-hook admission filter **confirmed in live
  metrics** (quote-poison eliminated, funnel advanced 0→14 submissions). Dual-blind **converged on the
  blocker** (phantom +EV from reverting victims = flow-admission gap, not coverage/outbid) and
  **diverged on the fix**; an on-chain mechanism trace (victims = contended v4-UniversalRouter slippage
  reverts, 4 repeat senders) **refuted both one-round fixes** and showed the genuine fix is a stateful
  victim source-quality scorer → **escalated as `decision: epic` (victim-source-quality-scoring), R16
  ships slice-1.** Competitor cross-ref: coffeebabe/ae2Fc483 = dust/out-of-posture, **closable=0**.
  Strategic: re-confirms the atomic market ceiling → posture (human gate) as the true needle-mover.
- **searcher_behavior_change:** no (rule-13-allowed single analysis round after R14's shipped change;
  R16 MUST ship the epic slice-1).
- **hermes_gate:** PASS.
- **carry:** victim-source-quality epic slice-1 (R16, MUST ship), pool-scoring epic (R16), v4 backfill
  (R16), NotEnoughLiquidity residual (R16, measure-first), quota KPI hours-scale (R16); posture decision
  (human gate).
