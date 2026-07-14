import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import type { StateBackend } from "../../shared/state/state-backend.js";
import { v4PoolId, type V4PoolKey } from "../planner/token-graph.js";
import { PoolStateCache } from "../solver/pool-state-cache.js";
import { PoolStateUpdater } from "../solver/pool-state-updater.js";
import { quoteV2ExactInput } from "../solver/v2-fee.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const TICK_LENS = "0xbfd8137f7d1516D3ea5cA83523914859ec47F573";
const V2_POOL = "0x0000000000000000000000000000000000000a02";
const V3_POOL = "0x0000000000000000000000000000000000000a03";
const TOKEN0 = "0x00000000000000000000000000000000000000a0";
const TOKEN1 = "0x00000000000000000000000000000000000000b1";
const PANCAKE_V2_FACTORY = "0x1097053fd2ea711dad45caccc45eff7548fcb362";
const SQRT_PRICE_1_1 = 1n << 96n;
const V4_KEY: V4PoolKey = {
  currency0: TOKEN0,
  currency1: TOKEN1,
  fee: 500,
  tickSpacing: 10,
  hooks: ethers.ZeroAddress,
};
const V4_POOL_ID = v4PoolId(V4_KEY);

const multicallIface = new ethers.Interface([
  "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success, bytes returnData)[] returnData)",
]);
const v2Iface = new ethers.Interface([
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function factory() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);
const v3Iface = new ethers.Interface([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 a, uint16 b, uint16 c, uint8 d, bool e)",
  "function liquidity() view returns (uint128)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);
const v4StateViewIface = new ethers.Interface([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
]);
const tickLensIface = new ethers.Interface([
  "function getPopulatedTicksInWord(address pool, int16 tickBitmapIndex) view returns ((int24 tick,int128 liquidityNet,uint128 liquidityGross)[])",
]);

async function main(): Promise<void> {
  let aggregateCalls = 0;
  let mutableCalls = 0;
  let tickCalls = 0;

  const provider = {
    async call(req: { to?: string; data?: string; blockTag?: number }): Promise<string> {
      assert(req.to?.toLowerCase() === MULTICALL3.toLowerCase(), `provider must only call Multicall3`);
      assert(req.blockTag === 123, `aggregate must be pinned to block 123`);
      aggregateCalls++;
      const calls = multicallIface.decodeFunctionData("aggregate3", req.data ?? "0x")[0] as Array<{
        target: string;
        callData: string;
      }>;
      const returnData = calls.map((call) => {
        const target = call.target.toLowerCase();
        const selector = call.callData.slice(0, 10);
        if (target === TICK_LENS.toLowerCase()) {
          tickCalls++;
          return {
            success: true,
            returnData: tickLensIface.encodeFunctionResult("getPopulatedTicksInWord", [[]]),
          };
        }
        mutableCalls++;
        if (target === V2_POOL.toLowerCase()) {
          return { success: true, returnData: encodeV2(selector) };
        }
        if (target === V3_POOL.toLowerCase()) {
          return { success: true, returnData: encodeV3(selector) };
        }
        if (target === ADDR.UNISWAP_V4_STATE_VIEW.toLowerCase()) {
          return { success: true, returnData: encodeV4(selector) };
        }
        return { success: false, returnData: "0x" };
      });
      return multicallIface.encodeFunctionResult("aggregate3", [returnData]);
    },
  } as unknown as ethers.JsonRpcProvider;

  const cache = new PoolStateCache(provider);
  const updater = new PoolStateUpdater(provider, cache, {
    maxPools: 8,
    maxV3TickPoolsPerBlock: 1,
    awaitTickRefreshForTest: true,
  });
  await updater.update(123, [
    { adapterId: "univ2-swap", target: V2_POOL, tokenIn: TOKEN0, tokenOut: TOKEN1, amountIn: 10_000n },
    { adapterId: "univ3-swap", target: V3_POOL, tokenIn: TOKEN0, tokenOut: TOKEN1, amountIn: 10_000n },
    {
      adapterId: "univ4-unlock",
      target: ADDR.UNISWAP_V4_POOL_MANAGER,
      tokenIn: TOKEN0,
      tokenOut: TOKEN1,
      amountIn: 10_000n,
      v4PoolKey: V4_KEY,
    },
  ]);
  assert(aggregateCalls === 2, `expected mutable aggregate + tick aggregate, got ${aggregateCalls}`);
  assert(mutableCalls === 12, `expected 12 mutable/static subcalls, got ${mutableCalls}`);
  assert(tickCalls > 0, `expected TickLens subcalls in aggregate`);
  const v4 = cache.snapshotV4(V4_POOL_ID, 123);
  assert(v4?.sqrtPriceX96 === SQRT_PRICE_1_1, "v4 slot0 seeded by PoolStateUpdater");
  assert(v4?.liquidity === 10n ** 18n, "v4 liquidity seeded by PoolStateUpdater");

  const noState = {
    async call(): Promise<string> {
      throw new Error("state.call should not be reached after updater seed");
    },
  } as unknown as StateBackend;
  cache.beginHint(123);
  const v2Out = await cache.quoteV2(noState, V2_POOL, TOKEN0, TOKEN1, 10_000n);
  const v3Out = await cache.quoteV3(noState, V3_POOL, TOKEN0, TOKEN1, 1_000n);
  // The mocked factory() is the fork-swap-verified 0.25% fork, so the updater must
  // resolve it end-to-end to 25bps (proves factory()→feeBps→quote wiring for a
  // real non-30 fee, not just the default).
  const expectedV2Out = quoteV2ExactInput(2_000_000n, 1_000_000n, 10_000n, 25n);
  assert(v2Out === expectedV2Out, `seeded v2 quote ${v2Out} != ${expectedV2Out}`);
  assert(v3Out > 0n, `seeded v3 quote should produce output`);
  console.log("[pool-updater] multicall seed + local quote: PASS");
}

function encodeV2(selector: string): string {
  if (selector === v2Iface.getFunction("token0")!.selector) {
    return v2Iface.encodeFunctionResult("token0", [TOKEN0]);
  }
  if (selector === v2Iface.getFunction("token1")!.selector) {
    return v2Iface.encodeFunctionResult("token1", [TOKEN1]);
  }
  if (selector === v2Iface.getFunction("factory")!.selector) {
    return v2Iface.encodeFunctionResult("factory", [PANCAKE_V2_FACTORY]);
  }
  if (selector === v2Iface.getFunction("getReserves")!.selector) {
    return v2Iface.encodeFunctionResult("getReserves", [2_000_000n, 1_000_000n, 0]);
  }
  return "0x";
}

function encodeV3(selector: string): string {
  if (selector === v3Iface.getFunction("token0")!.selector) {
    return v3Iface.encodeFunctionResult("token0", [TOKEN0]);
  }
  if (selector === v3Iface.getFunction("token1")!.selector) {
    return v3Iface.encodeFunctionResult("token1", [TOKEN1]);
  }
  if (selector === v3Iface.getFunction("fee")!.selector) {
    return v3Iface.encodeFunctionResult("fee", [500]);
  }
  if (selector === v3Iface.getFunction("tickSpacing")!.selector) {
    return v3Iface.encodeFunctionResult("tickSpacing", [1]);
  }
  if (selector === v3Iface.getFunction("slot0")!.selector) {
    return v3Iface.encodeFunctionResult("slot0", [SQRT_PRICE_1_1, 0n, 0, 0, 0, 0, false]);
  }
  if (selector === v3Iface.getFunction("liquidity")!.selector) {
    return v3Iface.encodeFunctionResult("liquidity", [10n ** 18n]);
  }
  return "0x";
}

function encodeV4(selector: string): string {
  if (selector === v4StateViewIface.getFunction("getSlot0")!.selector) {
    return v4StateViewIface.encodeFunctionResult("getSlot0", [SQRT_PRICE_1_1, 0, 0, 500]);
  }
  if (selector === v4StateViewIface.getFunction("getLiquidity")!.selector) {
    return v4StateViewIface.encodeFunctionResult("getLiquidity", [10n ** 18n]);
  }
  return "0x";
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
