import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";

export const WSTETH_FAMILY_ID = familyId("protocol:wsteth");
export const WSTETH_LINEAGE_ID = lineageId(
  "wsteth:steth-active-binding",
);

export const wstethFamilyManifest = {
  familyId: WSTETH_FAMILY_ID,
  domain: "protocol",
  ownedActionAdapterIds: ["wsteth-wrap", "wsteth-unwrap"],
  requiredInfraActionAdapterIds: ["erc20-approve"],
  allowedTaxonomy: [
    { slotKind: "protocol", protocolAction: "wrap" },
    { slotKind: "protocol", protocolAction: "unwrap" },
  ],
  supportedLineages: [WSTETH_LINEAGE_ID],
  poolAdapterIds: ["wsteth"],
  edgeAdapterIds: ["wsteth-wrap", "wsteth-unwrap"],
  requiresProtocolEdgesFlag: true,
} satisfies FamilyManifest<"protocol">;
