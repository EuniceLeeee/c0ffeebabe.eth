# Hermes Round R21-20260704 — same-block loss analysis + rule-16 tooling codification (WBTC pricing)

> Scope: authorized, defensive on-chain arbitrage research. Node runs bounded-live inside the
> script-enforced envelope (Safety Rule 1). Broadcast outside the envelope stays a human gate.
> Autonomous round (user away — decide + proceed per rules 14/15).

```yaml
cycle_id: R21-20260704
date: 2026-07-04
orchestrator: Fable 5 (autonomous hermes scheduled run)
type: loss-analysis + rule-16 analysis-tooling codification (no searcher-behavior change — coverage paused on human gate per R20)
cu_budget: 1000
cu_spent: ~1 secondary-source postmortem rerun vs Alchemy (the rule-12 flip gate); all else local reth over SSM, zero-CU
codex: n/a — fully-specified mechanical registry clone of the committed FRAX fix (a97f759); rule-11 mechanical-edit path, gated by a real on-chain postmortem flip (non-author = the chain)
searcher_behavior_change: no (analysis-tooling only; MANDATED by rule 16, NOT a null round — rule 13's null-round bar is about searcher behavior; rule 16 tooling codification is required and blocks cycle-close)
hermes_gate: n/a (verification/tooling round — no NEW measured window; same precedent as R20. The mandatory competitor cross-reference was done as a direct same-block-loss trace + watchlist scan, below)
```

## Step 0.5 — bounded-live safety valve
- Signer `0xb8578B6…DA3c` = **0.002704 ETH** = baseline (`/opt/MEV/.live-start-balance-eth`). Unchanged.
  ≥ 50% → **no circuit-break.** `.deploy-live` present, `SEARCHER_DRY_RUN=0`, `SEARCHER_EV_GATE=1`,
  `SEARCHER_EVENTS_PATH=/var/log/mev/events/searcher-live.jsonl` — bounded-LIVE preserved. Node on
  `91972af` (R18 slice-1 code), searcher uptime ~2.6h (continuous R18/R19/R20 window, run_id `aea4dccf`).

## Deploy — intentionally NOT redeployed (coverage loop paused on the R20 human gate)
R20 escalated to the economics/posture human gate and PAUSED the autonomous coverage loop ("more
autonomous coverage rounds only polish dust"). This round ships an **analysis-tooling** fix with NO
searcher-behavior change, so a searcher restart (which resets the run_id + arb-relevance universe) buys
nothing. Node mode verified preserved via `/proc/<pid>/environ` + local reth (bounded-LIVE, universe≠0).

## What R21 did — analyzed the newest same-block loss, found a tooling blind spot, codified it
Rather than grind another coverage round (R20 forbade that), R21 post-mortemed the latest bundle the
searcher actually submitted-and-lost in the live window, and that analysis exposed a rule-16 tooling gap.

### The loss (bundle-postmortem on the node, local reth, zero-CU)
- Our bundle `0x79759566…` — opp `0x182e6e99`, path `USDC->WBTC->WETH->USDC` (univ4 legs + univ3 close),
  sim gross **0.000174 ETH** (dust), bid 0.000125 ETH, accepted by 3 builders, target block 25454800.
- Triggering swap `0xe3d20633…` landed at block 25454800 idx 12 (status 0x1). **Landed → our one-shot
  bundle is permanently invalid** (nonce consumed + dislocation re-equalized). Non-inclusion is EXPECTED.
- Winner `0x85ddd78c…` (bot `0xa00003b2`, idx 16): atomic loop `USDC->WBTC->USDT->USDC` (univ4 `0x3ea74c`,
  univ3 `0x56534741`, univ4 `0x0fb0e40c` — **ALL `in_graph=true`**), builder_payment **$2.44** via 100%
  coinbase transfer (priority tip 0). `route_gap_decisive=true` (winner payment 0.00139 ETH > our full
  sim gross 0.000174 ETH). Competing candidates idx 13 (`0xf41a2f7c`) + idx 27 also same WBTC/USDT/USDC
  venues — hand-traced on local reth.

### The tooling blind spot (rule 16 — the round's real deliverable)
On the **unpatched** tool the winner classified as `winner_style: unknown` /
`realized_profit_usd: unpriceable(0x2260fac5…)` — because **WBTC (`0x2260fac5…`) was absent from
`TOKEN_META`**, so its delta fell into `unpricedDeltas` (with the wrong fallback decimals 18 vs the real
8), which made `hasAtomicLoopFlow` fail. Exactly the FRAX dead-entry class Fable found (commit `a97f759`).
Consequence: the §6c step-2 comparability filter **could not run** — the tool literally could not tell
whether this loss was a comparable atomic loop (coverage-relevant) or noise.

## Fix + rule-12 gate (deterministic flip — CONFIRMED)
- Added WBTC to `analysis/src/registry/protocols.ts` `TOKEN_META` (decimals 8, rough BTC mark; roughUsd
  only needs to be *defined* for classification, USD figure approximate by contract) and to
  `bundle-postmortem.ts` `INVENTORY_PRICED_TOKENS`. Mechanical clone of the FRAX entry.
- **Gate (reran the PATCHED postmortem vs the live chain on the exact loss tx `0x79759566…`):**

  | field | before (node, unpatched) | after (patched) |
  |---|---|---|
  | `winner_style` | `unknown` | **`atomic_loop`** |
  | `realized_profit_usd` | `unpriceable(0x2260fac5…)` | **priced (−$7.91 rough; builder_payment $2.44 = robust floor)** |
  | `tokenMeta(WBTC)` | `{WBTC?, decimals:18(fallback)}` unpriced | `{WBTC, decimals:8, roughUsd}` priced |

  `expected_transition: winner_style unknown→atomic_loop; realized unpriceable→priced`. `verdict: fixed`.
  Local gates: `tsc --noEmit` clean; noise-filter test **26/26**; `tokenMeta(WBTC)` priced=true decimals=8.

## What the corrected classifier tells us (reconfirms R20 — NOT a new coverage gap)
With WBTC priced, the loss now classifies correctly: a **comparable `atomic_loop`**, `route_gap_decisive`
true, but **every winner venue is `in_graph=true`** → auto-close would close 0 (no `in_graph=false`
venue). Comparable winner + auto-close=0 + we lost = the §6b "same-pool under-extraction /
sim-undervaluation" class — the winner extracted **dust** and paid **~97%+ to the builder** (the
atomic-backrun market ceiling, [[project-atomic-backrun-market-ceiling]]). This is **economics/posture,
not coverage** → the **R20 human gate**, reconfirmed on a fresh, now-correctly-classified sample.

