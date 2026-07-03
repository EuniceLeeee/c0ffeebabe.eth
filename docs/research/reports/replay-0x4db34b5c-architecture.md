# Architecture design — non-victim (spatial cyclic) arbitrage, replay `0x4db34b5c…d4b606`

**Scope:** authorized, defensive on-chain arbitrage research. Fork replay + dry-run only; broadcast
stays a human-gated step (Safety Rule 1). Companion to
[replay-0x4db34b5c-gap-analysis.md](replay-0x4db34b5c-gap-analysis.md) — that doc establishes *what*
we miss and *why*; this doc is the **architect's design** for *how* we build it. On-chain facts in the
gap-analysis are taken as correct; this doc does not re-verify them.

Author: repo architect (Claude, Fable 5). This is the `Claude plans` step of the CLAUDE.md
generator/evaluator split — design/judgment authored here, implementation is a later Codex pass.

---

## 1. Thesis: this is two orthogonal generalizations, not one

The gap-analysis frames the miss as "pool gap + adapter gap + detection-model gap." Architecturally
those collapse into **two independent axes**, and the whole epic should be organized around them
because they have different owners, different risk, and different gates:

- **Axis V — Venue generalization** (the *pool / path / adapter* gaps). "We can price and execute a
  leg on any venue archetype." Deterministic, unit-replayable (bit-exact quote flips). Low risk.
- **Axis T — Trigger generalization** (the *detection-model* gap). "We can find and size a profitable
  cycle with **no pending swap to anchor to**." This is the deep change: the entire detector →
  planner-focus → solver-sizing spine is victim-anchored today. Higher risk, and the combinatorial
  scale problem lives here.

