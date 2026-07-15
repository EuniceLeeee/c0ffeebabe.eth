# Coffee full-corpus classifier calibration — 2026-07-12

Scope: authorized defensive arbitrage research. Public on-chain receipts only; no broadcast or key use.
Follow-up schema-v4 rerun: 2026-07-15.

## Result

The full Coffee export is useful as a **candidate generator**, not an atomic-loop oracle. The receipt-log
classifier separates observed roles from production routability: exact registered Fluid DEX evidence is
routing-attested, canonical Balancer Vault Swap events expose a real swap-route gap, Balancer flash loans
remain supported funding, and Balancer `PoolBalanceChanged` is liquidity evidence only. DODO Swap topics
remain candidate evidence until pool identity is attested; topic recognition alone is not production support.

Atomicity remains a second stage: every transaction with named protocol evidence must pass canonical
`bundle-postmortem` position-conservation analysis before it can influence an A/B verdict.

## Corpus manifest

- Local, gitignored source: `analysis/outputs/coffee-corpus/coffee-logs.csv`
- SHA-256: `156930644045a3769306424660a7eaf87ad0c9190e556b7894d2282be89f415e`
- Window: blocks `24558871..24588564`, `2026-03-01 00:00:47 UTC` through
  `2026-03-05 03:25:59 UTC`
- Contents: 857 unique successful Coffee transactions, 18,541 receipt-log rows
- Canonical schema-v4 output SHA-256:
  `b9f0104ff0cb5bb8daecb2354ec0ceaf02565c7c6c31703d7868ff9840a583b6`
- Committed canonical-input projection: 857 transactions and 9,810 unique `(emitter, topic0)`
  observations in `analysis/src/test/fixtures/loop-coverage-v4.json`; projection SHA-256
  `5b26c301a89de4d5d18ec746b0c5d35e2259aa6031e9c95f0f9be2bcf936b97e`.
- Generated local artifacts: `analysis/outputs/coffee-corpus/venues.json` and
  `analysis/outputs/coffee-corpus/loop-coverage.json`

There was no second 857-transaction corpus in the repo to delete. The uploaded CSV itself contains exactly
857 transactions. The nine small committed Coffee fixtures remain intentionally: they are deterministic
regression gates, not a duplicate full corpus.

The full-corpus regression no longer trusts copied counts. It decodes the committed projection, reruns
`classifyTxLoopCoverage` for all 857 transactions, reconstructs the canonical output byte-for-byte, hashes
it, and derives the exact Balancer FlashLoan/Swap/PoolBalanceChanged and DODO transaction sets. The raw CSV
remains gitignored; the normalized projection is the reviewable semantic input actually consumed by the
classifier.

## Corrected contract

`venue-discovery-bq --loop-coverage` now emits schema v4:

- `protocolAdapterCandidate`: every **named** protocol event maps to a registered adapter.
- `protocolVenueGaps`: named protocol evidence with no registered adapter.
- `unclassifiedEmitters`: helper/accounting/token-specific events requiring trace; not automatically a gap.
- `observedSwapVenues` and `observedFundingVenues`: receipt observations with independent identity and
  production-routability assessments.
- `observedSwapEmitterCount`: distinct swap emitters in that transaction.
- `receiptRouteCoverageComplete`: conservative receipt-route coverage only; never trace comparability or
  loop closure.
- `coverageScope: receipt_log_emitters_only` and `comparability: requires_trace` on every row.
- Schema v4 removes `swapVenues`, `fullyCovered`, and `gapVenues` rather than silently changing their meaning.

The canonical postmortem now also recognizes Fluid DEX topic
`0xdc004dbca4ef9c966218431ee5d9133d337ad018dd5b5c5493722803f75c64f7` as `fluidDex`.

## Full-corpus output

| measure | count |
|---|---:|
| transactions | 857 |
| transactions with named protocol evidence | 78 |
| transactions with a supported protocol leg | 54 |
| registered-protocol candidates | 53 |
| known protocol-gap transactions | 25 |
| transactions requiring trace before comparability | 857 |
| receipt-route-coverage-complete transactions | 0 |
| transactions with unclassified emitters | 702 |
| Balancer `FlashLoan` (`0x0d7d75e0…`) transactions | 489 |
| Balancer `Swap` (`0x2170c741…`) gap transactions | 19 |
| Balancer `PoolBalanceChanged` (`0xe5ce2490…`) liquidity transactions | 2 |
| DODO topic-observed, identity-unassessed transactions | 39 |

