import { ethers } from "ethers";
import { RuntimeAmountProgram, runtimeDeferredPayment, runtimePayment, runtimeProgramScript,
  type RuntimeSettlementRequest } from "../../../../adapters/runtime-amount-program.js";
import { runtimeExecutor } from "../../runtime-execution.js";
import { ABI, NEED, scales, uint } from "./codec.js";
import type { Binding } from "./types.js";

/** r3 is the maximum sold quantity; r1/r10 retain the full scaled price/divisor. */
export function budgetProgram(p: RuntimeAmountProgram, d: Binding): RuntimeAmountProgram {
  const s = scales(d);
  return p.constant(12, 1n)
    .call(d.target, ABI.encodeFunctionData(NEED, [d.sold, s.priceProbe]), { static: true }).load(1, 0)
    .constant(11, s.want).math("sub", 2, 1, 11)
    .constant(9, s.sold).math("mul", 1, 1, 9).constant(10, s.denominator)
    .math("add", 2, 0, 12).math("mul", 2, 2, 10).math("sub", 2, 2, 12).math("div", 3, 2, 1);
}

/** Same floor inverse as Exact, capped by the auction's current capacity.
 * r3=output, r4=actual payable cost; r0 remains the unmodified input budget. */
function terms(p: RuntimeAmountProgram, d: Binding, actor: string): RuntimeAmountProgram {
  p.call(d.target, ABI.encodeFunctionData("receiver"), { static: true }).load(6, 0)
    .constant(7, BigInt(actor)).math("eq", 8, 6, 7).constant(9, 0n).equal(8, 9);
  return budgetProgram(p, d)
    .call(d.target, ABI.encodeFunctionData("available", [d.sold]), { static: true }).load(4, 0)
    .math("min", 3, 3, 4).math("sub", 2, 3, 12)
    .math("mul", 4, 3, 1).math("div", 4, 4, 10)
    .math("sub", 2, 4, 12).math("sub", 2, 0, 4);
}

export function quoteProgram(d: Binding, executor: string, recipient?: string): RuntimeAmountProgram {
  const actor = runtimeExecutor(executor, d.target, d.implementation, d.want, d.sold);
  if (recipient !== undefined) runtimeExecutor(recipient, d.target, d.implementation, d.want, d.sold);
  return terms(new RuntimeAmountProgram(), d, actor).constant(2, 0n).math("add", 0, 3, 2);
}

export function deferredProgram(d: Binding, executor: string,
  request: Extract<RuntimeSettlementRequest, { kind: "deferred-input" }>): RuntimeAmountProgram {
  const actor = runtimeExecutor(executor, d.target, d.implementation, d.want, d.sold);
  if (!uint(request.paymentAmount)) throw new Error("Yearn auction zero payment prefix");
  // The shared helper requires the prefix to deliver the complete quoted cap.
  // Yearn separately validates its smaller positive debt and approves only that
  // debt for the post-callback pull. No payment is transferred to receiver().
  const payment = runtimeDeferredPayment({ tokenOut: d.sold, executor: actor, ...request });
  const cb = new RuntimeAmountProgram().constant(8, 0n).constant(9, 0n).constant(10, 0n)
    .calldata(2, 4).constant(3, BigInt(d.sold)).equal(2, 3)
    .calldata(2, 36).constant(3, BigInt(actor)).equal(2, 3)
    .calldata(2, 68).equal(2, 8).calldata(1, 100).equal(1, 9)
    .constant(12, 1n).math("sub", 2, 1, 12);
  runtimePayment(cb, 1, 2);
  const paymentProgramOffset = cb.bytes().length + 7;
  cb.run(payment.script.slice(36), 0, 4)
    .call(d.want, ABI.encodeFunctionData("balanceOf", [actor]), { static: true }).load(3, 0)
    .math("sub", 3, 3, 10).equal(3, 0)
    .call(d.want, ABI.encodeFunctionData("approve", [d.target, 0n]), { patches: [{ offset: 36, reg: 1 }] })
    .load(3, 0).equal(3, 12);
  const script = runtimeProgramScript(cb.bytes()), dataStart = 164;
  const p = terms(new RuntimeAmountProgram(), d, actor)
    .call(d.sold, ABI.encodeFunctionData("balanceOf", [actor]), { static: true }).load(13, 0)
    .constant(14, request.paymentAmount).math("add", 14, 13, 14)
    .call(d.want, ABI.encodeFunctionData("balanceOf", [actor]), { static: true }).load(11, 0)
    .nativeBalance(15)
    .call(d.want, ABI.encodeFunctionData("approve", [d.target, 0n])).load(5, 0).equal(5, 12)
    .call(d.target, ABI.encodeFunctionData("take(address,uint256,address,bytes)", [d.sold, 0n, actor, script]), {
      callback: { incomingOffset: 196, outgoingOffset: dataStart },
      patches: [{ offset: 36, reg: 3 }, { offset: dataStart + 1, reg: 0 },
        { offset: dataStart + 39, reg: 3 }, { offset: dataStart + 73, reg: 4 },
        { offset: dataStart + 107, reg: 11 },
        { offset: dataStart + paymentProgramOffset + payment.floorOffset, reg: 14 }],
    }).load(5, 0).equal(5, 3)
    .call(d.want, ABI.encodeFunctionData("approve", [d.target, 0n])).load(5, 0).equal(5, 12)
    .call(d.want, ABI.encodeFunctionData("balanceOf", [actor]), { static: true }).load(6, 0)
    .math("add", 7, 11, 0).math("sub", 7, 7, 4).equal(6, 7)
    .call(d.sold, ABI.encodeFunctionData("balanceOf", [actor]), { static: true }).load(6, 0)
    .math("add", 7, 13, 3).constant(14, request.paymentAmount).math("sub", 7, 7, 14).equal(6, 7)
    .nativeBalance(6).equal(6, 15);
  return p;
}
