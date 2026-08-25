import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";
import {
  createErc20BalanceFundingOwnedAction,
  createErc20BalanceFundingSemantics,
} from "../erc20-balance-family-plugin.js";
import { BALANCER_FLASH_CONFIG } from "./config.js";

export const balancerFlashManifest = {
  familyId: familyId("flash-loan:balancer-v2"),
  domain: "funding",
  ownedActionAdapterIds: ["balancer-flash"],
  requiredInfraActionAdapterIds: ["assert-balance", "erc20-transfer"],
  allowedTaxonomy: [{ slotKind: "flash" }],
  supportedLineages: [lineageId("balancer-flash")],
  fundingPriority: { planningPriority: 1, liquidityPriority: 0 },
} satisfies FamilyManifest<"funding">;

export const balancerFlashFunding =
  createErc20BalanceFundingSemantics(BALANCER_FLASH_CONFIG);

export const balancerFlashFamilyOwnedAction =
  createErc20BalanceFundingOwnedAction(BALANCER_FLASH_CONFIG);
