import { ethers } from "ethers";
import { isStateCallAbortedError } from "../../shared/state/state-backend.js";

export const CURVE_METAREGISTRY = "0xF98B45FA17DE75FB1aD0e7aFD971b0ca00e379fC";

export interface CurveUnderlyingCallBackend {
  call(req: { to: string; data: string }): Promise<string>;
}

export type CurveUnderlyingMetadataSource =
  | "curve-metaregistry-underlying"
  | "curve-underlying-provisional";

export interface CurveUnderlyingMetadata {
  coins: string[];
  source: CurveUnderlyingMetadataSource;
}

export class CurveUnderlyingMetadataNotApplicableError extends Error {
  readonly code = "CURVE_UNDERLYING_NOT_APPLICABLE";

  constructor(
    message: string,
    readonly kind: "unregistered" | "behavior_mismatch",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CurveUnderlyingMetadataNotApplicableError";
  }
}

export function isCurveUnderlyingMetadataNotApplicableError(
  error: unknown,
): error is CurveUnderlyingMetadataNotApplicableError {
  return error instanceof CurveUnderlyingMetadataNotApplicableError || (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code ===
      "CURVE_UNDERLYING_NOT_APPLICABLE"
  );
}

const metaRegistryIface = new ethers.Interface([
  "function get_registry_handlers_from_pool(address pool) view returns (address[10])",
  "function get_underlying_coins(address pool) view returns (address[8])",
  "function get_coins(address pool) view returns (address[8])",
  "function get_pool_from_lp_token(address token) view returns (address)",
]);
const poolIface = new ethers.Interface([
  "function underlying_coins(int128 i) view returns (address)",
  "function get_dy_underlying(int128 i, int128 j, uint256 dx) view returns (uint256)",
]);
const poolCoinsUintIface = new ethers.Interface([
  "function coins(uint256 i) view returns (address)",
]);
const poolCoinsIntIface = new ethers.Interface([
  "function coins(int128 i) view returns (address)",
]);
const metadataCaches = new WeakMap<object, Map<string, Promise<CurveUnderlyingMetadata>>>();
const CURVE_UNDERLYING_PROBE_AMOUNTS = Object.freeze([
  1n,
  1_000_000n,
  1_000_000_000_000_000_000n,
]);

/**
 * Resolve the complete underlying-token domain from Curve's registry when possible.
 * Registry-uncovered compatible pools may opt into a provisional direct-ABI probe;
 * the source stays explicit and final simulation remains the execution gate.
 */
export async function resolveCurveUnderlyingMetadata(
  backend: CurveUnderlyingCallBackend,
  pool: string,
  options: { allowDirectPoolFallback?: boolean } = {},
): Promise<CurveUnderlyingMetadata> {
  const address = ethers.getAddress(pool);
  const allowDirect = options.allowDirectPoolFallback === true;
  const key = `${address.toLowerCase()}:${allowDirect ? "direct" : "registry"}`;
  let cache = metadataCaches.get(backend as object);
  if (!cache) {
    cache = new Map();
    metadataCaches.set(backend as object, cache);
  }
  let pending = cache.get(key);
  if (!pending) {
    pending = resolveMetadataUncached(backend, address, allowDirect)
      .catch((error) => {
        // Rejections never populate the metadata cache. Transport/deadline
        // failures must be retryable, while a stable negative may change after
        // a proxy upgrade when a long-lived non-pinned backend is used.
        if (cache?.get(key) === pending) {
          cache.delete(key);
        }
        throw error;
      });
    cache.set(key, pending);
  }
  return pending;
}

export async function probeCurveUnderlyingQuote(
  backend: CurveUnderlyingCallBackend,
  pool: string,
  i: number,
  j: number,
): Promise<boolean> {
  for (const amountIn of CURVE_UNDERLYING_PROBE_AMOUNTS) {
    try {
      const raw = await backend.call({
        to: ethers.getAddress(pool),
        data: poolIface.encodeFunctionData("get_dy_underlying", [
          BigInt(i),
          BigInt(j),
          amountIn,
        ]),
      });
      const amountOut = BigInt(
        poolIface.decodeFunctionResult("get_dy_underlying", raw)[0],
      );
      if (amountOut > 0n) return true;
    } catch (error) {
      if (isStateCallAbortedError(error)) throw error;
      if (!isCanonicalBehaviorFailure(error)) throw error;
    }
  }
  return false;
}

