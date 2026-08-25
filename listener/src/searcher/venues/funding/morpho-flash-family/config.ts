import { morphoFlashAdapter } from "../../../../adapters/morpho-flash.js";
import { ADDR } from "../../../../shared/constants/addresses.js";
import type { Erc20BalanceFundingFamilyConfig } from
  "../erc20-balance-family-plugin.js";

export const MORPHO_FLASH_CONFIG = Object.freeze({
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
  discoveryEvent: {
    id: "morpho-flash-loan",
    signature: "FlashLoan(address,address,uint256)",
    tokenTopicIndex: 2,
    providerFromBlock: 0,
  },
}) satisfies Erc20BalanceFundingFamilyConfig;
