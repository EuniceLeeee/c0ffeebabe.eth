import { ethers } from "ethers";
import { RuntimeAmountProgram, type RuntimeAmountLeg, type RuntimeSettlementRequest } from "../../adapters/runtime-amount-program.js";
import type { ResolvedPlanNode } from "../../shared/types/plan.js";

type Leg = RuntimeAmountLeg & { readonly tokenIn: string; readonly tokenOut: string };
const token = new ethers.Interface(["function balanceOf(address) view returns(uint256)"]);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Capability-driven composition. Every ABI, debt interpretation and receiver
 * is issued by its Family. No pool/Family id, protocol math or external quote. */
export function buildRuntimeSettlementRoot(input: {
  legs: readonly Leg[]; amount: bigint; minimumProfit: bigint; executor: string;
  build(index: number, request: RuntimeSettlementRequest): RuntimeAmountLeg | null;
}): ResolvedPlanNode | null {
  const { legs, amount, minimumProfit, executor } = input;
  if (legs.length < 2 || legs.length > 6 || amount <= 0n || minimumProfit < 1n || legs.slice(0, -1).some(leg => leg.inputMode !== undefined)) return null;
  const last = legs.at(-1)!;
  const recipient = last.settlement?.deferredInput;
  if (last.inputMode !== undefined && (last.inputMode !== "maximum" || !recipient || !same(recipient, executor))) return null;
  if (!recipient || !legs.slice(0, -1).every(leg => leg.settlement?.quoteOutput) ||
      !legs.at(-2)!.settlement?.directOutput) return null;
  if (!same(legs[0]!.tokenIn, last.tokenOut) || legs.some((leg, i) =>
    same(leg.tokenIn, leg.tokenOut) || i > 0 && !same(legs[i - 1]!.tokenOut, leg.tokenIn))) {
    throw new Error("runtime settlement continuity");
  }
  const quotes: RuntimeAmountLeg[] = [], execution: Leg[] = [];
  for (let i = 0; i < legs.length - 1; i++) {
    const quote = input.build(i, { kind: "quote-output", recipient: i === legs.length - 2 ? recipient : executor });
    const action = i === legs.length - 2 ? input.build(i, { kind: "direct-output", recipient }) : legs[i]!;
    if (!quote || !action) return null;
    quotes.push(quote); execution.push({ ...action, tokenIn: legs[i]!.tokenIn, tokenOut: legs[i]!.tokenOut });
  }
  // Measure each real receipt, including credit at the final debt recipient.
  // This optimization requires an exact positive debit. A tolerated retained
  // unit or maximum-input PREFIX uses the existing funded runtime fallback;
  // its 0/1 and refund rules are unchanged. No old inventory may fund a hop.
  const payment = new RuntimeAmountProgram();
  for (let i = 0; i < execution.length; i++) {
    const leg = execution[i]!, receiver = i === execution.length - 1 ? recipient : executor;
    payment.call(leg.tokenIn, token.encodeFunctionData("balanceOf", [executor]), { static: true }).load(1, 0)
      .constant(7, 0n).math("add", 7, 0, 7)
      .call(leg.tokenOut, token.encodeFunctionData("balanceOf", [receiver]), { static: true }).load(2, 0)
      .run(leg.program, 0, 3)
      .call(leg.tokenIn, token.encodeFunctionData("balanceOf", [executor]), { static: true }).load(4, 0)
      .math("sub", 4, 1, 4).constant(5, 1n).math("sub", 6, 4, 5).equal(4, 7)
      .call(leg.tokenOut, token.encodeFunctionData("balanceOf", [receiver]), { static: true }).load(4, 0)
      .math("sub", 0, 4, 2).constant(5, 1n).math("sub", 6, 0, 5);
  }
  const deferred = input.build(legs.length - 1, { kind: "deferred-input",
    paymentAmount: amount, paymentProgram: ethers.hexlify(payment.bytes()) });
  if (!deferred) return null;
  const assets = [...new Set(legs.map(leg => leg.tokenIn.toLowerCase()))];
  const p = new RuntimeAmountProgram();
  assets.forEach((asset, i) => p.call(asset, token.encodeFunctionData("balanceOf", [executor]), { static: true }).load(i + 1, 0));
  p.nativeBalance(7).constant(8, 0n).math("add", 8, 0, 8);
  for (const quote of quotes) p.run(quote.program, 8, 8, true);
  p.run(deferred.program, 8, 9);
  assets.forEach((asset, i) => {
    p.call(asset, token.encodeFunctionData("balanceOf", [executor]), { static: true }).load(10, 0);
    if (i === 0) p.math("sub", 10, 10, 1).constant(11, minimumProfit).math("sub", 10, 10, 11);
    else if (last.inputMode === "maximum" && same(asset, last.tokenIn)) p.math("sub", 10, 10, i + 1);
    else p.equal(10, i + 1);
  });
  p.nativeBalance(10).equal(10, 7);
  return { adapterId: "runtime-amount-flow", target: executor, tokenIn: legs[0]!.tokenIn, tokenOut: last.tokenOut,
    amount, children: [], params: { minimumReturn: amount + minimumProfit,
      legs: JSON.stringify(legs), settlementProgram: ethers.hexlify(p.bytes()) } };
}
