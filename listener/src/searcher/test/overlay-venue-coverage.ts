import { ethers } from "ethers";
import { detectImpactFromLogs } from "../detector/pool-impact.js";
import { type TokenEdge, type V4PoolKey, v4PoolId } from "../planner/token-graph.js";
import { postImpactSupportsStateOverrides } from "../solver/post-impact-overrides.js";
import type { PostImpactSeed } from "../solver/pool-state-cache.js";
import { FLASH_LEND_SWAP_REPAY, FLASH_SWAP_REPAY } from "../templates/path-template.js";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

const POOL = "0x0000000000000000000000000000000000000c01";
const POOL_MANAGER = "0x000000000004444c5dc75cB358380D2e3dE08A90";
const TOKEN0 = "0x00000000000000000000000000000000000000a0";
const TOKEN1 = "0x00000000000000000000000000000000000000b1";
const SENDER = "0x0000000000000000000000000000000000000aaa";
const RECIPIENT = "0x0000000000000000000000000000000000000bbb";

const V2_IFACE = new ethers.Interface([
  "event Sync(uint112 reserve0,uint112 reserve1)",
  "event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)",
]);
const V3_IFACE = new ethers.Interface([
  "event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)",
]);
const V4_IFACE = new ethers.Interface([
  "event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)",
]);

const V4_KEY: V4PoolKey = {
  currency0: TOKEN0,
  currency1: TOKEN1,
  fee: 3_000,
  tickSpacing: 60,
  hooks: ethers.ZeroAddress,
};
const V4_POOL_ID = v4PoolId(V4_KEY);

const CURVE_DEFERRED = new Set([
  "curve-exchange",
  "curve-exchange-nr",
  "curve-exchange-plain",
  "curve-exchange-received-uint",
]);

function routedSwapVenues(): string[] {
  const out = new Set<string>();
  for (const template of [FLASH_LEND_SWAP_REPAY, FLASH_SWAP_REPAY]) {
    for (const slot of template.slots) {
      if (slot.kind !== "swap") continue;
      for (const adapter of slot.adapters) {
        if (adapter !== "psm") out.add(adapter);
      }
    }
  }
  return [...out].sort();
}

async function hasCaptureBranch(adapterId: string): Promise<boolean> {
  if (adapterId === "univ2-swap") {
    const graph: TokenEdge[] = [{
      adapterId,
      target: POOL,
      tokenIn: TOKEN0,
      tokenOut: TOKEN1,
      slotKind: "swap",
      poolToken0: TOKEN0,
      poolToken1: TOKEN1,
    }];
    const impacts = await detectImpactFromLogs([eventLog(V2_IFACE, "Sync", POOL, [101n, 202n]), eventLog(
      V2_IFACE,
      "Swap",
      POOL,
      [SENDER, 10n, 0n, 0n, 9n, RECIPIENT],
    )], graph);
    return impacts.some((impact) => impact.matchedAdapterId === adapterId && impact.v2PostState !== undefined);
  }

  if (adapterId === "univ3-swap") {
    const graph: TokenEdge[] = [{
      adapterId,
      target: POOL,
      tokenIn: TOKEN0,
      tokenOut: TOKEN1,
      slotKind: "swap",
      poolToken0: TOKEN0,
      poolToken1: TOKEN1,
    }];
    const impacts = await detectImpactFromLogs([eventLog(V3_IFACE, "Swap", POOL, [
      SENDER,
      RECIPIENT,
      10n,
      -9n,
      1n << 96n,
      123n,
      1,
    ])], graph);
    return impacts.some((impact) => impact.matchedAdapterId === adapterId && impact.v3PostState !== undefined);
  }

  if (adapterId === "univ4-unlock") {
    const graph: TokenEdge[] = [{
      adapterId,
      target: POOL_MANAGER,
      tokenIn: TOKEN0,
      tokenOut: TOKEN1,
      slotKind: "swap",
      v4PoolKey: V4_KEY,
      poolId: V4_POOL_ID,
    }];
    const impacts = await detectImpactFromLogs([eventLog(V4_IFACE, "Swap", POOL_MANAGER, [
      V4_POOL_ID,
      SENDER,
      10n,
      -9n,
      1n << 96n,
      123n,
      1,
      3_000,
    ])], graph);
    return impacts.some((impact) => impact.matchedAdapterId === adapterId && impact.v4PostState !== undefined);
  }

  return false;
}

function seedForAdapter(adapterId: string): PostImpactSeed | null {
  if (adapterId === "univ2-swap") {
    return {
      kind: "v2",
      pool: POOL,
      token0: TOKEN0,
      token1: TOKEN1,
      reserve0: 1n,
      reserve1: 2n,
      blockNumber: 1,
    };
  }
  if (adapterId === "univ3-swap") {
    return {
      kind: "v3",
      pool: POOL,
      sqrtPriceX96: 1n << 96n,
      tick: 0,
      liquidity: 1n,
      blockNumber: 1,
    };
  }
  if (adapterId === "univ4-unlock") {
    return {
      kind: "v4",
      poolManager: POOL_MANAGER,
      poolId: V4_POOL_ID,
      sqrtPriceX96: 1n << 96n,
      tick: 0,
      liquidity: 1n,
      lpFee: 3_000,
      blockNumber: 1,
    };
  }
  return null;
}

function eventLog(iface: ethers.Interface, eventName: string, address: string, args: unknown[]) {
  const fragment = iface.getEvent(eventName);
  assert(fragment !== null, `${eventName} event fragment missing`);
  const encoded = iface.encodeEventLog(fragment, args);
  return {
    address,
    topics: [...encoded.topics],
    data: encoded.data,
  };
}

async function main(): Promise<void> {
  const venues = routedSwapVenues();
  assert(venues.length > 0, "no routed swap venues found in path templates");

  const deferred: string[] = [];
  for (const adapterId of venues) {
    if (CURVE_DEFERRED.has(adapterId)) {
      deferred.push(adapterId);
      continue;
    }

    const seed = seedForAdapter(adapterId);
    assert(
      seed !== null,
      `overlay coverage missing exact-overlay seed for routed venue ${adapterId}; ` +
        "add hash-only post-state capture plus postImpactStateOverrides support for this fidelity path",
    );
    assert(
      postImpactSupportsStateOverrides(seed),
      `overlay coverage missing postImpactStateOverrides kind for routed venue ${adapterId}`,
    );
    assert(
      await hasCaptureBranch(adapterId),
      `overlay coverage missing PoolImpact *PostState capture branch for routed venue ${adapterId}`,
    );
    console.log(`[overlay-coverage] ${adapterId}: exact capture + override support PASS`);
  }

  for (const adapterId of deferred) {
    console.log(`[overlay-coverage] ${adapterId}: DEFERRED (curve balances storage layout not safely unified)`);
  }
  console.log(`overlay-venue-coverage PASS (${venues.length - deferred.length} exact, ${deferred.length} deferred)`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
