import { ethers } from "ethers";
import { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import { runtimeLeg, runtimeExecutor } from "../../runtime-execution.js";
import {
  NO_EXECUTION_RUNTIME_PROJECTION,
  type ExecutionSemantics,
} from "../../adapter-family-plugin.js";
import { sameAddress } from "../standard-family/common.js";
import { assertErc4626SiloInvocation } from "./shared.js";
import type {
  Erc4626SiloRedeemDescriptor,
  Erc4626SiloRedeemExactEvidence,
  Erc4626SiloRedeemRoute,
} from "./types.js";

export const erc4626SiloRedeemExecution = {
  buildRuntimeLeg(input) {
    const { descriptor: d, route: r, executor } = input;
    assertErc4626SiloInvocation(d, r); runtimeExecutor(executor, d.vault);
    const p = new RuntimeAmountProgram().call(d.vault,
      new ethers.Interface(["function redeem(address,uint256,address,address)"]).encodeFunctionData("redeem", [r.tokenOut, 0n, executor, executor]),
      { patches: [{ offset: 36, reg: 0 }] });
    return runtimeLeg(r.adapterId, p);
  },
  runtimeProjection: () => NO_EXECUTION_RUNTIME_PROJECTION,
  buildFragment(input) {
    assertErc4626SiloInvocation(input.descriptor, input.route);
    const evidence = input.exactEvidence;
    if (
      input.amountIn <= 0n ||
      input.quotedAmountOut <= 0n ||
      evidence.kind !== "erc4626-silo-preview-chain" ||
      evidence.previewAssets <= 0n ||
      evidence.amountIn !== input.amountIn ||
      evidence.amountOut !== input.quotedAmountOut ||
      !sameAddress(evidence.vault, input.descriptor.vault) ||
      !sameAddress(evidence.payoutToken, input.descriptor.payoutToken) ||
      evidence.bindingFingerprint !== input.route.bindingRef.fingerprint
    ) {
      throw new Error(
        "ERC4626 Silo execution received incompatible exact evidence",
      );
    }
    return Object.freeze({
      requirements: Object.freeze([]),
      nodes: Object.freeze([Object.freeze({
        adapterId: input.route.adapterId,
        target: input.descriptor.vault,
        tokenIn: input.route.tokenIn,
        tokenOut: input.route.tokenOut,
        amount: input.amountIn,
        params: {},
        children: [],
      })]),
    });
  },
  expectedEffects: ({ descriptor, route }) => Object.freeze([
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
      token: descriptor.vault,
      direction: "decrease" as const,
    }),
  ]),
} satisfies ExecutionSemantics<
  Erc4626SiloRedeemDescriptor,
  Erc4626SiloRedeemRoute,
  Erc4626SiloRedeemExactEvidence
>;
