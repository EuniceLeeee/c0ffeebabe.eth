import assert from "node:assert/strict";
import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import type { TokenEdge } from "../planner/token-graph.js";
import {
  diagnoseResolvedRingScore,
  scanBlockStateFromResolvedMids,
} from "../detector/blockscan-scanner-core.js";
import {
  BLOCKSCAN_MIN_EXECUTABLE_INPUT,
  BLOCKSCAN_MIN_VENUE_RESERVE_IN,
} from "../detector/blockscan-sizing-constants.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";
import type { RouteVenueMid } from "../venues/mid-readers.js";
import {
  assertPureSynchronousDeriveMids,
  blockScanEdgeKey,
  createAmbientIoPoisonHarness,
  stateSchemaFingerprint,
  type BlockScanStateCapability,
  type StateRead,
  type StateReadResult,
  type StateReadSuccess,
} from "../venues/blockscan-state-capability.js";
import {
} from "../venues/swaps/balancer-v3.js";
import {
  ANGSTROM_MAINNET_HOOK,
} from "../venues/swaps/angstrom-attestation.js";
import { angstromV4Adapter } from "../venues/swaps/angstrom-v4.js";
import {
  BLOCKSCAN_MULTICALL3,
  blockScanErc20Iface,
  blockScanMulticallIface,
  currentBlockRead,
  q96PrecisionProbeAmount,
} from "../venues/swaps/blockscan-state-shared.js";
import {
  createCurrentBlockViewQuoteCapability,
  factoryOwnedDeriveMidsPurityCase,
} from "../venues/swaps/view-quote-blockscan-state.js";
import {
} from "../venues/swaps/curve-plain.js";
import {
  curveUnderlyingBlockScanState,
  curveUnderlyingAdapter,
} from "../venues/swaps/curve-underlying.js";
import { CURVE_METAREGISTRY } from "../venues/curve-underlying.js";
import {
  dodoV2BlockScanState,
  dodoV2PoolIface,
  dodoV2Adapter,
} from "../venues/swaps/dodo-v2.js";
import {
  fluidDexBlockScanState,
  fluidDexResolverIface,
  fluidDexSwapIface,
  fluidDexAdapter,
  quoteFluidDex,
} from "../venues/swaps/fluid-dex.js";
import {
  univ2BlockScanState,
  univ2StandardAdapter,
} from "../venues/swaps/univ2-standard.js";
import {
  univ3BlockScanState,
  univ3StandardAdapter,
} from "../venues/swaps/univ3-standard.js";
import {
  univ4BlockScanState,
  univ4Adapter,
} from "../venues/swaps/univ4.js";
import { v4PoolId } from "../venues/swaps/univ4-common.js";
import { TRUSTED_V2_LINEAGES } from "../venues/v2-lineage.js";
import { PRODUCTION_ADAPTER_FAMILIES } from "../venues/production-registry.js";

const SOURCE_BLOCK = 22_000_000;
const SOURCE_HASH = `0x${"ab".repeat(32)}`;
const POOL = "0x1111111111111111111111111111111111111111";
const TOKEN0 = "0x2222222222222222222222222222222222222222";
const TOKEN1 = "0x3333333333333333333333333333333333333333";
const TOKEN2 = "0x4444444444444444444444444444444444444444";
const UNIV3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const PANCAKE_V3_FACTORY = "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865";
const UNKNOWN_V3_FACTORY = "0x6666666666666666666666666666666666666666";
const UNIV3_QUOTER_V2 = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
const PANCAKE_V3_QUOTER_V2 = "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997";
const Q96 = 1n << 96n;
const UNIT = 10n ** 18n;
const taxonomy = deriveEdgeTaxonomy("swap");

const v2Iface = new ethers.Interface([
  "function getReserves() view returns (uint112 reserve0,uint112 reserve1,uint32 blockTimestampLast)",
  "function factory() view returns (address)",
]);
const v3Iface = new ethers.Interface([
  "function factory() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
  "function liquidity() view returns (uint128)",
  "function fee() view returns (uint24)",
]);
const v3FactoryIface = new ethers.Interface([
  "function getPool(address tokenA,address tokenB,uint24 fee) view returns (address)",
]);
const v3QuoterIface = new ethers.Interface([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);
const v4StateIface = new ethers.Interface([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
]);
const v4QuoterIface = new ethers.Interface([
  "function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)",
]);
const curveStateIface = new ethers.Interface([
  "function A() view returns (uint256)",
  "function fee() view returns (uint256)",
  "function offpeg_fee_multiplier() view returns (uint256)",
  "function balances(uint256 i) view returns (uint256)",
  "function stored_rates() view returns (uint256[])",
]);
const curveIntBalanceIface = new ethers.Interface([
  "function balances(int128 i) view returns (uint256)",
]);
const curveUnderlyingIface = new ethers.Interface([
  "function get_dy_underlying(int128 i,int128 j,uint256 dx) view returns (uint256)",
]);
const curveIntQuoteIface = new ethers.Interface([
  "function get_dy(int128 i,int128 j,uint256 dx) view returns (uint256)",
]);
const curveUintQuoteIface = new ethers.Interface([
  "function get_dy(uint256 i,uint256 j,uint256 dx) view returns (uint256)",
]);
const curveMetaRegistryStateIface = new ethers.Interface([
  "function get_underlying_decimals(address pool) view returns (uint256[8])",
  "function get_underlying_balances(address pool) view returns (uint256[8])",
]);
const balancerIface = new ethers.Interface([
  "function getPoolTokenInfo(address pool) view returns (address[] tokens,tuple(uint8 tokenType,address rateProvider,bool paysYieldFees)[] tokenInfo,uint256[] balancesRaw,uint256[] lastBalancesLiveScaled18)",
  "function querySwapSingleTokenExactIn(address pool,address tokenIn,address tokenOut,uint256 exactAmountIn,address sender,bytes userData) returns (uint256 amountOut)",
]);
const dodoBalanceIface = new ethers.Interface([
  "function balanceOf(address account) view returns (uint256)",
]);
const pureFixtureFamilyIds = new Set<string>();

await runUniV2();
runConcentratedLiquidityPrecisionBoundary();
await runUniV3();
await runUniV3ExtremePrice();
await runUniV3FactoryBoundPrecision();
await runUniV3FactoryBoundQuotes();
await runUniV4();
await runAngstromV4();
await runUniV4ExtremePrice();
await runUniV4DirectionIsolation();
await runInactiveUniPools();
await runMalformedUniState();
await runCurveUnderlying();
await runDodoV2();
await runFluidDex();
await runViewQuoteDecodeAmountBinding();
runViewQuoteFactoryStateKeyCaptureBoundary();

function runConcentratedLiquidityPrecisionBoundary(): void {
  const edges = twoTokenEdges("univ3-swap").map((edge) => ({
    ...edge,
    factory: UNIV3_FACTORY,
  }));
  for (let reserve = 1n; reserve < BLOCKSCAN_MIN_VENUE_RESERVE_IN; reserve++) {
    for (const edge of edges) {
      assert.equal(
        q96PrecisionProbeAmount({
          sqrtPriceX96: Q96,
          liquidity: reserve,
          token0: TOKEN0,
          token1: TOKEN1,
          edge,
          maxAmountIn: 1n << 255n,
        }),
        BLOCKSCAN_MIN_EXECUTABLE_INPUT,
        `virtual reserve ${reserve} must use exact precision before scanner sizing`,
      );
    }
  }
  for (const edge of edges) {
    assert.equal(
      q96PrecisionProbeAmount({
        sqrtPriceX96: Q96,
        liquidity: BLOCKSCAN_MIN_VENUE_RESERVE_IN,
        token0: TOKEN0,
        token1: TOKEN1,
        edge,
        maxAmountIn: 1n << 255n,
      }),
      null,
      "virtual reserve 36 has the scanner's first executable ordinary ceiling",
    );
  }
  const asymmetricEdges = edges.map((edge) => ({ ...edge }));
  const asymmetricAmounts = asymmetricEdges.map((edge) =>
    q96PrecisionProbeAmount({
      sqrtPriceX96: 36n * Q96,
      liquidity: 36n,
      token0: TOKEN0,
      token1: TOKEN1,
      edge,
      maxAmountIn: 1n << 255n,
    })
  );
  assert.deepEqual(
    asymmetricAmounts,
    [BLOCKSCAN_MIN_EXECUTABLE_INPUT, 324n],
    "V3/V4 shared precision requires a witness when either directed side is 1..35",
  );
}
const pureCoveredFamilyIds = new Set(pureFixtureFamilyIds);
for (const family of PRODUCTION_ADAPTER_FAMILIES.pricing("swap")) {
  const factoryCase = factoryOwnedDeriveMidsPurityCase(family.pricingState);
  if (!factoryCase) continue;
  const purity = assertPureSynchronousDeriveMids({
    capability: family.pricingState,
    snapshot: factoryCase.snapshot,
    edges: factoryCase.edges,
    harness: createAmbientIoPoisonHarness(),
  });
  assert(
    purity.edgeKeys.length > 0,
    `${family.id}: factory purity case must exercise a non-empty mid`,
  );
  pureCoveredFamilyIds.add(family.id);
}
assert.deepEqual(
  [...pureCoveredFamilyIds].sort(),
  PRODUCTION_ADAPTER_FAMILIES.pricing("swap").map((family) => family.id).sort(),
  "every production swap pricing family requires one passing purity fixture",
);

console.log("[swap-blockscan-state-capabilities] current-N + pure derive: PASS");

async function runViewQuoteDecodeAmountBinding(): Promise<void> {
  const quoteAmount = 12_345n;
  let decodedAmount: bigint | null = null;
  const capability =
    createCurrentBlockViewQuoteCapability<Record<string, never>>({
      kind: "external-swap",
      edgeAdapterIds: new Set(["fixture-view-quote"]),
      compileGroup: () => Object.freeze({}),
      quoteAmountIn: () => quoteAmount,
      quoteRead(ctx) {
        return currentBlockRead({
          id: `fixture-view-quote:${ctx.amountIn}`,
          sourceBlock: ctx.sourceBlock,
          sourceBlockHash: ctx.sourceBlockHash,
          to: ctx.edge.target,
          data: ethers.AbiCoder.defaultAbiCoder().encode(
            ["uint256"],
            [ctx.amountIn],
          ),
        });
      },
      decodeQuote(_edge, data, amountIn) {
        decodedAmount = amountIn;
        assert.equal(
          BigInt(
            ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], data)[0],
          ),
          amountIn,
          "decodeQuote amount must match the exact amount encoded in quoteRead",
        );
        return amountIn * 2n;
      },
    });
  const edge = twoTokenEdges("fixture-view-quote")[0];
  const result = await execute(
    "fixture-view-quote",
    capability,
    [edge],
    (read) =>
      read.id.startsWith("static-decimals:")
        ? blockScanErc20Iface.encodeFunctionResult("decimals", [18])
        : read.data,
    { recordProductionFixture: false },
  );
  assert.equal(
    decodedAmount,
    quoteAmount,
    "view-quote decoder receives the selected executable probe amount",
  );
  assert.equal(
    result.mids.get(blockScanEdgeKey(edge))?.mid,
    2,
    "the mid is derived from that same selected amount",
  );
}

