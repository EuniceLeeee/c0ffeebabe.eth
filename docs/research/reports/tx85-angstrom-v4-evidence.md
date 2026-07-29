# tx85 Angstrom V4 landed evidence

- Transaction:
  `0x85e9c8d4b8f799dca214f6057d9caea6ca9485d7d4f9ae7603a7aec3427ac8b0`
- Block / index: `25635365 / 75`
- Classification: positive closed swap loop funded by a Balancer WETH flash
  loan; no standing position remains.
- Classification net profit at the validation valuation: `1.62` USD.

## Independently recovered route

1. Angstrom's official adapter
   `0xb535aEB27335B91e1B5bcCbd64888bA7574eFBF8` executes the dynamic-fee
   Uniswap V4 PoolKey
   `(WETH, USDT, 0x800000, 10,
   0x0000000aa232009084Bd71A5797d089AA4Edfad4)`.
2. The adapter spends `791076021036708663` WETH and the executor receives
   `1506689811` USDT.
3. Uniswap V3 pool `0xc7bBeC68d12a0d1830360F8Ec58fA599bA1b0e9b`
   swaps `1506689810` USDT for `791945036544149548` WETH.
4. The Balancer flash loan repays `791076021036708663` WETH. Gross WETH
   surplus is `869015507440885` wei.

The PoolManager Swap event reports gross USDT output `1506915848`. Angstrom's
`afterSwap` fee is `226037`, so the ERC20 transfer and official hook-aware V4
Quoter both return the same net output:

```text
1506915848 - 226037 = 1506689811
```

## Identity and execution evidence

- PoolId recomputed from the full PoolKey:
  `0x90078845bceb849b171873cfbc92db8540e9c803ff57d9d21b1215ec158e79b3`.
  It equals the indexed PoolManager Swap id.
- The packed official-adapter call carries 11 EIP-712 empty-block
  attestations covering blocks `25635362..25635372`.
- The hook's controller slot resolves to ControllerV1, its `ANGSTROM()`
  reverse link resolves back to the canonical hook, and the hook's
  authoritative `_isNode` mapping for signer
  `0x2252f216f4a494a87025123425181ca1bb754fb8` is `1` at the replay anchor.
- The historical hook-aware Quoter at parent block `25635364`, using the
  attestation signed for that exact block, returns `1506689811`.

The fixture pins only the independently recovered route and trace witnesses.
Production family code must rediscover edges, quote, size, compile and simulate
the route; no realized amount is injected into sizing.

## Production instance materialization check

At source block `25635365`, the registered `custom-swap:angstrom-v4`
landed-pool materializer was given the transaction's real PoolManager `Swap`
log and an otherwise empty family inventory. Neither an `Initialize` log nor a
PoolKey was injected. Using the production PositionManager/backfill resolver,
it returned:

- `complete=true`, zero issues and zero retryable instances;
- pool adapter `angstrom-v4`;
- the exact PoolId and canonical Angstrom hook above;
- identity source `angstrom-v4-hook-poolkey`; and
- both WETH→USDT and USDT→WETH `angstrom-v4-swap` edges.

This proves family-owned instance discovery and edge construction for the real
sample. It does not relabel the route-pinned Adapter Replay's steps 1–2 as
passed; natural full-graph route enumeration remains a separate
`production_route_stage` check.
