# Architecture improvement plan — from the coffee 2026-07-04 classification

> Scope: authorized, defensive on-chain arbitrage research; mainnet fork + dry-run; broadcast is a
> human-gated step. This plan takes the three gaps named in
> [`coffee-atomic-arb-classification-20260704.md`](coffee-atomic-arb-classification-20260704.md)
> (data trusted as-is, not re-verified) and maps each to a concrete change in *this* repo, with a
> repair-replay (rule-12) gate for each. It does NOT itself change searcher behavior — it is the
> design + verification contract the implementation cycles execute against.

## The three gaps (from the source doc)

| # | competitor evidence | our gap | class | size |
|---|---|---|---|---|
| A | 8/9 of coffee's txs = **atomic chain-state arbitrage** (a standing cross-pool spread captured in one tx; **no pending source swap** to follow) | our pipeline is **backrun-only** — it triggers exclusively on a pending mempool swap; a standing spread never enters the funnel | strategy / architecture | **largest — EPIC** |
| B | 1/9 = a **public backrun** whose victim `to=0x663dc15d…` (custom router) was dropped **before** the funnel | mempool admission is a fixed ~14-router allowlist; a swap via an unlisted router that touches our pools is invisible | flow-admission | small, cheap |
| C | the per-round comparison never checked "did we SEE the source swap" nor "is the competitor atomic- or backrun-shaped" (built by hand: `coffee-backrun-verify.mjs`) | the followability classifier is a hand analysis, not a permanent tool | analysis-tooling (rule 16) | cheapest |

Economics honesty (carried from memory, not re-litigated): coffee's atomic take is **dust** on public
flow ($0–0.33/tx, ~$23/2.5h) — but that ceiling was measured on ~1.4% of flow, and MEV-Share flow (72×
volume) was just flipped on. Gap A is a **capability** we lack regardless of today's dust; its EV must
still clear the gate. Do not celebrate dust (Hermes "simSuccess must be +EV" rule).

---

## What is already reusable (do NOT rebuild)

The backrun pipeline is already victim-*agnostic* below the trigger. An atomic (no-victim) opportunity
reuses almost all of it:

| stage | file:line | victim-dependence today | reuse for atomic |
|---|---|---|---|
| block-driven pool-state freshness | `main.ts:762 / :807` (`provider.on("block")` warm + state update), `solver/pool-state-updater.ts` | none — already per-block | **trigger + state source for the scan** |
| cycle enumeration | `planner/token-graph.ts:462` `buildTokenPaths(start,profit)` | none — DFS start→profit is generic | seed with `start===profit` (a cycle) |
| candidate planning | `planner/planner.ts:86` `TemplatePlanner.plan(opp,…)` | reads `opp.affectedPools` only to *pin* the impact pool | plan from a synthetic `Opportunity` with no pinned victim pool |
| amount sizing | `solver/solver.ts:442` `resolveSearchCenter` | `if (victimAmount<=0n) return 1n` → **already** falls back to the geometric-grid + GSS search | drive with `victimAmountIn:0n` |
| execution / submission | `execution/bundle-router.ts:81` `standalone` → `submitStandaloneBundle` (single next-block tx, **no victim rawTx**) | already exists for the mined-victim Path C (`main.ts:1134`) | **atomic bundle == standalone bundle** |
| EV / final-verify gate | `main.ts:1583` terminal verify + EV gate | none | unchanged |

So the **only genuinely missing pieces for Gap A** are: (1) a block-triggered *opportunity source* that
scans current state for a profitable cycle, and (2) a cheap pre-filter so the per-block scan fits the
between-block budget. Everything downstream already runs no-victim.

---

## Gap A — per-block atomic chain-state scanner (EPIC)

**Root cause (verified in code):** `BackrunDetector.detect` runs only inside `handleHint`, which fires
only on an `OrderflowEvent` from the mempool (`main.ts:1240`). There is **no block-driven scan**. A
standing cross-pool spread with no pending swap produces no hint → no opportunity → never seen. This
matches the doc exactly: "our pipeline never triggers; there is nothing to follow."

Escalated to an **EPIC** per rule 13 (too big for one 30-min round; ordered slices, each with its own
rule-12 gate). Owner: `atomic-scanner-epic`. Default OFF (`SEARCHER_ENABLE_ATOMIC_SCAN=0`) until A4.

### Ordered slices