function runViewQuoteFactoryStateKeyCaptureBoundary(): void {
  let getterReads = 0;
  let customStateKeyCalls = 0;
  const config = {
    kind: "external-swap" as const,
    edgeAdapterIds: new Set(["fixture-custom-state-key"]),
    compileGroup: () => Object.freeze({}),
    quoteRead(): never {
      throw new Error("state-key capture fixture must not build reads");
    },
    decodeQuote: () => 1n,
  };
  Object.defineProperty(config, "stateKey", {
    configurable: false,
    enumerable: true,
    get() {
      getterReads += 1;
      return () => {
        customStateKeyCalls += 1;
        return "family-custom-state-key";
      };
    },
  });
  const capability = createCurrentBlockViewQuoteCapability(config);
  assert.equal(getterReads, 1, "view-quote stateKey config is captured once");
  assert.equal(
    factoryOwnedDeriveMidsPurityCase(capability),
    null,
    "custom stateKey capability requires its own family purity fixture",
  );
  capability.stateKey(twoTokenEdges("fixture-custom-state-key")[0]);
  assert.equal(customStateKeyCalls, 1);
}

async function runUniV2(): Promise<void> {
  const edges = twoTokenEdges("univ2-swap");
  const result = await execute(univ2StandardAdapter.id, univ2BlockScanState, edges, (read) => {
    const selector = read.data.slice(0, 10);
    if (selector === v2Iface.getFunction("getReserves")!.selector) {
      return v2Iface.encodeFunctionResult("getReserves", [
        1_000n * UNIT,
        2_000n * UNIT,
        1,
      ]);
    }
    if (selector === v2Iface.getFunction("factory")!.selector) {
      return v2Iface.encodeFunctionResult("factory", [
        TRUSTED_V2_LINEAGES[0].factory,
      ]);
    }
    throw new Error(`unexpected v2 read ${read.id}`);
  });
  assert.equal(result.mids.get(blockScanEdgeKey(edges[0]))?.mid, 2);
  assert.equal(result.mids.get(blockScanEdgeKey(edges[1]))?.mid, 0.5);
  assert.equal(result.initialReads.length, 1);
  assert.equal(result.snapshot.blockTimestampLast, 1);
}

async function runUniV3(): Promise<void> {
  const builtEdges = await univ3StandardAdapter.buildEdges(
    {
      address: POOL,
      adapter: "univ3",
      token0: TOKEN0,
      token1: TOKEN1,
      fee: 3_000,
      tickSpacing: 60,
      factory: UNIV3_FACTORY,
    },
    {
      call: async () => {
        throw new Error("fully attested V3 edge construction must not call");
      },
    },
  );
  assert(
    builtEdges.every((edge) => edge.factory === UNIV3_FACTORY),
    "V3 edges retain reverse-attested factory provenance for pricing",
  );
  const edges = twoTokenEdges("univ3-swap").map((edge) => ({
    ...edge,
    factory: UNIV3_FACTORY,
  }));
  const result = await execute(univ3StandardAdapter.id, univ3BlockScanState, edges, (read) => {
    const binding = maybeV3PoolBindingRead(read);
    if (binding !== null) return binding;
    const selector = read.data.slice(0, 10);
    if (selector === v3Iface.getFunction("slot0")!.selector) {
      return v3Iface.encodeFunctionResult("slot0", [
        2n * Q96,
        0,
        0,
        1,
        1,
        0,
        true,
      ]);
    }
    if (selector === v3Iface.getFunction("liquidity")!.selector) {
      return v3Iface.encodeFunctionResult("liquidity", [1_000n * UNIT]);
    }
    if (selector === v3Iface.getFunction("fee")!.selector) {
      return v3Iface.encodeFunctionResult("fee", [3_000]);
    }
    throw new Error(`unexpected v3 read ${read.id}`);
  });
  assert.equal(result.mids.get(blockScanEdgeKey(edges[0]))?.mid, 4);
  assert.equal(result.mids.get(blockScanEdgeKey(edges[1]))?.mid, 0.25);
  assert.equal(result.staticReads.length, 1);
  assert.equal(result.initialReads.length, 2);
  assert.equal(result.snapshot.tickSpacing, 60);
  assert.equal(result.snapshot.observationCardinality, 1);
  assert.equal(result.snapshot.unlocked, true);
}

async function runUniV3ExtremePrice(): Promise<void> {
  // Mainnet 0x616c... at source block 25,610,261. The token0 virtual
  // reserve is below one wei, so floor division used to erase both edges.
  const sqrtPriceX96 =
    104900925875096973426354586331491637011052178n;
  const liquidity = 98_607n;
  const edges = twoTokenEdges("univ3-swap").map((edge) => ({
    ...edge,
    factory: UNIV3_FACTORY,
  }));
  const result = await execute(
    univ3StandardAdapter.id,
    univ3BlockScanState,
    edges,
    (read) => {
      const binding = maybeV3PoolBindingRead(read);
      if (binding !== null) return binding;
      const selector = read.data.slice(0, 10);
      if (selector === v3Iface.getFunction("slot0")!.selector) {
        return v3Iface.encodeFunctionResult("slot0", [
          sqrtPriceX96,
          696_424,
          0,
          2,
          2,
          102,
          true,
        ]);
      }
      if (selector === v3Iface.getFunction("liquidity")!.selector) {
        return v3Iface.encodeFunctionResult("liquidity", [liquidity]);
      }
      if (selector === blockScanMulticallIface.getFunction("aggregate3")!.selector) {
        return respondAggregate(read, ({ callData }) => {
          const quote = v3QuoterIface.decodeFunctionData(
            "quoteExactInputSingle",
            callData,
          )[0];
          const direct =
            String(quote.tokenIn).toLowerCase() === TOKEN0.toLowerCase();
          assert.equal(
            BigInt(quote.amountIn),
            direct ? 9n : 32_639_800_260_113_778_162n,
            `extreme V3 ${direct ? "direct" : "reverse"} scanner ceiling`,
          );
          return successInner(v3QuoterIface.encodeFunctionResult(
            "quoteExactInputSingle",
            [
              direct ? 130_546_280_204_193_357_693n : 0n,
              sqrtPriceX96,
              0,
              100_000,
            ],
          ));
        });
      }
      throw new Error(`unexpected extreme-v3 read ${read.id}`);
    },
    { recordProductionFixture: false },
  );
  const direct = result.mids.get(blockScanEdgeKey(edges[0]));
  const reverse = result.mids.get(blockScanEdgeKey(edges[1]));
  assert(direct, "executable extreme V3 direction remains available");
  assert.equal(
    reverse,
    undefined,
    "zero-output extreme V3 direction does not publish a phantom mid",
  );
  assert.match(
    result.unavailable.get(blockScanEdgeKey(edges[1])) ?? "",
    /returned zero.*scanner ceiling/,
  );
  const reserve0Floor = liquidity * Q96 / sqrtPriceX96;
  const reserve1Floor = liquidity * sqrtPriceX96 / Q96;
  assert.equal(reserve0Floor, 0n, "source fixture exercises sub-wei virtual reserve");
  assert.equal(direct.reserveA, 36n);
  assert.equal(direct.reserveB, 522_185_120_816_773_430_772n);
  assert(Number.isFinite(direct.mid) && direct.mid > 0);
  assert.equal(reserve1Floor, 130_559_201_040_455_112_650n);
  assertExtremeDirectionScans(edges, result.mids, "v3");
}

