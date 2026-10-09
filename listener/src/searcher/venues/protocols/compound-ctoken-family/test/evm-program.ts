// Offline FFI: emit the actual production Family script for the Solidity test.
// No provider, signer, RPC or hand-written replacement VM.
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { runtimeAmountFlowAdapter, RuntimeAmountProgram, runtimeProgramScript } from "../../../../../adapters/runtime-amount-program.js";
import { plugin } from "../../../production-families/compound-ctoken.production.js";
import { CTOKEN_INTERFACE } from "../abi.js";
import { identityWith, SOURCE } from "./fixtures.js";

const [mode, market, underlying, executor, returnPool, amountText, minimumText, rateText, cashText] = process.argv.slice(2);
assert(["quoted", "runtime", "flow"].includes(mode) && cashText !== undefined);
const amount = BigInt(amountText), minimum = BigInt(minimumText);
const identity = { ...identityWith(), subject: ethers.getAddress(market), underlying: ethers.getAddress(underlying) };
const descriptor = plugin.instance.finalizeDescriptor({ identity, draft: plugin.instance.compileDraft(identity), sharedBindings: [] });
const route = plugin.routes.project({ descriptor })[0];
const input = { descriptor, route, source: SOURCE, executor, amountIn: amount, runtimeEvidence: [] };
let script: Uint8Array;
if (mode === "quoted") {
  const method = plugin.exact.methods(input)[1]; assert(method.kind === "request-program");
  const quote = method.program.decode({ programInput: input, dependentEvidence: [],
    initialResults: method.program.buildRequests(input).map(r => ({ id: r.id, ok: true as const, completion: "returned" as const,
      source: SOURCE, provenance: { kind: "synthetic-EVM-state", fingerprint: "not-chain-evidence" },
      data: CTOKEN_INTERFACE.encodeFunctionResult(r.id === "quote-rate-current" ? "exchangeRateCurrent" : "getCash",
        [BigInt(r.id === "quote-rate-current" ? rateText : cashText)]) })) });
  const fragment = plugin.execution.buildFragment({ ...input, quotedAmountOut: quote.amountOut, minAmountOut: minimum, exactEvidence: quote.evidence });
  script = plugin.actionAdapters[0].encode(fragment.nodes[0] as never, executor, new Uint8Array());
} else {
  const runtimeInput = { descriptor, route, source: SOURCE, executor, runtimeEvidence: [] };
  for (const field of ["amountIn", "quotedAmountOut", "minAmountOut", "exactEvidence"])
    Object.defineProperty(runtimeInput, field, { get() { throw new Error("off-chain amount touched: " + field); } });
  const leg = plugin.execution.buildRuntimeLeg!(runtimeInput); assert(leg);
  if (mode === "runtime") script = runtimeProgramScript(ethers.getBytes(leg.program), amount);
  else {
    const returns = new ethers.Interface(["function swap(address underlying,address share,uint256 amount)"]);
    const next = new RuntimeAmountProgram().call(returnPool, returns.encodeFunctionData("swap", [underlying, market, 0n]),
      { patches: [{ offset: 68, reg: 0 }] });
    script = runtimeAmountFlowAdapter.encode({ adapterId: "runtime-amount-flow", target: executor, tokenIn: market, tokenOut: market,
      amount, children: [], params: { minimumReturn: amount, legs: JSON.stringify([
        { tokenIn: market, tokenOut: underlying, program: leg.program },
        { tokenIn: underlying, tokenOut: market, program: ethers.hexlify(next.bytes()) },
      ]) } } as never, executor, new Uint8Array());
  }
}
process.stdout.write(ethers.hexlify(script));
