import type { ExecutionSemantics } from "../../adapter-family-plugin.js";
import { sameAddress } from "./codec.js";
import type {
  DodoV2Descriptor,
  DodoV2ExactEvidence,
  DodoV2Route,
} from "./types.js";

export const dodoV2Execution = {
  buildFragment(input) {
    assertExecutionEvidence(input);
    return Object.freeze({
      requirements: Object.freeze([Object.freeze({
        kind: "transfer-to-pool" as const,
        token: input.route.tokenIn,
        pool: input.descriptor.pool,
        amount: input.amountIn,
      })]),
      nodes: Object.freeze([Object.freeze({
        adapterId: "dodo-v2-swap",
        target: input.descriptor.pool,
        tokenIn: input.route.tokenIn,
        tokenOut: input.route.tokenOut,
        amount: input.amountIn,
        params: { sellBase: input.route.direction === "sell-base" },
        children: [],
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
  DodoV2Descriptor,
  DodoV2Route,
  DodoV2ExactEvidence
>;

function assertExecutionEvidence(input: {
  readonly descriptor: DodoV2Descriptor;
  readonly route: DodoV2Route;
  readonly amountIn: bigint;
  readonly quotedAmountOut: bigint;
  readonly exactEvidence: DodoV2ExactEvidence;
  readonly executor: string;
}): void {
  const evidence = input.exactEvidence;
  if (
    evidence.kind !== "dodo-v2-actor-bound-query" ||
    !sameAddress(evidence.pool, input.descriptor.pool) ||
    !sameAddress(evidence.actor, input.descriptor.quoteActorBinding.actor) ||
    !sameAddress(evidence.actor, input.executor) ||
    evidence.direction !== input.route.direction ||
    !sameAddress(evidence.tokenIn, input.route.tokenIn) ||
    !sameAddress(evidence.tokenOut, input.route.tokenOut) ||
    evidence.amountIn !== input.amountIn ||
    evidence.amountOut !== input.quotedAmountOut
  ) {
    throw new Error("dodo-v2 execution received incompatible exact evidence");
  }
}
