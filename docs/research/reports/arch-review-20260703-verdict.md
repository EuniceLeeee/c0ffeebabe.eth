# Architecture Review — Verdict (2026-07-03, refire)

> Fired by CLAUDE.md rule 13's architecture-review trigger (R10 + R11 closed with genuine +EV
> `simSuccess` flat at 0, both solid non-thin samples). Dual-blind at the architecture level
> (rule 13 / Rounds step 4). Scope: authorized defensive on-chain arbitrage research; mainnet
> fork + dry-run; broadcast is a hard human gate; targets/harms no user.
>
> This is a REFIRE — the 20260702 review's verdict was `localized_lever: COVERAGE`,
> `decision: EPIC`, executed across R4-R10 (universe topN=0 fix, v4 adapter, v4 discovery, v4
> Initialize-window gap — all landed and deployed live). This review asks whether coverage
> remains the binding lever now that epic has substantially landed.

## Method — two independent reviewers, blind to each other, both from `HANDOFF-architecture-review.md`

- **A** = fresh fable-5 sub-agent (chain-side + code): direct on-chain trace of 2 pinned
  counterfactual cases + live diagnostic-field re-derivation from raw jsonl.
- **B** = Codex, read-only (code-side): re-derived economics/sim-fidelity numbers from `file:line`,
  no chain access, worked from the handoff's pinned data only.
- **Orchestrator (Claude)** independently re-verified the single discriminating fact after A and B
  disagreed: pulled the raw `pipeline_dropped` event for the pinned pool directly from the node's
  events jsonl, and the live `.env` (`SEARCHER_EV_GATE`, `SEARCHER_BRIBE_BPS`).

## localized_lever = **no-replicable-atomic-EV** (primary) — A's conclusion, orchestrator-confirmed

### Where A and B disagreed, and how it was resolved
| | B (Codex) | A (fable) | orchestrator re-check |
|---|---|---|---|
| pinned pool `0x51840EdC…` in routing graph? | "handoff's `null` is unknown, not proven absent" (correctly cautious, medium confidence) | **`impact_pool_edge_in_routing_graph: true`** (pool IS registered) | **CONFIRMED true** — pulled raw `pipeline_dropped` event directly: `impact_pool_edge_in_routing_graph:true`, `impact_token_return_venues_excluding_impact_pool:0`, `classification:only_immediate_same_pool_reverse` |
| `SEARCHER_EV_GATE` live value | assumed OFF (handoff/code-default framing) | **ON** (`SEARCHER_EV_GATE=1`, read from `/proc/PID/environ`) | **CONFIRMED** `SEARCHER_EV_GATE=1` on the live node |
| `SEARCHER_BRIBE_BPS` live value | assumed 10000 (code default) | **5000** (read from live env) | **CONFIRMED** `SEARCHER_BRIBE_BPS=5000` on the live node |
| primary class | coverage / routing-graph registration gap | no-replicable-atomic-EV | **A wins** — B's primary hypothesis is empirically refuted for the pinned case; B worked from code defaults instead of the live-node env/diagnostic (no chain access, as designed) |

B's methodology was sound (correctly flagged its own uncertainty, correctly refuted the
"`gasUsed=0` unconditional" carry-over from the 0702 review — that specific sim-fidelity bug IS
fixed in current code, `botvm-simulator.ts` reads real receipt gas). B's error was assuming
code-default config rather than live-node config, which it structurally cannot check (no chain/SSM
access) — this is the expected shape of a correct dual-blind disagreement: A's tools reached
ground truth B's tools could not.

### The walk (load-bearing evidence, both cases chain-verified this round)
**Case 1 (pinned):** tx `0x2e19d12618a2…`, block 25447978, pool `0x51840EdC34BE8f0a391cBB180a213facF22CCD74`.
Pool **is** in our routing graph; the out-token (`0x3e76dd57…`) has exactly **1 supported pool,
0 other return venues** (`impact_token_return_venues_excluding_impact_pool:0`,
`cross_venue_reverse_count:0`) — there is no second on-chain venue to close an atomic loop through.
Competitor's tx is a single directional swap (not a loop) — consistent with an off-chain-priced
(CEX-DEX/inventory) leg, not an on-chain arb we failed to route.

**Case 2 (found independently by A):** block 25447685, pool `0xc7bBeC68d12a0d1830360F8Ec58fA599bA1b0e9b`
(corrected: A's raw report had a transcription typo, `…d0e9b`, an address with no on-chain bytecode;
orchestrator verified the real pool via `cast code` on both candidates before running the falsifier)
(USDT/WETH v3). Our planner DID generate 20 candidate plans and found a real triangle
(`WETH->USDC->USDT->WETH`, `flash-swap-repay`) with **positive gross profit (~0.00037 ETH)**,
correctly killed by `below_ev_gate` after ~360k gas (net ≈ −0.000135 ETH). Competitor's take on
the **same block, same pool**: a single swap netting ~$62 — roughly 48,000× our atomic loop's
gross profit on the identical venue/block. This is the sharpest evidence: we successfully
constructed and simmed the atomic loop, and it is still dust next to the non-atomic take.

### R11 `no_candidate_plans` sub-classification (re-derived, resolves the earlier open question)
`only_immediate_same_pool_reverse` (correctly pruned, no closing venue) = **93/106 (88%)**;
`impact_pool_not_in_routing_graph` (genuine graph gap) = **13/106 (12%)**. Consistent with R9's 19/20
and R10's 33/35 — the coverage epic's remaining residual is a small, longtail fraction, not the
dominant drop class.

