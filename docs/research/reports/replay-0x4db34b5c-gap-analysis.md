# Replay feasibility + gap analysis — `0x4db34b5c…d4b606`

**Scope:** authorized, defensive on-chain arbitrage research. Local reth + Alchemy reads only,
mainnet-fork replay, dry-run. No broadcast (broadcast stays a human-gated step, Safety Rule 1).

## Verdict

**We cannot replicate this transaction today.** It is a ~8-leg spatial (cyclic) arbitrage whose
loop runs almost entirely through venues we neither index, quote, execute, nor detect. The two
Uniswap legs are the only pieces inside our current capability; the other six are out of scope on
every axis (discovery, quoting, execution, and the detection model). This is primarily a **pool
gap**, compounded by a **path/adapter gap** and a **detection-model gap**.

The tx itself is dust (gross ≈ 0.00047 WETH ≈ $1.7, net ≈ $1.3). The reason to care is the
**capability class** it exposes — SmarDex-family venues + spatial cyclic arbs with no in-block
trigger — not this one bundle.

**Goal update (2026-07-03):** the plan below targets **end-to-end replication of this exact tx**,
not just the reusable subset. End-to-end is worth the extra two venue modules because the loop
spans **four distinct venue archetypes** — a fictive-reserve AMM (SmarDex), a custom non-factory
AMM (OUSD), a fund-share redemption that is not an AMM at all (Enzyme `redeemSharesInKind`), and
plain V2-forks (RigelSwap/DIFX) — so reproducing it end-to-end is the acceptance test that our new
**generalized venue-adapter framework** actually generalizes across every shape we'll meet again,
instead of being a SmarDex one-off. The dust P&L is irrelevant; the framework is the deliverable.

## On-chain facts (verified)

