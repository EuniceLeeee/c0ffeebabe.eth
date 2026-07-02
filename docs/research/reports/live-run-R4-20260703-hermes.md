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

## Next
Compare A vs B once both return: converge -> high-confidence next step (either a verified pinned
gap->flip fixture proceeding to slice-2 productionization, or a confirmed narrower discovery-queue fix
superseding the general epic framing); diverge -> dig further. Will write the comparison + Claude Final
Decision in this same file once both land.
