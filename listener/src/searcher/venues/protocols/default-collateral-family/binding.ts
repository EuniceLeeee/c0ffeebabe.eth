import { hashCanonical } from "../../canonical-value.js";
import {
  assertRouteBound,
  lowerAddress,
  sameAddress,
} from "../standard-family/common.js";
import { DEFAULT_COLLATERAL_FEE_BPS } from "./codec.js";
import {
  DEFAULT_COLLATERAL_ACTION_ID,
  DEFAULT_COLLATERAL_FAMILY_ID,
  DEFAULT_COLLATERAL_LINEAGE_ID,
} from "./manifest.js";
import type {
  DefaultCollateralDescriptor,
  DefaultCollateralRoute,
} from "./types.js";

export function defaultCollateralStaticBindingProjection(
  descriptor: DefaultCollateralDescriptor,
) {
  return {
    vault: lowerAddress(descriptor.vault),
    share: lowerAddress(descriptor.share),
    asset: lowerAddress(descriptor.asset),
    implementation: lowerAddress(descriptor.implementation),
    shareCodeHash: descriptor.shareCodeHash.toLowerCase(),
    implementationCodeHash: descriptor.implementationCodeHash.toLowerCase(),
    assetCodeHash: descriptor.assetCodeHash.toLowerCase(),
    decimals: descriptor.decimals,
    rateModel: "default-collateral-one-to-one-v1",
    feeBps: DEFAULT_COLLATERAL_FEE_BPS,
  };
}

export function assertDefaultCollateralInvocation(
  descriptor: DefaultCollateralDescriptor,
  route: DefaultCollateralRoute,
): void {
  if (
    descriptor.familyId !== DEFAULT_COLLATERAL_FAMILY_ID ||
    descriptor.lineageId !== DEFAULT_COLLATERAL_LINEAGE_ID ||
    route.familyId !== DEFAULT_COLLATERAL_FAMILY_ID ||
    route.lineageId !== DEFAULT_COLLATERAL_LINEAGE_ID
  ) {
    throw new Error("default-collateral route Family mismatch");
  }
  if (route.adapterId !== DEFAULT_COLLATERAL_ACTION_ID) {
    throw new Error("default-collateral route adapter mismatch");
  }
  if (
    route.taxonomy.slotKind !== "protocol" ||
    route.taxonomy.protocolAction !== "convert"
  ) {
    throw new Error("default-collateral route taxonomy mismatch");
  }
  if (
    !sameAddress(descriptor.share, descriptor.vault) ||
    sameAddress(descriptor.share, descriptor.asset) ||
    sameAddress(descriptor.vault, descriptor.asset)
  ) {
    throw new Error("default-collateral vault/share/asset alias");
  }
  if (
    !sameAddress(route.tokenIn, descriptor.share) ||
    !sameAddress(route.tokenOut, descriptor.asset)
  ) {
    throw new Error("default-collateral route direction was not behavior-proven");
  }
  assertRouteBound({
    descriptorInstanceKey: descriptor.instanceKey,
    descriptorTarget: descriptor.vault,
    route,
    bindingFingerprint: hashCanonical(
      defaultCollateralStaticBindingProjection(descriptor),
    ),
  });
}
