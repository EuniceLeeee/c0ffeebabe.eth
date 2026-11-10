import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";

export const FAMILY = familyId("protocol:ondo-usdy-instant-redeem");
export const LINEAGE = lineageId("ondo-usdy-instant-redeem:v1");
export const ACTION = "ondo-usdy-redeem";

export const manifest = {
  familyId: FAMILY,
  domain: "protocol",
  ownedActionAdapterIds: [ACTION],
  requiredInfraActionAdapterIds: ["erc20-approve"],
  allowedTaxonomy: [{ slotKind: "protocol", protocolAction: "redeem" }],
  supportedLineages: [LINEAGE],
  poolAdapterIds: [ACTION],
  edgeAdapterIds: [ACTION],
  requiresProtocolEdgesFlag: true,
} satisfies FamilyManifest<"protocol">;
