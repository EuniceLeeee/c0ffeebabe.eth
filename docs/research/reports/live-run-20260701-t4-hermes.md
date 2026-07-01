# Hermes — Turn 4 `20260701-t4` (sizing the prize)

> Same window. Goal: put a dollar size on the watchlist bots' extraction to justify (or not) the Uni v4 epic.

## Attempt — venue-agnostic realized-profit measurement  <!-- verified, with honest limits -->

Method: per competitor tx, net the **bot contract (tx.to)** balance change — native ETH via `debug_traceTransaction` prestateTracer (diffMode) + WETH/USDC/USDT/DAI `Transfer` net — on local reth.

**Result (confounded, reported honestly):**
- Native ETH delta to the bot contract ≈ **0** across all 21 (v4 and non-v4) → profit is not settling as native ETH to `tx.to`.
- Token nets are dominated by **swap size, not profit**, because `tx.to` is frequently a router/pool, not the profit beneficiary (e.g. block 25434877 shows USDC −100,874 / USDT +100,932 — a 100k swap leg, not $58 profit).
- Cleanest readable signals: one v4 leg at **+$310 USDT** (block 25434953, matches the earlier decodable $315 detection_gap arb); most others net cents–single-dollars; window order ≈ **$100s**, dominated by a few arbs.

**Conclusion:** a Transfer/balance-diff shortcut CANNOT cleanly size these arbs — router intermediaries + v4 flash-accounting (`settle`/`take`) obscure the beneficiary. So clean v4 $-sizing genuinely requires proper **v4 `Swap` decoding + arb-beneficiary attribution** — i.e. slice 1 of the turn-3 Uni v4 epic. The failed shortcut is the evidence that justifies building it (not a heuristic).

## Claude Final Decision  <!-- AUTHORITATIVE -->
- **decision:** Do not fabricate a precise prize number from a confounded heuristic. Turn 4 records: (a) arbs range up to ~$300+ individually, window order ~$100s; (b) clean sizing needs the v4-decode slice; (c) the near-term **measurable + actionable** lever is the **5 detection_gap** arbs — pools already in our 2512-graph, decodable (+$84), where we got no hint — a mempool/router-signal question, not a v4 build. No code this turn (the honest output is the redirect, not a forced tool).
- **rationale:** verify-before-claim + no-invented-work.

## Next levers (for human review)
1. **detection_gap (5, near-term):** for pools we already have, why no `opportunity_seen`? Check whether each competitor arb backran a mempool victim via a router NOT in `MEMPOOL_ROUTER_ADDRESSES` (→ add router) vs was atomic/no-victim (→ strategy gap, backrun model can't catch). Cheap, actionable, verifiable.
2. **Uni v4 epic (structural, human-gated):** slice 1 = analysis v4 `Swap` decode + beneficiary attribution → real v4 $; then the searcher v4 adapter.

## Implementation / Review-Fix Loop
- **code changes this turn:** none (deliberate).
- **ran_gate:** on-chain measurement over 21 txs (prestate ETH diff + token Transfer net) on local reth; demonstrated the heuristic is confounded (native ETH ≈ 0, router-dominated token nets).

## Next Run
- **next_state:** pick lever 1 (detection_gap → router/mempool coverage, small + verifiable) OR begin epic slice 1 (v4 decode) — human choice.
- **live_allowed:** no (dry-run only; go-live human gate).
