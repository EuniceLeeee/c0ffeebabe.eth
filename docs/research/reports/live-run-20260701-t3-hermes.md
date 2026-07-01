# Hermes — Turn 3 `20260701-t3` (graph_gap frontier)

> Same run window (blocks 25434876–25434966). No new dry-run. Step-1 = `--watch <watchlist> --graph-pools <dump>`.

## Step-1 competitor cross-reference (grounded + secondary-validated)

Watchlist `0xc0ffeebabe…` + `0xae2Fc483…`, 21 MEV txs. Turn-2 authoritative split: not_seen **graph_gap=13 / detection_gap=5**. This turn drills the graph_gap.

## Discovery — the graph_gap frontier is Uniswap v4  <!-- verified -->

Breakdown of the graph_gap venues (from the watch reports' `protocols`): **9 of 21 competitor txs (43%) route through the Uniswap v4 PoolManager `0x000000000004444c5dc75cB358380D2e3dE08A90`.** Most graph_gap entries are `protocols:["Uniswap v4"]` with `pools:[]` (`nopool`) — because v4 is a **singleton PoolManager**, not per-pool pair contracts, so our factory/pair-based discovery + adapters index none of it (that's why they land in `graph_gap`).

**Secondary-source validation:** tx `0x6e3cbd946f…` emits a log from the v4 PoolManager — confirmed identical on local reth AND Alchemy (1 = 1). Counted across all 21: **9/21 touch the v4 PoolManager.**

Profit note: our analyzer cannot decode v4 swap deltas, so `roughProfit` for the graph_gap/v4 set is garbage (net -$55). The decodable `detection_gap` set (pools we already have) shows +$84. So the v4 dollar-size is currently **unmeasured**, not zero — decoding v4 is a prerequisite to prioritizing the epic.

## Claude Final Decision  <!-- AUTHORITATIVE -->
- **decision:** The dominant coverage frontier is **Uniswap v4** (43% of watchlist MEV). This is a structural DEX integration — a new v4 adapter over the singleton PoolManager (pool-key encoding, hooks, state read/quote), which touches the searcher hot path and gates go-live. **It is NOT a single autonomous turn and must not be rushed.** Turn 3 records it as the top-priority scoped epic with verified evidence; NO searcher code changes this turn.
- **rationale:** verify-before-claim + no-invented-work — faking a small "add pools" fix would be dishonest for a structural gap. The verified finding (43% via v4, secondary-validated) is itself the deliverable and redirects the roadmap.

## Scoped epic (backlog, human-gated to start)
**Uniswap v4 support.** Prereqs/slices: (1) analysis: decode v4 PoolManager `Swap` events → identify the v4 pool (poolId) + real token deltas → measure v4 arb $ (turn 4 candidate, analysis-only, verifiable). (2) searcher: v4 adapter — pool discovery from PoolManager, poolId/currency encoding, state read + quote, hook awareness. (3) graph: include v4 pools. Gate each slice; go-live stays human.

## Implementation / Review-Fix Loop
- **code changes this turn:** none (deliberate — structural epic, hot-path, human-gated).
- **ran_gate:** on-chain secondary validation only — 9/21 txs touch the v4 PoolManager, local==Alchemy for the sampled tx. No build/commit of code.

## Next Run
- **next_state:** turn 4 = bounded, analysis-only slice: decode Uniswap v4 `Swap` events so the watch analyzer can size v4 arb profit (turn the garbage -$55 into a real number) and identify the top v4 pools/tokens — the data needed to justify (or not) the v4 searcher epic. Also open: the 5 detection_gap (pools we have, no hint) — why no hint (router/mempool vs atomic-arb strategy gap).
- **live_allowed:** no (dry-run only; go-live human gate).
