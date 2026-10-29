import { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import { runtimeLeg, runtimeExecutor, assertProjectedRuntimeRoute } from "../../runtime-execution.js";
import { NO_EXECUTION_RUNTIME_PROJECTION, type ExecutionSemantics } from "../../adapter-family-plugin.js";
import { MAX_UINT256, sameAddress } from "../standard-family/common.js";
import { TELLER_INTERFACE } from "./abi.js";
import { boringRoutes } from "./routes.js";
import type { BoringDescriptor, BoringExactEvidence, BoringRoute } from "./types.js";

function assertInvocation(d: BoringDescriptor, r: BoringRoute): void {
  if (r.adapterId !== "boring-vault-withdraw" || !sameAddress(r.tokenIn, d.vault) || !sameAddress(r.tokenOut, d.asset)) {
    throw new Error("boring vault route mismatch");
  }
}

/** Teller.bulkWithdraw burns shares held by the caller (no allowance: the
 * vault's authority gates `exit` to its Teller hook) and pays one supported
 * asset to the receiver. */
export const boringExecution = {
  buildRuntimeLeg(input) {
    const { descriptor: d, route: r, executor } = input;
    assertInvocation(d, r);
    runtimeExecutor(executor, d.teller, d.vault, d.asset);
    assertProjectedRuntimeRoute(r, boringRoutes.project({ descriptor: d }));
    if (input.settlement && input.settlement.kind !== "direct-output") return null;
    const receiver = input.settlement?.recipient === undefined
      ? executor
      : runtimeExecutor(input.settlement.recipient, d.teller, d.vault, d.asset);
    const program = new RuntimeAmountProgram().call(
      d.teller,
      TELLER_INTERFACE.encodeFunctionData("bulkWithdraw", [d.asset, 0n, 0n, receiver]),
      { patches: [{ offset: 36, reg: 0 }] },
    );
    return {
      ...runtimeLeg(r.adapterId, program),
      settlement: { directOutput: true as const },
      ...(input.settlement ? { settlementRequest: input.settlement } : {}),
    };
  },
  runtimeProjection: () => NO_EXECUTION_RUNTIME_PROJECTION,
  buildFragment(input) {
    const d = input.descriptor;
    assertInvocation(d, input.route);
    assertProjectedRuntimeRoute(input.route, boringRoutes.project({ descriptor: d }));
    runtimeExecutor(input.executor, d.teller, d.vault, d.asset);
    const e = input.exactEvidence;
    if (input.amountIn <= 0n || input.amountIn > MAX_UINT256 ||
        e.kind !== "boring-vault-withdraw" || e.amountIn !== input.amountIn ||
        e.amountOut !== input.quotedAmountOut || input.minAmountOut < 0n || input.minAmountOut > input.quotedAmountOut ||
        !sameAddress(e.teller, d.teller) || !sameAddress(e.asset, d.asset) ||
        !sameAddress(e.executor, input.executor) || e.bindingFingerprint !== input.route.bindingRef.fingerprint) {
      throw new Error("boring vault execution evidence mismatch");
    }
    return Object.freeze({
      requirements: Object.freeze([]),
      nodes: Object.freeze([Object.freeze({
        adapterId: input.route.adapterId,
        target: d.teller,
        tokenIn: input.route.tokenIn,
        tokenOut: input.route.tokenOut,
        amount: input.amountIn,
        params: Object.freeze({ asset: d.asset, minimumOut: input.minAmountOut }),
        children: [],
      })]),
    });
  },
  expectedEffects: ({ route }) => Object.freeze([
    Object.freeze({ kind: "token-delta" as const, token: route.tokenIn, account: "executor" as const, direction: "decrease" as const }),
    Object.freeze({ kind: "token-delta" as const, token: route.tokenOut, account: "executor" as const, direction: "increase" as const }),
  ]),
} satisfies ExecutionSemantics<BoringDescriptor, BoringRoute, BoringExactEvidence>;
