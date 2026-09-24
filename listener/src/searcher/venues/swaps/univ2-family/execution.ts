import type { ResolvedPlanNode } from "../../../../shared/types/plan.js";
import type { ExecutionSemantics } from "../../adapter-family-plugin.js";
import { UNIV2_PAIR_INTERFACE, sameAddress } from "./codec.js";
import { uniV2QuoteRouter } from "./router-quote.js";
import type {
  UniV2Descriptor,
  UniV2ExactEvidence,
  UniV2Route,
} from "./types.js";

export const univ2Execution = {
  runtimeProjection: ({ hop }) => Object.freeze({
    // Both execution models pay the pair directly; neither spends via a router.
    allowanceSpender: null,
    prewarmQuoteCalls: Object.freeze([Object.freeze({
      from: "0x0000000000000000000000000000000000000000",
      to: hop.target,
      calldata: UNIV2_PAIR_INTERFACE.encodeFunctionData("getReserves", []),
      gasLimit: 300_000,
    })]),
  }),
  buildFragment(input) {
    assertExecutionEvidence(input);
    const zeroForOne = input.route.direction === "zero-for-one";
    const transferFirst = input.descriptor.quoteModel.kind === "constant-product";
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
      requirements: Object.freeze(transferFirst ? [Object.freeze({
        kind: "transfer-to-pool" as const,
        token: input.route.tokenIn,
        pool: input.descriptor.pool,
        amount: input.amountIn,
      })] : []),
      nodes: Object.freeze([Object.freeze({
        adapterId: "univ2-swap",
        target: input.descriptor.pool,
        tokenIn: input.route.tokenIn,
        tokenOut: input.route.tokenOut,
        amount: input.amountIn,
        params: {
          // Pair.swap specifies an exact transfer, not a minimum-output
          // threshold. A relaxed acceptance floor must not request less.
          amount0Out: zeroForOne ? 0n : input.quotedAmountOut,
          amount1Out: zeroForOne ? input.quotedAmountOut : 0n,
          to: input.executor,
        },
        children: transferFirst ? [] : [transfer],
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
  readonly executor: string;
  readonly transactionOrigin?: string;
}): void {
  const evidence = input.exactEvidence;
  const zeroForOne = input.route.direction === "zero-for-one";
  if (
    input.amountIn < 0n ||
    (input.route.direction !== "zero-for-one" && input.route.direction !== "one-for-zero") ||
    input.route.instanceKey !== input.descriptor.instanceKey ||
    !sameAddress(input.route.pool, input.descriptor.pool) ||
    !sameAddress(input.route.tokenIn, zeroForOne ? input.descriptor.token0 : input.descriptor.token1) ||
    !sameAddress(input.route.tokenOut, zeroForOne ? input.descriptor.token1 : input.descriptor.token0) ||
    (input.descriptor.quoteModel.kind === "pool-get-amount-out"
      ? evidence.kind !== "univ2-reserves-exact"
      : (input.amountIn > 0n || input.quotedAmountOut > 0n) && (evidence.kind === "univ2-router-amounts"
        ? uniV2QuoteRouter(input.descriptor) === null || !sameAddress(evidence.router, uniV2QuoteRouter(input.descriptor)!)
        : evidence.kind !== "univ2-reserves-exact" || evidence.amountOut <= 0n)) ||
    evidence.quoteModel !== input.descriptor.quoteModel.kind ||
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
