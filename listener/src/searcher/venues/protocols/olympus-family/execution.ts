import type { ExecutionSemantics } from "../../adapter-family-plugin.js";
import { NO_EXECUTION_RUNTIME_PROJECTION } from "../../adapter-family-plugin.js";
import {
  runtimeLeg,
  runtimeExecutor,
} from "../../runtime-execution.js";
import { MAX_UINT256, sameAddress } from "../standard-family/common.js";
import { assertOlympusInvocation } from "./binding.js";
import { olympusQuote } from "./codec.js";
import { olympusDirectProgram } from "./direct.js";
import type {
  OlympusDescriptor,
  OlympusExactEvidence,
  OlympusRoute,
} from "./types.js";

export const olympusExecution = {
  buildRuntimeLeg(input) {
    const { descriptor: d, route: r, executor } = input;
    assertOlympusInvocation(d, r);
    if (input.runtimeEvidence.length !== 0) {
      throw new Error("Olympus runtime does not accept external evidence");
    }
    const request = input.settlement;
    if (request && request.kind !== "direct-output") return null;
    const actor = runtimeExecutor(executor, d.staking, d.gOHM, d.OHM);
    const recipient = request
      ? runtimeExecutor(request.recipient, d.staking, d.gOHM, d.OHM)
      : actor;
    const leg = {
      ...runtimeLeg(r.adapterId, olympusDirectProgram(d, actor, recipient)),
      settlement: { directOutput: true as const },
      ...(request ? { settlementRequest: request } : {}),
    };
    return leg;
  },
  runtimeProjection: () => NO_EXECUTION_RUNTIME_PROJECTION,
  buildFragment(input) {
    assertOlympusInvocation(input.descriptor, input.route);
    runtimeExecutor(input.executor, input.descriptor.staking,
      input.descriptor.gOHM, input.descriptor.OHM);
    const evidence = input.exactEvidence;
    if (
      input.amountIn <= 0n ||
      input.amountIn > MAX_UINT256 ||
      input.quotedAmountOut <= 0n ||
      evidence.kind !== "olympus-index-unstake" ||
      evidence.amountIn !== input.amountIn ||
      evidence.amountOut !== input.quotedAmountOut ||
      evidence.index <= 0n ||
      evidence.bindingFingerprint !== input.route.bindingRef.fingerprint ||
      !sameAddress(evidence.staking, input.descriptor.staking) ||
      !sameAddress(evidence.gOHM, input.descriptor.gOHM) ||
      !sameAddress(evidence.OHM, input.descriptor.OHM) ||
      olympusQuote(input.amountIn, evidence.index) !== input.quotedAmountOut
    ) {
      throw new Error("Olympus execution received incompatible exact evidence");
    }
    return Object.freeze({
      // The staking contract burns gOHM from msg.sender; no allowance exists
      // between the executor and the staking contract.
      requirements: Object.freeze([]),
      nodes: Object.freeze([Object.freeze({
        adapterId: "olympus-unstake",
        target: input.descriptor.staking,
        tokenIn: input.descriptor.gOHM,
        tokenOut: input.descriptor.OHM,
        amount: input.amountIn,
        params: Object.freeze({
          index: evidence.index,
          quotedAmountOut: input.quotedAmountOut,
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
} satisfies ExecutionSemantics<
  OlympusDescriptor,
  OlympusRoute,
  OlympusExactEvidence
>;
