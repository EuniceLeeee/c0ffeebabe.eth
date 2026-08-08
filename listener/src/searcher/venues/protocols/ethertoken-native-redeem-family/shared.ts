import { ethers } from "ethers";
import { ADDR } from "../../../../shared/constants/addresses.js";
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
  EtherTokenNativeRedeemDescriptor,
  EtherTokenNativeRedeemRoute,
} from "./types.js";

export const ETHERTOKEN_NATIVE_INTERFACE = new ethers.Interface([
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function withdraw(uint256 amount)",
]);
export const ETHERTOKEN_NATIVE_PROBE_ACTOR = ethers.getAddress(
  `0x${"00".repeat(18)}e7e2`,
);
export const ETHERTOKEN_NATIVE_PROBE_ACTOR_EVIDENCE_ID =
  "ethertoken-native-probe-actor";

export function etherTokenNativeStaticProjection(
  descriptor: EtherTokenNativeRedeemDescriptor,
) {
  return {
    token: lowerAddress(descriptor.token),
    nativeAnchor: lowerAddress(descriptor.nativeAnchor),
    selector: ETHERTOKEN_NATIVE_INTERFACE.getFunction("withdraw")!
      .selector.toLowerCase(),
    payoutSemantics: "exact-burn-equal-native-out-v1",
  };
}

export function assertEtherTokenNativeInvocation(
  descriptor: EtherTokenNativeRedeemDescriptor,
  route: EtherTokenNativeRedeemRoute,
): void {
  assertRouteBound({
    descriptorInstanceKey: descriptor.instanceKey,
    descriptorTarget: descriptor.token,
    route,
    bindingFingerprint: hashCanonical(
      etherTokenNativeStaticProjection(descriptor),
    ),
  });
  if (
    route.direction !== "withdraw-to-native" ||
    route.adapterId !== "ethertoken-native-redeem" ||
    !sameAddress(route.tokenIn, descriptor.token) ||
    !sameAddress(route.tokenOut, descriptor.nativeAnchor) ||
    sameAddress(descriptor.token, ADDR.WETH)
  ) {
    throw new Error(
      "EtherToken native route is incompatible with its descriptor",
    );
  }
}

export function etherTokenWithdrawalSimulation(input: {
  readonly id: string;
  readonly token: string;
  readonly actor: string;
  readonly callerRef: CallerRef;
  readonly amountIn: bigint;
}): AdapterRequest {
  const token = canonicalAddress(input.token);
  const actor = canonicalAddress(input.actor);
  return Object.freeze({
    id: input.id,
    kind: "effect-delta-simulation" as const,
    call: Object.freeze({
      caller: input.callerRef,
      to: token,
      data: ETHERTOKEN_NATIVE_INTERFACE.encodeFunctionData(
        "withdraw",
        [input.amountIn],
      ),
    }),
    overrideIntent: Object.freeze({
      caller: input.callerRef,
      tokenBalances: Object.freeze([Object.freeze({
        token,
        amount: input.amountIn,
      })]),
    }),
    observe: Object.freeze([
      "return-data" as const,
      "token-delta" as const,
      "native-delta" as const,
      "total-supply-delta" as const,
      "logs" as const,
    ]),
  });
}

export function validateEtherTokenWithdrawal(input: {
  readonly result: Extract<AdapterRequestResult, { readonly ok: true }>;
  readonly token: string;
  readonly actor: string;
  readonly amountIn: bigint;
}): bigint {
  if (input.result.completion !== "returned") {
    throw new Error("EtherToken withdrawal simulation did not return");
  }
  ETHERTOKEN_NATIVE_INTERFACE.decodeFunctionResult(
    "withdraw",
    input.result.data,
  );
  const tokenSpent = (input.result.effects?.tokenDeltas ?? []).some((delta) =>
    sameAddress(delta.token, input.token) &&
    sameAddress(delta.account, input.actor) &&
    delta.delta === -input.amountIn
  );
  const supplyBurned = (input.result.effects?.totalSupplyDeltas ?? []).some(
    (delta) => sameAddress(delta.token, input.token) &&
      delta.delta === -input.amountIn,
  );
  const nativeOut = (input.result.effects?.nativeDeltas ?? [])
    .filter((delta) => sameAddress(delta.account, input.actor) && delta.delta > 0n)
    .reduce((total, delta) => total + delta.delta, 0n);
  if (!tokenSpent || !supplyBurned || nativeOut !== input.amountIn) {
    throw new Error("EtherToken native exact effect invariants failed");
  }
  return nativeOut;
}
