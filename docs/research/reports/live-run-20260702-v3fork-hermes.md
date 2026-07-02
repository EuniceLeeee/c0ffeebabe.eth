# Hermes — Cycle `20260702-v3fork`

> Scope note: authorized on-chain **arbitrage research** — mainnet fork + dry-run only; broadcast
> stays a human-gated step (CLAUDE.md Safety Rule 1). This cycle studies a public competitor
> transaction and closes the coverage gap it exposes.

> One run, one file. Each agent writes **only its own sections**, never edits the other's.
> **`Claude Final Decision` is the only section that drives code.**

```yaml
run_id: 20260702-v3fork
date: 2026-07-02
window: sample-initiated (block 25442109, tx index 81) — not a 30-min live-run follow-up
config: n/a (no live run this cycle; analysis on Alchemy RPC, local reth tunnel down)
cu_budget: 100 calls (analysis)   # actual spend ~25 light calls (tx/receipt/getLogs/eth_call)
cu_spent: ~25 calls
codex: pending
turn_class: extraction            # brief changes searcher behavior (graph gains a pool class)
inputs:
  competitor_cross_reference: manual primary-source trace (below) — user-supplied sample tx
  key_tx_links:
    - https://etherscan.io/tx/0xa3c18c97320c3a6c7f5b2f9ab0a2cec53b400a96bbd3d529b9022437063a90d5
```

---

## Run Facts  <!-- auto -->

Cycle origin: user-supplied competitor sample (coffeebabe), not a live-run artifact.
No funnel/JSONL this cycle; the mandatory Step-1 competitor cross-reference was done
manually at transaction level (primary sources: `eth_getTransactionByHash`,
`eth_getTransactionReceipt`, `trace_transaction`, `eth_getLogs`, `eth_call` probes).

## Competitor Cross-Reference — manual trace (mandatory Step 1)  <!-- Claude, primary source -->

Sample: `0xa3c18c97320c3a6c7f5b2f9ab0a2cec53b400a96bbd3d529b9022437063a90d5`
block 25442109 (0x184373d), tx index 81, from `0xC0ffeEBABE…29671` (watchlist) → executor
contract `0xE08D97e151473A848C3d9CA3f323Cb720472D015` (same BotVM-style contract we study).

Raw flow (receipt logs, wei-exact):

| leg | pool | in → out |
|---|---|---|
| 1 (flash-swap) | `0xE0554a476A092703abdB3Ef35c80e0D76d32939F` Uni v3 USDC/WETH 0.01% | borrow 47.811488 USDC, repay leg 3's WETH |
| 2 | `0x3416cF6C708Da44DB2624D63ea0AAef7113527C6` Uni v3 USDC/USDT 0.01% | 47.811488 USDC → 47.843923 USDT |
| 3 | `0x05DEF6d34631BbDD35E212cb749CACaebf8C963d` **v3-fork** WETH/USDT 0.05% | 47.843923 USDT → 0.029633 WETH |
| repay | pool 1 | 0.029558 WETH |

Economics: gross 75,430,711,800,926 wei WETH (= WETH `Withdrawal` amount, exact);
internal transfers: 4,737,048,701,040 wei to builder fee recipient `0xDAdB0d80…3711`,
70,693,663,100,514 wei back to EOA; gas 292,980 @ 0.0928 gwei; **net ≈ +0.0000435 ETH (~$0.15)**.
Split sanity: builder + EOA = unwrap + 628 wei tx value (exact).

Trigger analysis (this is the load-bearing finding):
- `eth_getLogs` over block 25442109 on all three pools: **only tx index 81 touched them** —
  no in-block triggering swap precedes it. Loop profitability depends only on these 3 pool
  states ⇒ the mispricing existed at end of block 25442108.
- Last swap per pool before target: `0xE0554a` @ 25442108 (**1 block before**),
  `0x05DEF6` @ 25442106, `0x3416cf` @ 25442101. The block-25442108 swap on `0xE0554a`
  (a pool in OUR pinned set) created the imbalance; coffeebabe captured it **next block**
  with a 0.0928 gwei priority-fee tip. Class: **next-block state-arb, no in-block trigger**.

