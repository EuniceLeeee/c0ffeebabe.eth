import { hashCanonical } from "../../canonical-value.js";
import {
  assertRouteBound,
  lowerAddress,
  sameAddress,
} from "../standard-family/common.js";
import type { RocksolidDescriptor, RocksolidRoute } from "./types.js";

export function rocksolidStaticBindingProjection(
  descriptor: RocksolidDescriptor,
) {
  return {
    target: lowerAddress(descriptor.target),
    asset: lowerAddress(descriptor.asset),
    receipt: lowerAddress(descriptor.receipt),
    execution: "syncDeposit(assets,receiver,zero-referral)",
  };
}

export function assertRocksolidInvocation(
  descriptor: RocksolidDescriptor,
  route: RocksolidRoute,
): void {
  assertRouteBound({
    descriptorInstanceKey: descriptor.instanceKey,
    descriptorTarget: descriptor.target,
    route,
    bindingFingerprint: hashCanonical(
      rocksolidStaticBindingProjection(descriptor),
    ),
  });
  if (
    route.direction !== "sync-deposit" ||
    route.adapterId !== "rocksolid-sync-deposit" ||
    !sameAddress(route.tokenIn, descriptor.asset) ||
    !sameAddress(route.tokenOut, descriptor.receipt)
  ) {
    throw new Error(
      "RockSolid route is incompatible with its receipt descriptor",
    );
  }
}
