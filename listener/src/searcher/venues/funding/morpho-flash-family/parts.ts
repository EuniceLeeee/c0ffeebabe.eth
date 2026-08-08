import { morphoFlashAdapter } from "../../../../adapters/morpho-flash.js";
import { ADDR } from "../../../../shared/constants/addresses.js";
import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";
import {
  createErc20BalanceFundingOwnedAction,
  createErc20BalanceFundingSemantics,
  type Erc20BalanceFundingFamilyConfig,
} from "../erc20-balance-family-plugin.js";

const MORPHO_FLASH_CONFIG = Object.freeze({
  familyId: "flash-loan:morpho",
  lineageId: "morpho-flash",
  action: morphoFlashAdapter,
  target: ADDR.MORPHO,
  liquidityHolder: ADDR.MORPHO,
  repayment: "approve-pull",
  paramShape: "none",
  planningPriority: 0,
  liquidityPriority: 1,
  requiredInfraActionAdapterIds: ["assert-balance", "erc20-approve"],
}) satisfies Erc20BalanceFundingFamilyConfig;

export const morphoFlashManifest = {
  familyId: familyId("flash-loan:morpho"),
  domain: "funding",
  ownedActionAdapterIds: ["morpho-flash"],
  requiredInfraActionAdapterIds: ["assert-balance", "erc20-approve"],
  allowedTaxonomy: [{ slotKind: "flash" }],
  supportedLineages: [lineageId("morpho-flash")],
} satisfies FamilyManifest<"funding">;

export const morphoFlashFunding =
  createErc20BalanceFundingSemantics(MORPHO_FLASH_CONFIG);

export const morphoFlashFamilyOwnedAction =
  createErc20BalanceFundingOwnedAction(MORPHO_FLASH_CONFIG);
