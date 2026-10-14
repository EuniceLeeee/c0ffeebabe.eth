import { ethers } from "ethers";
import { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import { runtimeLeg, runtimeExecutor } from "../../runtime-execution.js";
import {
  NO_EXECUTION_RUNTIME_PROJECTION,
  type ExecutionSemantics,
} from "../../adapter-family-plugin.js";
import { MAX_UINT256 } from "../standard-family/common.js";
import { assertErc4626Invocation } from "./binding.js";
import { INFINIFI_VARIANT } from "./infinifi.js";
import { infinifiProgram } from "./infinifi-execution.js";
import { CUSTODIAN_VARIANT } from "./custodian.js";
import { assertCustodianExecutionSource, custodianProgram } from "./custodian-execution.js";
import { sameAddress } from "../standard-family/common.js";
import type {
  Erc4626Descriptor,
  Erc4626ExactEvidence,
  Erc4626Route,
} from "./types.js";

/** Standard receiver/owner split. Scope is the already admitted operation;
 * a nonstandard implementation that ignores receiver fails the fresh receipt. */
export function standardRecipientProgram(d: Pick<Erc4626Descriptor, "vault" | "share" | "asset">,
  executor: string, direction: "deposit" | "redeem", recipient: string): RuntimeAmountProgram {
  runtimeExecutor(executor, d.vault, d.asset); runtimeExecutor(recipient, d.vault, d.asset);
  const deposit = direction === "deposit", input = deposit ? d.asset : d.share, output = deposit ? d.share : d.asset;
  const abi = new ethers.Interface(["function deposit(uint256,address)", "function redeem(uint256,address,address)",
    "function balanceOf(address) view returns(uint256)"]);
  const p = new RuntimeAmountProgram().constant(15, 1n).math("sub", 12, 0, 15).nativeBalance(9);
  p.call(input, abi.encodeFunctionData("balanceOf", [executor]), { static: true }).load(1, 0)
    .call(output, abi.encodeFunctionData("balanceOf", [recipient]), { static: true }).load(2, 0);
  if (deposit) p.allowance(input, d.vault, 0, MAX_UINT256);
  p.call(d.vault, abi.encodeFunctionData(direction, deposit ? [0n, recipient] : [0n, recipient, executor]),
    { patches: [{ offset: 4, reg: 0 }] }).load(3, 0)
    .call(input, abi.encodeFunctionData("balanceOf", [executor]), { static: true }).load(4, 0).math("sub", 4, 1, 4).equal(4, 0)
    .call(output, abi.encodeFunctionData("balanceOf", [recipient]), { static: true }).load(4, 0).math("sub", 4, 4, 2).equal(4, 3)
    .math("sub", 12, 4, 15).nativeBalance(4).equal(4, 9);
  return p;
}
export const erc4626Execution: ExecutionSemantics<
  Erc4626Descriptor,
  Erc4626Route,
  Erc4626ExactEvidence
> = {
  buildRuntimeLeg(input) {
    const { descriptor: d, route: r, executor } = input;
    assertErc4626Invocation(d, r); runtimeExecutor(executor, d.vault);
    const request = input.settlement;
    if (request && (request.kind !== "direct-output" || d.infinifi !== undefined)) return null;
    const recipient = request ? runtimeExecutor(request.recipient, d.vault, d.share, d.asset,
      ...(d.custodian ? [d.custodian.proxyAdmin] : [])) : executor;
    const settle = { settlement: { directOutput: true as const }, ...(request ? { settlementRequest: request } : {}) };
    if (d.infinifi !== undefined) {
      assertCustodianExecutionSource(input.source);
      if (input.runtimeEvidence.length) throw new Error("InfiniFi pending runtime evidence unsupported");
      return runtimeLeg(r.adapterId, infinifiProgram(d.infinifi, executor, r.direction));
    }
    if (d.custodian !== undefined) {
      assertCustodianExecutionSource(input.source);
      runtimeExecutor(executor, d.custodian.proxyAdmin);
      if (input.runtimeEvidence.length) throw new Error("Custodian pending runtime evidence unsupported");
      return { ...runtimeLeg(r.adapterId, custodianProgram(d, executor, r.direction, 1n, recipient)), ...settle };
    }
    if (request) return { ...runtimeLeg(r.adapterId, standardRecipientProgram(d, executor, r.direction, recipient)), ...settle };
    const p = new RuntimeAmountProgram();
    const abi = new ethers.Interface(["function deposit(uint256,address)", "function redeem(uint256,address,address)"]);
    if (r.direction === "deposit") p.allowance(r.tokenIn, d.vault, 0, MAX_UINT256);
    p.call(d.vault, abi.encodeFunctionData(r.direction, r.direction === "deposit" ? [0n, executor] : [0n, executor, executor]),
      { patches: [{ offset: 4, reg: 0 }] });
    return { ...runtimeLeg(r.adapterId, p), ...settle };
  },
  runtimeProjection: () => NO_EXECUTION_RUNTIME_PROJECTION,
  buildFragment(input) {
    assertErc4626Invocation(input.descriptor, input.route);
    const evidence = input.exactEvidence;
    if (
      input.amountIn <= 0n || input.quotedAmountOut <= 0n ||
      evidence.kind !== (input.descriptor.infinifi !== undefined ? "infinifi-gateway-preview" : input.descriptor.custodian === undefined ? "erc4626-preview" : "frax-custodian-preview") ||
      evidence.direction !== input.route.direction ||
      evidence.amountIn !== input.amountIn ||
      evidence.amountOut !== input.quotedAmountOut ||
      evidence.bindingFingerprint !== input.route.bindingRef.fingerprint
    ) {
      throw new Error("ERC4626 execution received incompatible exact evidence");
    }
    if (input.descriptor.infinifi !== undefined) {
      const b = input.descriptor.infinifi;
      assertCustodianExecutionSource(evidence.source);
      if (!evidence.executor || !sameAddress(evidence.executor, input.executor) ||
          !sameAddress(evidence.vault, input.descriptor.vault) || input.runtimeEvidence.length)
        throw new Error("InfiniFi execution actor/evidence mismatch");
      infinifiProgram(b, input.executor, input.route.direction, input.minAmountOut);
      return { requirements: [], nodes: [{ adapterId: input.route.adapterId, target: input.descriptor.vault,
        tokenIn: input.route.tokenIn, tokenOut: input.route.tokenOut, amount: input.amountIn,
        params: { variant: INFINIFI_VARIANT, minimumOut: input.minAmountOut, gateway: b.gateway, core: b.core, yieldSharing: b.yieldSharing }, children: [] }] };
    }
    if (input.descriptor.custodian !== undefined) {
      assertCustodianExecutionSource(evidence.source);
      if (!evidence.executor || !sameAddress(evidence.executor, input.executor) ||
          !sameAddress(evidence.vault, input.descriptor.vault) || input.runtimeEvidence.length)
        throw new Error("Custodian execution actor/evidence mismatch");
      runtimeExecutor(input.executor, input.descriptor.custodian.proxyAdmin);
      custodianProgram(input.descriptor, input.executor, input.route.direction, input.minAmountOut);
      return { requirements: [], nodes: [{ adapterId: input.route.adapterId, target: input.descriptor.vault,
        tokenIn: input.route.tokenIn, tokenOut: input.route.tokenOut, amount: input.amountIn,
        params: { variant: CUSTODIAN_VARIANT, minimumOut: input.minAmountOut }, children: [] }] };
    }
    return Object.freeze({
      requirements: input.route.direction === "deposit"
        ? Object.freeze([Object.freeze({
            kind: "approve" as const,
            token: input.route.tokenIn,
            spender: input.descriptor.vault,
            amount: MAX_UINT256,
          })])
        : Object.freeze([]),
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
      token: route.direction === "deposit" ? route.tokenOut : route.tokenIn,
      direction: route.direction === "deposit"
        ? "increase" as const
        : "decrease" as const,
    }),
  ]),
};
