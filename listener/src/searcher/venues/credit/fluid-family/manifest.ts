import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";

export const FLUID_CREDIT_FAMILY_ID = familyId("credit:fluid");
export const FLUID_CREDIT_FACTORY_LINEAGE_ID = lineageId(
  "fluid-credit:vault-factory-child",
);

export const fluidCreditFamilyManifest = {
  familyId: FLUID_CREDIT_FAMILY_ID,
  domain: "credit",
  ownedActionAdapterIds: ["fluid-vault", "fluid-dex-liquidate"],
  requiredInfraActionAdapterIds: ["erc20-approve"],
  allowedTaxonomy: [{ slotKind: "lend" }],
  supportedLineages: [FLUID_CREDIT_FACTORY_LINEAGE_ID],
} satisfies FamilyManifest<"credit">;
