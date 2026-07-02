# Epic (coverage) — Slice 1 plan: universe admission fix + one real-sample replay

> Impl cycle. Orchestrator = Opus 4.8 (5-step: Claude plans → Codex reviews plan → Claude
> finalizes → Codex writes → Claude reviews + gates). Scope: authorized defensive on-chain
> arbitrage research; fork/dry-run; broadcast is a hard human gate.
> Source verdict: `docs/research/reports/arch-review-20260702-verdict.md` (localized_lever=coverage).

```yaml
cycle_id: epic-coverage-slice1-20260702
orchestrator: Opus 4.8 (5-step)
codex: pending
```

## Decision + Implementation Brief  <!-- AUTHORITATIVE — only this drives code -->

### goal / root cause
The curated file-backed pool universe (`active-pools.json`, 2995 scored pools) never enters the
live runtime graph: `SEARCHER_POOL_UNIVERSE_TOP_N` defaults `"0"` (main.ts:330) → `loadPoolUniverse(maxPools:0)`
→ `opts.maxPools ?? Infinity` keeps 0 (pool-universe.ts:64, `??` misses 0) → `slice(0,0)=[]`. So the
runtime graph holds hot/recent pools (factory/swap) but misses the curated **return venues** →
70–77% of opportunities die at `no_candidate_plans` (`only_immediate_same_pool_reverse` /
`impact_pool_not_in_routing_graph`) → `simSuccess=0`. **Fix = make discovered pools reliably enter
the production runtime graph — bounded, explicit, and with forced-include for competitor-demonstrated
return venues.** NOT latency, NOT economics (this slice), NOT unlimited-2995.

### searcher_behavior_change: **yes** (the runtime graph gains the curated return venues → planner can close loops)

### The SIMPLE path (surgical — pinned changes)
1. **`main.ts:330`** — default `SEARCHER_POOL_UNIVERSE_TOP_N` `"0"` → **`"2000"`** (bounded, explicit;
   never a silent 0 that drops everything). Keep `poolUniverseMinScore` default (1).
2. **`pool-universe.ts:64`** — fix the nullish bug so an *explicit* `0` means unlimited (repo
   convention `0=unlimited`), not "load none":
   `const maxPools = opts.maxPools && opts.maxPools > 0 ? opts.maxPools : Infinity;`
   (Default is now 2000, so this only matters if someone sets 0 deliberately.)
3. **Forced-include** (belt-and-suspenders so a ranking cut never drops a competitor-demonstrated
   return venue): add `forceInclude?: string[]` to `PoolUniverseLoadOptions`; in `loadPoolUniverse`,
   after the sort+slice, append any file entry whose address ∈ `forceInclude` that isn't already in
   the sliced set (deduped, checksum-compared). Wire a config `poolUniverseForceInclude` from env
   `SEARCHER_POOL_UNIVERSE_FORCE_INCLUDE` (comma-sep addresses). Seed on the node with the walk's
   return venues that are confirmed present in active-pools.json: `0x2beb35e7…`, `0xe9930ea6…`
   (+ `0x1069cea8…`, `0x7948548e…` if present).
4. **Startup log** — `main.ts:472-477` already prints `${universePools.length} universe`; extend the
   same line to also print the forced-include count. Requirement satisfied by the existing log; just
   verify it now prints **nonzero**.
5. **Runtime dump** — `main.ts:478 dumpRuntimeGraphPools(allPools)` already dumps; verify the promoted
   pools appear in `runtime-graph-pools.json` after the fix (no code change needed).
6. **PERSIST across deploys (analysis D — CONFIRMED, the "why it keeps reverting").** `deploy-node.sh`
   rebuilds `.env` from a `KEYS` allowlist recovered off the running process (line 22-24); that allowlist
   **omits `SEARCHER_POOL_UNIVERSE_TOP_N`**, so the v3fork cycle's `=1500` was silently dropped on the
   next deploy → back to 0. **Add `SEARCHER_POOL_UNIVERSE_TOP_N` + `SEARCHER_POOL_UNIVERSE_MIN_SCORE` +
   `SEARCHER_POOL_UNIVERSE_FORCE_INCLUDE` to the `KEYS` allowlist** (else my new forced-include env is
   dropped the same way). The code-default fix (change 1) is the robust primary; the allowlist keeps
   `.env` tuning from silently reverting. **Post-deploy banner assertion:** deploy-node.sh should FAIL
   loud if the restarted banner shows `universe=0` (same spirit as the DRY_RUN guard).

### allowed files
- `listener/src/searcher/main.ts` (config line 330 + the startup-log line 472-477 only)
- `listener/src/searcher/pool-universe.ts` (line 64 + the `forceInclude` option/logic)
- `scripts/deploy-node.sh` (KEYS allowlist + the universe!=0 banner assertion)
- `listener/src/searcher/test/pool-universe.ts` (**new** unit test) — or the nearest existing test file
- the real-sample replay fixture files for the `production_gap` gate (see AC-3)
### forbidden
solver / planner core / token-graph / adapters / detector — this slice is **admission only**.

## Plan Review  <!-- Opus 4.8 5-step: Codex critiques this plan BEFORE code -->
- **codex verdict:** _pending_
- **incorporated into final plan:** _pending_

