import { hashCanonical } from "../../canonical-value.js";
import {
  assertRouteBound,
  lowerAddress,
  sameAddress,
} from "../standard-family/common.js";
import type { OlympusDescriptor, OlympusRoute } from "./types.js";

export function olympusStaticBindingProjection(descriptor: OlympusDescriptor) {
  return {
    staking: lowerAddress(descriptor.staking),
    gOHM: lowerAddress(descriptor.gOHM),
    OHM: lowerAddress(descriptor.OHM),
    gOhmDecimals: descriptor.gOhmDecimals,
    ohmDecimals: descriptor.ohmDecimals,
    quoteSemantics: "floor(gohm*index/1e18)-v1",
  };
}

export function assertOlympusInvocation(
  descriptor: OlympusDescriptor,
  route: OlympusRoute,
): void {
  assertRouteBound({
    descriptorInstanceKey: descriptor.instanceKey,
    descriptorTarget: descriptor.staking,
    route,
    bindingFingerprint: hashCanonical(
      olympusStaticBindingProjection(descriptor),
    ),
  });
  if (
    route.direction !== "unstake" ||
    route.adapterId !== "olympus-unstake" ||
    !sameAddress(route.tokenIn, descriptor.gOHM) ||
    !sameAddress(route.tokenOut, descriptor.OHM)
  ) {
    throw new Error("Olympus route is incompatible with its staking descriptor");
  }
}
