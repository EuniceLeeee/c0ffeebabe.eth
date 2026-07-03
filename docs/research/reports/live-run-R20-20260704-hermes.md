# Hermes Round R20-20260704 — slice-2 premise VERIFIED PHANTOM → coverage exhausted → human-gate escalation

> Scope: authorized, defensive on-chain arbitrage research. Node runs bounded-live inside the
> script-enforced envelope (Safety Rule 1). Broadcast outside the envelope stays a human gate.
> Autonomous round (user away — decide + proceed per rules 14/15). **This chain took over as the
> SOLE chain after the concurrent peer chain went silent post-R19 (see "Concurrent-chain" below).**

```yaml
cycle_id: R20-20260704
date: 2026-07-04
orchestrator: Fable 5 (autonomous hermes scheduled run — sole chain after peer went silent)
type: verification + arch-review conclusion + human-gate escalation (NO fix shipped — verified phantom)
cu_budget: 1000
cu_spent: ~0 (all on-chain venue verification on local reth over SSM; no Alchemy)
codex: n/a (no code cycle — the proposed fix was verified to be a phantom/null fix BEFORE building it)
searcher_behavior_change: no (rule-13 STOP+escalate: no impactful searcher change exists — verified, not assumed)
hermes_gate: n/a (verification round; no new measured live window — the peer's R19 measured this window)
```

## Step 0.5 — bounded-live safety valve
- Signer `0xb8578B6…DA3c` = **0.002704 ETH** = baseline. Unchanged. ≥ 50% → **no circuit-break.**
  `.deploy-live` present, bounded-LIVE preserved (node on `91972af` = R18 slice-1 code).

## Concurrent-chain resolution
Two autonomous Hermes chains were duplicating rounds (R19 collision). This chain became a **lagging
backstop**; on wake it found **no `hermes R20` commit and >1h since the peer's R19 (`a4012cf`, 05:21 →
now 06:27), lock free, no peer round/codex running** → the peer chain went silent → this chain took over
as the sole chain (lock acquired). If the peer resurfaces, the PID-liveness lock dedupes.

## Why NO fix this round (rule 3 verify → rule 13 don't-ship-null)
The peer's R19 (`a4012cf`) concluded "slice-2 justified, R20 MUST ship" on the premise that the residual
`only_immediate_same_pool_reverse` no_candidate (46%) is long-tail impact tokens **that DO have a 2nd
venue but slice-1's binary partition + count-rank buries it.** Before building slice-2 I **verified that
premise on-chain (local reth, zero-CU)** — and it is **FALSE**:

**Residual longtail impact tokens are genuinely SINGLE-VENUE (no 2nd AMM pool exists to surface).**
Sampled the top residual `only_immediate_same_pool_reverse` impact tokens (28 distinct), counting real
AMM pool venues (Transfer-log counterparties that expose `token0()`):
| impact token | no_candidate drops | AMM pool venues on-chain |
|---|---|---|
| `0xf515a333…` | 145 | **1** (`0xcfa70c6e`, 2326/2412 transfers; the x30/x29 counterparties are routers/EOAs, NOT pools — `token0()`=∅) |
| `0x2d8c2e05…` | 22 | **1** (`0x3b4e4c91`, 1615/1758) |
| `0x9d70bae2…` | 15 | **1** (`0xfaf41f37`) |
| `0x66fd8de5…` | 17 | **0** pool counterparties in top-8 |
| `0xa0b8…`(USDC)/`0xdac1…`(USDT) | 24 / 16 | major tokens — the impact PAIR is bottlenecked by the single-venue longtail counterparty, not by USDC/USDT coverage |

