import { createErc20BalanceFundingDiscovery } from
  "../erc20-balance-family-plugin.js";
import { MORPHO_FLASH_CONFIG } from "./config.js";

export const morphoFlashDiscovery =
  createErc20BalanceFundingDiscovery(MORPHO_FLASH_CONFIG);
