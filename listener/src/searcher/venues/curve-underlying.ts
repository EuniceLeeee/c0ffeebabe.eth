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

const metaRegistryIface = new ethers.Interface([
  "function get_registry_handlers_from_pool(address pool) view returns (address[10])",
  "function get_underlying_coins(address pool) view returns (address[8])",
]);
const poolIface = new ethers.Interface([
  "function underlying_coins(int128 i) view returns (address)",
  "function get_dy_underlying(int128 i, int128 j, uint256 dx) view returns (uint256)",
]);
const metadataCaches = new WeakMap<object, Map<string, Promise<CurveUnderlyingMetadata>>>();

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
    pending = resolveMetadataUncached(backend, address, allowDirect);
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
  try {
    const raw = await backend.call({
      to: ethers.getAddress(pool),
      data: poolIface.encodeFunctionData("get_dy_underlying", [BigInt(i), BigInt(j), 1n]),
    });
    poolIface.decodeFunctionResult("get_dy_underlying", raw);
    return true;
  } catch (error) {
    if (isStateCallAbortedError(error)) throw error;
    return false;
  }
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
    // Registry-uncovered pools are considered only through the explicit fallback below.
  }

  if (!allowDirect) {
    throw new Error(`curve-underlying pool ${pool} is not registered in Curve MetaRegistry`);
  }
  const coins: string[] = [];
  for (let i = 0; i < 8; i++) {
    try {
      const raw = await backend.call({
        to: pool,
        data: poolIface.encodeFunctionData("underlying_coins", [BigInt(i)]),
      });
      const coin = ethers.getAddress(poolIface.decodeFunctionResult("underlying_coins", raw)[0]);
      if (coin === ethers.ZeroAddress) break;
      coins.push(coin);
    } catch (error) {
      if (isStateCallAbortedError(error)) throw error;
      break;
    }
  }
  if (coins.length < 2) {
    throw new Error(`curve-underlying pool ${pool} exposed fewer than two underlying coins`);
  }
  return { coins: normalizeCoins(coins), source: "curve-underlying-provisional" };
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
