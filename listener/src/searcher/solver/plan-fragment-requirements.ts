import type { ResolvedPlanNode } from "../../shared/types/plan.js";
import type { PlanFragment } from "../venues/route-leg-adapter.js";

const MAX_UINT = (1n << 256n) - 1n;

/** Materialize only the requirements declared by the owning Family, in order. */
export function planFragmentNodes(
  fragment: PlanFragment, inputToken: string, inputAmount: bigint,
): ResolvedPlanNode[] {
  return [
    ...fragment.requirements.map((requirement): ResolvedPlanNode => {
      if (requirement.kind === "transfer-to-pool") return {
        adapterId: "erc20-transfer",
        target: requirement.token,
        tokenIn: requirement.token,
        tokenOut: requirement.token,
        amount: requirement.amount,
        params: { to: requirement.pool, amount: requirement.amount },
        children: [],
      };
      const { token, spender, amount } = requirement;
      // Only an unlimited input-token grant uses the exact leg's spend as its
      // minimum. Finite requirements and other assets keep their declared bound.
      const minimumAllowance = amount === MAX_UINT && token.toLowerCase() === inputToken.toLowerCase()
        ? inputAmount : amount;
      if (minimumAllowance <= 0n || amount < minimumAllowance || amount > MAX_UINT) {
        throw new Error("Family approval does not cover its exact input");
      }
      return {
        adapterId: "erc20-approve",
        target: token,
        tokenIn: token,
        tokenOut: token,
        amount,
        params: { spender, amount, minimumAllowance },
        children: [],
      };
    }),
    ...fragment.nodes,
  ];
}
