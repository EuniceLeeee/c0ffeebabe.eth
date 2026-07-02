# Architecture Review #2 — Verdict (2026-07-02): dust ceiling

> Fired by CLAUDE.md rule 13, from `live-run-R3cov-20260702-hermes.md` Findings Ledger: 3 consecutive
> rounds (R1cov/R2cov/R3cov) closed with genuine +EV `simSuccess` ≈ 0 (funnel produces simSuccess
> 0→2→4, every sim DUST $0.01–$0.65). Handoff: `HANDOFF-architecture-review-2.md`. Orchestrator =
> Opus 4.8, self-driven (rule 14, unattended hourly cron). Scope: authorized defensive on-chain
> arbitrage research; fork/dry-run; broadcast human-gated.

## Method — dual-blind, orchestrator-verified (rule 13 / Rounds step 4)
- **A** = fresh fable-5 sub-agent, chain-side + code, full counterfactual walk on local reth (zero CU) +
  node SSM. Detail: `/private/tmp/hermes-arch-review-20260702/fable-conclusion-A.md`.
- **B** = Codex, read-only, code-side only (no chain/graph access) — re-derived path-breadth and
  sim-fidelity numbers from `file:line`, blind to A (sandboxed, could not write its detail file —
  reasoning recovered from its `--json` event stream).