export async function quoteCurveUnderlyingByIndex(
  backend: CurveUnderlyingCallBackend,
  pool: string,
  i: number,
  j: number,
  amountIn: bigint,
): Promise<bigint> {
  const raw = await backend.call({
    to: ethers.getAddress(pool),
    data: poolIface.encodeFunctionData("get_dy_underlying", [BigInt(i), BigInt(j), amountIn]),
  });
  return BigInt(poolIface.decodeFunctionResult("get_dy_underlying", raw)[0]);
}

async function resolveMetadataUncached(
  backend: CurveUnderlyingCallBackend,
  pool: string,
  allowDirect: boolean,
): Promise<CurveUnderlyingMetadata> {
  try {
    const handlerRaw = await backend.call({
      to: CURVE_METAREGISTRY,
      data: metaRegistryIface.encodeFunctionData("get_registry_handlers_from_pool", [pool]),
    });
    const handlers = Array.from(
      metaRegistryIface.decodeFunctionResult("get_registry_handlers_from_pool", handlerRaw)[0] as readonly string[],
    );
    if (handlers.some((handler) => ethers.getAddress(handler) !== ethers.ZeroAddress)) {
      const coinsRaw = await backend.call({
        to: CURVE_METAREGISTRY,
        data: metaRegistryIface.encodeFunctionData("get_underlying_coins", [pool]),
      });
      const coins = normalizeCoins(
        Array.from(
          metaRegistryIface.decodeFunctionResult("get_underlying_coins", coinsRaw)[0] as readonly string[],
        ),
      );
      if (coins.length >= 2) {
        return { coins, source: "curve-metaregistry-underlying" };
      }
    }
  } catch (error) {
    if (isStateCallAbortedError(error)) throw error;
    if (!isCanonicalBehaviorFailure(error)) throw error;
  }

  if (!allowDirect) {
    throw new CurveUnderlyingMetadataNotApplicableError(
      `curve-underlying pool ${pool} is not registered in Curve MetaRegistry`,
      "unregistered",
    );
  }
  const explicitUnderlyingCoins = await readCurveCoinDomain(
    backend,
    pool,
    [{
      iface: poolIface,
      functionName: "underlying_coins",
    }],
  );
  if (explicitUnderlyingCoins.length >= 2) {
    if (
      await hasExecutableCurveUnderlyingDirection(
        backend,
        pool,
        explicitUnderlyingCoins.length,
      )
    ) {
      return {
        coins: explicitUnderlyingCoins,
        source: "curve-underlying-provisional",
      };
    }
    throw new CurveUnderlyingMetadataNotApplicableError(
      `curve-underlying pool ${pool} exposes metadata but no executable direction`,
      "behavior_mismatch",
    );
  }

  // Some genuine Curve meta/zap venues expose the executable underlying
  // token domain through coins(...) while omitting underlying_coins(...).
  // A coins getter alone is not enough: pair it with the exact execution
  // selector and calldata semantics owned by this family.
  const poolLevelCoins = await readCurveCoinDomain(
    backend,
    pool,
    [
      { iface: poolCoinsUintIface, functionName: "coins" },
      { iface: poolCoinsIntIface, functionName: "coins" },
    ],
  );
  const compatibleCoins = poolLevelCoins.length < 2
    ? []
    : await expandCurveUnderlyingCoinDomain(
        backend,
        poolLevelCoins,
        new Set([pool.toLowerCase()]),
        0,
      );
  if (compatibleCoins.length > 8) {
    throw new CurveUnderlyingMetadataNotApplicableError(
      `curve-underlying pool ${pool} expanded to ${compatibleCoins.length} ` +
        `coins; maximum supported is 8`,
      "behavior_mismatch",
    );
  }
  if (
    compatibleCoins.length >= 2 &&
    await hasExecutableCurveUnderlyingDirection(
      backend,
      pool,
      compatibleCoins.length,
    )
  ) {
    return {
      coins: compatibleCoins,
      source: "curve-underlying-provisional",
    };
  }
  throw new CurveUnderlyingMetadataNotApplicableError(
    `curve-underlying pool ${pool} exposed no executable underlying token domain`,
    "behavior_mismatch",
  );
}

