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

export const erc4626Execution: ExecutionSemantics<
  Erc4626Descriptor,
  Erc4626Route,
  Erc4626ExactEvidence
> = {
  buildRuntimeLeg(input) {
    const { descriptor: d, route: r, executor } = input;
    assertErc4626Invocation(d, r); runtimeExecutor(executor, d.vault);
    if (d.infinifi !== undefined) {
      assertCustodianExecutionSource(input.source);
      if (input.runtimeEvidence.length) throw new Error("InfiniFi pending runtime evidence unsupported");
      return runtimeLeg(r.adapterId, infinifiProgram(d.infinifi, executor, r.direction));
    }
    if (d.custodian !== undefined) {
      assertCustodianExecutionSource(input.source);
      runtimeExecutor(executor, d.custodian.proxyAdmin);
      if (input.runtimeEvidence.length) throw new Error("Custodian pending runtime evidence unsupported");
      return runtimeLeg(r.adapterId, custodianProgram(d, executor, r.direction));
    }
    const p = new RuntimeAmountProgram();
    const abi = new ethers.Interface(["function deposit(uint256,address)", "function redeem(uint256,address,address)"]);
    if (r.direction === "deposit") p.allowance(r.tokenIn, d.vault, 0, MAX_UINT256);
    p.call(d.vault, abi.encodeFunctionData(r.direction, r.direction === "deposit" ? [0n, executor] : [0n, executor, executor]),
      { patches: [{ offset: 4, reg: 0 }] });
    return runtimeLeg(r.adapterId, p);
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