- **Orchestrator** independently reproduced A's core aggregate stat directly from the raw node events
  file (not from A's summary) before accepting it — see below.

## A vs B: DIVERGED
| | A (fable) | B (codex) |
|---|---|---|
| localized_lever | **coverage** (per-opportunity on-demand admission of impact-token's different-pair neighborhood) | **path-breadth** (`SEARCHER_MAX_HOPS=3`) |
| runner_up | dust-ceiling | strategy-shape-gap |
| decision | epic | funnel-fix |

## Orchestrator resolution — A confirmed, B refuted (independently verified, zero CU)
Pulled `/tmp/r1-events.jsonl` from the node (SSM) and re-ran A's aggregate myself, from the raw
`no_candidate_diagnostic` field (not from A's prose):
```
total_no_candidate 124
classes {'only_immediate_same_pool_reverse': 104, 'impact_pool_not_in_routing_graph': 20}
zero_return_venues 122   (98%)
zero_cross_venue_reverse 122   (98%)
edge_false 20
```
**Exact match to A's reported numbers.** 122/124 (98%) of `no_candidate` drops have the impact
token's return-venue count at **zero** — there is no edge for ANY hop count to traverse. This directly
falsifies B's mechanism: raising `SEARCHER_MAX_HOPS` cannot route through an edge that does not
exist in the graph. B reasoned correctly about the *code* (`maxHops=3` main.ts:301/371, planner
default 8 overridden) but had no graph/diagnostic data to check whether edges existed at all — B
explicitly flagged this gap itself ("I'm not going to invent per-case replay numbers... no checked-in
runtime graph JSON appears"). **Verdict: A's coverage lever is primary; B's path-breadth is ruled out
as primary** (may still matter on the 2/124 residual with real cross-venue edges, but that's not the
dominant loss).

## Additional orchestrator finding (deeper than either A or B — a caveat on A's pinned case #1)
Checked whether the pinned case #1 (`0x2a6c340b`, WETH/`0x14feE680`, block 25444402) actually has a
real different-pair neighbor pool available anywhere in the curated universe:
```
active-pools.json (2995 entries): pools containing 0x14feE680... = 2  (both same-pair WETH venues:
  the impact pool + the R3-fixed alt 0x49bd1fa4)
```
**Zero different-pair candidates exist even in the full 2995-pool curated universe** for this specific
token — `0x14feE680` is a thin/low-liquidity token (consistent with the competitor's $0.09 tip on this
lane). So case #1 is a genuine **dust-ceiling instance**, not a representative different-pair-coverage
example — A's general mechanism finding (98% zero-return-venue) stands, but the SPECIFIC pinned case
undersells the value question. The `impact_pool_not_in_routing_graph` class (20/124) — pools that
exist on-chain but aren't loaded at all (same shape as the already-fixed `coverage-ovr-weth-flip` /
`coverage-ff208177-flip` fixtures) — is the safer place to find a real, non-thin-token pinned case for
slice-1, since a missing-pool gap doesn't carry the thin-token risk a missing-*neighbor* gap does.

## Localization
- **coverage (primary, confirmed):** 98% of no_candidate loss is zero-return-venue for the impact
  token; no landed mechanism does live per-opportunity broader-neighborhood admission (top-N load +
  same-pair pair-completion + build-time discovery-queue are all landed and insufficient — hard req #4
  checked, no duplication).
- **path-breadth (ruled out as primary):** disproven by hard diagnostic data; B's own hypothesis lacked
  the graph data to check.
- **dust-ceiling (runner-up, live):** genuinely present on thin-liquidity tokens (case #1); does not
  explain the other 121 zero-return-venue drops, most of which are unverified for value either way.
- **sim-fidelity (secondary, unchanged from arch-review #1):** `botvm-simulator.ts:55,66` still returns
  `gasUsed: 0n` unconditionally; latent under `EV_GATE=1` at go-live, not the current binding constraint.

## decision: **EPIC** (coverage — per-opportunity broader-neighborhood admission)
A's proposed slice-1 (pin a case, forceInclude the missing neighbor, replay-gate) is correct in
structure but needs a **better-chosen pinned case** than #1 (thin-token, real different-pair venue
doesn't exist even in the full curated universe). R4 task, in order:
1. From the `impact_pool_not_in_routing_graph` class (20/124, safer: missing-pool not missing-neighbor),
   or a fresh live window's `only_immediate_same_pool_reverse` case, find ≥1 real on-chain pool that (a)
   is NOT in `active-pools.json`/routing graph, (b) genuinely exists with liquidity (verify via local
   reth `eth_call`, zero CU), and (c) a competitor closed through for non-dust value.
2. Pin it as a `REPLAY_FIXTURES` gap→flip pair in `test/planner.ts` (same pattern as
   `coverage-ovr-weth-gap/flip`).
3. If it flips to `plans>0` + a genuinely +EV revm sim → **coverage confirmed for real value**;
   proceed to slice-2 (productionize: bounded per-opportunity or build-time broader admission, sized to
   avoid reopening the R2cov graph-size/latency tension — e.g. top-K same-token neighbors by score, not
   unbounded).
4. If it stays dust even after the flip → **dust-ceiling confirmed as the binding constraint**; stop
   chasing coverage, pivot to economics slice-3 (already speced, `epic-coverage-slice1-20260702.md:163`)
   as the only remaining lever, accepting the atomic-bluechip-triangle ceiling.

## Findings Ledger
| finding | owner | carry_to | status |
|---|---|---|---|
| coverage (per-opp different-pair/broader neighborhood admission) confirmed primary, 98% of no_candidate | R4 | R4 | **open** — epic slice pending a better pinned case |
| path-breadth (`maxHops=3`) ruled out as primary (no edges to traverse in 98% of drops) | — | — | **killed** as primary; B's cheap_disproof (`MAX_HOPS=8`) not worth running — would not move the needle |
| pinned case #1 (`0x2a6c340b`/14feE680) is a thin-token dust-ceiling instance, not representative | — | — | noted; do not reuse as the slice-1 fixture |
| need a real, verified, non-thin pinned case from `impact_pool_not_in_routing_graph` (20/124) or a fresh window | R4 | R4 | open |
| sim-fidelity: `gasUsed=0n` unconditional (botvm-simulator.ts:55,66), unchanged since arch-review #1 | pre-broadcast | go-live | open (carried) |
| economics slice-3 spec (EV_GATE=1, BRIBE_BPS<10000, real gas) | slice-3 | go-live | open (carried, unchanged) |

## distance-to-production check
This review did NOT produce a new +EV bundle — it re-localized the lever after 3 rounds of confirmed-
but-dust progress, ruled out a plausible-but-wrong alternative (path-breadth) with hard data, and found
a flaw in its own leading candidate fixture before it was implemented (avoiding a wasted Codex pass on
a thin-token case that would have failed the gate for the wrong reason). Next concrete step (R4) is
narrow: find one real, verified, valuable pinned case and run the existing gap→flip fixture pattern.
