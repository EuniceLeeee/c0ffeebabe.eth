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
6. **PERSIST across deploys — fix the CLASS, not one var (conclusion-A + Codex plan-review, CONFIRMED).**
   `deploy-node.sh` rebuilds `.env` from a hand-maintained `KEYS` allowlist recovered off the running
   process (line 21-24); anything not in it is silently dropped. That's why the v3fork `topN=1500` reverted
   — **and the same footgun silently drops `SEARCHER_EVENTS_PATH` (the Hermes Step-1 precondition!), max-hops,
   plan/solver budgets, quote floors, EV/warm/mempool knobs.** Fix the class: **preserve ALL `SEARCHER_*`
   vars found in the running process env** (glob, not a hand-list), while still FORCING `SEARCHER_DRY_RUN=1`
   (broadcast guard unchanged) — plus the explicit non-`SEARCHER_` keys (RPC/keys/BOTVM). This ends the
   whole "silently dropped tuning var" class. (Code-default fix in change 1 stays the robust primary for
   topN specifically.) **Post-deploy banner assertion:** after restart, WAIT for the `pool registry:` startup
   line and FAIL loud if it's missing or shows `universe=0` (don't rely on the fixed `sleep 8`).
7. **Detail catches from plan-review (must handle, else silent wrong-loading):**
   - **`minScore` filters W3's closable pools:** discovery-queue inclusions can have `score: undefined`
     (`build-active-pool-universe.ts:315`) → `(score ?? 0) >= 1` (`pool-universe.ts:67`) drops them.
     `forceInclude` MUST bypass `minScore` (a competitor-demonstrated pool is never score-filtered), and/or
     W3 inclusions get a floor score.
   - **`forceInclude` is non-v4-only:** address-only dedup is wrong for v4 (all v4 share the PoolManager
     address). Scope `forceInclude` to concrete non-v4 pool addresses, or reject v4 entries with a clear error.
   - **`live-readiness.ts` also defaults topN to `"0"` (line 176):** after the loader change it will load
     unlimited if the file exists — acknowledge/adjust the test so it stays deterministic.

### allowed files
- `listener/src/searcher/main.ts` (config line 330 + the startup-log line 472-477 only)
- `listener/src/searcher/pool-universe.ts` (line 64 + the `forceInclude` option/logic, non-v4-scoped, minScore-bypass)
- `scripts/deploy-node.sh` (preserve-all-`SEARCHER_*` glob + the wait-for-banner / universe!=0 assertion)
- `listener/src/searcher/test/pool-universe.ts` (**new** loader unit test) — or nearest existing test file
- `listener/src/searcher/test/planner.ts` (Layer A pinned fixture, blk 25443539 WETH/`0xff208177`)
- `listener/src/searcher/test/live-readiness.ts` (adjust its topN=0 default so the loader change stays deterministic)
- **Pass B:** a fork-replay test for Layer B (`forge --fork-url` @ 25443539) — NOT `replay-live-fixtures.ts`
### forbidden
solver / planner core / token-graph / adapters / detector — this slice is **admission only** (no routing/solve logic changes).

## Plan Review  <!-- Opus 4.8 5-step: Codex critiqued this plan BEFORE code -->
- **codex verdict:** `plan-needs-changes` (3 blocking + several detail catches — all incorporated below).
- **incorporated into final plan:**
  1. **AC-3 sample facts corrected** (I had conflated cases). Per `architecture-review-20260702-conclusion-A.md`:
     the pinned load-bearing lane is **case 1 `0x476548cc` blk 25443539 WETH/`0xff208177`** via `0x15e86e6f`
     (rank 534) + `0x08650bb9` (rank 923) — both in active-pools top-1500, pruned by topN=0 — corroborated by
     **case 2 `0x5aba954d`** (same block, same pair, different bot, +0.00874 WETH, pure arb). `0x68e77ef1`
     (+$200) is at blk **25443460 WETH/`0xb1dd19b5`** = corroborating, NOT the pinned case. The `0x476548cc`
     +0.01557 (arb-leg) vs −0.478 (tx/entity incl. Amp inventory) is reconciled: use the arb-leg figure;
     case 2 de-risks it (an independent plain-arb bot cleared the same lane).
  2. **AC-3 harness corrected:** `replay-live-fixtures.ts` only re-sims pre-recorded calldata — it does NOT
     rebuild the graph / re-plan / re-solve, so it CANNOT prove `0 plans → solverEntered → simSuccess`
     (Codex verified `replay-live-fixtures.ts:78`). The +EV-sim layer needs a real fork replay, not this harness.
  3. **Deploy persistence broadened** beyond the 3 universe vars — `deploy-node.sh` silently drops ALL non-allowlist
     `SEARCHER_*` incl. **`SEARCHER_EVENTS_PATH`** (the Hermes Step-1 precondition), max-hops, budgets, quote
     floors, EV, warm, mempool. Change 6 now fixes the class, not one var.
  4. Detail catches folded into change 7: `minScore=1` would filter W3's `score:undefined` closable pools;
     `live-readiness.ts` also defaults topN=0; `forceInclude` address-key is wrong for v4 (shared PoolManager).
  5. Economics framing tightened: a non-positive SIM is sim-fidelity/sizing, NOT something an EV-gate/bribe
     config change fixes (simSuccess is upstream of the EV gate) — economics stays slice-3, not bundled here.

