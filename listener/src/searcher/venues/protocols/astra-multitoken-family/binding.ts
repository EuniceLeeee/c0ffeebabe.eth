import { routeKey } from "../../adapter-family-identifiers.js";
import { hashCanonical } from "../../canonical-value.js";
import { lowerAddress, sameAddress } from "./codec.js";
import type {
  AstraMultiTokenDescriptor,
  AstraMultiTokenRoute,
} from "./types.js";

export function astraStaticBindingProjection(
  descriptor: AstraMultiTokenDescriptor,
) {
  return {
    target: descriptor.target,
    registryBinding: {
      registryContract: descriptor.registryBinding.registryContract,
      tokens: descriptor.registryBinding.tokens,
      tokenWeights: descriptor.registryBinding.tokenWeights.map((binding) => ({
        token: binding.token,
        weight: binding.weight,
        codeHash: binding.codeHash,
      })),
    },
    behaviorBinding: {
      interfaceMode: descriptor.behaviorBinding.interfaceMode,
      changesEnabled: descriptor.behaviorBinding.changesEnabled,
      totalPercents: descriptor.behaviorBinding.totalPercents,
      changeFee: descriptor.behaviorBinding.changeFee,
      inLendingMode: descriptor.behaviorBinding.inLendingMode,
      activeProof: descriptor.behaviorBinding.activeProof,
    },
  };
}

export function astraBindingFingerprint(
  descriptor: AstraMultiTokenDescriptor,
): string {
  return hashCanonical(astraStaticBindingProjection(descriptor));
}

export function assertAstraRouteBinding(
  descriptor: AstraMultiTokenDescriptor,
  route: AstraMultiTokenRoute,
): void {
  const expectedPairIndex = pairIndex(
    descriptor.registryBinding.tokens,
    route.tokenIn,
    route.tokenOut,
  );
  const expectedRouteKey = routeKey([
    descriptor.familyId,
    lowerAddress(descriptor.target),
    lowerAddress(route.tokenIn),
    lowerAddress(route.tokenOut),
  ].join("\u001f"));
  if (
    route.familyId !== descriptor.familyId ||
    route.lineageId !== descriptor.lineageId ||
    route.instanceKey !== descriptor.instanceKey ||
    !sameAddress(route.target, descriptor.target) ||
    route.routeKey !== expectedRouteKey ||
    route.pairIndex !== expectedPairIndex ||
    route.taxonomy.slotKind !== "protocol" ||
    route.taxonomy.protocolAction !== "convert" ||
    route.bindingRef.bindingKey !== lowerAddress(descriptor.target) ||
    route.bindingRef.fingerprint !== astraBindingFingerprint(descriptor)
  ) {
    throw new Error("astra-multitoken route is not registry-bound");
  }
}

function pairIndex(
  tokens: readonly string[],
  tokenIn: string,
  tokenOut: string,
): number {
  let index = 0;
  for (const candidateIn of tokens) {
    for (const candidateOut of tokens) {
      if (sameAddress(candidateIn, candidateOut)) continue;
      if (
        sameAddress(candidateIn, tokenIn) &&
        sameAddress(candidateOut, tokenOut)
      ) {
        return index;
      }
      index++;
    }
  }
  return -1;
}
