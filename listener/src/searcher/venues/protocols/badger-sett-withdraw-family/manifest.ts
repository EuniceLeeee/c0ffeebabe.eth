import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";
export const FAMILY = familyId("protocol:badger-sett-withdraw");
export const LINEAGE = lineageId("badger-sett:thevault-1.5-vlaura-1.2-liquid");
export const ACTION = "badger-sett-withdraw";
export const manifest = {
  familyId: FAMILY, domain: "protocol", ownedActionAdapterIds: [ACTION],
  requiredInfraActionAdapterIds: [], supportedLineages: [LINEAGE],
  allowedTaxonomy: [{ slotKind: "protocol", protocolAction: "redeem" }],
  poolAdapterIds: [ACTION], edgeAdapterIds: [ACTION], requiresProtocolEdgesFlag: true,
} satisfies FamilyManifest<"protocol">;
