# Hermes Round R4 — 20260703: epic slice-1 gate (real pinned coverage flip)

> Reads arch-review-2-20260702-verdict.md. Orchestrator = Opus 4.8, self-driven (rule 14/15,
> unattended). Scope: authorized arbitrage research; fork/dry-run; broadcast human-gated.

## Task
Architecture-review #2 localized the dominant loss (98% of no_candidate drops, verified independently
on raw node events) to zero routing-graph return venues for the impact token, but its own pinned
example (case #1, `0x14feE680`) turned out to be a thin token with no real alternate venue anywhere in
the curated universe. R4's job: find a REAL, non-thin, verified case and run the existing rule-12
gap→flip fixture pattern (`test/planner.ts`) on it — no production code change yet, mechanism-proof only.

## Case found (orchestrator, zero CU, SSM + active-pools.json)
Token `0x1151CB3d861920e07a38e03eEAd12C32178567F6` / USDT — **repeat lane**, fired as an
`impact_pool_not_in_routing_graph` drop at TWO separate blocks in the R1cov window:
- block 25444461, tx `0x5610530b…4511b7`, pool `0x5ea523e4…F285F8` (univ3 fee 10000, universe score 7, swapCount30d 7)
- block 25444621, tx `0x26c6a22a…7523987`, pool `0x1e84865E…dFaA199` (univ3 fee 10000, universe score 9, swapCount30d 9)

Both pools are real, present in the curated 2995-pool `active-pools.json`, both below the current
top-N cutoff → neither loaded into the runtime routing graph. Real (if modest) 30d swap activity, not
a dead/thin token — the disqualifying issue that killed arch-review-2's original case #1.

## Gate (rule-12, deterministic, Codex-authored + Claude-verified independently)
Added `r4-1151-usdt-pair-gap` / `r4-1151-usdt-pair-flip` to `REPLAY_FIXTURES`
(`listener/src/searcher/test/planner.ts`), same pattern as `coverage-ovr-weth-gap/flip`. Diff scope:
1 file, 25 lines (`git diff --stat`), matches brief exactly.
- **gap** (today's live state, neither pool admitted): `expectClass:
  "impact_pool_not_in_routing_graph"` — **PASS**.
- **flip** (both pools admitted as edges): `expectMinPlans: 1` — **PASS**.
- Claude independently re-ran `npm run searcher:planner` (not Codex's sandbox-workaround run) →
  `planner PASS (12/12) + replay fixtures (12/12)`, both new fixtures print `PASS`.

**expected_transition:** `no_candidate_plans (impact_pool_not_in_routing_graph)` →
`candidate_plans>0`. **verdict: fixed** (mechanism-level — this is a planner-graph fixture, no anvil/
revm sim in this gate; it proves the planner CAN construct a cross-venue closed loop once the real
missing pools are admitted, on a real non-thin recurring case, not that this specific lane is +EV-sized).

## What this does NOT yet prove
This is slice-1 (mechanism gate) only — no production code changed. It does not admit these pools
live, does not re-measure a dry-run window, and does not size the value. Two open questions carry to
slice-2:
1. **Productionize:** the existing mechanisms (top-N load, same-pair pair-completion, discovery-queue)
   all require at least one venue of a pair to already clear the cutoff before completing it. This case
   shows a pair where **both** venues are below cutoff — pair-completion has nothing to attach to. The
   safe, bounded fix is a **per-pair floor** (guarantee the top-1 scored pool for every pair with ≥1
   pool above some lower activity threshold, not a broad per-opportunity neighborhood — avoids
   reopening the R2cov graph-size/latency tension). Needs Codex design + implementation (rule 7/11 —
   Claude does not author net-new design).
2. **Value sizing:** unknown until slice-2 lands and a live window re-measures whether cases like this
   produce genuine +EV sims or more dust (arch-review-2's dust-ceiling runner-up).

## Findings Ledger
| finding | owner | carry_to | status |
|---|---|---|---|
| R4 slice-1 gate: real pinned `0x1151cb3d/USDT` case flips no_candidate→candidate_plans>0 | R4 | — | **fixed (mechanism-level, gate PASS, independently verified)** |
| slice-2: productionize a bounded per-pair floor (both-venues-below-cutoff case) | next round | R5 | open |
| value sizing (dust vs +EV) unresolved until slice-2 + live re-measure | next round | R5 | open (carried from arch-review-2 dust-ceiling runner-up) |
| sim-fidelity `gasUsed=0n` unconditional | pre-broadcast | go-live | open (carried) |
| economics slice-3 spec ready | slice-3 | go-live | open (carried) |
