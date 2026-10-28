import { ethers } from "ethers";
import type { ExactQuoteInput, ExactRequestProgram } from "../../adapter-family-plugin.js";
import { sameAddress, requireSuccessfulResult } from "./codec.js";
import { ALGEBRA_QUOTER_INTERFACE, algebraQuoterGuardRequests, assertAlgebraQuoterGuards, assertAlgebraSource } from "./quoter-model.js";
import type { AlgebraIntegralDescriptor, AlgebraIntegralRoute, AlgebraQuoterExactEvidence } from "./types.js";

type Input = ExactQuoteInput<AlgebraIntegralDescriptor, AlgebraIntegralRoute>;
function validate(input: Input): void {
  const { descriptor: d, route: r } = input;
  if (d.executedFee.kind !== "cypher-bound-quoter" || input.amountIn < 0n || input.amountIn >= (1n << 255n) ||
      r.instanceKey !== d.instanceKey || !sameAddress(r.pool, d.pool) ||
      !sameAddress(r.tokenIn, r.direction === "zero-for-one" ? d.token0 : d.token1) ||
      !sameAddress(r.tokenOut, r.direction === "zero-for-one" ? d.token1 : d.token0) ||
      !["zero-for-one", "one-for-zero"].includes(r.direction) || r.tickSpacing !== d.tickSpacing) {
    throw new Error("algebra Quoter input/route mismatch");
  }
  if (!input.transactionOrigin) throw new Error("algebra Quoter requires the production transaction origin");
  ethers.getAddress(input.transactionOrigin);
  ethers.getAddress(input.executor);
}

export function algebraQuoterQuote(input: Input, amountOut: bigint, reportedLastFee: bigint): {
  amountOut: bigint; evidence: AlgebraQuoterExactEvidence;
} {
  validate(input);
  if (input.descriptor.executedFee.kind !== "cypher-bound-quoter") throw new Error("algebra missing Quoter binding");
  return { amountOut, evidence: { kind: "algebra-integral-bound-quoter", source: input.source,
    pool: input.descriptor.pool, tokenIn: input.route.tokenIn, tokenOut: input.route.tokenOut,
    tickSpacing: input.descriptor.tickSpacing, binding: input.route.bindingRef.fingerprint,
    routeKey: input.route.routeKey, executor: ethers.getAddress(input.executor),
    transactionOrigin: ethers.getAddress(input.transactionOrigin!),
    quoter: input.descriptor.executedFee.quoterBinding.quoter, plugin: input.descriptor.executedFee.plugin,
    amountIn: input.amountIn, amountOut, reportedLastFee, declinedReason: null } };
}

export const algebraQuoterProgram: ExactRequestProgram<AlgebraIntegralDescriptor, AlgebraIntegralRoute, AlgebraQuoterExactEvidence> = {
  requirements: () => ({ transports: ["eth-call", "get-code"], caller: "transaction-origin" }),
  buildRequests(input) {
    validate(input);
    const fee = input.descriptor.executedFee;
    if (fee.kind !== "cypher-bound-quoter") throw new Error("algebra missing Quoter binding");
    if (input.amountIn === 0n) return [];
    return [{ id: "exact-quoter", kind: "eth-call", to: fee.quoterBinding.quoter,
      // This Quoter's deployer parameter is CUSTOM deployer, not poolDeployer.
      data: ALGEBRA_QUOTER_INTERFACE.encodeFunctionData("quoteExactInputSingle", [
        input.route.tokenIn, input.route.tokenOut, ethers.ZeroAddress, input.amountIn, 0n]),
      caller: { kind: "transaction-origin" }, completion: "return-data" },
    ...algebraQuoterGuardRequests(input.descriptor.pool, fee.plugin, fee.quoterBinding)];
  },
  decode({ programInput: input, initialResults, dependentEvidence }) {
    validate(input);
    if (dependentEvidence.length !== 0) throw new Error("algebra unexpected Quoter round");
    if (input.amountIn === 0n) {
      if (initialResults.length) throw new Error("algebra zero quote has remote results");
      return algebraQuoterQuote(input, 0n, 0n);
    }
    const fee = input.descriptor.executedFee;
    if (fee.kind !== "cypher-bound-quoter") throw new Error("algebra missing Quoter binding");
    assertAlgebraSource(initialResults, input.source);
    assertAlgebraQuoterGuards(fee.plugin, fee.quoterBinding, initialResults);
    const data = requireSuccessfulResult(initialResults, "exact-quoter").data;
    if (!ethers.isHexString(data) || ethers.dataLength(data) !== 64) throw new Error("algebra malformed Quoter return");
    const [amountOut, reportedLastFee] = ALGEBRA_QUOTER_INTERFACE.decodeFunctionResult("quoteExactInputSingle", data);
    if (amountOut <= 0n) throw new Error("algebra no positive Quoter output");
    // Output uses real swap/plugin execution, but callback-revert does NOT prove
    // payment, full input consumption or post-swap effects. Execution enforces
    // full debit and the actual receipt floor independently; final sim remains.
    return algebraQuoterQuote(input, BigInt(amountOut), BigInt(reportedLastFee));
  },
};
