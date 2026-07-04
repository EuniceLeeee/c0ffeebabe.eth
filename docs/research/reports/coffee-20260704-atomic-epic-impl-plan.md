# Atomic-arb EPIC — production implementation spec (final pre-production review)

> Scope: authorized, defensive on-chain arbitrage research; mainnet fork + dry-run; broadcast is a
> human-gated step. This doc is the **buildable HOW** for
> [`coffee-20260704-architecture-improvement-plan.md`](coffee-20260704-architecture-improvement-plan.md)
> (the WHY/architecture doc — unchanged, still authoritative for rationale). Codex implements against
> THIS doc: exact files, TypeScript contracts, algorithms, and executable acceptance per slice.
> Reviewer: fresh Fable pass, 2026-07-04 (final round before implementation). Every anchor below was
> re-verified against the working tree at `026d132`.
> **Owner FINAL re-review folded 2026-07-04 (§0.3): conditional approval — 5 blockers (P0-1/2/3,
> P1-4/5) + the two-lane evolution (new slice A-lane); ordering re-gated at §0.3 / §5.**

---

## 0. Final review pass

### 0.1 Anchor re-calibration (verified 2026-07-04 @ `026d132` — `main.ts` drifted ~+11 lines since the plan)

| plan/prompt anchor | verified current anchor |
|---|---|
| `planner.ts:126` `plan(opp,templates,opts)` no strategy arg | ✅ `planner/planner.ts:126` |
| `impactFromOpportunity` `:413` / `focusPathsOnImpact` returns all paths w/o impact | ✅ `:413` / `:449–:465` (`analyzeImpactFocus` no-impact branch returns `paths`) |
| `buildBorrowabilityRotations` rotates start token | ✅ `planner.ts:321`; clone at `:356–:360` (`startToken/profitToken := borrowable.token`) |
| `main.ts` busy guard `:854/:866/:902` | now `:858/:870/:906` (decl `:680`) |
| `handleHint` `:954`; detect `:1245`; opps loop `~:1275+` | now `:965`; `:1256`; loop `:1287+` |
| backrun submit re-targets `latest+1` `:1832` | now `:1834` |
| block listeners `:764/:809/:823` | now `:775` (warm) / `:820` (state update) / `:827` (blockTracker) |
| `MEMPOOL_ROUTER_ADDRESSES` `:206/:208` | now `:219` |
| `buildMempoolToAddressFilter` `:2809/:2816/:2820` | now `:2896/:2903`; hot cap 200 / max 300 at `:2907–:2908`; firehose refusal `:2958+` |
| `submitter.ts:296` `getNonce("pending")`; `:79/:250` one target block | ✅ unchanged |
| `bundle-router.ts:5` `victimTxHash` required; standalone ignores it `:81` | ✅ `:6` (required `string`); standalone `:81–:93` |
| `solver.ts:442` `resolveSearchCenter`; `victimAmount<=0n → 1n` `:449`; GSS only on `bestVal>0n` `:196` | ✅ `:442/:449/:196`; NOTE `flashToken = plan.opportunity.startToken` (`solver.ts:120`) |
| `force-include.ts:5` cwd-relative `resolve("searcher","pools",…)`; `appendForceIncludePoolIds:88` | ✅ `:5–:14` (also `DEFAULT_FORCE_INCLUDE_ROUTERS_PATH:10`); append `:88` |
| `route-gap-watcher.ts:89` keys only on `bundle_not_included`; checkpoint offset | ✅ event filter `:148`; checkpoint `:88–:128`; pending-deploy marker `:21/:180` |
| `sender-flow.ts:44` private/high before `seenInOurPublicFeed` | ✅ `:44–:49` (bug confirmed verbatim) |
| `victim-source.ts` `decodeSwapLog` v2/v3/v4 only | ✅ `:124` |
| `bundle-postmortem` has `winner_style` | ✅ `bundle-postmortem.ts:41/:106/:512` |
| `analysis` imports `listener` relatively | ✅ `live-loss.ts:15–:19` (`../../../listener/src/searcher/venues/capability.js`) |
| harnesses `searcher:planner` / `searcher:replay-live-fixtures` | ✅ `listener/package.json:35/:58`; `REPLAY_FIXTURES` at `test/planner.ts:495` |
| `detector.ts:6` Opportunity | ✅ `detector/detector.ts:6` — **already carries `kind: "backrun-arb"`** (union-ready) |
| `events.ts:38–109` `victim_hash` required everywhere | ✅ `makeOpportunityId:38`; all event variants require `victim_hash` |
| `buildTokenPaths(start,profit)` generic DFS | ✅ `token-graph.ts:462` — `opts = {maxHops, maxPoolsPerToken, pinnedPools, maxPaths, deadlineAtMs}` |
| `selectArbRelevantPools` build-time | ✅ `pool-universe-arb-relevance.ts:15`; consumed `build-active-pool-universe.ts:238` |

### 0.2 Residual findings (the "8th nail" hunt — new items, NOT restating the 7 nails)

**R1 — Gap B is ALREADY LANDED; the plan's Gap B slice is stale and would cause duplicate work.**
Verified: `listener/src/searcher/discover-routers.ts` exists (commit `307dd3c` auto-runs it on every
deploy — `scripts/deploy-node.sh:159–:168`); the loss-driven append loop exists
(`auto-close-router-gap.ts`, commit `940e705`); the fixture router `0x663dc15d…` is **already
committed** in `listener/searcher/pools/force-include-routers.json:22` and the rule-12 flip test
already passes (`test/mempool-router-filter.ts:19` — "deBridge admitted false→true PASS", npm
`searcher:mempool-router-filter`). The ONLY plan item not yet implemented is the **quota-bucket
budgeting** (current `buildMempoolToAddressFilterWithRouters` `main.ts:2903–:2931` is first-come
`[fixed, pinned, hot]` under a 300 cap). → Gap B is re-scoped below to **B-residual** (small,
evidence-gated). Codex must NOT re-create `discover-routers.ts`.

**R2 — the `busy` exclusion is TWO-WAY; "idle-only (skip if busy)" is only half the constraint.**
`handleHint` sets `busy=true` at `main.ts:870` and every warm/state listener checks it — but nothing
stops a hint from starting while the ATOMIC scan is mid-flight unless the scan itself **takes the
`busy` slot**. The scan and a hint share the Anvil fork, `PoolStateCache`, and the solver; concurrent
use corrupts shared state. Spec (A4): the atomic scan runs `if (busy) skip` AND sets `busy=true` for
its own duration (`try/finally`), exactly like the hint path. Backrun keeps absolute priority via the
skip-first check + the coordinator policy.

> **R2 fix SUPERSEDED by P0-1 (owner final re-review, §0.3) — the hazard stands, the fix was wrong.**
> Taking `busy` makes an arriving hint hit `skip hint` (`main.ts:858–:859` — a DROP, not a queue), so
> an atomic scan holding the slot 1–2s silently drops backrun victims. Resolution = **lane isolation
> (slice A-lane)**: atomic gets its OWN `atomic_busy` and its OWN mutable state (own `PoolStateCache`
> + own sim backend instance), so there is nothing shared left to corrupt and no slot to hold. R2's
> two-way analysis remains the justification for WHY the mutable state must be per-lane.

**R3 — making `victim_hash` optional has an ANALYSIS-side compat surface the plan never lists.**
Every consumer that indexes events by `victim_hash` must tolerate its absence:
`analysis/src/cli/live-loss.ts` (`--watch` joins on victim hash), `redact-live-run.ts` (funnel
drill), `hermes-gate.ts` (step-1 validation), `route-gap-watcher.ts` (reads `bundle_not_included`).
A-contract's acceptance therefore includes running `redact-live-run` + `route-gap-watcher` over a
mixed (backrun+atomic) events fixture with **zero crashes and unchanged backrun aggregation**.

