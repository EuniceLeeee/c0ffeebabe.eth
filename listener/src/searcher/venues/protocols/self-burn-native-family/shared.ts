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
  SelfBurnNativeDescriptor,
  SelfBurnNativeRoute,
} from "./types.js";

export const SELF_BURN_NATIVE_TOKEN_INTERFACE = new ethers.Interface([
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function transfer(address to,uint256 amount) returns (bool)",
]);
export const SELF_BURN_NATIVE_PROBE_ACTOR = ethers.getAddress(
  `0x${"00".repeat(18)}b07a`,
);
export const SELF_BURN_NATIVE_PRICING_ACTOR = ethers.getAddress(
  `0x${"00".repeat(18)}b10c`,
);
export const SELF_BURN_NATIVE_PROBE_ACTOR_EVIDENCE_ID =
  "self-burn-native-probe-actor";
export const SELF_BURN_NATIVE_PRICING_ACTOR_EVIDENCE_ID =
  "self-burn-native-pricing-actor";

export function selfBurnNativeStaticProjection(
  descriptor: SelfBurnNativeDescriptor,
) {
  return {
    token: lowerAddress(descriptor.token),
    nativeAnchor: lowerAddress(descriptor.nativeAnchor),
    call: "transfer-self",
    selector: SELF_BURN_NATIVE_TOKEN_INTERFACE.getFunction("transfer")!
      .selector.toLowerCase(),
    payoutSemantics: "exact-burn-variable-native-out-v1",
  };
}

export function assertSelfBurnNativeInvocation(
  descriptor: SelfBurnNativeDescriptor,
  route: SelfBurnNativeRoute,
): void {
  assertRouteBound({
    descriptorInstanceKey: descriptor.instanceKey,
    descriptorTarget: descriptor.token,
    route,
    bindingFingerprint: hashCanonical(
      selfBurnNativeStaticProjection(descriptor),
    ),
  });
  if (
    route.direction !== "self-burn-to-native" ||
    route.adapterId !== "self-burn-native-redeem" ||
    !sameAddress(route.tokenIn, descriptor.token) ||
    !sameAddress(route.tokenOut, descriptor.nativeAnchor)
  ) {
    throw new Error(
      "self-burn native route is incompatible with its descriptor",
    );
  }
}

export function selfBurnNativeProbeAmounts(one: bigint): readonly bigint[] {
  return Object.freeze([...new Set([
    one >= 100n ? one / 100n : 1n,
    one >= 10n ? one / 10n : 1n,
    one,
    one >= 1_000n ? one / 1_000n : 1n,
  ])].filter((amount) => amount > 0n));
}

export function selfBurnNativeSimulation(input: {
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
      data: SELF_BURN_NATIVE_TOKEN_INTERFACE.encodeFunctionData(
        "transfer",
        [token, input.amountIn],
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

export function validateSelfBurnNativeEffects(input: {
  readonly result: Extract<AdapterRequestResult, { readonly ok: true }>;
  readonly token: string;
  readonly actor: string;
  readonly amountIn: bigint;
}): bigint {
  if (input.result.completion !== "returned") {
    throw new Error("self-burn native simulation did not return");
  }
  const returned = SELF_BURN_NATIVE_TOKEN_INTERFACE.decodeFunctionResult(
    "transfer",
    input.result.data,
  );
  if (!Boolean(returned[0])) {
    throw new Error("self-burn transfer returned false");
  }
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
  if (!tokenSpent || !supplyBurned || nativeOut <= 0n) {
    throw new Error("self-burn native effect invariants failed");
  }
  return nativeOut;
}
