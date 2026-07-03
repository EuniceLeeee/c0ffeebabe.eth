# Hermes Impl Cycle R12-20260703

> Lean implementation cycle (epic slice-1, following the R11 architecture review's
> `decision: epic` verdict — see `docs/research/reports/arch-review-20260703-verdict.md`).
> Scope: authorized arbitrage research; fork/dry-run; broadcast is a human gate.
> Codex = generator; Claude = non-author evaluator.

```yaml
cycle_id: R12-20260703
date: 2026-07-03
orchestrator: Sonnet 5 (autonomous hermes-hourly scheduled run)
cu_budget: 1000 (per-fire cap; this cycle used 0 Alchemy CU — all analysis/gates local reth + local build)
cu_spent: ~0
codex: landed
```

## Decision + Implementation Brief
- **goal / root cause:** R11's architecture review found atomic-loop opportunities on deep
  ETH/stablecoin venues are structurally dust (falsifier: negative net profit at every size
  0.1–10,000,000 WETH on a real block-25447685 triangle). Root cause of *why* longtail
  wide-spread pairs aren't in our graph: pool-universe `score` = recent swap-log count, which
  systematically favors high-traffic efficient venues and crowds low-traffic high-fee pairs out
  of the top-1500 cutoff (e.g. real pair `0x1151CB3d.../USDT`, fee 10000, scores 7/9 — excluded,
  first documented back in R4).
- **searcher_behavior_change:** yes — pool-universe admission now reserves a bounded quota for
  high-fee/wide-spread pairs otherwise excluded by score rank.
- **allowed files:** `listener/src/searcher/pool-universe.ts`, `listener/src/searcher/main.ts`,
  `listener/src/searcher/test/pool-universe.ts`, `listener/src/searcher/test/planner.ts`.
  **forbidden:** EV gate / bribeBps / defaultGasUsed / economics config (confirmed correct by
  R11, out of scope); v4 pool-discovery code (separate landed epic).
- **changes:** `pool-universe.ts` adds `selectRankedPools()` — reserves
  `highSpreadPairQuota` (default 150) of the top-N slots for pools with `fee >= highSpreadMinFee`
  (default 10000) not already admitted by score rank, one pool per distinct token pair (dedup via
  existing `unorderedTokenPairKey`/`poolRegistryKey` helpers — no new dedup logic). `main.ts` wires
  `SEARCHER_POOL_UNIVERSE_HIGH_SPREAD_PAIR_QUOTA` / `SEARCHER_POOL_UNIVERSE_HIGH_SPREAD_MIN_FEE`
  env vars + startup banner fields.
- **gate command(s):** `cd listener && npm run build`, `npx tsx src/searcher/test/pool-universe.ts`
  (8/8), `npx tsx src/searcher/test/planner.ts` (12/12 + replay fixtures + new high-spread replay).

## Codex Implementation Pass
- **status:** landed
- **authored_by:** codex
- **changed_files:** `listener/src/searcher/pool-universe.ts`, `listener/src/searcher/main.ts`,
  `listener/src/searcher/test/pool-universe.ts`, `listener/src/searcher/test/planner.ts`
