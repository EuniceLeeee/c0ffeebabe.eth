// FFI emits production Family bytes. This is not a replacement VM or a chain test.
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { runtimeAmountFlowAdapter, RuntimeAmountProgram, runtimeProgramScript } from "../../../../../adapters/runtime-amount-program.js";
import { depositProgram } from "../deposit.js";
const [mode, lt, asset, stablecoin, cryptopool, amm, executor, returnPool, amountText, minimumText] = process.argv.slice(2);
assert(["quoted", "runtime", "flow"].includes(mode!) && minimumText !== undefined);
const s = { lt: lt!, asset: asset!, stablecoin: stablecoin!, cryptopool: cryptopool!, amm: amm! };
const amount = BigInt(amountText!), minimum = BigInt(minimumText);
const program = depositProgram(s, executor!, mode === "quoted" ? { quotedDebt: amount * 20n, minimumShares: minimum } : {}).bytes();
let script: Uint8Array;
if (mode === "flow") {
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
