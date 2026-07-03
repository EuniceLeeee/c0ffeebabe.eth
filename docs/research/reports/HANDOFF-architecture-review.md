# Architecture Review Handoff — refired after R10+R11 (2026-07-03)

> Regenerated per `docs/research/templates/architecture-review.md` section B. DATA + HYPOTHESIS,
> not conclusions. Scope: authorized defensive on-chain arbitrage research; mainnet fork +
> dry-run; broadcast is a human-gated step.
>
> **This is a REFIRE of a prior review, not a first firing.** The 20260702 review (see
> `docs/research/reports/arch-review-20260702-verdict.md`) already ran this same dual-blind
> process once, verdict `localized_lever: COVERAGE`, `decision: EPIC` (proactive venue-graph
> coverage). That epic was executed across R4-R10 (universe topN=0 fix, v4 adapter, v4 discovery,
> v4 Initialize-window gap) and is now substantially LANDED and DEPLOYED LIVE. Yet `simSuccess`
> is STILL flat (0) across R10 and R11. **Your job: determine whether coverage remains the binding
> lever (just not yet sufficient), or whether closing coverage has now exposed a DIFFERENT binding
> constraint** (the prior review's own Codex-B pass already flagged a candidate: see §2 below).

## 1. Trigger evidence — round table (flat simSuccess)

| round | window | opps_seen | pipeline_dropped | simulation_result (ok:true) | non-dust bundle_submitted | fix shipped |
|---|---|---|---|---|---|---|
| R8 | 20260703 | 48 | 51 | **3** | — | EV-gate FRAX valuation fix |
| R9 | 64 events, 147 blocks | 32 | 32 | 0 (strict window) | **first non-dust found** (block 25447376: profit 0.00217 ETH, bid 0.00109 ETH, net ~$3.9, bid≈50% not 100%) | validated R8 fix live |
| R10 | 92 events | 47 | 45 | **0** | 0 in-window | v4 Initialize-window pool-discovery gap fixed + deployed (`82dce7e`) |
| R11 | 183 events, 573 blocks (25447562→25448134, 64min) | 91 | 90 | **0** | **0** | none yet — this trigger |

**R10 + R11 are both solid (non-thin) samples with zero non-dust simSuccess growth.** R11
`pipeline_dropped`: `no_candidate_plans`=57 (63%), `no-profitable-quote`=11, `candidate-cap`=11,
`quote-timeout`=7, `expired-before-solver`=4. Spread across **13 distinct pools** (not one
concentrated known-bottleneck pool like R6-R9's `0xEcABc504…`/`0x39484A066af5…` pattern) —
`0xb2896002662372B95086A4fCAaf7dFA6C7727B4A`(7x), `0x46af68beE5212318B3f30AE14b4EE03fd49FB147`(3x),
rest 1-2x each.

**IMPORTANT — do not trust the raw `no_candidate_plans` count without sub-classification.** R9/R10
each hand-classified their own `no_candidate_plans` drops and found the large majority were
**correctly-pruned, non-arbable** (`only_immediate_same_pool_reverse`): R9 19/20, R10 33/35. Only a
small remainder (R9 1/20, R10 2/35) were `impact_pool_not_in_routing_graph` — a REAL gap. **R11's 57
`no_candidate_plans` have NOT been sub-classified yet this round — this is the reviewer's first job**
(the events carry a `subReason`/classification field per drop; grep the raw jsonl, don't just count).
If R11 follows the same ~94% correctly-pruned pattern, the real remaining `no_candidate_plans` gap is
only ~3-4 pools, not 57 — which changes the whole picture of how big the coverage lever still is.

## 2. Prior review's own unresolved finding (read before re-deriving from scratch)

From `docs/research/reports/epic-coverage-slice1-20260702.md` (Codex-B, independent economics
re-derivation, already landed as an epic finding, **status: open, carry_to: go-live, NOT YET FIXED**):

> **Anvil sim returns `gasUsed=0` unconditionally** (`botvm-simulator.ts:51-56`) → whenever the EV
> gate is evaluated, it ALWAYS falls back to `defaultGasUsed=12,000,000` × 2 buffer = 24M gas ≈
> 0.024 ETH @1gwei — enough to kill real, modest (~0.01-0.02 ETH) profitable lanes. **A sim-fidelity
> bug that compounds economics.** Also: `bribeBps=10000` → `bidEth = expectedProfitEth` →
> `netEth = −gasCostEth` (fails EV gate by construction) whenever the gate is ON.

**Caveat also already noted by that review:** `simSuccess` is measured **upstream** of the EV gate
(`main.ts:1509` before `main.ts:1619`), and **the EV gate is OFF in dry-run** — so this specific bug
does NOT explain a flat `simSuccess=0` by itself (it's a pre-broadcast wall, not a `simSuccess`
blocker). **Re-verify this is still true on the current code** (line numbers may have shifted since
R6-R10 touched `main.ts` — grep, don't trust the cited line numbers). If `simSuccess` really is
computed pre-EV-gate, then the flat-zero this round is a `plan → sim` problem (no positive quote
ever reaches `simSuccess`), not (yet) an EV-gate/economics problem — but confirm this split still
holds; do not assume it is unchanged from the 0702 review.

## 3. Pinned counterfactual case (from R11's own Step-1, chain-verified this round)

- **tx:** `0x2e19d12618a20024759214b553a904c8a3f561ebee5d15b7c8b4c3aebdc5997c`, block `25447978`,
  competitor `0xae2Fc483527B8EF99EB5D9B44875F005ba1FaE13`.
- **on-chain facts (cast receipt, local reth):** `gasUsed=106774` (vs our 12M fallback — ~112x
  smaller), single pool `0x51840EdC34BE8f0a391cBB180a213facF22CCD74` (standard UniV3 `Swap` topic
  `0xc42079f9…`), USDT leg = 5,268.398337 USDT out of the pool; other leg = token
  `0x3e76dd57E649A263a532cC9bcC58b32A065fB2a4` (unpriced by the script, `unpriced_deltas:1` — treat
  the `$5228.68 realized_profit_usd` figure as a rough, possibly-inflated heuristic, `profit_confidence:
  medium`, until independently priced).
- **script classification** (`outputs/live-loss/watch-25447978-2e19d12618.md` on the node):
  `primary_reason: seen_but_lost`, `seen_scope: same_token`, `pool_in_seen_events: false`,
  `pool_in_routing_graph: null`, `gap_type: n/a` (unclassified by the script — verify, don't trust).
- **our own funnel, SAME window:** this EXACT pool address appears in R11's `no_candidate_plans`
  drop list — meaning our planner DID encounter it and produced no candidate plan, yet the script
  says it's not in our routing graph. **This contradiction is the thing to resolve**: is the pool
  registered but unroutable (path gap), or does opportunity-detection touch it via a different
  mechanism than the routing graph (registration/coverage gap)?
- **Widen the sample:** `0xae2Fc483` alone executed 126 txs in this 64-min window (net ~$332
  realized after netting paired legs; 30/126 `seen_but_lost`, 96/126 `not_seen`).
  `0xc0ffeEBABE5D496B2DDE509f9fa189C25cF29671` executed 10 txs, ~$4.07 net (quiet this window).
  Raw reports: on the node, `/opt/MEV/analysis/outputs/live-loss/watch-*.md`, filter to
  **filename block number in `[25447562, 25448134]`** (the directory has stale reports from prior
  rounds mixed in — do NOT grep the whole directory, `grep -l addr $(cat /tmp/inwindow.txt)`
  pattern was used this round to scope correctly, list saved at `/tmp/inwindow.txt` on the node).

## 4. Current repo mechanisms snapshot (so no epic slice reinvents landed work)

- **Coverage / learn→close (W3, landed `a3c8cb2`):** `listener/searcher/pools/discovery-queue.json`
  — only `class:closable` pools auto-enqueue for probe+merge; `single_venue_noise` never added;
  non-standard shapes (native-ETH sentinel, v4) recorded `blocked_on_adapter`, feed the epic.
  Current queue has 6 STALE entries from `step1:20260702-v3fork` (never probed/merged since
  `first_seen_block` ~25442420-493) — **check whether this queue is actively drained by anything,
  or sits dormant round-to-round.**
- **v4 pool discovery:** R7 initial backfill (655/1500 graph slots v4) + R10 fixed the
  `Initialize`-window gap (`resolveV4InitBackward`, deployed `82dce7e`). R10's live production
  backfill (150k-block window) is **STILL RUNNING** on the node as of this handoff (pid 99451,
  ~2hr+ elapsed, stuck in the per-poolId resolver phase — see `/tmp/v4-backfill-r10.log`), not yet
  merged into `active-pools.json`.
- **Pool universe:** `SEARCHER_POOL_UNIVERSE_TOP_N=1500` confirmed live this round (startup banner:
  `2 protocol + 12 pinned + 1500 universe + 2934 factory + 100 swap-active + 284 pair-completion =
  4676 total`). The 20260702 zero-universe regression (topN=0) is NOT present.

## 5. Economics config snapshot (current values, re-verified this round)

| knob | value | source |
|---|---|---|
| `SEARCHER_QUOTE_SAFETY_BPS` | 9999 | `main.ts:303`, `solver.ts:112` |
| `SEARCHER_QUOTE_PROFIT_FLOOR_BPS` | 20 (dry-run) / 0 (live) | `main.ts:330`, `solver.ts:114` |
| `SEARCHER_BRIBE_BPS` | 10000 (100%) | `main.ts:350` |
| `SEARCHER_MIN_NET_ETH` | 0 | `main.ts:353` |
| `SEARCHER_BACKRUN_GAS_USED` (defaultGasUsed fallback) | 12,000,000 | `main.ts:316`, used at `main.ts:1656,1694` when `sim.gasUsed==0` |
| `SEARCHER_POOL_UNIVERSE_TOP_N` | 1500 (confirmed live) | startup banner this round |
| `SEARCHER_OPP_TTL_MS` | 5000 (deploy default) | `scripts/deploy-node.sh` |

**Note:** line numbers above are from a grep run this round (2026-07-03) — re-verify, code may have
shifted since. `defaultGasUsed`/`bribeBps` values match the prior review's Codex-B finding almost
exactly (still 12M / 10000bps) — i.e. that finding was never actually remediated, only diagnosed.

## 6. Deliverable format expected back

Per the template's 4 hard requirements: (1) counterfactual walk on ≥2 real competitor takes
(the pinned `0x2e19d126…` case + ≥1 more you find independently) with a named primary class
(coverage / sim-fidelity / economics / flow-admission, or a stated combination with a named
primary) — **and explicitly address whether coverage is still-insufficient vs a new lever has
emerged now that the 20260702 epic has substantially landed**; (2) load-bearing numbers
re-derived from code/raw artifacts, not inherited from R-round docs or this handoff; (3) runner-up
class + the evidence that separated it + one cheap falsification experiment; (4) a repo-mechanism
inventory check (§4 above is a starting point, verify it) before naming any class `epic`.
