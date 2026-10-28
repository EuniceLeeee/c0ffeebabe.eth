import { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import { runtimeLeg, runtimeExecutor, assertProjectedRuntimeRoute } from "../../runtime-execution.js";
import {
  NO_EXECUTION_RUNTIME_PROJECTION,
  type ExecutionSemantics,
} from "../../adapter-family-plugin.js";
import { sameAddress, MAX_UINT256 } from "../standard-family/common.js";
import { assertSelfBurnNativeInvocation, SELF_BURN_NATIVE_TOKEN_INTERFACE } from "./shared.js";
import { selfBurnNativeRoutes } from "./routes.js";
import type {
  SelfBurnNativeDescriptor,
  SelfBurnNativeExactEvidence,
  SelfBurnNativeRoute,
} from "./types.js";

export const selfBurnNativeExecution = {
  buildRuntimeLeg(input) {
    const { descriptor: d, route: r, executor } = input;
    assertSelfBurnNativeInvocation(d, r); runtimeExecutor(executor, d.token);
    assertProjectedRuntimeRoute(r, selfBurnNativeRoutes.project({ descriptor: d }));
    // Sending the token to itself is the protocol redemption, not a wrapper.
    const p = new RuntimeAmountProgram()
      .call(d.token, SELF_BURN_NATIVE_TOKEN_INTERFACE.encodeFunctionData("transfer", [d.token, 0n]), { patches: [{ offset: 36, reg: 0 }] });
    return runtimeLeg(r.adapterId, p);
  },
  runtimeProjection: () => NO_EXECUTION_RUNTIME_PROJECTION,
  buildFragment(input) {
    assertSelfBurnNativeInvocation(input.descriptor, input.route);
    assertProjectedRuntimeRoute(input.route, selfBurnNativeRoutes.project({ descriptor: input.descriptor }));
    runtimeExecutor(input.executor, input.descriptor.token);
    const evidence = input.exactEvidence;
    if (
      input.amountIn <= 0n ||
      input.amountIn > MAX_UINT256 ||
      input.quotedAmountOut <= 0n ||
      input.minAmountOut < 0n || input.minAmountOut > input.quotedAmountOut ||
      evidence.kind !== "self-burn-native-fee-quote" ||
      evidence.fees === null ||
      evidence.fee < 0n ||
      evidence.fee > input.amountIn ||
      evidence.amountOut !== input.amountIn - evidence.fee ||
      evidence.amountIn !== input.amountIn ||
      evidence.amountOut !== input.quotedAmountOut ||
      !sameAddress(evidence.token, input.descriptor.token) ||
      !sameAddress(evidence.executor, input.executor) ||
      evidence.bindingFingerprint !== input.route.bindingRef.fingerprint
    ) {
      throw new Error(
        "self-burn native execution received incompatible exact evidence",
      );
    }
    return Object.freeze({
      requirements: Object.freeze([]),
      nodes: Object.freeze([
        Object.freeze({
          adapterId: input.route.adapterId,
          target: input.descriptor.token,
          tokenIn: input.descriptor.token,
          tokenOut: input.route.tokenOut,
          amount: input.amountIn,
          params: {},
          children: [],
        }),
      ]),
    });
  },
  expectedEffects: ({ descriptor, route }) => Object.freeze([
    Object.freeze({
      kind: "token-delta" as const,
      token: route.tokenIn,
      account: "executor" as const,
      direction: "decrease" as const,
    }),
    Object.freeze({
      kind: "total-supply-delta" as const,
      token: descriptor.token,
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
  SelfBurnNativeDescriptor,
  SelfBurnNativeRoute,
  SelfBurnNativeExactEvidence
>;