Third-leg pool identity (eth_call + bytecode probes):
- `token0`=WETH, `token1`=USDT, `fee`=500; `factory()` = `0x075C42cD233a1c723c0F18f6dd575c8d679FEA85`
  (NOT the official Uni v3 factory). Factory has ~38 lifetime events; pool has 12 swaps/day.
- Pool bytecode contains standard v3 `swap` selector `0x128acb08` **and**
  `uniswapV3SwapCallback` selector `0xfa461e33`; factory answers standard
  `getPool(WETH,USDT,500)` → the pool. **Fully Uni-v3-ABI-compatible fork.**

## Path / Leg Findings — our-side coverage audit  <!-- Claude -->

Verified against code (not memory):

1. **Pool gap (primary).** `0x05DEF6` is nowhere in the repo. Why each discovery channel misses it:
   - `indexFactoryPools` (`active-pool-discovery.ts`): factory whitelist = UniV2/Sushi/UniV3 official only.
   - `scanActivePools` startup (300 blocks / top 100 by count) + 5-min refresh (25 blocks / top 200):
     behavior-based and factory-agnostic, **but** a 12-swap/day pool can never rank top-100 over 300 blocks.
   - 30-day universe builder `build-active-pool-universe.ts` (`npm run searcher:pool-universe`,
     minSwaps=2, maxPools=3000, metadata-enriched) **would** include it (~360 swaps/30d) — but
     `searcher/pools/active-pools.json` has never been generated, and even if present,
     `SEARCHER_POOL_UNIVERSE_TOP_N` defaults to `"0"` → `loadPoolUniverse(maxPools: 0)` →
     `slice(0,0)` → **empty**. The universe channel is default-OFF in live.
2. **Path gap: none.** `SEARCHER_MAX_HOPS` default 3 (triangle fits); `FLASH_SWAP_REPAY` template
   1–8 swaps; token-graph builds both directed edges for any `adapter:"univ3"` pool;
   `univ3.ts` adapter encodes `pool.swap` on arbitrary target; BotVM `fallback()` handles the
   callback via TSLOT offset with no factory check. Execution layer needs **zero** changes.
3. **Strategy-shape gap (secondary).** `Opportunity.kind` is only `"backrun-arb"`; the pipeline
   fires only on mempool pending txs. A no-trigger next-block state-arb is invisible even with
   full pool coverage. Victim-centric live-loss attribution has the same blind spot.
   (For THIS sample a mempool path exists too: the block-25442108 triggering swap on `0xE0554a`
   was a normal pool swap we could have backrun same-block — if leg 3 had been in the graph.)

## Claude Round 1
- **core judgment:** the sample is a **pool gap** (v3-ABI fork pool outside every enabled
  discovery channel) plus a latent **strategy-shape gap** (no state-arb trigger). Cheapest
  +coverage move: pin the pool + enable the already-built 30-day universe channel; the
  state-arb detector is a separate behavior change and must not bloat this patch.
- **next_action:** Final Decision + Brief below (fixtures + pinned pool now; universe
  generation/enable as ops; state-arb detector → next cycle, ledgered).
- **not_doing:** new discovery architecture (already exists), v4 epic scope, any solver/adapter edits.

---

## Claude Final Decision

**Decision:** close the v3-fork pool-gap class exposed by the coffeebabe sample, in two slices;
defer the state-arb detector to the next cycle as a ledgered behavior change.

- **Slice 1 (Codex, this brief):** repair-replay fixtures pinning the sample (gap + flip) in
  `listener/src/searcher/test/planner.ts`, and add pool `0x05DEF6` to
  `listener/searcher/pools/pinned-warm-pools.json` so the live graph gains the pool now.
- **Slice 2 (Claude, ops after Slice 1 lands):** generate `active-pools.json` on the local reth
  node (`npm run searcher:pool-universe`, lookback within --full retention window, zero CU),
  deploy with `SEARCHER_POOL_UNIVERSE_TOP_N=500`, then a 30-min dry-run metrics gate
  (`prep_ms p50/p95`, `expiredBeforeSolver`, `pipeline_dropped` mix) before ramping TOP_N.