The two `PoolBalanceChanged` observations are no longer unclassified and create no swap or funding gap. Eight
observations from the exact registered Fluid singleton are routing-attested; the other 24 Fluid-topic
observations remain unassessed because their emitter identity is not registered. DODO event recognition is
observation evidence only: all 40 DODO emitter observations across 39 transactions remain
`unassessed/factory_or_routing_graph_not_attested`. The production listener has no DODO adapter, but receipt
topic evidence alone cannot prove that an arbitrary emitter is a genuine DODO pool.

## Manual plus canonical sampling

Each log-level result class was sampled independently, then reconciled with the existing any-tx
`bundle-postmortem` against the archive RPC. Net USD includes gas.

| log-level bucket | tx | canonical winner style | net USD | calibration meaning |
|---|---|---|---:|---|
| candidate, unknown emitters | `0x95805790…` | `atomic_loop` | +0.2169 | real protocol-DEX positive control; PSM/Curve/UniV2 all supported |
| candidate, unknown emitters | `0x32696afe…` | `inventory_vault_rebalance` | +0.2435 | one vault + six swaps still does not prove comparability |
| candidate, unknown emitters | `0x1cc4cd4f…` | `inventory_vault_rebalance` | +0.1560 | private vault inventory negative control |
| candidate, unknown emitters | `0x17f767fd…` | `inventory_vault_rebalance` | +4.7817 | high profit still excluded when position is not conserved |
| candidate, unknown emitters | `0xba5a9536…` | `inventory_vault_rebalance` | +1.5868 | same exclusion at another profit level |
| DODO identity-unassessed | `0x52c27c6e…` | `atomic_loop` | +0.1124 | DODO topic observed; trace/factory identity is still required before declaring a route gap |
| unassessed swap identity | `0xd5f6eb8c…` | `atomic_loop` | -0.0035 | closed shape does not imply receipt-only routability or positive net EV |
| Balancer swap-route gap | `0xf7a689fa…` | `one_leg_inventory` | +0.0120 | Balancer funding support does not imply Balancer swap support |
| known protocol gap | `0x6dc56877…` | `atomic_loop` | +0.5096 | real production gap, not classifier noise |
| dominant protocol-gap family | `0x17c61de3…` | `atomic_loop` | +0.0661 | real but below the project's $0.10 dust threshold |
| pinned inventory control | `0x9be73297…` | `inventory_vault_rebalance` | see F-009 | Fluid lineage recognized, but private inventory still excluded |

The important production exemplar is `0x6dc56877…`: it is a conserving atomic loop and the classifier finds
an unregistered ERC4626-like USDC venue `0x74ad2f78…`. Canonical postmortem additionally finds UniV2 pool
`0x5377ee59…` absent from the current runtime graph. This is a real adapter/coverage backlog item; this
calibration change deliberately does not add the adapter or pool.

## Hermes / A/B use

1. Run `npm run competitor-calibration`; current gate is 22/22, including Fluid lineage and the Coffee
   inventory control.
2. On the same measured block window run `scripts/census-gap.sh`; it joins the complete matched Coffee takes
   to canonical postmortems and source-block scanner evidence.
3. Only `atomic_loop` rows with conserved in-transaction positions enter the external A/B comparison.
4. Inventory, sandwich, keeper, RFQ, JIT-LP and standing-credit rows are excluded before gap attribution.
5. `venue-discovery-bq --loop-coverage` supplies candidates and named protocol gaps only. It never owns the
   merge decision.

## Verification

```text
analysis build: PASS
analysis tests: 223/223 PASS
competitor calibration: 22/22 PASS
loop-coverage + venue-bq focused tests: 18/18 PASS
bundle-postmortem noise filter: 57/57 PASS
full corpus: 857 tx / 18,541 receipt-log rows parsed; schema v4 output SHA-256 b9f0104f…83b6
```