async function hasExecutableCurveUnderlyingDirection(
  backend: CurveUnderlyingCallBackend,
  pool: string,
  coinCount: number,
): Promise<boolean> {
  for (let i = 0; i < coinCount; i++) {
    for (let j = 0; j < coinCount; j++) {
      if (i === j) continue;
      if (await probeCurveUnderlyingQuote(backend, pool, i, j)) return true;
    }
  }
  return false;
}

async function expandCurveUnderlyingCoinDomain(
  backend: CurveUnderlyingCallBackend,
  poolLevelCoins: readonly string[],
  visitedPools: ReadonlySet<string>,
  depth: number,
): Promise<string[]> {
  if (depth > 3) {
    throw new CurveUnderlyingMetadataNotApplicableError(
      "curve-underlying base-pool expansion exceeded depth 3",
      "behavior_mismatch",
    );
  }
  const mappings = await curveLpMappings(backend, poolLevelCoins);
  const base = mappings[0];
  if (
    mappings.length !== 1 ||
    base === undefined ||
    base.index !== poolLevelCoins.length - 1
  ) {
    throw new CurveUnderlyingMetadataNotApplicableError(
      `curve-underlying pool requires one uniquely proven final base-LP slot; ` +
        `found ${mappings.length}`,
      "behavior_mismatch",
    );
  }
  const baseKey = base.pool.toLowerCase();
  if (visitedPools.has(baseKey)) {
    throw new CurveUnderlyingMetadataNotApplicableError(
      `curve-underlying base-pool cycle at ${base.pool}`,
      "behavior_mismatch",
    );
  }
  const baseDomain = await resolveCurveBaseUnderlyingDomain(
    backend,
    base.pool,
    new Set([...visitedPools, baseKey]),
    depth + 1,
  );
  return normalizeCoins([
    ...poolLevelCoins.slice(0, base.index),
    ...baseDomain,
  ]);
}

async function resolveCurveBaseUnderlyingDomain(
  backend: CurveUnderlyingCallBackend,
  basePool: string,
  visitedPools: ReadonlySet<string>,
  depth: number,
): Promise<string[]> {
  if (depth > 3) {
    throw new CurveUnderlyingMetadataNotApplicableError(
      "curve-underlying base-pool expansion exceeded depth 3",
      "behavior_mismatch",
    );
  }
  const registryUnderlying = await readCurveMetaRegistryDomain(
    backend,
    "get_underlying_coins",
    basePool,
  );
  if (registryUnderlying.length >= 2) return registryUnderlying;

  const registryCoins = await readCurveMetaRegistryDomain(
    backend,
    "get_coins",
    basePool,
  );
  const baseCoins = registryCoins.length >= 2
    ? registryCoins
    : await readCurveCoinDomain(
        backend,
        basePool,
        [
          { iface: poolCoinsUintIface, functionName: "coins" },
          { iface: poolCoinsIntIface, functionName: "coins" },
        ],
      );
  if (baseCoins.length < 2) {
    throw new CurveUnderlyingMetadataNotApplicableError(
      `curve-underlying base pool ${basePool} has no resolvable coin domain`,
      "behavior_mismatch",
    );
  }
  const mappings = await curveLpMappings(backend, baseCoins);
  if (mappings.length === 0) return baseCoins;
  const nested = mappings[0];
  if (
    mappings.length !== 1 ||
    nested === undefined ||
    nested.index !== baseCoins.length - 1
  ) {
    throw new CurveUnderlyingMetadataNotApplicableError(
      `curve-underlying nested base ${basePool} has ambiguous LP layout`,
      "behavior_mismatch",
    );
  }
  const nestedKey = nested.pool.toLowerCase();
  if (visitedPools.has(nestedKey)) {
    throw new CurveUnderlyingMetadataNotApplicableError(
      `curve-underlying base-pool cycle at ${nested.pool}`,
      "behavior_mismatch",
    );
  }
  return normalizeCoins([
    ...baseCoins.slice(0, nested.index),
    ...await resolveCurveBaseUnderlyingDomain(
      backend,
      nested.pool,
      new Set([...visitedPools, nestedKey]),
      depth + 1,
    ),
  ]);
}