- `searcher_behavior_change: yes` (routing graph gains the pool / pool class; what the searcher
  catches changes).

**Repair-replay gate (rule 12):**
```
failing_sample:    coffeebabe triangle, block 25442109 tx 81 (pools E0554a / 3416cf / 05DEF6)
baseline_failure:  planner cannot close WETH→USDC→USDT→WETH; leg-3 pool absent from graph
                   (fixture "v3fork-triangle-gap" asserts plans=0, observed classification
                   only_immediate_same_pool_reverse)
fix_commit:        58c8ca5
replay_command:    cd listener && npm run searcher:planner
replay_result:     planner PASS (12/12) + replay fixtures (4/4); gap fixture 0 plans w/
                   class=only_immediate_same_pool_reverse; flip fixture ≥1 plan (run by
                   Claude locally, independent of Codex's pasted output)
expected_transition: with 05DEF6 edges present + maxHops 3 → candidate_plans > 0  ✓ flipped
verdict:           fixed (planner-level flip; live competitiveness still gated by the
                   Slice-2 dry-run before ramping universe TOP_N)
```

## Implementation Brief — Codex pass 1  <!-- Claude authors; Codex implements -->

> Scope note: authorized arbitrage research; fork/dry-run only; broadcast is human-gated.

**Task:** two files only. No other file may change.

**File 1 — `listener/src/searcher/test/planner.ts`** (append to existing
`REPLAY_FIXTURES` machinery, style-matching the two existing fixtures):

1. Extend `ReplayFixture` with two optional fields:
   `maxHops?: number` (harness currently hardcodes `setMaxHops(2)`; use `fx.maxHops ?? 2`)
   and `expectMinPlans?: number` (when set, assert `plans.length >= expectMinPlans` instead of
   exact equality; `expectPlans` behavior unchanged for existing fixtures).
2. Add local consts (checksummed):
   `POOL_USDC_WETH_100 = ADDR.UNISWAP_V3_USDC_WETH_100` (`0xE0554a476A092703abdB3Ef35c80e0D76d32939F`),
   `POOL_USDC_USDT_100 = ADDR.UNISWAP_V3_USDC_USDT_100` (`0x3416cF6C708Da44DB2624D63ea0AAef7113527C6`),
   `POOL_V3FORK_WETH_USDT = "0x05DEF6d34631BbDD35E212cb749CACaebf8C963d"`.
   Tokens: `ADDR.WETH`, USDC `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`,
   USDT `0xdAC17F958D2ee523a2206206994597C13D831ec7` (reuse existing consts where present).
3. Fixture A `id: "v3fork-triangle-gap"`, provenance
   `"coffeebabe 0xa3c18c97…a90d5 block 25442109; leg-3 v3-fork pool absent from graph"`:
   edges = both directions of E0554a (WETH↔USDC) + both directions of 3416cf (USDC↔USDT)
   — 4 edges, NO leg-3 pool; impact `{ tokenIn: WETH, tokenOut: USDC, pool: E0554a, start: WETH }`;
   `maxHops: 3`; `expectPlans: 0`; `expectClass:` **run the harness once, read
   `planner.lastNoCandidateDiagnostic().classification`, pin the observed string** (do not guess).
4. Fixture B `id: "v3fork-triangle-flip"`, same provenance + `"FLIPPED: pool covered"`:
   Fixture A's 4 edges + both directions of `POOL_V3FORK_WETH_USDT` (WETH↔USDT) = 6 edges;
   same impact; `maxHops: 3`; `expectMinPlans: 1`.

**File 2 — `listener/searcher/pools/pinned-warm-pools.json`**: append one entry, exact
schema of the existing `0xE0554a` entry:
`label: "V3-fork (factory 0x075C42) WETH/USDT 0.05% — coffeebabe sample 20260702"`,
`address: "0x05DEF6d34631BbDD35E212cb749CACaebf8C963d"`, `adapter: "univ3"`,
`warmDirections`: WETH→USDT `amountIn "1000000000000000000"` weight 40, and
USDT→WETH `amountIn "1000000000"` weight 40
(WETH `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`, USDT `0xdAC17F958D2ee523a2206206994597C13D831ec7`).

