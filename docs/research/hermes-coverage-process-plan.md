# Plan — Close the Hermes coverage-process gaps (epic trigger · coverage KPI · learn→close auto-enqueue)

> Scope: authorized, defensive on-chain **arbitrage research** — mainnet fork + dry-run only,
> reads public chain data, targets/harms no user; broadcast stays a hard human gate.
>
> Companion to `docs/research/reports/HANDOFF-hermes-coverage-process.md` (the evidence base —
> gaps #1/#2/#3 confirmed against R1/R2). The handoff deliberately did not prescribe a design;
> this plan IS the design, written on user request. The executing session should still verify the
> handoff's confirmations independently before implementing (rule 3: verify-before-claim).

## Problem (one paragraph)

Three process gaps confirmed from R1/R2 (2026-07-02): **(#1)** coverage gaps get parked as
"longtail/separate" round after round and never escalate to an epic — no written trigger forces
the escalation; **(#2)** the north-star signal ("what fraction of competitor arb legs route
through pools we don't index") exists only as hand-counted prose, never a per-round machine
metric; **(#3)** Step-1 identifies out-of-graph pools competitors use, but nothing feeds them
into the discovery pipeline — findings die between "diagnosed" and "closed". Fix = one
governance trigger + one instrument + one behavior change, in that order.

## Workstream 1 — Epic-escalation trigger (governance, doc-only)

**What:** Add a mechanical trigger to CLAUDE.md rule 13's epic-escalation clause, and open the
coverage-frontier epic record.

1. **CLAUDE.md rule 13, epic-escalation bullet** — add the trigger:
   *"Same `gap_class` recurring in ≥3 independent samples within one window, OR in ≥2 consecutive
   rounds, → mandatory `decision: epic` in the Findings Ledger. Once a class is epic'd, per-pool
   pins for that class inside the 30-min loop are forbidden — only epic slices (each with its own
   rule-12 gate) may touch it. A systemic single fix (R2's v4 gate flip) always beats N per-pool
   pins when one exists."*
2. **Findings Ledger entry** (in the current round's Hermes md): `decision: epic` for the
   **coverage frontier** (non-standard / native-ETH / v3-fork pool population; evidence: Slice-2
   window 3/3 sources same gap_class — original sample + coffeebabe `0x2e8b0b…` + ae2Fc483 sample
   5/8 pools OUT). Slices = W2 (instrument) → W3 (enqueue) → adapter work joins the existing v4
   epic where shapes overlap ([[project-univ4-coverage-frontier]]).

**Verify:** trigger text present in CLAUDE.md; ledger entry has `owner` + slice list.
**Class:** governance/doc — no code. May be Claude-authored (mechanical), Codex not required.

## Workstream 2 — `coverage_kpi` in the step1 artifact, counts computed not asserted (instrument)

> **Design correction (verified on disk during implementation, 2026-07-02):**
> `runtime-graph-pools.json` is generated on the node at runtime, is **absent locally**, and
> dumps only `{address, adapter}` — **no token identities**. So a gate that recomputes the A/B
> `closable`/`single_venue_noise` split offline is NOT cleanly feasible (no reliable graph token
> set). Corrected split of responsibility, keeping the gate pure/offline:
> - **W2 gate recomputes the COUNTS** (`legs_total`, `legs_out_of_graph`) from the per-tx records
>   it already validates — this is the deterministic anti-hand-wave core and needs no external
>   artifact.
> - **A/B classification in W2 is analyst-labeled** per OUT pool (`class` + `token0`/`token1` from
>   the trace + `evidence`); the gate only checks the label is valid and the counts partition the
>   unique OUT pools. The gate does not recompute A/B.
> - **The precise, computable A/B filter lives in W3** at enqueue time, where the built token set
>   is in memory — that is where it functionally gates what gets probed/added, proven by W3's flip
>   + STAY-0 fixtures.

**What:** The per-tx pool classifications the gate already validates
([hermes-gate.ts:96](analysis/src/cli/hermes-gate.ts) `validateTxRecord` — `pools[].inGraph`,
`gap_class`) contain the counts the KPI needs. Make the gate **recompute the counts** from them
and require the artifact to carry a `coverage_kpi` block whose counts match, so the trend is
machine-produced, not hand-asserted.

1. **Schema** — top-level `coverage_kpi` block in the step1 artifact JSON:
   ```
   coverage_kpi: {
     competitor_legs_total: N,      // sum of pools[] across all analyzed txs (full + sampled)
     legs_out_of_graph: M,          // pools[].inGraph === false, over the same txs
     out_pools: [ { addr, token0, token1, class: "closable" | "single_venue_noise", evidence } ],
     closable: X, single_venue_noise: Y,   // X + Y = |unique out_pools|
     prev_round: { run_id, legs_out_of_graph, closable } | null   // the trend link
   }
   ```
   **A/B rule (the [[project-planner-no-candidate-plans]] split), applied by the analyst in W2 and
   computed authoritatively in W3:** a pool is `closable` (return-venue-missing) iff BOTH its
   tokens already appear in our routing graph (adding this one pool could close a loop); otherwise
   `single_venue_noise` (the must-STAY-0 longtail; never enqueue).
2. **hermes-gate.ts** — (a) new `--emit-kpi` mode: read the artifact's per-tx records and print
   the recomputed `competitor_legs_total` / `legs_out_of_graph` + the list of unique OUT pool
   addresses (the operator fills each pool's `token0`/`token1`/`class`/`evidence`, then pastes the
   block — counts derived, A/B analyst-set); (b) validation: `coverage_kpi` present; `legs_total`
   and `legs_out_of_graph` **equal** the recomputed values from per-tx records; every unique OUT
   pool address in per-tx records appears in `out_pools` with a valid `class` ∈
   {closable, single_venue_noise} + non-placeholder `token0`/`token1`/`evidence`;
   `closable + single_venue_noise` = |unique OUT pools|. Missing/mismatched → FAIL (same blocking
   posture as the four existing checks).
3. **Templates** — one `coverage_kpi:` line in the close section of
   `docs/research/templates/hermes-impl-cycle.md` and `hermes-live-run.md`.
4. **Baseline:** back-fill the KPI for `step1-20260702-v3fork.json` (per-tx data already in the
   file) so R3 has a `prev_round` to link to. R1/R2 predate the artifact schema — do not
   retro-fabricate; `prev_round: null` is honest there.

**Verify (all local, zero CU):** `cd analysis && npm run build` clean;
`npm run hermes-gate -- docs/research/reports/live-run-20260702-v3fork-hermes.md` PASS after the
artifact gains the block; then negative tests — delete `coverage_kpi` → FAIL; corrupt
`legs_out_of_graph` → FAIL; give an OUT pool an invalid `class` → FAIL. **Do not only test the
happy path.**
**Class:** `turn_class: observability-only` — label it honestly. Per rule 13's anti-drift cap,
**W3 must be the immediately following implementation turn.**

## Workstream 3 — learn→close auto-enqueue (searcher_behavior_change: yes)

**What:** `closable` OUT-of-graph pools from Step-1 flow into the pool universe automatically;
standard-shaped ones become routable edges with no human in the loop.

1. **Queue file** — `searcher/pools/discovery-queue.json` (next to the existing
   `active-pools.json`, [pool-universe.ts:6](listener/src/searcher/pool-universe.ts) convention):
   `[ { addr, source: "step1:<run_id>", class: "closable", first_seen_block } ]`. A small
   `analysis` helper (or `--emit-queue` on hermes-gate, whichever is less code) appends the
   `closable` entries from a step1 artifact — dedup on addr.
2. **Consume in [build-active-pool-universe.ts](listener/src/searcher/build-active-pool-universe.ts):**
   for each queued addr, ABI-probe the shape using the machinery already there — the
   `SWAP_TOPICS` adapter classification + `univ2Iface`/`univ3Iface` token/fee probes → build a
   `PoolEntry` → merge via `mergePoolRegistries`
   ([active-pool-discovery.ts:217](listener/src/searcher/active-pool-discovery.ts)). Token-graph
   picks it up at next startup unchanged. v4 pools take the existing v4 path (poolId from
   Initialize/Swap logs; `PoolEntry.currency0/1`, native-ETH aliasing already in `TokenEdge`).
3. **No adapter fits → don't drop, don't author:** record the entry as
   `blocked_on_adapter: "<shape>"` in the queue. It stays visible in the KPI as
   closable-but-blocked and feeds the W1 epic. **Authoring new adapters is epic scope, not this
   slice** (rule: Simplicity First; the non-standard/native-ETH shapes are exactly why the epic
   exists).
4. **Guards:** only `class: "closable"` is ever enqueued (the A/B filter is the noise gate); a
   probed pool must answer the standard probes non-reverting at head before merge; queue entries
   carry provenance (`source`) so a bad auto-add is traceable to its window.

**Gate (rule 12 — deterministic replay flip, BEFORE any dry-run):**
- Pin one real `closable` OUT pool from the Slice-2 window (pick the standard-shaped one from the
  ae2Fc483 sample — the probe decides which of the 5 OUT pools qualifies) as a named fixture in
  `REPLAY_FIXTURES` ([planner.ts:450](listener/src/searcher/test/planner.ts)), with on-chain
  provenance (tx hash + block).
  `expected_transition`: `pool_in_routing_graph false→true` AND `no_candidate → candidate_plans>0`
  on the pinned sample via `npm run searcher:planner`.
- **Negative fixture:** one `single_venue_noise` pool from the same window must STAY at 0
  candidates and must NOT appear in the queue — proves the A/B filter blocks noise.
- No flip = `implemented_not_validated`, not `fixed`.

**Then:** one node dry-run window (deploy via `scripts/deploy-node.sh` first, `SEARCHER_EVENTS_PATH`
set) → full Step-1 + hermes-gate PASS → the KPI's `prev_round` link shows the first machine-produced
trend point (`legs_out_of_graph` / `closable` vs Slice-2 baseline).

## Execution model & order

Per CLAUDE.md generator/evaluator split (Fable orchestrator = 3 steps): **W1** doc-only, Claude
may author. **W2, W3** = one Codex cycle each (rule 11 protocol, lean `hermes-impl-cycle.md`
template): W2 brief = `analysis/src/cli/hermes-gate.ts` + artifact + 2 templates, forbidden:
searcher code; W3 brief = `build-active-pool-universe.ts` + queue helper + planner fixtures,
forbidden: adapter/quote code. Claude reviews every hunk (`git diff --stat` first,
[[feedback-gate-full-codex-diff]]), runs the gates, commits.

Order is W1 → W2 → W3 back-to-back: W1 unblocks governance in minutes; W2 is the instrument but
is observability-only, so the anti-drift cap forces W3 next; W3 is the behavior change that makes
the whole loop real. Budget: zero-CU-first (local reth over SSM, local fixtures); Alchemy only for
the existing ≥1-tx secondary-source validation rule.

## Explicitly not doing

- **No new swap adapters / quote math** — non-standard shapes go to `blocked_on_adapter` + the
  epic. (This includes the native-ETH pool `0x2e8b0b…` unless the probe shows a standard shape.)
- **No fix to `--competitor-scan`'s `analyzeBlock`/`--coverage` block+1 bug** — known, tracked
  separately ([[project-competitor-scan-tool]]).
- **No auto-enqueue of `single_venue_noise`** — ever; the STAY-0 fixtures are the proof.
- **No broadcast** — human gate, unchanged.
- **No new harnesses** — planner.ts fixtures + hermes-gate are the only gates touched.

## Acceptance summary

| WS | Deliverable | Gate | Class |
|---|---|---|---|
| W1 | rule-13 trigger text + epic ledger entry | text present, owner + slices named | doc |
| W2 | `coverage_kpi` schema + `--emit-kpi` + gate checks + templates | gate PASS on v3fork md; 2 negative FAILs | observability-only |
| W3 | queue + universe consume + guards | planner fixture flip (`no_candidate → plans>0`) + STAY-0 negative; then 1 dry-run window w/ KPI trend point | **searcher_behavior_change: yes** |

## Implementation log

- **W1 — DONE** (`e068518`, Claude-authored, doc): rule-13 mechanical epic-escalation trigger
  (≥3 samples/window OR ≥2 consecutive rounds → mandatory `decision: epic`; per-pool pins for an
  epic'd class forbidden in-loop) + R2 Findings Ledger `decision: epic` for the coverage frontier.
- **W2 — DONE** (Codex-authored `hermes-gate.ts` +130; Claude = non-author evaluator, ran the
  gates). `--emit-kpi` recomputes `competitor_legs_total`/`legs_out_of_graph` from the per-tx
  records (v3fork: 11 total / 6 out-of-graph / 6 unique OUT pools); the normal gate now requires a
  `coverage_kpi` block whose counts EQUAL the recompute + a valid A/B class per OUT pool + a
  `prev_round` trend link. `step1-20260702-v3fork.json` back-filled (5 closable / 1
  single_venue_noise — OVR/WETH single-venue). Gate verified by the evaluator: PASS on the
  back-filled artifact; 4 independent negatives each block (wrong `legs_out_of_graph`; invalid
  `class`; `closable+noise != out_pools.length`; dropped `out_pools` entry → addr-set mismatch).
  `turn_class: observability-only` — per rule-13 anti-drift cap, **W3 is the required next
  behavior-changing turn.**
- **A/B correction (verify-before-claim, `347b967`):** probing the paired in-graph pool showed
  `0x0b0d6c11` (OVR/WETH) is **closable, not noise** — its partner `0xc3f6b8` (OVR/WETH) is
  already in-graph, so OVR is routable and this is the missing 2nd venue (competitor tx `0x68f186`
  closed exactly this loop). Corrected artifact to **6 closable / 0 single_venue_noise** — all six
  OUT legs are confirmed-closable coverage gaps. Lesson: the manual A/B label missed the paired
  in-graph pool; the **computable filter (W3) checks the real token set and gets it right** — an
  argument for the computed filter over hand-labels.
- **W3 verification correction (after the user asked "is it actually confirmed"):** re-checking
  against the REAL node exposed two things my first pass overstated.
  1. **`consumeDiscoveryQueue` had never run to completion.** It now has: the real function was
     exercised against a mock provider seeded with the real on-chain token/shape data (the module
     ran `main()` on import and hung the live attempts — fixed with an entry-point guard, below).
     Result is correct: with OVR in the token set → 5 included / 1 blocked (native-ETH `0x2e8b0b`
     → `not_closable_in_current_graph`, 0xEEE sentinel); with OVR absent → 4 included / OVR also
     blocked. The A/B filter behaves exactly as designed.
  2. **My "0xc3f6b8 is in our graph" claim conflated two things.** `0xc3f6b8` (OVR/WETH) is in the
     **universe** (`active-pools.json`, 2995 pools) but **NOT in the current runtime graph**
     (`runtime-graph-pools.json`, 2928 — it was pruned). The filter's token set is built from the
     universe, so the enqueue decision (include `0x0b0d6c11`) is correct on the real node. But
     whether the OVR loop actually CLOSES at runtime needs both venues to survive into the routed
     graph — and `0xc3f6b8` is currently pruned. Adding `0x0b0d6c11` to the universe does not
     guarantee the runtime graph will route it.
- **W3 — verdict corrected: `implemented` + deterministically gated on the pieces; the end-to-end
  learn→close is `implemented_not_validated` pending a node dry-run.** NOT "fixed" end-to-end.
  What IS confirmed (deterministic, local): the gate (W2), the planner routing flip (given both
  edges → loop closes), the `isClosablePair` filter unit, and `consumeDiscoveryQueue` full logic
  (mock + real data). What is NOT confirmed: that after deploy+universe-rebuild+restart the OVR
  loop actually closes in the runtime graph (the universe→runtime pruning is an open question only
  a node dry-run answers).
  - Evaluator gates run: `npm run build` (listener tsc clean); `npm run searcher:planner` →
    `coverage-ovr-weth-gap` 0 plans, `coverage-ovr-weth-flip` ≥1 plan, `single-venue-longtail`
    STAYS 0 (planner PASS 12/12 + fixtures 6/6); `isClosablePair` pure unit (both-in true /
    one-missing false); real-pool probe classification via local reth (zero CU) — the 5 standard
    closable pools are univ2/univ3 (probe-classifiable → included when their tokens are graph
    tokens); native-ETH `0x2e8b0b` (0xEEE sentinel not a graph token) is correctly excluded from
    auto-add → feeds the epic. `failing_sample`: OVR/WETH backrun tx `0x68f186…` block 25442493;
    `expected_transition`: `no_candidate → candidate_plans≥1` once the enqueued 2nd venue is a
    graph edge — CONFIRMED.
  - Minor note (not a defect): `0x2e8b0b` blocks with reason `not_closable_in_current_graph`
    (0xEEE ∉ graph tokens) rather than `blocked_on_adapter`; both land it in the `blocked` list and
    keep it out of auto-add. Native-ETH sentinel aliasing stays epic scope.
- **W3 detail** (Codex cycle, `searcher_behavior_change: yes`):
  - `build-active-pool-universe.ts`: `isClosablePair(t0,t1,tokenSet)` (computable A/B, both tokens
    already routable) + `probePoolShape` (univ3→univ2→null) + `consumeDiscoveryQueue` → merged into
    the universe; non-standard shapes (native-ETH `0x2e8b0b`, v4) → `blocked_on_adapter` (feeds the
    epic, not auto-added).
  - Queue seed `listener/searcher/pools/discovery-queue.json` (6 closable pools, `source:
    step1:20260702-v3fork`) — orchestrator-authored data.
  - **Rule-12 flip = OVR/WETH** (real, confirmed): `coverage-ovr-weth-gap` (one venue `0xc3f6b8`
    → 0 plans) → `coverage-ovr-weth-flip` (add enqueued 2nd venue `0x0b0d6c11` → ≥1 plan).
    Chosen over AAVE/WETH because one OVR venue is already in-graph, so a SINGLE enqueued pool
    demonstrates the flip (purest auto-enqueue proof). STAY-0 guard = the existing
    `single-venue-longtail` fixture (unchanged).