## Ruled out
- **coverage (as primary)** — the epic substantially landed (universe=1500 confirmed live, v4
  gaps fixed); the pinned + second case both show the impact pool correctly in-graph; the residual
  `impact_pool_not_in_routing_graph` fraction is only 12% and (per R9/R10) itself resolves to
  dust-scale longtail pools, not the source of the flat `simSuccess`.
- **economics (as primary cause of flat simSuccess)** — `simSuccess`/`simulation_result` is
  measured upstream of the EV gate; Case 2 shows the EV gate correctly rejecting a real-but-dust
  triangle, not wrongly rejecting a winner. Economics is real (and now confirmed LIVE, not off) but
  is gating dust correctly, not suppressing hidden +EV.
- **sim-fidelity (`gasUsed=0` fallback)** — the 0702 review's carried finding is REFUTED on current
  code: `botvm-simulator.ts` returns real receipt gas on success; the 12M fallback only fires on
  simulator failure, and B confirmed this is not unconditional.

## Runner-up + falsifier
- **runner-up = funnel/solver under-sizing** (A's own proposed alternative): maybe the atomic
  triangle at block 25447685 is real but our solver found only a local-optimum dust size when a
  larger flash size would clear gas.
- **separating evidence (so far):** competitor's take on the same block/pool was a single swap, not
  a bigger version of our triangle — suggesting an off-chain edge, not a mis-sized on-chain one.
- **falsifier RESULT (run on the node against local reth, block 25447685, 18 log-spaced points
  from 0.1 to 10,000,000 WETH input, gas cost 0.00014 ETH):** `net_profit_eth` is **negative at
  EVERY tested size**, monotonically worsening as size grows (0.1 WETH → −0.000193 ETH;
  10,000,000 WETH → −9,999,490 ETH — slippage dominates immediately, there is no local optimum to
  find by sizing up). Verdict line: **`CONFIRMED: dust persists across full size range`**.
  **Runner-up (solver under-sizing) is REFUTED.** No size of this specific atomic triangle clears
  gas — the loop's own AMM-implied slippage makes it a losing trade at any scale, consistent with
  the competitor's edge coming from off-chain information (CEX price), not from an on-chain
  arbitrage we mis-sized.

## decision: **EPIC** — re-target opportunity search toward fatter-margin atomic loops

Falsifier CONFIRMED (dust/negative persists across the full size range on the deep ETH/stable
triangle). The finding is a **strategy-shape ceiling, not a bug**: our pipeline correctly sees,
plans, sims, and gates atomic loops on deep ETH/stablecoin venues — but those venues are priced
efficiently enough that any real edge there is off-chain (CEX-DEX/inventory), which an atomic
flash-loan architecture structurally cannot capture. `decision: epic` = re-target discovery/solver
attention toward longtail volatile-token triangles where naturally wider on-chain spreads can make
an atomic loop's OWN slippage the profit source (no external price information needed), rather than
building a non-atomic/CEX-DEX strategy class (out of mission scope; breaks the atomic-flash-loan
safety posture — Safety Rules 1-2). Do NOT spend another round polishing the EV gate /
`defaultGasUsed` / coverage graph on deep ETH/stablecoin pools — per the evidence above, those
stages are working correctly on this venue class.

**Epic slice-1 (rule-12 minimal first cut, carried to R12):** audit whether our pool-universe
ranking / solver candidate selection is *biased toward deep/high-TVL pools* (e.g. by liquidity-based
scoring) in a way that starves longtail-triangle exploration, and if so, the minimal change is
re-weighting candidate selection to also surface wide-spread longtail triangles — gated by a pinned
replay showing a previously-dust longtail case flip to a genuine +EV `simSuccess`. This audit is the
next Implementation Brief's job (R12) — this round (R11) is analysis/architecture-review only,
which is the CLAUDE.md rule-13-mandated exception to "every round ships a fix."

## searcher_behavior_change: no (this round — mandated architecture-review exception)
R11 shipped no production code change (only the one-off diagnostic falsifier script, additive,
not wired into the live searcher). Per rule 13's own carve-out, the architecture review replaces a
point-fix round when its trigger fires; but per the anti-drift cap, **R12 MUST ship a real
searcher-behavior change** (the epic slice-1 above) — this round cannot be followed by another
observability-only turn.

## Findings Ledger
| finding | owner | carry_to | status |
|---|---|---|---|
| coverage epic (0702) substantially landed; residual gap is 12% longtail, not dominant | R4-R10 | — | **confirmed closed enough** — not the R10/R11 flat-simSuccess cause |
| 0702 review's `gasUsed=0` sim-fidelity carry | Codex-B (0702) | this review | **refuted** — fixed in current code, `botvm-simulator.ts` returns real gas |
| atomic triangles that DO route/sim are dust vs non-atomic competitor takes on the same block/pool | R11 dual-blind (A) | — | **confirmed** (Case 2, ~48,000x gap; falsifier shows dust/negative at every size 0.1-10,000,000 WETH) |
| flash-size sweep falsifier (sizing vs structural ceiling) | R11 | — | **done** — `CONFIRMED: dust persists across full size range`, runner-up (sizing) refuted |
| epic slice-1: audit pool-selection bias toward deep/high-TVL venues, re-weight toward longtail | R11 | R12 | **done** — bias confirmed (score=swap-log-count, not TVL, same effect); bounded high-spread pair quota shipped + replay-gated, commit `5266555`, see `live-run-R12-20260703-hermes.md` |
| discovery-queue.json 6 stale entries, never drained since 20260702 | future | when slack exists | open, non-blocking (noted in handoff §4) |
| R10 v4 production backfill still running (~2hr+, pid 99451) | R10→R11 | R12 | still running, not yet merged into active-pools.json, zero-cost to let continue |
