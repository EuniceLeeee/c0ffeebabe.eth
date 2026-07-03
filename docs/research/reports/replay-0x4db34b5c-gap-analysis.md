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

## Plan

Replicating *this exact dust tx* is not the goal; building the **generalizable capability** it
exposes is. Per Hermes rule 13, the multi-venue scope below is an **epic**, run as ordered slices,
each with its own rule-12 replay flip. Slices are ordered by ROI-per-effort and by dependency.

**Epic decision:** `decision: epic` — venue class "SmarDex-family + spatial cyclic arb". Recurrence
basis: coffeebabe capture in one of our own blocks (2026-07-03) on a venue class absent from our
graph; per rule-13 this converts a parked coverage gap into a forced epic instead of a per-pool pin.

### Slice 0 — Pin the failing case as a replay fixture (observability, blocks nothing)
- Record this tx as a named planner fixture in
  [test/planner.ts](listener/src/searcher/test/planner.ts) `REPLAY_FIXTURES`: impact/opportunity =
  the WBTC cycle, with on-chain provenance (block 25448858, the 9 pools above).
- **Acceptance:** `npm run searcher:planner` runs the new fixture and asserts **`0 candidates`
  today** with classification `impact_pool_not_in_routing_graph` (the baseline failure this epic
  must later flip). This is the pinned `baseline_failure`.

### Slice 1 — Discover the missing V2-fork venues (pool gap, highest ROI)
- Add RigelSwap (`0x880A…`), SmarDex (`0x7753…`, `0xB878…`), DIFX (`0xe5aa…`) factories to
  `FACTORIES` in [active-pool-discovery.ts](listener/src/searcher/active-pool-discovery.ts). They
  emit `PairCreated` like UniV2, so factory-scan + the existing V2 `Swap`/`Sync` topics apply.
- **Acceptance (rule-12 flip):** after a discovery run over a window covering block 25448858, the
  runtime graph contains pools `0xdf14…a357`, `0xf3a4…0179`, `0xae26…97e4`, `0xc034…bf0d`.
  `expected_transition: pool_in_routing_graph false→true` for pool `0xdf14…a357`.
- **Note:** discovery ≠ correct pricing. SmarDex edges discovered here are still mispriced until
  Slice 2 — do not route through them before Slice 2 lands (guard: tag SmarDex adapterId distinctly
  so the quoter routes it to the new math, not `univ2`).

### Slice 2 — SmarDex adapter: quote + execute (path/adapter gap)
- Add a `smardex-swap` adapter: quoter math in [solver/quoter.ts](listener/src/searcher/solver/quoter.ts)
  using SmarDex fictive-reserve formula (`getAmountOut` with `fictiveReserve*` + `priceAverage`),
  and the BotVM execution leg (`1f18b371` `swap(...)`) in the plan-builder / Solidity BotVM.
- **Acceptance (rule-12 flip):** a unit test quotes a real SmarDex swap from block 25448858 and
  matches the on-chain `amountOut` **bit-exact** (same bar as the curve/v3 local-quote work, memory
  [[project-path-b-local-quote]]). `expected_transition: smardex quote == on-chain amountOut (1 wei)`.

### Slice 3 — Deeper hops for the spatial loop (config/planner)
- Allow the spatial-scan path to enumerate longer cycles (raise the hop budget for the
  cyclic-scan mode specifically; keep the live victim-backrun path at its low cap for latency).
- **Acceptance:** with Slices 1–2 landed, `npm run searcher:planner` on the Slice-0 fixture now
  emits **`candidate_plans > 0`** that reconstruct the WBTC→…→WBTC loop through the SmarDex/Uniswap
  legs. `expected_transition: candidate_plans 0→>0` (ideally the loop matches the on-chain venue set
  minus the un-adaptered legs).

### Slice 4 — Spatial / cyclic detection mode (detection-model gap)
- Add a top-of-block / standing-dislocation scan that seeds the planner with cyclic opportunities on
  the newly-covered venues **without** requiring an in-block victim (the current `BackrunDetector`
  cannot see these).
- **Acceptance:** on a fork at block 25448858 pre-state, the detector emits a WBTC-cycle opportunity
  for this pool set with **no victim tx supplied**; the planner + solver produce a bundle whose
  simulated `sim.success` is **+EV net of gas** (or, if only dust like the original, explicitly
  logged as `dust` per the "don't celebrate dust" rule).

### Explicitly NOT doing (recorded)
- **Enzyme `redeemSharesInKind` (`0x4d54…`) and the OUSD custom AMMs (`0x1791…`, `0x6d18…`)**: exotic,
  low-reuse legs. Excluded from this epic. Consequence: we will reconstruct the *SmarDex/Uniswap
  portion* of the loop but **not this exact tx end-to-end**. That is acceptable — the goal is the
  reusable SmarDex venue class + spatial mode, not this dust bundle. Revisit only if these legs
  recur across ≥2 further competitor captures (rule-13 recurrence trigger).
- No broadcast. Every slice gates on fork/replay; live competitiveness is a separate dry-run gate.

### Definition of done (epic)
`fixed` (not merely `implemented`) requires the Slice-0 fixture to flip
`0 candidates (impact_pool_not_in_routing_graph)` → `candidate_plans > 0` reconstructing the loop,
**with** Slice-2's bit-exact SmarDex quote proven against block 25448858. Record
`failing_sample / baseline_failure / fix_commit / replay_command / replay_result /
expected_transition / verdict` per rule 12 at epic close.