async function runUniV3FactoryBoundPrecision(): Promise<void> {
  const sqrtPriceX96 = 36n * Q96;
  const liquidity = 36n;
  const canonicalEdges = twoTokenEdges("univ3-swap").map((edge) => ({
    ...edge,
    factory: UNIV3_FACTORY,
  }));
  assert.notEqual(
    stateSchemaFingerprint(canonicalEdges),
    stateSchemaFingerprint(canonicalEdges.map((edge) => ({
      ...edge,
      factory: PANCAKE_V3_FACTORY,
    }))),
    "factory-bound precision metadata invalidates the static schema cache",
  );
  const canonical = await execute(
    univ3StandardAdapter.id,
    univ3BlockScanState,
    canonicalEdges,
    (read) => {
      const binding = maybeV3PoolBindingRead(read);
      if (binding !== null) return binding;
      const selector = read.data.slice(0, 10);
      if (selector === v3Iface.getFunction("slot0")!.selector) {
        return v3Iface.encodeFunctionResult("slot0", [
          sqrtPriceX96,
          0,
          0,
          1,
          1,
          0,
          true,
        ]);
      }
      if (selector === v3Iface.getFunction("liquidity")!.selector) {
        return v3Iface.encodeFunctionResult("liquidity", [liquidity]);
      }
      if (selector === blockScanMulticallIface.getFunction("aggregate3")!.selector) {
        return respondAggregate(read, ({ target, callData }) => {
          assert.equal(
            target.toLowerCase(),
            UNIV3_QUOTER_V2.toLowerCase(),
            "canonical V3 precision witness must use its factory-bound quoter",
          );
          const quote = v3QuoterIface.decodeFunctionData(
            "quoteExactInputSingle",
            callData,
          )[0];
          const direct =
            String(quote.tokenIn).toLowerCase() === TOKEN0.toLowerCase();
          assert.equal(
            BigInt(quote.amountIn),
            direct ? BLOCKSCAN_MIN_EXECUTABLE_INPUT : 324n,
          );
          return direct
            ? successInner(v3QuoterIface.encodeFunctionResult(
                "quoteExactInputSingle",
                [100n, sqrtPriceX96, 0, 100_000],
              ))
            : Object.freeze({ success: false, returnData: "0x" });
        });
      }
      throw new Error(`unexpected factory-bound V3 read ${read.id}`);
    },
    { recordProductionFixture: false },
  );
  assert(
    canonical.mids.has(blockScanEdgeKey(canonicalEdges[0])),
    "one successful precision direction remains published",
  );
  assert.equal(
    canonical.mids.has(blockScanEdgeKey(canonicalEdges[1])),
    false,
    "a failed sibling precision direction remains fail-closed",
  );
  assert.match(
    canonical.unavailable.get(blockScanEdgeKey(canonicalEdges[1])) ?? "",
    /factory-bound.*quote call reverted/,
  );

  const pancakeEdges = twoTokenEdges("univ3-swap").map((edge) => ({
    ...edge,
    factory: PANCAKE_V3_FACTORY,
  }));
  const pancake = await execute(
    univ3StandardAdapter.id,
    univ3BlockScanState,
    pancakeEdges,
    (read) => {
      const binding = maybeV3PoolBindingRead(read, {
        factory: PANCAKE_V3_FACTORY,
      });
      if (binding !== null) return binding;
      const selector = read.data.slice(0, 10);
      if (selector === v3Iface.getFunction("slot0")!.selector) {
        return v3Iface.encodeFunctionResult("slot0", [
          sqrtPriceX96,
          0,
          0,
          1,
          1,
          0,
          true,
        ]);
      }
      if (selector === v3Iface.getFunction("liquidity")!.selector) {
        return v3Iface.encodeFunctionResult("liquidity", [liquidity]);
      }
      if (selector === blockScanMulticallIface.getFunction("aggregate3")!.selector) {
        return respondAggregate(read, ({ target, callData }) => {
          assert.equal(
            target.toLowerCase(),
            PANCAKE_V3_QUOTER_V2.toLowerCase(),
            "Pancake precision must use the Pancake factory-bound quoter",
          );
          const quote = v3QuoterIface.decodeFunctionData(
            "quoteExactInputSingle",
            callData,
          )[0];
          const direct =
            String(quote.tokenIn).toLowerCase() === TOKEN0.toLowerCase();
          return successInner(v3QuoterIface.encodeFunctionResult(
            "quoteExactInputSingle",
            [direct ? 100n : 0n, sqrtPriceX96, 0, 100_000],
          ));
        });
      }
      throw new Error(`unexpected Pancake factory-bound V3 read ${read.id}`);
    },
    { recordProductionFixture: false },
  );
  assert.equal(pancake.dependentReads.length, 2);
  assert(pancake.mids.has(blockScanEdgeKey(pancakeEdges[0])));
  assert.equal(pancake.mids.has(blockScanEdgeKey(pancakeEdges[1])), false);

  for (const factory of [UNKNOWN_V3_FACTORY]) {
    const edges = twoTokenEdges("univ3-swap").map((edge) => ({
      ...edge,
      factory,
    }));
    const result = await execute(
      univ3StandardAdapter.id,
      univ3BlockScanState,
      edges,
      (read) => {
        const selector = read.data.slice(0, 10);
        if (selector === v3Iface.getFunction("slot0")!.selector) {
          return v3Iface.encodeFunctionResult("slot0", [
            sqrtPriceX96,
            0,
            0,
            1,
            1,
            0,
            true,
          ]);
        }
        if (selector === v3Iface.getFunction("liquidity")!.selector) {
          return v3Iface.encodeFunctionResult("liquidity", [liquidity]);
        }
        throw new Error(
          `non-Uniswap factory must not schedule QuoterV2 read ${read.id}`,
        );
      },
      { recordProductionFixture: false },
    );
    assert.equal(
      result.dependentReads.length,
      0,
      `${factory} cannot reuse the Uniswap QuoterV2 precision witness`,
    );
    assert.equal(result.mids.size, 0);
    assert.equal(result.unavailable.size, edges.length);
    for (const reason of result.unavailable.values()) {
      assert.match(reason, /has no registered witness/);
    }

    const ordinary = await execute(
      univ3StandardAdapter.id,
      univ3BlockScanState,
      edges,
      (read) => {
        const selector = read.data.slice(0, 10);
        if (selector === v3Iface.getFunction("slot0")!.selector) {
          return v3Iface.encodeFunctionResult("slot0", [
            Q96,
            0,
            0,
            1,
            1,
            0,
            true,
          ]);
        }
        if (selector === v3Iface.getFunction("liquidity")!.selector) {
          return v3Iface.encodeFunctionResult("liquidity", [UNIT]);
        }
        throw new Error(
          `ordinary provisional V3 must not call a lineage Quoter ${read.id}`,
        );
      },
      { recordProductionFixture: false },
    );
    assert.equal(
      ordinary.mids.size,
      edges.length,
      "a behavior-admitted provisional pool keeps target-specific local mids",
    );
    assert.equal(ordinary.unavailable.size, 0);
  }

  const reverseMismatchedPool =
    "0x9999999999999999999999999999999999999999";
  const reverseMismatchedEdges = canonicalEdges.map((edge) => ({
    ...edge,
    target: reverseMismatchedPool,
  }));
  const mismatched = await execute(
    univ3StandardAdapter.id,
    univ3BlockScanState,
    reverseMismatchedEdges,
    (read) => {
      const binding = maybeV3PoolBindingRead(read, {
        pool: reverseMismatchedPool,
        boundPool: POOL,
      });
      if (binding !== null) return binding;
      const selector = read.data.slice(0, 10);
      if (selector === v3Iface.getFunction("slot0")!.selector) {
        return v3Iface.encodeFunctionResult("slot0", [
          sqrtPriceX96,
          0,
          0,
          1,
          1,
          0,
          true,
        ]);
      }
      if (selector === v3Iface.getFunction("liquidity")!.selector) {
        return v3Iface.encodeFunctionResult("liquidity", [liquidity]);
      }
      throw new Error(
        `reverse-mismatched V3 pool must not schedule precision read ${read.id}`,
      );
    },
    { recordProductionFixture: false },
  );
  assert.equal(mismatched.dependentReads.length, 0);
  assert.equal(mismatched.mids.size, 0);
  assert.equal(mismatched.unavailable.size, reverseMismatchedEdges.length);
  for (const reason of mismatched.unavailable.values()) {
    assert.match(reason, /binds .* not target/);
  }
}

