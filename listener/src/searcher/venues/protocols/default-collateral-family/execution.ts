import { ethers } from "ethers";
import type { ExecutionSemantics } from "../../adapter-family-plugin.js";
import { NO_EXECUTION_RUNTIME_PROJECTION } from "../../adapter-family-plugin.js";
import { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import { runtimeExecutor, runtimeLeg } from "../../runtime-execution.js";
import {
  canonicalAddress,
  sameAddress,
} from "../standard-family/common.js";
import { assertDefaultCollateralInvocation } from "./binding.js";
import {
  DEFAULT_COLLATERAL_ERC20_INTERFACE,
  DEFAULT_COLLATERAL_FEE_BPS,
  DEFAULT_COLLATERAL_INTERFACE,
  defaultCollateralUint,
} from "./codec.js";
import { DEFAULT_COLLATERAL_ACTION_ID } from "./manifest.js";
import type {
  DefaultCollateralDescriptor,
  DefaultCollateralExactEvidence,
  DefaultCollateralRoute,
} from "./types.js";

/**
 * Runtime amount program for one redeem leg. r0 is the incoming share amount
 * measured by the enclosing production runtime-amount flow, never an off-chain
 * quote: the program re-reads the vault asset(), withdraws exactly r0 shares
 * for the recipient and proves inside the executor transaction that the
 * recipient received exactly r0 asset units and the executor share balance
 * fell by exactly r0. A changed vault rate or asset wiring reverts instead of
 * silently under-delivering.
 */
export function defaultCollateralWithdrawProgram(input: {
  readonly descriptor: DefaultCollateralDescriptor;
  readonly executor: string;
  readonly recipient: string;
  readonly minimumAmountOut?: bigint;
}): RuntimeAmountProgram {
  const { descriptor: descriptor, executor, recipient } = input;
  const program = new RuntimeAmountProgram();
  program
    .call(
      descriptor.vault,
      DEFAULT_COLLATERAL_INTERFACE.encodeFunctionData("asset"),
      { static: true },
    )
    .load(1, 0)
    .constant(2, BigInt(descriptor.asset))
    .equal(1, 2)
    .call(descriptor.asset, DEFAULT_COLLATERAL_ERC20_INTERFACE
      .encodeFunctionData("balanceOf", [recipient]), { static: true })
    .load(13, 0)
    .call(descriptor.share, DEFAULT_COLLATERAL_ERC20_INTERFACE
      .encodeFunctionData("balanceOf", [executor]), { static: true })
    .load(11, 0)
    .call(
      descriptor.vault,
      DEFAULT_COLLATERAL_INTERFACE.encodeFunctionData("withdraw", [
        canonicalAddress(recipient),
        0n,
      ]),
      { patches: [{ offset: 36, reg: 0 }] },
    )
    .call(descriptor.asset, DEFAULT_COLLATERAL_ERC20_INTERFACE
      .encodeFunctionData("balanceOf", [recipient]), { static: true })
    .load(14, 0)
    .call(descriptor.share, DEFAULT_COLLATERAL_ERC20_INTERFACE
      .encodeFunctionData("balanceOf", [executor]), { static: true })
    .load(12, 0)
    .constant(5, 0n)
    // recipient receipt == incoming shares (proven 1:1 conversion)
    .math("sub", 3, 14, 13)
    .math("sub", 3, 3, 0)
    .equal(3, 5)
    // executor share burn == incoming shares
    .math("sub", 4, 11, 12)
    .math("sub", 4, 4, 0)
    .equal(4, 5);
  if (input.minimumAmountOut !== undefined) {
    const minimum = defaultCollateralUint(input.minimumAmountOut);
    // min(received, minimum) == minimum  <=>  received >= minimum
    program.constant(6, minimum).math("min", 7, 3, 6).equal(7, 6);
  }
  return program;
}

/**
 * Direct-output settlement: `withdraw(receiver, shares)` burns the executor
 * shares and transfers the asset to `receiver` inside the same call. There is
 * no callback, deferred input or approval requirement.
 */
export const defaultCollateralExecution = {
  buildRuntimeLeg(input) {
    const { descriptor, route, executor } = input;
    assertDefaultCollateralInvocation(descriptor, route);
    const actor = runtimeExecutor(
      executor,
      descriptor.vault,
      descriptor.asset,
      descriptor.implementation,
    );
    const request = input.settlement;
    let recipient = ethers.getAddress(actor);
    if (request !== undefined) {
      if (request.kind !== "direct-output") return null;
      recipient = ethers.getAddress(request.recipient);
      if (recipient === ethers.ZeroAddress) return null;
    }
    const program = defaultCollateralWithdrawProgram({
      descriptor,
      executor: actor,
      recipient,
    });
    return {
      ...runtimeLeg(DEFAULT_COLLATERAL_ACTION_ID, program),
      settlement: { directOutput: true as const },
      ...(request === undefined ? {} : { settlementRequest: request }),
    };
  },
  runtimeProjection: () => NO_EXECUTION_RUNTIME_PROJECTION,
  buildFragment(input) {
    const descriptor = input.descriptor;
    const route = input.route;
    assertDefaultCollateralInvocation(descriptor, route);
    const evidence = input.exactEvidence;
    runtimeExecutor(
      input.executor,
      descriptor.vault,
      descriptor.asset,
      descriptor.implementation,
    );
    defaultCollateralUint(input.amountIn);
    defaultCollateralUint(input.quotedAmountOut);
    defaultCollateralUint(input.minAmountOut);
    if (
      input.amountIn === 0n ||
      input.quotedAmountOut <= 0n ||
      input.minAmountOut > input.quotedAmountOut ||
      evidence.kind !== "default-collateral-one-to-one" ||
      !sameAddress(evidence.vault, descriptor.vault) ||
      !sameAddress(evidence.share, descriptor.share) ||
      !sameAddress(evidence.asset, descriptor.asset) ||
      evidence.amountIn !== input.amountIn ||
      evidence.amountOut !== input.quotedAmountOut ||
      evidence.feeBps !== DEFAULT_COLLATERAL_FEE_BPS ||
      evidence.bindingFingerprint !== route.bindingRef.fingerprint
    ) {
      throw new Error(
        "default-collateral execution received incompatible exact evidence",
      );
    }
    return Object.freeze({
      // Shares are burned from msg.sender: no ERC20 approval is required.
      requirements: Object.freeze([]),
      nodes: Object.freeze([Object.freeze({
        adapterId: DEFAULT_COLLATERAL_ACTION_ID,
        target: descriptor.vault,
        tokenIn: descriptor.share,
        tokenOut: descriptor.asset,
        amount: input.amountIn,
        params: Object.freeze({ minAmountOut: input.minAmountOut }),
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
} satisfies ExecutionSemantics<
  DefaultCollateralDescriptor,
  DefaultCollateralRoute,
  DefaultCollateralExactEvidence
>;
