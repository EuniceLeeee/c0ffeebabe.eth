import {
  NO_EXECUTION_RUNTIME_PROJECTION,
  type ExecutionSemantics,
} from "../../adapter-family-plugin.js";
import { sameAddress } from "./codec.js";
import type {
  FluidCreditDescriptor,
  FluidCreditRiskEvidence,
  FluidCreditRoute,
} from "./types.js";

const MAX_UINT = (1n << 256n) - 1n;

export const fluidCreditExecution = {
  runtimeProjection: () => NO_EXECUTION_RUNTIME_PROJECTION,
  buildFragment(input) {
    assertExecutionEvidence(input);
    return Object.freeze({
      requirements: Object.freeze([Object.freeze({
        kind: "approve" as const,
        token: input.descriptor.supplyToken,
        spender: input.descriptor.vault,
        amount: MAX_UINT,
      })]),
      nodes: Object.freeze([Object.freeze({
        adapterId: "fluid-vault",
        target: input.descriptor.vault,
        tokenIn: input.route.tokenIn,
        tokenOut: input.route.tokenOut,
        amount: input.amountIn,
        params: Object.freeze({
          nftId: 0n,
          collateralDelta: input.amountIn,
          debtDelta: input.quotedAmountOut,
        }),
        children: [],
      })]),
    });
  },
  expectedEffects: ({ route }) => Object.freeze([
    Object.freeze({
      kind: "token-delta" as const,
      token: route.tokenIn,
      account: "executor" as const,
      direction: "decrease" as const,
    }),
    Object.freeze({
      kind: "token-delta" as const,
      token: route.tokenIn,
      account: "route-target" as const,
      direction: "increase" as const,
    }),
    Object.freeze({
      kind: "token-delta" as const,
      token: route.tokenOut,
      account: "route-target" as const,
      direction: "decrease" as const,
    }),
    Object.freeze({
      kind: "token-delta" as const,
      token: route.tokenOut,
      account: "executor" as const,
      direction: "increase" as const,
    }),
  ]),
} satisfies ExecutionSemantics<
  FluidCreditDescriptor,
  FluidCreditRoute,
  FluidCreditRiskEvidence
>;

function assertExecutionEvidence(input: {
  readonly descriptor: FluidCreditDescriptor;
  readonly route: FluidCreditRoute;
  readonly amountIn: bigint;
  readonly quotedAmountOut: bigint;
  readonly exactEvidence: FluidCreditRiskEvidence;
  readonly executor: string;
}): void {
  const evidence = input.exactEvidence;
  if (
    evidence.kind !== "fluid-credit-effect-delta-risk-proof" ||
    !sameAddress(evidence.vault, input.descriptor.vault) ||
    evidence.routeKey !== input.route.routeKey ||
    !sameAddress(evidence.executor, input.executor) ||
    evidence.collateralAmount !== input.amountIn ||
    evidence.debtAmount !== input.quotedAmountOut ||
    evidence.collateralDelta !== -input.amountIn ||
    evidence.debtDelta !== input.quotedAmountOut ||
    evidence.nftId <= 0n ||
    evidence.finalSupply <= 0n ||
    evidence.finalBorrow <= 0n
  ) {
    throw new Error("fluid-credit execution received incompatible risk evidence");
  }
}