async function runUniV3FactoryBoundQuotes(): Promise<void> {
  const quoteResult = v3QuoterIface.encodeFunctionResult(
    "quoteExactInputSingle",
    [123n, Q96, 0, 100_000],
  );
  const exactCalls: string[] = [];
  const exactAmount = await univ3StandardAdapter.quoteExact({
    state: {
      call: async ({ to, data }: { to: string; data: string }) => {
        exactCalls.push(to.toLowerCase());
        const binding = maybeV3PoolBindingRead({ to, data });
        if (binding !== null) return binding;
        const selector = data.slice(0, 10);
        if (
          to.toLowerCase() === UNIV3_QUOTER_V2.toLowerCase() &&
          selector === v3QuoterIface.getFunction("quoteExactInputSingle")!.selector
        ) {
          return quoteResult;
        }
        throw new Error(`unexpected canonical exact V3 call ${to}:${selector}`);
      },
    } as never,
    target: POOL,
    edgeAdapterId: "univ3-swap",
    tokenIn: TOKEN0,
    tokenOut: TOKEN1,
    amountIn: UNIT,
  });
  assert.equal(exactAmount, 123n);
  assert(exactCalls.includes(UNIV3_QUOTER_V2.toLowerCase()));

  const pancakePool = "0x7777777777777777777777777777777777777777";
  let crossFactoryExactCall = false;
  const pancakeExact = await univ3StandardAdapter.quoteExact({
    state: {
      call: async ({ to, data }: { to: string; data: string }) => {
        const binding = maybeV3PoolBindingRead(
          { to, data },
          { pool: pancakePool, factory: PANCAKE_V3_FACTORY },
        );
        if (binding !== null) return binding;
        const selector = data.slice(0, 10);
        if (to.toLowerCase() === UNIV3_QUOTER_V2.toLowerCase()) {
          crossFactoryExactCall = true;
          throw new Error("cross-factory Uniswap quoter call");
        }
        if (to.toLowerCase() === PANCAKE_V3_QUOTER_V2.toLowerCase()) {
          return quoteResult;
        }
        throw new Error(`unexpected Pancake exact V3 call ${to}:${selector}`);
      },
    } as never,
    target: pancakePool,
    edgeAdapterId: "univ3-swap",
    tokenIn: TOKEN0,
    tokenOut: TOKEN1,
    amountIn: UNIT,
  });
  assert.equal(pancakeExact, 123n);
  assert.equal(crossFactoryExactCall, false);

  const unknownPool = "0x8888888888888888888888888888888888888888";
  await assert.rejects(
    univ3StandardAdapter.quoteExact({
      state: {
        call: async ({ to, data }: { to: string; data: string }) => {
          assert.notEqual(to.toLowerCase(), UNIV3_QUOTER_V2.toLowerCase());
          assert.notEqual(to.toLowerCase(), PANCAKE_V3_QUOTER_V2.toLowerCase());
          const binding = maybeV3PoolBindingRead(
            { to, data },
            { pool: unknownPool, factory: UNKNOWN_V3_FACTORY },
          );
          if (binding !== null) return binding;
          throw new Error(`unexpected unknown-factory exact call ${to}`);
        },
      } as never,
      target: unknownPool,
      edgeAdapterId: "univ3-swap",
      tokenIn: TOKEN0,
      tokenOut: TOKEN1,
      amountIn: UNIT,
    }),
    /no registered factory-bound quoter/,
  );

  const mismatchedPool = "0x9999999999999999999999999999999999999999";
  let mismatchedQuoterCalled = false;
  await assert.rejects(
    univ3StandardAdapter.quoteExact({
      state: {
        call: async ({ to, data }: { to: string; data: string }) => {
          const binding = maybeV3PoolBindingRead(
            { to, data },
            {
              pool: mismatchedPool,
              boundPool: POOL,
            },
          );
          if (binding !== null) return binding;
          if (to.toLowerCase() === UNIV3_QUOTER_V2.toLowerCase()) {
            mismatchedQuoterCalled = true;
          }
          throw new Error(`unexpected reverse-mismatch exact call ${to}`);
        },
      } as never,
      target: mismatchedPool,
      edgeAdapterId: "univ3-swap",
      tokenIn: TOKEN0,
      tokenOut: TOKEN1,
      amountIn: UNIT,
    }),
    /binds .* not target/,
  );
  assert.equal(
    mismatchedQuoterCalled,
    false,
    "reverse-mismatched V3 target must fail before canonical quoter use",
  );

  for (const target of [pancakePool, unknownPool]) {
    const local = await univ3StandardAdapter.quoteExact({
      state: {
        call: async () => {
          throw new Error("successful local V3 quote must not reverse-read factory");
        },
      } as never,
      target,
      edgeAdapterId: "univ3-swap",
      tokenIn: TOKEN0,
      tokenOut: TOKEN1,
      amountIn: UNIT,
      cache: {
        quoteV3: async () => 777n,
      } as never,
    });
    assert.equal(local, 777n, "successful local quote remains factory-agnostic");
  }

  const prepared = univ3StandardAdapter.prepared;
  const preparedContext = {
    request: {
      adapterId: "univ3-swap",
      target: POOL,
      tokenIn: TOKEN0,
      tokenOut: TOKEN1,
      amountIn: UNIT,
    },
    readChain: async ({ to, data }: { to: string; data: string }) => {
      const binding = maybeV3PoolBindingRead({ to, data });
      if (binding !== null) return binding;
      throw new Error(`unexpected prepared V3 read ${to}:${data.slice(0, 10)}`);
    },
    callPrepared: async (to: string) => {
      assert.equal(to.toLowerCase(), UNIV3_QUOTER_V2.toLowerCase());
      return { output: quoteResult, latencyMs: 1 };
    },
  };
  const prewarm = await prepared.encodeQuotePrewarm(preparedContext);
  assert.equal(prewarm[0].to.toLowerCase(), UNIV3_QUOTER_V2.toLowerCase());
  assert.equal((await prepared.quote(preparedContext)).amountOut, 123n);

  const pancakePreparedContext = {
    ...preparedContext,
    request: { ...preparedContext.request, target: pancakePool },
    readChain: async ({ to, data }: { to: string; data: string }) => {
      const binding = maybeV3PoolBindingRead(
        { to, data },
        { pool: pancakePool, factory: PANCAKE_V3_FACTORY },
      );
      if (binding !== null) return binding;
      throw new Error(`unexpected Pancake prepared read ${to}:${data.slice(0, 10)}`);
    },
    callPrepared: async (to: string) => {
      assert.equal(to.toLowerCase(), PANCAKE_V3_QUOTER_V2.toLowerCase());
      return { output: quoteResult, latencyMs: 1 };
    },
  };
  const pancakePrewarm = await prepared.encodeQuotePrewarm(
    pancakePreparedContext,
  );
  assert.equal(
    pancakePrewarm[0].to.toLowerCase(),
    PANCAKE_V3_QUOTER_V2.toLowerCase(),
  );
  assert.equal(
    (await prepared.quote(pancakePreparedContext)).amountOut,
    123n,
  );

  let unsupportedPreparedCall = false;
  const unsupportedContext = {
    ...preparedContext,
    request: { ...preparedContext.request, target: unknownPool },
    readChain: async ({ to, data }: { to: string; data: string }) => {
      const binding = maybeV3PoolBindingRead(
        { to, data },
        { pool: unknownPool, factory: UNKNOWN_V3_FACTORY },
      );
      if (binding !== null) return binding;
      throw new Error(`unexpected unsupported prepared read ${to}:${data.slice(0, 10)}`);
    },
    callPrepared: async () => {
      unsupportedPreparedCall = true;
      throw new Error("unsupported factory must not call a prepared quoter");
    },
  };
  await assert.rejects(
    prepared.quote(unsupportedContext),
    /no registered factory-bound quoter/,
  );
  await assert.rejects(
    prepared.encodeQuotePrewarm(unsupportedContext),
    /no registered factory-bound quoter/,
  );
  assert.equal(unsupportedPreparedCall, false);

  let mismatchedPreparedCall = false;
  const mismatchedPreparedContext = {
    ...preparedContext,
    request: { ...preparedContext.request, target: mismatchedPool },
    readChain: async ({ to, data }: { to: string; data: string }) => {
      const binding = maybeV3PoolBindingRead(
        { to, data },
        { pool: mismatchedPool, boundPool: POOL },
      );
      if (binding !== null) return binding;
      throw new Error(`unexpected reverse-mismatch prepared read ${to}`);
    },
    callPrepared: async () => {
      mismatchedPreparedCall = true;
      throw new Error("reverse-mismatched target must not call prepared quoter");
    },
  };
  await assert.rejects(
    prepared.quote(mismatchedPreparedContext),
    /binds .* not target/,
  );
  await assert.rejects(
    prepared.encodeQuotePrewarm(mismatchedPreparedContext),
    /binds .* not target/,
  );
  assert.equal(mismatchedPreparedCall, false);
}

async function runUniV4(): Promise<void> {
  const key = {
    currency0: TOKEN0,
    currency1: TOKEN1,
    fee: 3_000,
    tickSpacing: 60,
    hooks: ethers.ZeroAddress,
  };
  const poolId = v4PoolId(key);
  const edges = twoTokenEdges("univ4-unlock").map((edge) => ({
    ...edge,
    target: ADDR.UNISWAP_V4_POOL_MANAGER,
    poolId,
    v4PoolKey: key,
  }));
  const result = await execute(univ4Adapter.id, univ4BlockScanState, edges, (read) => {
    const selector = read.data.slice(0, 10);
    if (selector === v4StateIface.getFunction("getSlot0")!.selector) {
      return v4StateIface.encodeFunctionResult("getSlot0", [
        2n * Q96,
        0,
        0,
        3_000,
      ]);
    }
    if (selector === v4StateIface.getFunction("getLiquidity")!.selector) {
      return v4StateIface.encodeFunctionResult("getLiquidity", [1_000n * UNIT]);
    }
    throw new Error(`unexpected v4 read ${read.id}`);
  });
  assert.equal(result.mids.get(blockScanEdgeKey(edges[0]))?.mid, 4);
  assert.equal(result.mids.get(blockScanEdgeKey(edges[1]))?.mid, 0.25);
  assert.equal(result.initialReads.length, 2);
}