| field | value |
|---|---|
| tx | `0x4db34b5ce1b878c7cc22b1d59e0ab0d6a2930bd77f8f4cf9832eb26152d4b606` |
| block / index | 25448858 (`0x184519a`) / tx index 58 (`0x3a`) |
| time | 2026-07-03 01:58:35 UTC (same day as this analysis) |
| from | `0xc0ffeebabe5d496b2dde509f9fa189c25cf29671` (**coffeebabe**, watchlist) |
| to | `0xe08d97e151473a848c3d9ca3f323cb720472d015` (coffeebabe's BotVM-style router; note: same address as our reference bot) |
| status | success |
| flash source | **Balancer V2 Vault** (`0xba12…2c8`), token **WBTC**, amount 0.00008937 WBTC |
| result | 0.000474 WETH withdrawn at the end; WBTC repaid to Balancer |
| gas | 980,043 @ 0.115 gwei |

### The cycle (WBTC flash → WBTC repay), verified pool-by-pool

| # | pool | venue (factory) | pair | in our scope? |
|---|---|---|---|---|
| 1 | `0xdf14…a357` | **RigelSwap** V2-fork (`0x880A…`) | WBTC/WETH | ❌ factory not scanned |
| 2 | `0xf3a4…0179` | **SmarDex** (`0x7753…`) | WETH/SDEX | ❌ factory not scanned **+ non-xy=k math** |
| 3 | `0xae26…97e4` | **SmarDex** (`0xB878…`) | SDEX/sUSDN | ❌ same |
| 4 | `0x4d54…9a84` | **Enzyme vault** `redeemSharesInKind` | sUSDN→USDnr | ❌ not an AMM; no adapter |
| 5 | `0x1791…65f5` | **OUSD/USDnr** custom AMM (no `factory()`) | USDnr/OUSD | ❌ not factory-discoverable |
| 6 | `0x6d18…26dc` | **OUSD/USDC** custom AMM (no `factory()`) | OUSD/USDC | ❌ not factory-discoverable |
| 7 | `0x9a77…7d16` | **Uniswap V3** (`0x1F98…`) | WBTC/USDC | ✅ discoverable |
| 8 | `0x0de0…b149` | **Uniswap V2** (`0x5C69…`) | WBTC/USDT | ✅ discoverable |
| 9 | `0xc034…bf0d` | **DIFX** V2-fork (`0xe5aa…`) | WETH-leg | ❌ factory not scanned |

**No in-block trigger.** Across all 9 path pools, coffeebabe's tx is the *only* tx in block
25448858 that touched any of them (verified via `eth_getLogs` on the block hash). Even the two
Uniswap pools carry no victim swap in-block. So this is a **standing cross-venue price dislocation**
captured as a pure cyclic/spatial arb — **not** a same-block backrun.

## Why each of our stages fails on this tx

1. **Discovery / pool gap (dominant).** `active-pool-discovery.ts` scans only Uniswap-V2
   (`0x5C69…`), Sushi (`0xC0AE…`), and Uniswap-V3 (`0x1F98…`) factories. RigelSwap / SmarDex×2 /
   DIFX sit on other factories; the two OUSD pools expose no `factory()` at all; the Enzyme vault
   is a fund, not a pool. → 6 of 8 swap venues never enter our pool universe, so no edge exists.

2. **Quoting + execution / path-adapter gap.** `solver/quoter.ts` and the BotVM adapters price and
   execute only `curve* / univ2 / univ3 / univ4 / psm / fluid`. Even if the pools were indexed:
   - **SmarDex uses fictive-reserve math**, not constant-product — our `univ2` quoter would
     misprice it (silent wrong number, not a clean failure).
   - The **OUSD custom AMMs** and the **Enzyme `redeemSharesInKind`** leg have **no adapter and no
     quoter** — the loop cannot be quoted or built at all.

3. **Planner depth / config gap.** Live runs with `SEARCHER_MAX_HOPS=3`
   ([main.ts:304](listener/src/searcher/main.ts:304)); this cycle is ~7–8 legs. Even with full pool
   coverage, DFS at depth 3 would never enumerate it. (Third-order — the coverage gaps are already
   fatal.)

4. **Detection-model gap.** `BackrunDetector` keys off a victim/impact swap **in a pool that is in
   our graph**. This arb has no in-block trigger and its entry pools aren't in our graph, so nothing
   ever registers as an opportunity — it is invisible to our funnel end-to-end. Capturing it needs a
   **spatial/cyclic-scan detection mode**, which we do not have.

**Not the blocker:** the flash leg. We already support `balancer-flash` from the Balancer Vault
([flash-liquidity.ts:35](listener/src/searcher/solver/flash-liquidity.ts:35)), and WBTC would be
borrowable there. Flash is the one part of this tx we *could* have done.

---

## Architecture change (the enabling seam for end-to-end)

Today a venue is hardwired across **four** independent switch statements that must be edited in
lockstep for any new venue — there is no venue abstraction:

| layer | file:line | switch keyed on | role |
|---|---|---|---|
| discovery | [active-pool-discovery.ts](listener/src/searcher/active-pool-discovery.ts) `FACTORIES` | factory address | which venues enter the pool universe |
| quoting | [quoter.ts:375](listener/src/searcher/solver/quoter.ts:375) `switch(adapterId)` | `adapterId` | price a leg locally |
| execution encode | [plan-builder.ts:162](listener/src/searcher/solver/plan-builder.ts:162) `switch(edge.adapterId)` | `adapterId` | build the BotVM calldata for the leg |
| on-chain exec | [BotVM.sol:107](src/BotVM.sol:107) opcode `0x00` = generic `target.call(payload)` | — | run the leg (callback venues also need a field-state opcode) |

**Key execution fact:** BotVM opcode `0x00`/`0x01` is already a **generic call** — so on-chain
execution of a new venue is largely *already possible*; the real execution gap is the **TS
plan-builder** (encode the venue's calldata + wire its callback field) plus the **quoter** math.
Only callback-style venues (SmarDex has a `smardexSwapCallback`, like V3's `uniswapV3SwapCallback`)
need the callback field-state opcodes; simple pre-transfer / redemption venues (OUSD, Enzyme) run on
the plain generic call.

**The seam (Slice A below):** introduce a single **VenueAdapter registry** — one self-contained
module per venue implementing a common shape:

```
interface VenueAdapter {
  id: string;                                  // adapterId, single source of truth
  discovery:                                   // how pools enter the universe
    | { mode: "factory"; factory: string; pairCreatedTopic: string; swapTopic: string }
    | { mode: "seed";    pools: string[] }     // for no-factory() venues (OUSD)
    | { mode: "custom";  discover(ctx): Pool[] };
  quote(state, pool, tokenIn, amtIn): bigint;  // local pricing math for this venue
  buildLeg(edge, ctx): BotVmAction[];          // plan-builder calldata + callback opcodes
  botvmCallbackField?: number;                 // only if the venue uses a swap callback
}
```

Discovery, quoter, and plan-builder then **iterate the registry** instead of their hardcoded
switches. This is the reusable component the mission needs: every future venue becomes one module +
one registry line, and — critically for ask #2 — the registry becomes the **single source of truth
the analysis tool reads** to decide "do we support this venue's execution?". Note the registry must
support **non-AMM legs** (Enzyme is a share redemption, not a pool) and **non-factory discovery**
(OUSD exposes no `factory()`), so the framework cannot assume "AMM with reserves".

---

## Plan (epic — end-to-end replication)

Per Hermes rule 13 this multi-venue scope is an **epic**, run as ordered slices, each with its own
rule-12 replay flip. The end state is a **fork replay of this exact tx** (Slice 8). Slices are
ordered architecture-first, then by dependency and ROI.

**Epic decision:** `decision: epic` — "generalized venue-adapter framework + spatial cyclic arb".
Recurrence basis: coffeebabe capture in one of our own blocks (2026-07-03) on a venue class absent
from our graph; per rule-13 this converts a parked coverage gap into a forced epic, not per-pool pins.

### Slice 0 — Pin the failing case as a replay fixture (observability, blocks nothing)
- Record this tx as a named planner fixture in
  [test/planner.ts](listener/src/searcher/test/planner.ts) `REPLAY_FIXTURES`: opportunity = the WBTC
  cycle, with on-chain provenance (block 25448858, the 9 pools above).
- **Acceptance:** `npm run searcher:planner` runs the new fixture and asserts **`0 candidates`
  today** with classification `impact_pool_not_in_routing_graph` (the pinned `baseline_failure` the
  epic must later flip).

### Slice A — VenueAdapter registry seam (architecture, behavior-preserving refactor)
- Refactor the three TS switches (discovery `FACTORIES`, `quoter.ts` `switch(adapterId)`,
  `plan-builder.ts` `switch(edge.adapterId)`) to iterate a `VenueAdapter[]` registry. Re-express the
  **existing** venues (curve*/univ2/univ3/univ4/psm/fluid) as registry entries — no behavior change.
- **Acceptance (rule-12 = behavior-identical):** `npm run searcher:planner` and the curve/v3
  bit-exact quote tests ([[project-path-b-local-quote]]) pass **unchanged**; a diff-check shows the
  three switches are gone and every prior `adapterId` resolves through the registry.
  `expected_transition: none (refactor) — all existing quote/plan fixtures still pass`.

### Slice B — Analysis tool: per-tx venue-gap classifier (ask #2 — "what exactly are we missing")
- **Problem:** [live-loss.ts:340](analysis/src/cli/live-loss.ts:340) `classifyGapType` is a binary
  (`in graph → detection_gap`, `out → graph_gap`) and `extractPoolAddresses`
  ([live-loss.ts:345](analysis/src/cli/live-loss.ts:345)) only recognizes univ2/v3/curve topics — so
  it cannot even *see* SmarDex/OUSD/Enzyme pools, let alone classify them. It cannot answer the
  question that mattered on this tx: **is the gap a missing DEX class, a missing pool, or a missing
  swap-endpoint adapter?**
- **Change:** add a `venue-gap` classifier (new CLI verb / extend `live-loss --watch`) that, for each
  address emitting a log in a competitor tx, resolves the venue and emits one of a **5-way** class:

  | class (缺什么) | meaning | source of truth checked |
  |---|---|---|
  | `venue_class_gap` (缺 DEX) | factory / venue signature not in our known set | scanned-factory set (from registry) + `factory()` probe |
  | `pool_gap` (缺 pool) | venue known & scanned, but this pool not in runtime graph | `runtime-graph-pools.json` membership |
  | `execution_adapter_gap` (缺兑换口) | venue identifiable, pool graphable, but no quote+buildLeg adapter | VenueAdapter registry (Slice A) |
  | `detection_gap` | fully covered (discoverable+quotable+executable), opp not detected/routed | all three above pass |
  | `unknown` | address's venue can't be identified (probe reverts, no signature) | — |

  Implementation notes: (a) replace the hardcoded 3-topic filter with an **any-log→address** sweep
  then per-address venue resolution (probe `factory()`; on revert, check seed-list + a small
  bytecode/selector signature table for OUSD/Enzyme-style contracts); (b) read the scanned-factory
  set and the supported-adapter set **from the registry**, so the tool and the searcher never drift.
- **Acceptance (rule-12 flip):** run the classifier on tx `0x4db34b5c…` and assert the per-pool
  output **matches the hand-analysis in this doc**: `0x9a77…`(UniV3) + `0x0de0…`(UniV2) →
  `detection_gap`; `0xdf14…`(Rigel) `0xf3a4…`/`0xae26…`(SmarDex) `0xc034…`(DIFX) `0x1791…`/`0x6d18…`
  (OUSD) → `venue_class_gap`; `0x4d54…`(Enzyme) → `venue_class_gap`. After Slices 1/4 land, re-running
  must flip the newly-covered pools out of `venue_class_gap` into `pool_gap`/`detection_gap`.
  `expected_transition: binary {graph_gap|detection_gap} → precise 5-way class matching hand-trace`.
- **Generality (ask #2, "for every new tx"):** this makes the classifier a reusable per-competitor-tx
  triage — for any future capture, one command says whether we're short a DEX, a pool, or an adapter,
  instead of the current in/out binary.

### Slice 1 — SmarDex venue module (fictive-reserve AMM: discovery + quote + execute)
- One VenueAdapter module: factory discovery (`0x7753…`, `0xB878…`), fictive-reserve quote
  (`getAmountOut` with `fictiveReserve*` + `priceAverage`), plan-builder leg (`swap(...)` +
  `smardexSwapCallback` field wiring, mirroring the V3 callback pattern), `botvmCallbackField` set.
- **Acceptance (rule-12 flip):** a unit test quotes a real SmarDex swap from block 25448858 and
  matches on-chain `amountOut` **bit-exact** (curve/v3 bar, [[project-path-b-local-quote]]); pools
  `0xf3a4…`, `0xae26…` enter the graph. `expected_transition: smardex quote == on-chain amountOut
  (1 wei) AND pool_in_routing_graph false→true`.

### Slice 2 — OUSD custom-AMM venue module (no-factory / seed discovery + custom quote)
- VenueAdapter with `discovery.mode:"seed"` (the two pools `0x1791…`, `0x6d18…` have no `factory()`);
  quote via the pool's own on-chain price/`getAmountOut` state read; execution via the generic
  `0x00` call (no callback — verify whether it pulls via `transferFrom` or expects pre-transfer, and
  encode accordingly).
- **Acceptance (rule-12 flip):** unit test quotes the real OUSD swap from block 25448858 bit-exact
  vs on-chain; both pools resolvable. `expected_transition: ousd quote == on-chain amountOut (1 wei)`.

### Slice 3 — Enzyme `redeemSharesInKind` venue module (non-AMM redemption leg)
- VenueAdapter for the sUSDN Enzyme vault (`0x4d54…`): `discovery.mode:"seed"`; "quote" = shares ×
  NAV/share (read `redeemSharesInKind` preview or share price from the vault); execution = generic
  `0x00` call to `redeemSharesInKind(recipient, shares, [], [])`. This proves the framework handles a
  leg that is **not an AMM** and returns an underlying basket (single underlying here → simple).
- **Acceptance (rule-12 flip):** unit test computes the sUSDN→USDnr out for the block-25448858 shares
  and matches the on-chain redemption amount. `expected_transition: enzyme redeem out == on-chain (≤1
  wei or documented NAV-rounding tolerance)`.

### Slice 4 — RigelSwap + DIFX V2-fork factories (cheap coverage, reuse univ2 math)
- Add `0x880A…` (RigelSwap) and `0xe5aa…` (DIFX) as `discovery.mode:"factory"` registry entries
  reusing the existing `univ2-swap` quote+buildLeg (they are plain xy=k V2-forks — confirm no
  fee-on-transfer / custom fee before reusing univ2 math).
- **Acceptance (rule-12 flip):** pools `0xdf14…`, `0xc034…` enter the graph and quote via univ2 math;
  `expected_transition: pool_in_routing_graph false→true` for `0xdf14…`.

### Slice 5 — Spatial / cyclic detection mode + deeper hops (detection-model gap)
- Add a standing-dislocation / top-of-block cyclic scan that seeds the planner with cycle
  opportunities on the covered venues **without** an in-block trigger (the current `BackrunDetector`
  keys off a same-block impact swap and cannot see this), and raise the hop budget for the cyclic-scan
  mode specifically (live victim-backrun path keeps its low cap for latency).
- **Acceptance (rule-12 flip):** with Slices 1–4 landed, `npm run searcher:planner` on the Slice-0
  fixture emits **`candidate_plans > 0`** reconstructing the WBTC→…→WBTC loop across all covered legs
  with **no victim supplied**. `expected_transition: candidate_plans 0→>0`.

### Slice 8 — End-to-end fork replay of the exact tx (epic definition of done)
- On a mainnet fork at block 25448858 pre-state, with **no victim tx supplied**, run
  detector → planner → solver → BotVM and reproduce the full **WBTC flash → 9-venue cycle → WBTC
  repay** bundle through the SmarDex + OUSD + Enzyme + Uniswap + Rigel/DIFX legs.
- **Acceptance (rule-12 flip, end-to-end):** the simulated bundle `sim.success` with the WBTC
  flash-repay assert-balance guard passing; net result reproduces the on-chain ~0.00047 WETH (or is
  explicitly logged `dust` per "don't celebrate dust" — the pass criterion is *reproduction*, not
  profit). `expected_transition: full-cycle sim.success on the pinned pre-state`.

### Governance / boundaries (recorded)
- No broadcast. Every slice gates on fork/replay; live competitiveness is a separate dry-run gate.
- Nothing exotic is deferred any more — end-to-end requires all four archetypes; the only excluded
  work is any venue **not** on this tx's path.
- If a slice's on-chain math can't be made bit-exact (e.g. Enzyme NAV rounding), document the
  tolerance and downgrade that leg's verdict to `implemented_not_validated`, do not silently pass.

### Definition of done (epic)
`fixed` (not `implemented`) requires **Slice 8's end-to-end fork replay to `sim.success`** on the
block-25448858 pre-state, built on Slices 1–3's bit-exact per-venue quotes and Slice B's classifier
flipping every path pool to its correct venue class. Record per rule 12 at epic close:
`failing_sample / baseline_failure / fix_commit / replay_command / replay_result /
expected_transition / verdict` for each slice.