## Acceptance Criteria (the hard 3-段 bar — planner flip alone is NOT "fixed")

**AC-1 — loader unit (`coverage_planning_fixed` foundation):** a `loadPoolUniverse` test asserting:
(a) with the new default (topN=2000) the 2995-pool file loads a **bounded, nonzero** set (top-2000 by
score); (b) `forceInclude` promotes a specified below-cut address; (c) explicit `topN=0` now loads
**all** (unlimited). `npm run build` clean.

**AC-2 — planner flips still pass (regression):** `npm run searcher:planner` → **12/12 + 6/6**, incl.
`coverage-ovr-weth-gap→flip`, `v3fork-triangle-gap→flip`, and `single-venue-longtail` STAYS 0
(anti-fabrication guard). This is the `coverage_planning_fixed` bar — necessary, **not sufficient**.

**AC-3 — one REAL competitor +EV sample, full-pipeline replay (`production_gap_fixed` bar):**
- **Primary sample (analysis D — cleaner, died at no_candidate not latency):** block **25443539**,
  WETH/`0xff208177` via venues `0x15e86e6f` + `0x08650bb9` (both in active-pools top-1500, pruned from
  the runtime graph). Strongest: **`0x68e77ef1` (+0.0668 WETH ≈ $200)** dropped
  `only_immediate_same_pool_reverse` (source in-graph, closing venue missing). Pinned planner fixture:
  WETH/`0xff208177` `0 plans → plans>0`; then revm +EV-sim flip.
- Alt: R1 `0x4cece1af` (block 25442793; +0.050 WETH; return pools `0x2beb35e7`/`0xe9930ea6`) — but its
  live drop was latency, so 25443539 is the cleaner coverage gate. **Record the fixture SOON (reth
  --full prunes ~10k blocks ≈ 33h).**
- **baseline** (graph WITHOUT the promoted return venues): `no_candidate_plans` /
  `only_immediate_same_pool_reverse`.
- **after** (universe fix promotes them): **plans>0 AND ≥1 candidate enters the solver AND (target)
  `simSuccess>0` with positive profit.**
- **verdict naming (your rule):** all three met → `production_gap_fixed`. Only plans>0 / solver-entry
  but sim not +EV → **`coverage_planning_fixed`** + record the EXACT stop (quote ≤0 → sim-fidelity;
  sim revert → adapter) — do **NOT** claim `production_gap_fixed`.
- Harness: `listener/src/searcher/test/replay-live-fixtures.ts` (`npm run searcher:replay-live-fixtures`,
  revm sim) for solver-entry + sim; record with `SEARCHER_RECORD_LIVE_FIXTURES=1`.

## Implementation staging (rule 11: one narrow Codex patch at a time)
- **Pass A** = changes 1–4 + AC-1 + AC-2 (admission fix + loader unit + planner regression). Clean, ≤2 src files.
- **Pass B** = AC-3 (record + wire the real-sample replay). Depends on Pass A landing + node fixture record.
- Slice-1 is **not accepted** until AC-3 returns either `production_gap_fixed` or an explicit
  `coverage_planning_fixed` + stop-reason.

## Sufficiency caveat + parallel economics track (analysis D — 4th independent confirmation)
- **topN=1500 was ALREADY run (v3fork window) and STILL closed simSuccess=0.** So slice-1 (coverage) is
  NECESSARY + highest-leverage but **not proven sufficient**; economics (`bribeBps=10000`, `minNetEth=0`)
  is the likely next wall once coverage lands.
- **This makes AC-3's `coverage_planning_fixed` vs `production_gap_fixed` split load-bearing:** if slice-1
  flips the planner (plans>0, solver-entry) but the sim is not +EV, that is NOT a failure — it has
  LOCALIZED the wall to economics with a one-line config change, the progress three flat rounds couldn't make.
- **Run Codex conclusion B (independent EV-gate re-derivation) IN PARALLEL** with slice-1 impl — don't
  serialize; the economics slice should be ready the moment coverage lands.
- **Open reconciliation (non-blocking):** D says `0x476548cc`=+0.0156 WETH (real arb); A/C said −0.478 WETH
  (inventory move). Likely A/C measured the gross from+to entity flow, D isolated the arb leg. Re-trace to
  align before pinning `0x476548cc`; the $200 `0x68e77ef1` is the primary gate regardless.

## Findings Ledger
| finding | owner | carry_to | status |
|---|---|---|---|
| topN=0 universe never loads (root cause) | Pass A | slice-1 | open |
| **deploy-node.sh KEYS allowlist omits topN → fix keeps reverting (D, confirmed)** | Pass A | slice-1 | open |
| real-sample production_gap proof (solver-entry + +EV sim, block 25443539) | Pass B | slice-1 | open |
| economics likely next wall (topN=1500 still simSuccess=0) — Codex-B re-derivation in parallel | Codex-B | slice-1 | open |
| 0x476548cc profitability: D(+0.0156) vs A/C(−0.478) — re-trace to align | orchestrator | slice-1 | open |
| latency runner-up | after slice-1 | R-after | deferred (verdict) |
| valueInEth H3b + EV-gate-off | pre-broadcast | go-live | deferred (verdict) |
