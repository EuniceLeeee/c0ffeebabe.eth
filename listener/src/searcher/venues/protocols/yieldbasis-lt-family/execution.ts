import { ethers } from "ethers";
import { RuntimeAmountProgram } from
  "../../../../adapters/runtime-amount-program.js";
import {
  NO_EXECUTION_RUNTIME_PROJECTION,
  type ExecutionSemantics,
} from "../../adapter-family-plugin.js";
import { runtimeExecutor, runtimeLeg } from "../../runtime-execution.js";
import { LT_INTERFACE } from "./abi.js";
import {
  assertYieldBasisLtInvocation,
  lower,
} from "./codec.js";
import { YIELDBASIS_WITHDRAW_ACTION } from "./manifest.js";
import type {
  YieldBasisLtDescriptor,
  YieldBasisLtExactEvidence,
  YieldBasisLtRoute,
} from "./types.js";

/**
 * Runtime-actual leg: `withdraw(uint256 shares, uint256 min_assets)` is called
 * with the CURRENT leg's working amount patched straight into the shares
 * argument from register r0, which the enclosing runtime flow primes with the
 * previous hop's actual received LT amount. No quote result, no preset output
 * amount and no off-chain Exact call is an input to this construction.
 *
 * The `min_assets` argument is encoded as 0 in this path BY CONSTRUCTION: a
 * runtime leg may not read a quoted floor, so the builder cannot invent one.
 * Output protection for a runtime flow is supplied by the enclosing flow's own
 * checks, and the specified-amount `buildFragment` path — which carries the real
 * floor — is the one used for quoted execution.
 */
export const yieldBasisLtExecution: ExecutionSemantics<
  YieldBasisLtDescriptor,
  YieldBasisLtRoute,
  YieldBasisLtExactEvidence
> = {
  buildRuntimeLeg(input) {
    const { descriptor: d, route: r, executor } = input;
    assertYieldBasisLtInvocation(d, r);
    runtimeExecutor(executor, d.lt, d.asset);
    const program = new RuntimeAmountProgram();
    program.call(
      d.lt,
      ethers.getBytes(
        LT_INTERFACE.encodeFunctionData("withdraw(uint256,uint256)", [
          0n,
          0n,
        ]),
      ),
      { patches: [{ offset: 4, reg: 0 }] },
    );
    return runtimeLeg(YIELDBASIS_WITHDRAW_ACTION, program);
  },
  runtimeProjection: () => NO_EXECUTION_RUNTIME_PROJECTION,
  buildFragment(input) {
    assertYieldBasisLtInvocation(input.descriptor, input.route);
    const e = input.exactEvidence;
    if (
      input.amountIn <= 0n ||
      input.quotedAmountOut <= 0n ||
      input.minAmountOut <= 0n ||
      input.minAmountOut > input.quotedAmountOut ||
      e.kind !== "yieldbasis-lt-withdraw-preview" ||
      e.direction !== "withdraw" ||
      e.amountIn !== input.amountIn ||
      e.amountOut !== input.quotedAmountOut ||
      e.bindingFingerprint !== input.route.bindingRef.fingerprint ||
      lower(e.lt) !== lower(input.descriptor.lt) ||
      lower(e.asset) !== lower(input.descriptor.asset)
    ) {
      throw new Error(
        "Yield Basis LT execution received incompatible exact evidence",
      );
    }
    return {
      // withdraw burns the caller's own LT shares and pulls no input token:
      // no approval transfer is required.
      requirements: [],
      nodes: [{
        adapterId: YIELDBASIS_WITHDRAW_ACTION,
        target: input.descriptor.lt,
        tokenIn: input.route.tokenIn,
        tokenOut: input.route.tokenOut,
        amount: input.amountIn,
        params: {
          // `withdraw`'s second argument is the on-chain slippage floor. It is
          // carried here unchanged so the encoder can encode exactly the quoted
          // floor; the capacity evidence stays in exactEvidence.
          minAssetsOut: input.minAmountOut,
        },
        children: [],
      }],
    };
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
      token: route.tokenIn,
      direction: "decrease" as const,
    }),
  ]),
};
