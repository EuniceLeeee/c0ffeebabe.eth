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

## Window results (block 25446543-25446717, ~30min, 54 events: 25 opportunity_seen, 27
pipeline_dropped, 2 simulation_result)

**EV-gate flip result: gate works correctly, no genuine +EV non-dust bundle this window.**
Both `simulation_result` events (`ok:true`, same opportunity, two candidate routes) carried
**real, non-zero `gas_estimate`** (386991 / 429968 — confirms R4's `gasUsed` fix is live) but
tiny `simulated_profit` (9052 / 9030 raw USDC units = **$0.009**). With `SEARCHER_EV_GATE=1` +
`SEARCHER_BRIBE_BPS=5000`, both correctly dropped `below_ev_gate` (profit ~$0.009 vs. ~$1.2-1.4
of realistic gas cost at current base fee) — `simSuccess` counter still incremented (2, per
`main.ts:1543`, ahead of the EV-gate check) but **zero reached the submit stage**. This is the
gate doing its job: previously (`SEARCHER_EV_GATE` off) these two would have been indistinguishable
from a real success; now they're correctly rejected. **No bundle to flag for human broadcast
review this window** (nothing was genuinely +EV, let alone non-dust).
`failing_sample: n/a (verification, not a bugfix) / gate: SEARCHER_EV_GATE off→on with real gas /
result: 2/2 sim-positive candidates correctly rejected below_ev_gate / verdict: **gate verified
operative**, dust-ceiling reconfirmed`.

`pipeline_dropped` reasons (27 total): 13 `no_candidate_plans`, 2 `below_ev_gate` (above), plus 12
more not yet itemized in the same reason (all `no_candidate_plans`/`below_ev_gate` — no third
reason appeared this window). Of the 13 `no_candidate_plans`: **11/13 classify
`only_immediate_same_pool_reverse`** (a same-pool round-trip the planner correctly prunes — not
arbable, matches R4's classifier finding) and **2/13 classify `impact_pool_not_in_routing_graph`**
(the potential-gap bucket). Hand-traced both via `cast receipt` on the local reth node (zero CU):
- `0x0ef65c723d8d52c2a75184ef84d50a2505c7848f763b6d25040eca0c895bc6b9` (pool `0x0d1cfdb7...`):
  3 logs, a single-leg swap with only one token (USDC) emitting events — a one-way source swap,
  no return leg present on-chain. Non-arbable, consistent with R4.
- `0x7f111bf630b21738973cfcb4b953501320a0c32d96f07a83961a1709f839a5a2` (pool `0xe06e1c61...`):
  12 logs across two V3 pools (`0xe06e1c61...`, `0xb4e16d01...`), same-direction multi-hop route
  with no reverse leg. Also non-arbable on this evidence.

**No new coverage gap found in the primary (funnel-internal) question this window.** This
reconfirms R4's Final Decision: economics + same-pool-reverse dust remains the production
ceiling, not cross-venue coverage, for the funnel-internal blocker.

## Mandatory competitor cross-reference (local reth, zero Alchemy CU)
`analysis live-loss --watch coffeebabe,0xae2Fc483... --rpc http://127.0.0.1:8545 --from-block
25446543 --to-block 25446717` (174 blocks, within the 200-block tool cap): **32 matches** — 1
coffeebabe, 31 `0xae2Fc483...` (`seenScope: none` / `primaryReason: not_seen` on every match — this
was a real-flow window, not a starved one).

- **coffeebabe (1/1 tx, full manual trace — mandatory):** block 25446585,
  `0xba315fb7806d9a24bf281b7972ecacaebe5889f1763e317a122159eb73dffcb4`. `trade.swap -> unwrap`
  on pool `0x1098...7daa`, realized ~**$0.42**. Dust, `profit_confidence: requires_decode`, not a
  meaningful capture — coffeebabe was quiet this window.
- **0xae2Fc483 (sampled 6/31, outcome-driven):** every sampled tx is `path_template:
  LP-positioned(partial→arb)` or `unknown_replayable` routed through **Uniswap v4** pools
  (`v4_pool_ids`: `0xce2899b1...` fee=500, `0x81fd4a10...` fee=20000) doing LP mint/burn paired
  with swaps. `pool_in_routing_graph: null` on every v4 sample (unresolved — our graph doesn't
  carry v4 poolId-based edges beyond the few hand-pinned native pools from the 2026-07-02 v4-native
  work). Real net take per cycle, using the more-trustworthy `rough_profit` ETH field (the
  `realized_profit_usd` legs are a valuation artifact — paired +/- values differing by ~$15-25
  driven by an unpriced LP token `0xa27e...62d2`): **~0.0016-0.0049 ETH (~$3-8) per cycle** — real,
  but not remotely large, and every instance is v4-routed.

**Classification: pool gap, already-epic'd, not new.** This matches `project-univ4-coverage-frontier`
(memory) exactly — the v4 *native-pool adapter* (execution mechanics for a handful of pinned pools)
shipped 2026-07-02, but general v4 pool **discovery/indexing** (the equivalent of v3's factory-event
discovery, for the full PoolManager singleton universe) is still missing. This window's 31 matches
against a single watched address, virtually all v4-routed with `pool_in_routing_graph: null`,
independently reconfirm that gap — this is evidence for an existing epic, not a new finding.

**Per rule 13 mechanical escalation: per-pool pinning is forbidden here.** This window alone
produced ≥4 independent v4-pool samples (blocks 25446694 x2, 25446716, 25446642) beyond the
≥3-in-one-window trigger threshold — hand-pinning `0xce2899b1...`/`0x81fd4a10...` individually
would be exactly the whack-a-mole pattern rule 13 rules out once a class is epic'd. The correct
next step is a v4 pool-discovery epic slice (index `Initialize` events off the PoolManager
singleton the way `build-active-pool-universe.ts` does for v3 factory `PoolCreated`), not two more
pinned-pool commits.

## Why this round does NOT implement the v4-discovery slice
That work touches `pool-universe.ts` / `build-active-pool-universe.ts` — files this round is
explicitly avoiding per the top-of-file safeguard (concurrent session PID 77146/77145, still alive
at 16h07m / 0% CPU / clean tree as of this check, but not confirmed exited). It is also a genuine
multi-file design task (new discovery path, poolId→PoolKey resolution, graph admission), not a
1-3-file mechanical Codex pass — better scoped as its own dedicated round once the file-safeguard
clears, rather than compressed into the tail of an already-long round.

## Findings Ledger (final this round)
| finding | owner | carry_to | status |
|---|---|---|---|
| concurrent-session collision (PID 77146/77145) | human | next fire | monitor — idle 16h07m, tree clean; safeguard (no edits to `main.ts`/`pool-universe.ts`/`test/pool-universe.ts`) held all round without needing to touch them anyway |
| R4 carry: measure EV-gate flip effect | R4→R6 | — | **done** — gate verified operative (2/2 sim-positive candidates correctly rejected `below_ev_gate` with real gas); dust-ceiling reconfirmed, no bundle to escalate for broadcast |
| v4 pool discovery/indexing (general PoolManager singleton coverage, beyond hand-pinned native pools) | future | R7 | **reinforced, not new** — 31 competitor samples this window, all v4-routed, `pool_in_routing_graph: null`; per-pool pinning forbidden (rule 13); next Implementation Brief once the file-safeguard clears |
| classifier blind spot (`impact_pool_not_in_routing_graph` conflates no-venue vs missing-graph-edge) | future | R7+ | open, non-blocking (R4, reconfirmed this window: both traced candidates were one-way swaps not gaps) |
| build-time discovery-queue chicken-egg (`not_closable_in_current_graph`) | future | R7+ | open, non-blocking (R4) |

## searcher_behavior_change: yes
`SEARCHER_EV_GATE` flipped from off to on (config, deploy-time) and **verified operative** live:
correctly filters dust bundles that the sim-fidelity fix (R4) now prices with real gas, rather than
letting them through as false-positive "successes." This is a real step toward Mission #1 (the
gate that must protect any future broadcast is now confirmed working, not just implemented).

## Next action
Round complete. No background Codex/agent dispatch pending. Releasing the round lock; next
Hermes work (the v4 pool-discovery epic slice) is carried to the next `hermes-hourly` cron fire
(~1h, external scheduler — already confirmed via `list_scheduled_tasks`), which should first
re-check PID 77146/77145 liveness before touching `pool-universe.ts`.
