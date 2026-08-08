import { hashCanonical } from "../../canonical-value.js";
import {
  assertRouteBound,
  lowerAddress,
  sameAddress,
} from "../standard-family/common.js";
import type { EigenpieDescriptor, EigenpieRoute } from "./types.js";

export function eigenpieStaticBindingProjection(
  descriptor: EigenpieDescriptor,
) {
  return {
    target: lowerAddress(descriptor.target),
    asset: lowerAddress(descriptor.asset),
    receipt: lowerAddress(descriptor.receipt),
    execution: "depositAsset(asset,amount,minOut,zero-referral)",
  };
}

export function assertEigenpieInvocation(
  descriptor: EigenpieDescriptor,
  route: EigenpieRoute,
): void {
  assertRouteBound({
    descriptorInstanceKey: descriptor.instanceKey,
    descriptorTarget: descriptor.target,
    route,
    bindingFingerprint: hashCanonical(
      eigenpieStaticBindingProjection(descriptor),
    ),
  });
  if (
    route.direction !== "deposit-asset" ||
    route.adapterId !== "eigenpie-deposit-asset" ||
    !sameAddress(route.tokenIn, descriptor.asset) ||
    !sameAddress(route.tokenOut, descriptor.receipt)
  ) {
    throw new Error("Eigenpie route is incompatible with its pair descriptor");
  }
}