async function runAngstromV4(): Promise<void> {
  const key = {
    currency0: TOKEN0,
    currency1: TOKEN1,
    fee: 0x80_0000,
    tickSpacing: 10,
    hooks: ANGSTROM_MAINNET_HOOK,
  };
  const poolId = v4PoolId(key);
  const edges = twoTokenEdges("angstrom-v4-swap").map((edge) => ({
    ...edge,
    target: ADDR.UNISWAP_V4_POOL_MANAGER,
    poolId,
    v4PoolKey: key,
  }));
  const result = await execute(
    angstromV4Adapter.id,
    angstromV4Adapter.pricingState,
    edges,
    (read) => {
      const selector = read.data.slice(0, 10);
      if (selector === v4StateIface.getFunction("getSlot0")!.selector) {
        return v4StateIface.encodeFunctionResult("getSlot0", [
          2n * Q96,
          0,
          0,
          3_000,
        ]);
      }
      if (
        selector === v4StateIface.getFunction("getLiquidity")!.selector
      ) {
        return v4StateIface.encodeFunctionResult(
          "getLiquidity",
          [1_000n * UNIT],
        );
      }
      throw new Error(`unexpected Angstrom spot-state read ${read.id}`);
    },
  );
  assert.equal(result.staticReads.length, 0);
  assert.equal(result.initialReads.length, 2);
  assert.equal(result.dependentReads.length, 0);
  assert.equal(result.mids.get(blockScanEdgeKey(edges[0]))?.mid, 4);
  assert.equal(result.mids.get(blockScanEdgeKey(edges[1]))?.mid, 0.25);
}

async function runUniV4ExtremePrice(): Promise<void> {
  const sqrtPriceX96 =
    104900925875096973426354586331491637011052178n;
  const liquidity = 98_607n;
  const key = {
    currency0: TOKEN0,
    currency1: TOKEN1,
    fee: 10_000,
    tickSpacing: 200,
    hooks: ethers.ZeroAddress,
  };
  const poolId = v4PoolId(key);
  const edges = twoTokenEdges("univ4-unlock").map((edge) => ({
    ...edge,
    target: ADDR.UNISWAP_V4_POOL_MANAGER,
    poolId,
    v4PoolKey: key,
  }));
  const result = await execute(
    univ4Adapter.id,
    univ4BlockScanState,
    edges,
    (read) => {
      const selector = read.data.slice(0, 10);
      if (selector === v4StateIface.getFunction("getSlot0")!.selector) {
        return v4StateIface.encodeFunctionResult("getSlot0", [
          sqrtPriceX96,
          696_424,
          0,
          10_000,
        ]);
      }
      if (
        selector === v4StateIface.getFunction("getLiquidity")!.selector
      ) {
        return v4StateIface.encodeFunctionResult(
          "getLiquidity",
          [liquidity],
        );
      }
      if (selector === blockScanMulticallIface.getFunction("aggregate3")!.selector) {
        return respondAggregate(read, ({ target, callData, allowFailure }) => {
          assert.equal(target.toLowerCase(), ADDR.UNISWAP_V4_QUOTER.toLowerCase());
          assert.equal(allowFailure, true);
          const quote = v4QuoterIface.decodeFunctionData(
            "quoteExactInputSingle",
            callData,
          )[0];
          const direct = Boolean(quote.zeroForOne);
          assert.equal(
            BigInt(quote.exactAmount),
            direct ? 9n : 32_639_800_260_113_778_162n,
            `extreme V4 ${direct ? "direct" : "reverse"} scanner ceiling`,
          );
          return successInner(v4QuoterIface.encodeFunctionResult(
            "quoteExactInputSingle",
            [direct ? 130_546_280_204_193_357_693n : 0n, 100_000],
          ));
        });
      }
      throw new Error(`unexpected extreme-v4 read ${read.id}`);
    },
    { recordProductionFixture: false },
  );
  const direct = result.mids.get(blockScanEdgeKey(edges[0]));
  assert(direct, "executable extreme V4 direction remains available");
  assert.equal(
    result.mids.get(blockScanEdgeKey(edges[1])),
    undefined,
    "zero-output extreme V4 direction does not publish a phantom mid",
  );
  assert.match(
    result.unavailable.get(blockScanEdgeKey(edges[1])) ?? "",
    /returned zero.*scanner ceiling/,
  );
  assert.equal(direct.reserveA, 36n);
  assert.equal(direct.reserveB, 522_185_120_816_773_430_772n);
  assertExtremeDirectionScans(edges, result.mids, "v4");
}

async function runUniV4DirectionIsolation(): Promise<void> {
  const sqrtPriceX96 = 36n * Q96;
  const liquidity = 36n;
  const key = {
    currency0: TOKEN0,
    currency1: TOKEN1,
    fee: 3_000,
    tickSpacing: 60,
    hooks: ethers.ZeroAddress,
  };
  const poolId = v4PoolId(key);
  const edges = twoTokenEdges("univ4-unlock").map((edge) => ({
    ...edge,
    target: ADDR.UNISWAP_V4_POOL_MANAGER,
    poolId,
    v4PoolKey: key,
  }));
  for (const failure of ["revert", "malformed"] as const) {
    const result = await execute(
      univ4Adapter.id,
      univ4BlockScanState,
      edges,
      (read) => {
        const selector = read.data.slice(0, 10);
        if (selector === v4StateIface.getFunction("getSlot0")!.selector) {
          return v4StateIface.encodeFunctionResult("getSlot0", [
            sqrtPriceX96,
            0,
            0,
            3_000,
          ]);
        }
        if (selector === v4StateIface.getFunction("getLiquidity")!.selector) {
          return v4StateIface.encodeFunctionResult("getLiquidity", [liquidity]);
        }
        if (
          selector ===
            blockScanMulticallIface.getFunction("aggregate3")!.selector
        ) {
          return respondAggregate(
            read,
            ({ target, callData, allowFailure }) => {
              assert.equal(
                target.toLowerCase(),
                ADDR.UNISWAP_V4_QUOTER.toLowerCase(),
              );
              assert.equal(
                allowFailure,
                true,
                "each V4 direction must be independently revert-tolerant",
              );
              const quote = v4QuoterIface.decodeFunctionData(
                "quoteExactInputSingle",
                callData,
              )[0];
              if (Boolean(quote.zeroForOne)) {
                return successInner(v4QuoterIface.encodeFunctionResult(
                  "quoteExactInputSingle",
                  [100n, 100_000],
                ));
              }
              return failure === "revert"
                ? Object.freeze({ success: false, returnData: "0x" })
                : successInner("0x1234");
            },
          );
        }
        throw new Error(`unexpected V4 direction-isolation read ${read.id}`);
      },
      { recordProductionFixture: false },
    );
    assert.equal(result.dependentReads.length, 2);
    assert(
      result.dependentReads.every(
        (read) => read.to.toLowerCase() === BLOCKSCAN_MULTICALL3.toLowerCase(),
      ),
      "V4 precision reads must preserve direction failures inside Multicall3",
    );
    assert(
      result.mids.has(blockScanEdgeKey(edges[0])),
      `healthy V4 direction remains published when sibling is ${failure}`,
    );
    assert.equal(
      result.mids.has(blockScanEdgeKey(edges[1])),
      false,
      `failed V4 direction remains unavailable when sibling is ${failure}`,
    );
    assert.match(
      result.unavailable.get(blockScanEdgeKey(edges[1])) ?? "",
      failure === "revert"
        ? /precision witness failed: quote call reverted/
        : /precision witness failed: malformed quote result/,
    );
  }
}

function assertExtremeDirectionScans(
  extremeEdges: readonly TokenEdge[],
  extremeMids: ReadonlyMap<string, RouteVenueMid>,
  family: "v3" | "v4",
): void {
  const returnPool = "0x5555555555555555555555555555555555555555";
  const returnEdges = twoTokenEdges("univ2-swap").map((edge) => ({
    ...edge,
    target: returnPool,
  }));
  const direct = extremeMids.get(blockScanEdgeKey(extremeEdges[0]));
  assert(direct, `${family} direct precision mid missing`);
  const returnDirectMid = direct.mid / 2;
  const returnReserve = 10n ** 60n;
  const mids = new Map(extremeMids);
  mids.set(blockScanEdgeKey(returnEdges[0]), {
    kind: "v2",
    pool: returnPool,
    edges: [returnEdges[0]],
    mid: returnDirectMid,
    feeBps: 0,
    reserveA: returnReserve,
    reserveB: returnReserve,
    depthProxy: Number(returnReserve),
  });
  mids.set(blockScanEdgeKey(returnEdges[1]), {
    kind: "v2",
    pool: returnPool,
    edges: [returnEdges[1]],
    mid: 1 / returnDirectMid,
    feeBps: 0,
    reserveA: returnReserve,
    reserveB: returnReserve,
    depthProxy: Number(returnReserve),
  });
  const scanned = scanBlockStateFromResolvedMids({
    edges: [...extremeEdges, ...returnEdges],
    sourceBlock: SOURCE_BLOCK,
    swapTouched: null,
    cfg: {
      maxHops: 2,
      minSpreadBps: 0,
      maxCandidates: 10,
      budgetMs: 1_000,
      pricedTokens: new Map([
        [TOKEN0.toLowerCase(), { maxBorrow: 10n ** 30n }],
      ]),
    },
    mids,
  });
  const diagnosis = diagnoseResolvedRingScore(
    [extremeEdges[0], returnEdges[1]],
    mids,
  );
  assert.equal(
    scanned.opportunities.length,
    1,
    `${family} precision route scans: outcome=${scanned.outcome} ` +
      `diagnosis=${diagnosis.status}`,
  );
  assert.equal(
    scanned.opportunities[0].searchSeed.searchCenter,
    9n,
    `${family} scanner sizes at the exact positive-output witness`,
  );
  assert.equal(
    scanned.opportunities[0].searchSeed.maxInput,
    9n,
    `${family} scanner ceiling cannot exceed its precision witness`,
  );
}

