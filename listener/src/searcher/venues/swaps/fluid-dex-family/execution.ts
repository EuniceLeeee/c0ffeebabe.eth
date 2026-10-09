import { ethers } from "ethers";
import { runtimeLeg, assertProjectedRuntimeRoute } from "../../runtime-execution.js";
import { fluidDexRoutes } from "./routes.js";
import { fluidDexRawProgram } from "./raw-execution.js";
import {
  hopTargetExecutionRuntimeProjection,
  type ExecutionSemantics,
} from "../../adapter-family-plugin.js";
import { sameAddress } from "./codec.js";
import type {
  FluidDexDescriptor,
  FluidDexExactEvidence,
  FluidDexRoute,
} from "./types.js";

export const fluidDexExecution = {
  buildRuntimeLeg(input) {
    const { descriptor: d, route: r, executor } = input;
    assertProjectedRuntimeRoute(r, fluidDexRoutes.project({ descriptor: d }));
    const p = fluidDexRawProgram({ pool: d.pool, tokenIn: r.tokenIn, tokenOut: r.tokenOut, executor,
      swap0To1: r.swap0To1, nativeInput: r.executionAssets!.input === "native",
      nativeOutput: r.executionAssets!.output === "native", minimum: 1n });
    return runtimeLeg("fluid-dex-swap", p);
  },
  runtimeProjection: hopTargetExecutionRuntimeProjection,
  buildFragment(input) {
    assertProjectedRuntimeRoute(input.route, fluidDexRoutes.project({ descriptor: input.descriptor }));
    assertExecutionEvidence(input);
    return Object.freeze({
      requirements: Object.freeze([]),
      nodes: Object.freeze([Object.freeze({
        adapterId: "fluid-dex-swap",
        target: input.descriptor.pool,
        tokenIn: input.route.tokenIn,
        tokenOut: input.route.tokenOut,
        amount: input.amountIn,
        params: Object.freeze({
          swap0to1: input.route.swap0To1,
          amountOutMin: input.minAmountOut,
          nativeInput: input.route.executionAssets!.input === "native",
          nativeOutput: input.route.executionAssets!.output === "native",
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
    ...(route.executionAssets!.input === "native" ? [] : [Object.freeze({
      kind: "token-delta" as const,
      token: route.tokenIn,
      account: "route-target" as const,
      direction: "increase" as const,
    })]),
    ...(route.executionAssets!.output === "native" ? [] : [Object.freeze({
      kind: "token-delta" as const,
      token: route.tokenOut,
      account: "route-target" as const,
      direction: "decrease" as const,
    })]),
    Object.freeze({
      kind: "token-delta" as const,
      token: route.tokenOut,
      account: "executor" as const,
      direction: "increase" as const,
    }),
  ]),
} satisfies ExecutionSemantics<
  FluidDexDescriptor,
  FluidDexRoute,
  FluidDexExactEvidence
>;

function assertExecutionEvidence(input: {
  readonly descriptor: FluidDexDescriptor;
  readonly route: FluidDexRoute;
  readonly amountIn: bigint;
  readonly quotedAmountOut: bigint;
  readonly exactEvidence: FluidDexExactEvidence;
  readonly minAmountOut: bigint;
}): void {
  const evidence = input.exactEvidence;
  if (
    input.amountIn <= 0n || input.amountIn > ethers.MaxUint256 ||
    input.quotedAmountOut <= 0n || input.quotedAmountOut > ethers.MaxUint256 ||
    input.minAmountOut < 0n || input.minAmountOut > input.quotedAmountOut ||
    evidence.kind !== "fluid-dex-declared-revert-quote" ||
    evidence.completion !== "reverted-as-declared" ||
    !sameAddress(evidence.pool, input.descriptor.pool) ||
    evidence.routeKey !== input.route.routeKey ||
    evidence.swap0To1 !== input.route.swap0To1 ||
    !sameAddress(evidence.tokenIn, input.route.tokenIn) ||
    !sameAddress(evidence.tokenOut, input.route.tokenOut) ||
    evidence.amountIn !== input.amountIn ||
    evidence.amountOut !== input.quotedAmountOut
  ) {
    throw new Error("fluid-dex execution received incompatible exact evidence");
  }
}
