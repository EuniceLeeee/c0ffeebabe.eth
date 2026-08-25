import { balancerFlashAdapter } from "../../../../adapters/balancer-flash.js";
import { ADDR } from "../../../../shared/constants/addresses.js";
import type { Erc20BalanceFundingFamilyConfig } from
  "../erc20-balance-family-plugin.js";

export const BALANCER_FLASH_CONFIG = Object.freeze({
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
  discoveryEvent: {
    id: "balancer-v2-flash-loan",
    signature: "FlashLoan(address,address,uint256,uint256)",
    tokenTopicIndex: 2,
    providerFromBlock: 0,
  },
}) satisfies Erc20BalanceFundingFamilyConfig;
