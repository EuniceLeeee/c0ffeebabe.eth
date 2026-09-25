import type { AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import { assertSource, callRequest, returnedResult } from "../standard-family/common.js";
import { ABI, ERC20, word, resultSet, calculate } from "./codec.js";
import type { Descriptor } from "./types.js";
// Shared request runtime owns scheduling/memoization. These two state reads
// are independent of amount; the quoter always receives the requested amount.
export function quoteRequests(d: Descriptor, amount: bigint) {
  calculate(amount, d.numerator, d.denominator);
  return [callRequest("halted", d.target, ABI.encodeFunctionData("halted")),
    callRequest("inventory", d.tokenOut, ERC20.encodeFunctionData("balanceOf", [d.target])),
    callRequest("amount-quote", d.target, ABI.encodeFunctionData("tokenMigrationAmountToReceive", [amount]))];
}
export function decodeQuote(d: Descriptor, amount: bigint, results: readonly AdapterRequestResult[], expected?: CanonicalSource) {
  const source = resultSet(results, ["halted", "inventory", "amount-quote"]);
  if (expected) assertSource(source, expected);
  const halted = word(returnedResult(results, "halted").data);
  if (halted > 1n) throw new Error("migration invalid boolean");
  const inventory = word(returnedResult(results, "inventory").data);
  const amountOut = word(returnedResult(results, "amount-quote").data);
  if (amountOut !== calculate(amount, d.numerator, d.denominator)) throw new Error("migration chain quote disagrees with bound runtime");
  return Object.freeze({ source, halted: halted === 1n, inventory, amountIn: amount, amountOut });
}
