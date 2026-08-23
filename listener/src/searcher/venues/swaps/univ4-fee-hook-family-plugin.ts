import { defineSwapFamily } from "../adapter-family-plugin.js";
import { univ4FeeHookFamilyOwnedActions } from "./univ4-fee-hook-family/action.js";
import { univ4FeeHookDiscovery } from "./univ4-fee-hook-family/discovery.js";
import { univ4FeeHookExact } from "./univ4-fee-hook-family/exact.js";
import { univ4FeeHookExecution } from "./univ4-fee-hook-family/execution.js";
import { univ4FeeHookIdentity } from "./univ4-fee-hook-family/identity.js";
import { univ4FeeHookInstance } from "./univ4-fee-hook-family/instance.js";
import { univ4FeeHookFamilyManifest } from "./univ4-fee-hook-family/manifest.js";
import { univ4FeeHookPricing } from "./univ4-fee-hook-family/pricing.js";
import { univ4FeeHookRoutes } from "./univ4-fee-hook-family/routes.js";
import { univ4FeeHookSwap } from "./univ4-fee-hook-family/swap.js";
import { univ4FeeHookVictimReplay } from "./univ4-fee-hook-family/victim.js";

/**
 * Strict UniV4 fee-hook Family: standard V4 swap semantics for pools whose
 * poolKey names the audited tiered dynamic-fee hook (chain-proven code hash).
 */
export const univ4FeeHookStrictFamilyPlugin = defineSwapFamily({
  manifest: univ4FeeHookFamilyManifest,
  discovery: univ4FeeHookDiscovery,
  identity: univ4FeeHookIdentity,
  instance: univ4FeeHookInstance,
  routes: univ4FeeHookRoutes,
  pricing: univ4FeeHookPricing,
  exact: univ4FeeHookExact,
  execution: univ4FeeHookExecution,
  swap: univ4FeeHookSwap,
  actionAdapters: univ4FeeHookFamilyOwnedActions,
});

export {
  univ4FeeHookDiscovery,
  univ4FeeHookExact,
  univ4FeeHookExecution,
  univ4FeeHookFamilyManifest,
  univ4FeeHookFamilyOwnedActions,
  univ4FeeHookIdentity,
  univ4FeeHookInstance,
  univ4FeeHookRoutes,
  univ4FeeHookSwap,
  univ4FeeHookVictimReplay,
};
