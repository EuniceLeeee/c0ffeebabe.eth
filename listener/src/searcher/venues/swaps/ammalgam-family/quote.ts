import { quoteAmountOut } from "./math.js";
import { missingAssets, netBalances, quotable } from "./state.js";
import type { Descriptor, Route, State } from "./types.js";

/**
 * Reference quote for one route at one source state, computed with the
 * verified Ammalgam invariant. The production exact path executes the family
 * runtime program in the same state instead; this function is used by tests to
 * cross-check the program and to reproduce an observed transaction's leg.
 */
export function quoteForRoute(
  descriptor: Pick<Descriptor, "pair">,
  route: Pick<Route, "xForY">,
  state: State,
  amountIn: bigint,
): bigint {
  const reason = quotable(state);
  if (reason) throw new Error(reason);
  const net = netBalances(state);
  const missing = missingAssets(state);
  const index = route.xForY ? 0 : 1;
  const other = 1 - index;
  const reserveIn = index === 0 ? state.reserves[0] : state.reserves[1];
  const reserveOut = other === 0 ? state.reserves[0] : state.reserves[1];
  const referenceIn = index === 0 ? state.references[0] : state.references[1];
  const netIn = index === 0 ? net[0] : net[1];
  const netOut = other === 0 ? net[0] : net[1];
  const missingIn = index === 0 ? missing[0] : missing[1];
  const missingOut = other === 0 ? missing[0] : missing[1];
  void descriptor;
  return quoteAmountOut({ amountIn, reserveIn, reserveOut, referenceIn, netIn, netOut, missingIn, missingOut });
}
