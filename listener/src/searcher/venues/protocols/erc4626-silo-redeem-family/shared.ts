import { ethers } from "ethers";
import type {
  AdapterRequest,
  AdapterRequestResult,
  CallerRef,
} from "../../adapter-request-program.js";
import { hashCanonical } from "../../canonical-value.js";
import {
  assertRouteBound,
  canonicalAddress,
  lowerAddress,
  sameAddress,
} from "../standard-family/common.js";
import type {
  Erc4626SiloRedeemDescriptor,
  Erc4626SiloRedeemRoute,
} from "./types.js";

export const ERC4626_SILO_INTERFACE = new ethers.Interface([
  "function asset() view returns (address)",
  "function totalSupply() view returns (uint256)",
  "function previewRedeem(uint256 shares) view returns (uint256 assets)",
  "function redeem(address token,uint256 shares,address receiver,address owner) returns (uint256 amountOut)",
  "function withdraw(address token,uint256 assets,address receiver,address owner) returns (uint256 shares)",
]);
export const ERC4626_SILO_PAYOUT_INTERFACE = new ethers.Interface([
  "function asset() view returns (address)",
  "function previewWithdraw(uint256 assets) view returns (uint256 shares)",
]);
export const ERC4626_SILO_ERC20_INTERFACE = new ethers.Interface([
  "function decimals() view returns (uint8)",
]);
export const ERC4626_SILO_PROBE_ACTOR = ethers.getAddress(
  `0x${"00".repeat(18)}51a0`,
);
export const ERC4626_SILO_PROBE_ACTOR_EVIDENCE_ID =
  "erc4626-silo-probe-actor";
export const ERC4626_SILO_DEFAULT_SAMPLE_SHARES = 10n ** 18n;

export function erc4626SiloStaticProjection(
  descriptor: Erc4626SiloRedeemDescriptor,
) {
  return {
    vault: lowerAddress(descriptor.vault),
    payoutToken: lowerAddress(descriptor.payoutToken),
    underlyingAsset: lowerAddress(descriptor.underlyingAsset),
    redeemSemantics: "silo-multitoken-exact-in-v1",
  };
}

export function assertErc4626SiloInvocation(
  descriptor: Erc4626SiloRedeemDescriptor,
  route: Erc4626SiloRedeemRoute,
): void {
  assertRouteBound({
    descriptorInstanceKey: descriptor.instanceKey,
    descriptorTarget: descriptor.vault,
    route,
    bindingFingerprint: hashCanonical(erc4626SiloStaticProjection(descriptor)),
  });
  if (
    route.direction !== "silo-redeem" ||
    route.adapterId !== "erc4626-redeem-silo" ||
    !sameAddress(route.tokenIn, descriptor.vault) ||
    !sameAddress(route.tokenOut, descriptor.payoutToken)
  ) {
    throw new Error(
      "ERC4626 Silo route is incompatible with its descriptor",
    );
  }
}

export function erc4626SiloRedeemSimulation(input: {
  readonly id: string;
  readonly vault: string;
  readonly payoutToken: string;
  readonly actor: string;
  readonly callerRef: CallerRef;
  readonly amountIn: bigint;
}): AdapterRequest {
  const actor = canonicalAddress(input.actor);
  return Object.freeze({
    id: input.id,
    kind: "effect-delta-simulation" as const,
    call: Object.freeze({
      caller: input.callerRef,
      to: canonicalAddress(input.vault),
      data: ERC4626_SILO_INTERFACE.encodeFunctionData("redeem", [
        input.payoutToken,
        input.amountIn,
        actor,
        actor,
      ]),
    }),
    overrideIntent: Object.freeze({
      caller: input.callerRef,
      tokenBalances: Object.freeze([Object.freeze({
        token: canonicalAddress(input.vault),
        amount: input.amountIn,
      })]),
    }),
    observe: Object.freeze([
      "return-data" as const,
      "token-delta" as const,
      "total-supply-delta" as const,
      "logs" as const,
    ]),
  });
}

export function validateErc4626SiloRedeemEffects(input: {
  readonly result: Extract<AdapterRequestResult, { readonly ok: true }>;
  readonly vault: string;
  readonly payoutToken: string;
  readonly actor: string;
  readonly amountIn: bigint;
}): bigint {
  if (input.result.completion !== "returned") {
    throw new Error("ERC4626 Silo redeem simulation did not return");
  }
  const amountOut = BigInt(
    ERC4626_SILO_INTERFACE.decodeFunctionResult(
      "redeem",
      input.result.data,
    )[0],
  );
  const tokenSpent = (input.result.effects?.tokenDeltas ?? []).some((item) =>
    sameAddress(item.token, input.vault) &&
    sameAddress(item.account, input.actor) &&
    item.delta === -input.amountIn
  );
  const supplyBurned = (input.result.effects?.totalSupplyDeltas ?? []).some(
    (item) => sameAddress(item.token, input.vault) &&
      item.delta === -input.amountIn,
  );
  const payoutReceived = (input.result.effects?.tokenDeltas ?? []).some((item) =>
    sameAddress(item.token, input.payoutToken) &&
    sameAddress(item.account, input.actor) &&
    item.delta === amountOut
  );
  if (amountOut <= 0n || !tokenSpent || !supplyBurned || !payoutReceived) {
    throw new Error("ERC4626 Silo redeem effect invariants failed");
  }
  return amountOut;
}