**A0 — decode/verify (analysis-decode).**
Fork-replay one coffee atomic tx at its pre-tx state and prove the cycle is reconstructable from public
chain state alone. Pick **#2 `0x803a3693`** (block 25455024, 3 pools, net $0.33 — the richest clean
atomic sample). Reuse the historical-replay harness pattern (`docs/historical-replay.md`).
- **Gate:** replay at pre-tx state reproduces a profitable closed cycle returning to a priced token,
  gross ≈ the doc's figure. Substantiates "contestable with a scanner, no private information" (the
  doc's recommended next step, §Caveats).
- **Deliverable:** a pinned fixture `{block, startToken, cyclePools[], expectedGrossWei}` for A1/A3.

**A1 — atomic opportunity source (planner seeding).**
Add `detector/atomic-scanner.ts` → `detectAtomicOpportunities(state, pricedTokens)`: for each
borrowable/priced start token, enumerate short cycles (`buildTokenPaths(start, start, {maxHops:3})`)
over the runtime graph and emit `Opportunity{ kind:"atomic-arb", victimTxHash:"", victimAmountIn:0n,
affectedPools:[], startToken, profitToken:start }`. No new planner/solver logic — it produces the same
`Opportunity` shape the existing planner consumes (add the `"atomic-arb"` kind to
`detector.ts:6`).
- **Gate (rule-12, `npm run searcher:planner`, deterministic, no anvil):** pin the A0 cycle as a
  `REPLAY_FIXTURE`; assert `candidate_plans 0→>0` for the atomic seed (start===profit) — the same
  flip shape as the existing CFG v4 fixture (`test/planner.ts:829`).

**A2 — cheap spread pre-filter (latency guard).**
Before full GSS sizing, a per-pool-pair fast price check (constant-product / `sqrtPriceX96` ratio from
the warm `PoolStateCache`) prunes the O(cycles) enumeration to the few pairs whose mid-price spread
exceeds a threshold. This keeps the per-block scan inside the between-block warm budget.
- **Gate (rule-12 latency, `npm run searcher:bench-topn` pattern / a new `searcher:bench-atomic`):**
  per-block scan cost stays under the between-block budget (relative, harness-bound per rule 12); AND
  the A0 fixture still survives the pre-filter (no false prune).

**A3 — no-victim solve + sim + standalone build (end-to-end on fork).**
Run the A0 fixture through `solver.solve` (no `localVictimApply` → sims on the current fork directly,
exactly like the standalone/mined path) → terminal verify → `standalone` bundle build.
- **Gate (rule-12, `npm run searcher:replay-live-fixtures`):** `sim.success=true`, net-EV > 0 after
  gas, EV gate passes, a `standalone` `BundleSubmission` is produced (DryRun signs it). Records the
  rule-12 quartet (`failing_sample / fix_commit / replay_command / expected_transition:
  atomic_scan no_candidate→sim.success+standalone`).

**A4 — live wiring + dry-run window.**
Hook `detectAtomicOpportunities` into `provider.on("block")` in `main.ts` (behind
`SEARCHER_ENABLE_ATOMIC_SCAN`, default 0), feeding the existing `handleHint` downstream with a
synthetic block-triggered hint. Deploy (`scripts/deploy-node.sh`), run a dry-run window, run the
mandatory Step-1 competitor cross-reference over coffee's blocks.
- **Gate (metrics, non-deterministic per rule 12 exemption):** atomic `opportunity_seen>0` in the
  window, ≥1 atomic `simSuccess` on a real block, and Step-1 shows we now generate a competing
  candidate for ≥1 of coffee's atomic txs. Carry to the next round if the window is thin (extend the
  window, do not conclude a true negative — the R3 trap).

### Gap-A sequencing note
A0→A1 are pure/deterministic and land fast. A2 is the only real engineering risk (per-block cost). A4
is gated behind the flag and the dry-run — go-live stays a human gate. **Per-pool force-include pins
for this class are forbidden once epic'd (rule 13); only these slices touch it.**

---

## Gap B — mempool flow-admission (bounded router widening)

**Root cause (verified):** `MEMPOOL_ROUTER_ADDRESSES` is a fixed ~14-address set (`main.ts:206`);
`buildMempoolToAddressFilter` (`main.ts:2755`) = those routers + pinned pools + top-N hot pools. The
subscription is a **server-side `alchemy_pendingTransactions` `toAddress` filter** (`main.ts:2794`), so
we cannot "admit by pool-touch" at subscribe time — we don't know the touched pool until we fork the
tx. The code explicitly refuses the hash-firehose fallback (`main.ts:2805`). So the only correct fix is
to **widen the address set in a bounded, evidence-based way**, not go unfiltered.

