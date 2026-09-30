import { ethers } from "ethers";
import { compilePlan } from "../compiler.js";
import type { ResolvedPlanNode } from "../shared/types/plan.js";
import type { CompiledExactPrefix } from "./exact-prefix-context.js";
import { planFragmentNodes } from "./solver/plan-fragment-requirements.js";
import type { PlanFragment } from "./venues/route-leg-adapter.js";

const SUBSCRIPT = new ethers.Interface(["function execSubscript(bytes script)"]);
const MAX_UINT = (1n << 256n) - 1n;

export interface ExactPrefixPlanStep {
  readonly fragment: PlanFragment;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
}

/** Compile already-authenticated Exact fragments, without interpreting protocols.
 * The existing VM flow measures each leg's input/output balance DELTA, so neither
 * surplus nor old executor inventory can hide divergence from the sealed quote.
 * This is an open quotation prefix, not a funded route or final simulation. */
export function compileExactPrefix(
  steps: readonly ExactPrefixPlanStep[], executor: string,
): CompiledExactPrefix {
  if (steps.length === 0 || steps.length > 6) throw new Error("exact prefix requires 1..6 steps");
  executor = address(executor);
  const children = steps.map((step, index): ResolvedPlanNode => {
    const tokenIn = address(step.tokenIn), tokenOut = address(step.tokenOut);
    if (tokenIn === tokenOut || step.amountIn <= 0n || step.amountOut <= 0n ||
        step.amountIn > MAX_UINT || step.amountOut > MAX_UINT) throw new Error("invalid exact prefix amount or token");
    const previous = steps[index - 1];
    if (previous && (address(previous.tokenOut) !== tokenIn || previous.amountOut !== step.amountIn)) {
      throw new Error("disconnected exact prefix token or amount");
    }
    const exact: ResolvedPlanNode = {
      adapterId: "actual-amount-case", target: executor, tokenIn, tokenOut,
      amount: step.amountIn, params: { mode: "quote-prefix", quotedAmountOut: step.amountOut },
      children: planFragmentNodes(step.fragment, tokenIn, step.amountIn),
    };
    return { adapterId: "actual-amount-step", target: executor, tokenIn, tokenOut,
      amount: step.amountIn, params: {}, children: [exact] };
  });
  const root: ResolvedPlanNode = {
    adapterId: "actual-amount-flow", target: executor, tokenIn: children[0]!.tokenIn,
    tokenOut: children.at(-1)!.tokenOut, amount: steps[0]!.amountIn,
    params: { mode: "quote-prefix", toleranceRawUnits: 0n }, children,
  };
  return Object.freeze({ executor, calldata: SUBSCRIPT.encodeFunctionData("execSubscript", [compilePlan(root, executor)]),
    inputToken: root.tokenIn, inputAmount: root.amount });
}

function address(value: string): string {
  const result = ethers.getAddress(value).toLowerCase();
  if (result === ethers.ZeroAddress) throw new Error("exact prefix address cannot be zero");
  return result;
}
