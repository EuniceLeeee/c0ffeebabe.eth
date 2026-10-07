import { ethers } from "ethers";
import { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import { runtimeLeg, runtimeExecutor, assertProjectedRuntimeRoute } from "../../runtime-execution.js";
import { curveUnderlyingRoutes } from "./routes.js";
import {
  hopTargetExecutionRuntimeProjection,
  type ExecutionSemantics,
} from "../../adapter-family-plugin.js";
import { sameAddress } from "./codec.js";
import type {
  CurveUnderlyingDescriptor,
  CurveUnderlyingExactEvidence,
  CurveUnderlyingRoute,
} from "./types.js";

const MAX_UINT = (1n << 256n) - 1n;

export const curveUnderlyingExecution = {
  buildRuntimeLeg(input) {
    const { descriptor: d, route: r, executor } = input;
    assertProjectedRuntimeRoute(r, curveUnderlyingRoutes.project({ descriptor: d })); runtimeExecutor(executor, d.pool);
    const p = new RuntimeAmountProgram().allowance(r.tokenIn, d.pool, 0, MAX_UINT)
      .call(d.pool, new ethers.Interface(["function exchange_underlying(int128,int128,uint256,uint256)"]).encodeFunctionData("exchange_underlying",
        [r.i, r.j, 0n, 1n]), { patches: [{ offset: 68, reg: 0 }] });
    return runtimeLeg("curve-exchange-underlying", p);
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
        adapterId: "curve-exchange-underlying",
        target: input.descriptor.pool,
        tokenIn: input.route.tokenIn,
        tokenOut: input.route.tokenOut,
        amount: input.amountIn,
        params: Object.freeze({
          i: BigInt(input.route.i),
          j: BigInt(input.route.j),
          minDy: input.minAmountOut,
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
  CurveUnderlyingDescriptor,
  CurveUnderlyingRoute,
  CurveUnderlyingExactEvidence
>;

function assertExecutionEvidence(input: {
  readonly descriptor: CurveUnderlyingDescriptor;
  readonly route: CurveUnderlyingRoute;
  readonly amountIn: bigint;
  readonly quotedAmountOut: bigint;
  readonly exactEvidence: CurveUnderlyingExactEvidence;
}): void {
  const evidence = input.exactEvidence;
  if (
    evidence.kind !== "curve-underlying-get-dy" ||
    !sameAddress(evidence.pool, input.descriptor.pool) ||
    evidence.routeKey !== input.route.routeKey ||
    evidence.i !== input.route.i ||
    evidence.j !== input.route.j ||
    !sameAddress(evidence.tokenIn, input.route.tokenIn) ||
    !sameAddress(evidence.tokenOut, input.route.tokenOut) ||
    evidence.amountIn !== input.amountIn ||
    evidence.amountOut !== input.quotedAmountOut
  ) {
    throw new Error("curve-underlying execution received incompatible exact evidence");
  }
}
