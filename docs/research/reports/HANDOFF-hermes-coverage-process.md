# Handoff — Hermes process gaps for the coverage frontier (for an independent fable session)

> Scope: authorized, defensive on-chain **arbitrage research** — mainnet fork + dry-run only,
> reads public chain data, targets/harms no user; broadcast stays a hard human gate. Terms like
> "the source swap we follow" / "competitor arb leg" are standard DeFi/MEV nomenclature for the
> price-moving trade an arbitrage follows, not adversarial action against a person.
>
> Task for the fresh session: **independently** decide and implement the fix for the three
> Hermes-process gaps below. This doc gives the CONFIRMATION (grounded in R1/R2) + the exact
> reference material — it does NOT prescribe the design; reach your own conclusion.

## Confirmation against the latest runs (R1 + R2, 2026-07-02)

**Gap #2 — no cross-round coverage aggregation / no north-star KPI — CONFIRMED.**
Both rounds surfaced a coverage signal in PROSE only, never a trended metric:
- R1: competitor arb legs captured the same public-mempool source swaps we lost, on pools we
  already index (USDC/WETH-100); separately, 33 `plan/no_candidate_plans` (70% of drops).
- R2: 17 `plan/no_candidate_plans` sit on "a separate, non-overlapping pool set."
Nothing sums "what fraction of competitor arb legs route through pools/venues we do NOT index,
trended per round." The signal ("3/3 samples point at the same gap class") was hand-counted.

**Gap #3 — learn→close is manual (the diagnosed-but-not-closed chasm) — CONFIRMED.**
Step-1 competitor cross-ref identifies venues/pools competitors route through that we lack, but
nothing auto-feeds those into the discovery candidate set. R1's 33 + R2's 17 `no_candidate` pool
sets were classified (longtail vs separate) and then **parked** — no pipeline enqueues an
out-of-graph pool for ABI-probe + bit-exact quote validation + graph insertion.

**Gap #1 — round granularity vs gap magnitude — CONFIRMED, with a nuance.**
The coverage gap is a POPULATION (many non-standard / native-ETH / fork pools), not a point. But
note what R1/R2 actually did: they did NOT whack-a-mole pins — R1 fixed quote latency, R2 fixed a
**systemic** execution bug (safety-haircut on the v4 `take()` amount → nonzero PoolManager delta →
`unlock` reverts) that in one change unlocked the WHOLE v4 execution class. So the real observed
failure mode is the OPPOSITE of whack-a-mole: coverage keeps getting **parked as "longtail/separate"
and never escalated to an epic**. The fix #1 needs = a written trigger (same `gap_class` recurring
in ≥N samples across rounds → `decision: epic` in the Findings Ledger, out of the 30-min loop),
AND the discipline that a systemic single fix (like R2's) beats N per-pool pins when available.
Do NOT naively treat every out-of-graph leg as a closable gap — some are single-venue longtail
noise (the fixtures that must STAY at 0 candidates); the KPI in #2 must carry that A/B split
(single-venue-noise vs return-venue-missing).

## Reference material (read these; primary sources, zero-CU where possible)

**Run findings (the confirmation evidence):**
- `docs/research/reports/live-run-R1-20260702-hermes.md`, `...-R2-20260702-hermes.md`
  — funnel, `no_candidate` classifications, competitor takes, `not_this` notes.
- `docs/research/reports/live-run-20260701-detgap-hermes.md` — prior competitor cross-ref + the
  v4 coverage frontier framing.

**Gate + Step-1 artifact tooling (where a coverage KPI would live):**
- `analysis/src/cli/hermes-gate.ts` — the close gate + the `step1` block/artifact schema.
- `analysis/src/competitor-scan.ts`, `analysis/src/cli/live-loss.ts` — `--watch` / `--competitor-scan`,
  the `WatchReport` shape (the structured competitor output the KPI would aggregate).
- Node raw artifacts (audit the real competitor data): `/tmp/r1-cscan.out`, `/tmp/r1-watch.out`,
  `/tmp/r2-cscan.log`, `/tmp/r2-watch.log`, `/tmp/r2-window.log`, `/opt/MEV/analysis/outputs/live-loss-r1/`
  (EC2 `i-0ff908dedeec9ebc6`, SSM-only, local reth `127.0.0.1:8545` = zero CU).

**Discovery + graph (where out-of-graph pools would be auto-enqueued):**
- `listener/src/searcher/active-pool-discovery.ts`, `build-active-pool-universe.ts`,
  `pool-universe.ts` — how pools enter the active universe.
- `listener/src/searcher/planner/token-graph.ts` — how a pool becomes a routable edge (adapter
  types, v4 PoolKey, the `univ4`/`univ3`/`curve` cases); `runtime-graph-pools.json` is dumped on
  the node at startup (its count is the current graph size).
- `listener/src/searcher/detector/pool-impact.ts` — the impact decoders (which pools produce hints).

**Governance anchors:**
- `CLAUDE.md` Mission/North-Star (learn from competitors → classify our gap pool/path/unanticipated
  → close it) + governance rule 13 (forcing functions, epic-escalation) + the Rounds loop (step 4
  dual-blind blocker discovery; the Findings Ledger `carry_to_round`).
- Memory: `project-univ4-coverage-frontier`, `project-planner-no-candidate-plans` (the pending
  single-venue-noise vs return-venue-missing A/B split the KPI needs).

## Suggested order (yours to accept/reject)
1. Findings Ledger `decision: epic` — move the coverage frontier out of the 30-min loop; write the
   ≥N-recurrence escalation trigger.
2. Extend the `hermes-gate` step1 artifact with a `coverage_kpi` (count of competitor arb legs whose
   pools are out-of-graph, WITH the A/B single-venue-noise vs return-venue-missing split) and require
   it per round so the trend is machine-produced, not hand-counted.
3. A behavior-discovery slice: competitor-scan out-of-graph pools → auto-enqueue into the discovery
   candidate set → ABI-probe + bit-exact quote validation + graph insertion. Gate it with a
   deterministic flip (a real out-of-graph competitor pool: not-in-graph → in-graph + routable).

Broadcast stays a human gate; all validation is fork / dry-run on local reth (zero CU).
