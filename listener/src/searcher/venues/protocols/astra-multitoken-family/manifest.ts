import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";

export const ASTRA_MULTITOKEN_FAMILY_ID = familyId(
  "protocol:astra-multitoken",
);
export const ASTRA_MULTITOKEN_ACTIVE_REGISTRY_LINEAGE_ID = lineageId(
  "astra-multitoken:observed-active-registry",
);

export const astraMultiTokenFamilyManifest = {
  familyId: ASTRA_MULTITOKEN_FAMILY_ID,
  domain: "protocol",
  ownedActionAdapterIds: ["astra-multitoken-change"],
  requiredInfraActionAdapterIds: ["erc20-approve"],
  allowedTaxonomy: [{ slotKind: "protocol", protocolAction: "convert" }],
  supportedLineages: [ASTRA_MULTITOKEN_ACTIVE_REGISTRY_LINEAGE_ID],
  poolAdapterIds: ["astra-multitoken"],
} satisfies FamilyManifest<"protocol">;
