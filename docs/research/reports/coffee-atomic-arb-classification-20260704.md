# coffeebabe strategy classification — atomic chain-arbitrage vs backrun (2026-07-04)

> Scope: authorized, defensive on-chain arbitrage research. Public chain data only; local reth full
> node (zero-CU) + one bounded Alchemy query. Fork/replay analysis; no broadcast (broadcast is a
> human-gated step). Purpose: classify how a comparison searcher (`0xC0ffeEBABE…29671`) sources its
> arbitrage — does it follow a pending source swap (backrun), or capture a standing cross-pool price
> difference by scanning chain state (atomic) — and localize why our searcher does not submit a
> competing bundle for the same opportunities.

## Summary
Over `0xC0ffeEBABE…`'s 9 arbitrage txs after block 25454979:
- **8/9 = atomic chain-state arbitrage** (a standing cross-pool price difference captured in one tx;
  **no preceding swap on any shared pool in the same block** → nothing to follow).
- **1/9 = backrun** (one preceding public source swap on a shared pool).
- **Correction to an earlier claim:** `maxPriorityFeePerGas=0` does NOT prove "private orderflow" — it
  only shows the tx is submitted as a bundle paying the builder via coinbase transfer, which every MEV
  searcher does (public relay or private). Coffee's atomic opportunities are **public and
  permissionless** (pool prices are public chain state); "private" was a mis-frame for those.

## Method / tools
| step | tool | source | neutral notes |
|---|---|---|---|
| enumerate the comparison searcher's txs after a block | `alchemy_getAssetTransfers` (fromAddress, category=external) | Alchemy (1 bounded query) | 9 txs, all `to=0xE08D97…` |
| tx / receipt / block fields | `eth_getTransactionByHash` / `…Receipt` / `eth_getBlockByNumber` | local reth `127.0.0.1:8545` via SSM | zero-CU |
| **atomic-vs-backrun classifier** | per tx: collect the arb pools from its swap logs (UniV2/V3/V4, Curve TokenExchange, Balancer), then `eth_getLogs` each pool for the same block and count swaps at a **lower tx index** (a preceding swap on a shared pool = a source swap it followed) | local reth | 0 preceding → atomic; ≥1 → backrun. Script `coffee-backrun-verify.mjs` |
| submission method (bundle vs public) | `maxPriorityFeePerGas`, builder via `decodeExtraData(block.extraData)`, coinbase transfer via `debug_traceTransaction` callTracer | local reth | 0 tip + coinbase transfer = bundle (does NOT imply private orderflow) |
| our visibility | grep `SEARCHER_EVENTS_PATH` (`/var/log/mev/events/searcher-live.jsonl`) for the source-swap hash | node events JSONL | seen? / stage reached |
| realized value (gross/net USD) | WETH `Withdrawal` (unwrap) + coinbase transfer + gasUsed×effGasPrice; ETH/USD via Chainlink `0x5f4eC3Df…8419` `latestAnswer` | local reth | WETH-unwrap gross is a LOWER bound (misses token-denominated value) |
| our mempool admission filter | read `listener/src/searcher/main.ts:203-221` `MEMPOOL_ROUTER_ADDRESSES` | repo | fixed ~14-router allowlist OR tracked pool |

Scripts (this session, scratchpad): `coffee-victims.mjs`, `coffee-xref.mjs`, `coffee-backrun-verify.mjs`,
`coffee-flow.mjs`, `victim-check.mjs`, `coffee-profit.mjs`.

## Raw results — the 9 txs
`from=0xC0ffeEBABE…29671`, `to=0xE08D97e1…`. ETH/USD=$1746.76.

