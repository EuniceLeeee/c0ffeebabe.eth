import { createErc20BalanceFundingDiscovery } from
  "../erc20-balance-family-plugin.js";
import { BALANCER_FLASH_CONFIG } from "./config.js";

export const balancerFlashDiscovery =
  createErc20BalanceFundingDiscovery(BALANCER_FLASH_CONFIG);
