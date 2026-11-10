import { hashCanonical } from "../../canonical-value.js";
import {
  assertRouteBound,
  lowerAddress,
  sameAddress,
} from "../standard-family/common.js";
import type { OriginOusdDescriptor, OriginOusdRoute } from "./types.js";

export function originOusdStaticBindingProjection(
  descriptor: OriginOusdDescriptor,
) {
  return {
    target: lowerAddress(descriptor.target),
    asset: lowerAddress(descriptor.asset),
    token: lowerAddress(descriptor.token),
    decimalScale: descriptor.decimalScale,
    proxyCodeHash: descriptor.proxyCodeHash.toLowerCase(),
    implementationCodeHash: descriptor.implementationCodeHash.toLowerCase(),
    tokenCodeHash: descriptor.tokenCodeHash.toLowerCase(),
    mintSemantics: "origin-ousd-vault-mint-1to1-no-fee-v1",
  };
}

export function assertOriginOusdInvocation(
  descriptor: OriginOusdDescriptor,
  route: OriginOusdRoute,
): void {
  assertRouteBound({
    descriptorInstanceKey: descriptor.instanceKey,
    descriptorTarget: descriptor.target,
    route,
    bindingFingerprint: hashCanonical(
      originOusdStaticBindingProjection(descriptor),
    ),
  });
  if (
    route.direction !== "mint-usdc-to-ousd" ||
    route.adapterId !== "origin-ousd-mint" ||
    !sameAddress(route.tokenIn, descriptor.asset) ||
    !sameAddress(route.tokenOut, descriptor.token) ||
    descriptor.decimalScale <= 0n
  ) {
    throw new Error("Origin OUSD route is incompatible with its mint descriptor");
  }
}
