import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";

/**
 * Compound V2 cToken share redemption. This family owns exactly one routed
 * action: redeem cToken shares for the market's underlying asset.
 *
 * `redeemUnderlying(uint256)` is deliberately NOT routed: its single argument
 * is an UNDERLYING OUTPUT amount, so it cannot consume the previous hop's
 * actually-received cToken amount inside the transaction. Admitting it as a
 * route would either require an off-chain output prediction or silently
 * mis-scale the amount — both forbidden. It stays covered by family-local
 * negative tests instead.
 */
export const CTOKEN_FAMILY_ID = familyId("protocol:compound-ctoken");
export const CTOKEN_LINEAGE_ID = lineageId(
  "compound-v2:comptroller-registered-ctoken",
);
export const CTOKEN_REDEEM_ACTION = "compound-ctoken-redeem";

export const compoundCTokenManifest: FamilyManifest<"protocol"> = Object.freeze({
  familyId: CTOKEN_FAMILY_ID,
  domain: "protocol",
  ownedActionAdapterIds: Object.freeze([CTOKEN_REDEEM_ACTION]),
  requiredInfraActionAdapterIds: Object.freeze(["erc20-approve"]),
  allowedTaxonomy: Object.freeze([
    Object.freeze({
      slotKind: "protocol" as const,
      protocolAction: "redeem" as const,
    }),
  ]),
  supportedLineages: Object.freeze([CTOKEN_LINEAGE_ID]),
  poolAdapterIds: Object.freeze(["compound-ctoken"]),
  edgeAdapterIds: Object.freeze([CTOKEN_REDEEM_ACTION]),
  requiresProtocolEdgesFlag: true,
});