async function curveLpMappings(
  backend: CurveUnderlyingCallBackend,
  coins: readonly string[],
): Promise<Array<{ index: number; pool: string }>> {
  const mappings: Array<{ index: number; pool: string }> = [];
  for (let index = 0; index < coins.length; index++) {
    const pool = await curvePoolForLpToken(backend, coins[index]);
    if (pool !== null) mappings.push({ index, pool });
  }
  return mappings;
}

async function curvePoolForLpToken(
  backend: CurveUnderlyingCallBackend,
  token: string,
): Promise<string | null> {
  try {
    const raw = await backend.call({
      to: CURVE_METAREGISTRY,
      data: metaRegistryIface.encodeFunctionData(
        "get_pool_from_lp_token",
        [token],
      ),
    });
    const pool = ethers.getAddress(
      String(
        metaRegistryIface.decodeFunctionResult(
          "get_pool_from_lp_token",
          raw,
        )[0],
      ),
    );
    return pool === ethers.ZeroAddress ? null : pool;
  } catch (error) {
    if (isStateCallAbortedError(error)) throw error;
    if (!isCanonicalBehaviorFailure(error)) throw error;
    return null;
  }
}

async function readCurveMetaRegistryDomain(
  backend: CurveUnderlyingCallBackend,
  functionName: "get_underlying_coins" | "get_coins",
  pool: string,
): Promise<string[]> {
  try {
    const raw = await backend.call({
      to: CURVE_METAREGISTRY,
      data: metaRegistryIface.encodeFunctionData(functionName, [pool]),
    });
    return normalizeCoins(
      Array.from(
        metaRegistryIface.decodeFunctionResult(
          functionName,
          raw,
        )[0] as readonly string[],
      ),
    );
  } catch (error) {
    if (isStateCallAbortedError(error)) throw error;
    if (!isCanonicalBehaviorFailure(error)) throw error;
    return [];
  }
}

type CurveCoinGetter = {
  readonly iface: ethers.Interface;
  readonly functionName: "underlying_coins" | "coins";
};

async function readCurveCoinDomain(
  backend: CurveUnderlyingCallBackend,
  pool: string,
  getters: readonly CurveCoinGetter[],
): Promise<string[]> {
  const coins: string[] = [];
  for (let index = 0; index < 8; index++) {
    let coin: string | null = null;
    for (const getter of getters) {
      try {
        const raw = await backend.call({
          to: pool,
          data: getter.iface.encodeFunctionData(
            getter.functionName,
            [BigInt(index)],
          ),
        });
        coin = ethers.getAddress(
          String(
            getter.iface.decodeFunctionResult(
              getter.functionName,
              raw,
            )[0],
          ),
        );
        break;
      } catch (error) {
        if (isStateCallAbortedError(error)) throw error;
        if (!isCanonicalBehaviorFailure(error)) throw error;
      }
    }
    if (coin === null || coin === ethers.ZeroAddress) break;
    coins.push(coin);
  }
  return normalizeCoins(coins);
}

/**
 * A canonical call revert or malformed ABI result is stable negative behavior
 * evidence at the pinned source block. Provider, HTTP, deadline and connection
 * failures deliberately remain outside this set and therefore retryable.
 */
function isCanonicalBehaviorFailure(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code).toUpperCase()
    : "";
  return new Set([
    "CALL_EXCEPTION",
    "BAD_DATA",
    "INVALID_ARGUMENT",
    "NUMERIC_FAULT",
  ]).has(code);
}

function normalizeCoins(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const coins: string[] = [];
  for (const value of values) {
    const coin = ethers.getAddress(value);
    if (coin === ethers.ZeroAddress) break;
    const key = coin.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    coins.push(coin);
  }
  return coins;
}
