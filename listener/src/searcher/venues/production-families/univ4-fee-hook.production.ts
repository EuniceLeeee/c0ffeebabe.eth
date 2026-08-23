import { defineSwapFamily } from "../adapter-family-plugin.js";
import { univ4FeeHookCapture } from "../swaps/univ4-fee-hook-family/capture.js";
import {
  univ4FeeHookSettleFamilyOwnedAction,
  univ4FeeHookSettleValueFamilyOwnedAction,
  univ4FeeHookSwapFamilyOwnedAction,
  univ4FeeHookSyncFamilyOwnedAction,
  univ4FeeHookTakeFamilyOwnedAction,
  univ4FeeHookUnlockFamilyOwnedAction,
} from "../swaps/univ4-fee-hook-family/action.js";
import { univ4FeeHookDiscovery } from "../swaps/univ4-fee-hook-family/discovery.js";
import { univ4FeeHookExact } from "../swaps/univ4-fee-hook-family/exact.js";
import { univ4FeeHookExecution } from "../swaps/univ4-fee-hook-family/execution.js";
import { univ4FeeHookIdentity } from "../swaps/univ4-fee-hook-family/identity.js";
import { univ4FeeHookInstance } from "../swaps/univ4-fee-hook-family/instance.js";
import { univ4FeeHookFamilyManifest } from "../swaps/univ4-fee-hook-family/manifest.js";
import { univ4FeeHookPricing } from "../swaps/univ4-fee-hook-family/pricing.js";
import { univ4FeeHookRoutes } from "../swaps/univ4-fee-hook-family/routes.js";
import { univ4FeeHookSwap } from "../swaps/univ4-fee-hook-family/swap.js";

export const plugin = defineSwapFamily({
  manifest: univ4FeeHookFamilyManifest,
  capture: univ4FeeHookCapture,
  discovery: univ4FeeHookDiscovery,
  identity: univ4FeeHookIdentity,
  instance: univ4FeeHookInstance,
  routes: univ4FeeHookRoutes,
  pricing: univ4FeeHookPricing,
  exact: univ4FeeHookExact,
  execution: univ4FeeHookExecution,
  swap: univ4FeeHookSwap,
  actionAdapters: [
    univ4FeeHookUnlockFamilyOwnedAction,
    univ4FeeHookSwapFamilyOwnedAction,
    univ4FeeHookTakeFamilyOwnedAction,
    univ4FeeHookSyncFamilyOwnedAction,
    univ4FeeHookSettleFamilyOwnedAction,
    univ4FeeHookSettleValueFamilyOwnedAction,
  ],
});
