import { ADDR } from "../../shared/constants/addresses.js";
import {
  buildTokenGraph,
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
  fixedTokenIn: ADDR.ZERO,
  fixedTokenOut: "0xc8Fb80fCc03f699C70ff0CC08C09106288888888",
};

async function edgeCount(pool: PoolEntry): Promise<number> {
  return (await buildTokenGraph(stubBackend, [pool])).length;
}

async function main(): Promise<void> {
  const hooked_edges = await edgeCount(hookedPool);
  const hookless_native_edges = await edgeCount(hooklessNativePool);

  assert(hooked_edges === 0, `hooked pool: expected 0 edges, got ${hooked_edges}`);
  assert(hookless_native_edges === 2, `hookless native pool: expected 2 edges, got ${hookless_native_edges}`);

  console.log(
    `[v4-hook-admission] PASS hooked_edges=${hooked_edges} hookless_native_edges=${hookless_native_edges}`,
  );
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[v4-hook-admission] FAIL ${msg}`);
  process.exit(1);
});
