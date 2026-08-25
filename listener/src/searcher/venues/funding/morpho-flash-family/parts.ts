import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";
import {
  createErc20BalanceFundingOwnedAction,
  createErc20BalanceFundingSemantics,
} from "../erc20-balance-family-plugin.js";
import { MORPHO_FLASH_CONFIG } from "./config.js";

export const morphoFlashManifest = {
  familyId: familyId("flash-loan:morpho"),
  domain: "funding",
  ownedActionAdapterIds: ["morpho-flash"],
  requiredInfraActionAdapterIds: ["assert-balance", "erc20-approve"],
  allowedTaxonomy: [{ slotKind: "flash" }],
  supportedLineages: [lineageId("morpho-flash")],
  fundingPriority: { planningPriority: 0, liquidityPriority: 1 },
} satisfies FamilyManifest<"funding">;

export const morphoFlashFunding =
  createErc20BalanceFundingSemantics(MORPHO_FLASH_CONFIG);

export const morphoFlashFamilyOwnedAction =
  createErc20BalanceFundingOwnedAction(MORPHO_FLASH_CONFIG);