**Verification (must run, paste output):**
`cd listener && npm run build && npm run searcher:planner`
— all existing planner tests + both existing replay fixtures must still pass; new gap fixture
asserts 0 plans with pinned classification; new flip fixture asserts ≥1 plan.

**Allowed files:** the two above. **Forbidden:** `main.ts`, `planner/planner.ts`, `solver/**`,
`adapters/**`, `active-pool-discovery.ts`, `.env`, anything else. If a change outside the two
files seems required, STOP and report instead of editing.

## Acceptance
1. `npm run build` clean; `npm run searcher:planner` green with both new fixtures → verify: command output.
2. Gap fixture pins the real classification string (observed, not guessed) → verify: diff + output.
3. `git diff --stat` touches exactly the two allowed files → verify: orchestrator diff-scope check.

## Slice 2 — Deploy + Metrics Gate (node `mev-searcher.service`)  <!-- Claude ops -->

**Deployed** (node `i-0ff908dedeec9ebc6`, SSM only): `git reset --hard origin/main` →
`281cf50` (incl. checksum hotfix). Generated `active-pools.json` on the local reth node
(zero CU): `npm run searcher:pool-universe` with `POOL_UNIVERSE_LOOKBACK_BLOCKS=7000`
(within --full retention) → **2,995 pools** written. Sample fork pool `0x05dEf6…` present
at rank 1447 (score 11, univ3, WETH/USDT). Set `SEARCHER_POOL_UNIVERSE_TOP_N=1500`
(explicit value fixes the `=0` footgun); verified `SEARCHER_DRY_RUN=1` before every restart.

**Startup crash + fix (rule-11 fallback, authored_by claude):** first restart crash-looped
(`fatal: bad address checksum` on the pinned fork pool). Root cause = **bad EIP-55 casing
in Claude's own Brief** (`0x05DEF6…` vs canonical `0x05dEf6…`) that Codex transcribed
verbatim; `loadPinnedWarmPools` runs `ethers.getAddress` at startup. Fixed both occurrences
(`58c8ca5`→`281cf50`), re-ran planner (4/4 green), redeployed → healthy.

**Pool registry growth (the actual thing this cycle risks):**
`2 protocol + 11 pinned + 1500 universe + 2712 factory + 100 swap-active = 4138 total`
(was 2801 in the latency cycle). Fork pool confirmed **in the runtime routing graph**
(`grep 05def6 runtime-graph-pools.json` → present).

**Window:** process start 04:09:30 UTC (block ~25442352), ~33 min, dry-run.

```
funnel (cumulative counters, this process — JSONL unavailable, see finding):
  hints 21253 / impacts 2976 / opportunities 56 / plans 364 / solverEntered 104 /
  solverSuccess 0 / simSuccess 0 / submitAttempts 0
  expiredBeforeSolver 7 / quoteTimeouts 15 / simReverts 0 / finalVerifyFailed 0 / missingState 0
per-hint end-to-end latency (n=19426): p50=14ms  p95=18ms  max=6747ms (single cold-state outlier)
hint skip mix: 12096 tx-filter / 4153 no-rawTx / 2920 hash-only / 82 victim / 3 insufficient
```

**Gate verdict: PASS (no regression) — TOP_N kept at 1500.**
- **Latency (the real risk of +1337 pools): not regressed.** p95 per-hint = 18ms with a
  4138-pool registry, well inside `planBudgetMs=300`/`oppTtlMs=5000`. Bigger graph did NOT
  blow up prep. `solverEntered=104` healthy (~1.9/opp).
- `expiredBeforeSolver=7` (raw) on 56 opportunities — small-sample noise, not the ≥16%
  starvation the latency cycle fixed; p95 confirms no systemic starvation. Not "显著劣化",
  so no rollback to 500.
- **No live +EV close this window** (`solverSuccess=0`), consistent with prior runs.
- **Fork pool `0x05def6`: 0 live hits this window.** Expected — 12-swap/day pool over 33 min;
  it may simply not have traded, and even a swap must land in a detected opportunity. Coverage
  is proven at the graph level (planner flip fixture `v3fork-triangle-flip` + runtime-graph
  presence); live capture awaits a window where it actually moves. **This is why the repair-
  replay flip — not a live catch — is the correctness gate for a pool-coverage fix (rule 12);
  live dry-run gates competitiveness, and a 33-min window can't force a rare pool to trade.**

