import assert from "node:assert/strict";
import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import type { TokenEdge } from "../planner/token-graph.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";
import type { RouteVenueMid } from "../venues/mid-readers.js";
import {
  assertPureSynchronousDeriveMids,
  blockScanEdgeKey,
  createAmbientIoPoisonHarness,
  type BlockScanStateCapability,
  type StateRead,
  type StateReadResult,
  type StateReadSuccess,
} from "../venues/blockscan-state-capability.js";
import {
  balancerV3BlockScanState,
  balancerV3Adapter,
} from "../venues/swaps/balancer-v3.js";
import {
  BLOCKSCAN_MULTICALL3,
  blockScanErc20Iface,
  blockScanMulticallIface,
} from "../venues/swaps/blockscan-state-shared.js";
import {
  curvePlainBlockScanState,
  curvePlainAdapter,
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
const Q96 = 1n << 96n;
const UNIT = 10n ** 18n;
const taxonomy = deriveEdgeTaxonomy("swap");

const v2Iface = new ethers.Interface([
  "function getReserves() view returns (uint112 reserve0,uint112 reserve1,uint32 blockTimestampLast)",
  "function factory() view returns (address)",
]);
const v3Iface = new ethers.Interface([
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
  "function liquidity() view returns (uint128)",
  "function fee() view returns (uint24)",
]);
const v4StateIface = new ethers.Interface([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
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
await runUniV3();
await runUniV4();
await runInactiveUniPools();
await runMalformedUniState();
await runCurvePlain();
await runCurveUnderlying();
await runBalancerV3();
await runDodoV2();
await runFluidDex();
assert.deepEqual(
  [...pureFixtureFamilyIds].sort(),
  PRODUCTION_ADAPTER_FAMILIES.pricing("swap").map((family) => family.id).sort(),
  "every production swap pricing family requires one passing purity fixture",
);

console.log("[swap-blockscan-state-capabilities] current-N + pure derive: PASS");

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
  const edges = twoTokenEdges("univ3-swap");
  const result = await execute(univ3StandardAdapter.id, univ3BlockScanState, edges, (read) => {
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
  assert.equal(result.initialReads.length, 2);
  assert.equal(result.snapshot.tickSpacing, 60);
  assert.equal(result.snapshot.observationCardinality, 1);
  assert.equal(result.snapshot.unlocked, true);
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

async function runCurvePlain(): Promise<void> {
  const edges = twoTokenEdges("curve-exchange-plain").map((edge, index) => ({
    ...edge,
    curveI: index,
    curveJ: index === 0 ? 1 : 0,
  }));
  const result = await execute(curvePlainAdapter.id, curvePlainBlockScanState, edges, (read) => {
    if (read.data.slice(0, 10) === blockScanErc20Iface.getFunction("decimals")!.selector) {
      return blockScanErc20Iface.encodeFunctionResult("decimals", [18]);
    }
    assert.equal(read.to.toLowerCase(), BLOCKSCAN_MULTICALL3.toLowerCase());
    const calls = blockScanMulticallIface.decodeFunctionData(
      "aggregate3",
      read.data,
    )[0] as readonly { target: string; callData: string }[];
    const responses = calls.map(({ target, callData }) => {
      const selector = callData.slice(0, 10);
      if (selector === curveStateIface.getFunction("A")!.selector) {
        return { success: true, returnData: curveStateIface.encodeFunctionResult("A", [2_000]) };
      }
      if (selector === curveStateIface.getFunction("fee")!.selector) {
        return { success: true, returnData: curveStateIface.encodeFunctionResult("fee", [4_000_000]) };
      }
      if (selector === curveStateIface.getFunction("offpeg_fee_multiplier")!.selector) {
        return { success: false, returnData: "0x" };
      }
      if (selector === curveStateIface.getFunction("stored_rates")!.selector) {
        return { success: false, returnData: "0x" };
      }
      if (selector === curveStateIface.getFunction("balances")!.selector) {
        return { success: false, returnData: "0x" };
      }
      if (selector === curveIntBalanceIface.getFunction("balances")!.selector) {
        const index = Number(
          curveIntBalanceIface.decodeFunctionData("balances", callData)[0],
        );
        return {
          success: true,
          returnData: curveIntBalanceIface.encodeFunctionResult(
            "balances",
            [index === 0 ? 1_000_000n * UNIT : 1_000_000n * UNIT],
          ),
        };
      }
      throw new Error(`unexpected Curve inner call ${selector}`);
    });
    return blockScanMulticallIface.encodeFunctionResult("aggregate3", [responses]);
  });
  assert.equal(result.initialReads.length, 1);
  for (const edge of edges) {
    assert.ok((result.mids.get(blockScanEdgeKey(edge))?.mid ?? 0) > 0);
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

async function runBalancerV3(): Promise<void> {
  const edges = twoTokenEdges("balancer-v3-unlock");
  const result = await execute(balancerV3Adapter.id, balancerV3BlockScanState, edges, (read) => {
    if (
      read.data.slice(0, 10) ===
        balancerIface.getFunction("getPoolTokenInfo")!.selector
    ) {
      return balancerIface.encodeFunctionResult("getPoolTokenInfo", [
        [TOKEN0, TOKEN1],
        [
          [0, ethers.ZeroAddress, false],
          [0, ethers.ZeroAddress, false],
        ],
        [100n * UNIT, 100n * UNIT],
        [100n * UNIT, 100n * UNIT],
      ]);
    }
    return respondAggregate(read, ({ callData }) => {
      const selector = callData.slice(0, 10);
      if (
        selector === blockScanErc20Iface.getFunction("decimals")!.selector
      ) {
        return successInner(
          blockScanErc20Iface.encodeFunctionResult("decimals", [18]),
        );
      }
      const decoded = balancerIface.decodeFunctionData(
        "querySwapSingleTokenExactIn",
        callData,
      );
      const amountIn = BigInt(decoded[3]);
      return successInner(
        balancerIface.encodeFunctionResult(
          "querySwapSingleTokenExactIn",
          [
            String(decoded[1]).toLowerCase() === TOKEN0.toLowerCase()
              ? amountIn * 2n
              : amountIn / 2n,
          ],
        ),
      );
    });
  });
  assert.equal(result.initialReads.length, 4);
  assert.equal(result.dependentReads.length, 2);
}

async function runDodoV2(): Promise<void> {
  const edges = twoTokenEdges("dodo-v2-swap");
  const reserve = 1_000_000_000n * UNIT;
  const precisionSafeProbe = reserve / 1_000_000n;
  const result = await execute(dodoV2Adapter.id, dodoV2BlockScanState, edges, (read) => {
    const selector = read.data.slice(0, 10);
    if (selector === blockScanErc20Iface.getFunction("decimals")!.selector) {
      return blockScanErc20Iface.encodeFunctionResult("decimals", [18]);
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
    for (const fn of ["querySellBase", "querySellQuote"] as const) {
      if (selector === dodoV2PoolIface.getFunction(fn)!.selector) {
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
  assert.equal(result.dependentReads.length, 2);
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
  }) => { readonly success: boolean; readonly returnData: string },
): string {
  assert.equal(read.to.toLowerCase(), BLOCKSCAN_MULTICALL3.toLowerCase());
  const calls = blockScanMulticallIface.decodeFunctionData(
    "aggregate3",
    read.data,
  )[0] as readonly { target: string; callData: string }[];
  return blockScanMulticallIface.encodeFunctionResult(
    "aggregate3",
    [calls.map(respond)],
  );
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
      slotKind: "swap",
      ...taxonomy,
    },
  ];
}

await import("./external-swap-liquidity-state.js");
await import("./curve-underlying-decimals-isolation.js");
