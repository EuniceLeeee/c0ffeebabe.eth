import type { ExecutionSemantics } from "../../adapter-family-plugin.js";
import { MAX_UINT256 } from "../standard-family/common.js";
import { assertErc4626Invocation } from "./binding.js";
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
  buildFragment(input) {
    assertErc4626Invocation(input.descriptor, input.route);
    const evidence = input.exactEvidence;
    if (
      input.amountIn <= 0n || input.quotedAmountOut <= 0n ||
      evidence.kind !== "erc4626-preview" ||
      evidence.direction !== input.route.direction ||
      evidence.amountIn !== input.amountIn ||
      evidence.amountOut !== input.quotedAmountOut ||
      evidence.bindingFingerprint !== input.route.bindingRef.fingerprint
    ) {
      throw new Error("ERC4626 execution received incompatible exact evidence");
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
