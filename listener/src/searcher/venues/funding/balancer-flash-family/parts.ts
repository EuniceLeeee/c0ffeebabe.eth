import { balancerFlashAdapter } from "../../../../adapters/balancer-flash.js";
import { ADDR } from "../../../../shared/constants/addresses.js";
import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";
import {
  createErc20BalanceFundingOwnedAction,
  createErc20BalanceFundingSemantics,
  type Erc20BalanceFundingFamilyConfig,
} from "../erc20-balance-family-plugin.js";

const BALANCER_FLASH_CONFIG = Object.freeze({
  familyId: "flash-loan:balancer-v2",
  lineageId: "balancer-flash",
  action: balancerFlashAdapter,
  target: ADDR.BALANCER_VAULT,
  liquidityHolder: ADDR.BALANCER_VAULT,
  repayment: "transfer",
  paramShape: "tokens-and-amounts",
  planningPriority: 1,
  liquidityPriority: 0,
  requiredInfraActionAdapterIds: ["assert-balance", "erc20-transfer"],
}) satisfies Erc20BalanceFundingFamilyConfig;

export const balancerFlashManifest = {
  familyId: familyId("flash-loan:balancer-v2"),
  domain: "funding",
  ownedActionAdapterIds: ["balancer-flash"],
  requiredInfraActionAdapterIds: ["assert-balance", "erc20-transfer"],
  allowedTaxonomy: [{ slotKind: "flash" }],
  supportedLineages: [lineageId("balancer-flash")],
} satisfies FamilyManifest<"funding">;

export const balancerFlashFunding =
  createErc20BalanceFundingSemantics(BALANCER_FLASH_CONFIG);

export const balancerFlashFamilyOwnedAction =
  createErc20BalanceFundingOwnedAction(BALANCER_FLASH_CONFIG);