**Fix — a discovered-router set (mirrors the pool-universe / force-include pattern):**
1. `listener/src/searcher/discover-routers.ts` + `npm run discover-routers`: offline/periodic scan of
   recent blocks on the **local reth** (zero-CU) for `to` addresses that emit swap logs on our indexed
   pools, above a min-frequency threshold. Persist to a committed `discovered-routers.json` (survives
   deploy, like `force-include-poolids.json`).
2. Merge `discovered-routers.json` into `MEMPOOL_ROUTER_ADDRESSES` at load; raise
   `SEARCHER_MEMPOOL_FILTER_MAX_ADDRESSES` headroom so the merge isn't truncated (`main.ts:2778`).
- **Gate (rule-12, deterministic, from committed reth logs):** pin #9's victim tx `0x8e0c59b4…`
  (`to=0x663dc15d…`) as a fixture; assert after discovery `0x663dc15d` ∈ merged set AND
  `buildMempoolToAddressFilter` would include it → admission flip `false→true`.
- **Honesty:** #9 netted **−$0.19** (a lower bound, understated) → low value on this one sample. Do it
  because it is a cheap, genuine coverage hole and it unblocks *measuring* whether the wider flow pays —
  not because this tx pays. **Bounded widening only** (evidence-gated addresses, capped count).

Connects to memory `project-mempool-router-allowlist-blindspot`.

---

## Gap C — codify the atomic-vs-backrun classifier (rule 16)

**Root cause:** the followability judgment (atomic vs backrun; "did we see the source swap") was done by
hand (`coffee-backrun-verify.mjs`). Rule 16 requires a hand analysis that exposes a tooling gap to become
a one-command capability, or the cycle does not close.

**Fix — fold the classifier into the standing tools:**
- Extend `analysis` `live-loss` / census with a per-competitor-tx **shape** field: for each arb pool in
  the tx, `eth_getLogs` the same block for a preceding swap at a **lower tx index** → 0 preceding =
  `atomic`, ≥1 = `backrun` (the exact `coffee-backrun-verify.mjs` logic, made permanent).
- Reuse the existing primitives for the two complementary axes: `pnl/victim-source.ts` ("did we see the
  source swap") and `pnl/sender-flow.ts` (public/private, with the doc's correction that
  `maxPriorityFeePerGas=0` ≠ private). `bundle-postmortem` already has `winner_style` — add
  `atomic_scan_shape` so the census reports **followable vs non-followable** per competitor automatically.
- **Gate (rule-12, `analysis` test):** pin coffee's 9 txs (from the source doc's table) as a fixture;
  assert the classifier returns **8 atomic + 1 backrun** and `#9 source_swap_seen=false`. Deterministic.

Also records the doc's two corrections so they aren't repeated: "private" overstated (`maxPrio=0` is
just bundle+coinbase), "dust" imprecise (report per-tx net USD vs the $0.1 line).

---

## Verification summary (the gates, in order)

| slice | harness / command | expected transition (rule-12) |
|---|---|---|
| A0 | fork replay at pre-tx state (`docs/historical-replay.md` pattern) | atomic cycle reproduced from public state, gross > 0 |
| A1 | `npm run searcher:planner` | `candidate_plans 0→>0` for the atomic seed (start===profit) |
| A2 | `searcher:bench-atomic` (bench-topn pattern) | per-block scan < between-block budget; A0 not false-pruned |
| A3 | `npm run searcher:replay-live-fixtures` | `sim.success + net-EV>0 + standalone bundle built` |
| A4 | dry-run window + Step-1 cross-ref | atomic `opportunity_seen>0`, ≥1 atomic `simSuccess`, competing candidate for a coffee atomic tx |
| B | `npm run searcher:planner`-style fixture on committed reth logs | `0x663dc15d ∈ mempool filter` → admission `false→true` |
| C | `analysis` classifier test | coffee 9 txs → 8 atomic + 1 backrun; `#9 source_swap_seen=false` |

## Governance / sequencing

- **Gap A = EPIC** (rule 13): `decision: epic`, owner `atomic-scanner-epic`, ordered slices A0→A4 each
  with its own gate; per-pool pins for this class are now forbidden inside the 30-min loop.
- **Gap B, C = single-cycle rule-12 fixes**, parallelizable with A0/A1.
- **Recommended order:** **C first** (cheapest; makes every future round auto-measure followability, so
  we stop hand-classifying) → **B** (cheap coverage + unblocks measuring wider flow) → **A** as the epic
  (the real capability, highest ceiling especially over MEV-Share flow).
- Each slice is generator/evaluator split (rule 7): Claude briefs → Codex writes → Claude gates. Go-live
  stays a hard human gate (Safety Rule 1); A4 is dry-run + flag-gated only.
