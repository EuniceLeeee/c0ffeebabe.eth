import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";

export const ORIGIN_STETH_ARM_FAMILY_ID = familyId("protocol:origin-steth-arm");
export const ORIGIN_STETH_ARM_LINEAGE_ID = lineageId("origin-steth-arm-lido");
export const ORIGIN_STETH_ARM_ACTION_ID = "origin-steth-arm-swap";

export const originStethArmFamilyManifest = {
  familyId: ORIGIN_STETH_ARM_FAMILY_ID,
  domain: "protocol",
  ownedActionAdapterIds: [ORIGIN_STETH_ARM_ACTION_ID],
  requiredInfraActionAdapterIds: ["erc20-approve"],
  allowedTaxonomy: [{ slotKind: "protocol", protocolAction: "convert" }],
  supportedLineages: [ORIGIN_STETH_ARM_LINEAGE_ID],
  // Provenance label only. The ARM proxy is admitted by the proxy +
  // implementation runtime-code proof and the observed swap behavior in
  // identity.ts, not by a file-backed pool-universe entry.
  poolAdapterIds: ["origin-steth-arm"],
  edgeAdapterIds: [ORIGIN_STETH_ARM_ACTION_ID],
  requiresProtocolEdgesFlag: false,
} satisfies FamilyManifest<"protocol">;
