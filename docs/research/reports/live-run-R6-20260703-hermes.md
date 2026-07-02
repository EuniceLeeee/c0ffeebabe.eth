# R6 — EV-gate flip measurement (2026-07-03)

> Scope: authorized defensive on-chain arbitrage research; local-reth reads; broadcast is a
> separate human-gated step, not performed here. Orchestrator = the hourly Hermes cron
> (self-driven, rule 14).

## Judgment call: resuming after the R5 concurrent-session stand-down

R5 stood down 4 consecutive fires (01:08 / 01:37 / 02:04 / this fire at 02:08) over a
concurrent-session collision: PID 77146/77145 (a resumed `claude-opus-4-8 --effort xhigh`
session, `68cdc92e-...`) building arch-review-2's slice-2 (`SEARCHER_PAIR_FLOOR`) has been alive
since 2026-07-02 10:46.

New evidence this fire changes the call:
- PID still alive at **15h27m**, but **0.1-0.4% CPU** across every check this fire and the prior
  one — consistent with an idle/stalled process, not active computation.
- `git status --short` clean, matching `origin/main`, for 3 consecutive checks over ~1h (01:37,
  02:04, 02:08) — no WIP diff has reappeared.
- Zero commits from that session in 15h27m.

**Decision (rule 14, self-served):** treat the collision risk as low enough to resume the normal
round protocol, with one safeguard — **do not edit `main.ts`, `pool-universe.ts`, or
`test/pool-universe.ts`** this round (the exact files the other session's WIP touched), so even if
it wakes mid-round there is no file-level collision. Everything else (deploy, dry-run window,
analysis, non-pool-universe fixes) proceeds. Indefinite stand-down without new evidence is itself
a null-round pattern rule 13 warns against; 4 consecutive no-op fires on an idle process is enough
signal to act rather than poll a 5th time.

## R4 carry executed: EV-gate flip measurement

R4 (commit `f721651`) fixed the `gasUsed=0n` sim-fidelity bug and left as carry: "measure the
EV-gate flip's effect" once a clean deploy window was available. Executed this fire:

1. Deployed latest `main` (`ead98ec`) via `scripts/deploy-node.sh` — confirmed `universe=1500`
   (not the `topN=0` regression) and `dry_run_env=1` in the restart banner.
2. Flipped the minimal slice-3 knobs from `epic-coverage-slice1-20260702.md`'s spec
   (`SEARCHER_EV_GATE=1`, `SEARCHER_BRIBE_BPS=5000`, `MIN_NET_ETH` left at its `0` default) by
   editing `/opt/MEV/.env` directly and restarting `mev-searcher`. Verified via
   `/proc/$PID/environ`: `SEARCHER_EV_GATE=1`, `SEARCHER_BRIBE_BPS=5000`, `SEARCHER_DRY_RUN=1`,
   `SEARCHER_EVENTS_PATH=/var/log/mev/events/searcher-live.jsonl` all present on the restarted PID
   (88744).
3. Window start recorded: events file at line offset **2980**, epoch **1783015993**
   (2026-07-02 18:13 UTC), start block **25445519** (`0x184488f`) on the local reth node.

## Window in progress
~30-min dry-run window running now with EV gate ON for the first time since the gasUsed fix.
Self-scheduling a wakeup at +30min to pull `pipeline_dropped`/`simSuccess` events from offset 2980
onward, run the mandatory competitor cross-reference, and determine whether EV_GATE=1 changes the
`simSuccess` funnel stage (previously dust-only per R2/R3) now that gas is realistically priced
instead of the 12M/24M fallback.

## Findings Ledger (carried + new)
| finding | owner | carry_to | status |
|---|---|---|---|
| concurrent-session collision (PID 77146) | human | monitor | **downgraded** — idle 15h27m, tree clean 3 checks; resumed round with file-level safeguard (no `main.ts`/`pool-universe.ts`/`test/pool-universe.ts` edits this round) |
| R4 carry: measure EV-gate flip effect | R4→R6 | this fire | **in progress** — window running, EV_GATE=1/BRIBE_BPS=5000 live since 18:13 UTC, results pending at +30min wakeup |
| classifier blind spot (`impact_pool_not_in_routing_graph` conflates no-venue vs missing-graph-edge) | future | R6+ | open, non-blocking (R4) |
| build-time discovery-queue chicken-egg (`not_closable_in_current_graph`) | future | R6+ | open, non-blocking (R4) |

## searcher_behavior_change: pending (config-only flip this turn; verdict depends on window results)

## Next action
Self-scheduled wakeup in ~30 min to pull window results and continue the round (pull events,
mandatory competitor cross-ref, dual-blind blocker-find if `simSuccess` is still 0/dust, or flag
for human broadcast review if a genuine +EV non-dust `simSuccess` appears — per rule 3, never
broadcast autonomously).