**R4 — the state-block gate is implementable today, but `PoolStateCache` lacks the query.**
`seedV2` stores per-entry `blockNumber` (`pool-state-cache.ts:281–:289`), Curve/v3-tick entries have
block fields — but there is no public `seedBlockOf(pool)` accessor. A4's `state_block ===
source_block` gate needs one. Also the CORRECT gate is per-pool, not global (see §A4): a pool
untouched in block N has block-invariant state — requiring literal `=== N` on every pool would skip
almost every scan. The precise rule: every cycle pool is either (a) in block N's changed set and
re-seeded at N, or (b) NOT in the changed set (any seed block ≤ N is then valid).

> **R4's rule (b) REDEFINED by P0-2 (owner final re-review, §0.3).** "Not in the swap-touched set ⇒
> any seed ≤ N is valid" is UNSOUND: non-swap events (and even eventless direct token transfers)
> mutate quote state, so the swap-only set never proves "unchanged". The `seedBlockOf(pool)` accessor
> is still required — but the gate becomes UNIFORM: **every candidate-cycle pool must be fresh-read at
> `source_block` before quote/sim (`seedBlockOf(pool) === sourceBlock`), else drop** (§A4). No
> block-invariance assumption survives; the cost is a handful of extra local-reth reads per candidate.

**R5 — A0's replay window is closing (operational, not architectural).**
The A0 sample `0x803a3693` is block 25455024; local reth prunes state to ~10k blocks
([[project-reth-node]]). If A0 does not run within days of 2026-07-04, its pre-tx state needs the
archive-RPC fallback (nail #7's contract applies to A0 too). → run A0 first, and persist the fixture
(pool states, not just the block number) so the gate stays replayable forever.

**Verdict: NO residual unknown-class production blocker.** The plan's architecture (7 nails + user
closures) stands. R1–R5 are scoping/precision items, all folded into the slices below. The single
biggest implementation risk is not a design gap but the **A-contract `processOpportunities`
factor-out** of a ~640-line loop body from `handleHint` (`main.ts:1287→~1905`) — mitigated below by
scoping it as a mechanical move gated on byte-equivalent replay fixtures.

### 0.3 Owner FINAL re-review (2026-07-04) — conditional approval: 5 blockers + the two-lane evolution

Conditional approval, folded (do not re-litigate the direction). Five must-fix items; **P0-1 EVOLVES
the concurrency design** (lane isolation — a new prerequisite slice **A-lane** — superseding R2's
"scan takes `busy`" fix). Explicitly NOT gating (owner): B-residual as scoped; A0's dust sample as
fixture (so long as the production enable-criterion never counts dust as success); C1's direction.

| id | blocker (verified anchor) | folded into |
|---|---|---|
| **P0-1** | Atomic must NOT share backrun's `busy` — the hint loop DROPS on busy (`main.ts:858–:859` `skip hint`, no queue; `busy` decl `:680`, set `:870`, cleared `:906`), so an atomic scan holding `busy` 1–2s silently drops backrun victims; the naive inverse ("atomic always yields") starves atomic on every busy block. Atomic = its OWN lane (`atomic_busy`, own mutable cache + sim instance); one `SubmissionCoordinator` stays the only cross-lane point. | **A-lane (NEW slice)** + §1.4 + A4 |
| **P0-2** (REVISED v1) | Swap logs are **TRIGGER-only** — they answer "which venues might have a spread this block", they do NOT prove "all other pools unchanged" (non-swap events — v2 `Sync`/`Mint`/`Burn`, v3 `Mint`/`Burn`, v4 `ModifyLiquidity`/`Donate`, Curve/Balancer add/remove-liquidity, even eventless direct token transfers — also mutate the reserves/slot0/liquidity that `pool-state-updater.ts:123–:224` quotes off). Do NOT chase an all-events registry (bottomless); instead: once a candidate cycle is formed, **fresh-read ALL its pools at `source_block` BEFORE quote/sim** — spread gone after fresh-read ⇒ drop; any cycle pool unreadable ⇒ drop, never guess. Supersedes the R4 "untouched ⇒ block-invariant" rule (unsound under non-swap events). | A4 (+A-lane cache rules) |
| **P0-3** (MERGED with P0-2) | The scanner delta-updates only swap-touched pools, but atomic compares them against RETURN venues — the atomic view ≫ backrun's warm set, so the return pool is often cold ⇒ "have the graph + path, skip on missing state". → bounded neighborhood expansion (swap-touched pool → peer venues on the pair/ring) whose fresh-read at `source_block` IS the same mechanism as P0-2's pre-quote gate: **ONE rule — seed/fresh-read every candidate-cycle pool at `source_block` before quote; drop if unreadable** (expansion forms the cycle; the gate verifies the formed cycle). | A4 |
| **P1-4** | C2's full-sweep replay (`changedPools: null`) answers CAPABILITY ("could the scanner find it"), not LIVE ADMISSION ("would live A4 have scanned it" — live is delta-triggered). → split `capability_replay_stage` / `live_admission_stage`; sweep-found-but-not-delta-triggered ⇒ `primary_gap = atomic_scan_not_triggered`. | C2-minimal |
| **P1-5** | This spec dropped the plan's `venue_view_version` (plan md `:190`) keeping only `strategy_view_used` — a real regression. Restore `strategy_view_version` + `atomic_view_hash`/`backrun_view_hash` on atomic events AND `LearningCase`, else replay-now ≠ live-then and no close is provable. | §1.3 / §1.5 / A-universe |

**Re-gated ordering (owner decision — encoded per-slice below and in §5):**
- **GO now:** C1, A0, A-contract, A-universe, and the **offline-fixture** A1/A2/A3 (+ the new A-lane).
- **BLOCKED:** **A4 live wiring** until the A-lane gate + the merged P0-2/P0-3 fresh-read gate are
  green; **C2 as the AUTHORITATIVE auto-close judgment** until P1-4 (capability/live-admission split)
  + P1-5 (view versioning) land — C2-minimal may ship and REPORT, but D must not act on a pre-split
  verdict.

**Honesty line (owner, recorded):** a same-process idle-only atomic (this spec's pre-P0-1 design) is
a **learning/measurement tool, not a competitive atomic searcher** — lane isolation is what makes it
production-parallel. First step = same-machine dual-lane (shared read-only reth, separate sim
instances); split to a 2nd machine later only if CPU/IO contends.

---

## 1. Shared contracts (pinned once; every slice references these)

### 1.1 `Opportunity` discriminated union — `listener/src/searcher/detector/detector.ts` (MODIFY)

```ts
export interface BackrunOpportunity {          // today's shape, renamed; zero field changes
  kind: "backrun-arb";
  victimTxHash: string;
  blockNumber: number;
  affectedPools: string[];
  affectedTokens: string[];
  startToken: string;
  profitToken: string;
  victimAmountIn: bigint;
  targetNetProfit?: bigint;
  hints: Record<string, unknown>;
}

export interface AtomicOpportunity {
  kind: "atomic-arb";
  sourceBlock: number;           // block whose end-state the scan read (target = sourceBlock+1)
  stateBlock: number;            // consistency evidence; gate: per-pool rule (§A4), recorded on events
  cycleId: string;               // canonicalTokenRing(ring).join(",") — block-free ring identity
  cycleFingerprint: string;      // cycleFingerprint(sourceBlock, ring) — the C2 join key
  seedEdges: TokenEdge[];        // the EXACT ordered cycle; the planner is bound to these edges
  affectedPools: string[];       // seedEdges targets (warm/telemetry compat)
  affectedTokens: string[];      // the ring tokens
  startToken: string;            // === flashToken (solver.ts:120 reads startToken as flash)
  profitToken: string;           // === flashToken
  flashToken: string;            // pinned by the scanner; planner MUST NOT rotate (nail #1/#2 of A-contract)
  searchSeed: { searchCenter: bigint; maxInput?: bigint };  // flashToken units, center > 8n
  estSpreadBps: number;          // telemetry / ranking only — never identity
  targetNetProfit?: bigint;
  hints: Record<string, unknown>;   // MUST NOT contain hints.impact
}

export type Opportunity = BackrunOpportunity | AtomicOpportunity;
```

Compile-audit surface (TypeScript makes it exhaustive — every `opp.victimTxHash` /
`opp.victimAmountIn` access errors until narrowed by `opp.kind`): `main.ts`, `events.ts`,
`planner/planner.ts`, `solver/solver.ts`, `detector/*`, plus tests. No other non-test consumers
(verified by the union's current single construction site `detector.ts:71`).

### 1.2 Cycle identity — `listener/src/searcher/detector/cycle-fingerprint.ts` (CREATE)

Lives in **listener** (analysis imports it relatively, precedent `live-loss.ts:15`), so both sides
share ONE implementation of the join key.

```ts
/** ring = cycle token sequence WITHOUT the repeated start, e.g. [A,B,C] for A→B→C→A. */
export function canonicalTokenRing(ring: readonly string[]): string[] {
  const t = ring.map((x) => x.toLowerCase());
  const minIdx = t.indexOf([...t].sort()[0]);                 // 1. rotate: lowest-address first
  const rot = [...t.slice(minIdx), ...t.slice(0, minIdx)];
  const rev = [rot[0], ...rot.slice(1).reverse()];            // 2. orient: smaller 2nd element wins
  return (rev[1] ?? "") < (rot[1] ?? "") ? rev : rot;
}
export function cycleFingerprint(sourceBlock: number, ring: readonly string[]): string {
  return ethers.keccak256(ethers.toUtf8Bytes(`${sourceBlock}|${canonicalTokenRing(ring).join(",")}`));
}
```

Invariants (unit-tested in A-contract's gate): rotation-invariant, direction-invariant, distinct
rings ⇒ distinct fingerprints, size/venue/route NOT in identity (comparison attributes only).
Temporal rule (user point 1): a competitor tx executing in block `B` joins at
`cycleFingerprint(B−1, ring)` — C2 computes `source_block = B−1`, always.

### 1.3 Telemetry — `listener/src/searcher/events.ts` (MODIFY)

- `victim_hash` becomes **optional** on `opportunity_seen` / `simulation_result` /
  `pipeline_dropped` / `bundle_submitted` / `bundle_included` / `bundle_not_included` (R3 compat
  gate applies). Backrun emission sites keep passing it — no backrun event changes shape.
- New optional fields on those events: `opportunity_kind?: "backrun-arb" | "atomic-arb"`,
  `source_block?`, `cycle_id?`, `cycle_fingerprint?`, `strategy_view_used?: "backrun" | "atomic"`,
  `search_center?: string`, `candidate_rank?: number`, `scanner_budget_ms?`, `seed_venues?: string[]`.
- **View versioning (P1-5 — restores the architecture plan's `venue_view_version`, plan md `:190`,
  which an earlier draft of this spec dropped):** `strategy_view_version?: string`,
  `atomic_view_hash?: string`, `backrun_view_hash?: string` on every atomic-carrying event (and on
  `atomic_scan_result`). Computed once per view build by `buildStrategyViews` (§A-universe) — hash =
  keccak over the sorted pool ids/addresses of the view + the overrides-file content hash +
  `pool_universe_generated_at`. Without them: replay-now ≠ live-then, an auto-close cannot prove THIS
  close fixed the gap (the view changed underneath), and re-runs confuse "missing-then" vs "fixed-now".
- New event (nail #4 — exactly ONE per newHead while the flag is on, regardless of outcome):

```ts
| {
    type: "atomic_scan_result";
    source_block: number;
    state_block: number | null;          // null when outcome !== "ran"
    outcome: "ran" | "skipped_busy" | "stale_state" | "budget_exceeded" | "disabled" | "breaker_open";
    // skipped_busy = OWN-lane overrun (atomic_busy) ONLY — never "backrun busy" (P0-1, slice A-lane)
    scanned_pairs: number;
    swap_touched_pools: number;        // trigger-set size (P0-2: trigger-only semantics)
    candidates: number;
    scan_ms: number;
    skipped_reason?: string;
  }
```

- New `pipeline_dropped` reasons (string values, no schema change):
  `atomic_stale_target_block` (nail #3), `submission_arbitration_lost` (nail #2), `dedup_per_block`
  (A-contract #5), `atomic_state_inconsistent` (the P0-2 fresh-read gate), and
  `atomic_preempted_by_backrun` (P0-1 — an atomic candidate/holder losing the SUBMISSION slot to a
  backrun; a sub-class of arbitration loss that fires ONLY at the coordinator, never on the
  scan/read path).
- New id derivation (never a fabricated source-swap hash):

```ts
export function makeAtomicOpportunityId(input: {
  sourceBlock: number; cycleId: string; startToken: string; seedPools: string[];
}): string   // keccak("atomic|" + sourceBlock + "|" + cycleId + "|" + startToken + "|" + sortedSeedPools)
```

### 1.4 `SubmissionCoordinator` — `listener/src/searcher/execution/submission-coordinator.ts` (CREATE)

**Two-lane context (P0-1, owner final re-review).** The coordinator is no longer arbitrating two
callers inside ONE serialized hot path — it is the **single cross-lane touch point** between two
independent producers, each with its own busy flag and its own mutable state:

```
newHeads ──> AtomicLane  ── scan/solve/sim (atomic_busy, OWN PoolStateCache + sim instance) ──┐
                                                                                              ├─ SubmissionCoordinator ─ submit