- **verification:** `npm run build` clean; `pool-universe PASS (8/8)`;
  `planner PASS (12/12) + replay fixtures (12/12) + high-spread universe replay`
  (all re-run locally by the orchestrator, not just trusted from Codex's own report).
- **diff_scope_check:** matches allowed files exactly (4 files). An unrelated, pre-existing
  modification to `scripts/deploy-node.sh` (the user's own separate live-broadcast-envelope work,
  per a harness note) was present in the working tree but deliberately excluded from this commit —
  Codex's own report flagged it as untouched.

## Gate + Final Approval
- **kind:** deterministic (pool-universe admission / graph coverage) → planner replay flip.
- **failing_sample:** real pair `0x1151CB3d861920e07a38e03eEAd12C32178567F6`/USDT, pools
  `0x5ea523e496D049e2bA8B303C8D85C83FB6F285F8` (score 7) and
  `0x1e84865E17B49286f26D356DC39fF671EDfaA199` (score 9), fee 10000 — both below a naive
  score-only top-1500 cutoff (first documented R4, run `9a20d602`, blocks 25444461/25444621).
- **baseline_failure:** `test/planner.ts` `r4-1151-usdt-pair-gap` fixture / new
  `testHighSpreadUniverseSelectionReplay`: score-only selection (`highSpreadPairQuota:0`) →
  **0 plans**, `classification: impact_pool_not_in_routing_graph`.
- **replay_command:** `npx tsx listener/src/searcher/test/planner.ts`
  (`npm run searcher:planner` hits an unrelated sandbox `tsx` IPC `EPERM` in some environments;
  the direct `tsx` invocation is equivalent and was used for verification here and by Codex).
- **replay_result:** WITH `highSpreadPairQuota:150, highSpreadMinFee:10000` + existing
  pair-completion → both real pools admitted → **1 plan** (`expected_transition` confirmed,
  `impact_pool_not_in_routing_graph` → plans>0).
- **expected_transition:** `impact_pool_not_in_routing_graph` (score-only excluded) →
  `candidate_plans>0` for a real, previously-documented high-fee pair. Confirmed.
- **verdict:** **fixed** (mechanism-level, rule-12 compliant — deterministic replay flip both
  directions verified independently by the orchestrator, not just Codex's self-report).
- **fix_commit:** `5266555`.
- **hermes_gate:** not run this cycle — this is a mechanism-level implementation gate
  (rule-12 replay), not a live-run analysis window; `hermes-gate` applies to live-run-analysis
  cycles per the lean-template note. The NEXT live measurement window (R13) will show whether
  this shifts real `simSuccess`/coverage-KPI numbers.

## Post-deploy live sanity check (not a full validation window — see caveat)
Deployed `30ba112` to the node (`scripts/deploy-node.sh`, `mode=DRY` confirmed, no live marker
present). Startup banner confirmed the fix is wired: `highSpreadPairQuota=150
highSpreadMinFee=10000`; universe pair-completion grew 284→323 pools (consistent with the quota
admitting previously-excluded high-fee pairs). A ~31.5min sanity window (blocks 25448833→25448990,
111 events, 53 `opportunity_seen`) showed **2 `simulation_result` events** (both `ok:true`, dust —
gross ~$0.03-0.06, correctly rejected by `below_ev_gate` after gas+bribe) — more pipeline depth
than R10/R11's flat-zero windows, though these two happened to be an unrelated v4/PSM path, not
the specific high-fee pairs the fix targets. `no_candidate_plans` sub-classification: 37/38
`only_immediate_same_pool_reverse` (correctly pruned), 1/38 `impact_pool_not_in_routing_graph`.
**This single small window is NOT sufficient to conclude the fix's live effect either way** (R3-trap
rule — a 31min/53-opportunity sample is too thin for a coverage-KPI verdict); it confirms the
deploy is clean and non-regressive. A proper before/after coverage-KPI comparison (how many
high-fee/wide-spread pairs actually enter `opportunity_seen` pre- vs post-fix, over an hours-scale
window) is carried to the next round.

## Session handoff (ending this extended loop here — see rationale)
This session ran the R11 architecture review end-to-end (dual-blind, falsifier-confirmed) and
shipped + gated + deployed R12's epic slice-1 in the same continuous run. During this run, `git log`
revealed a **second, concurrent Hermes session** also operating on this repo (it independently
produced its own `live-run-R11-20260703-hermes.md` + `step1-R11-20260703.json`, and separately
committed a `deploy-node.sh` change adding a bounded live-broadcast mode) — no file conflicts
occurred (different filenames), but round-numbering has collided (two independent "R11"s exist).
Rather than keep chaining `ScheduleWakeup` for more hours in this single session (which would only
duplicate what the independently-scheduled `hermes-hourly` cron already does on its own cadence,
and increases the chance of colliding further with the concurrent session), this session's active
work concludes HERE at a clean checkpoint: architecture review closed, epic slice-1 shipped/gated/
deployed, initial non-regressive sanity check done. The round lock is released below so the next
`hermes-hourly` firing (a fresh session, reading current repo state per its own Step 1) can proceed
without contention.

**Stronger reason to stop here, discovered after the above was written:** the concurrent session
(Opus 4.8) went further while this session was running — it read this round's R11/R12 work, ran its
own independent 3-way synthesis (Fable-A blind + Codex re-review), converged that R12's high-spread
admission is the right lever but unproven live, found a genuinely new gap (**no on-chain-inclusion
event** — `accepted` from a builder is not "mined"), and is now running the natural next step
itself: a **multi-hour bounded-live measurement** (see
`docs/research/reports/arch-review-20260703-live-synthesis.md`). Confirmed on the node: `.deploy-live`
marker present, `SEARCHER_DRY_RUN=0`, `SEARCHER_EV_GATE=1` — bounded-live is ACTIVE right now, inside
the CLAUDE.md-documented ≤0.2 ETH test-wallet envelope authorized by the user 2026-07-03. This session
will NOT redeploy, restart, or otherwise touch the node while that measurement is running — doing so
could interrupt a live (if tiny-stakes) in-flight bundle. No further action from this session;
ownership of the live-measurement phase belongs to the concurrent session.

## Findings Ledger
| finding | owner | carry_to | status |
|---|---|---|---|
| epic slice-1: high-spread pool-universe quota | R12 | — | **done** — fixed, gated via planner replay flip, commit `5266555`, deployed live (`30ba112`), banner-confirmed |
| proper before/after coverage-KPI measurement (hours-scale window) | R12 | R13 | open — this round's 31min sanity check is too thin to conclude live effect |
| discovery-queue.json 6 stale entries, never drained since 20260702 | future | when slack exists | open, non-blocking |
| R10 v4 production backfill (pid changed 99451→110950, still running) | R10→R12 | R13 | check status, likely still running or finished — merge into active-pools.json if done |
| epic slice-2+ (if slice-1's live effect is small): consider whether `highSpreadPairQuota=150` / `highSpreadMinFee=10000` are the right defaults, or need tuning from live data | future | R13+ | open |
| concurrent Hermes session detected (own R11 doc + deploy-node.sh live-mode change) — round-numbering collision, no file conflict | R12 | R13 | open, non-blocking — be aware when picking the next round number |
