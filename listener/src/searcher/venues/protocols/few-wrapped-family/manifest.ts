import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";
export const FAMILY = familyId("protocol:few-wrapped");
export const LINEAGE = lineageId("few:factory-backed-wrap-v1");
export const manifest = {
  familyId: FAMILY, domain: "protocol", supportedLineages: [LINEAGE],
  ownedActionAdapterIds: ["few-wrap", "few-unwrap"], requiredInfraActionAdapterIds: ["erc20-approve"],
  poolAdapterIds: ["few-wrapped"], edgeAdapterIds: ["few-wrap", "few-unwrap"], requiresProtocolEdgesFlag: true,
  allowedTaxonomy: [{ slotKind: "protocol", protocolAction: "wrap" }, { slotKind: "protocol", protocolAction: "unwrap" }],
} satisfies FamilyManifest<"protocol">;
