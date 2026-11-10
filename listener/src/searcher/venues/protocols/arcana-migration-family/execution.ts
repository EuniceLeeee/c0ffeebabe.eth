import { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import { runtimeLeg, runtimeExecutor, assertProjectedRuntimeRoute, runtimeExactApproval, runtimeClearApproval } from "../../runtime-execution.js";
import { NO_EXECUTION_RUNTIME_PROJECTION, type ExecutionSemantics } from "../../adapter-family-plugin.js";
import { sameAddress, MAX_UINT256 } from "../standard-family/common.js";
import { ARCANA_SOURCE_INTERFACE } from "./abi.js";
import { arcanaMigrationRoutes } from "./routes.js";
import { assertArcanaInvocation } from "./shared.js";
import type { ArcanaDescriptor, ArcanaExactEvidence, ArcanaRoute } from "./types.js";

export const arcanaMigrationExecution = {
  buildRuntimeLeg(input) {
    const { descriptor: d, route: r, executor } = input;
    assertArcanaInvocation(d, r);
    runtimeExecutor(executor, d.source);
    assertProjectedRuntimeRoute(r, arcanaMigrationRoutes.project({ descriptor: d }));
    const p = new RuntimeAmountProgram();
    // lockAndBridge pulls the old token with transferFrom(executor, burn, amount).
    // The quoted fragment declares the same approval as a requirement; the runtime
    // program must issue it itself, exactly for this hop's input.
    runtimeExactApproval(p, r.tokenIn, d.source);
    p.call(
      d.source,
      ARCANA_SOURCE_INTERFACE.encodeFunctionData("lockAndBridge", [d.tokenId, 0n, executor]),
      { patches: [{ offset: 36, reg: 0 }] },
    );
    runtimeClearApproval(p, r.tokenIn, d.source);
    return runtimeLeg(r.adapterId, p);
  },
  runtimeProjection: () => NO_EXECUTION_RUNTIME_PROJECTION,
  buildFragment(input) {
    assertArcanaInvocation(input.descriptor, input.route);
    assertProjectedRuntimeRoute(input.route, arcanaMigrationRoutes.project({ descriptor: input.descriptor }));
    runtimeExecutor(input.executor, input.descriptor.source);
    const evidence = input.exactEvidence;
    if (
      input.amountIn <= 0n ||
      input.amountIn > MAX_UINT256 ||
      evidence.kind !== "arcana-migration-preview" ||
      evidence.amountIn !== input.amountIn ||
      evidence.amountOut !== input.quotedAmountOut ||
      input.minAmountOut < 0n || input.minAmountOut > input.quotedAmountOut ||
      !sameAddress(evidence.sourceContract, input.descriptor.source) ||
      !sameAddress(evidence.executor, input.executor) ||
      evidence.bindingFingerprint !== input.route.bindingRef.fingerprint
    ) {
      throw new Error("arcana execution received incompatible exact evidence");
    }
    return Object.freeze({
      requirements: Object.freeze([Object.freeze({
        kind: "approve" as const,
        token: input.route.tokenIn,
        spender: input.descriptor.source,
        amount: MAX_UINT256,
      })]),
      nodes: Object.freeze([Object.freeze({
        adapterId: input.route.adapterId,
        target: input.descriptor.source,
        tokenIn: input.route.tokenIn,
        tokenOut: input.route.tokenOut,
        amount: input.amountIn,
        params: Object.freeze({
          tokenId: input.descriptor.tokenId,
          recipient: input.executor,
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
      token: route.tokenOut,
      account: "executor" as const,
      direction: "increase" as const,
    }),
  ]),
} satisfies ExecutionSemantics<ArcanaDescriptor, ArcanaRoute, ArcanaExactEvidence>;
