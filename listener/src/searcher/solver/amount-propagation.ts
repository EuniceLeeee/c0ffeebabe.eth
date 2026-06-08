import type { StateBackend } from "../../shared/state/state-backend.js";
import type { TokenPath } from "../planner/token-graph.js";
import { quote } from "./quoter.js";

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
  options: { fluidDebtBps?: bigint } = {},
): Promise<bigint[]> {
  const amounts: bigint[] = [flashAmount];
  let cur = flashAmount;
  for (const edge of path.edges) {
    const out = edge.adapterId === "fluid-vault" && options.fluidDebtBps !== undefined
      ? quoteFluidDebtBySearchBps(cur, options.fluidDebtBps)
      : await quote(
        edge.adapterId,
        edge.target,
        edge.tokenIn,
        edge.tokenOut,
        cur,
        state,
      );
    if (out <= 0n) {
      throw new Error(
        `propagation produced zero at edge ${edge.adapterId} ${edge.tokenIn}->${edge.tokenOut}`,
      );
    }
    const spendable = applySafetyBps(out);
    amounts.push(spendable);
    cur = spendable;
  }
  return amounts;
}

function applySafetyBps(amount: bigint): bigint {
  return (amount * 9990n) / 10000n;
}

function quoteFluidDebtBySearchBps(collateralAmount: bigint, debtBps: bigint): bigint {
  return (collateralAmount * debtBps) / 10000n / 10n ** 12n;
}
