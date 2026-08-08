import { hashCanonical } from "../../canonical-value.js";
import {
  assertRouteBound,
  lowerAddress,
  sameAddress,
} from "../standard-family/common.js";
import type { Erc4626Descriptor, Erc4626Route } from "./types.js";

export function erc4626StaticProjection(descriptor: Erc4626Descriptor) {
  return {
    vault: lowerAddress(descriptor.vault),
    asset: lowerAddress(descriptor.asset),
    share: lowerAddress(descriptor.share),
    verifiedDirections: descriptor.verifiedDirections,
    standardPayout: "asset()",
  };
}

export function assertErc4626Invocation(
  descriptor: Erc4626Descriptor,
  route: Erc4626Route,
): void {
  assertRouteBound({
    descriptorInstanceKey: descriptor.instanceKey,
    descriptorTarget: descriptor.vault,
    route,
    bindingFingerprint: hashCanonical(erc4626StaticProjection(descriptor)),
  });
  const expected = route.direction === "deposit"
    ? [
        descriptor.asset,
        descriptor.share,
        "erc4626-deposit",
        descriptor.verifiedDirections.deposit,
      ] as const
    : [
        descriptor.share,
        descriptor.asset,
        "erc4626-redeem",
        descriptor.verifiedDirections.redeem,
      ] as const;
  if (
    !expected[3] ||
    !sameAddress(route.tokenIn, expected[0]) ||
    !sameAddress(route.tokenOut, expected[1]) ||
    route.adapterId !== expected[2]
  ) {
    throw new Error("ERC4626 route direction was not behavior-proven");
  }
}