## Acceptance Criteria (the hard 3-段 bar — planner flip alone is NOT "fixed")

**AC-1 — loader unit (`coverage_planning_fixed` foundation):** a `loadPoolUniverse` test asserting:
(a) with the new default (topN=2000) the 2995-pool file loads a **bounded, nonzero** set (top-2000 by
score); (b) `forceInclude` promotes a specified below-cut address; (c) explicit `topN=0` now loads
**all** (unlimited). `npm run build` clean.

**AC-2 — planner flips still pass (regression):** `npm run searcher:planner` → **12/12 + 6/6**, incl.
`coverage-ovr-weth-gap→flip`, `v3fork-triangle-gap→flip`, and `single-venue-longtail` STAYS 0
(anti-fabrication guard). This is the `coverage_planning_fixed` bar — necessary, **not sufficient**.

**AC-3 — the pinned lane + a real full-pipeline replay (`production_gap_fixed` bar):**
- **Pinned lane (conclusion-A case 1+2, corrected):** block **25443539**, WETH/`0xff208177` via `0x15e86e6f`
  (rank 534) + `0x08650bb9` (rank 923) — **both in active-pools.json top-1500, both pruned from the runtime
  graph by topN=0**. Case 1 `0x476548cc` (arb-leg +0.01557 WETH) dropped `impact_pool_not_in_routing_graph`;
  case 2 `0x5aba954d` (+0.00874 WETH, a DIFFERENT bot, same block/pair) confirms the lane is independently
  arb-profitable (de-risks case 1's Amp-inventory ambiguity). `0x4e57f830` (case 2's other venue) is NOT in
  the universe file → W3/discovery domain, out of slice-1 scope.
- **Two-layer gate (the harness split — replay-live-fixtures is NOT valid for layer 2):**
  - **Layer A `coverage_planning_fixed` (deterministic, pure — `test/planner.ts`):** pinned fixture at blk
    25443539 WETH/`0xff208177`: baseline graph WITHOUT `0x15e86e6f`+`0x08650bb9` → **0 plans /
    `impact_pool_not_in_routing_graph`**; WITH both loaded → **plans>0** (`npm run searcher:planner`). This is
    the primary, cheap, deterministic flip.
  - **Layer B `production_gap_fixed` (+EV sim):** needs a **fork replay** (`forge --fork-url` / anvil at block
    25443539, or a NEW full-pipeline test that rebuilds graph + re-plans + re-solves + sims) — **NOT
    `replay-live-fixtures.ts`** (it only re-sims recorded calldata; a no-candidate baseline has none). Assert
    `sim.success && netProfit>0`; competitor arb-leg **0.01557 WETH** is the sanity ceiling. A dust/≤0 sim here
    ⇒ the lever is sim-fidelity/economics, not coverage (falsifier). **Building Layer B is Pass B's main work.**
- **Record the fixture / trace SOON (reth --full prunes ~10k blocks ≈ 33h; blk 25443539 is from this morning).**
- **verdict naming:** Layer A only → `coverage_planning_fixed`; Layer A+B → `production_gap_fixed`; never claim
  the latter from a planner flip alone.
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
- **This makes AC-3's `coverage_planning_fixed` vs `production_gap_fixed` split load-bearing** — but be precise
  about what a non-flip means (Codex correction): `simSuccess` increments UPSTREAM of the EV gate
  (`main.ts:1509` before `1619`). So if Layer A flips (plans>0) but Layer B's **sim is ≤0/dust**, that is a
  **sim-fidelity / sizing / genuine-not-+EV** signal — NOT something an EV-gate/bribe config change fixes.
  Economics config (bribe/minNet) only bites AFTER a positive sim. So the honest branch: plans>0 + positive
  sim → coverage was the lever; plans>0 + non-positive sim → sim-fidelity/sizing is next (economics is only
  relevant once a positive sim exists).
- **Run Codex conclusion B (independent EV-gate re-derivation) IN PARALLEL** with slice-1 impl — don't
  serialize; the economics slice (slice-3) should be ready the moment a positive sim exists.
- **`0x476548cc` reconciliation RESOLVED (see Plan Review):** arb-leg +0.01557 WETH (conclusion-A) vs
  −0.478 (tx/entity incl. Amp inventory) — use the arb-leg figure; case 2 `0x5aba954d` (+0.00874, independent
  bot, same lane) confirms it. Pass B's fork trace re-verifies before the +EV ceiling is trusted.

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