**Post-window action:** set `SEARCHER_EVENTS_PATH` on the node so the next cycle's follow-up
uses structured JSONL (rule: prefer JSONL over log substrings) instead of counter scraping.

## Slice 2 — Step-1 Competitor Cross-Reference (done retroactively — was MISSED, now corrected)  <!-- Claude -->

**Process miss:** the first close of this section gated only on latency metrics and OMITTED
the mandatory Step-1 competitor cross-reference over the window. Corrected here; CLAUDE.md
hardened so a "metrics-gate" window can no longer skip Step-1. Our events JSONL was absent
this window, so `analysis live-loss --watch` couldn't run on it — did the minimum-bar manual
on-chain trace on the local reth instead (nonce delta + per-tx pool classification).

**Window:** blocks 25442352–25442520 (~33 min). WATCHLIST `0xc0ffeebabe…29671` (coffeebabe).

Machine-readable Step-1 record (consumed by the close-gate `npm run hermes-gate`):
```step1
run_id: 20260702-v3fork
window_blocks: 25442352..25442520
watchlist: 0xc0ffeebabe5d496b2dde509f9fa189c25cf29671,0xae2Fc483527B8EF99EB5D9B44875F005ba1FaE13
artifact: docs/research/reports/step1-20260702-v3fork.json
method: manual-onchain-trace
```

**Finding — coffeebabe made exactly 1 move from its main EOA in our window** (nonce
187915→187916): tx `0x5891adf8…977b`, block 25442447 (index 303 = backrun-shaped),
to executor `0xe08d…d015`, **success**, dust-scale profit (same profile as the origin sample).

Route (receipt + `trace_transaction`):
```
Balancer V2 Vault (flash, FlashLoan event 0x0d7d75e0)         → template-supported (balancer-flash) ✓
  → pool 0x2e8b0ba0…b5d3f  native-ETH(0xeee…eee sentinel)/USDT, v2-fork Swap topic, no fee()   NOT in graph ✗
  → pool 0xc7bBeC68…0e9b   USDT/WETH v3 (our pinned pool)                                        IN graph ✓
  → WETH wrap → repay
```

**Gap classification: pool gap (again).** `seenScope = same_pool` — we cover the `0xc7bBeC68`
leg but the loop can't close without `0x2e8b0b` (confirmed absent from `active-pools.json`
AND `runtime-graph-pools.json`). So we could not have captured this even post-Slice-2.
**This is the SAME gap class this whole cycle is about** (uncovered non-standard pools), with
a new wrinkle: `0x2e8b0b` uses the `0xeee…eee` native-ETH sentinel + a V2-style event — a
cousin of the ledgered native-ETH/ZeroAddress v4 gap. Two independent samples (origin tx +
first in-window competitor tx) now point at the same frontier: **non-standard / native-ETH
pools missed by our discovery + graph**, not a path or template gap.

**Second watchlist bot `0xae2Fc483…FaE13` — sampling analysis (46 txs in window).** Nonce
delta 0x62198a→0x6219b8 = **46 txs**, all to executor `0x1f2f10d1…f387` (high-frequency
multi-pool arber). Sampled 3:
- `0x816c176e…374e9` (blk 25442420): 4-pool arb, 2 legs IN graph / 2 OUT (`0x60b84fc4`,
  `0xe6e386c6`).
- `0xc0b55b11…d7e1` (blk 25442460): 2-pool arb, **both** legs OUT (`0x8597fa07`, `0xeab9a071`).
- `0x68f186f0…20ead` (blk 25442493): 2-pool arb, 1 IN (`0xc3f6b81f`) / 1 OUT (`0x0b0d6c11`).
3/3 sampled are multi-pool arbs with ≥1 leg OUT of our graph → **recurring pool-coverage gap**,
same frontier as coffeebabe + the origin sample.

**Consolidated window read:** both watchlist bots + the origin sample all point at ONE gap
class this cycle — **pool coverage across many non-standard/native-ETH venues**, not path or
template. This is now recorded in a structured artifact and enforced by `hermes-gate`.

