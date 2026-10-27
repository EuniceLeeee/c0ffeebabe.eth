import { buildDeclarativeExecutionProgram, assertDeclarativeExecutionSource } from "../../declarative-execution.js";
import { compileDeclarativeValues } from "../../declarative-values.js";
import definition from "./custodian.json";
const values = compileDeclarativeValues(definition);
export const assertCustodianExecutionSource = assertDeclarativeExecutionSource;
/** Compatibility signature. Production uses the source-required declaration. */
export function custodianProgram(d: { vault: string; share: string; asset: string }, executor: string,
  direction: "deposit" | "redeem", minimumOut = 1n, recipient = executor, direct = false) {
  return buildDeclarativeExecutionProgram({ ...definition.execution, requireCanonicalSource: false } as any, {
    descriptor: d, binding: d, executor, direction, recipient, minAmountOut: minimumOut,
    settlementRequested: direct, runtimeEvidence: [],
    route: { tokenIn: direction === "deposit" ? d.asset : d.share,
      tokenOut: direction === "deposit" ? d.share : d.asset },
  }, values);
}
export function custodianRedeemProgram(d: { vault: string; share: string; asset: string }, executor: string, minimumOut = 1n) {
  return custodianProgram(d, executor, "redeem", minimumOut);
}
