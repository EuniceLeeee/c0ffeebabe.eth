import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";

export const FAMILY = familyId("protocol:mellow-queue");
export const LINEAGE = lineageId("mellow-queue:v1");

export const manifest = {
  familyId: FAMILY,
  domain: "protocol",
  ownedActionAdapterIds: ["mellow-deposit", "mellow-redeem"],
  requiredInfraActionAdapterIds: ["erc20-approve"],
  allowedTaxonomy: [
    { slotKind: "protocol", protocolAction: "wrap" },
    { slotKind: "protocol", protocolAction: "redeem" },
  ],
  supportedLineages: [LINEAGE],
  poolAdapterIds: ["mellow-queue"],
  edgeAdapterIds: ["mellow-deposit", "mellow-redeem"],
  requiresProtocolEdgesFlag: true,
} satisfies FamilyManifest<"protocol">;
