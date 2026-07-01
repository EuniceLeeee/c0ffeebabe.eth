# v4 slice-1 — realized-profit audit (run 20260701 window)

Auditable artifact for the v4 decode + pricing patches (A–D, commits `bc1fe59`→`0e08a37`).
Reproduce: `analysis live-loss --watch 0xc0ffeebabe…,0xae2Fc483… --graph-pools
<runtime-graph-pools.json> --events <searcher-live.jsonl> --rpc http://127.0.0.1:8545`
(local reth, `price_trace=on`, `ethUsd=1575` from Chainlink). Window: blocks
25434876–25434966 (~18 min), 21 competitor txs from the 2 watchlist bots.

## Headline — with an honest correction

| metric | value | meaning |
|---|---:|---|
| `positive_legs_only` (code window total) | **$838** | **OVERCOUNT — do not use.** Sums only per-tx legs with net>0. |
| **true net (all legs)** | **$142** | Net of every leg; the real number. |
| net via v4-touching blocks | **$80** | ~56% of net (not the 81% an earlier positive-legs read implied). |

**Why the overcount:** these bots split one arb across multiple txs in a block, so
per-tx netting shows one leg positive and the others negative (e.g. block 25434926:
+$315 and −$288 → net +$27). The code's window total applies a `>0` gate and drops
the negative legs → ~6× overcount. **Known bug — the aggregate must net per (bot,
block), not sum positive legs.** Tracked as follow-up **patch E**; per-tx values below
are correct, the code's `realized_profit_usd total` line is not.

## Per-block net (the real per-arb profit)

| block | net USD | v4 pools | txs |
|---|---:|---:|---:|
| 25434917 | 52 | 1 | 1 |
| 25434937 | 50 | 0 | 2 |
| 25434926 | 27 | 2 | 2 |
| 25434966 | 8 | 0 | 1 |
| 25434877 | 2 | 0 | 2 |
| 25434916/22/27/31/34/47/53/64 | ~0 | (mixed) | — |
| **total** | **142** | — | — |

Per bot: `0xae2fc483…` net **$142** (19 txs); `0xc0ffeebabe…` (coffeebabe) net **$0**
(2 txs, netted out). The single biggest positive block ($50 @ 25434937) is **non-v4**;
v4's edge is the large gross legs (a $315 gross leg at 25434926), not a dominant net.

## Confidence distribution (patch B/C)

8 `high` · 12 `medium` (some unpriced token in the tx) · 1 `requires_decode` · 0
`unsafe` (neither bot's `tx.to` is a public router, so nothing was excluded — the
guard is in place for generality). Every v4 tx carries `v4_pool_ids[]`.

## Codex review acceptance (5 criteria)

1. every v4 tx has `v4_pool_ids[]` — **met** (patch A).
2. unpriced/poolkey-missing not marked `high` — **met** (patch B: medium/requires_decode).
3. public-router `tx.to` not auto-counted as bot actor — **met** (patch C: routers registry + `unsafe`).
4. external RPC no trace by default — **met** (patch D: `--price-trace` / local-only).
5. totals exclude `unsafe` — **met**; BUT the aggregate still overcounts by summing
   positive legs (the separate patch-E netting bug above).

## Not done (slice-1 remaining)

- **patch E:** window/aggregate must net per (bot, block); the current `total`/`via_v4`
  line overcounts.
- **poolId → token pair:** `v4_pool_ids[]` are raw poolIds; `currency0/1` mapping via the
  v4 `Initialize` event (indexed) is not built (old pools are beyond reth `--full` →
  needs archive or a cached poolkey index; mark `requires_poolkey_index`). `univ4Initialize`
  topic is staged but unused.

**Verdict:** patches A–D correctly make v4 visible + per-tx profit attributed with
confidence and cost/actor guards. The **window aggregate is not yet trustworthy**
(patch E), and v4 pool→token decode is still pending — so this is "v4 rough pricing +
auditable per-tx evidence", not "v4 profit solved".
