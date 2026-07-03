# R11 — v4 long-tail coverage churn confirmed, no new blocker (2026-07-03)

> Scope: authorized defensive on-chain arbitrage research; local-reth reads; broadcast is a
> separate human-gated step, not performed here. Orchestrator = the hourly Hermes cron
> (self-driven, rule 14). This round was self-driven by the orchestrating session after
> confirming (twice, ~5min apart) that no other invocation had claimed the round lock following
> R10's clean close.

```yaml
run_id: R11-20260703
date: 2026-07-03
window: block 25448510-25448663 (153 blocks, ~30min), HEAD=0bbb250 (post-R10, no redeploy needed)
config: SEARCHER_DRY_RUN=1, SEARCHER_EV_GATE=1, SEARCHER_BRIBE_BPS=5000, universe=1500
cu_budget: <=1000 Alchemy CU
cu_spent: 0 (window pull + competitor cross-ref + all on-chain checks ran against local reth via SSM)
codex: not dispatched this round (no new blocker found; see Blocker discovery below)
turn_class: observability/validation (searcher_behavior_change: no — see rationale; allowed once after R10's extraction turn per rule 13's anti-drift cap)
```

```step1
run_id: R11-20260703
window_blocks: 25448510..25448663
watchlist: 0xc0ffeebabe5d496b2dde509f9fa189c25cf29671,0xae2fc483527b8ef99eb5d9b44875f005ba1fae13
artifact: docs/research/reports/step1-R11-20260703.json
method: manual-onchain-trace
```

