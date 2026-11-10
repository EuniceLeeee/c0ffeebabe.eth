import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";

export const OLYMPUS_FAMILY_ID = familyId("protocol:olympus");
export const OLYMPUS_LINEAGE_ID = lineageId("olympus:staking-v3-gohm-unstake");
export const OLYMPUS_ACTION_ID = "olympus-unstake";

export const olympusFamilyManifest = {
  familyId: OLYMPUS_FAMILY_ID,
  domain: "protocol",
  ownedActionAdapterIds: [OLYMPUS_ACTION_ID],
  // gOHM is burned from msg.sender by the staking contract; no ERC20
  // allowance is created or consumed by unstake.
  requiredInfraActionAdapterIds: [],
  allowedTaxonomy: [{ slotKind: "protocol", protocolAction: "convert" }],
  supportedLineages: [OLYMPUS_LINEAGE_ID],
  poolAdapterIds: ["olympus"],
  edgeAdapterIds: [OLYMPUS_ACTION_ID],
  requiresProtocolEdgesFlag: true,
} satisfies FamilyManifest<"protocol">;
