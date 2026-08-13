import type { ResolvedPlanNode } from "../../../../shared/types/plan.js";
import {
  MAX_SQRT_RATIO,
  MIN_SQRT_RATIO,
} from "../../../solver/v3-math.js";
import type { ExecutionSemantics } from "../../adapter-family-plugin.js";
import { UNIV3_SWAP_ROUTER } from "../univ3-abi.js";
import { canonicalAddress, sameAddress } from "./codec.js";
import type {
  UniV3Descriptor,
  UniV3ExactEvidence,
  UniV3Route,
} from "./types.js";

export const univ3Execution = {
  runtimeProjection: () => Object.freeze({
    allowanceSpender: UNIV3_SWAP_ROUTER,
    prewarmQuoteCalls: Object.freeze([]),
  }),
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
        adapterId: "univ3-swap",
        target: input.descriptor.pool,
        tokenIn: input.route.tokenIn,
        tokenOut: input.route.tokenOut,
        amount: input.amountIn,
        params: {
          zeroForOne,
          amountSpecified: input.amountIn,
          sqrtPriceLimit: zeroForOne
            ? MIN_SQRT_RATIO + 1n
            : MAX_SQRT_RATIO - 1n,
        },
        children: [transfer],
      })]),
    });
  },
  expectedEffects: ({ route }) => [
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
  UniV3Descriptor,
  UniV3Route,
  UniV3ExactEvidence
>;

function assertExecutionEvidence(input: {
  readonly descriptor: UniV3Descriptor;
  readonly route: UniV3Route;
  readonly amountIn: bigint;
  readonly quotedAmountOut: bigint;
  readonly exactEvidence: UniV3ExactEvidence;
  readonly executor: string;
}): void {
  const evidence = input.exactEvidence;
  if (
    evidence.kind !== "univ3-factory-bound-quoter" ||
    !sameAddress(evidence.pool, input.descriptor.pool) ||
    evidence.quoter !== input.descriptor.quoterBinding.quoter ||
    !sameAddress(evidence.caller, canonicalAddress(input.executor)) ||
    !sameAddress(evidence.tokenIn, input.route.tokenIn) ||
    !sameAddress(evidence.tokenOut, input.route.tokenOut) ||
    evidence.fee !== input.descriptor.fee ||
    evidence.amountIn !== input.amountIn ||
    evidence.amountOut !== input.quotedAmountOut
  ) {
    throw new Error("univ3 execution received incompatible exact evidence");
  }
}