## R10 carry executed
Node was already at `0bbb250` (R10's close commit) with `universe=1500`, `dry_run_env=1`,
`SEARCHER_EV_GATE=1`, `SEARCHER_BRIBE_BPS=5000` confirmed via `/proc/<pid>/environ` — no redeploy
needed. Ran a fresh ~30min window (line offset 4044, epoch 1783039701, block 25448510).

## Run Facts
101 new events: 51 `opportunity_seen`, 49 `pipeline_dropped`, **0** `simulation_result`, 1
`mempool_filter_config` — thinner than R8/R9/R10 (which each had ≥3 `simulation_result`).
`pipeline_dropped`: `no_candidate_plans`=35, `candidate-cap`=5, `expired-before-solver`=4,
`no-profitable-quote`=3, `quote-timeout`=2. No own-funnel signal pointing to a specific new
blocker this window (0 simulation_result means nothing reached the EV gate to inspect).

## R10 carry: the live production backfill (node PID 99451)
Checked in on the backfill R10 launched at its close (5 poolIds incl. `0xce2899b1...` needing a
backward-walk `Initialize` resolution). Read the actual script source
(`/opt/MEV/listener/v4-backfill-r10.mjs`) to confirm its logging behavior before judging it: it
logs to stderr at 3 fixed checkpoints only (`initLogs`, `swapLogs`, final `resolved entries`) with
**no per-poolId progress inside the resolver loop** — so a frozen log file doesn't necessarily
mean a hang.

Waited on it properly (blocking poll on the actual node PID via SSM, not just re-checking): the
process ran **2h+ total** (vs. R10's own single-poolId test of ~181s worst-case), still actively
using CPU (1-4%, not zero — genuinely working, not deadlocked), but with zero log progress for
~112 of those minutes. Given (a) R10 already independently verified `resolveV4InitBackward`
terminates cleanly even on a full 2M-block miss, so this is very unlikely a hard hang, but (b) the
one-off script has no per-poolId progress logging or wall-clock cap, so there is no way to
distinguish "almost done" from "will run for many more hours" from outside, and (c) R10's own
doc already established the code fix is deployed and live independent of this specific backfill
run completing — **killed the process this round** (PID 99451) as a diminishing-return op rather
than continuing to babysit an unbounded, unobservable one-off job across further rounds.

**Carried finding (new, small, non-blocking):** a future one-off v4 backfill script should add
either a wall-clock budget (kill/report-partial past N minutes) or per-poolId progress logging
(one line per resolved/skipped poolId), so its state is observable without needing to read source
code and reason about logging behavior mid-round, as this round had to do.

## Mandatory competitor cross-reference (local reth, zero Alchemy CU)
`analysis/src/cli/live-loss.ts --watch coffeebabe,0xae2Fc483... --events
/var/log/mev/events/searcher-live.jsonl --rpc http://127.0.0.1:8545 --from-block 25448510
--to-block 25448663`, run directly on the node. **Note:** the tool's per-run output files
accumulate under `outputs/live-loss/` without per-invocation isolation (same known issue R8/R9
flagged) — filtered strictly to the numeric block range in-window (not just filename prefix
matching) before drawing any conclusion, since a naive prefix match pulled in 53 stale
out-of-window reports from other rounds.

- **coffeebabe — 2 txs this window, verified by nonce delta** (`0x2dca5`→`0x2dca7`=2, exactly
  matches the watch tool's 2 matches). Both hand-traced (mandatory full mode): block 25448530
  (`unknown_replayable`, $0.06, dust) and block 25448539 (Sky PSM + Uniswap v4 path, $0.43, dust).
  Both `pool_in_routing_graph: null`, both dust — no meaningful capture.
- **0xae2Fc483... — 50 txs, fully swept** (nonce delta `0x62204d`→`0x62207f`=50, exactly matches
  the watch tool's 50 matches). **100% (50/50) are v4-routed with `pool_in_routing_graph: null`.**
  Pairing up the mirrored mint/burn (JIT-LP) legs and using the more-trustworthy `rough_profit`
  field (per R6's established methodology — `realized_profit_usd` on paired legs is a known
  valuation artifact) rather than the raw `realized_profit_usd`:
  - Block 25448655: `realized_profit_usd` pair nets to **+$11.38** but `rough_profit` pair nets to
    **~$0.000017** — effectively a wash. Same JIT-LP/mint-burn artifact pattern as R6/R8/R9/R10.
  - Block 25448610: ambiguous — `realized_profit_usd` pair nets ~$48.76 but `rough_profit` pair
    (37400.36/-37400.35) also nets near-zero; `unknown_opaque` path, not chased further.
  - Largest **clean** single-pair net this window: block 25448577, $7.66 (`unknown_replayable`).
  - Every other pair/single nets in the $0.05-$300 range, mostly single-digit dollars or dust.

**Classification: reconfirms two already-epic'd/classified gaps, no new finding.** (1) The v4
pool coverage frontier (100% of this window's competitor legs out-of-graph) — but this is
**long-tail churn**, not a regression: R7's backfill (655/1500 slots) and R10's Initialize-window
fix both remain deployed and correct; this window's specific pools are simply *different* pools
than what those backfills covered, because new v4 pools keep appearing faster than a periodic
one-off backfill can promote them. (2) The JIT-LP unsupported-strategy-shape gap (mirrored
mint/burn legs), reconfirmed yet again with a clean quantitative demonstration that its headline
`realized_profit_usd` numbers are frequently valuation noise, not real economics.

## Blocker discovery — not dispatched this round (judgment call, rule 14 self-served)
No dual-blind search was run. Rationale, mirroring R9's precedent: every signal this window — own
funnel (0 `simulation_result`, no new drop-reason pattern) and competitor cross-reference (100%
already-classified v4-long-tail + JIT-LP) — reconfirms **already-tracked** findings. Per rule 13,
per-pool pins are forbidden once a class is epic'd, and there is no new systemic angle this window
big enough to justify a fresh Implementation Brief (the "ongoing discovery cadence" observation
above is a real angle on the existing epic, but is itself an operational/process finding, not a
code fix ready to specify — needs more thought before it's a Codex-sized brief). Forcing a
dual-blind search onto zero new signal would be manufactured activity, not signal (rule 13's
"impact counterweight").

**Considered and explicitly deferred:** building INCREMENTAL v4 pool discovery into the periodic
loop (e.g., a scheduled small-window backfill every N hours, so newly-active pools get promoted
automatically instead of via manual one-off Hermes-round scripts) — this is the generalized fix
that would prevent every future round from re-discovering "100% v4 not in graph" as if it were
new. Not specified as a brief this round (needs a design decision: cron cadence, where it runs,
how it merges without racing the live searcher's own file reads) — carried to whichever round has
slack to scope it properly.

## Hermes gate
`cd analysis && npm run hermes-gate -- ../docs/research/reports/live-run-R11-20260703-hermes.md`
→ **PASS**. Step-1 artifact (`step1-R11-20260703.json`) hand-traces 6 txs (2 coffeebabe full-mode +
4 sampled from `0xae2Fc483`'s 50), itemizing 7 total pool-legs (7/7 out-of-graph, 5 unique
addresses after dedup — 2 txs had no pool address recoverable from logs, recorded as an explicit
placeholder rather than skipped).

## Findings Ledger
| finding | owner | carry_to | status |
|---|---|---|---|
| R10 carry: production backfill for 5 poolIds (incl. `0xce2899b1...`) | R10→R11 | R12+ | **killed, not completed** — ran 2h+ with no observable progress signal; the discovery *mechanism* fix (R10, `fixed`) is deployed and live regardless; these specific 5 poolIds remain unpromoted, open for a future re-run with proper bounding |
| one-off backfill scripts need a wall-clock cap or per-poolId progress logging | future | when slack exists | new, non-blocking — this round had to read source code mid-analysis to judge "hung vs slow"; observability gap, not a searcher-behavior gap |
| v4 long-tail pool coverage churn (100% of this window's 52 competitor legs out-of-graph, different pools than R7/R10's backfills covered) | future | monitor / epic-refinement | reconfirmed, not new in kind, but crystallizes a sharper angle: **one-off backfills can't keep pace with new pool creation** — the real fix is an ongoing/incremental discovery cadence, not another manual backfill. Not specified as a brief this round (needs design scoping) |
| JIT-LP strategy-shape gap, `realized_profit_usd` valuation-artifact quantified again (block 25448655: $11.38 nominal vs ~$0.000017 real via `rough_profit`) | future | monitor | reconfirmed, not new, already epic-classified "unsupported strategy shape" |
| classifier blind spot (`impact_pool_not_in_routing_graph` conflates no-venue vs missing-edge) | future | when slack exists | still open, non-blocking, unchanged this round (0 own-funnel samples hit this classifier this window to add evidence either way) |
| live-loss watch tool output-file accumulation across runs (no per-invocation isolation) | future | tooling | reconfirmed (R8/R9/R10/R11 all had to filter stale cross-window files); worth a small tool fix (timestamped output subdir per invocation) when a round has slack |

## searcher_behavior_change: no
No code shipped this round. Value is validation + a sharper diagnosis of the v4 coverage
frontier's real shape (churn/cadence, not a backfill-count problem) plus operational cleanup
(killed a stalled-looking one-off job). Per rule 13's anti-drift cap, this is the one allowed
observability turn following R10's `extraction` turn — R12 must ship a real behavior change or
escalate.

## Next action
Round complete: measured a fresh window (thinner than R8-R10, 0 `simulation_result`), ran the
mandatory competitor cross-reference (52/52 v4-not-in-graph, quantified the JIT-LP valuation
artifact precisely, no new finding), checked on and closed out R10's stalled-looking backfill
carry, and explicitly declined to force blocker discovery onto zero new signal. `hermes-gate`
run below. Releasing the round lock. R12 should either (a) scope the "incremental v4 discovery
cadence" idea into a real Implementation Brief (the sharpest lead from this round), or (b) if a
fresh window surfaces a different own-funnel or competitor signal, chase that instead — per rule
13, R12 needs a real `searcher_behavior_change`, not another validation-only round. External
scheduler (`hermes-hourly`, confirmed enabled) or a self-driven continuation (as this round was)
is the trigger.
