# coffeebabe competitive analysis — post-R21 (blocks 25454979+), 2026-07-04

> Scope: authorized, defensive on-chain arbitrage research. Public chain data; local reth (zero-CU)
> + one bounded Alchemy query. Triggered by a manual challenge: "if coffee backruns public-mempool
> victims, we should at least SUBMIT a competing bundle, not fail to submit — I don't believe there
> is nothing to optimize." This investigation confirms a real, fixable searcher-side gap that the
> autonomous R13–R21 watchlist analysis missed, plus a dust-label correction.

## TL;DR (two findings)
1. **Mempool router-allowlist blind spot (fixable searcher-side gap, NOT the economics gate).** Our
   filtered mempool (`listener/src/searcher/main.ts:206` `MEMPOOL_ROUTER_ADDRESSES`) admits a pending
   tx only if `tx.to ∈ {~10 hardcoded routers} OR {tracked pool}`. A **public** victim
   (`0x8e0c59b4…`, paid priority fee) that coffee backran routed through a **custom router
   `0x663dc15d`** (not in the allowlist, selector `0x4d8160ba`) → we **filtered it out → never
   forked/simulated it → never saw the opportunity → did not submit.** Any public swap through a
   non-allowlisted router (custom aggregators, MEV-Share routers, niche/new routers) is invisible to us.
2. **"Dust" was mislabeled.** The census `--min-profit-usd` default is 0.1, and several coffee txs
   net **above** $0.1 (up to $0.33), so calling them all "dust" was imprecise. Accurate: coffee's
   per-tx net is small ($0.02–$0.33), mostly-but-not-all below $0.1 (ETH=$1746.76 at analysis time).

## Method / tools used
| step | tool / command | source |
|---|---|---|
| enumerate coffee's txs after a block | `alchemy_getAssetTransfers` (fromAddress=coffee, category external) | Alchemy (1 bounded query) |
| tx / receipt / block fields | `eth_getTransactionByHash` / `…Receipt` / `eth_getBlockByNumber` | local reth `127.0.0.1:8545` via SSM (zero-CU) |
| victim-source (what coffee backran) | nearest preceding opposite-dir swap on a shared v2/v3/v4 pool (the `victim-source.ts` logic) | local reth |
| public-vs-private sender flow | `maxPriorityFeePerGas==0 ⇒ private` / paid priority fee ⇒ public (the `sender-flow.ts` logic) | local reth |
| builder identity | `decodeExtraData(block.extraData)` | local reth |
| our visibility | grep `SEARCHER_EVENTS_PATH=/var/log/mev/events/searcher-live.jsonl` for the victim hash | node events JSONL |
| profit (gross/net/USD) | WETH `Withdrawal` (unwrap) + `debug_traceTransaction` callTracer coinbase transfer + gasUsed×effGasPrice; ETH/USD via Chainlink `0x5f4eC3Df…8419` `latestAnswer` | local reth |
| filter root-cause | read `listener/src/searcher/main.ts:203-221` `MEMPOOL_ROUTER_ADDRESSES` | repo |

Scripts (scratchpad, this session): `coffee-victims.mjs`, `coffee-xref.mjs`, `coffee-flow.mjs`,
`victim-check.mjs`, `coffee-profit.mjs`.

## Raw data — coffee's 9 txs after block 25454979
All `from=0xC0ffeEBABE…29671`, `to=0xE08D97e1…` (original bot contract). ETH/USD=$1746.76.

| # | tx | block | builder | maxPrio | our sender_flow | victim (same-pool preceding) | grossUSD | netUSD |
|---|---|---|---|---|---|---|---|---|
| 1 | 0xee51e264 | 25454979 | BuilderNet | 0 | **private** | none (atomic) | $0.02 | $0.00 |
| 2 | 0x803a3693 | 25455024 | Titan | 0 | **private** | none | $0.40 | **$0.33** |
| 3 | 0xf2de7499 | 25455297 | — | 0 | **private** | none | $0.27 | **$0.18** |
| 4 | 0xdc52761f | 25455523 | Titan | 0 | **private** | none | $0.12 | $0.00 |
| 5 | 0x975e9ea6 | 25455539 | — | 0 | **private** | none | $0.09 | $0.04 |
| 6 | 0x96f48d4d | 25455738 | — | 0 | **private** | none | $0.10 | $0.06 |
| 7 | 0x378e0ed2 | 25455838 | — | 0 | **private** | none | $0.00* | −$0.13* |
| 8 | 0x5f9f530f | 25456048 | — | 0 | **private** | none | $0.04 | $0.01 |
| 9 | 0xc9ad7160 | 25456237 | Titan | 60603622 | mixed | **0x8e0c59b4… (PUBLIC)** | $0.00* | −$0.19* |

`*` gross measured as WETH-unwrap only → a LOWER BOUND; txs profiting in a token (USDC/USDT/…) read
as $0/negative. So true net for #7/#9 is higher than shown.

### The one public victim we missed (tx #9's source)
- victim `0x8e0c59b404087fe5c9be7b68d1ffc80a34703d5222e41f4cf6b2c906cfae3881`
- `from=0x298d0902…` `to=0x663dc15d…` (custom router, 4285-byte contract), selector `0x4d8160ba`
- **maxPriorityFee=6782416 wei (>0) ⇒ PUBLIC mempool.** Multi-pool USDC/WETH swap
  (0x1445f32d / 0x1533f61f / 0x3446dd70 / 0xef4fb24a).
- **`victim_in_OUR_events=false`** — we never saw it. Near that block we logged 7 `opportunity_seen`,
  0 `bundle_submitted`.
- Root cause: `0x663dc15d` ∉ `MEMPOOL_ROUTER_ADDRESSES` → filtered out.

## Interpretation
- **8/9 of coffee's flow is PRIVATE** (maxPriorityFee=0, builder-integrated to Titan/BuilderNet).
  Structurally invisible to public-mempool competition → that portion is genuinely **Lever B
  (private orderflow, human gate)**, confirming R20.
- **The 1 PUBLIC victim we missed is a searcher-side gap**, distinct from the economics gate: the
  mempool filter's fixed router allowlist blinds us to swaps through non-allowlisted routers.
- **Why R13–R21 missed this:** the watchlist analysis compared coffee's OUTCOMES (labelled dust) but
  never tested whether we SAW coffee's public victims. The census checks POOL coverage, not MEMPOOL
  ROUTER coverage — a methodology gap.

## Recommended next steps (searcher-side, not go-live)
1. **Quantify first:** over a window, count public victims (paid priority fee, touching a pool we
   index) whose `tx.to` is a non-allowlisted router. That sizes the blind spot.
2. **If material — widen admission:** admit a pending tx by **pool-touch** (decode/prelim-simulate to
   see if it swaps a pool we index) rather than a fixed router allowlist; catches custom routers.
3. **Fix the census methodology:** add a "did WE see this competitor's public victim" check (reuse
   `sender-flow.ts` + the events grep), so future rounds test mempool-router coverage, not just pools.
4. Correct the "dust" language: report per-tx **net USD** vs the $0.1 line, not a blanket "dust".

## Honest caveats
- Coffee's backrun of the missed victim was itself small; widening the filter catches MORE flow but
  much may still be sub-$0.1. Unknown until measured — we have been blind to it.
- The victim-source scan covered v2/v3/v4 pools only (not Curve/Balancer), so "none (atomic)" for
  8/9 is a lower bound on victims; the private-flow conclusion rests on the robust maxPriorityFee=0
  payment signal, which is independent of victim detection.
