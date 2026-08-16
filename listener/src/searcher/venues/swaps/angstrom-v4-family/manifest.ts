import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";

export const ANGSTROM_V4_FAMILY_ID = familyId("custom-swap:angstrom-v4");
export const ANGSTROM_V4_LINEAGE_ID = lineageId(
  "angstrom-v4:official-hook-poolkey",
);

export const angstromV4FamilyManifest = {
  familyId: ANGSTROM_V4_FAMILY_ID,
  domain: "swap",
  ownedActionAdapterIds: ["angstrom-v4-swap"],
  requiredInfraActionAdapterIds: ["erc20-approve"],
  allowedTaxonomy: [{ slotKind: "swap" }],
  supportedLineages: [ANGSTROM_V4_LINEAGE_ID],
  poolAdapterIds: ["angstrom-v4"],
  edgeAdapterIds: ["angstrom-v4-swap"],
  requiresProtocolEdgesFlag: false,
} satisfies FamilyManifest<"swap">;