async function runInactiveUniPools(): Promise<void> {
  const v2Edges = twoTokenEdges("univ2-swap");
  const inactiveV2 = await execute(
    univ2StandardAdapter.id,
    univ2BlockScanState,
    v2Edges,
    (read) => {
      assert.equal(
        read.data.slice(0, 10),
        v2Iface.getFunction("getReserves")!.selector,
      );
      return v2Iface.encodeFunctionResult("getReserves", [0n, UNIT, 1]);
    },
    { recordProductionFixture: false },
  );
  assertInactiveEdges(inactiveV2, v2Edges, /zero reserve/);

  for (const zeroField of ["sqrtPriceX96", "liquidity"] as const) {
    const v3Edges = twoTokenEdges("univ3-swap");
    const inactiveV3 = await execute(
      univ3StandardAdapter.id,
      univ3BlockScanState,
      v3Edges,
      (read) => {
        const binding = maybeV3PoolBindingRead(read);
        if (binding !== null) return binding;
        const selector = read.data.slice(0, 10);
        if (selector === v3Iface.getFunction("slot0")!.selector) {
          return v3Iface.encodeFunctionResult("slot0", [
            zeroField === "sqrtPriceX96" ? 0n : Q96,
            0,
            0,
            1,
            1,
            0,
            true,
          ]);
        }
        if (selector === v3Iface.getFunction("liquidity")!.selector) {
          return v3Iface.encodeFunctionResult(
            "liquidity",
            [zeroField === "liquidity" ? 0n : UNIT],
          );
        }
        throw new Error(`unexpected inactive v3 read ${read.id}`);
      },
      { recordProductionFixture: false },
    );
    assertInactiveEdges(inactiveV3, v3Edges, new RegExp(`zero ${zeroField}`));
  }

  const key = {
    currency0: TOKEN0,
    currency1: TOKEN1,
    fee: 3_000,
    tickSpacing: 60,
    hooks: ethers.ZeroAddress,
  };
  const poolId = v4PoolId(key);
  for (const zeroField of ["sqrtPriceX96", "liquidity"] as const) {
    const v4Edges = twoTokenEdges("univ4-unlock").map((edge) => ({
      ...edge,
      target: ADDR.UNISWAP_V4_POOL_MANAGER,
      poolId,
      v4PoolKey: key,
    }));
    const inactiveV4 = await execute(
      univ4Adapter.id,
      univ4BlockScanState,
      v4Edges,
      (read) => {
        const selector = read.data.slice(0, 10);
        if (selector === v4StateIface.getFunction("getSlot0")!.selector) {
          return v4StateIface.encodeFunctionResult("getSlot0", [
            zeroField === "sqrtPriceX96" ? 0n : Q96,
            0,
            0,
            3_000,
          ]);
        }
        if (selector === v4StateIface.getFunction("getLiquidity")!.selector) {
          return v4StateIface.encodeFunctionResult(
            "getLiquidity",
            [zeroField === "liquidity" ? 0n : UNIT],
          );
        }
        throw new Error(`unexpected inactive v4 read ${read.id}`);
      },
      { recordProductionFixture: false },
    );
    assertInactiveEdges(inactiveV4, v4Edges, new RegExp(`zero ${zeroField}`));
  }
}

async function runMalformedUniState(): Promise<void> {
  await assert.rejects(
    () =>
      execute(
        univ3StandardAdapter.id,
        univ3BlockScanState,
        twoTokenEdges("univ3-swap"),
        () => "0x",
        { recordProductionFixture: false },
      ),
    /decode result data|BAD_DATA/i,
    "an unknown decode failure must remain unresolved, not terminal unavailable",
  );
}

function assertInactiveEdges(
  result: {
    readonly mids: ReadonlyMap<string, unknown>;
    readonly unavailable: ReadonlyMap<string, string>;
  },
  edges: readonly TokenEdge[],
  reason: RegExp,
): void {
  assert.equal(result.mids.size, 0);
  assert.deepEqual(
    [...result.unavailable.keys()].sort(),
    edges.map(blockScanEdgeKey).sort(),
  );
  for (const unavailableReason of result.unavailable.values()) {
    assert.match(unavailableReason, reason);
    assert.match(unavailableReason, /current source/);
  }
}

async function runCurveUnderlying(): Promise<void> {
  const edges = twoTokenEdges("curve-exchange-underlying").map((edge, index) => ({
    ...edge,
    curveI: index,
    curveJ: index === 0 ? 1 : 0,
  }));
  const result = await execute(
    curveUnderlyingAdapter.id,
    curveUnderlyingBlockScanState,
    edges,
    (read) => {
      return respondAggregate(read, ({ target, callData }) => {
        const selector = callData.slice(0, 10);
        if (
          target.toLowerCase() === CURVE_METAREGISTRY.toLowerCase() &&
          selector ===
            curveMetaRegistryStateIface.getFunction(
              "get_underlying_decimals",
            )!.selector
        ) {
          return successInner(
            curveMetaRegistryStateIface.encodeFunctionResult(
              "get_underlying_decimals",
              [[18, 18, 0, 0, 0, 0, 0, 0]],
            ),
          );
        }
        if (
          target.toLowerCase() === CURVE_METAREGISTRY.toLowerCase() &&
          selector ===
            curveMetaRegistryStateIface.getFunction(
              "get_underlying_balances",
            )!.selector
        ) {
          return successInner(
            curveMetaRegistryStateIface.encodeFunctionResult(
              "get_underlying_balances",
              [[1_000n * UNIT, 1_000n * UNIT, 0, 0, 0, 0, 0, 0]],
            ),
          );
        }
        if (
          selector ===
            blockScanErc20Iface.getFunction("decimals")!.selector
        ) {
          return successInner(
            blockScanErc20Iface.encodeFunctionResult("decimals", [18]),
          );
        }
        const decoded = curveUnderlyingIface.decodeFunctionData(
          "get_dy_underlying",
          callData,
        );
        const amountIn = BigInt(decoded[2]);
        return successInner(
          curveUnderlyingIface.encodeFunctionResult(
            "get_dy_underlying",
            [decoded[0] === 0n ? amountIn * 2n : amountIn / 2n],
          ),
        );
      });
    },
  );
  assert.equal(result.staticReads.length, 0);
  assert.equal(result.initialReads.length, 4);
  assert(
    result.initialReads.every((read) =>
      read.to.toLowerCase() === BLOCKSCAN_MULTICALL3.toLowerCase()
    ),
    "Curve-underlying scale probes stay in fail-isolated current-N multicalls",
  );
  assert.equal(result.dependentReads.length, 2);
}

