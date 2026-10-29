import { ethers } from "ethers";
import { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import {
  runtimeClearApproval,
  runtimeExactApproval,
  runtimeExecutor,
  runtimeLeg,
} from "../../runtime-execution.js";
import {
  NO_EXECUTION_RUNTIME_PROJECTION,
  type ExecutionSemantics,
} from "../../adapter-family-plugin.js";
import {
  canonicalAddress,
  MAX_UINT256,
  sameAddress,
} from "../standard-family/common.js";
import { assertOriginStethArmInvocation } from "./binding.js";
import {
  ORIGIN_STETH_ARM_INTERFACE,
  ORIGIN_STETH_ARM_PRICE_SCALE,
  originStethArmQuote,
  originStethArmRateGetter,
  originStethArmRateSlot,
} from "./codec.js";
import {
  ORIGIN_STETH_ARM_ACTION_ID,
} from "./manifest.js";
import type {
  OriginStethArmDescriptor,
  OriginStethArmExactEvidence,
  OriginStethArmRoute,
} from "./types.js";

/**
 * Quoted fragment: exact approval of the input amount to the ARM proxy and the
 * verified `swapExactTokensForTokens(tokenIn, tokenOut, amount, minOut,
 * executor)` call. The ARM pulls the input from msg.sender (the executor) with
 * transferFrom and sends the output straight to `to`; settlement is one
 * direct-output transfer, so no callback or deferred-input path is claimed.
 */
export const originStethArmExecution = {
  buildRuntimeLeg(input) {
    const { descriptor: d, route: r, executor } = input;
    assertOriginStethArmInvocation(d, r);
    runtimeExecutor(executor, d.target);
    const request = input.settlement;
    let recipient = ethers.getAddress(executor);
    if (request !== undefined) {
      if (request.kind !== "direct-output") return null;
      recipient = ethers.getAddress(request.recipient);
      if (recipient === ethers.ZeroAddress) return null;
    }
    const p = new RuntimeAmountProgram();
    // The swap's own price word, read in this transaction: minOut is the
    // protocol's integer amount for the actual incoming amount, never an
    // off-chain Exact value and never a preset output.
    p.call(
      d.target,
      ORIGIN_STETH_ARM_INTERFACE.encodeFunctionData(
        originStethArmRateGetter(r.direction),
      ),
      { static: true },
    )
      .load(1, 0)
      .math("mul", 2, 0, 1)
      .constant(3, ORIGIN_STETH_ARM_PRICE_SCALE)
      .math("div", 2, 2, 3);
    runtimeExactApproval(p, r.tokenIn, d.target);
    p.call(
      d.target,
      ORIGIN_STETH_ARM_INTERFACE.encodeFunctionData(
        "swapExactTokensForTokens",
        [r.tokenIn, r.tokenOut, 0n, 0n, recipient],
      ),
      { patches: [{ offset: 68, reg: 0 }, { offset: 100, reg: 2 }] },
    );
    runtimeClearApproval(p, r.tokenIn, d.target);
    return {
      ...runtimeLeg(ORIGIN_STETH_ARM_ACTION_ID, p),
      settlement: { directOutput: true as const },
      ...(request === undefined ? {} : { settlementRequest: request }),
    };
  },
  runtimeProjection: () => NO_EXECUTION_RUNTIME_PROJECTION,
  buildFragment(input) {
    assertOriginStethArmInvocation(input.descriptor, input.route);
    const evidence = input.exactEvidence;
    if (
      input.amountIn <= 0n ||
      input.amountIn > MAX_UINT256 ||
      input.quotedAmountOut <= 0n ||
      input.minAmountOut < 0n ||
      input.minAmountOut > input.quotedAmountOut ||
      evidence.kind !== "origin-steth-arm-linear-price" ||
      evidence.target.toLowerCase() !== input.descriptor.target.toLowerCase() ||
      !sameAddress(evidence.tokenIn, input.route.tokenIn) ||
      !sameAddress(evidence.tokenOut, input.route.tokenOut) ||
      evidence.direction !== input.route.direction ||
      evidence.rateSlot !== originStethArmRateSlot(input.route.direction) ||
      evidence.amountIn !== input.amountIn ||
      evidence.amountOut !== input.quotedAmountOut ||
      evidence.bindingFingerprint !== input.route.bindingRef.fingerprint
    ) {
      throw new Error(
        "Origin stETH ARM execution received incompatible exact evidence",
      );
    }
    if (originStethArmQuote(input.amountIn, evidence.rate) !== input.quotedAmountOut) {
      throw new Error(
        "Origin stETH ARM execution price does not reproduce exact output",
      );
    }
    return Object.freeze({
      requirements: Object.freeze([Object.freeze({
        kind: "approve" as const,
        token: canonicalAddress(input.route.tokenIn),
        spender: canonicalAddress(input.descriptor.target),
        amount: input.amountIn,
      })]),
      nodes: Object.freeze([Object.freeze({
        adapterId: ORIGIN_STETH_ARM_ACTION_ID,
        target: input.descriptor.target,
        tokenIn: input.route.tokenIn,
        tokenOut: input.route.tokenOut,
        amount: input.amountIn,
        params: Object.freeze({ minAmountOut: input.minAmountOut }),
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
  OriginStethArmDescriptor,
  OriginStethArmRoute,
  OriginStethArmExactEvidence
>;
