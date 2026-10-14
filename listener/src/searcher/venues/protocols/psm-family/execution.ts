import { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import { runtimeLeg, runtimeExecutor } from "../../runtime-execution.js";
import { PSM_INTERFACE, PSM_WAD } from "./codec.js";
import {
  NO_EXECUTION_RUNTIME_PROJECTION,
  type ExecutionSemantics,
} from "../../adapter-family-plugin.js";
import { MAX_UINT256 } from "../standard-family/common.js";
import { assertPsmInvocation } from "./binding.js";
import { psmBuyQuote, psmSellQuote } from "./codec.js";
import type { PsmDescriptor, PsmExactEvidence, PsmRoute } from "./types.js";

export const psmExecution = {
  buildRuntimeLeg(input) {
    const { descriptor: d, route: r, executor } = input;
    assertPsmInvocation(d, r); runtimeExecutor(executor, d.target);
    const request=input.settlement;if(request&&request.kind!=="direct-output")return null;
    const recipient=request?runtimeExecutor(request.recipient,d.target,r.tokenIn,r.tokenOut):executor;
    const p = new RuntimeAmountProgram().allowance(r.tokenIn, d.target, 0, MAX_UINT256);
    const sell = r.direction === "sell-gem";
    if (!sell) {
      // buyGem takes output gem units. Invert its integer cost in this transaction,
      // using the current fee, not a stale chain-external quote.
      p.call(d.target, PSM_INTERFACE.encodeFunctionData("tout"), { static: true }).load(1, 0)
        .constant(2, PSM_WAD).math("sub", 6, 2, 1).constant(3, 1n)
        .math("add", 4, 0, 3).math("mul", 4, 4, 2).math("sub", 4, 4, 3)
        .math("add", 5, 2, 1).math("div", 4, 4, 5)
        .constant(5, d.decimalScale).math("div", 4, 4, 5);
    }
    p.call(d.target, PSM_INTERFACE.encodeFunctionData(sell ? "sellGem" : "buyGem", [recipient, 0n]),
      { patches: [{ offset: 36, reg: sell ? 0 : 4 }] });
    // buyGem spends the cost of whole gem units; any unused DAI budget stays
    // protected by the common maximum-input policy, independently of rounding.
    const leg = {...runtimeLeg("psm", p),settlement:{directOutput:true as const},
      ...(request?{settlementRequest:request}:{})};
    return sell ? leg : { ...leg, inputMode: "maximum" as const };
  },
  runtimeProjection: () => NO_EXECUTION_RUNTIME_PROJECTION,
  buildFragment(input) {
    assertPsmInvocation(input.descriptor, input.route);
    const evidence = input.exactEvidence;
    if (
      input.amountIn <= 0n ||
      input.quotedAmountOut <= 0n ||
      evidence.kind !== "psm-directional-fee" ||
      evidence.direction !== input.route.direction ||
      evidence.amountIn !== input.amountIn ||
      evidence.amountOut !== input.quotedAmountOut ||
      evidence.bindingFingerprint !== input.route.bindingRef.fingerprint
    ) {
      throw new Error("PSM execution received incompatible exact evidence");
    }
    const sell = input.route.direction === "sell-gem";
    if ((sell ? psmSellQuote : psmBuyQuote)(input.amountIn, evidence.fee,
      input.descriptor.decimalScale) !== input.quotedAmountOut) {
      throw new Error("PSM execution fee does not reproduce exact output");
    }
    return Object.freeze({
      requirements: Object.freeze([Object.freeze({
        kind: "approve" as const,
        token: input.route.tokenIn,
        spender: input.descriptor.target,
        amount: MAX_UINT256,
      })]),
      nodes: Object.freeze([Object.freeze({
        adapterId: "psm",
        target: input.descriptor.target,
        tokenIn: input.route.tokenIn,
        tokenOut: input.route.tokenOut,
        amount: input.amountIn,
        params: { direction: input.route.direction,
          gemAmount: sell ? input.amountIn : input.quotedAmountOut,
          fee: evidence.fee, scale: input.descriptor.decimalScale },
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
} satisfies ExecutionSemantics<PsmDescriptor, PsmRoute, PsmExactEvidence>;
