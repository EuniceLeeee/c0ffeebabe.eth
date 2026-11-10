import { ethers } from "ethers";
import { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import {
  assertProjectedRuntimeRoute,
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
import { assertMetafactoryInvocation } from "./binding.js";
import {
  METAFACTORY_INTERFACE,
  metafactoryRedeemAmount,
} from "./codec.js";
import { metafactoryRoutes } from "./routes.js";
import type {
  MetafactoryDescriptor,
  MetafactoryExactEvidence,
  MetafactoryRoute,
} from "./types.js";

/**
 * Raw protocol operation only:
 *   approve(composter, 0) -> approve(composter, amount)
 *   -> compostAndRedeem(amount, 0)
 *   -> approve(composter, 0)
 *
 * The composter burns ROBOT from msg.sender and pays raw native ETH back to
 * msg.sender. It has no payout-recipient argument, so a settlement request for
 * any account other than the executor is unsupported (null keeps the quoted
 * path). The shared execution-asset boundary wraps the measured native receipt;
 * the Family never wraps or unwraps inside the program.
 */
export const metafactoryExecution = {
  buildRuntimeLeg(input) {
    const { descriptor: d, route: r, executor } = input;
    assertMetafactoryInvocation(d, r);
    runtimeExecutor(executor, d.target);
    assertProjectedRuntimeRoute(
      r, metafactoryRoutes.project({ descriptor: d }));
    const request = input.settlement;
    if (request !== undefined) {
      if (request.kind !== "direct-output") return null;
      // Native ETH can only be delivered to msg.sender; a third-party payee is
      // not part of this verified deployment.
      if (!sameAddress(request.recipient, executor)) return null;
    }
    const p = new RuntimeAmountProgram();
    runtimeExactApproval(p, r.tokenIn, d.target);
    p.call(
      d.target,
      METAFACTORY_INTERFACE.encodeFunctionData(
        "compostAndRedeem",
        [0n, ethers.ZeroAddress],
      ),
      { patches: [{ offset: 4, reg: 0 }] },
    );
    runtimeClearApproval(p, r.tokenIn, d.target);
    return {
      ...runtimeLeg(r.adapterId, p),
      settlement: { directOutput: true as const },
      ...(request === undefined ? {} : { settlementRequest: request }),
    };
  },
  runtimeProjection: () => NO_EXECUTION_RUNTIME_PROJECTION,
  buildFragment(input) {
    assertMetafactoryInvocation(input.descriptor, input.route);
    const evidence = input.exactEvidence;
    if (
      input.amountIn <= 0n ||
      input.amountIn > MAX_UINT256 ||
      input.quotedAmountOut <= 0n ||
      input.minAmountOut < 0n ||
      input.minAmountOut > input.quotedAmountOut ||
      evidence.kind !== "metafactory-pro-rata-eth-quote" ||
      evidence.amountIn !== input.amountIn ||
      evidence.amountOut !== input.quotedAmountOut ||
      !sameAddress(evidence.target, input.descriptor.target) ||
      !sameAddress(evidence.tokenIn, input.descriptor.tokenIn) ||
      !sameAddress(evidence.nativeAnchor, input.descriptor.nativeAnchor) ||
      !sameAddress(evidence.executor, input.executor) ||
      evidence.bindingFingerprint !== input.route.bindingRef.fingerprint ||
      metafactoryRedeemAmount(
        input.amountIn,
        evidence.totalEthAllocated,
        evidence.circulatingSupply,
      ) !== input.quotedAmountOut
    ) {
      throw new Error(
        "metafactory execution received incompatible exact evidence",
      );
    }
    return Object.freeze({
      // The Family-owned action carries its own temporary approval pair, so the
      // shared approve infra is not required for this route.
      requirements: Object.freeze([]),
      nodes: Object.freeze([Object.freeze({
        adapterId: input.route.adapterId,
        target: canonicalAddress(input.descriptor.target),
        tokenIn: canonicalAddress(input.route.tokenIn),
        tokenOut: canonicalAddress(input.route.tokenOut),
        amount: input.amountIn,
        params: {},
        children: [],
      })]),
    });
  },
  expectedEffects({ route }) {
    return Object.freeze([
      Object.freeze({
        kind: "token-delta" as const,
        token: route.tokenIn,
        account: "executor" as const,
        direction: "decrease" as const,
      }),
      // The raw payout is native ETH; the shared boundary wraps it into the
      // graph asset before settlement, which is the measured effect.
      Object.freeze({
        kind: "token-delta" as const,
        token: route.tokenOut,
        account: "executor" as const,
        direction: "increase" as const,
      }),
    ]);
  },
} satisfies ExecutionSemantics<
  MetafactoryDescriptor,
  MetafactoryRoute,
  MetafactoryExactEvidence
>;