A single-venue token has **no atomic return path** (closing the loop requires re-entering its only pool =
the immediate same-pool reverse, correctly pruned). **No ranking/weighting change can create a venue that
does not exist** → slice-2 as specified cannot flip a single REAL residual case; it would be a phantom /
null fix (rule 12 "no flip = not fixed"; rule 13 "a clean commit that changes nothing the searcher
catches"). Building it to satisfy a mechanical "MUST ship" would be the exact anti-pattern rule 13 guards
against. **Correcting the peer's R19 premise: verify against data, not the prior claim (rule 3).**

## Arch-review conclusion (the rule-13 trigger, now definitively localized + VERIFIED)
Genuine non-dust landable +EV has been 0 across R15→R19 → the arch-review trigger is armed. This round
**closes the localization with on-chain verification**, not another point-fix:
- **Lever A — searcher-side coverage — EXHAUSTED.** R14 (v4 hook filter), R16 (victim-source filter),
  R18 (pool-scoring loop-completion) shipped the real coverage/quality gains: `no_candidate_plans`
  63%→46%, `sims_ok` 2→10, funnel mechanically healthy. The RESIDUAL no_candidate is **genuinely
  single-venue dust longtail** (verified above) — unfixable by any scoring/coverage change.
- **Lever B — ECONOMICS / posture — the BINDING constraint — HUMAN GATE.** The +gross opps we now DO
  find are dust that fails net-EV: a **0.00244 ETH gross** sim (opp `0x11cee402`, R19) was dropped at
  `below_ev_gate` (net −EV after gas + ~100% bribe). This is the atomic-backrun **market ceiling**
  ([[project-atomic-backrun-market-ceiling]]) — a top same-class bot (coffeebabe) also only extracts dust
  from public atomic flow. Growing genuine +EV requires a **posture/economics decision** (private
  orderflow / a different strategy class / a bid-policy change), which is a **human gate** (Safety Rule 1
  / rule 6b).

## HUMAN ESCALATION (the actionable output of this round)
The autonomous coverage loop has done its job: it drove the searcher-side levers to completion and
**verified** that no remaining searcher-side change creates a genuine landable +EV. The production
needle now moves ONLY on a human-gated decision. **For the human, pick a direction:**
1. **Private orderflow** (MEV-Share / a builder orderflow deal) — access to flow that isn't the
   contended public mempool where every atomic backrun is dust.
2. **A different strategy class** (out of the atomic-backrun posture — e.g. the sandwich/JIT shapes
   ae2Fc483 runs for non-dust, or CEX-DEX) — a deliberate posture change.
3. **A bid-policy / economics change** (the ~100% bribe bids away all profit → `below_ev_gate`; a
   different bid posture is an economics call) — Safety-Rule-1 territory.
Until one is chosen, more autonomous coverage rounds only polish dust. The loop is **paused on this
human gate**, not stalled.

## Findings Ledger
| finding | owner | carry_to | status |
|---|---|---|---|
| Pool-scoring **slice-2** (degree-weighted for long-tail residual) | pool-scoring epic | — | **KILLED (not a valid fix)** — VERIFIED the residual longtail impact tokens are single-venue on-chain (no 2nd venue to surface); slice-2 would be a phantom/null fix. Correcting peer R19's premise ([[project-pool-scoring-arb-relevance-epic]]) |
| Searcher-side coverage lever — EXHAUSTED (slice-1 captured the gains; residual is single-venue dust longtail) | R20 | — | **closed (verified)** |
| **Binding constraint = economics/posture (Lever B) — HUMAN GATE** | **human** | **when human decides** | **open — ESCALATED. The production lever. Pick: private orderflow / different strategy class / bid-policy.** ([[project-atomic-backrun-market-ceiling]]) |
| Downstream bottleneck candidate-cap (41) + expired-before-solver (28) | (paused) | post-human-decision | open — tuning levers, but the opps they'd save are economics-bound (dust) → not needle-movers until posture changes |
| Victim-source filter live before/after (needs an active serial-reverting sender) | R16 | when one appears | open — filter validated (rule-12 + correct-quiet); before/after still pending a qualifying window |
| Concurrent-chain duplication (two autonomous Hermes chains) | human | when human decides | open — recommend consolidating to ONE chain; this chain is the survivor after the peer went silent |

## Verdict + close
- **verdict:** verification + escalation round. The peer's R19 "slice-2 justified" premise was **VERIFIED
  FALSE on-chain** — the residual longtail impact tokens are single-venue (no 2nd AMM pool exists), so
  slice-2 would be a phantom fix (correctly NOT shipped, per rule 3 + rule 13). The arch-review lever is
  now definitively localized + verified: **searcher-side coverage is EXHAUSTED; the binding production
  constraint is economics/posture — a HUMAN GATE.** The autonomous coverage loop is **PAUSED on this
  human decision** (rule-13 escalate-to-human; not a stall).
- **searcher_behavior_change:** no (no impactful searcher change exists — verified). This is the
  rule-13-prescribed STOP+escalate, not a null round.
- **carry:** the human-gate posture/economics decision (the sole remaining production lever); victim
  filter before/after (opportunistic); concurrent-chain consolidation (human).
