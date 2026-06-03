# Historical Replay Plan — Block 24710788

This document records the transaction order that creates the wstUSR depeg
opportunity used by the reference MEV bot.

Reference arb tx:

`0xf88b498b835279ec9de597c7360ca21b7e8803053b442a04c5fc664e04e39970`

Block:

`24710788`

## Execution Order

Etherscan/Tenderly often show the newest or highest transaction index first.
For replay, use Ethereum execution order: `transactionIndex` ascending.

| Tx Index | Tx Hash | Status | Role |
|---:|---|---:|---|
| 0 | `0xc52bc6f4d29a96bc18efa09708636e9d37109918d28c52d585a5f3df1609bb22` | 1 | Initial user swap; creates the wstUSR depeg |
| 1 | `0x63db40c3ff6c68b439fd036de364420b96c2a36e6b55152554993c27c949bf73` | 1 | Intermediate block tx |
| 2 | `0x2ce7283e8391664d2b42130a675a10478dee26ddeeeb5d958c168b1ea08c7c4e` | 1 | Partial DOLA -> wstUSR backrun |
| 3 | `0x3b2d4ab1e260d1314a763d446955eea1da2283fd2aff31d14cbafc9241e830d9` | 1 | Intermediate block tx |
| 4 | `0xc7d8cba4cc619e1bde71ed5fb912d19b84aa99a7cc7485b30a80942a7bb03610` | 1 | Intermediate block tx |
| 5 | `0x0906d8e68028f0241c31cac423f1f089eff853dd5e3de5fd91a40162e0cb5b65` | 1 | Intermediate block tx |
| 6 | `0x34cec7c06c5c5e66c7c3e500fca025b7c03616e3a67a4efd1e721b476fe4a572` | 1 | Partial DOLA -> wstUSR backrun |
| 7 | `0x565990e0b963a97be74ce03b8ddc222648521befebc570ba6664f669b5e0ae2a` | 1 | Partial DOLA -> wstUSR backrun; has an internal revert but outer tx succeeds |
| 8 | `0xf88b498b835279ec9de597c7360ca21b7e8803053b442a04c5fc664e04e39970` | 1 | Reference MEV bot backrun |

## DOLA/wstUSR Pool Impact

The relevant pool is:

`0x64273624eb57c5cA961d366CBF3968e760Bf0452`

Token order:

- coin 0: DOLA
- coin 1: wstUSR

Direct pool-changing swaps before the reference bot:

| Tx Index | Direction | Approx Amount |
|---:|---|---|
| 0 | wstUSR -> DOLA | `2,800 wstUSR -> 2,176.817833 DOLA` |
| 2 | DOLA -> wstUSR | `288.143346 DOLA -> 453.236322 wstUSR` |
| 6 | DOLA -> wstUSR | `290.046679 DOLA -> 416.534836 wstUSR` |
| 7 | DOLA -> wstUSR | `316.699031 DOLA -> 421.907715 wstUSR` |
| 8 | DOLA -> wstUSR | `3,537.263180 DOLA -> 3,806.514758 wstUSR` |

Interpretation:

1. Tx index 0 sells wstUSR into the DOLA/wstUSR pool and makes wstUSR cheap.
2. Tx indices 2, 6, and 7 already consume part of the price gap.
3. The reference bot at index 8 still finds enough remaining gap to profit.

## Replay Target

The accurate replay target is not simply:

`block 24710787 end state`

or:

`block 24710788 end state`

The accurate replay target is:

```text
block 24710787 end state
+ tx index 0
+ tx index 1
+ tx index 2
+ tx index 3
+ tx index 4
+ tx index 5
+ tx index 6
+ tx index 7
= tx index 8 pre-state
```

Then run our BotVM script at that pre-state.

This is why `testReplayAtForkBlockIsNotOriginalTxState` has almost no wstUSR
profit, while `testReplayWithOriginalPreState` matches the reference arb.

## Verification Commands

Check transaction order:

```bash
source .env
for h in \
  0xc52bc6f4d29a96bc18efa09708636e9d37109918d28c52d585a5f3df1609bb22 \
  0x63db40c3ff6c68b439fd036de364420b96c2a36e6b55152554993c27c949bf73 \
  0x2ce7283e8391664d2b42130a675a10478dee26ddeeeb5d958c168b1ea08c7c4e \
  0x3b2d4ab1e260d1314a763d446955eea1da2283fd2aff31d14cbafc9241e830d9 \
  0xc7d8cba4cc619e1bde71ed5fb912d19b84aa99a7cc7485b30a80942a7bb03610 \
  0x0906d8e68028f0241c31cac423f1f089eff853dd5e3de5fd91a40162e0cb5b65 \
  0x34cec7c06c5c5e66c7c3e500fca025b7c03616e3a67a4efd1e721b476fe4a572 \
  0x565990e0b963a97be74ce03b8ddc222648521befebc570ba6664f669b5e0ae2a \
  0xf88b498b835279ec9de597c7360ca21b7e8803053b442a04c5fc664e04e39970
do
  cast receipt "$h" --rpc-url "$MAINNET_RPC_URL" --json \
    | jq -r '[.transactionIndex,.transactionHash,.status] | @tsv'
done
```

Check DOLA/wstUSR pool logs for the whole block:

```bash
source .env
cast logs \
  --from-block 24710788 \
  --to-block 24710788 \
  --address 0x64273624eb57c5cA961d366CBF3968e760Bf0452 \
  --rpc-url "$MAINNET_RPC_URL"
```
