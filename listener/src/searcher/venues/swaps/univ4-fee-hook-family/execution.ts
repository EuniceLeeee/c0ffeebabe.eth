import { runtimeExecutor, assertProjectedRuntimeRoute } from "../../runtime-execution.js";
import { buildV4RuntimeProgram } from "../univ4-family/runtime-execution.js";
import { univ4FeeHookRoutes } from "./routes.js";
import { hookDataFor, sat1Permissions } from "./sat1.js";
import {
  NO_EXECUTION_RUNTIME_PROJECTION,
  type ExecutionSemantics,
} from "../../adapter-family-plugin.js";
import {
  poolKeyFingerprint,
  sameAddress,
} from "../univ4-family/codec.js";
import {
  UNIV4_FEE_HOOK_ADDRESS,
} from "./manifest.js";
import type {
  FeeHookDescriptor,
  FeeHookExactEvidence,
  FeeHookRoute,
} from "./types.js";

/**
 * Quote evidence stays mandatory. Both execution interfaces use the same
 * framed callback and actual-debt program, with Family-owned hookData. The
 * issuer owns native conversion and its measured minimum; final-sim and
 * complete-flow input/output guards remain unchanged.
 */
export const univ4FeeHookExecution = {
  buildRuntimeLeg(input) {
    const { descriptor: d, route: r, executor } = input;
    assertProjectedRuntimeRoute(r, univ4FeeHookRoutes.project({ descriptor: d })); runtimeExecutor(executor, d.managerBinding.manager);
    if (!sameAddress(d.hook, d.poolKey.hooks) ||
        !(d.hookModel === "sat1" ? sat1Permissions(d.hook) : sameAddress(d.hook, UNIV4_FEE_HOOK_ADDRESS))) {
      throw new Error("univ4 fee-hook runtime hook binding diverged");
    }
    return buildV4RuntimeProgram({ descriptor: d, route: r, executor, actionAdapterId: "univ4-fee-hook-unlock",
      hookData: hookDataFor(d, executor, r.direction === "zero-for-one") });
  },
  runtimeProjection: () => NO_EXECUTION_RUNTIME_PROJECTION,
  buildFragment(input) {
    assertExecutionEvidence(input);
    assertProjectedRuntimeRoute(input.route, univ4FeeHookRoutes.project({ descriptor: input.descriptor }));
    runtimeExecutor(input.executor, input.descriptor.managerBinding.manager);
    const leg = buildV4RuntimeProgram({ descriptor: input.descriptor, route: input.route,
      executor: input.executor, actionAdapterId: "univ4-fee-hook-unlock", hookData: input.exactEvidence.hookData });
    return Object.freeze({
      requirements: Object.freeze([]),
      nodes: Object.freeze([Object.freeze({
        adapterId: "univ4-fee-hook-unlock",
        target: input.descriptor.managerBinding.manager,
        tokenIn: input.route.tokenIn,
        tokenOut: input.route.tokenOut,
        amount: input.amountIn,
        params: { runtimeAmountProgram: leg.program },
        children: [],
      })]),
    });
  },
  expectedEffects: ({ route }) => [
    {
      kind: "token-delta" as const,
      token: route.tokenIn,
      account: "executor" as const,
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
  FeeHookDescriptor,
  FeeHookRoute,
  FeeHookExactEvidence
>;

function assertExecutionEvidence(input: {
  readonly descriptor: FeeHookDescriptor;
  readonly route: FeeHookRoute;
  readonly amountIn: bigint;
  readonly quotedAmountOut: bigint;
  readonly exactEvidence: FeeHookExactEvidence;
  readonly minAmountOut?: bigint;
  readonly executor?: string;
  readonly runtimeEvidence?: readonly unknown[];
}): void {
  const evidence = input.exactEvidence;
  if (
    input.amountIn <= 0n || input.amountIn >= (1n << 127n) || input.quotedAmountOut <= 0n ||
    (input.minAmountOut !== undefined && (input.minAmountOut < 0n || input.minAmountOut > input.quotedAmountOut)) ||
    !(evidence.kind === "univ4-fee-hook-quoter" ||
      (evidence.kind === "sat1-local-exact-in" && input.descriptor.hookModel === "sat1")) ||
    evidence.poolId !== input.descriptor.poolId ||
    evidence.poolKeyFingerprint !== poolKeyFingerprint(input.descriptor.poolKey) ||
    !sameAddress(evidence.quoter, input.descriptor.managerBinding.quoter) ||
    !sameAddress(evidence.tokenIn, input.route.tokenIn) ||
    !sameAddress(evidence.tokenOut, input.route.tokenOut) ||
    evidence.amountIn !== input.amountIn ||
    evidence.amountOut !== input.quotedAmountOut ||
    evidence.hookData !== hookDataFor(input.descriptor, input.executor ?? "", input.route.direction === "zero-for-one")
  ) {
    throw new Error(
      "univ4 fee-hook execution received incompatible exact evidence",
    );
  }
  if (!sameAddress(input.descriptor.hook, input.descriptor.poolKey.hooks) ||
    !(input.descriptor.hookModel === "sat1" ? sat1Permissions(input.descriptor.hook) : sameAddress(input.descriptor.hook, UNIV4_FEE_HOOK_ADDRESS))) {
    throw new Error("univ4 fee-hook execution hook binding diverged");
  }
}
