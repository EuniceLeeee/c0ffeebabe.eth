import {
  isStateCallAbortedError,
  type StateBackend,
} from "../../shared/state/state-backend.js";
import {
  BlockScanFamilyAttributedError,
  blockScanEdgeFamilyId,
} from "../detector/blockscan-family-budget.js";
import type { TokenEdge, TokenPath } from "../planner/token-graph.js";
import type { PoolStateCache } from "./pool-state-cache.js";
import { quote, type V4QuotePathStats } from "./quoter.js";
import type { QuoteRequest, QuoteResult } from "../live-state-backend.js";
import { PRODUCTION_ADAPTER_FAMILIES } from "../venues/production-registry.js";

export interface AmountQuoteSource {
  quote(req: QuoteRequest): Promise<QuoteResult>;
}

export interface PropagatedAmounts {
  /** Haircutted per-edge amounts used for downstream sizing and profit checks. */
  amounts: bigint[];
  /** Raw pre-haircut quote output for each edge; rawOutputs[i] is edge i output. */
  rawOutputs: bigint[];
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
    executor?: string;
    fluidDebtBps?: bigint;
    cache?: PoolStateCache;
    quoteSource?: AmountQuoteSource;
    v4QuoteStats?: V4QuotePathStats;
    safetyBps?: bigint;
    /** Abort between hops when the solver deadline passes, so a single cold
     *  quote point doesn't run past the TTL uninterrupted. */
    shouldStop?: () => boolean;
  } = {},
): Promise<bigint[]> {
  return (await propagateAmountsWithRawOutputs(path, flashAmount, state, options)).amounts;
}

export async function propagateAmountsWithRawOutputs(
  path: TokenPath,
  flashAmount: bigint,
  state: StateBackend,
  options: {
    executor?: string;
    fluidDebtBps?: bigint;
    cache?: PoolStateCache;
    quoteSource?: AmountQuoteSource;
    v4QuoteStats?: V4QuotePathStats;
    safetyBps?: bigint;
    /** Abort between hops when the solver deadline passes, so a single cold
     *  quote point doesn't run past the TTL uninterrupted. */
    shouldStop?: () => boolean;
  } = {},
): Promise<PropagatedAmounts> {
  const amounts: bigint[] = [flashAmount];
  const rawOutputs: bigint[] = [];
  let cur = flashAmount;
  const safetyBps = options.safetyBps ?? 10000n;
  for (const edge of path.edges) {
    if (options.shouldStop?.()) {
      throw new Error(`propagation aborted: deadline reached before edge ${edge.adapterId}`);
    }
    let out: bigint;
    try {
      const creditFamily = PRODUCTION_ADAPTER_FAMILIES.credits().find(
        (family) => family.edgeAdapterIds.includes(edge.adapterId),
      );
      out = creditFamily && options.fluidDebtBps !== undefined
        ? creditFamily.creditPolicy.quoteOutputByDebtBps(cur, options.fluidDebtBps)
        : await quoteEdge(edge, cur, state, options);
    } catch (error) {
      if (
        error instanceof BlockScanFamilyAttributedError ||
        isStateCallAbortedError(error) ||
        isControlFailure(error)
      ) {
        throw error;
      }
      throw new BlockScanFamilyAttributedError(
        blockScanEdgeFamilyId(edge),
        "amount propagation",
        error,
      );
    }
    if (out <= 0n) {
      throw new BlockScanFamilyAttributedError(
        blockScanEdgeFamilyId(edge),
        "amount propagation",
        new Error(
          `propagation produced zero at edge ${edge.adapterId} ${edge.tokenIn}->${edge.tokenOut}`,
        ),
      );
    }
    rawOutputs.push(out);
    const spendable = applySafetyBps(out, safetyBps);
    amounts.push(spendable);
    cur = spendable;
  }
  return { amounts, rawOutputs };
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
  options: {
    executor?: string;
    cache?: PoolStateCache;
    quoteSource?: AmountQuoteSource;
    v4QuoteStats?: V4QuotePathStats;
  },
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
      edge.poolToken0,
      edge.poolToken1,
      options.v4QuoteStats,
      options.executor,
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
      poolToken0: edge.poolToken0,
      poolToken1: edge.poolToken1,
    })).amountOut;
  }
}

function isControlFailure(error: unknown): boolean {
  return error instanceof Error &&
    /\b(?:abort(?:ed)?|deadline|timed?\s*out|timeout)\b/i.test(error.message);
}

function applySafetyBps(amount: bigint, safetyBps: bigint): bigint {
  return (amount * safetyBps) / 10000n;
}
