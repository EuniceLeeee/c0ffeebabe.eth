import type { ExactTrialStateRef } from "../adapter-family-plugin.js";
import { hashCanonical } from "../canonical-value.js";
import type { V3PoolState } from "../../solver/v3-math.js";
import { storageState, tokenBalanceState } from "./resources.js";

/** Shared by direct pool quotes and protocols executing that same pool internally.
 * The central runtime only handles the opaque ref, never this pricing model. */
export interface V3TrialBinding {
  readonly pool: string;
  readonly token0: string;
  readonly token1: string;
  readonly fee: bigint;
  readonly tickSpacing: number;
}

export function v3TrialStateRef(binding: V3TrialBinding): ExactTrialStateRef {
  const pool = binding.pool.toLowerCase(), token0 = binding.token0.toLowerCase(), token1 = binding.token1.toLowerCase();
  if (![pool, token0, token1].every(address => /^0x[0-9a-f]{40}$/.test(address)) || token0 >= token1 ||
      binding.fee < 0n || binding.fee >= 1_000_000n || !Number.isInteger(binding.tickSpacing) || binding.tickSpacing <= 0) {
    throw new Error("invalid shared V3 state binding");
  }
  return Object.freeze({ key: `pool:${pool}`, schema: "v3-pool-state-v1",
    dependencies: [storageState(pool)],
    binding: hashCanonical({ pool, token0, token1, fee: binding.fee, tickSpacing: binding.tickSpacing }) });
}

export function v3TrialStateEffects(binding: V3TrialBinding, executor?: string): readonly string[] {
  return [storageState(binding.pool), tokenBalanceState(binding.token0, binding.pool),
    tokenBalanceState(binding.token1, binding.pool), ...(executor === undefined ? [] :
      [tokenBalanceState(binding.token0, executor), tokenBalanceState(binding.token1, executor)])];
}

export function readV3TrialState(view: { get(ref: ExactTrialStateRef): unknown } | undefined,
  binding: V3TrialBinding): V3PoolState | undefined {
  const value = view?.get(v3TrialStateRef(binding));
  if (value === undefined) return undefined;
  const state = value as V3PoolState;
  if (!state || typeof state.sqrtPriceX96 !== "bigint" || typeof state.liquidity !== "bigint" ||
      !Number.isInteger(state.tick) || state.fee !== binding.fee || state.tickSpacing !== binding.tickSpacing ||
      !(state.ticks instanceof Map) || !(state.tickBitmap instanceof Map)) {
    throw new Error("invalid shared V3 trial state");
  }
  return state;
}
