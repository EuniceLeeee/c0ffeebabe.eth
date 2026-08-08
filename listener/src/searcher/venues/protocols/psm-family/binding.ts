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
    feeSemantics: "lite-psm-tin-tout-wad-v1",
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
    route.direction !== "sell-gem" ||
    route.adapterId !== "psm" ||
    !sameAddress(route.tokenIn, descriptor.gem) ||
    !sameAddress(route.tokenOut, descriptor.dai)
  ) {
    throw new Error("PSM route is not the verified sellGem direction");
  }
}