| # | tx | block | idx | arb pools | preceding swap on a shared pool | class | net USD |
|---|---|---|---|---|---|---|---|
| 1 | 0xee51e264 | 25454979 | 70 | 1 | 0 | **atomic** | $0.00 |
| 2 | 0x803a3693 | 25455024 | 201 | 3 | 0 | **atomic** | $0.33 |
| 3 | 0xf2de7499 | 25455297 | 37 | 4 | 0 | **atomic** | $0.18 |
| 4 | 0xdc52761f | 25455523 | 136 | 5 | 0 | **atomic** | $0.00 |
| 5 | 0x975e9ea6 | 25455539 | 113 | 2 | 0 | **atomic** | $0.04 |
| 6 | 0x96f48d4d | 25455738 | 122 | 1 | 0 | **atomic** | $0.06 |
| 7 | 0x378e0ed2 | 25455838 | 243 | 0 | 0 | **atomic** | −$0.13* |
| 8 | 0x5f9f530f | 25456048 | 36 | 1 | 0 | **atomic** | $0.01 |
| 9 | 0xc9ad7160 | 25456237 | 52 | 1 | **1 (`0x8e0c59b4…`)** | **backrun** | −$0.19* |

`*` net = WETH-unwrap gross − costs; a lower bound (misses token-denominated value), so #7/#9 are
understated.

### The one backrun (#9) and why we did not submit
- Preceding public source swap `0x8e0c59b404…`: `maxPriorityFeePerGas=6782416` (>0 ⇒ it travelled the
  public mempool), `to=0x663dc15d…` (a custom router, selector `0x4d8160ba`), multi-pool USDC/WETH.
- `source_swap_in_our_events = false` — our searcher never saw it. Root cause: `0x663dc15d` is not in
  `MEMPOOL_ROUTER_ADDRESSES`, so our filtered-mempool admission dropped it **before** the funnel
  (`opportunity_seen=0`, `bundle_submitted=0` near that block). Fixable flow-admission gap: admit by
  pool-touch rather than a fixed router allowlist.

## Why our searcher does not submit for the atomic 8/9
Our searcher is **backrun-shaped**: it forks on a **pending source swap** in the mempool and simulates
a following trade. An atomic chain-arbitrage has **no pending source swap** — it captures a standing
cross-pool price difference in one tx. So our pipeline never triggers; there is nothing to follow.

This is a **strategy/capability gap, not a filter gap and not a lost auction**: capturing standing
price differences requires a **per-block whole-graph scanner** (each new block, search indexed
pool-pairs for a profitable cycle), which our searcher does not have. These opportunities are public
and permissionless (pool prices are public chain state), so they are contestable in principle.

## Distance-to-production levers (three distinct, none is "lost the auction")
| the comparison searcher's flow | what we lack | class |
|---|---|---|
| 8/9 atomic chain-arbitrage | a per-block whole-graph scanner (we only follow pending source swaps) | strategy / architecture — largest |
| 1/9 public backrun | mempool admission too narrow (fixed router allowlist) | flow-admission — fixable |
| private-orderflow slice (separate finding) | MEV-Share / private orderflow access (was disabled) | economics / access |

## Corrections recorded (do not repeat)
1. **"private" was overstated.** `maxPriorityFeePerGas=0` = bundle submission with a coinbase builder
   payment (universal for MEV searchers), NOT proof of private orderflow. For atomic arbitrage the
   opportunity is public chain state, so "private" is a category error there.
2. **"dust" was imprecise.** The census `--min-profit-usd` default is 0.1, yet several of these txs
   net above $0.1 (up to $0.33; ETH=$1746.76). Report per-tx net USD vs the $0.1 line.
3. **Methodology gap:** the per-round comparison checks pool coverage but not "did we SEE the
   comparison searcher's public source swap" nor "is the comparison searcher backrun-shaped or
   atomic-shaped". Both belong in the standing analysis (reuse `victim-source.ts` + `sender-flow.ts`).

## Caveats
- The atomic/backrun classifier counts preceding swaps on shared pools across UniV2/V3/V4 + Curve +
  Balancer; a source swap on a venue outside that set would be missed, so "atomic" is a lower bound on
  followability (but 8/9 with zero preceding swaps across all those venues is a strong signal).
- Whether these atomic opportunities are reproducible from public chain state alone is confirmable by
  a fork replay at the pre-tx block (recommended next step) — it would substantiate "contestable with
  a scanner, no private information required".
