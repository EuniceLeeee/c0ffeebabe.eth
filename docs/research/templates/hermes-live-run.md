# Hermes — Live Run `<run_id>`

> **Step 0 (before anything): ensure the sleep-keeper is alive** — Codex bg runs freeze on Mac
> sleep. See HERMES.md §Rounds Step 0 (idempotent, `/tmp/mev-sleep-keeper.pid`, `caffeinate -i -d -s`).
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

**coverage_kpi (north-star trend — required in the step1 artifact, computed via `hermes-gate --emit-kpi`, NOT hand-counted):**
`competitor_legs_total` · `legs_out_of_graph` · `closable` vs `single_venue_noise` (A/B: closable = both tokens already routable → auto-enqueue candidate; single_venue_noise = must STAY 0) · `prev_round` trend link. This is the fraction of competitor arb legs routing through pools we do NOT index, trended per round. The `hermes_gate` close gate enforces it.

## Path / Leg Findings  <!-- auto -->

Representative **non-sandwich** competitor legs (sandwich legs excluded per §6/§9.5):
`canonical_sequence`, `path_template`, `pool_in_our_graph`, tokens/venues.

### Competitor cross-ref — EXACT commands to hand the fable-5 blocker-finder (verified R1/R2)
Paste these into the fable-5 sub-agent brief so it runs them ITSELF (full independence, own
primary-source scan + own traces) with zero tooling-discovery overhead. All on local reth = 0 CU.
Node: EC2 `i-0ff908dedeec9ebc6`, SSM-only. `<FROM>`/`<TO>` = the window block range.
```
# 1. watch reports (what the watchlist bots did in-window)
cd /opt/MEV/analysis && npm run analysis -- live-loss \
  --events /var/log/mev/events/searcher-live.jsonl \
  --watch 0xc0ffeebabe5d496b2dde509f9fa189c25cf29671,0xae2Fc483527B8EF99EB5D9B44875F005ba1FaE13 \
  --rpc http://127.0.0.1:8545
# 2. per-drop competitor take (arb-signature at victim real-block)
cd /opt/MEV/analysis && npm run analysis -- live-loss \
  --events /var/log/mev/events/searcher-live.jsonl --competitor-scan --rpc http://127.0.0.1:8545
# 3. our funnel + expiries (loss attribution)
tail -N /var/log/mev/events/searcher-live.jsonl | jq -r 'select(.type=="pipeline_dropped")|.stage+"/"+.reason' | sort | uniq -c | sort -rn
grep -a "opportunity expired" /var/log/mev-live.log | tail   # stage breakdown per expiry
# 4. MANUAL on-chain trace (coffeebabe EVERY in-window tx, other SAMPLED) via local reth:
cast tx <hash> --rpc-url http://127.0.0.1:8545 ; cast run <hash> --rpc-url http://127.0.0.1:8545
# 5. secondary-validate ONE key tx via Alchemy ($MAINNET_RPC_URL in /opt/MEV/.env) — keep CU tiny
```
Flags drift: read `/opt/MEV/analysis/src/cli/live-loss.ts` for exact flags; iterate the script, don't reinvent.
Hand the fable-5 sub-agent the **funnel numbers as DATA** (never a conclusion) + these commands; it
produces the raw artifacts + its own traces + the named blocker.

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
- **searcher_behavior_change:** yes | no   <!-- governance 13: two consecutive `no` escalate; after 1 observability turn the next MUST be `yes` -->

| task | owner | files | done-when |
|---|---|---|---|
|  |  |  |  |

## Acceptance Criteria
1.

## Findings Ledger  <!-- governance 13: no orphan findings -->
| finding | owner | carry_to_round | status |
|---|---|---|---|
|  |  |  | open / done / killed |

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

### Repair Replay Gate (governance 12 — run BEFORE Final Approval; `build passes` is never enough)
- **searcher_behavior_change:** yes | no
- **kind:** deterministic (path/pool/decoder/template/planner/adapter/graph → REPLAY) | non-deterministic (latency/inclusion/mempool/network/bid → METRICS)

Deterministic → replay the failing sample:
- **failing_sample:** (block / victim / tx / pool)
- **baseline_failure:** (the bucket/state before, e.g. `no_candidate_plans`)
- **fix_commit:**
- **replay_command:**
- **replay_result:**
- **expected_transition:** e.g. `pool_in_routing_graph false→true` / `candidate_plans>0` (ideally `solverEntered>0`) / poolId→token pair / old wrong number gone
- **verdict:** fixed | implemented_not_validated | deferred   <!-- only replay-proven transition = fixed -->

Non-deterministic → before/after metrics (no replay):
- **metrics_before/after:** `prep_ms p50/p95` / `solverEntered` / `pendingReceived` / `cuProxyRpcCalls` / `not_seen` rate

### Codex Implementation Pass 1
<!-- Raw evidence: /tmp/codex-pass1.out (last-message) + /tmp/codex-pass1.events.jsonl.
     Orchestrator fills this ledger AFTER checking git diff --stat + build + replay —
     Codex's own "done" is not sufficient (governance 11). -->
- **status:** landed | stalled | blocked
- **authored_by:** codex | claude (codex stalled)
- **fixed:**
- **changed_files:**
- **verification:**
- **diff_scope_check:**   <!-- git diff --stat vs brief scope: matches? over-scope? -->
- **notes:**

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
