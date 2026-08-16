import { ADDR } from "../../shared/constants/addresses.js";
import { setProductionStrictViewsProvider } from
  "../venues/strict-catalog-registry-projection.js";
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
  // F8: the routing graph sources its edges from the committed strict views;
  // V4 hook admission semantics are strict-owned. The fixture commits only
  // the hookless native instance (2 edges); hooked/native-self pools are
  // absent from the committed views and stay retryable at the graph level.
  const source = Object.freeze({
    number: 100,
    hash: "0x" + "00".repeat(32),
    generation: 1,
  });
  const hooklessEdges = [0, 1].map((index) => Object.freeze({
    adapterId: "univ4-unlock",
    target: ADDR.UNISWAP_V4_POOL_MANAGER,
    tokenIn: index === 0 ? ADDR.ZERO : "0xc8Fb80fCc03f699C70ff0CC08C09106288888888",
    tokenOut: index === 0 ? "0xc8Fb80fCc03f699C70ff0CC08C09106288888888" : ADDR.ZERO,
    poolId: hooklessNativePool.poolId!,
    instanceKey: `univ4:${hooklessNativePool.poolId!.toLowerCase()}`,
    slotKind: "swap",
    canonicalEdgeId: `v4-hook-fixture-${index}`,
    v4PoolKey: {
      currency0: ADDR.ZERO,
      currency1: "0xc8Fb80fCc03f699C70ff0CC08C09106288888888",
      fee: 0,
      tickSpacing: 60,
      hooks: ADDR.ZERO,
    },
  }));
  const views = Object.freeze({
    revision: 1,
    source,
    publicationFingerprint: "v4-hook-admission-fixture",
    graphRoutes: Object.freeze([]),
    edges: Object.freeze(hooklessEdges),
    handleByCanonicalEdgeId: new Map(
      hooklessEdges.map((edge) => [
        edge.canonicalEdgeId,
        Object.freeze({
          familyId: "univ4",
          lineageId: "univ4:pool-manager-subinstance",
          candidateKey: edge.instanceKey,
          instanceKey: edge.instanceKey,
          routeKey: `univ4:${edge.poolId!.toLowerCase()}`,
          source,
          generation: 1,
        }),
      ]),
    ),
    pricingByPublicationKey: new Map(),
    fundingByPublicationKey: new Map(),
  });
  setProductionStrictViewsProvider(() =>
    views as unknown as Parameters<typeof setProductionStrictViewsProvider>[0] extends () => infer V ? V : never,
  );
  try {
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
      "hooked pool absent from committed strict views is terminal-known (zero edges)",
    );
    assert(hookless_native_edges === 2, `hookless native pool: expected 2 edges, got ${hookless_native_edges}`);
    assert(
      nativeWeth.edges.length === 0 &&
        nativeWeth.successful.length === 1 &&
        nativeWeth.failed.length === 0,
      "native ETH/WETH alias pool absent from committed strict views is terminal-known",
    );
    assert(
      mixed.edges.length === 2 &&
        mixed.successful.length === 2 &&
        mixed.failed.length === 0,
      "one strict-uncommitted V4 instance must not quarantine a supported sibling",
    );
    const mismatched = await buildTokenGraphWithResults(stubBackend, [{
      ...hookedPool,
      poolId: `0x${"11".repeat(32)}`,
    }]);
    assert(
      mismatched.successful.length === 1 && mismatched.failed.length === 0,
      "PoolKey/poolId mismatch is absent from committed strict views (zero edges)",
    );
    assert(
      ordinaryEmpty.successful.length === 1 && ordinaryEmpty.failed.length === 0,
      "ordinary empty family output is absent from committed strict views (zero edges)",
    );

    console.log(
      `[v4-hook-admission] PASS hooked_edges=${hooked_edges} ` +
        `hookless_native_edges=${hookless_native_edges} ordinary_empty=retryable`,
    );
  } finally {
    setProductionStrictViewsProvider(() => null);
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[v4-hook-admission] FAIL ${msg}`);
  process.exit(1);
});
