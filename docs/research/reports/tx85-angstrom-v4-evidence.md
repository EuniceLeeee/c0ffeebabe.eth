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

## Target-blind full-graph checkpoint

The development checkpoint used parent block `25635364` and a complete
content-addressed candidate universe built without a target route, pool or
amount:

- universe SHA-256:
  `1fb28d2b57529a5e1457c0f5166e6d4fe5a313a6446ecd4f9cace2d8bbc0cdf8`;
- pending-execution-evidence SHA-256:
  `b8469d7f7eb234e4f3ab9704fae8efdd7e1aa5e41abb8a5ee4d36b3774c8fd52`;
- unrelated protocol-shard marker SHA-256:
  `beffa3da757a4645dd8b6c14ca08e084149d624b264206baa401fa4483807eaa`;
- candidate code SHA:
  `53b6ce700603cedb8c3bbd5e686bad77a6233d75`.
- node-local semantic log SHA-256:
  `9f9f70dd90f6fbd220fc5fb3645db9e3a57f67ebdf1e437930aa72887ae2dc4b`
  (six ordered `SEMANTIC_SIX_STEP_EVIDENCE` records).
- node-local full hunt report SHA-256:
  `2e8e3fd59e318b69f2e42d7b13d93819c6789ca74675267fe67d5853edd4d8bc`
  (`ev_positive_found`, 300 retained opportunities, 27 solved).

A first run with no `AB_EXPECTED_*` input naturally enumerated the target
PoolId plus the UniV3 return pool at refined rank 27. The semantic run then
rebuilt the same full graph and froze its natural route set before using the
landed route as an output comparator. It emitted:

| Step | Result | Bound output |
|---|---|---|
| 1 discovery/admission/graph | pass | 30,932 edges; edge-set SHA `19f5280ba58368a50cc171065ffd92242ce7663e906ca69b992060dfcbc9f5d3`; four `custom-swap:angstrom-v4` edges; target membership present; required Angstrom and UniV3 shards complete |
| 2 route enumeration | pass | 1,287 natural coarse routes; route-set SHA `f14c2c6401f20f7da9fd9e028d7ef6ff9ee138ea90067efa35de224a4b456b6f`; target present at coarse rank 59 |
| 3 exact quote/refine | pass | target refined rank 27; probe `2249430444741851` WETH returned `2250489926561685` WETH; route SHA `ac065e0be8b2570a95a7d62dfb83e2f03325d542a847bcd75379e2bdd00ad733` |
| 4 plan/size | pass | solver selected `647592015151193554` WETH; plan SHA `a281be03fbfacd44dedec671925ca66f1a323170a3588408b0dcd792b1cacb66` |
| 5 fork final sim | pass | profit `154762303487137` WETH wei; gas `374076`; repayment/conservation true; no standing position |
| 6 production EV | pass | `allow`; net EV `52917226277367` wei; parent hash `0x70170e1d5fd98684d48596555e22f57a12e94fa4d689f99e6cdebb9a1bace189` |

The output comparator did not participate in graph construction, enumeration,
ranking, refinement selection or sizing. No realized amount was supplied.
Development-only outer budgets and candidate limits were widened, so this is
the agreed lightweight semantic checkpoint rather than a claim of production
latency or a canonical `checkpoint_pass`.

## Bugs found by the checkpoint

The checkpoint found and closed four production defects rather than weakening
the sample:

1. `loadPoolUniverse()` discarded `logicalInstanceId`, causing two Angstrom
   PoolIds behind the singleton PoolManager to collide. The parser now
   preserves the logical instance and has a same-target/two-instance
   regression.
2. A valid old-block Angstrom signature could activate a current-head pass.
   Current-head evidence is now required before authority reads.
3. Family isolation only examined the capped visible view, allowing a hidden
   same-family pool to replace the quarantined row. Isolation now derives exact
   keys from the complete uncapped inventory.
4. Angstrom edges omitted PoolKey token order. They now publish
   `poolToken0/poolToken1`, which the shared swap-observation path needs for
   direction decoding.

The legacy protocol-oriented production-replay wrapper still cannot certify a
pure swap-only route without rebuilding unrelated protocol history. That
architecture-specific harness limitation was not changed to make this sample
pass. Post-merge deployed-main validation remains required before deleting the
feature branch.
