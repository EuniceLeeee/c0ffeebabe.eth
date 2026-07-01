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
cu_budget:     # per-run CU cap set BEFORE the turn (anti-blowout)
cu_spent:      # actual, fill at close
codex:         # landed | stalled  (governance 11 — track generator reliability)
turn_class:    # extraction | observability-only  (governance 12 — see Repair Replay Gate)
inputs:
  redacted_log:
  redacted_events_summary:
  competitor_cross_reference:   # analysis live-loss --watch <WATCHLIST> --graph-pools <dump> (mandatory Step 1)
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

## Implementation / Review-Fix Loop

Max **3** review/fix passes per implementation cycle. After pass 3, Claude must
write Final Approval or stop with an explicit not-approved/deferred/blocked
decision and owner.

**Evaluator rule (anti-Nodding):** the evaluator = whoever did NOT author the
artifact. Every Claude Review pass must fill `ran_gate:` (the build / test /
replay / dry-run / diff-check actually executed) and `finding:` (what it found,
or "ran X, found nothing → pass"). An approve with **neither** is invalid; "two
models" does not substitute for a real run gate.

**Codex fallback (governance 11):** if `codex exec` stalled twice (exit 0, empty
`git status`), set `codex: stalled`. Claude may transcribe ONLY fully-specified
mechanical edits, labelled `authored_by: claude (codex stalled)`; judgment/design
work stops and waits — never solo.

### Repair Replay Gate (governance 12 — run BEFORE the next dry-run)
- **turn_class:** extraction | observability-only
- **fixture:** `{ block, victim/impact, pool, tokens }` (pinned; note if it needs archive)
- **assert (correctness):** e.g. `no_candidate → plans>0` / pool routes / `sim.success` — flipped? yes/no
- **assert (latency):** same fixture before/after → `seg` per-stage ms delta (RELATIVE only; harness must reproduce the cold-state/backend latency source, else untrusted)
- **result:** flipped=... | no fixture → logged observability-only (does NOT count as improving extraction)

### Codex Implementation Pass 1
- **authored_by:** codex | claude (codex stalled)
- **fixed:**
- **verification:**

### Claude Review Pass 1
- **ran_gate:**
- **finding:**
- **blocking:**
- **P1 in-scope:**
- **P2/deferred:**
- **approve_or_continue:** continue / final_approval

### Codex Fix Pass 1
- **fixed:**
- **deferred:**
- **verification:**

### Claude Review Pass 2
- **ran_gate:**
- **finding:**
- **blocking:**
- **P1 in-scope:**
- **P2/deferred:**
- **approve_or_continue:** continue / final_approval

### Codex Fix Pass 2
- **fixed:**
- **deferred:**
- **verification:**

### Claude Review Pass 3
- **ran_gate:**
- **finding:**
- **blocking:**
- **P1 in-scope:**
- **P2/deferred:**
- **approve_or_continue:** final_approval / not_approved / deferred / blocked

### Codex Fix Pass 3  <!-- only if Claude Review Pass 3 requests a final bounded fix -->
- **fixed:**
- **deferred:**
- **verification:**

<!-- Do not add pass 4. If pass 3 is still not acceptable, Claude stops the cycle with an explicit decision/owner. -->

## Claude Final Approval
- **approved:** yes / no
- **follow-ups (if any):**

---

## Next Run
- **next_state:** continue | collect_more | analyzer_first | replay_first | implement | stop
- **live_allowed:** yes / no   # yes only if all hard gates passed
- **config changes:**
- **what this run should answer:**
