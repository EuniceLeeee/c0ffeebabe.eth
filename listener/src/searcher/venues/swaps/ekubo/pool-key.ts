import { ethers } from "ethers";
import { ADDR } from "../../../../shared/constants/addresses.js";
import type { RouteImmutableBinding } from "../../route-immutable-binding.js";
import {
  createRouteImmutableBinding,
  validateRouteImmutableBinding,
} from "../../route-immutable-binding.js";

export const EKUBO_MEV_CAPTURE_EXTENSION =
  "0x5555ff9ff2757500bf4ee020dcfd0210cffa41be";
export const EKUBO_ORACLE_EXTENSION =
  "0x517e506700271aea091b02f42756f5e174af5230";
export const EKUBO_TWAMM_EXTENSION =
  "0xd4f1060cb9c1a13e1d2d20379b8aa2cf7541ed9b";
export const EKUBO_LEGACY_TWAMM_EXTENSION =
  "0xd47f1b1edcfeabb08f6ebd8fc337c27e636c75ba";
export const EKUBO_POOL_KEY_SCHEMA = "ekubo.pool-key.v1";

export type EkuboPoolVariant =
  | "base"
  | "mev-capture"
  | "oracle"
  | "twamm-current"
  | "twamm-legacy"
  | "extension";

export interface EkuboPoolKey {
  readonly token0: string;
  readonly token1: string;
  readonly config: string;
}

const abi = ethers.AbiCoder.defaultAbiCoder();

export function normalizeEkuboPoolKey(
  input: EkuboPoolKey,
): EkuboPoolKey {
  const token0 = ethers.getAddress(input.token0);
  const token1 = ethers.getAddress(input.token1);
  if (BigInt(token0) >= BigInt(token1)) {
    throw new Error("Ekubo PoolKey tokens must be strictly sorted");
  }
  const config = normalizeBytes32(input.config, "Ekubo PoolKey config");
  return Object.freeze({ token0, token1, config });
}

export function createEkuboPoolKeyBinding(
  input: EkuboPoolKey,
): RouteImmutableBinding {
  const poolKey = normalizeEkuboPoolKey(input);
  return createRouteImmutableBinding(
    EKUBO_POOL_KEY_SCHEMA,
    abi.encode(
      ["address", "address", "bytes32"],
      [poolKey.token0, poolKey.token1, poolKey.config],
    ),
  );
}

export function decodeEkuboPoolKeyBinding(
  binding: RouteImmutableBinding,
): EkuboPoolKey {
  const validated = validateRouteImmutableBinding(
    binding,
    EKUBO_POOL_KEY_SCHEMA,
  );
  if ((validated.payload.length - 2) / 2 !== 96) {
    throw new Error("Ekubo PoolKey binding must contain exactly three ABI words");
  }
  const decoded = abi.decode(
    ["address", "address", "bytes32"],
    validated.payload,
  );
  const poolKey = normalizeEkuboPoolKey({
    token0: String(decoded[0]),
    token1: String(decoded[1]),
    config: String(decoded[2]),
  });
  const canonical = createEkuboPoolKeyBinding(poolKey);
  if (canonical.payload !== validated.payload || canonical.hash !== validated.hash) {
    throw new Error("Ekubo PoolKey binding is not canonical ABI encoding");
  }
  return poolKey;
}

export function ekuboPoolId(input: EkuboPoolKey): string {
  const poolKey = normalizeEkuboPoolKey(input);
  return ethers.keccak256(
    abi.encode(
      ["address", "address", "bytes32"],
      [poolKey.token0, poolKey.token1, poolKey.config],
    ),
  ).toLowerCase();
}

/**
 * Labels known extensions for evidence and diagnostics only. Pool admission is
 * derived from the Core PoolInitialized event and the complete PoolKey hash;
 * an unknown extension remains a valid, independently identified Core pool.
 */
export function ekuboPoolVariant(config: string): EkuboPoolVariant {
  const extension = ekuboPoolExtension(config).toLowerCase();
  if (extension === ethers.ZeroAddress.toLowerCase()) return "base";
  if (extension === EKUBO_MEV_CAPTURE_EXTENSION.toLowerCase()) {
    return "mev-capture";
  }
  if (extension === EKUBO_ORACLE_EXTENSION.toLowerCase()) return "oracle";
  if (extension === EKUBO_TWAMM_EXTENSION.toLowerCase()) {
    return "twamm-current";
  }
  if (extension === EKUBO_LEGACY_TWAMM_EXTENSION.toLowerCase()) {
    return "twamm-legacy";
  }
  return "extension";
}

export function ekuboPoolExtension(config: string): string {
  const normalized = normalizeBytes32(config, "Ekubo PoolKey config");
  return ethers.getAddress(`0x${normalized.slice(2, 42)}`);
}

export function ekuboGraphToken(token: string): string {
  const normalized = ethers.getAddress(token);
  return normalized === ethers.ZeroAddress ? ADDR.WETH : normalized;
}

export function ekuboDirection(
  tokenIn: string,
  tokenOut: string,
  input: EkuboPoolKey,
): boolean {
  const poolKey = normalizeEkuboPoolKey(input);
  const graph0 = ekuboGraphToken(poolKey.token0).toLowerCase();
  const graph1 = ekuboGraphToken(poolKey.token1).toLowerCase();
  const inputToken = ethers.getAddress(tokenIn).toLowerCase();
  const outputToken = ethers.getAddress(tokenOut).toLowerCase();
  if (inputToken === graph0 && outputToken === graph1) return false;
  if (inputToken === graph1 && outputToken === graph0) return true;
  throw new Error(
    `tokens ${tokenIn} -> ${tokenOut} do not match the Ekubo PoolKey`,
  );
}

function normalizeBytes32(value: string, label: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${label} must be bytes32`);
  }
  return value.toLowerCase();
}
