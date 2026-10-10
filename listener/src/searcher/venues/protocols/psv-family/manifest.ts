import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";
export const FAMILY = familyId("protocol:psv");
export const LINEAGE = lineageId("psv:uups-exact-input-v1");
export const ACTION = "psv";
export const manifest = { familyId: FAMILY, domain: "protocol", ownedActionAdapterIds: [ACTION], requiredInfraActionAdapterIds: [],
  allowedTaxonomy: [{ slotKind: "protocol", protocolAction: "convert" }], supportedLineages: [LINEAGE],
  poolAdapterIds: [ACTION], edgeAdapterIds: [ACTION], requiresProtocolEdgesFlag: false,
} satisfies FamilyManifest<"protocol">;
