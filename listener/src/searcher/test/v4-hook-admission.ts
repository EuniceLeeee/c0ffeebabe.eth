import { ADDR } from "../../shared/constants/addresses.js";
import {
  buildTokenGraph,
  buildTokenGraphWithResults,
  v4PoolId,
  type PoolEntry,
  type TokenQueryBackend,
} from "../planner/token-graph.js";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const stubBackend: TokenQueryBackend = {
  async call() {
    throw new Error("v4 hook admission fixture should not call backend");
  },
};

const hookedPool: PoolEntry = {
  address: ADDR.UNISWAP_V4_POOL_MANAGER,
  adapter: "univ4",
  currency0: "0xb10cc888cb2cce7036f4c7ecad8a57da16161338",
  currency1: ADDR.USDT,
  fee: 3000,
  tickSpacing: 60,
  hooks: "0x0025040f0c0c0eba9daa45db1ad3d7748eeb0fc0",
  poolId: v4PoolId({
    currency0: "0xb10cc888cb2cce7036f4c7ecad8a57da16161338",
    currency1: ADDR.USDT,
    fee: 3000,
    tickSpacing: 60,
    hooks: "0x0025040f0c0c0eba9daa45db1ad3d7748eeb0fc0",
  }),
  fixedTokenIn: "0xb10cc888cb2cce7036f4c7ecad8a57da16161338",
  fixedTokenOut: ADDR.USDT,
};

const hooklessNativePool: PoolEntry = {
  address: ADDR.UNISWAP_V4_POOL_MANAGER,
  adapter: "univ4",
  currency0: ADDR.ZERO,
  currency1: "0xc8Fb80fCc03f699C70ff0CC08C09106288888888",
  fee: 0,
  tickSpacing: 60,
  hooks: ADDR.ZERO,
  poolId: v4PoolId({
    currency0: ADDR.ZERO,
    currency1: "0xc8Fb80fCc03f699C70ff0CC08C09106288888888",
    fee: 0,
    tickSpacing: 60,
    hooks: ADDR.ZERO,
  }),
  fixedTokenIn: ADDR.ZERO,
  fixedTokenOut: "0xc8Fb80fCc03f699C70ff0CC08C09106288888888",
};

const nativeWethPool: PoolEntry = {
  address: ADDR.UNISWAP_V4_POOL_MANAGER,
  adapter: "univ4",
  currency0: ADDR.ZERO,
  currency1: ADDR.WETH,
  fee: 500,
  tickSpacing: 10,
  hooks: ADDR.ZERO,
  poolId: v4PoolId({
    currency0: ADDR.ZERO,
    currency1: ADDR.WETH,
    fee: 500,
    tickSpacing: 10,
    hooks: ADDR.ZERO,
  }),
  fixedTokenIn: ADDR.ZERO,
  fixedTokenOut: ADDR.WETH,
};

async function edgeCount(pool: PoolEntry): Promise<number> {
  return (await buildTokenGraph(stubBackend, [pool])).length;
}

async function main(): Promise<void> {
  const hooked = await buildTokenGraphWithResults(stubBackend, [hookedPool]);
  const hooked_edges = hooked.edges.length;
  const hookless_native_edges = await edgeCount(hooklessNativePool);
  const nativeWeth = await buildTokenGraphWithResults(
    stubBackend,
    [nativeWethPool],
  );
  const mixed = await buildTokenGraphWithResults(
    stubBackend,
    [hookedPool, hooklessNativePool],
  );
  const ordinaryEmpty = await buildTokenGraphWithResults(stubBackend, [{
    address: "0x1111111111111111111111111111111111111111",
    adapter: "erc4626-silo-redeem",
  }]);

  assert(hooked_edges === 0, `hooked pool: expected 0 edges, got ${hooked_edges}`);
  assert(
    hooked.successful.length === 1 && hooked.failed.length === 0,
    "typed hook exclusion must be terminal-known rather than retryable",
  );
  assert(hookless_native_edges === 2, `hookless native pool: expected 2 edges, got ${hookless_native_edges}`);
  assert(
    nativeWeth.edges.length === 0 &&
      nativeWeth.successful.length === 1 &&
      nativeWeth.failed.length === 0,
    "native ETH/WETH alias self-edge must be terminal-known and absent",
  );
  assert(
    mixed.edges.length === 2 &&
      mixed.successful.length === 2 &&
      mixed.failed.length === 0,
    "one terminal V4 instance must not quarantine a supported family sibling",
  );
  const mismatched = await buildTokenGraphWithResults(stubBackend, [{
    ...hookedPool,
    poolId: `0x${"11".repeat(32)}`,
  }]);
  assert(
    mismatched.successful.length === 0 && mismatched.failed.length === 1,
    "PoolKey/poolId mismatch must remain fail-closed and retryable",
  );
  assert(
    ordinaryEmpty.successful.length === 0 && ordinaryEmpty.failed.length === 1,
    "ordinary empty family output must remain fail-closed and retryable",
  );

  console.log(
    `[v4-hook-admission] PASS hooked_edges=${hooked_edges} ` +
      `hookless_native_edges=${hookless_native_edges} ordinary_empty=retryable`,
  );
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[v4-hook-admission] FAIL ${msg}`);
  process.exit(1);
});
