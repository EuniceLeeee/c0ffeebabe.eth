# Coffee full-corpus classifier calibration — 2026-07-12

Scope: authorized defensive arbitrage research. Public on-chain receipts only; no broadcast or key use.

## Result

The full Coffee export is now useful as a **candidate generator**, not an atomic-loop oracle. The receipt-log
classifier had four production-affecting defects: Fluid DEX was not a swap lineage, Sky PSM was reported as a
gap despite an existing adapter, every unknown emitter was promoted to a route gap, and the summary counted
only one of 24 known protocol-gap transactions. All four are fixed and mechanically gated.

Atomicity remains a second stage: every transaction with named protocol evidence must pass canonical
`bundle-postmortem` position-conservation analysis before it can influence an A/B verdict.

## Corpus manifest

- Local, gitignored source: `analysis/outputs/coffee-corpus/coffee-logs.csv`
- SHA-256: `156930644045a3769306424660a7eaf87ad0c9190e556b7894d2282be89f415e`
- Window: blocks `24558871..24588564`, `2026-03-01 00:00:47 UTC` through
  `2026-03-05 03:25:59 UTC`
- Contents: 857 unique successful Coffee transactions, 18,541 receipt-log rows
- Generated local artifacts: `analysis/outputs/coffee-corpus/venues.json` and
  `analysis/outputs/coffee-corpus/loop-coverage.json`

There was no second 857-transaction corpus in the repo to delete. The uploaded CSV itself contains exactly
857 transactions. The nine small committed Coffee fixtures remain intentionally: they are deterministic
regression gates, not a duplicate full corpus.

## Corrected contract

`venue-discovery-bq --loop-coverage` now emits schema v2:

- `protocolAdapterCandidate`: every **named** protocol event maps to a registered adapter.
- `protocolVenueGaps`: named protocol evidence with no registered adapter.
- `unclassifiedEmitters`: helper/accounting/token-specific events requiring trace; not automatically a gap.
- `coverageScope: receipt_log_emitters_only` and `comparability: requires_trace` on every row.
- Legacy `fullyCovered` remains a strict log-cleanliness field only; it is explicitly not proof of closure.

The canonical postmortem now also recognizes Fluid DEX topic
`0xdc004dbca4ef9c966218431ee5d9133d337ad018dd5b5c5493722803f75c64f7` as `fluidDex`.

## Full-corpus output

| measure | count |
|---|---:|
| transactions | 857 |
| transactions with named protocol evidence | 78 |
| transactions with a supported protocol leg | 55 |
| registered-protocol candidates | 54 |
| known protocol-gap transactions | 24 |
| transactions requiring trace before comparability | 78 |
| strict log-clean rows | 3 |
| protocol-evidence rows with unclassified emitters | 74 |

The 24 known-gap transactions reference eight unsupported ERC4626/protocol emitters. The largest buckets are
`0xe4b91faf8810f8895772e7ca065d4cb889120f94` (16 tx) and
`0x74ad2f789ed583dbd141bbdafc673fe1f033718b` (3 tx).

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
| strict log-clean | `0x52c27c6e…` | `atomic_loop` | +0.1124 | clean positive control |
| strict log-clean | `0xd5f6eb8c…` | `atomic_loop` | -0.0035 | closed shape does not imply positive net EV |
| strict log-clean | `0xf7a689fa…` | `one_leg_inventory` | +0.0120 | decisive proof that log cleanliness cannot authorize comparability |
| known protocol gap | `0x6dc56877…` | `atomic_loop` | +0.5096 | real production gap, not classifier noise |
| dominant protocol-gap family | `0x17c61de3…` | `atomic_loop` | +0.0661 | real but below the project's $0.10 dust threshold |
| pinned inventory control | `0x9be73297…` | `inventory_vault_rebalance` | see F-009 | Fluid lineage recognized, but private inventory still excluded |

The important production exemplar is `0x6dc56877…`: it is a conserving atomic loop and the classifier finds
an unregistered ERC4626-like USDC venue `0x74ad2f78…`. Canonical postmortem additionally finds UniV2 pool
`0x5377ee59…` absent from the current runtime graph. This is a real adapter/coverage backlog item; this
calibration change deliberately does not add the adapter or pool.

## Hermes / A/B use

1. Run `npm run competitor-calibration`; current gate is 15/15, including Fluid lineage and the Coffee
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
analysis tests: 102/102 PASS
competitor calibration: 15/15 PASS
venue-bq focused tests: 4/4 PASS
bundle-postmortem noise filter: 51/51 PASS
full corpus: 857 tx parsed; schema v2 summary generated
```
