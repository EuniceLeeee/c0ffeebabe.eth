// FFI emits production Family bytes. This is not a replacement VM or a chain test.
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { runtimeAmountFlowAdapter, RuntimeAmountProgram, runtimeProgramScript } from "../../../../../adapters/runtime-amount-program.js";
import { plugin } from "../../../production-families/yieldbasis-lt.production.js";
import { descriptor, answerFor, SOURCE } from "./fixtures.js";
import { instanceKey } from "../../../adapter-family-identifiers.js";
import { DEPOSIT_DEBT_POLICY } from "../deposit.js";
const [mode, lt, asset, stablecoin, cryptopool, amm, executor, returnPool, amountText, minimumText] = process.argv.slice(2);
assert(["quoted", "runtime", "flow"].includes(mode!) && minimumText !== undefined);
const s = { lt: lt!, asset: asset!, stablecoin: stablecoin!, cryptopool: cryptopool!, amm: amm! };
const amount = BigInt(amountText!), minimum = BigInt(minimumText);
// Synthetic binding is only for mock-contract behavior. Use the actual Family
// route, fragment/action and runtime entry points, not a parallel test encoder.
const d = { ...descriptor(answerFor({ deposit: true })), ...s, share: lt!, instanceKey: instanceKey(lt!.toLowerCase()) };
const route = plugin.routes.project({ descriptor: d }).find(r => r.direction === "deposit")!;
const input = { descriptor: d, route, executor: executor!, source: SOURCE, runtimeEvidence: [] };
const program = ethers.getBytes(plugin.execution.buildRuntimeLeg!(input)!.program);
let script: Uint8Array;
if (mode === "quoted") {
  const fragment = plugin.execution.buildFragment({ ...input, amountIn: amount, quotedAmountOut: amount * 2n,
    minAmountOut: minimum, exactEvidence: { kind: "yieldbasis-lt-deposit-receipt", direction: "deposit", source: SOURCE,
      executor: executor!, lt: lt!, asset: asset!, amountIn: amount, amountOut: amount * 2n,
      debtPolicy: DEPOSIT_DEBT_POLICY, bindingFingerprint: route.bindingRef.fingerprint } });
  const action = plugin.actionAdapters.find(a => a.id === route.adapterId)!;
  script = action.encode(fragment.nodes[0]!, executor!, new Uint8Array());
} else if (mode === "flow") {
  const abi = new ethers.Interface(["function convert(address share,address asset,uint256 amount)"]);
  const next = new RuntimeAmountProgram().call(returnPool!, abi.encodeFunctionData("convert", [lt, asset, 0n]),
    { patches: [{ offset: 68, reg: 0 }] });
  script = runtimeAmountFlowAdapter.encode({ adapterId: "runtime-amount-flow", target: executor, tokenIn: asset, tokenOut: asset,
    amount, children: [], params: { minimumReturn: amount, legs: JSON.stringify([
      { tokenIn: asset, tokenOut: lt, program: ethers.hexlify(program) },
      { tokenIn: lt, tokenOut: asset, program: ethers.hexlify(next.bytes()) },
    ]) } } as never, executor!, new Uint8Array());
} else script = runtimeProgramScript(program, amount);
process.stdout.write(ethers.hexlify(script));
