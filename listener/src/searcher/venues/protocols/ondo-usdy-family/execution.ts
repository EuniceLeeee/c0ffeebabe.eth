import { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import { runtimeLeg, runtimeExecutor, assertProjectedRuntimeRoute } from "../../runtime-execution.js";
import { NO_EXECUTION_RUNTIME_PROJECTION, type ExecutionSemantics } from "../../adapter-family-plugin.js";
import { MAX_UINT256, sameAddress } from "../standard-family/common.js";
import { ONDO_MANAGER_INTERFACE } from "./abi.js";
import { ONDO_REDEEM_HELPER, buildOndoHelperCalldata } from "./helper.js";
import { ondoRoutes } from "./routes.js";
import type { OndoDescriptor, OndoExactEvidence, OndoRoute } from "./types.js";

function assertInvocation(d: OndoDescriptor, r: OndoRoute) {
  if (r.adapterId !== "ondo-usdy-redeem" || !sameAddress(r.tokenIn, d.rwa) || !sameAddress(r.tokenOut, d.receive)) throw new Error("ondo route mismatch");
}

export const ondoExecution = {
  buildRuntimeLeg(input) {
    const { descriptor: d, route: r, executor } = input;
    assertInvocation(d, r);
    const actor = runtimeExecutor(executor, ONDO_REDEEM_HELPER, d.rwa, d.receive);
    assertProjectedRuntimeRoute(r, ondoRoutes.project({ descriptor: d }));
    const p = new RuntimeAmountProgram().call(ONDO_REDEEM_HELPER, buildOndoHelperCalldata(actor, d.receive, d.rwa));
    return runtimeLeg(r.adapterId, p);
  },
  runtimeProjection: () => NO_EXECUTION_RUNTIME_PROJECTION,
  buildFragment(input) {
    assertInvocation(input.descriptor, input.route);
    assertProjectedRuntimeRoute(input.route, ondoRoutes.project({ descriptor: input.descriptor }));
    runtimeExecutor(input.executor, input.descriptor.manager, input.descriptor.rwa, input.descriptor.receive);
    const e = input.exactEvidence;
    if (input.amountIn <= 0n || input.amountIn > MAX_UINT256 || e.kind !== "ondo-usdy-redeem" || e.amountIn !== input.amountIn ||
        e.amountOut !== input.quotedAmountOut || input.minAmountOut < 0n || input.minAmountOut > input.quotedAmountOut ||
        !sameAddress(e.manager, input.descriptor.manager) || !sameAddress(e.executor, input.executor) || e.bindingFingerprint !== input.route.bindingRef.fingerprint) {
      throw new Error("ondo execution evidence mismatch");
    }
    return Object.freeze({
      requirements: Object.freeze([Object.freeze({ kind: "approve" as const, token: input.route.tokenIn, spender: ONDO_REDEEM_HELPER, amount: MAX_UINT256 })]),
      nodes: Object.freeze([Object.freeze({ adapterId: input.route.adapterId, target: ONDO_REDEEM_HELPER, tokenIn: input.route.tokenIn, tokenOut: input.route.tokenOut, amount: input.amountIn, params: Object.freeze({ helper: true as const, receive: input.descriptor.receive, usdy: input.descriptor.rwa, minimumOut: input.minAmountOut }), children: [] })]),
    });
  },
  expectedEffects: ({ route }) => Object.freeze([
    Object.freeze({ kind: "token-delta" as const, token: route.tokenIn, account: "executor" as const, direction: "decrease" as const }),
    Object.freeze({ kind: "token-delta" as const, token: route.tokenOut, account: "executor" as const, direction: "increase" as const }),
  ]),
} satisfies ExecutionSemantics<OndoDescriptor, OndoRoute, OndoExactEvidence>;
