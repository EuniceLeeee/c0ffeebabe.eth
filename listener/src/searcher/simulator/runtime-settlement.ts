import { ethers } from "ethers";
import { RuntimeAmountProgram, runtimeSettlementFlowHash, withRuntimeHopContext, type RuntimeAmountLeg, type RuntimeSettlementRequest } from "../../adapters/runtime-amount-program.js";
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
  if (legs.length < 2 || legs.length > 6 || amount <= 0n || minimumProfit < 1n) return null;
  const last = legs.at(-1)!;
  const recipient = last.settlement?.deferredInput;
  if (!recipient || !legs.slice(0, -1).every(leg => leg.settlement?.quoteOutput) ||
      !legs.at(-2)!.settlement?.directOutput) return null;
  if (!same(legs[0]!.tokenIn, last.tokenOut) || legs.some((leg, i) =>
    same(leg.tokenIn, leg.tokenOut) || i > 0 && !same(legs[i - 1]!.tokenOut, leg.tokenIn))) {
    throw new Error("runtime settlement continuity");
  }
  const flowHash = runtimeSettlementFlowHash(amount, amount + minimumProfit, legs);
  const tagged = (index: number, program: string): Uint8Array =>
    withRuntimeHopContext(index, flowHash, program);
  const quotes: RuntimeAmountLeg[] = [], execution: Leg[] = [];
  // A single upstream leg can settle the authenticated debt directly. Longer
  // prefixes retain receipt measurement at their custody boundaries.
  const directDebt = legs.length === 2 && legs[0]!.settlement?.settleOutput === true &&
    last.settlement?.deferredDebtInput === true;
  for (let i = 0; i < legs.length - 1; i++) {
    const quote = input.build(i, { kind: "quote-output" });
    const action = directDebt ? input.build(i, { kind: "settle-output", recipient, amountIn: amount })
      : i === legs.length - 2 ? input.build(i, { kind: "direct-output", recipient }) : legs[i]!;
    if (!quote || !action) return null;
    quotes.push(quote); execution.push({ ...action, tokenIn: legs[i]!.tokenIn, tokenOut: legs[i]!.tokenOut });
  }
  // Measure each real receipt, including credit at the final debt recipient.
  // Every leg is limited to its working input and cannot consume old inventory.
  const payment = new RuntimeAmountProgram();
  if (directDebt) {
    // A fixed transfer argument is not proof of the sender's actual debit for
    // arbitrary ERC20s. Retain the spending bound; downstream debt validation
    // replaces only the duplicate output-credit measurements.
    payment.call(legs[0]!.tokenIn, token.encodeFunctionData("balanceOf", [executor]), { static: true }).load(1, 0)
      .constant(2, amount).math("sub", 1, 1, 2)
      .run(tagged(0, execution[0]!.program))
      .call(legs[0]!.tokenIn, token.encodeFunctionData("balanceOf", [executor]), { static: true }).load(2, 0)
      .math("sub", 2, 2, 1);
  }
  else {
  for (let i = 0; i < execution.length; i++) {
    const leg = execution[i]!, receiver = i === execution.length - 1 ? recipient : executor;
    payment.call(leg.tokenIn, token.encodeFunctionData("balanceOf", [executor]), { static: true }).load(1, 0)
      .math("sub", 1, 1, 0)
      .call(leg.tokenOut, token.encodeFunctionData("balanceOf", [receiver]), { static: true }).load(2, 0)
      .run(tagged(i, leg.program), 0, 3)
      .call(leg.tokenIn, token.encodeFunctionData("balanceOf", [executor]), { static: true }).load(4, 0)
      .math("sub", 4, 4, 1)
      .call(leg.tokenOut, token.encodeFunctionData("balanceOf", [receiver]), { static: true }).load(4, 0)
      .math("sub", 0, 4, 2).constant(5, 1n).math("sub", 6, 0, 5);
  }
  }
  const deferred = input.build(legs.length - 1, { kind: "deferred-input",
    paymentAmount: amount, paymentProgram: ethers.hexlify(payment.bytes()), ...(directDebt ? { paymentInput: "debt" as const } : {}) });
  if (!deferred) return null;
  const assets = [...new Set(legs.map(leg => leg.tokenIn.toLowerCase()))];
  const p = new RuntimeAmountProgram();
  assets.forEach((asset, i) => p.call(asset, token.encodeFunctionData("balanceOf", [executor]), { static: true }).load(i + 1, 0));
  p.nativeBalance(7).constant(8, 0n).math("add", 8, 0, 8);
  quotes.forEach((quote, i) => p.run(tagged(i, quote.program), 8, 8, true));
  p.run(tagged(legs.length - 1, deferred.program), 8, 9);
  assets.forEach((asset, i) => {
    p.call(asset, token.encodeFunctionData("balanceOf", [executor]), { static: true }).load(10, 0);
    if (i === 0) p.math("sub", 10, 10, 1).constant(11, minimumProfit).math("sub", 10, 10, 11);
    else p.equal(10, i + 1);
  });
  p.nativeBalance(10).equal(10, 7);
  return { adapterId: "runtime-amount-flow", target: executor, tokenIn: legs[0]!.tokenIn, tokenOut: last.tokenOut,
    amount, children: [], params: { minimumReturn: amount + minimumProfit,
      legs: JSON.stringify(legs), settlementProgram: ethers.hexlify(p.bytes()) } };
}