async function runDodoV2(): Promise<void> {
  const edges = twoTokenEdges("dodo-v2-swap");
  const reserve = 1_000_000_000n * UNIT;
  const precisionSafeProbe = reserve / 1_000_000n;
  let onchainQuoteReads = 0;
  const result = await execute(dodoV2Adapter.id, dodoV2BlockScanState, edges, (read) => {
    const selector = read.data.slice(0, 10);
    if (selector === blockScanErc20Iface.getFunction("decimals")!.selector) {
      return blockScanErc20Iface.encodeFunctionResult("decimals", [18]);
    }
    if (
      selector === blockScanMulticallIface.getFunction("aggregate3")!.selector
    ) {
      return respondAggregate(read, ({ callData }) => {
        const innerSelector = callData.slice(0, 10);
        if (
          innerSelector ===
            dodoBalanceIface.getFunction("balanceOf")!.selector
        ) {
          return successInner(
            dodoBalanceIface.encodeFunctionResult("balanceOf", [reserve]),
          );
        }
        for (const fn of ["_BASE_RESERVE_", "_QUOTE_RESERVE_"] as const) {
          if (innerSelector === dodoV2PoolIface.getFunction(fn)!.selector) {
            return successInner(
              dodoV2PoolIface.encodeFunctionResult(fn, [reserve]),
            );
          }
        }
        for (const fn of ["getBaseInput", "getQuoteInput"] as const) {
          if (innerSelector === dodoV2PoolIface.getFunction(fn)!.selector) {
            return successInner(
              dodoV2PoolIface.encodeFunctionResult(fn, [0n]),
            );
          }
        }
        if (
          innerSelector ===
            dodoV2PoolIface.getFunction("getMtFeeTotal")!.selector
        ) {
          return Object.freeze({ success: false, returnData: "0x" });
        }
        throw new Error(`unexpected DODO aggregate selector ${innerSelector}`);
      });
    }
    if (selector === dodoBalanceIface.getFunction("balanceOf")!.selector) {
      return dodoBalanceIface.encodeFunctionResult("balanceOf", [reserve]);
    }
    for (const fn of ["_BASE_TOKEN_", "_QUOTE_TOKEN_"] as const) {
      if (selector === dodoV2PoolIface.getFunction(fn)!.selector) {
        return dodoV2PoolIface.encodeFunctionResult(
          fn,
          [fn === "_BASE_TOKEN_" ? TOKEN0 : TOKEN1],
        );
      }
    }
    if (
      selector === dodoV2PoolIface.getFunction("_BASE_RESERVE_")!.selector ||
      selector === dodoV2PoolIface.getFunction("_QUOTE_RESERVE_")!.selector
    ) {
      throw new Error("block-scan must reuse reserves already returned by PMM state");
    }
    if (
      selector ===
        dodoV2PoolIface.getFunction("getPMMStateForCall")!.selector
    ) {
      return dodoV2PoolIface.encodeFunctionResult("getPMMStateForCall", [
        UNIT,
        UNIT / 10n,
        reserve,
        reserve,
        reserve,
        reserve,
        0,
      ]);
    }
    if (
      selector ===
        dodoV2PoolIface.getFunction("getUserFeeRate")!.selector
    ) {
      return dodoV2PoolIface.encodeFunctionResult(
        "getUserFeeRate",
        [3n * 10n ** 15n, 1n * 10n ** 15n],
      );
    }
    for (const fn of ["getBaseInput", "getQuoteInput"] as const) {
      if (selector === dodoV2PoolIface.getFunction(fn)!.selector) {
        return dodoV2PoolIface.encodeFunctionResult(fn, [0n]);
      }
    }
    for (const fn of ["querySellBase", "querySellQuote"] as const) {
      if (selector === dodoV2PoolIface.getFunction(fn)!.selector) {
        onchainQuoteReads += 1;
        const decoded = dodoV2PoolIface.decodeFunctionData(fn, read.data);
        assert.equal(
          BigInt(decoded[1]),
          precisionSafeProbe,
          "DODO current-N probe must rise above one-token integer-rounding dust",
        );
        return dodoV2PoolIface.encodeFunctionResult(
          fn,
          [fn === "querySellBase" ? 2n * UNIT : UNIT / 2n],
        );
      }
    }
    throw new Error(`unexpected DODO read ${read.id}`);
  });
  assert.equal(result.initialReads.length, 5);
  assert.equal(
    result.dependentReads.length,
    0,
    "ordinary DODO current-N state must quote locally without querySell fallback reads",
  );
  assert.equal(onchainQuoteReads, 0);
}

async function runFluidDex(): Promise<void> {
  const previous = process.env.FLUID_DEX_RESOLVER;
  const resolver = "0x4444444444444444444444444444444444444444";
  const edges = twoTokenEdges("fluid-dex-swap");
  const quoteForDirection = (swap0to1: boolean): bigint =>
    swap0to1 ? 2n * UNIT : UNIT / 2n;
  const unknownError = new ethers.Interface([
    "error UnknownFluidError(uint256 value)",
  ]);
  try {
    process.env.FLUID_DEX_RESOLVER = resolver;
    const resolverResult = await execute(
      fluidDexAdapter.id,
      fluidDexBlockScanState,
      edges,
      (read) => {
        if (read.data.slice(0, 10) === blockScanErc20Iface.getFunction("decimals")!.selector) {
          return blockScanErc20Iface.encodeFunctionResult("decimals", [18]);
        }
        const decoded = fluidDexResolverIface.decodeFunctionData(
          "estimateSwapIn",
          read.data,
        );
        assert.equal(BigInt(decoded[2]), UNIT);
        return fluidDexResolverIface.encodeFunctionResult(
          "estimateSwapIn",
          [quoteForDirection(Boolean(decoded[1]))],
        );
      },
    );
    assert.equal(resolverResult.mids.get(blockScanEdgeKey(edges[0]))?.mid, 2);
    assert.equal(resolverResult.mids.get(blockScanEdgeKey(edges[1]))?.mid, 0.5);
    assert(
      resolverResult.initialReads.every(
        (read) =>
          read.to.toLowerCase() === resolver.toLowerCase() &&
          read.acceptRevertData !== true,
      ),
      "Fluid resolver reads must require ordinary successful ABI returns",
    );

    delete process.env.FLUID_DEX_RESOLVER;
    const estimateResult = await execute(
      fluidDexAdapter.id,
      fluidDexBlockScanState,
      edges,
      (read) => {
        if (read.data.slice(0, 10) === blockScanErc20Iface.getFunction("decimals")!.selector) {
          return blockScanErc20Iface.encodeFunctionResult("decimals", [18]);
        }
        const decoded = fluidDexSwapIface.decodeFunctionData("swapIn", read.data);
        assert.equal(BigInt(decoded[1]), UNIT);
        return fluidDexSwapIface.encodeErrorResult(
          "FluidDexSwapResult",
          [quoteForDirection(Boolean(decoded[0]))],
        );
      },
      { recordProductionFixture: false },
    );
    assert.equal(estimateResult.mids.get(blockScanEdgeKey(edges[0]))?.mid, 2);
    assert.equal(estimateResult.mids.get(blockScanEdgeKey(edges[1]))?.mid, 0.5);
    assert(
      estimateResult.initialReads.every(
        (read) =>
          read.to.toLowerCase() === POOL.toLowerCase() &&
          read.acceptRevertData === true,
      ),
      "Fluid ADDRESS_DEAD reads must explicitly accept proven revert data",
    );

    await assert.rejects(
      execute(
        fluidDexAdapter.id,
        fluidDexBlockScanState,
        edges,
        (read) => {
          if (read.data.slice(0, 10) === blockScanErc20Iface.getFunction("decimals")!.selector) {
            return blockScanErc20Iface.encodeFunctionResult("decimals", [18]);
          }
          return fluidDexSwapIface.encodeFunctionResult("swapIn", [UNIT]);
        },
        { recordProductionFixture: false },
      ),
      /malformed revert data/,
      "a generic 32-byte word is not a Fluid ADDRESS_DEAD estimate",
    );
    await assert.rejects(
      execute(
        fluidDexAdapter.id,
        fluidDexBlockScanState,
        edges,
        (read) => {
          if (read.data.slice(0, 10) === blockScanErc20Iface.getFunction("decimals")!.selector) {
            return blockScanErc20Iface.encodeFunctionResult("decimals", [18]);
          }
          return unknownError.encodeErrorResult("UnknownFluidError", [UNIT]);
        },
        { recordProductionFixture: false },
      ),
      /unknown custom error/,
      "a same-width custom error is not Fluid quote evidence",
    );
    await assert.rejects(
      execute(
        fluidDexAdapter.id,
        fluidDexBlockScanState,
        edges,
        (read) => {
          if (read.data.slice(0, 10) === blockScanErc20Iface.getFunction("decimals")!.selector) {
            return blockScanErc20Iface.encodeFunctionResult("decimals", [18]);
          }
          return "0x1234";
        },
        { recordProductionFixture: false },
      ),
      /malformed revert data/,
    );

    process.env.FLUID_DEX_RESOLVER = resolver;
    const exactResolverQuote = await quoteFluidDex(
      {
        call: async ({ to, data }) => {
          assert.equal(to.toLowerCase(), resolver.toLowerCase());
          const decoded = fluidDexResolverIface.decodeFunctionData(
            "estimateSwapIn",
            data,
          );
          return fluidDexResolverIface.encodeFunctionResult(
            "estimateSwapIn",
            [quoteForDirection(Boolean(decoded[1]))],
          );
        },
      },
      POOL,
      TOKEN0,
      TOKEN1,
      UNIT,
      TOKEN0,
      TOKEN1,
    );
    assert.equal(exactResolverQuote, 2n * UNIT);

    delete process.env.FLUID_DEX_RESOLVER;
    const exactEstimateQuote = await quoteFluidDex(
      {
        call: async ({ data }) => {
          const decoded = fluidDexSwapIface.decodeFunctionData("swapIn", data);
          throw Object.assign(new Error("execution reverted"), {
            data: fluidDexSwapIface.encodeErrorResult(
              "FluidDexSwapResult",
              [quoteForDirection(Boolean(decoded[0]))],
            ),
          });
        },
      },
      POOL,
      TOKEN1,
      TOKEN0,
      UNIT,
      TOKEN0,
      TOKEN1,
    );
    assert.equal(exactEstimateQuote, UNIT / 2n);

    await assert.rejects(
      quoteFluidDex(
        {
          call: async () => {
            throw Object.assign(new Error("execution reverted"), {
              data: unknownError.encodeErrorResult("UnknownFluidError", [UNIT]),
            });
          },
        },
        POOL,
        TOKEN0,
        TOKEN1,
        UNIT,
        TOKEN0,
        TOKEN1,
      ),
      /execution reverted/,
      "unknown custom reverts must remain unresolved in exact quoting",
    );
  } finally {
    if (previous === undefined) delete process.env.FLUID_DEX_RESOLVER;
    else process.env.FLUID_DEX_RESOLVER = previous;
  }
}

