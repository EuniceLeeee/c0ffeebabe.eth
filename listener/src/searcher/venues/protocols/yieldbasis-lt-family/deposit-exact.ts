import { ethers } from "ethers";
import { localZeroExactMethod, type ExactQuoteInput, type ExactRequestProgram } from "../../adapter-family-plugin.js";
import { assertYieldBasisLtInvocation } from "./codec.js";
import { decodeDepositProgramReceipt, depositProgramSimulation, DEPOSIT_REQUIREMENTS, DEPOSIT_DEBT_POLICY } from "./deposit.js";
import type { YieldBasisLtDescriptor, YieldBasisLtRoute, YieldBasisLtDepositExactEvidence } from "./types.js";

type Input = ExactQuoteInput<YieldBasisLtDescriptor, YieldBasisLtRoute>;
function check(i: Input) {
  assertYieldBasisLtInvocation(i.descriptor, i.route);
  if (i.route.direction !== "deposit" || typeof i.amountIn !== "bigint" || i.amountIn < 0n || i.amountIn > ethers.MaxUint256)
    throw new Error("Yield Basis deposit Exact invocation");
}
function evidence(i: Input, amountOut: bigint): YieldBasisLtDepositExactEvidence {
  return { kind: "yieldbasis-lt-deposit-receipt", direction: "deposit", source: i.source,
    executor: ethers.getAddress(i.executor), lt: i.descriptor.lt, asset: i.descriptor.asset,
    amountIn: i.amountIn, amountOut, debtPolicy: DEPOSIT_DEBT_POLICY, bindingFingerprint: i.route.bindingRef.fingerprint };
}
/** A single guarded program simulation. Debt is derived inside the transaction
 * from the bound pool's current reserves; no off-chain dependency round and no
 * preview_deposit/linear-mid fallback can manufacture the quoted output. */
export const depositExactProgram: ExactRequestProgram<YieldBasisLtDescriptor, YieldBasisLtRoute, YieldBasisLtDepositExactEvidence> = {
  requirements(i) { check(i); return i.amountIn === 0n ? { transports: [] } : DEPOSIT_REQUIREMENTS; },
  buildRequests(i) {
    check(i);
    return i.amountIn === 0n ? [] : [depositProgramSimulation("deposit-receipt", i.descriptor, i.executor, i.amountIn)];
  },
  decode({ programInput: i, initialResults, dependentEvidence }) {
    check(i);
    if (dependentEvidence.length) throw new Error("Yield Basis deposit has no dependent round");
    if (i.amountIn === 0n) {
      if (initialResults.length) throw new Error("Yield Basis zero deposit has request evidence");
      return { amountOut: 0n, evidence: evidence(i, 0n) };
    }
    const amountOut = decodeDepositProgramReceipt(initialResults, "deposit-receipt", i.descriptor, i.source, i.executor, i.amountIn);
    return { amountOut, evidence: evidence(i, amountOut) };
  },
};
export function depositExactMethods() {
  return [localZeroExactMethod<YieldBasisLtDescriptor, YieldBasisLtRoute, YieldBasisLtDepositExactEvidence>("local-zero", i => {
    check(i); return { amountOut: 0n, evidence: evidence(i, 0n) };
  }), { id: "yieldbasis-lt-deposit-receipt", kind: "request-program" as const, chainAmountQuote: true as const, program: depositExactProgram }];
}
