import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";

export const EIGENPIE_FAMILY_ID = familyId("protocol:eigenpie");
export const EIGENPIE_LINEAGE_ID = lineageId(
  "eigenpie:observed-active-pair",
);

export const eigenpieFamilyManifest = Object.freeze({
  familyId: EIGENPIE_FAMILY_ID,
  domain: "protocol",
  ownedActionAdapterIds: Object.freeze(["eigenpie-deposit-asset"]),
  requiredInfraActionAdapterIds: Object.freeze(["erc20-approve"]),
  allowedTaxonomy: Object.freeze([Object.freeze({
    slotKind: "protocol" as const,
    protocolAction: "wrap" as const,
  })]),
  supportedLineages: Object.freeze([EIGENPIE_LINEAGE_ID]),
  poolAdapterIds: Object.freeze(["eigenpie-deposit-router"]),
  edgeAdapterIds: Object.freeze(["eigenpie-deposit-asset"]),
  requiresProtocolEdgesFlag: true,
}) satisfies FamilyManifest<"protocol">;
