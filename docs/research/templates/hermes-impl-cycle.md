# Hermes Impl Cycle `<cycle_id>`

> **Step 0 (before anything): ensure the sleep-keeper is alive** — Codex bg runs freeze on Mac
> sleep. See HERMES.md §Rounds Step 0 (idempotent, `/tmp/mev-sleep-keeper.pid`, `caffeinate -i -d -s`).
> **Lean template for an IMPLEMENTATION cycle** — a known fix → code → gate → merge.
> For a genuine LIVE-RUN ANALYSIS (run searcher → drop attribution → competitor
> cross-reference → decide the fix) use the full `hermes-live-run.md` instead.
> Scope: authorized arbitrage research; fork / dry-run; broadcast is a human gate.
> Codex = generator; Claude = non-author evaluator. md auto-commit/push; no secrets/raw logs.

```yaml
cycle_id:
date:
orchestrator:   # Fable 5 (3-step: plan → Codex writes → review) | Opus 4.8 (5-step: + Codex plan-review + final plan)
cu_budget:      # set before the turn
cu_spent:       # fill at close
codex:          # landed | stalled
```

## Decision + Implementation Brief  <!-- AUTHORITATIVE — only this drives code -->
- **goal / root cause:**
- **searcher_behavior_change:** yes | no   <!-- rule 13: two consecutive `no` escalate -->
- **allowed files:** (only these)  ·  **forbidden:** (everything else)
- **changes:** (pinned file/anchor list — surgical)
- **gate command(s):**

## Plan Review  <!-- Opus 4.8 5-step only; skip for Fable 5 -->
- **codex verdict:** plan-ok | plan-needs-changes → (the changes)
- **incorporated into final plan:**

## Codex Implementation Pass  <!-- orchestrator fills AFTER git diff --stat + build + gate; Codex "done" ≠ enough -->
- **status:** landed | stalled | blocked
- **authored_by:** codex | claude (codex stalled, mechanical-only)
- **changed_files:**
- **verification:** (build + gate output)
- **diff_scope_check:** (git diff --stat vs allowed files — matches? over-scope?)

## Gate + Final Approval  <!-- rule 12 Repair-Replay; "build passes" is never enough -->
- **kind:** deterministic (path/pool/decoder/planner/adapter/graph → REPLAY flip) | non-deterministic (latency/inclusion/mempool → METRICS before/after)
- deterministic → **failing_sample / baseline_failure / replay_command / replay_result / expected_transition**
- non-deterministic → **metrics_before/after** (e.g. expired-before-solver rate, solverEntered, prep_ms p50/p95)
- **verdict:** fixed | implemented_not_validated | deferred
- **fix_commit:**
- **hermes_gate:** PASS (`cd analysis && npm run hermes-gate -- <this md>`) — the Step-1 close gate; requires the ```step1``` artifact below to carry `coverage_kpi` (competitor_legs_total / legs_out_of_graph, computed via `--emit-kpi`; the closable vs single_venue_noise A/B split; `prev_round` trend link). Prose cannot satisfy it.

```step1
run_id:
window_blocks:        # <from>..<to>
watchlist:            # all EOAs from analysis/config/live-competitors.json
watchlist_profile:    # profile_id from analysis/config/live-competitors.json
artifact:             # docs/research/reports/step1-<run_id>.json  (must include coverage_kpi)
method:               # manual-onchain-trace | live-loss-watch
fable_manual: no      # yes only when the fable-5 blocker-finder handoff ran
```

## Findings Ledger  <!-- rule 13: no orphan findings -->
| finding | owner | carry_to | status |
|---|---|---|---|
|  |  |  | open / done / killed |
