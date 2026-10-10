import { hashCanonical } from "../../canonical-value.js";
import {
  assertRouteBound,
  lowerAddress,
  sameAddress,
} from "../standard-family/common.js";
import type { Erc4626Descriptor, Erc4626Route } from "./types.js";
import { infinifiProjection, INFINIFI_GATEWAY } from "./infinifi.js";
import { CUSTODIAN_LINEAGE_ID, ERC4626_LINEAGE_ID, INFINIFI_LINEAGE_ID } from "./manifest.js";

export function erc4626StaticProjection(descriptor: Erc4626Descriptor) {
  return {
    ...(descriptor.infinifi === undefined ? {} : { infinifi: infinifiProjection(descriptor.infinifi) }),
    ...(descriptor.custodian === undefined ? {} : { custodian: { ...descriptor.custodian, proofSource: { ...descriptor.custodian.proofSource } } }),
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
  if (descriptor.infinifi !== undefined) {
    const b = descriptor.infinifi;
    if (descriptor.custodian !== undefined || descriptor.lineageId !== INFINIFI_LINEAGE_ID || route.lineageId !== INFINIFI_LINEAGE_ID ||
        !sameAddress(b.gateway, INFINIFI_GATEWAY) || !sameAddress(b.vault, descriptor.vault) ||
        !sameAddress(b.vault, descriptor.share) || !sameAddress(b.asset, descriptor.asset) || sameAddress(b.vault, b.asset))
      throw new Error("InfiniFi route binding mismatch");
  } else if (descriptor.custodian !== undefined) {
    const binding = descriptor.custodian;
    if (descriptor.lineageId !== CUSTODIAN_LINEAGE_ID || route.lineageId !== CUSTODIAN_LINEAGE_ID ||
        !sameAddress(binding.share, descriptor.share) || !sameAddress(binding.asset, descriptor.asset) ||
        sameAddress(descriptor.share, descriptor.vault) || sameAddress(descriptor.asset, descriptor.vault) ||
        sameAddress(descriptor.share, descriptor.asset)) throw new Error("Custodian conversion binding mismatch");
  } else if (descriptor.lineageId !== ERC4626_LINEAGE_ID || !sameAddress(descriptor.share, descriptor.vault)) {
    throw new Error("ERC4626 standard share binding mismatch");
  }
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
