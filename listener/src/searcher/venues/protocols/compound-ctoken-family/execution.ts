import {
  NO_EXECUTION_RUNTIME_PROJECTION,
  type ExecutionSemantics,
} from "../../adapter-family-plugin.js";
import { runtimeLeg } from "../../runtime-execution.js";
import { redeemProgram } from "./redeem-program.js";
import {
  assertCompoundCTokenInvocation,
  lower,
} from "./codec.js";
import { CTOKEN_REDEEM_ACTION } from "./manifest.js";
import type {
  CompoundCTokenDescriptor,
  CompoundCTokenExactEvidence,
  CompoundCTokenRoute,
} from "./types.js";

/**
 * Runtime-actual leg: `redeem(uint256 redeemTokens)` is called with the CURRENT
 * leg's working amount patched straight into the first argument from register
 * r0, which the enclosing runtime flow primes with the previous hop's actual
 * received cToken amount. No quote result, and no preset output amount, is an
 * input to this construction.
 */
export const compoundCTokenExecution: ExecutionSemantics<
  CompoundCTokenDescriptor,
  CompoundCTokenRoute,
  CompoundCTokenExactEvidence
> = {
  buildRuntimeLeg(input) {
    const { descriptor: d, route: r, executor } = input;
    assertCompoundCTokenInvocation(d, r);
    return runtimeLeg(CTOKEN_REDEEM_ACTION, redeemProgram(d.market, d.underlying, executor));
  },
  runtimeProjection: () => NO_EXECUTION_RUNTIME_PROJECTION,
  buildFragment(input) {
    assertCompoundCTokenInvocation(input.descriptor, input.route);
    const e = input.exactEvidence;
    // The central issued-exact boundary binds source before this callback;
    // ExecutionSemantics.buildFragment does not expose a second source input.
    if (
      input.amountIn <= 0n ||
      input.quotedAmountOut <= 0n ||
      input.minAmountOut <= 0n ||
      input.minAmountOut > input.quotedAmountOut ||
      e.kind !== "compound-ctoken-exchange-rate" ||
      e.direction !== "redeem" ||
      e.rateSource !== "exchange-rate-current" ||
      e.amountIn !== input.amountIn ||
      e.amountOut !== input.quotedAmountOut ||
      e.bindingFingerprint !== input.route.bindingRef.fingerprint ||
      lower(e.market) !== lower(input.descriptor.market)
    ) {
      throw new Error(
        "Compound cToken execution received incompatible exact evidence",
      );
    }
    return {
      // Redeem burns the caller's own cTokens: no approval transfer is needed.
      requirements: [],
      nodes: [{
        adapterId: CTOKEN_REDEEM_ACTION,
        target: input.descriptor.market,
        tokenIn: input.route.tokenIn,
        tokenOut: input.route.tokenOut,
        amount: input.amountIn,
        params: {
          minUnderlyingOut: input.minAmountOut,
          rateSource: e.rateSource,
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
