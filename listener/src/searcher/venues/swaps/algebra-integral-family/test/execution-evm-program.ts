// Offline FFI for ExecutionSafety.t.sol. Only the protocol/quote are synthetic;
// scripts come from the production Family emitter and run on the real BotVM.
// This is not historical identity, Exact-math, Ready or RPC evidence.
import assert from "node:assert/strict";
import { ethers } from "ethers";
import {
  RuntimeAmountProgram,
  runtimeAmountFlowAdapter,
  runtimeProgramScript,
} from "../../../../../adapters/runtime-amount-program.js";
import { plugin } from "../../../production-families/algebra-integral.production.js";
import type { AlgebraIntegralDescriptor, AlgebraIntegralExactEvidence } from "../types.js";
import { answerFor, candidateFor, identityWith, SOURCE, STATIC_FEE_FACTS } from "./fixtures.js";

const [requestedMode, pool, token0, token1, executor, returnPool, amountText, minimumText, direction, transactionOrigin] = process.argv.slice(2);
const dynamic = requestedMode.endsWith("-quoter"), mode = requestedMode.replace(/-quoter$/, "");
assert(["quoted", "runtime", "flow"].includes(mode) && ["0", "1"].includes(direction));
const amount = BigInt(amountText), minimum = BigInt(minimumText);
const facts = { ...STATIC_FEE_FACTS, pool, token0, token1, reversePool: pool };
const identity = identityWith(answerFor({ facts }), candidateFor(facts));
const staticDescriptor = plugin.instance.finalizeDescriptor({
  identity, draft: plugin.instance.compileDraft(identity), sharedBindings: [],
});
// Synthetic admitted descriptor/evidence only; no claim to dynamic identity or
// Quoter correctness. The same production execution guard must handle either.
const descriptor: AlgebraIntegralDescriptor = dynamic ? { ...staticDescriptor, executedFee: {
  ...staticDescriptor.executedFee, kind: "cypher-bound-quoter", plugin: "0x0000000000000000000000000000000000000007",
  quoterBinding: { quoter: "0x0000000000000000000000000000000000000008",
    quoterCodeHash: `0x${"11".repeat(32)}`, poolDeployer: pool,
    pluginCodeHash: `0x${"22".repeat(32)}`, pluginFactory: pool },
} } : staticDescriptor;
const route = plugin.routes.project({ descriptor })[Number(direction)];
assert(route);
const input = { descriptor, route, source: SOURCE, executor, transactionOrigin, runtimeEvidence: [] };
let script: Uint8Array;
if (mode === "quoted") {
  // Deliberately fixed synthetic quote. The pool can return this same nominal
  // output while crediting less, so only independent EVM balance deltas pass.
  const amountOut = 2n * amount;
  const exactEvidence: AlgebraIntegralExactEvidence = descriptor.executedFee.kind === "cypher-bound-quoter" ? {
    kind: "algebra-integral-bound-quoter", source: SOURCE, pool,
    tokenIn: route.tokenIn, tokenOut: route.tokenOut, tickSpacing: descriptor.tickSpacing,
    binding: route.bindingRef.fingerprint, routeKey: route.routeKey, executor, transactionOrigin,
    quoter: descriptor.executedFee.quoterBinding.quoter, plugin: descriptor.executedFee.plugin,
    amountIn: amount, amountOut, reportedLastFee: 999n, declinedReason: null,
  } : {
    kind: "algebra-integral-single-range", source: SOURCE, pool,
    tokenIn: route.tokenIn, tokenOut: route.tokenOut, tickSpacing: descriptor.tickSpacing,
    executedFee: descriptor.executedFee.fee, feeProvenance: "algebra-static-last-fee",
    pluginFeeProvenance: "structurally-zero-without-dynamic-fee-flag",
    pluginConfig: descriptor.executedFee.pluginConfig, amountIn: amount, amountOut,
    sqrtPriceX96Before: 1n << 96n, sqrtPriceX96After: 1n << 96n,
    rangeBoundTick: 0, rangeBoundSqrtPriceX96: 1n << 96n, declinedReason: null,
  };
  const fragment = plugin.execution.buildFragment({
    ...input, amountIn: amount, quotedAmountOut: amountOut, minAmountOut: minimum, exactEvidence,
  });
  assert.equal(fragment.nodes.length, 1);
  script = plugin.actionAdapters[0].encode(fragment.nodes[0] as never, executor, new Uint8Array());
} else {
  for (const key of ["amountIn", "quotedAmountOut", "minAmountOut", "exactEvidence"])
    Object.defineProperty(input, key, { get() { throw new Error(`runtime read off-chain amount: ${key}`); } });
  const leg = plugin.execution.buildRuntimeLeg!(input);
  assert(leg);
  if (mode === "runtime") script = runtimeProgramScript(ethers.getBytes(leg.program), amount);
  else {
    const nextAbi = new ethers.Interface(["function swap(address tokenIn,address tokenOut,uint256 amount)"]);
    const next = new RuntimeAmountProgram().call(returnPool,
      nextAbi.encodeFunctionData("swap", [route.tokenOut, route.tokenIn, 0n]),
      { patches: [{ offset: 68, reg: 0 }] });
    script = runtimeAmountFlowAdapter.encode({
      adapterId: "runtime-amount-flow", target: executor, tokenIn: route.tokenIn, tokenOut: route.tokenIn,
      amount, children: [], params: { minimumReturn: amount, legs: JSON.stringify([
        { tokenIn: route.tokenIn, tokenOut: route.tokenOut, program: leg.program },
        { tokenIn: route.tokenOut, tokenOut: route.tokenIn, program: ethers.hexlify(next.bytes()) },
      ]) },
    } as never, executor, new Uint8Array());
  }
}
process.stdout.write(ethers.hexlify(script));
