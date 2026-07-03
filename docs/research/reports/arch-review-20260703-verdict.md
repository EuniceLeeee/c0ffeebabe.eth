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

**Case 2 (found independently by A):** block 25447685, pool `0xc7bBeC68d12a0d1830360F8Ec58fA599bA1d0e9b`
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
- **falsifier dispatched, in progress:** Codex building a one-off flash-size sweep script
  (`searcher:falsify-r11-triangle-sizing`, background task, not yet complete at verdict-write time)
  to sweep 1e17–1e25 wei input on the block-25447685 triangle using the existing solver/quote code.
  If profit clears gas at ANY size → sizing is the real lever (point-fix, not epic). If dust
  persists across the full range → confirms no-replicable-atomic-EV. **This gates the epic/no-epic
  decision below — result to be appended once the sweep runs on the node.**

## decision: PENDING falsifier result (see above) — provisional lean: no code-fixable point-fix
this round; the finding is a **strategy-shape ceiling**, not a bug. Provisional framing per rule 13's
epic-escalation guidance: if the falsifier confirms dust-across-all-sizes, this becomes
`decision: epic` = re-target opportunity search toward fatter-margin atomic loops (longtail
volatile-token triangles where spreads are wider than deep ETH/stable venues), NOT build a
non-atomic/CEX-DEX strategy class (out of mission scope, breaks the atomic-flash-loan safety
posture). Do NOT spend another round polishing the EV gate / defaultGasUsed / coverage graph on
these specific ETH/stablecoin pools — per the evidence above, those stages are working correctly.

## Findings Ledger
| finding | owner | carry_to | status |
|---|---|---|---|
| coverage epic (0702) substantially landed; residual gap is 12% longtail, not dominant | R4-R10 | — | **confirmed closed enough** — not the R10/R11 flat-simSuccess cause |
| 0702 review's `gasUsed=0` sim-fidelity carry | Codex-B (0702) | this review | **refuted** — fixed in current code, `botvm-simulator.ts` returns real gas |
| atomic triangles that DO route/sim are dust vs non-atomic competitor takes on the same block/pool | R11 dual-blind (A) | falsifier | **evidenced** (Case 2, ~48,000x gap) — falsifier pending |
| flash-size sweep falsifier (sizing vs structural ceiling) | R11 | R12 | **in progress** (Codex building `searcher:falsify-r11-triangle-sizing`) |
| discovery-queue.json 6 stale entries, never drained since 20260702 | future | when slack exists | open, non-blocking (noted in handoff §4) |
| R10 v4 production backfill still running (~2hr+, pid 99451) | R10→R11 | R12 | still running, not yet merged into active-pools.json, zero-cost to let continue |
