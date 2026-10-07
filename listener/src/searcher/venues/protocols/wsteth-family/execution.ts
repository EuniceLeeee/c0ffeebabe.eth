import { ethers } from "ethers";
import { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import { runtimeLeg, runtimeExecutor } from "../../runtime-execution.js";
import {
  NO_EXECUTION_RUNTIME_PROJECTION,
  type ExecutionSemantics,
} from "../../adapter-family-plugin.js";
import { MAX_UINT256 } from "../standard-family/common.js";
import { assertWstethInvocation } from "./binding.js";
import type {
  WstethDescriptor,
  WstethExactEvidence,
  WstethRoute,
} from "./types.js";

export const wstethExecution = {
  buildRuntimeLeg(input) {
    const { descriptor: d, route: r, executor } = input;
    assertWstethInvocation(d, r); runtimeExecutor(executor, d.target);
    const p = new RuntimeAmountProgram();
    if (r.direction === "wrap") p.allowance(r.tokenIn, d.target, 0, MAX_UINT256);
    p.call(d.target, new ethers.Interface(["function wrap(uint256)", "function unwrap(uint256)"]).encodeFunctionData(r.direction, [0n]),
      { patches: [{ offset: 4, reg: 0 }] });
    return runtimeLeg(r.adapterId, p);
  },
  runtimeProjection: () => NO_EXECUTION_RUNTIME_PROJECTION,
  buildFragment(input) {
    assertWstethInvocation(input.descriptor, input.route);
    const evidence = input.exactEvidence;
    if (
      input.amountIn <= 0n ||
      input.quotedAmountOut <= 0n ||
      evidence.kind !== "wsteth-conversion-quote" ||
      evidence.direction !== input.route.direction ||
      evidence.amountIn !== input.amountIn ||
      evidence.amountOut !== input.quotedAmountOut ||
      evidence.bindingFingerprint !== input.route.bindingRef.fingerprint
    ) {
      throw new Error(
        "wstETH execution received incompatible exact evidence",
      );
    }
    return Object.freeze({
      requirements: input.route.direction === "wrap"
        ? Object.freeze([Object.freeze({
            kind: "approve" as const,
            token: input.route.tokenIn,
            spender: input.descriptor.target,
            amount: MAX_UINT256,
          })])
        : Object.freeze([]),
      nodes: Object.freeze([Object.freeze({
        adapterId: input.route.adapterId,
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
  WstethDescriptor,
  WstethRoute,
  WstethExactEvidence
>;
