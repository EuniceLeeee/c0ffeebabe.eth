import { fluidMaxBorrowRequest } from "./borrow-math.js";
import type { FluidCreditCapacity } from "./capacity.js";

/** Same debt policy as the operate quote. Capacity rejects the requested input;
 * it never silently lowers debt, changes LTV, or substitutes a smaller P. */
export function fluidLocalBorrowQuote(amountIn: bigint, state: FluidCreditCapacity): bigint {
  const debt = fluidMaxBorrowRequest(amountIn, state);
  if (debt < state.minimumBorrowing) throw new Error("fluid-credit below resolver minimum borrow amount");
  if (debt > state.borrowable) throw new Error("fluid-credit borrow capacity exceeded");
  return debt;
}
