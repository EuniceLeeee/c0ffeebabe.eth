# Hermes — Live Run `<run_id>`

> One run, one file. Each agent writes **only its own sections**, never edits the other's.
> Each round = **one core judgment + one next_action + one not_doing**.
> **`Claude Final Decision` is the only section that drives code.**
> md auto-commit/push; raw log / raw JSONL / secrets never committed.

```yaml
run_id:
date:
window:        # block <from>..<to> (~N blocks / ~M min)
config:        # SEARCHER_LIVE_BACKEND= / mempool= / OPP_TTL_MS= / SOLVER_DEADLINE_MS= / ...
inputs:
  redacted_log:
  redacted_events_summary:
  coverage_report:
  key_tx_links: []
```

---

## Run Facts  <!-- auto -->

```
funnel: hints / impacts / opportunities / plans / solverEntered / solverSuccess / simSuccess / submitAttempts
        expiredBeforeSolver / quoteTimeouts / simReverts / missingState
mempool: pendingReceived / pendingFilteredReceived / cuProxyRpcCalls
dominant pipeline_dropped reason:
```

## Auto Analysis  <!-- auto -->

- structured `pipeline_dropped` breakdown (use events, not log substrings)
- `no_candidate` classification distribution (9.4/9.5 buckets)
- sim outcomes (ok / sim-revert / no-profitable / failure_reason)

## Competitor Coverage  <!-- auto: analysis live-loss --coverage, same window -->

```
ours:        opportunity_seen / unique_victims / submitted / included
competitor:  executed_total / exact_victim_seen / same_pool_seen / not_seen_by_us
classification: sandwich_excluded / non_sandwich_candidate / standing / unknown
not_seen primary_reason: { router_not_watched / pool_not_in_graph / standing_not_victim_triggered / ... }
completeness_pct:        partial:
```

## Path / Leg Findings  <!-- auto -->

Representative **non-sandwich** competitor legs (sandwich legs excluded per §6/§9.5):
`canonical_sequence`, `path_template`, `pool_in_our_graph`, tokens/venues.

---

## Codex Round 1
- **core judgment:**
- **next_action:**
- **not_doing:**

## Claude Round 1
- **core judgment:**
- **next_action:**
- **not_doing:**

## Codex Review Of Claude
-

## Claude Review Of Codex
-

## Codex Final View
- **core judgment:**
- **next_action:**
- **not_doing:**

## Claude Final View
- **core judgment:**
- **next_action:**
- **not_doing:**

---

## Claude Final Decision  <!-- AUTHORITATIVE — only this drives code -->
- **decision:**
- **rationale (1-2 lines):**

## Implementation Brief
| task | owner | files | done-when |
|---|---|---|---|
|  |  |  |  |

## Acceptance Criteria
1.

---

## Codex Implementation Notes
-

## Claude Code Review
-

## Codex Fixes / Review Response
- **fixed:**
- **deferred:**
- **verification:**

## Claude Final Approval
- **approved:** yes / no
- **follow-ups (if any):**

---

## Next Run
- **config changes:**
- **what this run should answer:**
