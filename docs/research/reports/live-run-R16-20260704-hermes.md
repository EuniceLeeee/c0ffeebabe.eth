# Hermes Round R16-20260704 — impl-cycle (victim-source-quality slice-1)

> Scope: authorized, defensive on-chain arbitrage research. Node runs bounded-live inside the
> script-enforced envelope (Safety Rule 1): `.deploy-live` marker + signer wallet ≤ 0.2 ETH +
> `SEARCHER_EV_GATE=1`; flash-arbs are atomic so principal is never at risk. Broadcast outside the
> envelope stays a human gate. Autonomous round (user away — decide + proceed per rules 14/15).

```yaml
cycle_id: R16-20260704
date: 2026-07-04
orchestrator: Fable 5 (autonomous hermes scheduled run)
type: implementation-cycle (lean; blocker already diagnosed in R15 — no new discovery window)
generator: Codex (gpt-5.5 xhigh, scripts/codex-run.sh workspace-write)
evaluator: Fable 5 (non-author; ran build + rule-12 flip + planner regression + diff review)
cu_budget: 1000 (per-fire cap)
cu_spent: ~0 (local build/tests + node deploy over SSM; no Alchemy)
codex: landed (victim-source-quality slice-1; rule-12 gate flips; evaluator re-ran all gates)
searcher_behavior_change: yes (admission now skips proven serial-reverting victim sources → removes phantom +EV submissions)
hermes_gate: n/a (impl-cycle, no new measured window/competitor cross-ref this cycle; gated by the rule-12 replay flip)
```

