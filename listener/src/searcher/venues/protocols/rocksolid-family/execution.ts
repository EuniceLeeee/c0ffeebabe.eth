import { ethers } from "ethers";
import { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import { runtimeLeg, runtimeExecutor } from "../../runtime-execution.js";
import {
  NO_EXECUTION_RUNTIME_PROJECTION,
  type ExecutionSemantics,
} from "../../adapter-family-plugin.js";
import { MAX_UINT256 } from "../standard-family/common.js";
import { assertRocksolidInvocation } from "./binding.js";
import type {
  RocksolidDescriptor,
  RocksolidExactEvidence,
  RocksolidRoute,
} from "./types.js";

export const rocksolidExecution = {
  buildRuntimeLeg(input) {
    const { descriptor: d, route: r, executor } = input;
    assertRocksolidInvocation(d, r); runtimeExecutor(executor, d.target);
    const p = new RuntimeAmountProgram().allowance(r.tokenIn, d.target, 0, MAX_UINT256)
      .call(d.target, new ethers.Interface(["function syncDeposit(uint256,address,address)"]).encodeFunctionData("syncDeposit", [0n, executor, ethers.ZeroAddress]),
        { patches: [{ offset: 4, reg: 0 }] });
    return runtimeLeg("rocksolid-sync-deposit", p);
  },
  runtimeProjection: () => NO_EXECUTION_RUNTIME_PROJECTION,
  buildFragment(input) {
    assertRocksolidInvocation(input.descriptor, input.route);
    const evidence = input.exactEvidence;
    if (
      input.amountIn <= 0n ||
      input.quotedAmountOut <= 0n ||
      evidence.kind !== "rocksolid-convert-to-shares" ||
      evidence.amountIn !== input.amountIn ||
      evidence.amountOut !== input.quotedAmountOut ||
      evidence.bindingFingerprint !== input.route.bindingRef.fingerprint
    ) {
      throw new Error(
        "RockSolid execution received incompatible exact evidence",
      );
    }
    return Object.freeze({
      requirements: Object.freeze([Object.freeze({
        kind: "approve" as const,
        token: input.route.tokenIn,
        spender: input.descriptor.target,
        amount: MAX_UINT256,
      })]),
      nodes: Object.freeze([Object.freeze({
        adapterId: "rocksolid-sync-deposit",
        target: input.descriptor.target,
        tokenIn: input.route.tokenIn,
        tokenOut: input.route.tokenOut,
        amount: input.amountIn,
        params: {},
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
} satisfies ExecutionSemantics<
  RocksolidDescriptor,
  RocksolidRoute,
  RocksolidExactEvidence
>;
