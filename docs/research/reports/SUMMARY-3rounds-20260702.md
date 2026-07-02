# 3-Round Hermes Marathon — Summary (2026-07-02, post-coverage-epic)

> Scope: authorized defensive on-chain arbitrage research; mainnet fork + local reth dry-run; broadcast is
> a hard human gate. Orchestrator = Opus 4.8; each round's blocker-finder A = a fresh fable-5 sub-agent
> (R2/R3 verified pure fable-5, no fallback) + Codex conclusion B, dual-blind.

## The arc (each round: deploy → ~30-min dry-run window → analysis → competitor cross-ref → dual-blind blocker → Codex fix → Claude gate)
| round | fix | deterministic gate | live metric moved | genuine +EV simSuccess |
|---|---|---|---|---|
| R1 | coverage: universe 0→1500 (topN=0 `?? Infinity` bug + deploy-persist) | pool-universe flip | no_candidate **78%→59%**, graph 2928→4295 | **0** |
| R2 | latency: candidate cap 0→6 (activated shipped bail) | metrics (latency exempt) | expired+timeout **32%→12%** | 0 (2 sims, DUST) |
| R3 | coverage: pair-completion (+239 same-pair alternates) | planner flip (b2 gap→flip) | same_pool_reverse flat (non-closable) | 0 (4 sims, DUST) |

## What moved
- **The funnel now works end-to-end.** simSuccess **0 → 2 → 4** across the rounds — coverage + latency
  unblocked opportunities to reach the solver and produce *profitable simulations*. That is real: the
  pipeline was producing zero profitable sims before; now it produces a handful per 30-min window.
- Deterministic gates all PASSED (rule-12): the coverage load flip, the pair-completion flip, the latency
  metrics. Each fix was verified, not just "built."

## What did NOT move — the honest bottom line
- **Every simSuccess across all 3 rounds was DUST** ($0.01–$0.65). **Genuine +EV simSuccess = 0.** The
  production needle (a real +EV bundle we could broadcast) has NOT moved.
- Three structural reasons (dual-blind + competitor traces):
  1. **We catch small bluechip triangles** (WETH/USDC/USDT/DAI) — genuinely tiny arbs in efficient markets.
  2. **The BIG competitor value is still out of reach.** The $200-class longtail multi-hop arbs
     (e.g. `0x68e77ef1`) route through Uni v4 + unsupported custom AMMs + genuine multi-hop; and Fable-A
     showed much of the `same_pool_reverse` bucket is **non-closable noise** (sandwich, 1inch-LOP resting
     orders) we don't run. Coverage/pair-completion can't reach those.
  3. **Economics makes even the small sims −EV** (Codex-B): `bribeBps=10000` → netEth = −gasCostEth; and
     the Anvil sim returns `gasUsed=0` so the EV gate always uses the 12M fallback (≈0.024 ETH).

## Architecture-review trigger FIRED (rule 13)
≥2 consecutive rounds (all 3) closed with NO growth in a genuine +EV `simSuccess`. Per rule 13 the next
step is a **mandatory architecture-level review in a fresh dual-blind context — NOT another point-fix**.
The coverage/latency levers are DONE (funnel works). The remaining distance-to-production is structural,
and the review must localize it among:
- **economics** (dust→−EV; the sizes are real but the config/gas model kills them) — Codex-B slice-3 spec ready;
- **no-replicable-atomic-EV** (the atomic arbs we CAN construct are genuinely dust; the big competitor
  value needs strategies we don't run — sandwich / resting-order / v4);
- **flow-admission / big-value coverage** (v4 + unsupported-venue epic for the longtail multi-hop).

## Recommended next
1. **Architecture review** (dual-blind, fresh fable A + Codex B) to localize: is a genuine +EV bundle
   reachable by fixing economics + v4/multi-hop coverage, or is the replicable atomic-EV genuinely dust?
   (The hourly cron routine auto-fires this on its next run per the trigger.)
2. **Economics slice-3** (Codex-B spec): `EV_GATE=1` + `BRIBE_BPS<10000` + realistic gas (fix sim
   gasUsed=0) — verified disproof gives netEth=+0.002 ETH on the 0.01557 lane. Gate this once a real
   +EV-sized arb is constructible (don't chase it on dust).
3. **Reclassify** non-closable `same_pool_reverse` (sandwich/resting-order) so the funnel stops
   over-counting recoverable loss.

## Governance shipped this marathon (durable)
- `scripts/codex-run.sh` (codex launcher: `< /dev/null` + caffeinate + watchdog) + rule-11 enforcement hook.
- `guard-workflow-noask.py` (rule 14) + `guard-workflow-nostall.py` (rule 15) + sleep-keeper Step 0.
- Architecture-review = dual-blind (rule 13); `deploy-node.sh` SEARCHER_* glob + universe!=0 banner assert.
- The hourly unattended Hermes cron routine (with anti-overlap lock).
