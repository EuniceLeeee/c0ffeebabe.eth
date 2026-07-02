# R4 — coverage candidate verification (2026-07-03)

> Continuation of `arch-review-2-20260702-verdict.md`'s R4 directive. Orchestrator = the hourly Hermes
> cron (self-driven, rule 14). Scope: authorized defensive on-chain arbitrage research; local-reth reads;
> broadcast is a separate human-gated step, not performed here.

## Starting state
Found the previous round's process (lock PID 2688) had crashed mid-R4 (dead PID, stale lock reclaimed).
Left in the working tree: a pinned `planner.ts` fixture pair (`r4-1151-usdt-pair-gap`/`-flip`, TOK_1151/USDT,
run `9a20d602` block 25444461) and a scratch investigation script into `build-active-pool-universe.ts`'s
discovery queue.

## Finding: the in-progress candidate is INVALID as arb evidence
Full Transfer-log trace (via `cast receipt --json` on the node's local reth, zero CU) of tx
`0x5610530b4816cd6e405f2a5c788d13669c4fe0bc0ff0599cc0db95a88d4511b7` (block 25444461):
EOA `0x219fc40c...` sent 200 USDC to an executor, which split it across two USDC->USDT routes then two
USDT->TOK_1151 pools, and forwarded the TOK_1151 output straight to the EOA — no return leg to
USDC/USDT. **This is a one-way multi-route best-execution swap, not a closed-loop arbitrage.** The
`"Source":"ArbitrageBot"` tag in the calldata is an aggregator route-metadata label, not MEV evidence.
Per `arch-review-2-verdict.md`'s R4 criteria (needs "a competitor closed through for non-dust value"),
this candidate fails criterion (c) outright (not just "dust" like pinned case #1 — it isn't an arb at all).

**Action taken:** corrected the fixture's provenance comments in `listener/src/searcher/test/planner.ts`
to flag the invalidation explicitly (kept as a coverage-mechanism regression test only; must not be
reused as "real value" evidence). Build verified: `npm run searcher:planner` still 12/12 + 12/12 replay
fixtures PASS. Deleted the leftover scratch script after running it once (finding folded in below).

## Full survey: `impact_pool_not_in_routing_graph` drops in run 9a20d602 (18 entries)
Pulled from `/tmp/r1-events.jsonl` on the node. Two repeat-lanes stand out (same pool pair hit twice in
the window): `0xae07459b...` (blocks 25444463/25444466) and the block-25444527 pair
`0x4c083084.../0x93dbcd73...` (two separate victims, same pools). The rest (block 25444461/25444621 pair
is the invalidated TOK_1151 case) are untraced. A quick check of the tx immediately following the
25444527 victims hit the USDT contract directly (no Transfer logs) — inconclusive, not itself evidence
either way.

## Side finding (unverified hypothesis, not yet root-caused)
A scratch test against `consumeDiscoveryQueue` in `build-active-pool-universe.ts`, toggling whether the
already-fixed OVR token is seeded into the graph, showed the build-time discovery queue's
`not_closable_in_current_graph` filter changes outcome depending on which tokens are already present —
suggesting a possible chicken-and-egg gap in build-time admission (a pool's neighbor can only be admitted
incrementally, token-by-token). Not yet traced to file:line or connected to the Finding-2 drops.

## Dispatched (dual-blind, rule 13 Rounds-step-4 protocol)
Neither candidate hunt (the untraced 15 rows) nor the discovery-queue hypothesis has been resolved yet.
Rather than continue solo archaeology, dispatched the prescribed dual-blind analysis from a shared raw
DATA package (`/private/tmp/.../scratchpad/r4-data-package.md`, facts only, no conclusions):
- **A** = fresh fable-5 sub-agent (Agent tool, model:fable), full chain+code access, tasked with tracing
  >=2-3 more Finding-2 rows to a closed-loop/non-dust verdict (or a fresh window if none pan out) plus
  independently assessing the discovery-queue hypothesis. Running async.
- **B** = Codex (`scripts/codex-run.sh read-only`), code-only, blind to A, tasked with tracing the
  `not_closable_in_current_graph` gate to file:line and assessing it as a root cause independent of the
  general "coverage epic" framing. Running async in background.
Both write to separate `conclusion-A`/`conclusion-B` files and are instructed not to read each other.

## Findings Ledger
| finding | owner | carry_to | status |
|---|---|---|---|
| TOK_1151/USDT candidate invalidated (one-way swap, not a closed loop) | R4 | — | **closed** — fixture comment corrected, do not reuse |
| need >=1 verified non-dust closed-loop candidate from the 15 untraced `impact_pool_not_in_routing_graph` rows or a fresh window | R4 | R5 | **open** — dual-blind A/B dispatched, pending |
| build-time discovery-queue `not_closable_in_current_graph` chicken-egg hypothesis | R4 | R5 | **open** — unverified, dual-blind A/B dispatched, pending |
| coverage (per-opp broader-neighborhood admission) confirmed primary, 98% of no_candidate (arch-review-2) | R4 | R5 | carried, unchanged |
| sim-fidelity: `gasUsed=0n` unconditional (botvm-simulator.ts:55,66) | pre-broadcast | go-live | carried, unchanged |
| economics slice-3 spec (EV_GATE=1, BRIBE_BPS<10000, real gas) | slice-3 | go-live | carried, unchanged |

## A vs B comparison (both returned)
- **A (fable, full chain+code):** hand-traced 8 of 18 `impact_pool_not_in_routing_graph` rows (every
  priority repeat-lane) via full Transfer-log topology on the node's local reth. **Verdict: no verified
  non-dust closed-loop arbitrage in this window.** Every row is either (i) a one-way aggregator/router
  source swap (the triggering swap itself, correctly non-arbable) or (ii) a thin same-pool sandwich netting
  dust ($0.32-$0.54 gross, before gas — a same-pool round-trip the planner already prunes, not a
  cross-venue miss). Full evidence table in `/private/tmp/.../scratchpad/r4-conclusion-A-fable.md`.
  Core claim: the classifier's `impact_token_return_venues_excluding_impact_pool` field only checks
  edges in OUR graph, never whether a cross-venue return venue exists on-chain at all — so the "98%
  zero-return-venue" stat from arch-review-2 conflates "correctly-dropped non-arbable source swap" with
  "genuine missing-graph-edge gap," and this window's sample is dominated by the former.
- **B (Codex, code-only, blind to A):** confirmed Finding 3 (build-time discovery-queue chicken-egg gate,
  `build-active-pool-universe.ts:243,305,311`) is real code, but explicitly would **not** call it proven as
  the root cause of the Finding-2 drops — `discovery-queue.json` doesn't even contain those 18 addresses,
  so this gate governs a different (supplemental-queue) code path, not the main swap-log routing graph.
- **Agreement:** A and B independently converge that Finding 3 (discovery-queue chicken-egg) does NOT
  explain the Finding-2 drops — different code path (A: "governs only the supplemental discovery-queue.json
  admission... Finding 2 pools are impact_pool_in_detection_set:true... fail at the routing-graph
  return-edge stage, a different code path"; B: "the supplied facts do not establish that it caused the 18
  listed absences specifically"). High-confidence: Finding 3 is a real, separate, narrow bug — not this
  round's blocker.
- **Orchestrator independent verification of A's core claim:** read `listener/src/searcher/planner/planner.ts:525-561`
  directly. Confirmed: `directReturnVenues`/`impact_token_return_venues` are computed by iterating only the
  in-memory `graph` array — no on-chain existence check anywhere in this function. A's claim about the
  classifier's blind spot is code-verified, not just asserted.

## Claude Final Decision
**Kill the coverage-epic productionization on this evidence.** arch-review-2's "coverage confirmed primary"
verdict rested on a classifier stat (`impact_token_return_venues=0`) that cannot distinguish "no on-chain
return venue exists" (correct drop) from "return venue exists but missing from our graph" (real gap) — and
on manual trace, this window's sample is 100% the former. R4's mandate (find >=1 real non-dust closed-loop
case) is **not met** by run 9a20d602: both attempted candidates (TOK_1151/USDT and the ae07459b/4c08/93db
repeat lanes) are invalidated as arb evidence (one-way swaps or same-pool dust). This is consistent with,
and strengthens, R2/R3's repeated finding: **economics + same-pool-reverse dust is the production ceiling,
not cross-venue coverage.**

Per CLAUDE.md rule 13's anti-drift cap (arch-review-2 was one `observability-only` turn; this R4 comparison
would be a second consecutive one if it ended here — not allowed), **the next step must ship a real
searcher-behavior change now, in this same round**, rather than write a third analysis turn. Per
arch-review-2-verdict.md's own step-4 fallback ("if it stays dust... pivot to economics slice-3") and
epic-coverage-slice1-20260702.md's already-ready slice-3 spec, dispatched Codex (workspace-write,
`scripts/codex-run.sh`) to fix the sim-fidelity bug blocking slice-3: `botvm-simulator.ts:55,66` hard-codes
`gasUsed: 0n` unconditionally, so `main.ts:1655/1693`'s EV-gate gas cost ALWAYS falls back to the 12M-gas
default regardless of what a plan actually costs on anvil. Brief: add `StateBackend.getGasUsed(txHash)`
(additive, no existing signature changes) and wire it into `BotVMSimulator.simulate()`'s success path;
gate with `npm run searcher:ac3` (real forked-mainnet wstUSR replay) showing `gasUsed` flip from 0 to a
real measured value. `SEARCHER_EV_GATE`/`SEARCHER_BRIBE_BPS`/`SEARCHER_MIN_NET_ETH` are already wired as
env config (main.ts:349-352) — no code change needed there, just a deploy-time flip for a later
measurement round once this fix lands. Running in background; will review the diff + gate result and
either land it or document a defer once it returns.

## Findings Ledger (updated)
| finding | owner | carry_to | status |
|---|---|---|---|
| TOK_1151/USDT candidate invalidated (one-way swap, not a closed loop) | R4 | — | **closed** |
| coverage epic productionization: **KILLED** — no verified non-dust closed-loop case exists in run 9a20d602 (8/18 rows traced, all non-arbable or dust) | R4 | — | **closed** (dual-blind A confirmed, B corroborates via Finding-3 non-causation, orchestrator code-verified the classifier blind spot) |
| classifier blind spot: `impact_pool_not_in_routing_graph` conflates "no on-chain return venue" vs "return venue exists but missing from graph" | future | R5+ | open, non-blocking (recommended by A; cheap follow-up, not urgent — case (i) dominates so far) |
| build-time discovery-queue chicken-egg (`not_closable_in_current_graph`) | future | R5+ | open, non-blocking — real but narrow, doesn't explain Finding 2 |
| sim-fidelity: `gasUsed=0n` unconditional (botvm-simulator.ts:55,66) | R4 | — | **in progress** — Codex dispatched this turn, gate = `searcher:ac3` gasUsed flip |
| economics slice-3 (EV_GATE=1, BRIBE_BPS<10000, real gas, MIN_NET_ETH=0) | slice-3 | next round | blocked on sim-fidelity fix landing; config-only once unblocked |

## searcher_behavior_change: yes — LANDED
Codex implemented the fix (`state-backend.ts`: additive `getGasUsed(txHash)`; `botvm-simulator.ts`: success
path uses it instead of hardcoded `0n`; `ac3.ts`: asserts `gasUsed > 0n`). Codex's own sandbox could not run
anvil (`EPERM` on local TCP listen) to produce before/after numbers, so the orchestrator ran the repair-replay
gate directly: `npm run searcher:ac3` (real forked-mainnet wstUSR replay, block 24710789).

**Gate result: PASS.** `gasUsed` flipped from the previous unconditional `0n` to real measured values —
`1058884`, `1059262`, `1045212` (plausible for a 6-hop flash-loan arbitrage; the old fallback was
12,000,000 x2 = 24,000,000). AC-3 wstUSR regression fixtures still PASS 2/2 (`bestProfit` unchanged vs
threshold on both fixtures). `npm run build` clean; only `AnvilStateBackend` implements `StateBackend`, no
missed call sites. Diff scope matches the brief exactly (3 files: `state-backend.ts`, `botvm-simulator.ts`,
`ac3.ts`).
`failing_sample: AC-3 wstUSR fixtures (gasUsed hardcoded 0n, confirmed by code inspection pre-fix) /
fix_commit: f721651 / replay_command: npm run searcher:ac3 / replay_result: gasUsed 1058884/1059262/1045212,
AC-3 PASS 2/2 / expected_transition: gasUsed 0n (unconditional) -> real measured value / verdict: **fixed**`
(not merely `implemented_not_validated`). This satisfies rule 13's anti-drift cap for this round.
Unblocks economics slice-3 (`SEARCHER_EV_GATE`/`SEARCHER_BRIBE_BPS`/`SEARCHER_MIN_NET_ETH` already wired as
env config in `main.ts:349-352` — a deploy-time flip for a future measurement round, no code needed).
carry_to_round: R5 (deploy + dry-run to measure the EV-gate flip's effect).

## IMPORTANT — concurrent session collision discovered (flag to human)
While staging this commit, found **unstaged, uncommitted changes to `main.ts`, `pool-universe.ts`, and
`test/pool-universe.ts`** implementing a "pair-floor" pool-admission feature (`SEARCHER_PAIR_FLOOR`,
`selectPairFloorPools`, top-K same-token-neighbor admission) that this round did not write. Process
inspection found a **second, independently-running Claude Code session** (PID 77146/77145, a resumed
session `68cdc92e-8b69-4043-8d6d-dccc6302cf3a`, `claude-opus-4-8 --effort xhigh`, running since 10:46AM)
with its own live Codex dispatch in progress (`/private/tmp/hermes-arch-review-20260702/codex-slice2-impl-brief.md`,
PID 11558 at time of discovery) — this matches arch-review-2-verdict.md's **slice-2** productionization
step ("top-K same-token neighbors by score"), which was conditional on R4 finding a verified real-value
coverage case. **This round's Final Decision is that R4 found NO such case and killed the coverage-epic
productionization** — directly conflicting with what the other session appears to be building.
**Action taken:** left the other session's uncommitted files completely untouched (verified `git add`
only staged this round's 3 gasUsed-fix files before committing — no overlap, no risk of corrupting or
discarding its WIP). **Not resolved by this round** — this is a cross-session coordination gap the human
should see directly, not something to silently reconcile or override autonomously (two live Hermes loops
independently driving the same working tree is itself a process problem, separate from either loop's
technical conclusions). Recommend: check what the other session's slice-2 pass concludes against this
round's kill-the-epic finding before either lands further commits.