The two axes meet exactly once — at **Slice 8, the end-to-end fork replay** — which is why that is
the epic's definition of done. Everything else should be buildable and gateable on **one axis at a
time**. The single most important correction to the plan in the gap-analysis is to *stop conflating*
these: build and prove venue execution on a **known** cycle (Axis V + a seeded opportunity) before
building the **discovery** of cycles at universe scale (Axis T's hard half). See §5.

```
                 Axis V (venues)                          Axis T (trigger)
   discovery ─ edge-build ─ quote ─ execute        seed opportunity ─ bound search ─ size
        │                                                    │
        └──────────────► Slice 8: fork replay of 0x4db34b5c ◄┘  (both axes, no victim)
```

---

## 2. Axis V — the VenueAdapter registry

### 2.1 What actually needs unifying (5 dispatch points, not 3)

The gap-analysis lists three switches. There are **five** searcher-side venue-keyed dispatch points,
plus one that is *already* a registry. Any new venue today requires editing all five in lockstep:

| # | dispatch point | file:line | keyed on | role |
|---|---|---|---|---|
| 1 | discovery `FACTORIES` + `SWAP_TOPICS` | [active-pool-discovery.ts:25](../../../listener/src/searcher/active-pool-discovery.ts) | factory addr / swap topic | which pools enter the universe |
| 2 | `ADAPTER_MAP` + `queryPoolEdges` switch | [token-graph.ts:129](../../../listener/src/searcher/planner/token-graph.ts), [:196](../../../listener/src/searcher/planner/token-graph.ts) | `pool.adapter` | pool → graph `TokenEdge[]` |
| 3 | quoter `switch(adapterId)` | [quoter.ts:375](../../../listener/src/searcher/solver/quoter.ts) | `adapterId` | price a leg |
| 4 | plan-builder `switch(edge.adapterId)` | [plan-builder.ts:162](../../../listener/src/searcher/solver/plan-builder.ts) | `adapterId` | emit approve/transfer/callback scaffold + swap node |
| 5 | `SWAP_ADAPTERS` list | [path-template.ts:21](../../../listener/src/searcher/templates/path-template.ts) | `adapterId` | which adapters satisfy a "swap" slot |
| — | **on-chain encode** `ActionAdapter` | [adapters/registry.ts](../../../listener/src/adapters/registry.ts) | `adapterId` | **already a registry** — `register/get/listAll` |

**Design consequence:** the new `VenueAdapter` registry owns points 1–5 (searcher-side: discover,
edge-build, quote, scaffold, slot-classify). It does **not** replace the existing `ActionAdapter`
registry (on-chain calldata encode) — it *feeds* it. A `VenueAdapter.buildLeg` emits
`ResolvedPlanNode`s whose `adapterId` must resolve in the `ActionAdapter` registry. Keeping these two
registries distinct (searcher planning vs on-chain encoding) is deliberate: they change for different
reasons and the on-chain one is already stable.

### 2.2 The interface (refined from the gap-analysis sketch)

The gap-analysis sketch is directionally right but underspecified in four places that matter. The
refined shape:

```ts
interface VenueAdapter {
  id: string;                       // adapterId — single source of truth, resolves in BOTH registries

  // (1) DISCOVERY — how pools enter the universe
  discovery:
    | { mode: "factory"; factory: string; pairCreatedTopic: string; swapTopic: string }
    | { mode: "seed";    pools: PoolEntry[] }          // no factory() (OUSD, Enzyme vault)
    | { mode: "custom";  discover(ctx): Promise<PoolEntry[]> };

  // (2) EDGE-BUILD — pool → graph edges. NEW hook the sketch omitted. Needed because a
  //     venue may be non-two-token / directional (Enzyme redemption = one directed edge only).
  buildEdges(pool: PoolEntry, backend: TokenQueryBackend): Promise<TokenEdge[]>;

  // (3) QUOTE — async, cache-aware, needs tokenOut. Local warm-math is OPTIONAL (see §2.4).
  quote(ctx: QuoteCtx): Promise<bigint>;   // ctx = { state, cache?, pool, tokenIn, tokenOut, amountIn, edge }

  // (4) EXECUTE — declarative shape + shared scaffolder, NOT per-venue calldata duplication (§2.3)
  execution:
    | { kind: "callback";           swapNode(c: LegCtx): ResolvedPlanNode }  // V3, SmarDex
    | { kind: "pre-transfer";       swapNode(c: LegCtx): ResolvedPlanNode }  // V2, Rigel, DIFX
    | { kind: "approve-transferFrom"; swapNode(c: LegCtx): ResolvedPlanNode }// Curve, PSM, (OUSD?)
    | { kind: "redemption";         swapNode(c: LegCtx): ResolvedPlanNode }  // Enzyme
    | { kind: "custom";             buildLeg(c: LegCtx): ResolvedPlanNode }   // escape hatch
}
```

Four refinements over the sketch, each load-bearing:

1. **`buildEdges` hook added.** Dispatch point #2 (`queryPoolEdges`) is a venue switch the sketch
   forgot. Two-token venues emit the usual both-directions edges; **Enzyme emits a single directed
   edge** (`sUSDN → USDnr` only — you cannot un-redeem). The framework must not assume "AMM with two
   symmetric edges."
2. **`quote` is async, cache-aware, takes `tokenOut`.** The sketch's `quote(state,pool,tokenIn,amtIn)`
   can't express curve `(i,j)` or v4 `poolKey`, and ignores the path-B warm `PoolStateCache`. Match the
   existing [quoter.ts](../../../listener/src/searcher/solver/quoter.ts) contract.
3. **Execution is a declarative `kind`, not a raw `BotVmAction[]`.** The sketch's
   `buildLeg(edge,ctx): BotVmAction[]` pushes *all* scaffolding (approve, transfer, callback wiring,
   guard) into every venue module → the approve/transfer logic in
   [plan-builder.ts:66-91](../../../listener/src/searcher/solver/plan-builder.ts) gets copy-pasted N
   times. Instead: the venue **declares its `execution.kind`**, a **shared scaffolder** (the existing
   `ensureApprove`/`transferToPool`/callback-child logic, kept in plan-builder) wraps a small
   venue-specific `swapNode`. The four kinds above cover all 8 pools on this tx. `custom.buildLeg` is
   the escape hatch for a future venue that fits none.
4. **`botvmCallbackField` folded into `execution.kind:"callback"`.** A callback venue needs a
   matching on-chain `ActionAdapter` with a `field2Offset` (like
   [univ3.ts:14](../../../listener/src/adapters/univ3.ts) `FIELD2=132`). SmarDex's
   `smardexSwapCallback(int256,int256,bytes)` has the **same ABI shape as V3's callback → same 132
   offset**; it just needs its own `swap(...)` selector. That is a ~40-line clone of
   [univ3.ts](../../../listener/src/adapters/univ3.ts).

### 2.3 The missing on-chain primitive: a generic-call `ActionAdapter`

The gap-analysis says "BotVM opcode `0x00` is already generic, so on-chain execution is largely
possible." True on-chain — but **there is no TS `ActionAdapter` that emits a raw call** to an
arbitrary target with arbitrary calldata. The existing adapters (`univ2`, `curve`, `psm`, …) each
hardcode one protocol's ABI. OUSD's `swap`/`exchange` and Enzyme's `redeemSharesInKind` have no
adapter.

**Design:** add one reusable on-chain adapter `raw-call` that encodes `{target, calldata}` → BotVM
`0x00`. Then the OUSD and Enzyme `VenueAdapter.swapNode` just produce the calldata
(`iface.encodeFunctionData(...)`) and emit a `raw-call` node — no new opcode, no per-venue on-chain
adapter. This is the single primitive that makes the "not-an-AMM" and "custom-AMM" legs cheap. Only
**callback** venues (SmarDex) need a dedicated on-chain adapter (for the `field2` callback wiring);
pre-transfer / transferFrom / redemption venues all ride `raw-call` + the existing
`erc20-transfer`/`erc20-approve`.

### 2.4 Quote model: **on-chain view quotes are acceptable — warm local math is NOT required**

The strongest de-risking decision on Axis V. Path-B warm local math (bit-exact v3/curve reimplemented
off `PoolStateCache`, [project-path-b-local-quote]) exists because the **victim-backrun path is
latency-critical** — you race other searchers in the same block, so per-trial RPC is fatal.

**The non-victim cyclic path has no such race.** You are capturing a *standing* dislocation; you have
the whole block. Therefore new venues may quote via a **single on-chain view call** to the venue's own
quoter (SmarDex pair `getAmountOut`, OUSD's price view, Enzyme NAV/share) and still be bit-exact,
without reimplementing the math. `VenueAdapter.quote` may ignore `ctx.cache` and call `state`. Warm
local math becomes a *later* per-venue optimization, only if/when a venue graduates onto the
latency-critical path — it is explicitly **out of scope** for reproducing this tx. This turns Slices
1–3 from "reimplement fictive-reserve / custom-AMM math bit-exact" into "call the pool's own quoter
and assert it matches on-chain," which is both simpler and *more* trustworthy.

Exception to bit-exact: Enzyme redemption may carry NAV rounding — allow a documented tolerance and
downgrade that leg to `implemented_not_validated`, per the gap-analysis governance note.

---

## 3. Axis T — trigger generalization (the deep half)

### 3.1 What the pipeline already supports (do not over-build)

Reading the code, a **null-impact opportunity already flows end-to-end** — the "we have no spatial
detection mode at all" framing overstates the gap:

- [planner.ts:137](../../../listener/src/searcher/planner/planner.ts) `impactFromOpportunity(opp)`
  returns `null` when `opp.hints.impact` is absent.
- [planner.ts:449](../../../listener/src/searcher/planner/planner.ts) `focusPathsOnImpact(paths, null)`
  returns **all** enumerated cycles unchanged (no reverse-through-impact focusing).
- `buildTokenPaths` already enumerates `start → profit` cycles with top-N pruning and a
  `maxPaths`/deadline guard.

So the planner will already enumerate triggerless cycles. The **actual** missing pieces are three, and
they are smaller and more surgical than "build a new detection model":

| missing piece | where | change |
|---|---|---|
| **A. seed the null-impact opportunity** | new orderflow source | nothing *creates* an `Opportunity` without a victim today — both sources (mempool, `ManualVictimSource`) start from a tx |
| **B. size without a victim anchor** | [solver.ts:442](../../../listener/src/searcher/solver/solver.ts) `resolveSearchCenter` | `if (victimAmount <= 0n) return 1n` → a spatial arb searches around **1 wei**. Needs a reserve/flash-depth center |
| **C. bound the search** | planner hops + source seeding | triggerless DFS over 1500+ pools at depth 7–8 is a blow-up; today `maxHops=3` protects the *backrun* path |

### 3.2 A — the spatial-cycle opportunity source

Add `kind: "spatial-cycle"` to `Opportunity` (sibling of `"backrun-arb"`) with **no `impact` hint** and
a new optional `hints.seedPools?: string[]`. Introduce a `CyclicScanSource` parallel to
`ManualVictimSource`:

- **Cadence:** fires **once per new block** on the post-block state (a block scanner), *off* the
  latency-critical mempool path. No per-tx firing.
- **Seed tokens:** emit one opportunity per **flash-borrowable hub token** (`startToken =
  profitToken = hub`). This is not a heuristic — the cycle **must** start and end at a flash token to
  be repayable, so seeding from `FlashLiquidityCache` ([flash-liquidity.ts:51](../../../listener/src/searcher/solver/flash-liquidity.ts)) hub tokens (WBTC, WETH, USDC, USDT, DAI…) is *forced*, and it collapses the start-token space from ~thousands to <10.
- **Replay/seeded mode:** for the pinned fixture, the source emits a single opportunity with
  `startToken = WBTC` and `hints.seedPools = <the 9 pools>`, which restricts the graph the planner
  walks (§3.4). This is what makes Slice 8 deterministic and cheap — no universe-scale discovery
  needed to reproduce one tx.

`profitToken === startToken` keeps the current closed-loop model. **Multi-token settlement caveat:**
this tx repays WBTC (flash) but also withdraws ~0.00047 WETH. If the real flow is a pure WBTC→WBTC
closed loop with WETH as an incidental sub-leg residue, the single-token model holds as-is. If profit
is genuinely realized in a *second* token, the `assert-balance` guard
([plan-builder.ts:112](../../../listener/src/searcher/solver/plan-builder.ts)) must assert
**flash-repay solvency in the flash token** while profit is swept separately in another token. Resolve
which at Slice 0 by pinning the exact token flow; keep the generalization ("repay token ≠ profit
token") in the design but scope it only if Slice 0 shows it's needed.

### 3.3 B — non-victim sizing

`resolveSearchCenter` is entirely victim-anchored. For `kind:"spatial-cycle"` (victimAmountIn = 0),
the search center must come from the **cycle's own liquidity**, not the victim:

```
center = min( flashDepth(startToken),           // can't borrow more than the provider holds
              α · min-reserve-along-cycle )      // don't move any hop more than a fraction α
```

then the existing geometric-grid + golden-section refine
([amount-bounds.ts:11](../../../listener/src/searcher/solver/amount-bounds.ts),
[solver.ts:179](../../../listener/src/searcher/solver/solver.ts)) searches around it — the machinery
is reusable, only the **seed** changes. For the pinned replay, α and the grid will bracket the
on-chain observed flash size, so the fixture flips deterministically. This is a localized change
behind a `kind` branch in `resolveSearchCenter`; the victim path is untouched.

### 3.4 C — bounding the search (the real production risk)

Triggerless enumeration is where a spatial searcher explodes. The design bounds it structurally, and
**separates the two regimes**:

- **Seeded/replay regime (Slice 8):** `hints.seedPools` filters the graph to the cycle's pools before
  `buildTokenPaths`. DFS from WBTC at depth 8 over ~9 pools is trivial and deterministic. This regime
  needs *no* discovery breakthrough — it only exercises Axis V + the null-impact plumbing.
- **Scanner regime (production, later):** start only from <10 flash-hub tokens; cap depth to ~4–5
  (not 8); keep the existing `maxPoolsPerToken` top-N-by-score pruning
  ([token-graph.ts:477](../../../listener/src/searcher/planner/token-graph.ts)); rely on the block
  cadence (hundreds of ms/quotes per block is fine with no victim race). The `maxHops` cap must become
  **per-opportunity-kind** — `spatial-cycle` gets the deeper budget, `backrun-arb` keeps its low
  latency cap. A negative-cycle (Bellman-Ford on −log mid-price) *proposer* that hands candidate
  cycles to the existing solver is the eventual scale lever, but it is **explicitly out of near-term
  scope** — it is not needed to reproduce this tx and should not gate the epic.

---

## 4. Blast radius / what stays untouched

The design is deliberately additive. Unchanged: the on-chain `ActionAdapter` registry and BotVM
opcodes (except one new `raw-call` adapter + one SmarDex callback adapter); the mempool/backrun path
(new opportunity `kind` + per-kind hop cap, victim path branch-isolated); amount-propagation (dispatches
through `quote()`, so registry venues flow automatically once quoting is registry-based); the flash
layer (`balancer-flash` already supports WBTC, [flash-liquidity.ts:35](../../../listener/src/searcher/solver/flash-liquidity.ts)).

---

## 5. Revised slice plan & gates

Corrections to the gap-analysis plan are **in bold**. Every slice keeps its rule-12 replay flip.

| slice | what | gate (rule-12 flip) | axis |
|---|---|---|---|
| **0** | pin `0x4db34b5c` as a planner fixture; pin the exact token flow (resolve single- vs multi-token settlement, §3.2) | `searcher:planner` asserts **0 candidates** today, class `impact_pool_not_in_routing_graph` | — |
| **A** | VenueAdapter registry seam — **unify all 5 dispatch points (§2.1), add `raw-call` on-chain adapter (§2.3)**; re-express existing venues, behavior-identical | existing planner + curve/v3 bit-exact quote tests pass **unchanged**; all 5 switches gone | V |
| **B** | per-tx venue-gap classifier (5-way), reads the registry as source of truth | classifier on `0x4db34b5c` matches the hand-trace class per pool; **depends on A** | V |
| **4** *(do first of the venue modules)* | RigelSwap + DIFX V2-fork factories — reuse `univ2` math, cheapest, validates the factory-registry path | pools `0xdf14…`,`0xc034…` enter graph, quote via univ2 | V |
| **1** | SmarDex module — factory discovery + **on-chain `getAmountOut` view quote (NOT reimplemented math, §2.4)** + callback adapter (`field2=132`) | quote == on-chain `amountOut` (1 wei); `0xf3a4…`,`0xae26…` in graph | V |
| **2** | OUSD custom-AMM — `seed` discovery + on-chain view quote + `raw-call` execution | quote == on-chain (1 wei); both pools resolvable | V |
| **3** | Enzyme `redeemSharesInKind` — `seed` discovery + **single directed `buildEdges` (§2.2)** + NAV quote + `raw-call` | redeem out == on-chain (≤1 wei or documented NAV tolerance) | V |
| **5a** *(split from Slice 5)* | **null-impact plumbing only**: `spatial-cycle` opportunity + `CyclicScanSource` (seeded mode) + non-victim `resolveSearchCenter` + `seedPools` graph filter + per-kind hop cap | `searcher:planner` on the Slice-0 fixture (seeded, **no victim**) emits `candidate_plans > 0` reconstructing the WBTC loop | T |
| **5b** *(deferred, production scale)* | general block-cadence cyclic **scanner** — hub-token seeding, depth ~4–5, top-N pruning | dry-run metric: emits ≥1 valid cycle candidate per window with no victim | T |
| **8** | end-to-end fork replay at block 25448858 pre-state, no victim | full-cycle `sim.success` + flash-repay guard passes | **V+T** |

**Ordering rationale:** `0 → A → B` first (seam + observability). Then venue modules `4 → 1 → 2 → 3`
(cheapest-first, each an isolated bit-exact flip on Axis V). Then `5a` (the null-impact spine, Axis T,
gated on a *seeded* cycle — no discovery risk). Then `8` (both axes meet). `5b` (universe-scale
discovery) is **decoupled** and does not block Slice 8 or the epic's definition of done.

---

## 6. Architect decisions recorded (rule 14 — decided, not escalated)

1. **Two registries, not one.** New `VenueAdapter` (searcher: discover/edge/quote/scaffold) *feeds*
   the existing `ActionAdapter` (on-chain encode). Do not merge them.
2. **Declarative `execution.kind` + shared scaffolder**, with a `custom` escape hatch — chosen over
   the sketch's per-venue `BotVmAction[]` to keep approve/transfer/guard logic DRY.
3. **On-chain view quotes for new venues; warm local math out of scope** for this epic — justified by
   the non-victim path having no latency race (§2.4). Biggest de-risk.
4. **Split gap-analysis Slice 5 into 5a (execution on a seeded cycle) and 5b (universe-scale
   discovery).** Slice 8 depends only on 5a. This is the key correction — it stops the epic from
   stalling on the combinatorial scanner.
5. **`raw-call` generic on-chain adapter** is the single primitive that makes OUSD + Enzyme cheap; add
   it in Slice A.
6. **Per-opportunity-kind hop cap.** `spatial-cycle` gets the deep budget; `backrun-arb` keeps its low
   latency cap. Never crank global `maxHops` to 8.
7. **Multi-token settlement** kept in the design but scoped only if Slice 0 proves the flow is not a
   single-token closed loop.

## 7. Definition of done (unchanged from gap-analysis)

`fixed` requires **Slice 8's end-to-end fork replay to `sim.success`** on the block-25448858 pre-state,
built on the bit-exact per-venue quotes (Slices 1–3), the venue-gap classifier (Slice B), and the
null-impact spine (Slice 5a). Record per rule 12 at epic close: `failing_sample / baseline_failure /
fix_commit / replay_command / replay_result / expected_transition / verdict` per slice.