## Why this cycle (no re-analysis — R15 already diagnosed it)
R15 (`8a0d120`) found the phantom-victim flow-admission gap: all 14 bounded-live submissions followed
pending swaps that reverted on-chain (Uniswap v4 swaps via UniversalRouter reverting on their own
mine-time slippage, from 4 repeat-reverting EOAs). We already gate victim `receipt.status===1` but only
in isolation-at-head (`main.ts:1054-1057`); the revert is a race/ordering property invisible then. R15
escalated the fix as `decision: epic (victim-source-quality-scoring)`, slice-1 owed by R16. This cycle
ships slice-1. (The stale R15 fallback wakeup fired after R15 had already closed; per rule 14 the
productive action was to discharge R16's owed fix rather than redo R15 or idle.)

## Implementation (Codex writes → Fable evaluates + gates)
- **NEW `listener/src/searcher/detector/victim-source-quality.ts`** — pure `VictimSourceTracker`:
  per-sender land/revert ring buffer (`ringSize` 8); `shouldSkip(sender, block)` = `enabled` AND
  `>= minStreak` outcomes with `block >= currentBlock - windowBlocks` AND the most recent `minStreak`
  in-window outcomes ALL `landed === false`. Any in-window success in that recent streak re-admits.
  Deterministic, no I/O.
- **`listener/src/searcher/main.ts`** (+96 lines):
  - config `victimSourceFilter { enabled (env `SEARCHER_VICTIM_SOURCE_FILTER` default ON), minStreak
    (`_MIN_STREAK`=3), windowBlocks (`_WINDOW_BLOCKS`=200), ringSize 8 }`, logged in the startup banner.
  - **Admission skip** in `handleHint` after `eventFrom` is known and BEFORE `detect`/`opportunity_seen`
    (~1213): if `eventFrom !== ZeroAddress` and `victimSource.shouldSkip(...)` → emit `pipeline_dropped`
    `stage=admission reason=victim_source_low_landrate` + `return`. `eventFrom` is initialized to
    `ethers.ZeroAddress` (line 1019) so `.toLowerCase()` can never crash on undefined.
  - **Outcome feedback (opportunistic, no new timer):** a bounded `pendingVictimOutcomes` queue (cap
    200); enqueue `{sender, hash, targetBlock}` when a real victim-bundle is followed; at the top of
    each hint, `drainPendingVictimOutcomes` records `landed = receipt.status===1` for any victim whose
    `targetBlock < head` (local reth `getTransactionReceipt`, zero-CU, try/catch — never throws into the
    hot path; unresolved entries retained).
- **NEW `listener/src/searcher/test/victim-source-filter.ts`** + `searcher:victim-source-filter` script.

## rule-12 repair-replay gate
- `failing_sample:` real R15 sender `0x295fc34f1742c4e8bd1bfeb3711be567919fa72d` with its actual
  reverting-victim blocks 25453305 / 25453309 / 25453357.
- `baseline_failure:` with only **2** in-window reverts recorded, `shouldSkip === false` (streak not
  met → admitted). This is the pre-fix behavior (a no-op filter would also fail the positive assert).
- `fix_commit:` `d53cdac`.
- `replay_command:` `cd listener && npm run searcher:victim-source-filter`.
- `replay_result:` `PASS streak_skip=true recovery=true window=true disabled=true independent=true`
  (evaluator ran it locally, not under Codex's sandbox stub).
- `expected_transition:` admission `victim_source_skip false→true` for a sender after 3 in-window
  reverts (admitted at 2 → skipped at 3); recovery/window/disabled/independent controls all hold.
- `verdict:` **fixed** (deterministic flip confirmed; the positive+negative asserts together prove the
  behavior is real, not a no-op).
- **Regression:** `npm run build` clean; `searcher:planner` PASS (14/14 + replay 12/12 + high-spread
  universe) — the CFG v4 route-gap flip still PASS (no over-rejection).

## Evaluator (Fable, non-author)
- `ran_gate:` built (clean); ran `searcher:victim-source-filter` (PASS, in my env — Codex could only run
  it under a sandbox tsx stub); ran `searcher:planner` (PASS); reviewed every diff hunk (4 files,
  +97/-0 tracked + 2 new files, scope-clean, only the allowed files).
- `finding:` (1) two `emitPipelineDropped` closures now exist (1194 Codex + 1296 original) — build-legal
  (separate lexical scopes), mild redundancy, NOT a correctness issue → not blocking. (2) `eventFrom`
  crash risk checked and refuted (initialized to ZeroAddress). (3) the rule-12 test uses the REAL R15
  sender + blocks and asserts the flip → genuine. → approved + committed + deployed.

## Deploy + mode-preservation
- Deployed `d53cdac` via `deploy-node.sh`; node HEAD == origin/main, fresh restart (PID 152902, uptime
  48s), mode **preserved bounded-LIVE** (`dry_run_env=0`, `.deploy-live` present, EV_GATE=1),
  universe=1500 (4931 pools). **Banner confirms the fix is live:**
  `[searcher/live] victimSourceFilter enabled=on minStreak=3 windowBlocks=200`.
- Safety valve: signer `0xb8578B6…DA3c` balance unchanged (no live submission fired this cycle); ≥50%
  of baseline → no circuit-break.

## Findings Ledger (carry)
| finding | owner | carry_to | status |
|---|---|---|---|
| Phantom +EV on reverting victims — victim-source-quality **slice-1** (sender revert-streak admission skip) | R16 | — | **CLOSED (implemented + rule-12 gated + deployed)**; **live confirmation carried to R17** ([[project-phantom-victim-flow-admission-epic]]) |
| Victim-source-quality **live before/after** — does `victim_source_low_landrate` fire + do phantom submits (reverting-victim bundle_submitted) drop vs R15's 14/14? | R17 | R17 | open — measure next window (non-deterministic funnel metric, rule-12-exempt; before=R15 14 phantom submits) |
| Victim-source-quality **slice-2** (richer source scoring: land-rate ratio not just streak; per-sender decay; sender + pool joint quality) | epic: victim-source-quality-scoring | R18 | open — only if slice-1's streak filter proves insufficient in R17 metrics |
| `no_candidate_plans` ~52% — single-pool-token return-venue gap | pool-scoring epic | R17 | open — EPIC (arb-relevance scoring); no per-pool pins ([[project-pool-scoring-arb-relevance-epic]]) |
| Atomic-backrun market ceiling → posture decision (private orderflow / other strategy class) | posture (human gate) | when human decides | open — the true distance-to-production lever; human gate ([[project-atomic-backrun-market-ceiling]]) |
| Thin hookless v4 `NotEnoughLiquidity` residual | R14→R17 | R17 | open — measure-first |
| R10 v4 production backfill (systemd `v4-backfill-r14`) | R10→R17 | R17 | open — hookless subset only (swap-hooked now rejected at admission) |

## Verdict + close
- **verdict:** impl-cycle complete. Shipped victim-source-quality **slice-1** (sender revert-streak
  admission skip) — the R15 phantom-victim epic's first slice. Generator Codex, evaluator Fable
  (non-author) ran all gates: **rule-12 flip PASS** (real R15 sender, admitted@2-reverts →
  skipped@3-reverts), build clean, planner regression PASS. Deployed bounded-LIVE, mode preserved,
  **banner confirms the filter is on** (`enabled=on minStreak=3 windowBlocks=200`).
  searcher_behavior_change: **yes** (removes phantom +EV submissions from proven serial-reverting
  sources).
- **carry:** live before/after of the filter (R17 — does `victim_source_low_landrate` fire + phantom
  submits drop from R15's 14/14?), slice-2 source scoring (R18, only if needed), pool-scoring epic
  (R17), posture decision (human gate).
