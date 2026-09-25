import { hashCanonical } from "../../canonical-value.js";
import { assertRouteBound, sameAddress } from "../standard-family/common.js";
import { FAMILY, LINEAGE, XWIN_LINEAGE } from "./manifest.js";
import type { ConversionDescriptor, ConversionRoute } from "./types.js";
export function staticProjection(d: ConversionDescriptor) {
  return { variant: d.variant, target: d.target.toLowerCase(), asset: d.asset.toLowerCase(), codeHash: d.codeHash,
    ...(d.variant === "btb-bear-v1" ? { assetCodeHash: d.assetCodeHash } : { proxyAdmin: d.proxyAdmin.toLowerCase() }) };
}
export function assertInvocation(d: ConversionDescriptor, r: ConversionRoute): void {
  assertRouteBound({ descriptorInstanceKey: d.instanceKey, descriptorTarget: d.target, route: r, bindingFingerprint: hashCanonical(staticProjection(d)) });
  const lineage = d.variant === "btb-bear-v1" ? LINEAGE : d.variant === "xwin-allocations-v1" ? XWIN_LINEAGE : null;
  if (lineage === null || d.familyId !== FAMILY || d.lineageId !== lineage ||
      r.familyId !== FAMILY || r.lineageId !== lineage || !["mint", "redeem"].includes(r.direction) ||
      r.adapterId !== `token-conversion-${r.direction}` || r.taxonomy.slotKind !== "protocol" || r.taxonomy.protocolAction !== (r.direction === "mint" ? "wrap" : "redeem") ||
      !sameAddress(r.tokenIn, r.direction === "mint" ? d.asset : d.target) ||
      !sameAddress(r.tokenOut, r.direction === "mint" ? d.target : d.asset)) throw new Error("conversion route binding mismatch");
}