**Caveat (honest scope):** coffeebabe was traced full (its main EOA had 1 tx); it also runs
other EOAs not swept here. ae2Fc483 sampled 3/46. Single-window — not a rate. Next window
(events JSONL now on) uses `live-loss --watch` to sweep both automatically.

## Findings Ledger
| finding | decision | owner | carry_to_round |
|---|---|---|---|
| No-trigger next-block state-arb invisible (kind only `backrun-arb`) | next cycle brief (behavior change) | Claude | 20260703 cycle |
| live-loss lacks `trigger_type` (backrun vs state-arb) + per-pool in_universe/in_graph tags | pair with state-arb cycle | Claude | 20260703 cycle |
| `SEARCHER_POOL_UNIVERSE_TOP_N=0` silently disables universe channel (footgun) | **DONE** — set explicit `=1500` on node .env | Claude | this cycle (ops) ✓ |
| `active-pools.json` never generated | **DONE** — generated (2995 pools, 7000-block lookback); cadence policy still open (regen weekly?) | Claude | cadence → backlog |
| pinned-warm-pools has **no EIP-55 checksum-validation gate** — a bad-casing address only fails at node startup (crash-loop), never in CI/build | add a checksum assertion to `searcher:planner` or a pinned-pools lint so bad casing fails locally, not on the node | Claude | 20260703 cycle |
| node `.env` missing `SEARCHER_EVENTS_PATH` → no structured JSONL; follow-up forced onto log counters (violates "prefer JSONL" rule) | **DONE this cycle** — set events path + restart (dry-run guard re-verified) | Claude | this cycle (ops) ✓ |
| **PROCESS MISS:** Slice-2 window closed on metrics only, skipped mandatory Step-1 competitor cross-reference | **FIXED** — ran it retroactively (coffeebabe 1 window tx = pool gap on native-ETH `0x2e8b0b`); CLAUDE.md hardened so metrics-gate windows can't skip Step-1 | Claude | this cycle ✓ |
| native-ETH pools via `0xeee…eee` sentinel (not just ZeroAddress/v4) missed by discovery+graph — `0x2e8b0b` is a live example | fold into the discovery/native-ETH work with the v3-fork behavior-discovery slice | Claude | 20260703 cycle |

## Codex Implementation Pass  <!-- orchestrator fills after gates -->

```yaml
status: landed (pass 1, no fix loop needed)
authored_by: codex (gpt-5.5 xhigh), evaluated by claude (non-author)
changed_files:
  - listener/src/searcher/test/planner.ts   (+54/-3: ReplayFixture maxHops/expectMinPlans + 2 fixtures)
  - listener/searcher/pools/pinned-warm-pools.json  (+19: 0x05DEF6 univ3 entry, warm both directions)
verification: |
  ran_gate: cd listener && npm run build && npm run searcher:planner (run by Claude,
  independent re-execution — Codex's own run hit a sandbox tsx-IPC EPERM and used
  node --import tsx; both green). Result: planner PASS (12/12) + replay fixtures (4/4).
  finding: gap fixture classification observed as only_immediate_same_pool_reverse
  (planner diagnostic line confirms: edges=4/4 raw=1 prunedRoundtrip=1 constraintPass=0);
  flip fixture builds ≥1 plan at maxHops=3 with the fork pool present. Diff reviewed
  hunk-by-hunk; expectPlans made optional is guarded by an explicit missing-expectPlans
  assert, existing fixtures untouched.
diff_scope_check: |
  codex events.jsonl patch paths = exactly the two allowed files. Working tree also
  carries an out-of-scope CLAUDE.md edit from a CONCURRENT session in the same checkout
  (commit 3b20200 lineage, mtime 11:49) — NOT Codex's, NOT committed by this cycle.
cu_spent: 0 this pass (all local; analysis earlier ~25 light Alchemy calls)
codex: landed
hermes_gate: PASS (cd analysis && npm run hermes-gate -- docs/research/reports/live-run-20260702-v3fork-hermes.md → exit 0; step1 block + artifact step1-20260702-v3fork.json validated)
```
