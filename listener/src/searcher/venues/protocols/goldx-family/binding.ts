import { hashCanonical } from "../../canonical-value.js";
import {
  assertRouteBound,
  lowerAddress,
  sameAddress,
} from "../standard-family/common.js";
import type { GoldxDescriptor, GoldxRoute } from "./types.js";

export function goldxStaticBindingProjection(descriptor: GoldxDescriptor) {
  return {
    target: lowerAddress(descriptor.target),
    collateral: lowerAddress(descriptor.collateral),
    receipt: lowerAddress(descriptor.receipt),
    quoteSemantics: "floor(amount*unit/1e18)",
  };
}

export function assertGoldxInvocation(
  descriptor: GoldxDescriptor,
  route: GoldxRoute,
): void {
  assertRouteBound({
    descriptorInstanceKey: descriptor.instanceKey,
    descriptorTarget: descriptor.target,
    route,
    bindingFingerprint: hashCanonical(
      goldxStaticBindingProjection(descriptor),
    ),
  });
  if (
    route.direction !== "mint" ||
    route.adapterId !== "goldx-mint" ||
    !sameAddress(route.tokenIn, descriptor.collateral) ||
    !sameAddress(route.tokenOut, descriptor.receipt)
  ) {
    throw new Error("GOLDx route is incompatible with its mint descriptor");
  }
}
