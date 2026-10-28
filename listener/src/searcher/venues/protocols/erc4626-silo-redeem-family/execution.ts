import { ethers } from "ethers";
import { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import { runtimeLeg, runtimeExecutor, RUNTIME_ERC20 } from "../../runtime-execution.js";
import {
  NO_EXECUTION_RUNTIME_PROJECTION,
  type ExecutionSemantics,
} from "../../adapter-family-plugin.js";
import { sameAddress } from "../standard-family/common.js";
import { assertErc4626SiloInvocation, ERC4626_SILO_INTERFACE } from "./shared.js";
import type {
  Erc4626SiloRedeemDescriptor,
  Erc4626SiloRedeemExactEvidence,
  Erc4626SiloRedeemRoute,
} from "./types.js";

export const erc4626SiloRedeemExecution = {
  buildRuntimeLeg(input) {
    const { descriptor: d, route: r, executor } = input;
    assertErc4626SiloInvocation(d, r); runtimeExecutor(executor, d.vault);
    const request = input.settlement;
    if (request?.kind === "quote-output" || request?.kind === "deferred-input") return null;
    if (request?.kind === "direct-output") {
      const recipient = runtimeExecutor(request.recipient, d.vault, d.payoutToken, d.underlyingAsset);
      runtimeExecutor(executor, d.payoutToken, d.underlyingAsset);
      const external = !sameAddress(recipient, executor);
      const p = new RuntimeAmountProgram().constant(15, 1n).math("sub", 14, 0, 15);
      const balance = (token: string, account: string, reg: number) =>
        p.call(token, RUNTIME_ERC20.encodeFunctionData("balanceOf", [account]), { static: true }).load(reg, 0);
      balance(d.vault, executor, 1).math("sub", 14, 1, 0);
      balance(d.payoutToken, recipient, 2);
      p.call(d.vault, ERC4626_SILO_INTERFACE.encodeFunctionData("totalSupply"), { static: true }).load(3, 0).nativeBalance(4);
      if (external) { balance(d.payoutToken, executor, 5); balance(d.vault, recipient, 6); }
      p.call(d.vault, ERC4626_SILO_INTERFACE.encodeFunctionData("redeem", [r.tokenOut, 0n, recipient, executor]),
        { patches: [{ offset: 36, reg: 0 }] }).load(7, 0).math("sub", 14, 7, 15);
      balance(d.vault, executor, 8).math("sub", 8, 1, 8).equal(8, 0);
      balance(d.payoutToken, recipient, 8).math("sub", 8, 8, 2).equal(8, 7);
      p.call(d.vault, ERC4626_SILO_INTERFACE.encodeFunctionData("totalSupply"), { static: true })
        .load(8, 0).math("sub", 8, 3, 8).equal(8, 0).nativeBalance(8).equal(8, 4);
      if (external) { balance(d.payoutToken, executor, 8).equal(8, 5); balance(d.vault, recipient, 8).equal(8, 6); }
      return { ...runtimeLeg(r.adapterId, p), settlement: { directOutput: true }, settlementRequest: request };
    }
    const p = new RuntimeAmountProgram().call(d.vault,
      new ethers.Interface(["function redeem(address,uint256,address,address)"]).encodeFunctionData("redeem", [r.tokenOut, 0n, executor, executor]),
      { patches: [{ offset: 36, reg: 0 }] });
    return { ...runtimeLeg(r.adapterId, p), settlement: { directOutput: true } };
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
