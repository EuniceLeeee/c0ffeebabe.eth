import { hashCanonical } from "../../canonical-value.js";
import {
  assertRouteBound,
  lowerAddress,
  sameAddress,
} from "../standard-family/common.js";
import { METAFACTORY_FAMILY_ID, METAFACTORY_LINEAGE_ID } from "./manifest.js";
import type {
  MetafactoryDescriptor,
  MetafactoryRoute,
} from "./types.js";

/**
 * Static (state-independent) protocol identity of one composter instance:
 * the verified runtime code hash, the ROBOT token it burns, the dead address
 * it transfers to and the canonical native anchor. The pro-rata rate is block
 * state and is deliberately NOT part of this projection.
 */
export function metafactoryStaticProjection(descriptor: MetafactoryDescriptor) {
  return {
    target: lowerAddress(descriptor.target),
    tokenIn: lowerAddress(descriptor.tokenIn),
    nativeAnchor: lowerAddress(descriptor.nativeAnchor),
    deadAddress: lowerAddress(descriptor.deadAddress),
    codeHash: descriptor.codeHash.toLowerCase(),
    payoutSemantics: "compost-pro-rata-native-eth-to-caller-v1",
  };
}

export function assertMetafactoryInvocation(
  descriptor: MetafactoryDescriptor,
  route: MetafactoryRoute,
): void {
  assertRouteBound({
    descriptorInstanceKey: descriptor.instanceKey,
    descriptorTarget: descriptor.target,
    route,
    bindingFingerprint: hashCanonical(metafactoryStaticProjection(descriptor)),
  });
  if (
    descriptor.familyId !== METAFACTORY_FAMILY_ID ||
    descriptor.lineageId !== METAFACTORY_LINEAGE_ID ||
    route.familyId !== METAFACTORY_FAMILY_ID ||
    route.lineageId !== METAFACTORY_LINEAGE_ID ||
    route.direction !== "compost-redeem" ||
    route.adapterId !== "metafactory-compost-redeem" ||
    route.taxonomy.slotKind !== "protocol" ||
    route.taxonomy.protocolAction !== "convert" ||
    !sameAddress(route.tokenIn, descriptor.tokenIn) ||
    !sameAddress(route.tokenOut, descriptor.nativeAnchor) ||
    sameAddress(descriptor.tokenIn, descriptor.nativeAnchor) ||
    sameAddress(descriptor.tokenIn, descriptor.target)
  ) {
    throw new Error("metafactory route is not a verified compost redemption");
  }
  const assets = route.executionAssets;
  if (
    assets === undefined ||
    assets.input !== "erc20" ||
    assets.output !== "native"
  ) {
    throw new Error("metafactory route must declare an ERC20 -> native settlement");
  }
}