async function execute<Schema, Snapshot>(
  familyId: string,
  capability: BlockScanStateCapability<Schema, Snapshot>,
  edges: readonly TokenEdge[],
  respond: (read: StateRead) => string,
  options: {
    readonly recordProductionFixture?: boolean;
  } = {},
): Promise<{
  readonly initialReads: readonly StateRead[];
  readonly staticReads: readonly StateRead[];
  readonly dependentReads: readonly StateRead[];
  readonly snapshot: Snapshot;
  readonly mids: ReturnType<typeof capability.deriveMids>;
  readonly unavailable: ReadonlyMap<string, string>;
}> {
  const controller = new AbortController();
  let schema: Schema = await capability.compileStaticSchema({
    edges,
    deadlineAtMs: Date.now() + 10_000,
    signal: controller.signal,
  }) as Schema;
  const staticInput = {
    sourceBlock: SOURCE_BLOCK,
    sourceBlockHash: SOURCE_HASH,
    schema,
    edges,
  };
  const staticReads = capability.buildStaticSchemaReads?.(staticInput) ?? [];
  if (staticReads.length > 0) {
    const staticResults = staticReads.map((read) => success(read, respond(read)));
    schema = capability.hydrateStaticSchema!(schema, staticResults);
  }
  const input = {
    sourceBlock: SOURCE_BLOCK,
    sourceBlockHash: SOURCE_HASH,
    schema,
  };
  const grouped = new Map<string, TokenEdge[]>();
  for (const edge of edges) {
    const key = capability.stateKey(edge);
    const group = grouped.get(key) ?? [];
    group.push(edge);
    grouped.set(key, group);
  }
  const initialReads: StateRead[] = [];
  const dependentReads: StateRead[] = [];
  const snapshots: { readonly snapshot: Snapshot; readonly edges: readonly TokenEdge[] }[] = [];
  const unavailable = new Map<string, string>();
  const mids = new Map<string, RouteVenueMid>();
  for (const groupEdges of grouped.values()) {
    const groupInput = { ...input, edges: Object.freeze([...groupEdges]) };
    const groupInitialReads = capability.buildCurrentBlockReads(groupInput);
    const initialResults = groupInitialReads.map((read) =>
      success(read, respond(read))
    );
    const groupDependentReads = capability.buildDependentBlockReads?.({
      ...groupInput,
      completedRound: 0,
      priorResults: initialResults,
    }) ?? [];
    const dependentResults = groupDependentReads.map((read) =>
      success(read, respond(read))
    );
    const allResults = Object.freeze([...initialResults, ...dependentResults]);
    const noMore = capability.buildDependentBlockReads?.({
      ...groupInput,
      completedRound: 1,
      priorResults: allResults,
    }) ?? [];
    assert.equal(noMore.length, 0, "view quote must close after one dependent round");
    const snapshot = capability.decodeState(schema, allResults);
    snapshots.push({ snapshot, edges: groupInput.edges });
    for (const [edgeKey, reason] of
      capability.behaviorProvenUnavailableEdges?.(
        snapshot,
        groupInput.edges,
      ) ?? new Map()) {
      unavailable.set(edgeKey, reason);
    }
    for (const [edgeKey, mid] of capability.deriveMids(
      snapshot,
      groupInput.edges,
    )) {
      mids.set(edgeKey, mid);
    }
    initialReads.push(...groupInitialReads);
    dependentReads.push(...groupDependentReads);
  }
  const snapshot = snapshots[0]?.snapshot;
  if (!snapshot) throw new Error("swap block-scan fixture produced no snapshot");
  assert.deepEqual(
    [...mids.keys()].sort(),
    edges
      .map(blockScanEdgeKey)
      .filter((edgeKey) => !unavailable.has(edgeKey))
      .sort(),
  );
  for (const group of snapshots) {
    const harness = createAmbientIoPoisonHarness();
    assertPureSynchronousDeriveMids({
      capability,
      snapshot: group.snapshot,
      edges: group.edges,
      harness,
    });
  }
  if (options.recordProductionFixture !== false) {
    const production = PRODUCTION_ADAPTER_FAMILIES
      .pricing("swap")
      .find((family) => family.id === familyId);
    assert(production, `non-production swap purity fixture ${familyId}`);
    assert.equal(
      production.pricingState,
      capability,
      `${familyId}: fixture tests the wrong pricingState capability`,
    );
    assert(
      !pureFixtureFamilyIds.has(familyId),
      `duplicate swap purity fixture ${familyId}`,
    );
    pureFixtureFamilyIds.add(familyId);
  }
  for (const read of [...initialReads, ...dependentReads]) {
    assert.equal(read.sourceBlock, SOURCE_BLOCK);
    assert.equal(read.sourceBlockHash, SOURCE_HASH);
  }
  return {
    staticReads,
    initialReads,
    dependentReads,
    snapshot,
    mids,
    unavailable,
  };
}

function respondAggregate(
  read: StateRead,
  respond: (call: {
    readonly target: string;
    readonly callData: string;
    readonly allowFailure: boolean;
  }) => { readonly success: boolean; readonly returnData: string },
): string {
  assert.equal(read.to.toLowerCase(), BLOCKSCAN_MULTICALL3.toLowerCase());
  const calls = blockScanMulticallIface.decodeFunctionData(
    "aggregate3",
    read.data,
  )[0] as readonly {
    target: string;
    callData: string;
    allowFailure: boolean;
  }[];
  return blockScanMulticallIface.encodeFunctionResult(
    "aggregate3",
    [calls.map(respond)],
  );
}

function maybeV3PoolBindingRead(
  read: Pick<StateRead, "to" | "data">,
  input: {
    readonly pool?: string;
    readonly factory?: string;
    readonly boundPool?: string;
  } = {},
): string | null {
  const pool = input.pool ?? POOL;
  const factory = input.factory ?? UNIV3_FACTORY;
  const selector = read.data.slice(0, 10);
  if (
    read.to.toLowerCase() === pool.toLowerCase() &&
    selector === v3Iface.getFunction("factory")!.selector
  ) {
    return v3Iface.encodeFunctionResult("factory", [factory]);
  }
  if (
    read.to.toLowerCase() === pool.toLowerCase() &&
    selector === v3Iface.getFunction("token0")!.selector
  ) {
    return v3Iface.encodeFunctionResult("token0", [TOKEN0]);
  }
  if (
    read.to.toLowerCase() === pool.toLowerCase() &&
    selector === v3Iface.getFunction("token1")!.selector
  ) {
    return v3Iface.encodeFunctionResult("token1", [TOKEN1]);
  }
  if (
    read.to.toLowerCase() === pool.toLowerCase() &&
    selector === v3Iface.getFunction("fee")!.selector
  ) {
    return v3Iface.encodeFunctionResult("fee", [3_000]);
  }
  if (
    read.to.toLowerCase() === factory.toLowerCase() &&
    selector === v3FactoryIface.getFunction("getPool")!.selector
  ) {
    const [tokenA, tokenB, fee] = v3FactoryIface.decodeFunctionData(
      "getPool",
      read.data,
    );
    assert.deepEqual(
      [String(tokenA).toLowerCase(), String(tokenB).toLowerCase()],
      [TOKEN0.toLowerCase(), TOKEN1.toLowerCase()].sort(),
      "V3 reverse lookup must use sorted pool tokens",
    );
    assert.equal(BigInt(fee), 3_000n);
    return v3FactoryIface.encodeFunctionResult("getPool", [
      input.boundPool ?? pool,
    ]);
  }
  return null;
}

function successInner(returnData: string): {
  readonly success: true;
  readonly returnData: string;
} {
  return Object.freeze({ success: true, returnData });
}

function success(read: StateRead, data: string): StateReadSuccess {
  return Object.freeze({
    id: read.id,
    ok: true,
    sourceBlock: read.sourceBlock,
    sourceBlockHash: read.sourceBlockHash,
    provenance: Object.freeze({
      kind: "eip1898" as const,
      source: Object.freeze({
        number: read.sourceBlock,
        hash: read.sourceBlockHash,
        generation: 1,
      }),
      requireCanonical: true as const,
    }),
    data,
  });
}

function twoTokenEdges(adapterId: string): TokenEdge[] {
  return [
    {
      adapterId,
      target: POOL,
      tokenIn: TOKEN0,
      tokenOut: TOKEN1,
      poolToken0: TOKEN0,
      poolToken1: TOKEN1,
      ...(adapterId === "univ2-swap" ? { v2FeeBps: 30n } : {}),
      ...(adapterId === "univ3-swap" ? { v3Fee: 3_000 } : {}),
      ...(adapterId === "univ3-swap" ? { v3TickSpacing: 60 } : {}),
      ...(adapterId === "univ3-swap" ? { factory: UNIV3_FACTORY } : {}),
      slotKind: "swap",
      ...taxonomy,
    },
    {
      adapterId,
      target: POOL,
      tokenIn: TOKEN1,
      tokenOut: TOKEN0,
      poolToken0: TOKEN0,
      poolToken1: TOKEN1,
      ...(adapterId === "univ2-swap" ? { v2FeeBps: 30n } : {}),
      ...(adapterId === "univ3-swap" ? { v3Fee: 3_000 } : {}),
      ...(adapterId === "univ3-swap" ? { v3TickSpacing: 60 } : {}),
      ...(adapterId === "univ3-swap" ? { factory: UNIV3_FACTORY } : {}),
      slotKind: "swap",
      ...taxonomy,
    },
  ];
}

await import("./external-swap-liquidity-state.js");
await import("./curve-underlying-decimals-isolation.js");
