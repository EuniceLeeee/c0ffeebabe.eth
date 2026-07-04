# Mempool router allowlist — force-include seed (provenance)

Authorized arbitrage research: this documents the seed of `listener/searcher/pools/force-include-routers.json`,
the committed router/aggregator allowlist merged into the filtered-mempool admission set alongside the 14
builtin `MEMPOOL_ROUTER_ADDRESSES`. Fork/dry-run study; broadcast stays a human-gated step.

## Why (flow-admission gap)

We run a local reth firehose, so mempool ingest CU is already free; the address allowlist is a pure
downstream funnel-admission gate (`interesting(tx.to)`, `main.ts`). A pending tx has no logs, so its
arb impact is unknowable until we fork-apply it — hence `to` is the ONLY cheap pre-apply signal, and the
allowlist is funnel-LOAD protection (not CU saving). With only 14 builtin routers we filtered out whole
classes of retail/bridge swap flow before the funnel: e.g. a deBridge-routed source swap
(`0x663dc15d…`) that a competitor profitably backran was never admitted → `seen=0` → no bundle submitted.

## How this seed was derived (on-chain, zero hallucination)

Scanned 600 recent mainnet blocks on the local node. For every tx whose `to` is NOT already in the
allowlist and that emits ≥1 DEX Swap log (v2/v3/v4), tallied: tx count, distinct swap pools, and distinct
callers (`from`). Router/aggregator vs competitor-arb-bot is separated by **distinct callers**: a router
carries many retail callers (dozens–hundreds); an arb bot is called by 1–3 operator EOAs. Seed = entries
with **many callers (≥8) AND multiple pools (≥5)** — high-signal retail/bridge swap sources worth backrunning.
Single-caller-many-pool contracts (arb bots — backrunning them is pointless, they already equalized the
dislocation) and single-pool contracts were excluded.

Ranked by tx count (arb-relevance ~ real swap frequency). Recognized labels noted; the rest qualify by
on-chain behavior, not label.

| address | txs/600blk | pools | callers | label |
|---|---|---|---|---|
| 0x278d858f…f6ef8d2 | 1625 | 97 | 144 | (aggregator, unlabeled) |
| 0x51c72848…4502a7f | 578 | 57 | 118 | (aggregator, unlabeled) |
| 0x3328f7f4…a309c49 | 539 | 12 | 446 | (high-retail router) |
| 0x28b1dc1a…9cb2a183 | 416 | 187 | 298 | (aggregator, unlabeled) |
| 0x4c82d1fb…f70a2cca | 317 | 168 | 200 | (aggregator, unlabeled) |
| 0x00000000…72c22734 | 298 | 197 | 203 | (gas-opt aggregator) |
| 0x93c30e6e…faedd17 | 249 | 9 | 51 | (router, unlabeled) |
| 0xeff6cb8b…01aa167 | 196 | 44 | 59 | (aggregator, unlabeled) |
| 0xccc88a9d…1c315be | 155 | 73 | 74 | (aggregator, unlabeled) |
| 0xb300000b…c7028d | 110 | 90 | 101 | (aggregator, unlabeled) |
| 0x1231deb6…86f4eae | 98 | 58 | 143 | **LiFi Diamond** |
| 0x07964f13…5000000 | 84 | 27 | 37 | (gas-opt router) |
| 0x9008d19f…560ab41 | 76 | 75 | 14 | **CoW Protocol GPv2Settlement** |
| 0xbc1d9760…86c973 | 71 | 43 | 71 | (aggregator, unlabeled) |
| 0xbee3211a…8da000 | 60 | 23 | 9 | (router, unlabeled) |
| 0xb92fe925…c4fff4f | 58 | 16 | 27 | (router, unlabeled) |
| 0x00000000…37da032 | 56 | 40 | 62 | **ERC-4337 EntryPoint v0.7** (AA swap flow) |
| 0x4313c378…96b27f | 48 | 22 | 35 | (router, unlabeled) |
| 0xdcd51243…5d1a2a9 | 43 | 26 | 26 | (router, unlabeled) |
| 0xbe42b71d…dec2bc0 | 39 | 9 | 41 | (router, unlabeled) |
| 0x663dc15d…883c251 | 36 | 22 | 18 | **deBridge Crosschain Forwarder** (the found gap) |
| 0x69460570…0ca22d | 34 | 18 | 78 | (router, unlabeled) |
| 0x4337084d…b5ff108 | 32 | 16 | 45 | (router, unlabeled) |
| 0xac4c6e21…3f80b75 | 30 | 28 | 19 | (router, unlabeled) |
| 0x02e5be68…e6db2a9 | 27 | 17 | 23 | (router, unlabeled) |
| 0x6a000f20…40001068 | 27 | 33 | 29 | **ParaSwap Augustus v6** |
| 0xf24be340…81f57f0 | 27 | 31 | 19 | (router, unlabeled) |
| 0x5d3a6d87…2cd8a4 | 25 | 7 | 27 | (router, unlabeled) |

Added load is bounded + high-signal: ~15–25 extra admitted victims/block (real swaps), vs the ~75×
firehose that removing the filter entirely would dump into fork-apply. The long tail beyond this seed is
handled by the census/postmortem-driven learning loop (`force-include-routers.json` appends).

Regenerate: `analysis` scratchpad `discover_routers.py` + `enrich_routers.py` (local node, zero Alchemy CU).
