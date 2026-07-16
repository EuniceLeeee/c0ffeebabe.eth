import { ethers } from "ethers";
import { ADDR } from "../../../shared/constants/addresses.js";
import type { V4PoolKey } from "../../planner/token-graph.js";

const V4_POOLKEY_TUPLE =
  "tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)";
const V4_SWAP_HOOK_MASK = 0xccn;

export function v4PoolId(key: V4PoolKey): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      [V4_POOLKEY_TUPLE],
      [[key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]],
    ),
  ).toLowerCase();
}

export function v4HooksAffectSwap(hooks: string): boolean {
  return (BigInt(hooks) & V4_SWAP_HOOK_MASK) !== 0n;
}

export function normalizeV4PoolKey(poolKey: V4PoolKey, context: string): V4PoolKey {
  return {
    currency0: normalizeV4Currency(poolKey.currency0, "currency0", context),
    currency1: normalizeV4Currency(poolKey.currency1, "currency1", context),
    fee: uint24(poolKey.fee, "fee", context),
    tickSpacing: int24(poolKey.tickSpacing, "tickSpacing", context),
    hooks: normalizeV4Currency(poolKey.hooks, "hooks", context),
  };
}

export function normalizeV4Currency(value: string, field: string, context: string): string {
  if (value.toLowerCase() === "0x0") return ethers.ZeroAddress;
  try {
    return ethers.getAddress(value);
  } catch {
    throw new Error(`${context}: ${field} must be an address or 0x0, got ${value}`);
  }
}

export function realV4Currency(
  token: string,
  key: V4PoolKey,
  field: string,
  context: string,
): string {
  const normalized = normalizeV4Currency(token, field, context);
  if (normalized.toLowerCase() === key.currency0.toLowerCase()) return key.currency0;
  if (normalized.toLowerCase() === key.currency1.toLowerCase()) return key.currency1;

  const c0Native = key.currency0.toLowerCase() === ethers.ZeroAddress.toLowerCase();
  const c1Native = key.currency1.toLowerCase() === ethers.ZeroAddress.toLowerCase();
  if (c0Native !== c1Native && normalized.toLowerCase() === ADDR.WETH.toLowerCase()) {
    return c0Native ? key.currency0 : key.currency1;
  }

  throw new Error(
    `${context}: ${field} ${token} does not match PoolKey ${key.currency0} / ${key.currency1}`,
  );
}

export function validateV4CurrencyPair(
  realIn: string,
  realOut: string,
  key: V4PoolKey,
  context: string,
): void {
  const resolved = [realIn.toLowerCase(), realOut.toLowerCase()].sort().join("/");
  const poolPair = [key.currency0.toLowerCase(), key.currency1.toLowerCase()].sort().join("/");
  if (resolved !== poolPair) {
    throw new Error(
      `${context}: resolved pair ${realIn} / ${realOut} does not match PoolKey ` +
        `${key.currency0} / ${key.currency1}`,
    );
  }
}

export function rejectNativeWethV4Pool(key: V4PoolKey, context: string): void {
  const c0 = key.currency0.toLowerCase();
  const c1 = key.currency1.toLowerCase();
  const weth = ADDR.WETH.toLowerCase();
  const zero = ethers.ZeroAddress.toLowerCase();
  if ((c0 === zero && c1 === weth) || (c1 === zero && c0 === weth)) {
    throw new Error(`${context}: native/WETH v4 pool not supported (ambiguous alias)`);
  }
}

export function uint24(value: number, field: string, context: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffff) {
    throw new Error(`${context}: ${field} must be a uint24, got ${value}`);
  }
  return value;
}

export function int24(value: number, field: string, context: string): number {
  if (!Number.isInteger(value) || value < -0x800000 || value > 0x7fffff) {
    throw new Error(`${context}: ${field} must be an int24, got ${value}`);
  }
  return value;
}
