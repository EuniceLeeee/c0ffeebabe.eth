import { buildDeclarativeExecutionProgram } from "../../declarative-execution.js";
import { compileDeclarativeValues } from "../../declarative-values.js";
import type { InfiniFiBinding } from "./infinifi.js";
import definition from "./infinifi.json";
const values = compileDeclarativeValues(definition);
/** Compatibility signature. Production uses the source-required declaration. */
export function infinifiProgram(binding: Pick<InfiniFiBinding, "vault" | "asset" | "gateway" | "yieldSharing" | "core">,
  executor: string, direction: "deposit" | "redeem", minimumOut = 1n, recipient?: string) {
  return buildDeclarativeExecutionProgram({ ...definition.execution, requireCanonicalSource: false } as any, {
    descriptor: { ...binding, share: binding.vault }, binding, executor, direction,
    recipient: recipient ?? executor, minAmountOut: minimumOut,
    settlementRequested: recipient !== undefined, runtimeEvidence: [],
    route: { tokenIn: direction === "deposit" ? binding.asset : binding.vault,
      tokenOut: direction === "deposit" ? binding.vault : binding.asset },
  }, values);
}
