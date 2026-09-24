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
import {
  SequentialQuoteUnsupportedError,
  type StrictProductionExactHandle,
  type StrictProductionRuntimeSession,
} from "../strict-production-runtime-session.js";
import type { RuntimeEvidence } from
  "../venues/adapter-family-plugin.js";
import type { AdapterWorkControl } from "../adapter-work-intent.js";

export interface PropagatedAmounts {
  /** Nominal per-edge amounts in raw-unit mode; legacy BPS retains its haircut. */
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
    /** Raw-unit execution mode (0/1): nominal quotes, no pre-subtracted dust. */
    toleranceRawUnits?: bigint;
    /** Counts strict per-leg exact issuance without changing quote behavior. */
    onExactCall?: () => void;
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
    /** Raw-unit execution mode (0/1): nominal quotes, no pre-subtracted dust. */
    toleranceRawUnits?: bigint;
    /** Counts strict per-leg exact issuance without changing quote behavior. */
    onExactCall?: () => void;
    /** Abort between hops when the solver deadline passes, so a single cold
     *  quote point doesn't run past the TTL uninterrupted. */
    shouldStop?: () => boolean;
  } = {},
): Promise<PropagatedAmounts> {
  const amounts: bigint[] = [flashAmount];
  const rawOutputs: bigint[] = [];
  const exactHandles: StrictProductionExactHandle[] = [];
  let cur = flashAmount;
  const toleranceRawUnits = options.toleranceRawUnits;
  if (toleranceRawUnits !== undefined && toleranceRawUnits !== 0n && toleranceRawUnits !== 1n) {
    throw new Error("propagation tolerance must be 0 or 1 token raw unit");
  }
  const safetyBps = options.safetyBps ?? 10000n;
  // Opaque logical instance/state identities, never singleton contract addresses
  // or protocol IDs. Only repeated-state paths opt into isolated prefix quotes.
  const repeats = (keys: readonly (string | null | undefined)[]) => {
    const known = keys.filter((key): key is string => key !== undefined && key !== null);
    return new Set(known).size !== known.length;
  };
  // A pricing key may be directional; it must not hide a repeated instance.
  const sequential = repeats(path.edges.map(edge => edge.instanceKey)) ||
    repeats(path.edges.map(edge => options.strictSession?.stateKeyForEdge?.(edge)));
  if (toleranceRawUnits === undefined && (safetyBps < 1n || safetyBps > 10000n)) {
    throw new Error("propagation retained output must be in [1, 10000] bps");
  }
  for (const edge of path.edges) {
    if (options.shouldStop?.()) {
      throw new Error(`propagation aborted: deadline reached before edge ${edge.adapterId}`);
    }
    let out: bigint;
    try {
      if (options.strictSession === undefined || options.executor === undefined) {
        throw new Error("amount propagation requires a strict current-source session");
      }
      options.onExactCall?.();
      const exact = await options.strictSession.issueExact({
        edge,
        amountIn: cur,
        executor: options.executor,
        runtimeEvidence: options.runtimeEvidence ?? Object.freeze([]),
        ...(sequential ? { priorQuotes: [...exactHandles] } : {}),
        ...(options.adapterWorkControl === undefined
          ? {}
          : { control: options.adapterWorkControl }),
        ...(options.strictSession.blocksPrefixInversion(edge) &&
            options.fluidDebtBps !== undefined && options.fluidDebtBps > 0n
          ? { creditDebtBps: options.fluidDebtBps }
          : {}),
      });
      out = exact.amountOut;
      exactHandles.push(exact);
    } catch (error) {
      if (
        error instanceof BlockScanFamilyAttributedError ||
        error instanceof SequentialQuoteUnsupportedError ||
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
    const spendable = toleranceRawUnits === undefined
      ? (out * safetyBps) / 10000n
      : out;
    if (spendable <= 0n) {
      // Local amount policy, not a failed Family quote. Never send zero to
      // the next Family and accidentally attribute this rejection to it.
      throw new Error("propagation tolerance left no spendable output");
    }
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
