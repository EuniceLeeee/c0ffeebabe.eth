import { hashCanonical } from "../../canonical-value.js";
import {
  assertRouteBound,
  lowerAddress,
  sameAddress,
} from "../standard-family/common.js";
import type { PsmDescriptor, PsmRoute } from "./types.js";

export function psmStaticBindingProjection(descriptor: PsmDescriptor) {
  return {
    target: lowerAddress(descriptor.target),
    gem: lowerAddress(descriptor.gem),
    dai: lowerAddress(descriptor.dai),
    decimalScale: descriptor.decimalScale,
    feeSemantics: "lite-psm-bidirectional-integer-fee-v2",
  };
}

export function assertPsmInvocation(
  descriptor: PsmDescriptor,
  route: PsmRoute,
): void {
  assertRouteBound({
    descriptorInstanceKey: descriptor.instanceKey,
    descriptorTarget: descriptor.target,
    route,
    bindingFingerprint: hashCanonical(psmStaticBindingProjection(descriptor)),
  });
  if (
    (route.direction !== "sell-gem" && route.direction !== "buy-gem") ||
    route.adapterId !== "psm" ||
    !sameAddress(route.tokenIn, route.direction === "sell-gem" ? descriptor.gem : descriptor.dai) ||
    !sameAddress(route.tokenOut, route.direction === "sell-gem" ? descriptor.dai : descriptor.gem)
  ) {
    throw new Error("PSM route is not a verified direction");
  }
}
