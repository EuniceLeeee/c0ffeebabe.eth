import type { StateBackend } from "../../shared/state/state-backend.js";
import type { TokenEdge, TokenPath } from "../planner/token-graph.js";
import type { PoolStateCache } from "./pool-state-cache.js";
import { quote } from "./quoter.js";
import type { QuoteRequest, QuoteResult } from "../live-state-backend.js";

export interface AmountQuoteSource {
  quote(req: QuoteRequest): Promise<QuoteResult>;
}

/**
 * Chain quoter calls along a TokenPath: amountIn[i+1] = amountOut[i].
 * Returns the per-edge amounts (length = edges + 1, where amounts[0] is
 * the initial flashAmount and amounts[N] is the final closing-token amount).
 *
 * Throws if any quoter fails (unknown adapter / call revert) — caller
 * (solver) catches and skips this candidate.
 */
export async function propagateAmounts(
  path: TokenPath,
  flashAmount: bigint,
  state: StateBackend,
  options: {
    fluidDebtBps?: bigint;
    cache?: PoolStateCache;
    quoteSource?: AmountQuoteSource;
    safetyBps?: bigint;
    /** Abort between hops when the solver deadline passes, so a single cold
     *  quote point doesn't run past the TTL uninterrupted. */
    shouldStop?: () => boolean;
  } = {},
): Promise<bigint[]> {
  const amounts: bigint[] = [flashAmount];
  let cur = flashAmount;
  const safetyBps = options.safetyBps ?? 10000n;
  for (const edge of path.edges) {
    if (options.shouldStop?.()) {
      throw new Error(`propagation aborted: deadline reached before edge ${edge.adapterId}`);
    }
    const out = edge.adapterId === "fluid-vault" && options.fluidDebtBps !== undefined
      ? quoteFluidDebtBySearchBps(cur, options.fluidDebtBps)
      : await quoteEdge(edge, cur, state, options);
    if (out <= 0n) {
      throw new Error(
        `propagation produced zero at edge ${edge.adapterId} ${edge.tokenIn}->${edge.tokenOut}`,
      );
    }
    const spendable = applySafetyBps(out, safetyBps);
    amounts.push(spendable);
    cur = spendable;
  }
  return amounts;
}

/**
 * Quote one edge, preferring local closed-form math via the quoter (which uses
 * the warmed PoolStateCache for curve/v2/v3, falling back to state.call). The
 * live quoteSource (revm) is only a backstop for adapters/conditions local math
 * can't handle (e.g. V4, or a v3 swap crossing beyond the warmed words). In revm
 * mode `state` is backed by the prepared overlay, so local math reads the same
 * post-victim state the daemon holds — µs per trial instead of a daemon quote.
 */
async function quoteEdge(
  edge: TokenEdge,
  amountIn: bigint,
  state: StateBackend,
  options: { cache?: PoolStateCache; quoteSource?: AmountQuoteSource },
): Promise<bigint> {
  try {
    return await quote(
      edge.adapterId,
      edge.target,
      edge.tokenIn,
      edge.tokenOut,
      amountIn,
      state,
      options.cache,
      edge.v4PoolKey,
    );
  } catch (err) {
    if (!options.quoteSource) throw err;
    return (await options.quoteSource.quote({
      adapterId: edge.adapterId,
      target: edge.target,
      tokenIn: edge.tokenIn,
      tokenOut: edge.tokenOut,
      amountIn,
      v4PoolKey: edge.v4PoolKey,
    })).amountOut;
  }
}

function applySafetyBps(amount: bigint, safetyBps: bigint): bigint {
  return (amount * safetyBps) / 10000n;
}

function quoteFluidDebtBySearchBps(collateralAmount: bigint, debtBps: bigint): bigint {
  return (collateralAmount * debtBps) / 10000n / 10n ** 12n;
}
