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
import { assertOriginOusdInvocation } from "./binding.js";
import {
  ORIGIN_OUSD_VAULT_INTERFACE,
  originOusdMintQuote,
} from "./codec.js";
import type {
  OriginOusdDescriptor,
  OriginOusdExactEvidence,
  OriginOusdRoute,
} from "./types.js";

const MINT_CALLDATA =
  ORIGIN_OUSD_VAULT_INTERFACE.encodeFunctionData("mint", [0n]);

/**
 * Runtime leg for the direct USDC -> OUSD mint: exact temporary approval of the
 * incoming USDC amount, `mint(amount)` to the vault, then clear the approval.
 * The vault credits msg.sender (the executor), so a settlement request for any
 * other recipient is explicitly unsupported (null keeps the quoted path).
 */
export const originOusdExecution = {
  buildRuntimeLeg(input) {
    const { descriptor: d, route: r, executor } = input;
    assertOriginOusdInvocation(d, r);
    runtimeExecutor(executor, d.target);
    const request = input.settlement;
    if (request !== undefined) {
      if (request.kind !== "direct-output") return null;
      if (!sameAddress(request.recipient, executor)) return null;
    }
    const p = new RuntimeAmountProgram();
    runtimeExactApproval(p, r.tokenIn, d.target);
    p.call(d.target, MINT_CALLDATA, { patches: [{ offset: 4, reg: 0 }] });
    runtimeClearApproval(p, r.tokenIn, d.target);
    return {
      ...runtimeLeg("origin-ousd-mint", p),
      settlement: { directOutput: true as const },
      ...(request === undefined ? {} : { settlementRequest: request }),
    };
  },
  runtimeProjection: () => NO_EXECUTION_RUNTIME_PROJECTION,
  buildFragment(input) {
    assertOriginOusdInvocation(input.descriptor, input.route);
    const evidence = input.exactEvidence;
    if (
      input.amountIn <= 0n ||
      input.amountIn > MAX_UINT256 ||
      input.quotedAmountOut <= 0n ||
      evidence.kind !== "origin-ousd-1to1-mint" ||
      evidence.amountIn !== input.amountIn ||
      evidence.amountOut !== input.quotedAmountOut ||
      evidence.decimalScale !== input.descriptor.decimalScale ||
      !sameAddress(evidence.target, input.descriptor.target) ||
      !sameAddress(evidence.asset, input.descriptor.asset) ||
      !sameAddress(evidence.token, input.descriptor.token) ||
      evidence.bindingFingerprint !== input.route.bindingRef.fingerprint
    ) {
      throw new Error("Origin OUSD execution received incompatible exact evidence");
    }
    if (originOusdMintQuote(input.amountIn) !== input.quotedAmountOut) {
      throw new Error("Origin OUSD execution ratio does not reproduce exact output");
    }
    return Object.freeze({
      requirements: Object.freeze([Object.freeze({
        kind: "approve" as const,
        token: canonicalAddress(input.route.tokenIn),
        spender: canonicalAddress(input.descriptor.target),
        // Exact approval, never an unrequested standing allowance.
        amount: input.amountIn,
      })]),
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
    Object.freeze({
      kind: "total-supply-delta" as const,
      token: route.tokenOut,
      direction: "increase" as const,
    }),
  ]),
} satisfies ExecutionSemantics<
  OriginOusdDescriptor,
  OriginOusdRoute,
  OriginOusdExactEvidence
>;
