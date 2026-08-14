import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";

export const FLUID_DEX_FAMILY_ID = familyId("fluid-dex");
export const FLUID_DEX_FACTORY_LINEAGE_ID = lineageId(
  "fluid-dex:factory-child",
);

export const fluidDexFamilyManifest = {
  familyId: FLUID_DEX_FAMILY_ID,
  domain: "swap",
  ownedActionAdapterIds: ["fluid-dex-swap"],
  requiredInfraActionAdapterIds: ["erc20-approve"],
  allowedTaxonomy: [{ slotKind: "swap" }],
  supportedLineages: [FLUID_DEX_FACTORY_LINEAGE_ID],
  poolAdapterIds: ["fluid-dex"],
  requiresProtocolEdgesFlag: false,
} satisfies FamilyManifest<"swap">;
