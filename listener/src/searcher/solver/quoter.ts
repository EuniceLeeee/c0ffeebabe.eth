import { ethers } from "ethers";
import {
  isStateCallAbortedError,
  type StateBackend,
} from "../../shared/state/state-backend.js";
import type { V4PoolKey } from "../planner/token-graph.js";
import { PRODUCTION_ROUTE_ADAPTERS } from "../venues/production-registry.js";
export { quoteBalancerV3 } from "../venues/swaps/balancer-v3.js";
export {
  metronomeSynthPoolIface,
  quoteGoldxMint,
  quoteMetronomeSynthSwap,
  quoteProtocolLeg,
  quotePSM,
  quoteSiloRedeem,
} from "../venues/protocols/protocol-quote.js";
import type { V4QuotePathStats } from "../venues/route-leg-adapter.js";
export type { V4QuotePathStats } from "../venues/route-leg-adapter.js";
export {
  encodeUniV4QuoteExactInputSingle,
  uniV4QuoterIface,
} from "../venues/swaps/univ4.js";
import type { PoolStateCache } from "./pool-state-cache.js";

/**
 * Quoter — per-protocol amountOut estimation on the current fork state.
 * Returns "what would amountIn give you if you swapped right now".
 *
 * Used by amount-propagation to chain swap amounts through a path,
 * which then feeds solver's binary-search over flashAmount.
 *
 * Curve / UniV3 have on-chain quoters. Protocols without an exact quote or
 * dry-run path fail-fast here instead of emitting placeholder amounts.
 */

const FLUID_DEX_RESOLVER_ENV = "FLUID_DEX_RESOLVER";
export const FLUID_DEX_ADDRESS_DEAD = "0x000000000000000000000000000000000000dEaD";

type CallBackend = Pick<StateBackend, "call">;

// ── Fluid DEX T1 ------------------------------------------------

export const fluidDexSwapIface = new ethers.Interface([
  "function swapIn(bool swap0to1_, uint256 amountIn_, uint256 amountOutMin_, address to_) payable returns (uint256 amountOut_)",
]);

export const fluidDexResolverIface = new ethers.Interface([
  "function estimateSwapIn(address dex_, bool swap0to1_, uint256 amountIn_, uint256 amountOutMin_) payable returns (uint256 amountOut_)",
]);

export function fluidDexSwap0To1(
  tokenIn: string,
  tokenOut: string,
  poolToken0: string | undefined,
  poolToken1: string | undefined,
): boolean {
  if (!poolToken0 || !poolToken1) {
    throw new Error(`fluid-dex quote missing pool token order for ${tokenIn} -> ${tokenOut}`);
  }
  const inLower = tokenIn.toLowerCase();
  const outLower = tokenOut.toLowerCase();
  const t0 = poolToken0.toLowerCase();
  const t1 = poolToken1.toLowerCase();
  if (inLower === t0 && outLower === t1) return true;
  if (inLower === t1 && outLower === t0) return false;
  throw new Error(
    `fluid-dex tokens ${tokenIn} -> ${tokenOut} do not match pool tokens ${poolToken0} / ${poolToken1}`,
  );
}

export async function quoteFluidDex(
  state: CallBackend,
  pool: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  poolToken0: string | undefined,
  poolToken1: string | undefined,
): Promise<bigint> {
  const swap0to1 = fluidDexSwap0To1(tokenIn, tokenOut, poolToken0, poolToken1);
  const resolver = configuredFluidDexResolver();
  if (resolver) {
    try {
      const data = fluidDexResolverIface.encodeFunctionData("estimateSwapIn", [
        pool,
        swap0to1,
        amountIn,
        0n,
      ]);
      const result = await state.call({ to: resolver, data });
      const decoded = fluidDexResolverIface.decodeFunctionResult("estimateSwapIn", result);
      return BigInt(decoded[0]);
    } catch (error) {
      if (isStateCallAbortedError(error)) throw error;
      // Resolver deployments vary by environment. Fall through to the pool's
      // documented ADDRESS_DEAD estimate path if the configured resolver is not usable.
    }
  }

  return quoteFluidDexViaPoolEstimate(state, pool, swap0to1, amountIn);
}

function configuredFluidDexResolver(): string | null {
  const raw = process.env[FLUID_DEX_RESOLVER_ENV];
  if (!raw) return null;
  try {
    const addr = ethers.getAddress(raw);
    return addr === ethers.ZeroAddress ? null : addr;
  } catch {
    return null;
  }
}

async function quoteFluidDexViaPoolEstimate(
  state: CallBackend,
  pool: string,
  swap0to1: boolean,
  amountIn: bigint,
): Promise<bigint> {
  const data = fluidDexSwapIface.encodeFunctionData("swapIn", [
    swap0to1,
    amountIn,
    0n,
    FLUID_DEX_ADDRESS_DEAD,
  ]);
  try {
    const result = await state.call({ to: pool, data });
    const decoded = fluidDexSwapIface.decodeFunctionResult("swapIn", result);
    return BigInt(decoded[0]);
  } catch (err) {
    const revertData = extractRevertData(err);
    const decoded = decodeFluidDexEstimateRevert(revertData);
    if (decoded !== null) return decoded;
    throw err;
  }
}

function extractRevertData(err: unknown): string | null {
  const seen = new Set<unknown>();
  const stack: unknown[] = [err];
  while (stack.length > 0) {
    const value = stack.pop();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    if (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value)) return value;
    if (typeof value !== "object") continue;
    const obj = value as Record<string, unknown>;
    for (const key of ["data", "error", "info", "body", "payload"]) {
      const next = obj[key];
      if (typeof next === "string" && /^0x[0-9a-fA-F]+$/.test(next)) return next;
      if (next && typeof next === "object") stack.push(next);
    }
  }
  return null;
}

function decodeFluidDexEstimateRevert(data: string | null): bigint | null {
  if (!data || data === "0x") return null;
  try {
    const decoded = fluidDexSwapIface.decodeFunctionResult("swapIn", data);
    return BigInt(decoded[0]);
  } catch {
    // ADDRESS_DEAD estimates are intentionally surfaced through revert data.
  }
  const raw = data.startsWith("0x") ? data.slice(2) : data;
  if (raw.length < 64) return null;
  try {
    const lastWord = `0x${raw.slice(raw.length - 64)}`;
    return BigInt(lastWord);
  } catch {
    return null;
  }
}

// ── Dispatch ───────────────────────────────────────────────────

export async function quote(
  adapterId: string,
  target: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  state: StateBackend,
  cache?: PoolStateCache,
  v4PoolKey?: V4PoolKey,
  poolToken0?: string,
  poolToken1?: string,
  v4QuoteStats?: V4QuotePathStats,
): Promise<bigint> {
  if (amountIn <= 0n) return 0n;
  const routeAdapter = PRODUCTION_ROUTE_ADAPTERS.routeLegs.findForEdge(adapterId);
  if (routeAdapter) {
    return routeAdapter.quoteExact({
      state,
      target,
      edgeAdapterId: adapterId,
      amountIn,
      tokenIn,
      tokenOut,
      cache,
      v4PoolKey,
      v4QuoteStats,
    });
  }
  switch (adapterId) {
    case "fluid-dex-swap":
      return quoteFluidDex(state, target, tokenIn, tokenOut, amountIn, poolToken0, poolToken1);
    default:
      throw new Error(`no quoter for adapter ${adapterId}`);
  }
}
