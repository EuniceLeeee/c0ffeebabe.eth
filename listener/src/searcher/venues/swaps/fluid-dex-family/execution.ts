import { ethers } from "ethers";
import { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import { runtimeLeg, runtimeExecutor, assertProjectedRuntimeRoute } from "../../runtime-execution.js";
import { fluidDexRoutes } from "./routes.js";
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

const MAX_UINT = (1n << 256n) - 1n;

export const fluidDexExecution = {
  buildRuntimeLeg(input) {
    const { descriptor: d, route: r, executor } = input;
    assertProjectedRuntimeRoute(r, fluidDexRoutes.project({ descriptor: d })); runtimeExecutor(executor, d.pool);
    const p = new RuntimeAmountProgram().allowance(r.tokenIn, d.pool, 0, MAX_UINT)
      .call(d.pool, new ethers.Interface(["function swapIn(bool,uint256,uint256,address) payable"]).encodeFunctionData("swapIn",
        [r.swap0To1, 0n, 1n, executor]), { patches: [{ offset: 36, reg: 0 }] });
    return runtimeLeg("fluid-dex-swap", p);
  },
  runtimeProjection: hopTargetExecutionRuntimeProjection,
  buildFragment(input) {
    assertExecutionEvidence(input);
    return Object.freeze({
      requirements: Object.freeze([Object.freeze({
        kind: "approve" as const,
        token: input.route.tokenIn,
        spender: input.descriptor.pool,
        amount: MAX_UINT,
      })]),
      nodes: Object.freeze([Object.freeze({
        adapterId: "fluid-dex-swap",
        target: input.descriptor.pool,
        tokenIn: input.route.tokenIn,
        tokenOut: input.route.tokenOut,
        amount: input.amountIn,
        params: Object.freeze({
          swap0to1: input.route.swap0To1,
          amountOutMin: input.minAmountOut,
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
}): void {
  const evidence = input.exactEvidence;
  if (
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
