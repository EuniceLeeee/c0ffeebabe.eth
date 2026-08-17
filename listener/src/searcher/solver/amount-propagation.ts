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
import type { V4QuotePathStats } from "./quoter.js";
import type {
  StrictProductionExactHandle,
  StrictProductionRuntimeSession,
} from "../strict-production-runtime-session.js";
import type { RuntimeEvidence } from
  "../venues/adapter-family-plugin.js";
import type { AdapterWorkControl } from "../adapter-work-intent.js";

export interface PropagatedAmounts {
  /** Haircutted per-edge amounts used for downstream sizing and profit checks. */
  amounts: bigint[];
  /** Raw pre-haircut quote output for each edge; rawOutputs[i] is edge i output. */
  rawOutputs: bigint[];
  /** Issuer-sealed exact authority for each edge; consumed unchanged by S4. */
  exactHandles: StrictProductionExactHandle[];
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
    v4QuoteStats?: V4QuotePathStats;
    strictSession?: StrictProductionRuntimeSession;
    runtimeEvidence?: readonly RuntimeEvidence[];
    adapterWorkControl?: AdapterWorkControl;
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
    v4QuoteStats?: V4QuotePathStats;
    strictSession?: StrictProductionRuntimeSession;
    runtimeEvidence?: readonly RuntimeEvidence[];
    adapterWorkControl?: AdapterWorkControl;
    safetyBps?: bigint;
    /** Abort between hops when the solver deadline passes, so a single cold
     *  quote point doesn't run past the TTL uninterrupted. */
    shouldStop?: () => boolean;
  } = {},
): Promise<PropagatedAmounts> {
  const amounts: bigint[] = [flashAmount];
  const rawOutputs: bigint[] = [];
  const exactHandles: StrictProductionExactHandle[] = [];
  let cur = flashAmount;
  const safetyBps = options.safetyBps ?? 10000n;
  for (const edge of path.edges) {
    if (options.shouldStop?.()) {
      throw new Error(`propagation aborted: deadline reached before edge ${edge.adapterId}`);
    }
    let out: bigint;
    try {
      if (options.strictSession === undefined || options.executor === undefined) {
        throw new Error("amount propagation requires a strict current-source session");
      }
      const exact = await options.strictSession.issueExact({
        edge,
        amountIn: cur,
        executor: options.executor,
        runtimeEvidence: options.runtimeEvidence ?? Object.freeze([]),
        ...(options.adapterWorkControl === undefined
          ? {}
          : { control: options.adapterWorkControl }),
        ...(options.strictSession.blocksPrefixInversion(edge)
          ? { creditDebtBps: options.fluidDebtBps }
          : {}),
      });
      out = exact.amountOut;
      exactHandles.push(exact);
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
  return { amounts, rawOutputs, exactHandles };
}

/** Every hop is quoted by the same strict current-source session; no prepared
 * backend or local-math fallback may mint a second exact authority. */
function isControlFailure(error: unknown): boolean {
  return error instanceof Error &&
    /\b(?:abort(?:ed)?|deadline|timed?\s*out|timeout)\b/i.test(error.message);
}

function applySafetyBps(amount: bigint, safetyBps: bigint): bigint {
  return (amount * safetyBps) / 10000n;
}