mempool  ──> BackrunLane ── detect/solve/sim (busy, today's hot path — unchanged)            ┘
```

The lanes SHARE only read-only chain access (local reth / `mainnetBackend` reads) and this
coordinator (one wallet nonce / one target-block slot, `submitter.ts:296` + `:79/:250`). They share
NO mutable fork/simulator/cache state (slice A-lane). Because the two lanes now run genuinely
concurrently, **`offer()` MUST stay synchronous — no `await` inside** — so an admission decision is
atomic within one event-loop tick (the only serialization the two lanes get).

```ts
export interface SubmissionCandidate {
  strategy: "backrun" | "atomic";
  opportunityId: string;
  targetBlock: number;
  netEvWei: bigint;              // post-EV-gate net (profit − gas − tip), ETH wei
  deadlineAtMs?: number;
}
export type SlotDecision =
  | { admit: true; replaces?: SubmissionCandidate }
  | { admit: false; reason: "submission_arbitration_lost" | "atomic_preempted_by_backrun";
      holder: SubmissionCandidate };

export class SubmissionCoordinator {
  constructor(policy?: { atomicPreemptMarginBps?: number });   // default 0 = atomic never preempts backrun
  offer(c: SubmissionCandidate): SlotDecision;                 // SYNC; called immediately BEFORE bundleRouter.submit
  onBlock(latest: number): void;                               // prune slots with targetBlock <= latest
}
```

Decision matrix (one slot per `targetBlock`; grounded in `submitter.ts:296` one pending nonce +
`:79/:250` one pinned target block ⇒ at most one live submission per slot is meaningful):

| slot holder | candidate | decision |
|---|---|---|
| — (empty) | any | admit |
| backrun | backrun | **admit** (replacement; preserves today's serial last-write behavior exactly — refactor-neutral) |
| backrun | atomic | **reject** → `atomic_preempted_by_backrun` (backrun-first default; a policy change is an economics/human call) |
| atomic | backrun | **admit + replaces** (same pending nonce ⇒ the later bundle supersedes at builders); the replaced atomic emits `pipeline_dropped/atomic_preempted_by_backrun` |
| atomic | atomic | admit only if `netEvWei > holder.netEvWei` (replacement), else reject → `submission_arbitration_lost` |

`atomic_preempted_by_backrun` fires ONLY here, at the submission slot — never on the scan/read path
(the P0-1 acceptance: backrun can preempt atomic's SUBMISSION, it can never suppress atomic's SCAN,
and vice-versa an atomic scan can never make a hint hit `skip hint`). With
`SEARCHER_ENABLE_ATOMIC_SCAN=0` every offer is backrun-vs-backrun ⇒ always admit ⇒ **zero
behavior change** (asserted in the A-contract gate).

### 1.5 `LearningCase` — `analysis/src/learning/learning-case.ts` (CREATE)

```ts
export interface LearningCase {
  learning_case_id: string;        // keccak(strategy|trigger|competitor_tx|source_block|cycle_fingerprint|primary_gap)
  status: "open" | "proposed_close" | "replay_passed" | "applied" | "live_verified"
        | "parked_uneconomic" | "manual_required";
  strategy: "backrun" | "atomic";
  trigger: "bundle_not_included" | "competitor_not_seen";
  competitor_tx?: string;
  our_opportunity_id?: string;
  source_block?: number;           // atomic: competitor_execution_block − 1  (user point 1)
  target_block?: number;           // atomic: competitor_execution_block
  cycle_fingerprint?: string;
  comparable: boolean;             // winner_style atomic_loop only; one_leg_inventory/sandwich ⇒ false
  primary_gap: string;             // atomic taxonomy (§C2) or backrun taxonomy
  our_stage?: "not_scanned" | "cycle_not_found" | "no_plan" | "no_quote" | "sizing_failed"
            | "sim_failed" | "below_ev" | "submitted_lost" | "replay_state_unavailable";
  // P1-5: which live view was in effect / which view the replay ran against — a close is provable
  // only if the before/after stage transition is attributable to a view change:
  strategy_view_version?: string;
  atomic_view_hash?: string;
  backrun_view_hash?: string;
  // P1-4: capability vs live-admission (from AtomicReplayReport; see C2-minimal):
  capability_replay_stage?: string;   // full-sweep replay — "could the scanner find it at all"
  live_admission_stage?: string;      // delta-trigger replay — "would live A4 have scanned it then"
  evidence: Record<string, unknown>;
  close_action?: { kind: string; target_file?: string; entries?: string[] };
  replay_gate?: { command: string; expected_transition: string; before?: string; after?: string };
  created_at: string; updated_at: string;
}
```

Store: `analysis/learning-cases/store.json` (committed — small derived JSON, no secrets/raw logs;
same durability rationale as `force-include-poolids.json`). API:
`loadCases() / upsertCase(c) / advanceStatus(id, next)` — **forward-only** transitions
(`open → proposed_close → replay_passed → applied → live_verified`; terminals `parked_uneconomic`,
`manual_required`). `parked_uneconomic` re-opens ONLY on the same `cycleId` (block-free ring
identity) reappearing with `estSpreadBps ≥ k×` the parked value (default k=3) — the dust
steady-state terminal (nail #5). Replay-verdict cache: `analysis/learning-cases/replay-cache/
<learning_case_id>.json` (gitignored; one replay per case-version — nail #7 CU discipline).

---

## 2. Slice-by-slice code-level design + acceptance

Rule-12 form throughout: deterministic slice ⇒ pinned fixture that FLIPS
(`failing_sample / replay_command / expected_transition`); non-deterministic ⇒ before/after metrics.

### A0 — decode/verify the atomic sample (run FIRST — R5 prune window)

**Status: GO** (owner re-gate 2026-07-04; the dust sample is fine as a FIXTURE — the §4 production
enable-criterion never counts dust as success).

| action | path |
|---|---|
| CREATE | `listener/src/searcher/test/fixtures/atomic-coffee-803a3693.json` |
| CREATE | `listener/src/searcher/test/atomic-a0-replay.ts` + npm `searcher:atomic-a0` |

Method: at block **25455023** (pre-state of `0x803a3693`, block 25455024, 3 pools, net $0.33),
read each cycle pool's state (reserves / `slot0`+liquidity) from local reth (fallback: archive RPC
per nail #7), persist INTO the fixture (states, not just the block number — replayable after
prune-out), recompute the cycle output with the existing local math (`solver/v3-math.ts`,
constant-product) and assert gross > 0 ≈ the doc's figure.
- `failing_sample:` coffee #2 `0x803a3693` @ 25455024
- `replay_command:` `cd listener && npm run searcher:atomic-a0`
- `expected_transition:` cycle reconstructable from public state alone; `expectedGrossWei > 0`
  recorded in the fixture consumed by A1/A2/A3.

### A-contract — union + telemetry + shared entry + coordinator (PREREQUISITE)

**Status: GO** (owner re-gate 2026-07-04; carries the §1.4 two-lane coordinator semantics + the
§1.3 P1-5 view fields).

| action | path | change |
|---|---|---|
| MODIFY | `listener/src/searcher/detector/detector.ts` | §1.1 union (`BackrunOpportunity` rename is type-only; `detect()` still returns backrun shapes) |
| MODIFY | `listener/src/searcher/events.ts` | §1.3 (optional `victim_hash`, atomic fields, `atomic_scan_result`, `makeAtomicOpportunityId`) |
| CREATE | `listener/src/searcher/detector/cycle-fingerprint.ts` | §1.2 |
| MODIFY | `listener/src/searcher/execution/bundle-router.ts` | `victimTxHash?: string` (standalone path already ignores it, `:81`) |
| CREATE | `listener/src/searcher/execution/submission-coordinator.ts` | §1.4 |
| MODIFY | `listener/src/searcher/main.ts` | factor out `processOpportunities`; route both submit sites through the coordinator |
| CREATE | `listener/src/searcher/test/atomic-contract.ts` + npm `searcher:atomic-contract` | the gate below |

**`processOpportunities` factor-out (the risky part — scope it mechanically).** Extract the
opportunities for-loop body (`main.ts:1287 → ~1905`, plan→solve→sim→terminal-verify→EV-gate→submit
+ every `pipeline_dropped` emission) into:

```ts
type SourceMeta =
  | { kind: "backrun-arb"; victimTxHash: string; victimRawTx?: string;
      submissionMode: "victim-bundle" | "hash-only" | "standalone"; eventBlockNumber: number }
  | { kind: "atomic-arb"; sourceBlock: number };   // targetBlock derived = sourceBlock + 1, PINNED

async function processOpportunities(
  ctx: HandleCtx, opportunities: Opportunity[], sourceMeta: SourceMeta,
): Promise<void>
```

Constraints: **mechanical move, zero logic edits** — seg-timing marks stay at the `handleHint` call
site; closures (`emitPipelineDropped`, fixture recorder vars) become explicit params or `ctx`
fields; target-block logic branches on `sourceMeta.kind`: backrun keeps `latest+1` at submit
(`main.ts:1834`, unchanged); atomic pins `sourceBlock+1` and drops `atomic_stale_target_block`
when `ctx.blockTracker.latest > sourceMeta.sourceBlock` (nail #3 — implemented here, exercised in
A4). Event emission uses `victim_hash` only for the backrun arm; the atomic arm uses
`makeAtomicOpportunityId` + `opportunity_kind/source_block/cycle_*` fields.

**Backrun preservation:** `handleHint` delegates to `processOpportunities` with the backrun
`SourceMeta`; every existing fixture must replay byte-identically.

**Gate (deterministic):**
- `replay_command:` `npm run searcher:planner && npm run searcher:replay-live-fixtures && npm run searcher:atomic-contract`
- `expected_transition:` backrun suites pass **unchanged** (14/14 + live fixtures, profit
  equivalence 1 wei); new unit test asserts —
  (a) two anchors in one `source_block` ⇒ **distinct** `opportunity_id`s;
  (b) same ring, 2 rotations × 2 directions ⇒ **same** `cycle_fingerprint`; two different rings ⇒
  different (canonical-join invariance);
  (c) batch of ≥2 profitable atomic opps, one block ⇒ exactly one `bundle_submitted`, losers emit
  `pipeline_dropped/dedup_per_block`;
  (d) backrun + atomic candidates, same target block ⇒ one submitted, loser
  `atomic_preempted_by_backrun` (§1.4 matrix rows 3/4 asserted both directions; the reason fires
  at the coordinator only);
  (e) with atomic disabled, N backrun offers ⇒ N admits (coordinator neutrality);
  (f) **R3 compat**: `redact-live-run` + `route-gap-watcher --dry-run` consume a mixed
  backrun+atomic events fixture with no crash and unchanged backrun aggregation.

### A-universe — strategy-scoped selection views (PREREQUISITE, with A-contract)

**Status: GO** (owner re-gate 2026-07-04; now also owns the P1-5 `versions.*` computation).

| action | path | change |
|---|---|---|
| CREATE | `listener/src/searcher/strategy-views.ts` | `buildStrategyViews` below |
| CREATE | `listener/src/searcher/atomic-view-overrides.ts` | loader/appender mirroring `force-include.ts` — `DEFAULT_ATOMIC_VIEW_OVERRIDES_PATH = resolve("searcher","pools","atomic-view-overrides.json")` (nail #6: cwd-relative `searcher/pools/`, NOT `src/`) |
| CREATE | `listener/searcher/pools/atomic-view-overrides.json` | committed `[]` seed (survives deploy) |
| MODIFY | `listener/src/searcher/main.ts` (~`:560–:610`) | build views; backrun view feeds planner graph + mempool filter; atomic view feeds scanner |
| CREATE | `listener/src/searcher/test/universe-split.ts` + npm `searcher:universe-split` | the gate |

```ts
export interface StrategyViews {
  backrun: PoolEntry[];
  atomic: PoolEntry[];
  versions: {                       // P1-5 — computed HERE, once per build, stamped on every event
    strategy_view_version: string;  // keccak(backrun_view_hash | atomic_view_hash | pool_universe_generated_at)
    backrun_view_hash: string;      // keccak over the sorted backrun view pool ids/addresses
    atomic_view_hash: string;       // keccak over the sorted atomic view ids + overrides content hash
    pool_universe_generated_at: string;  // from the universe file metadata
    overrides_hash: string;         // content hash of atomic-view-overrides.json
  };
}
export function buildStrategyViews(
  basePools: PoolEntry[],          // exactly today's allPools input set
  universeFile: PoolEntry[],       // loadPoolUniverse(maxPools: 0 = uncapped) — the broad pool
  overrides: PoolEntry[],          // loadAtomicViewOverrides()
  opts: { atomicMaxPools: number } // SEARCHER_ATOMIC_VIEW_MAX_POOLS, default 6000
): StrategyViews
// backrun = basePools, BIT-FOR-BIT today's selection (refactor-neutral: same merge order,
//           same TOP_N slice, same pair-completion — main.ts:560–:603 unchanged in effect)
// atomic  = backrun ∪ selectArbRelevantPools(universeFile, …) ∪ overrides, capped atomicMaxPools
```

- One union edge graph: `atomicEdges = await buildTokenGraph(backend, views.atomic)`; the backrun
  planner keeps consuming exactly the edges it gets today (`main.ts:603`). The planner does NOT
  need the atomic view at all — atomic planning is `seedEdges`-bound (nail #1 resolves at the
  scanner boundary; see A1). This is the memory-cheap "one union graph, two edge-selection views".
- **Mempool `toAddress` filter is built from `views.backrun` only** (`main.ts:2596` call site) — the
  atomic score can never displace a source-swap-likely pool from the 200 hot slots.
- `selectArbRelevantPools` promotion from build-time (`build-active-pool-universe.ts:238`) to this
  runtime view IS the arb-relevance-epic unification ([[project-pool-scoring-arb-relevance-epic]]).

**Gate (deterministic, `searcher:universe-split`):**
- `expected_transition:` (i) `buildMempoolToAddressFilter(views.backrun)` returns a **set-equal**
  list before vs after widening the atomic view by 1000 pools (no displacement — decoupling proof);
  (ii) atomic view contains ≥1 loop-closure pool absent from the backrun set (views actually
  differ; also the nail-#1 view assertion: backrun edge set EXCLUDES that venue, atomic edge set
  INCLUDES it); (iii) loader-reads-written-file: `appendAtomicViewOverrides([X])` then
  `buildStrategyViews` ⇒ X ∈ atomic view AND X ∉ backrun view AND X ∉ mempool filter (nail #6
  loader gate + the Gap-D isolation invariant, proven at creation time); (iv) **view-hash contract
  (P1-5):** two builds from identical inputs ⇒ identical `versions.*`; appending one override ⇒
  `atomic_view_hash` AND `strategy_view_version` change while `backrun_view_hash` is unchanged (the
  attributability primitive the C2/D before-after proof rests on).

### A1 — anchor finder: delta-seeded O(pairs) 2-hop scan

**Status: GO — offline-fixture scope** (owner re-gate 2026-07-04; the pure scanner + planner
binding + pinned fixtures; live wiring stays in the BLOCKED A4).

| action | path |
|---|---|
| CREATE | `listener/src/searcher/detector/atomic-scanner.ts` |
| MODIFY | `listener/src/searcher/planner/planner.ts` (atomic branch) |
| MODIFY | `listener/src/searcher/solver/pool-state-cache.ts` (R4: `seedBlockOf(pool): number \| undefined`) |
| MODIFY | `listener/src/searcher/test/planner.ts` (atomic fixtures — REUSE the harness, per rule 12) |

```ts
export interface AtomicScanConfig {
  maxHops: number;                 // SEARCHER_ATOMIC_MAX_HOPS=4
  minSpreadBps: number;            // SEARCHER_ATOMIC_MIN_SPREAD_BPS=10
  maxCandidates: number;           // SEARCHER_ATOMIC_MAX_CANDIDATES=8
  budgetMs: number;                // SEARCHER_ATOMIC_SCAN_BUDGET_MS=2000
  pricedTokens: Map<string, { maxBorrow: bigint }>;   // flash-borrowable tokens (WETH first)
}
export interface AtomicScanOutcome {
  outcome: "ran" | "budget_exceeded";
  stateBlock: number | null;
  scannedPairs: number;
  swapTouchedPools: number;        // trigger-set size (P0-2: trigger-only)
  opportunities: AtomicOpportunity[];   // ranked, length ≤ maxCandidates
}
export function detectAtomicOpportunities(input: {
  edges: TokenEdge[];              // the ATOMIC view's edges
  cache: PoolStateCache;           // the atomic LANE's own cache (A-lane) — never backrun's
  sourceBlock: number;
  swapTouched: Set<string> | null; // P0-2: TRIGGER-only ("which venues MIGHT have a spread") — NEVER
                                   // a consistency proof; null = full sweep (periodic backstop)
  cfg: AtomicScanConfig;
}): AtomicScanOutcome                // PURE + SYNC over the warm cache — zero RPC. This purity is
                                     // what makes the C2 offline replay exact (same fn, same inputs).
                                     // The caller (A4 lane / C2 replay) does ALL reads: it fresh-reads
                                     // the expanded trigger∪peer set into the cache BEFORE calling
                                     // this, and gates every FORMED cycle on fresh state after (§A4).
```

Algorithm (2-hop):
1. Group `edges` by unordered pair key `min(tokenIn,tokenOut)|max(…)`; keep pairs with ≥2 distinct
   venues (pre-computed once per graph rebuild, not per block).
2. Delta-restrict: keep pairs with ≥1 edge whose pool ∈ `swapTouched` (O(touched), the hot path —
   trigger semantics only, per P0-2).
3. Per venue mid-price from cache (no RPC): v2 `reserveOut/reserveIn`; v3 `(sqrtPriceX96/2^96)^2`;
   curve-ng from cached balances where available, else skip the venue (recorded — not silently).
4. `spreadBps = (maxMid − minMid)/minMid × 10^4 − feeBps(cheap) − feeBps(rich)`; anchor iff
   `> minSpreadBps`.
5. `flashToken` = the ring token present in `pricedTokens` (prefer WETH); neither priced ⇒ skip
   (telemetry `scanner_skip_reason:"no_priced_ring_token"`).
6. **`searchCenter` derivation (replaces the `1n` fallback — the verified landing blocker):**
   size that moves the cheap venue roughly half the spread toward the rich venue's price —
   v2: `Δin ≈ reserveIn_cheap × spreadBps / (2×10^4)`;
   v3: `Δin ≈ L × (1/sqrtP_cheap − 1/sqrtP_target)` scaled to token units (target = mid of the two
   prices). Clamp to `[10^3, min(reserveIn_cheap/4, pricedTokens.maxBorrow)]`; `maxInput` = the
   clamp ceiling. Precision is non-critical — the solver's geometric grid (`halfWidth=3`) + GSS
   refines around the center; the requirement is order-of-magnitude ≫ 8 wei, in `flashToken` units.
7. Emit one `AtomicOpportunity` per anchor (2-edge `seedEdges`, oriented buy-cheap→sell-rich from
   `flashToken`); rank by `estSpreadBps × log10(depth)`; truncate to `maxCandidates`.

**Planner binding (nail #1 — selection by `opp.kind`, ONE signature).** `plan()` head
(`planner.ts:126`): `if (opp.kind === "atomic-arb") return this.planAtomicFromSeedEdges(opp, templates, opts);`
`planAtomicFromSeedEdges` builds the single `TokenPath` **directly from `seedEdges`** — it never
calls `buildTokenPaths`, `focusPathsOnImpact`, or `buildBorrowabilityRotations` (rotation disabled ⇒
`searchSeed` stays unambiguously in `flashToken` units); template/flash-adapter matching reuses the
existing machinery; `plan.maxFlashAmount := searchSeed.maxInput`. Backrun flow through `plan()` is
untouched (the branch is one early return).

**Gate (rule-12, `npm run searcher:planner` — extend `REPLAY_FIXTURES`, no new harness):**
- `failing_sample:` synthetic 2-venue WETH-pair anchor + the A0-derived 2-hop sub-case
- `expected_transition:` `candidate_plans 0→>0`; **every candidate's path contains exactly the seed
  pools** (anchor-constrained, not whole-graph); resolved center `>8n` and in `flashToken` units
  (no rotation present in any candidate); a no-spread control fixture yields 0 anchors (no false
  positives from fee-adjusted mids).

### A2 — bounded 3–4-hop cycle extension (where the value is)

**Status: GO — offline-fixture scope** (owner re-gate 2026-07-04).

| action | path |
|---|---|
| MODIFY | `listener/src/searcher/detector/atomic-scanner.ts` (extend) |
| CREATE | `listener/src/searcher/test/bench-atomic.ts` + npm `searcher:bench-atomic` (clone `bench-topn-latency.ts` pattern) |

Extension after step 7: for each anchor token (the ≤2×anchors distinct tokens from A1's flagged
pairs, deduped), **REUSE `buildTokenPaths(atomicEdges, t, t, { maxHops: cfg.maxHops,
maxPoolsPerToken: 8, maxPaths: 2000, deadlineAtMs })`** (`token-graph.ts:462` — start===profit
enumerates cycles; existing, harness-tested code — do NOT write a new DFS). Score each returned
ring by `Σ log(mid_i × (1 − fee_i))` from the cache; keep rings with positive log-sum whose
bps-equivalent `> minSpreadBps`; emit as `AtomicOpportunity` with the full ring as `seedEdges`
(same §A1 steps 5–7 for flashToken/center). Anchored seeding keeps this O(anchors × 8^4) worst
case; measured planner cost 114ms @ 4216 pools ([[project-topn-latency-curve]]) vs the ~12s
next-block deadline ⇒ comfortable, but the `budgetMs` deadline still hard-stops
(`outcome:"budget_exceeded"`, partial results kept).

**Gate 1 (rule-12 correctness, `searcher:planner`):** `failing_sample:` the A0 fixture (#2
`0x803a3693`, 3-hop) as a pinned cache-state fixture; `expected_transition:` ring found +
`candidate_plans 0→>0` with all 3 seed pools in the path.
**Gate 2 (rule-12 latency, `searcher:bench-atomic`):** full A1+A2 pass at `maxHops=4` over the
atomic view < `budgetMs` (relative, harness-bound); if not, `maxHops=3` (still captures #2) and
record the trade-off.

### A3 — no-source-swap solve + sim + standalone build

**Status: GO — offline-fixture scope** (owner re-gate 2026-07-04).

| action | path | change |
|---|---|---|
| MODIFY | `listener/src/searcher/solver/solver.ts` | `resolveSearchCenter` head (`:442`): `if (plan.opportunity.kind === "atomic-arb") return plan.opportunity.searchSeed.searchCenter;` — before the `victimAmount` read (which no longer exists on the atomic arm; TypeScript enforces the narrow). Backrun path byte-identical. |
| MODIFY | `listener/src/searcher/test/replay-live-fixtures.ts` | accept an atomic fixture (no `localVictimApply` — sim directly on fork state, the existing standalone/mined path shape) |

End-to-end on the A0 fixture: `planAtomicFromSeedEdges` → `solver.solve` (deadline = atomic budget,
NOT the 5s backrun TTL) → terminal verify (`main.ts:1617` area, unchanged) → EV gate (`evGate`,
unchanged) → `standalone` `BundleSubmission` (no `victimTxHash`; `bundle-router.ts:81` path).

**Gate (rule-12, `npm run searcher:replay-live-fixtures`):**
- `failing_sample:` A0 fixture; `replay_command:` `npm run searcher:replay-live-fixtures`
- `expected_transition:` `atomic_scan no_candidate → sim.success=true + netEV>0 post-gas + EV gate
  pass + standalone BundleSubmission produced (DryRun signs)`; **assert the resolved center came
  from `searchSeed` (`center > 8n`, logged)** — the `1n` dust-grid failure mode stays dead.

### A-lane — lane isolation: atomic gets its own busy/cache/sim (NEW, P0-1 — hard prerequisite of A4)

**Status: GO** (owner re-gate 2026-07-04; parallelizable with C2-minimal, after A-contract).

**Why a slice, not an A4 tweak:** P0-1 changes the concurrency MODEL (who may block whom), not a
scheduling detail — every A4 line that touched `busy` was wrong, and the isolation needs its own
deterministic gate before any live wiring. A same-process idle-only atomic (the pre-P0-1 design) is
a learning/measurement tool, not a competitive atomic searcher; lane isolation is what makes it
production-parallel.

| action | path | change |
|---|---|---|
| CREATE | `listener/src/searcher/atomic-lane.ts` | `AtomicLane` — owns `atomic_busy`, its OWN `PoolStateCache` + `PoolStateUpdater` + sim backend instance, the chunked scan driver, `lastTriggerBlock` |
| MODIFY | `listener/src/searcher/main.ts` | instantiate the lane's dependencies behind `SEARCHER_ENABLE_ATOMIC_SCAN` (construction only — the `newHeads` hook itself is A4); backrun hot path untouched |
| CREATE | `listener/src/searcher/test/atomic-lane.ts` + npm `searcher:atomic-lane` | the gate below |

**Lane rules (pinned — the P0-1 contract):**
1. **Two independent busy flags.** `atomic_busy` is private to the lane; the hint loop's `busy`
   (`main.ts:680/:858/:870/:906`) is NEVER read or written by the lane. A backrun hint arriving while
   the atomic lane scans/solves MUST be processed — zero new `skip hint`.
2. **Shared read-only, private mutable.** Lanes share the read-only local reth / `mainnetBackend`
   reads. The lane owns its OWN `PoolStateCache` + `PoolStateUpdater` (backrun's cache is mutated by
   the warm loop mid-hint — sharing it is the R2 corruption hazard) and its OWN simulator/fork
   instance. The ONLY cross-lane objects: the `SubmissionCoordinator` (§1.4, sync `offer()`), the
   append-only events emitter, and `blockTracker` (read-only).
3. **Node event-loop honesty (the second-order catch — a "lane" is a scheduling construct, not
   parallelism).** One process = one JS thread: a long SYNC scan blocks hint processing even with
   separate busy flags. The lane driver therefore runs `detectAtomicOpportunities` in **bounded pure
   chunks with cooperative yields** (`await setImmediate`-equivalent between pair-batches, budget
   checked per chunk); each chunk stays pure/sync so the C2 replay (which calls the whole fn in one
   pass) remains exact. If a dry-run window shows hint `prep_ms p95` regressing despite chunking,
   escalate to `worker_threads` / the 2nd machine — do NOT re-couple the lanes.
4. **Trigger-gap tracking (coverage, not correctness):** the lane records `lastTriggerBlock`; after
   skipped blocks (`atomic_busy` overrun / breaker), the next scan fetches trigger logs
   `fromBlock=lastTriggerBlock+1 → N` (cheap on local reth). Correctness never depends on this — the
   P0-2 fresh-read gate holds regardless of missed triggers; a gap only delays discovery.

**Second-order costs (accepted, recorded):**
- **Duplicate state reads:** the atomic cache re-reads pools already warm in backrun's cache —
  zero-CU on local reth but extra node load; bounded because the lane seeds ONLY the expanded
  trigger∪peer set per block (never a per-block full-view sweep).
- **Extra sim instance:** a second anvil/revm fork ≈ extra memory + fork-refresh reads; sized in the
  A4 window (this is the concrete cost of "atomic gets its own sim").
- **Genuinely concurrent `processOpportunities`:** both lanes may be inside it simultaneously — safe
  because each lane passes its OWN ctx (own cache/simulator), events are append-only, and the
  coordinator's sync `offer()` is the single serialization point; the submitter's
  `getNonce("pending")` (`submitter.ts:296`) sequences cross-slot submits.
- **`skipped_busy` redefined:** in `atomic_scan_result`, `skipped_busy` now means the lane's OWN
  previous scan overran (`atomic_busy`) — never "backrun was busy" (that condition no longer exists).

**Gate (deterministic, `searcher:atomic-lane`):**
- `failing_sample:` synthesized backrun hint injected mid-atomic-scan (harness parks the lane inside
  a scan chunk)
- `expected_transition:` (a) the hint IS processed — `handleHint` runs to completion, **zero
  `skip hint` emissions attributable to the atomic lane** (P0-1 acceptance); (b) the hint's
  observed start-delay is bounded by one chunk (the event-loop yield proof); (c) an atomic scan
  overrunning into the next block ⇒ `atomic_scan_result{outcome:"skipped_busy"}` keyed on
  `atomic_busy` only; (d) an atomic candidate losing the submission slot to a backrun emits
  `pipeline_dropped/atomic_preempted_by_backrun`, and NO scan/read-path event ever carries that
  reason (submission-slot-only, §1.4); (e) backrun suites re-run unchanged with the lane
  constructed-but-idle (refactor-neutral).

### A4 — live wiring + dry-run window (LAST; C2-minimal ships first)

**Status: BLOCKED** (owner re-gate 2026-07-04) — do not start until the A-lane gate
(`searcher:atomic-lane`) and the merged P0-2/P0-3 fresh-read gate fixtures (below, pinned in
`searcher:planner`) are green.

| action | path | change |
|---|---|---|
| MODIFY | `listener/src/searcher/main.ts` + `atomic-lane.ts` | `newHeads` → lane wiring below; config keys; breaker |
| CREATE | `listener/src/searcher/atomic-breaker.ts` | runtime circuit-breaker (§4) |
| MODIFY | `scripts/deploy-node.sh` | env-preservation + banner: `atomicScan=on/off` (see §4 — the `SEARCHER_POOL_UNIVERSE_TOP_N` regression precedent, [[project-universe-load-regression]]) |

```ts
// main.ts: newHeads feeds the ATOMIC LANE (A-lane) — backrun's busy/warm/state flags are NOT consulted
if (config.enableAtomicScan) {
  provider.on("block", (bn: number) => { void atomicLane.onBlock(bn); });
}
// atomic-lane.ts — the lane driver (P0-1: own flag; P0-2/P0-3: trigger → expand → fresh-read → gate)
async function onBlock(sourceBlock: number): Promise<void> {
  if (!config.enableAtomicScan)      return emitScan("disabled");
  if (!breaker.allowed(sourceBlock)) return emitScan("breaker_open");
  if (atomicBusy)                    return emitScan("skipped_busy");  // OWN-lane overrun only (P0-1)
  atomicBusy = true;
  const t0 = Date.now();
  try {
    // 1. TRIGGER (P0-2: swap logs answer "where MIGHT a spread be" — never a consistency proof)
    const touched = await fetchSwapTouchedVenues(lastTriggerBlock + 1, sourceBlock); // gap-inclusive
    // 2. EXPAND (P0-3: peer/return venues on the touched pools' pairs/ring tokens, bounded)
    const seedSet = expandToPeerVenues(touched, atomicView, cfg.maxPeerSeeds);
    // 3. FRESH-READ the expanded set at blockTag=sourceBlock into the LANE's own cache
    await lanePoolStateUpdater.update(sourceBlock, hopsFor(seedSet));
    if (blockTracker.latest > sourceBlock) return emitScan("stale_state");
    // 4. SCAN (pure, chunked with cooperative yields — A-lane rule 3)
    const res = await runChunked(() => detectAtomicOpportunities({ edges: atomicEdges,
      cache: laneCache, sourceBlock, swapTouched: touched, cfg }));
    emitScan(res.outcome, res);                              // nail #4: exactly one per newHead
    // 5. PRE-QUOTE GATE (P0-2 merged rule): EVERY cycle pool fresh at sourceBlock, else drop
    const best = filterFreshAtSourceBlock(res.opportunities, laneCache, sourceBlock)[0];
    if (!best) return;
    lastTriggerBlock = sourceBlock;
    await processOpportunities(laneCtx, [best], { kind: "atomic-arb", sourceBlock }); // one per block
  } finally { atomicBusy = false; breaker.record(sourceBlock, Date.now() - t0); }
}
```

- **State consistency — the P0-2 fresh-read gate (replaces R4's two-case rule, which is UNSOUND —
  non-swap events and eventless transfers mutate quote state, so "not swap-touched" never proves
  "unchanged"):** for EVERY pool in a candidate's `seedEdges`, require
  `laneCache.seedBlockOf(pool) === sourceBlock` (a fresh-read at `blockTag=sourceBlock`). Cycle pools
  pulled in by A2's ring extension that lie OUTSIDE the step-2 seed set get one targeted fresh-read
  (and the spread re-checked on fresh state) — spread gone after fresh-read ⇒ drop; any cycle pool
  unreadable ⇒ drop. Violation ⇒ `pipeline_dropped/atomic_state_inconsistent`; never enter the solver
  on guessed state. Record `state_block` (= the uniform fresh-read block, = `source_block`) on every
  atomic event. Cost: a handful of extra local-reth reads per candidate — accepted (we have reth).
- **Accepted miss-class (honesty, recorded):** a liquidity-only dislocation (no swap in block N)
  produces no trigger, so it is caught only by the periodic full sweep — a COVERAGE delay by design,
  never a correctness hole (the fresh-read gate holds regardless of what triggered the scan).
- **Submit-time expiry (nail #3):** already implemented in `processOpportunities` (A-contract);
  exercised here — a scan whose `latest > sourceBlock` at submit produces
  `atomic_stale_target_block`, never a re-targeted bundle.
- **`fetchSwapTouchedVenues` (renamed from the draft's `fetchChangedPools` — trigger semantics
  only):** one `eth_getLogs({fromBlock, toBlock: N, topics: [[v2Swap, v3Swap, v4Swap,
  curveTokenExchange]]})` against the local node, intersected with the atomic view — block-cadence
  (~1/12s), gap-inclusive from `lastTriggerBlock+1` (A-lane rule 4). Full-sweep backstop
  (`swapTouched: null`) every `SEARCHER_ATOMIC_FULL_SWEEP_BLOCKS` (default 50) — also the only
  catcher of the liquidity-only miss-class above.

**Deterministic pre-gates (pinned fixtures in `searcher:planner`, green BEFORE the window — these
are the P0-2/P0-3 acceptance):**
- **P0-3 (return-venue seeding):** cold lane cache + ONE swap-touched pool + the return venue never
  warmed ⇒ `expandToPeerVenues` includes the peer, the fresh-read seeds it, and the scanner still
  finds the candidate (`candidate_plans 0→>0`) — no "have the graph + path, skip on missing state".
- **P0-2 (fresh-read gate):** (a) a candidate whose cycle pool has `seedBlockOf < sourceBlock` is
  dropped `atomic_state_inconsistent` — a pool without a fresh-read at `source_block` is NEVER
  quoted; (b) a liquidity-change-only / no-swap pool whose cached state predates `source_block`
  cannot serve as fresh state (the gate rejects on seed-block alone — no "no swap event, so still
  valid" bypass); (c) a spread visible on stale cache that is GONE after the fresh-read ⇒ dropped,
  zero solver entry; (d) an unreadable cycle pool ⇒ dropped, never guessed.

**Gate (metrics — rule-12 non-deterministic exemption; window via `scripts/deploy-node.sh`, then
Step-1 cross-ref + `hermes-gate`):** over a dry-run window with the flag ON —
(1) atomic `opportunity_seen > 0`; (2) ≥1 atomic `simSuccess` on a real block (net-EV recorded —
dust labeled as dust, per the "don't celebrate dust" rule); (3) C2-minimal (already shipped) shows a
competing candidate for ≥1 coffee-class atomic tx, script-driven not hand-driven; (4) **regression
guard (P0-1):** backrun `expired-before-solver` + hint `prep_ms p95` not materially above the
pre-atomic baseline AND **zero `skip hint` emissions attributable to the atomic lane** (lane
isolation held under live flow — the A-lane synthetic gate, re-proven on real traffic); (5) every
newHead with the flag on emitted exactly one `atomic_scan_result` (nail #4 — including
`skipped_busy/stale_state` outcomes, `skipped_busy` = own-lane overrun only); (6) every atomic event
carries consistent `source_block/state_block` (uniformly fresh-read, P0-2) + the P1-5 view fields
(`strategy_view_version/atomic_view_hash`); any late submit shows `atomic_stale_target_block` and
zero re-targeted bundles (nail #3); (7) `atomic_preempted_by_backrun` appears ONLY as a
coordinator-level drop, never on a scan/read event. Thin window ⇒ EXTEND, never conclude a true
negative (the R3-trap rule).

### B-residual — quota buckets for the mempool `toAddress` filter (RE-SCOPED per R1)

**Status: unchanged — conditional, evidence-gated** (owner re-gate 2026-07-04: explicitly NOT gating).

**Landed already (do NOT rebuild):** `discover-routers.ts` + deploy auto-run
(`deploy-node.sh:159–:168`), `auto-close-router-gap.ts` loss-driven append, committed
`force-include-routers.json` (incl. `0x663dc15d…`), flip test `searcher:mempool-router-filter`
(admission false→true PASS). The plan's Gap B gate is **already green** — record it as landed in
the epic ledger.

**Residual (conditional, evidence-gated):** `buildMempoolToAddressFilterWithRouters`
(`main.ts:2903–:2931`) fills the 300-cap first-come `[fixed+forceRouters, pinned, hot]` — a large
discovered-router set can starve hot pools. Implement per-class quotas (fixed: unlimited /
discovered: top-K=40 / pinned+hot: remainder, `SEARCHER_MEMPOOL_FILTER_ROUTER_QUOTA`) **only when**
the truncation log line (`main.ts:2936` "mempool toAddress truncated") fires in a live window.
Precondition unchanged: confirm Alchemy's server-side `toAddress` length limit before raising
`SEARCHER_MEMPOOL_FILTER_MAX_ADDRESSES`.
**Gate (deterministic, extend `test/mempool-router-filter.ts`):** with 500 discovered routers +
250 hot pools, hot pools retain ≥ their quota; fixed routers all present; deBridge admission stays
true.

### C1 — the shape classifier (analysis; ships first, parallel with A0)

**Status: GO** (owner re-gate 2026-07-04 — direction explicitly approved as the learning-loop entry).

| action | path | change |
|---|---|---|
| CREATE | `analysis/src/pnl/swap-log-registry.ts` | ONE registry: topic + decoder per venue — UniV2 / UniV3 / UniV4 / Curve `TokenExchange`(+`_underlying`) / Balancer `Swap`; `decodeAnySwapLog(log): DecodedSwap \| null` |
| MODIFY | `analysis/src/pnl/victim-source.ts` | `decodeSwapLog` (`:124`) delegates to the registry (v2/v3/v4 behavior unchanged; Curve/Balancer added) |
| CREATE | `analysis/src/pnl/tx-shape.ts` | `classifyTxShape(receipt, sameBlockPoolLogs): { shape: "atomic_state_arb" \| "backrun" \| "unknown"; source_swap_hash?: string; source_router?: string; arb_pools: string[] }` — the `coffee-backrun-verify.mjs` logic made permanent: 0 preceding swaps at lower tx index on any shared pool ⇒ atomic; ≥1 ⇒ backrun |
| MODIFY | `analysis/src/pnl/sender-flow.ts` | split the single `flow` axis (`:44–:49` bug): `submission_method: "bundle" \| "public_mempool" \| "unknown"` (0-tip/coinbase ⇒ at most `bundle`, NEVER "private") + `source_visibility: "seen_by_us" \| "not_seen_by_us" \| "unknown"` — `seenInOurPublicFeed` evaluated FIRST. Migrate readers (`bundle-postmortem.ts`, `census-report.ts`) off `flow:"private"`. |
| MODIFY | `analysis/src/cli/census-report.ts` + `bundle-postmortem.ts` | add `atomic_scan_shape` per competitor tx (followable vs non-followable, next to `winner_style`) |
| CREATE | `analysis/src/test/fixtures/coffee-20260704/` (9 pinned receipts+logs) + `analysis/src/test/tx-shape.ts`; npm `analysis: "test:tx-shape"` | the gate |

**Gate (rule-12, deterministic):** the 9 pinned coffee txs ⇒ **8 `atomic_state_arb` + 1 `backrun`**;
`#9 0xc9ad7160…` resolves `source_swap_hash = 0x8e0c59b4…`, `source_swap_seen_by_us = false`;
**no `maxPriorityFeePerGas=0` tx gets `source_visibility` forced by fee heuristics** (the `:44`
regression pinned); a synthetic Curve-source-swap case classifies `backrun`, not
`atomic_state_arb` (the registry-coverage assertion).

### C2-minimal — strategy comparison + offline counterfactual replay (HARD PREREQUISITE of A4)

**Status: GO to build and REPORT** (owner re-gate 2026-07-04) — but **BLOCKED as the AUTHORITATIVE
auto-close judgment** (i.e. as D's input driving a close action) until the P1-4
capability/live-admission split + the P1-5 view versioning below are green. A pre-split verdict
conflates "scanner can't find it" with "live would never have scanned it" and misdirects the close.

| action | path | change |
|---|---|---|
| CREATE | `analysis/src/learning/learning-case.ts` | §1.5 |
| CREATE | `listener/src/searcher/atomic-replay.ts` | the offline harness — lives in **listener** so it exercises the REAL `detectAtomicOpportunities` + `planAtomicFromSeedEdges`, never a copy (plan §package-boundary) |
| CREATE | `analysis/src/cli/strategy-compare.ts` + npm `strategy-compare` | the comparison CLI |
| CREATE | `analysis/learning-cases/` (store.json committed; replay-cache/ gitignored) | |

```ts
// listener/src/searcher/atomic-replay.ts
export interface AtomicReplayReport {
  source_block: number;
  state_source: "local_reth" | "archive_rpc" | "unavailable";
  scanner_found: boolean;
  candidate_plans: number;
  solver_quote: boolean;
  sim_success?: boolean;               // optional heavy step, --with-sim
  // P1-4: capability vs live-admission — TWO verdicts, never conflated:
  capability_replay_stage: LearningCaseStage;   // full sweep (swapTouched: null) — "could the scanner find it"
  live_admission_stage: LearningCaseStage | "unknown"; // delta replay — "would live A4 have scanned it then"
  delta_triggered: boolean | null;     // did B−1's swap-trigger set (∩ atomic view) touch this ring; null = logs unavailable
  our_stage: LearningCaseStage;        // derived from BOTH (admission gap dominates), incl. "replay_state_unavailable"
  cycle_fingerprints: string[];
  // P1-5: which view this replay ran against (from buildStrategyViews.versions):
  strategy_view_version: string;
  atomic_view_hash: string;
}
export async function replayAtomicScanAt(opts: {
  block: number;                       // = B−1 (caller aligns; competitor executes in B)
  rpcs: string[];                      // ordered: local reth → archive (nail #7 contract)
  ring?: string[];                     // optional: assert this specific ring is/EXpected found
  cfg?: Partial<AtomicScanConfig>;
}): Promise<AtomicReplayReport>
```

Behavior: build the atomic view (same `buildStrategyViews` path as live; stamp `versions.*` on the
report — P1-5), seed a fresh `PoolStateCache` at `block` via the first RPC that can serve it
(`eth_call` at the pinned `blockTag`; a pruned-state error falls through to the next RPC); **no RPC
can serve ⇒ `state_source:"unavailable"`, `our_stage:"replay_state_unavailable"`, STOP** — never a
fabricated path/pool gap (nail #7). Then run BOTH replay modes (P1-4):
1. **Capability** — `detectAtomicOpportunities` full sweep (`swapTouched: null`) → planner →
   (optional) quote ⇒ `capability_replay_stage` ("could the scanner find it in theory").
2. **Live-admission** — recompute the trigger exactly as live A4 would have seen it:
   `fetchSwapTouchedVenues(B−1)` from retained logs (local reth keeps logs/receipts ≥100k blocks —
   usually zero-CU) ∩ the atomic view, then the same expand→fresh-read→scan path under the live
   sweep-cadence/budget config ⇒ `delta_triggered` + `live_admission_stage`. Logs unavailable for
   B−1 ⇒ `live_admission_stage:"unknown"`, stated not faked (same honesty contract as nail #7).
`our_stage` derives from BOTH — an admission gap dominates: **found by the full sweep but
`delta_triggered=false` ⇒ `primary_gap = atomic_scan_not_triggered` (scheduling/admission — owner
A4/scan-cadence), NEVER `atomic_cycle_not_found` (scanner logic — owner A1/A2).** Conflating the two
misdirects the close action.

`strategy-compare` flow per competitor tx (from census output or `--tx`):
1. `classifyTxShape` (C1) ⇒ skip non-atomic; `winner_style` non-comparable ⇒ `comparable:false`,
   short-circuit (never feeds close).
2. Ring extraction from the tx's swap logs (registry) → `cycleFingerprint(B−1, ring)` — imports
   `cycle-fingerprint.ts` from listener (**source_block = execution_block − 1, always** — user
   point 1).
3. LIVE align: scan our events JSONL for atomic events with that fingerprint at `source_block=B−1`
   ⇒ `our_atomic_seen` / `our_stage` from real telemetry.
4. No live match ⇒ OFFLINE: check `replay-cache/<learning_case_id>.json`; miss ⇒
   `replayAtomicScanAt({block: B−1, …})`; cache the verdict (one replay per case-version, CU cap).
5. Derive `primary_gap` (decision table — P1-4 ordering: ADMISSION before scanner-logic): venue ∉
   atomic view ⇒ `atomic_view_missing_venue`; **capability stage found the ring but
   `delta_triggered=false` (or live cadence/budget would have skipped the block) ⇒
   `atomic_scan_not_triggered` — NEVER `atomic_cycle_not_found`**; in view + capability
   `scanner_found=false` ⇒ `atomic_cycle_not_found`; found + `candidate_plans=0` ⇒
   `atomic_sizing_failed`/`no_plan` per diagnostic; quote/sim/EV stages map 1:1; pre-A4 live
   windows ⇒ `atomic_scan_not_triggered`. Emit/advance ONE `LearningCase` (idempotent by
   `learning_case_id`; sub-EV spreads park as `parked_uneconomic`; carries the P1-5 view fields +
   both P1-4 stages).

**Gate (rule-12, deterministic):** on the 8 coffee atomic samples — each emits **both**
`competitor_shape=atomic_state_arb` AND an offline-replay-driven `primary_gap` (never shape-only);
every `LearningCase` carries `source_block = execution_block − 1` + `learning_case_id` + `status`
(nail #5); re-running `strategy-compare` twice ⇒ zero new cases / zero status regressions
(idempotency); an aged-out synthetic case with both RPCs refusing the blockTag ⇒
`replay_state_unavailable`, NOT a path/pool gap (nail #7); pre-A slices, the replay honestly reports
`atomic_scan_not_triggered`→`atomic_cycle_not_found` transitions as each slice lands (the
self-evolution flip is measured on the SAME samples).
**P1-4 acceptance:** a pinned fixture with a profitable ring found by the full sweep whose source
block's swap-trigger set does NOT touch the ring ⇒ report shows
`capability_replay_stage` past `cycle_not_found`, `delta_triggered=false`, and
`primary_gap = atomic_scan_not_triggered` — NOT `atomic_cycle_not_found`.
**P1-5 acceptance:** the SAME competitor case replayed before and after an atomic-view close shows
`atomic_view_hash` (and `strategy_view_version`) CHANGE between the two reports, and the stage
transition (`atomic_view_missing_venue → scanner_found=true`) is attributable to exactly that view
change (before-hash report still fails when re-run against the archived pre-close view).

### C2-full — economics + full taxonomy (with/after A)

**Status: follows A4** (and inherits C2-minimal's authoritative-input block until P1-4/P1-5 green).

MODIFY `strategy-compare.ts`: add `competitor_profit_usd` (builder-payment floor + WETH-unwrap
gross, reusing the census pricing) vs `our_simulated_best` (from live events or `--with-sim`
replay); complete the taxonomy (`atomic_below_ev_gate`, `atomic_competitor_faster_or_outbid`,
`atomic_budget_skipped` — read from `atomic_scan_result` streams); `comparable=false` short-circuit
asserted end-to-end.
**Gate:** comparison test emits `competitor_profit vs our_simulated_best` on the A4-window data;
a `one_leg_inventory` synthetic never reaches the closer.

### D — strategy-aware close dispatcher (the close half; LAST)

**Status: LAST — additionally BLOCKED on C2's authoritative gate** (owner re-gate 2026-07-04): D
must not ACT on a C2 verdict produced before the P1-4 split + P1-5 view versioning landed.

| action | path | change |
|---|---|---|
| CREATE | `analysis/src/cli/auto-close-strategy-gap.ts` + npm `auto-close-strategy-gap` | input = `LearningCase[]` from the store (ONLY `LearningCase` — never a per-tool report shape, user point 3) |
| MODIFY | `listener/src/searcher/atomic-view-overrides.ts` | `appendAtomicViewOverrides(entries)` — idempotent append, mirrors `appendForceIncludePoolIds` (`force-include.ts:88`) |
| (unchanged) | `route-gap-watcher.ts` / `auto-close-route-gap.ts` | the backrun close path is IMPORTED by the dispatcher, not forked; its `bundle_not_included` checkpoint loop stays as-is |

Dispatch on `case.strategy`:
- `backrun` → today's `auto-close-route-gap` close (import `closeRouteGap`-equivalent entry; zero
  behavior change).
- `atomic` + `primary_gap=atomic_view_missing_venue` → `appendAtomicViewOverrides` →
  **`listener/searcher/pools/atomic-view-overrides.json` ONLY** (nail #6 path) → write the
  pending-deploy marker (same `/tmp/mev-pending-deploy.json` shape, `route-gap-watcher.ts:21`) →
  `status: proposed_close → replay_passed` only after `replayAtomicScanAt` flips the same sample.
- `atomic` + scanner/sizing/scheduling gaps → tracked item to the owning slice (A1/A2/A4), NOT a
  config write.
- `atomic_below_ev_gate` / `outbid` → economics ledger (human gate; no autonomous bid change).
- shared `adapter missing` → venue-adapter epic (touches neither view).
- **comparable inconclusive (closed=0 on a comparable atomic loss)** → write
  `analysis/learning-cases/pending-manual/<learning_case_id>.json` =
  `{LearningCase, close_result, our sim/bid, winner flows}` → `status: manual_required` — the
  §6b/§6c meta-loop package (Fable priority / Opus fallback); an unanalyzed package BLOCKS
  cycle-close (rule 16 teeth).

**Gate (rule-12):** per gap class, `before: <competitor sample> → primary_gap X` / `after replay:
same sample → stage improved` (e.g. `atomic_view_missing_venue → scanner_found=true;
atomic_cycle_not_found → candidate_plans>0; atomic_sizing_failed → sim.success`); **isolation
invariant:** closing an atomic case leaves `force-include-poolids.json` byte-identical AND
`buildMempoolToAddressFilter(views.backrun)` set-equal (never crowds backrun's hot path — user
point 4); loader gate re-asserted (the searcher's atomic view actually contains the written entry);
re-running the closer on the same `learning_case_id` ⇒ no duplicate append / no duplicate
escalation (nail #5).

---

## 3. Self-evolution parity — ONE learning loop, both strategies (the hard requirement, end-to-end)

```
                    BACKRUN                                      ATOMIC
trigger      bundle_not_included (our submit lost)      competitor atomic tx (census/C1 shape)
             └ route-gap-watcher.ts (checkpointed)      └ strategy-compare.ts (id-idempotent, nail #5)
                         │                                            │
analyze      bundle-postmortem (winner_style,           cycleFingerprint(B−1, ring) align (pt 1)
             route_gap_decisive)                        live events → else offline replayAtomicScanAt
                         │                                            │  (state contract, nail #7:
                         │                                            │   reth → archive → replay_state_unavailable)
                         └────────────┬───────────────────────────────┘
                                      ▼
                        LearningCase  (ONE schema, §1.5; analysis/learning-cases/store.json;
                                       learning_case_id + forward-only status; comparable filter
                                       short-circuits one_leg_inventory/sandwich)
                                      │
close        auto-close-strategy-gap (dispatch on strategy):
             backrun → force-include-poolids.json (existing)     [never crosses]
             atomic  → listener/searcher/pools/atomic-view-overrides.json ONLY (pt 4, nail #6)
             both    → pending-deploy marker; economics → human gate
                                      │
verify       rule-12 flip on the SAME sample (replay harness = the REAL scanner in listener,
             consumed by analysis — no drifting copy)  → status: replay_passed → applied
                                      │
live         next dry-run window: atomic_scan_result + funnel events confirm → live_verified;
             sub-EV dust → parked_uneconomic (terminal; re-opens only on materially wider spread)
                                      │
blind spot   comparable + closed=0 → pending-manual/<id>.json → fresh analyst names the class
             → CODIFY into the tool (rule 16) — package unanalyzed = cycle stays open
```

Module inventory (all named above): **listener** — `detector/atomic-scanner.ts`,
`detector/cycle-fingerprint.ts`, `atomic-lane.ts` (P0-1), `atomic-replay.ts`,
`atomic-view-overrides.ts`, `strategy-views.ts` (P1-5 `versions.*`),
`execution/submission-coordinator.ts`, `atomic-breaker.ts`, events/planner/
solver/main modifications; **analysis** — `learning/learning-case.ts`, `pnl/swap-log-registry.ts`,
`pnl/tx-shape.ts`, `pnl/sender-flow.ts` (two-axis), `cli/strategy-compare.ts`,
`cli/auto-close-strategy-gap.ts`, census/postmortem field additions. The harness boundary is
explicit: the ONLY scanner implementation lives in `listener`; `analysis` imports it (existing
precedent `live-loss.ts:15`).

---

## 4. Rollout / safety envelope

- **Flags (all default-safe):** `SEARCHER_ENABLE_ATOMIC_SCAN=0` (master, default OFF),
  `SEARCHER_ATOMIC_MAX_HOPS=4`, `SEARCHER_ATOMIC_MIN_SPREAD_BPS=10`,
  `SEARCHER_ATOMIC_SCAN_BUDGET_MS=2000`, `SEARCHER_ATOMIC_MAX_CANDIDATES=8`,
  `SEARCHER_ATOMIC_FULL_SWEEP_BLOCKS=50`, `SEARCHER_ATOMIC_VIEW_MAX_POOLS=6000`,
  `SEARCHER_ATOMIC_MAX_PEER_SEEDS=64` (P0-3 neighborhood-expansion bound),
  breaker: `SEARCHER_ATOMIC_BREAKER_EXPIRY_PCT=25` / `SEARCHER_ATOMIC_BREAKER_COOLDOWN_BLOCKS=300`.
- **Runtime circuit-breaker (`atomic-breaker.ts`):** rolling 100-block window; TRIP when
  (a) backrun `expiredBeforeSolver`/hint rate exceeds the pre-atomic baseline by
  `BREAKER_EXPIRY_PCT`, or (b) 5 consecutive `budget_exceeded` scans, or (c) **(redefined under
  P0-1 — the old "skipped hint while scan held `busy`" condition no longer exists)** hint-lane
  latency regression while the atomic lane is active: hint `prep_ms p95` above the pre-atomic
  baseline during lane-active blocks — the event-loop/CPU contention signal that chunked yields
  (A-lane rule 3) are not enough. Tripped ⇒ scans emit
  `atomic_scan_result{outcome:"breaker_open"}` for `COOLDOWN_BLOCKS`, one alert log line; auto
  re-arm after cooldown. The breaker only ever DISABLES atomic — it can never touch the backrun
  path (the scanner-scoped analog of the bounded-live safety valve).
- **Deploy preservation:** `deploy-node.sh` recovers env from the running process; explicitly ADD
  `SEARCHER_ENABLE_ATOMIC_SCAN` (+ the atomic knobs) to its preserved/verified set AND print
  `atomicScan=<on|off> atomicView=<n pools> overrides=<n> atomicViewHash=<0x…8>` in the startup
  banner (the short view hash makes P1-5 live-vs-replay attribution checkable at a glance) — the
  `SEARCHER_POOL_UNIVERSE_TOP_N` silent-revert regression ([[project-universe-load-regression]])
  is the precedent; a mode flip across auto-deploy must be visible, not silent. The committed
  `atomic-view-overrides.json` survives `git reset --hard` by construction.
- **Production enable-criterion (what flips the flag ON in bounded-live — pre-committed so the
  scanner is either rationally enabled or rationally parked, never ambient):** over ≥3 A4 dry-run
  windows (extend thin windows): (1) ≥1 atomic `simSuccess` with net-EV clearing the same
  `evGate`/`minNetEth` floor as backrun — **dust does not qualify**; (2) zero breaker trips and
  backrun funnel metrics within baseline; (3) C2 shows ≥1 comparable competitor atomic take in our
  blocks whose builder-payment floor exceeds our gas+tip estimate (the spread class is winnable,
  not just detectable). **Explicitly sanctioned alternative outcome:** if coffee-class atomic flow
  stays sub-EV (the measured $0–0.33 ceiling), the epic completes with the scanner
  `parked_uneconomic` + flag OFF while C2/strategy-compare keep running every window — the loop
  itself is the deliverable that tells us WHEN the posture changes (e.g. MEV-Share-scale flow
  showing wider standing spreads). Re-open = a `parked_uneconomic` case re-firing on a materially
  wider spread (§1.5 rule).
- Broadcast/go-live stays a hard human gate (Safety Rule 1); nothing in this epic submits outside
  the bounded-live envelope, and the auto-close chain marks pending-deploy — it never flips modes.

---

## 5. Acceptance matrix (every nail + residual → slice → executable assertion)

| item | slice | assertion (executable) | command |
|---|---|---|---|
| nail #1 planner strategy-view | A1 (+A-universe iii) | `plan()` branches on `opp.kind`; atomic candidates contain exactly `seedEdges`; backrun view excludes / atomic view includes an atomic-only venue | `searcher:planner`, `searcher:universe-split` |
| nail #2 SubmissionCoordinator | A-contract (d/e) | backrun+atomic same slot ⇒ 1 submit, atomic loser `atomic_preempted_by_backrun` (coordinator-only), atomic-vs-atomic loser `submission_arbitration_lost`; atomic-off ⇒ all backrun admits; `offer()` sync | `searcher:atomic-contract` |
| nail #3 stale target | A-contract (impl) / A4 (live) | `latest > source_block` at submit ⇒ `atomic_stale_target_block`, zero re-targeted bundles | `searcher:atomic-contract`; A4 window events |
| nail #4 `atomic_scan_result` | A4 | exactly one per newHead incl. `skipped_busy/stale_state/breaker_open` | A4 window JSONL count == newHead count |
| nail #5 LearningCase lifecycle | C2-minimal / D | double-run idempotency (0 new cases, 0 dup appends/escalations); forward-only status; `parked_uneconomic` terminal | `strategy-compare` ×2, `auto-close-strategy-gap` ×2 |
| nail #6 overrides path | A-universe (iii) / D | writer + loader agree on `listener/searcher/pools/atomic-view-overrides.json` (cwd-relative `searcher/pools/`); loader-reads-written-file | `searcher:universe-split` |
| nail #7 state backend | C2-minimal | reth→archive fallback order; unreachable B−1 ⇒ `replay_state_unavailable` never a gap; replay-cache hit ⇒ 0 RPC | `strategy-compare` fixture |
| user pt 1 B−1 alignment | C2-minimal | every LearningCase `source_block = execution_block − 1`; fingerprint join at B−1 | `strategy-compare` gate |
| user pt 3 one schema | D | dispatcher input type = `LearningCase` only (compile-level) | `analysis` build + D gate |
| user pt 4 isolation | A-universe / D | atomic close ⇒ `force-include-poolids.json` byte-identical + mempool `toAddress` set-equal | D gate |
| user pt 6 order | governance | C1 → A0 → A-contract/A-universe → A1–A3 → C2-minimal → **A-lane** → A4 → C2-full/D (B-residual conditional, anytime) | ledger |
| R1 Gap B landed | B-residual | recorded landed; quota test only if truncation observed | `searcher:mempool-router-filter` |
| R2 two-way busy | ~~A4~~ → **A-lane** (fix superseded by P0-1) | hazard closed by lane isolation: own `atomic_busy` + own cache/sim, NOTHING mutable shared; hint processed mid-scan | `searcher:atomic-lane` |
| R3 victim_hash compat | A-contract (f) | `redact-live-run`/`route-gap-watcher` over mixed events: no crash, backrun aggregates unchanged | `searcher:atomic-contract` |
| R4 seedBlockOf | A1/A4 (rule redefined by P0-2) | `PoolStateCache.seedBlockOf()`; UNIFORM gate: every cycle pool `seedBlockOf === source_block` (fresh-read), else drop | `searcher:planner` fixture |
| R5 A0 window | A0 | fixture persists pool STATES (replayable post-prune) | `searcher:atomic-a0` |
| sizing seed (plan blocker #2) | A1/A3 | resolved center from `searchSeed`, `>8n`, flashToken units, no rotation | `searcher:planner`, `searcher:replay-live-fixtures` |
| refactor-neutral | A-contract/A-universe | backrun 14/14 + live-fixture profit equivalence unchanged; mempool set-equal | existing suites |
| **P0-1 lane isolation** | **A-lane** (+A4 live) | hint injected mid-atomic-scan IS processed, zero `skip hint` from the lane; hint start-delay ≤ one chunk; `skipped_busy` = own-lane overrun only; `atomic_preempted_by_backrun` submission-slot-only; backrun suites unchanged with lane idle | `searcher:atomic-lane`; A4 window metric (4)/(7) |
| **P0-2 fresh-read gate (merged w/ P0-3)** | A4 pre-gates | swap logs TRIGGER-only; every candidate entering solve/sim has ALL cycle pools `seedBlockOf === source_block`; un-fresh pool never quoted (incl. liquidity-change-only/no-swap state); spread gone after fresh-read ⇒ drop; unreadable ⇒ drop, never guess | `searcher:planner` pinned fixtures |
| **P0-3 return-venue seeding** | A4 pre-gates | cold cache + one swap-touched pool + cold return venue ⇒ peer expanded + fresh-read + candidate found (`0→>0`) | `searcher:planner` pinned fixture |
| **P1-4 capability vs live-admission** | C2-minimal | sweep-found ring, source block not delta-triggered ⇒ `primary_gap=atomic_scan_not_triggered`, NOT `atomic_cycle_not_found`; both stages on every report/LearningCase | `strategy-compare` fixture |
| **P1-5 view versioning** | §1.3/§1.5/A-universe/C2 | `strategy_view_version` + `atomic_view_hash`/`backrun_view_hash` on atomic events AND LearningCase; identical inputs ⇒ identical hashes; override append flips atomic hash only; same case before/after a close shows the hash change + attributable stage transition | `searcher:universe-split` (iv), C2 P1-5 acceptance |

**Implementation order (final, owner re-gate 2026-07-04):** C1 → A0 → A-contract → A-universe →
A1 → A2 → A3 → C2-minimal → **A-lane** → A4 → C2-full → D; B-residual only on truncation evidence.
Per-slice status: **GO now** = C1, A0, A-contract, A-universe, A1/A2/A3 (offline-fixture scope),
A-lane, C2-minimal (build + report). **BLOCKED** = A4 live wiring (until `searcher:atomic-lane` +
the P0-2/P0-3 pre-gate fixtures are green) and C2-as-authoritative-close-input / D acting on it
(until P1-4 + P1-5 are green). Each slice = one Codex brief (rule 7/11:
Claude plans → Codex writes → Claude gates + commits), ≤3 files' core surface per pass where
possible; A-contract is the exception (the mechanical factor-out) and is gated hardest.
