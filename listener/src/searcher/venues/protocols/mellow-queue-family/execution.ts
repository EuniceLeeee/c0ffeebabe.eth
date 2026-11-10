import { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import { runtimeLeg, runtimeExecutor, assertProjectedRuntimeRoute } from "../../runtime-execution.js";
import {
  NO_EXECUTION_RUNTIME_PROJECTION,
  type ExecutionSemantics,
} from "../../adapter-family-plugin.js";
import { sameAddress, MAX_UINT256 } from "../standard-family/common.js";
import { MELLOW_QUEUE_INTERFACE } from "./abi.js";
import { mellowQueueRoutes } from "./routes.js";
import { assertMellowQueueInvocation } from "./shared.js";
import type {
  MellowQueueDescriptor,
  MellowQueueExactEvidence,
  MellowQueueRoute,
} from "./types.js";

export const mellowQueueExecution = {
  buildRuntimeLeg(input) {
    const { descriptor: d, route: r, executor } = input;
    assertMellowQueueInvocation(d, r);
    runtimeExecutor(executor, d.queue);
    assertProjectedRuntimeRoute(r, mellowQueueRoutes.project({ descriptor: d }));
    const p = d.kind === "deposit"
      ? new RuntimeAmountProgram().call(d.queue, MELLOW_QUEUE_INTERFACE.encodeFunctionData("deposit", [0n, executor, []]), { patches: [{ offset: 4, reg: 0 }] })
      : new RuntimeAmountProgram().call(d.queue, MELLOW_QUEUE_INTERFACE.encodeFunctionData("redeem", [0n, executor]), { patches: [{ offset: 4, reg: 0 }] });
    return runtimeLeg(r.adapterId, p);
  },
  runtimeProjection: () => NO_EXECUTION_RUNTIME_PROJECTION,
  buildFragment(input) {
    assertMellowQueueInvocation(input.descriptor, input.route);
    assertProjectedRuntimeRoute(input.route, mellowQueueRoutes.project({ descriptor: input.descriptor }));
    runtimeExecutor(input.executor, input.descriptor.queue);
    const evidence = input.exactEvidence;
    if (
      input.amountIn <= 0n ||
      input.amountIn > MAX_UINT256 ||
      evidence.kind !== "mellow-queue-oracle-price" ||
      evidence.amountIn !== input.amountIn ||
      evidence.amountOut !== input.quotedAmountOut ||
      input.minAmountOut < 0n || input.minAmountOut > input.quotedAmountOut ||
      !sameAddress(evidence.queue, input.descriptor.queue) ||
      !sameAddress(evidence.executor, input.executor) ||
      evidence.bindingFingerprint !== input.route.bindingRef.fingerprint
    ) {
      throw new Error("mellow queue execution received incompatible exact evidence");
    }
    return Object.freeze({
      requirements: Object.freeze([]),
      nodes: Object.freeze([Object.freeze({
        adapterId: input.route.adapterId,
        target: input.descriptor.queue,
        tokenIn: input.route.tokenIn,
        tokenOut: input.route.tokenOut,
        amount: input.amountIn,
        params: input.descriptor.kind === "deposit"
          ? Object.freeze({ referral: input.executor })
          : Object.freeze({ receiver: input.executor }),
        children: [],
      })]),
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
      kind: "token-delta" as const,
      token: route.tokenOut,
      account: "executor" as const,
      direction: "increase" as const,
    }),
    descriptor.kind === "deposit"
      ? Object.freeze({
          kind: "total-supply-delta" as const,
          token: descriptor.share,
          direction: "increase" as const,
        })
      : Object.freeze({
          kind: "total-supply-delta" as const,
          token: descriptor.share,
          direction: "decrease" as const,
        }),
  ]),
} satisfies ExecutionSemantics<
  MellowQueueDescriptor,
  MellowQueueRoute,
  MellowQueueExactEvidence
>;