## Step-1 competitor cross-reference (mandatory; local reth, zero-CU)
- **Direct same-block loss trace** (above): our submitted bundle vs the winner atomic loop + 2 competing
  candidates, hand-traced on local reth, winner flip verified vs Alchemy (secondary source).
- **Watchlist scan** over blocks 25455115..25455235 (node): **coffeebabe `0xc0ffee…` = 0 txs** (our
  comparable atomic class is quiet), **`0xae2Fc483…` = 36 txs** (active, but non-comparable sandwich/JIT
  posture = the human-gate strategy-class lever, not our atomic posture). Consistent with R20.

## Findings Ledger
| finding | owner | carry_to | status |
|---|---|---|---|
| **WBTC unpriced in TOKEN_META → winner_style unknown/unpriceable** (rule-16 tooling gap) | R21 | — | **CLOSED (codified `1f27faf`)** — deterministic postmortem flip unknown→atomic_loop; noise-filter 26/26 |
| Binding constraint = economics/posture (Lever B) — HUMAN GATE | **human** | **when human decides** | **open — RE-ESCALATED. Reconfirmed on a fresh correctly-classified sample: comparable atomic loss, all pools in_graph, dust, ~97%+ to builder. Pick: private orderflow / different strategy class / bid-policy** ([[project-atomic-backrun-market-ceiling]]) |
| Searcher-side coverage lever — EXHAUSTED (R20 verified single-venue longtail residual) | R20 | — | closed (verified) — R21 adds a second confirming sample (winner venues all in_graph) |
| Downstream candidate-cap (41) + expired-before-solver (28) | (paused) | post-human-decision | open — economics-bound (dust), not needle-movers until posture changes |
| Concurrent-chain duplication | human | when human decides | open — recommend consolidating to ONE chain |

## Verdict + close
- **verdict:** loss-analysis + **rule-16 tooling codification**. The newest same-block loss exposed a real
  analysis blind spot (WBTC unpriced → `winner_style` unclassifiable); fixed + gated by a **deterministic
  on-chain postmortem flip** (`unknown→atomic_loop`, `unpriceable→priced`). The corrected classifier
  **reconfirms R20**: this loss is a comparable atomic loop with all pools already in-graph, extracting
  dust and paying ~97%+ to the builder → **economics/posture is the binding constraint = HUMAN GATE**, not
  coverage. Coverage stays exhausted.
- **searcher_behavior_change:** no (analysis-tooling only, mandated by rule 16 — not a null round).
- **carry:** the human-gate posture/economics decision (the sole remaining production lever); the loop
  remains **PAUSED on this human decision** (rule-13 escalate-to-human; not a stall). Concurrent-chain
  consolidation (human).
