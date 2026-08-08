import type { ResolvedPlanNode } from "../../../../shared/types/plan.js";
import type { ExecutionSemantics } from "../../adapter-family-plugin.js";
import { sameAddress } from "./codec.js";
import type {
  UniV2Descriptor,
  UniV2ExactEvidence,
  UniV2Route,
} from "./types.js";

export const univ2Execution = {
  buildFragment(input) {
    assertExecutionEvidence(input);
    const zeroForOne = input.route.direction === "zero-for-one";
    const transfer: ResolvedPlanNode = {
      adapterId: "erc20-transfer",
      target: input.route.tokenIn,
      tokenIn: input.route.tokenIn,
      tokenOut: input.route.tokenIn,
      amount: input.amountIn,
      params: { to: input.descriptor.pool, amount: input.amountIn },
      children: [],
    };
    return Object.freeze({
      requirements: Object.freeze([]),
      nodes: Object.freeze([Object.freeze({
        adapterId: "univ2-swap",
        target: input.descriptor.pool,
        tokenIn: input.route.tokenIn,
        tokenOut: input.route.tokenOut,
        amount: input.amountIn,
        params: {
          amount0Out: zeroForOne ? 0n : input.minAmountOut,
          amount1Out: zeroForOne ? input.minAmountOut : 0n,
          to: input.executor,
        },
        children: [transfer],
      })]),
    });
  },
  expectedEffects: ({ descriptor, route }) => [
    {
      kind: "token-delta" as const,
      token: route.tokenIn,
      account: "executor" as const,
      direction: "decrease" as const,
    },
    {
      kind: "token-delta" as const,
      token: route.tokenIn,
      account: "route-target" as const,
      direction: "increase" as const,
    },
    {
      kind: "token-delta" as const,
      token: route.tokenOut,
      account: "route-target" as const,
      direction: "decrease" as const,
    },
    {
      kind: "token-delta" as const,
      token: route.tokenOut,
      account: "executor" as const,
      direction: "increase" as const,
    },
  ],
} satisfies ExecutionSemantics<
  UniV2Descriptor,
  UniV2Route,
  UniV2ExactEvidence
>;

function assertExecutionEvidence(input: {
  readonly descriptor: UniV2Descriptor;
  readonly route: UniV2Route;
  readonly amountIn: bigint;
  readonly quotedAmountOut: bigint;
  readonly exactEvidence: UniV2ExactEvidence;
}): void {
  const evidence = input.exactEvidence;
  if (
    evidence.kind !== "univ2-reserves-exact" ||
    !sameAddress(evidence.pool, input.descriptor.pool) ||
    !sameAddress(evidence.tokenIn, input.route.tokenIn) ||
    !sameAddress(evidence.tokenOut, input.route.tokenOut) ||
    evidence.amountIn !== input.amountIn ||
    evidence.amountOut !== input.quotedAmountOut ||
    evidence.feeBps !== input.descriptor.feeRule.feeBps
  ) {
    throw new Error("univ2 execution received incompatible exact evidence");
  }
}
