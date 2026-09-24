import { defineFamilyActivation } from "./activation.js";
import { defineSwapFamily } from "../adapter-family-plugin.js";
import { ellaBuyAction, ellaSellAction } from "../swaps/ella-exchange-family/action.js";
import { ellaCapture } from "../swaps/ella-exchange-family/capture.js";
import { ellaDiscovery } from "../swaps/ella-exchange-family/discovery.js";
import { ellaExact } from "../swaps/ella-exchange-family/exact.js";
import { ellaExecution } from "../swaps/ella-exchange-family/execution.js";
import { ellaIdentity } from "../swaps/ella-exchange-family/identity.js";
import { ellaInstance } from "../swaps/ella-exchange-family/instance.js";
import { ellaManifest } from "../swaps/ella-exchange-family/manifest.js";
import { ellaPricing } from "../swaps/ella-exchange-family/pricing.js";
import { ellaRoutes } from "../swaps/ella-exchange-family/routes.js";
import { ellaSwap } from "../swaps/ella-exchange-family/swap.js";
export const activation = defineFamilyActivation({ enabled: true, envKey: "SEARCHER_FAMILY_ELLA_EXCHANGE_ENABLED" });

export const plugin = defineSwapFamily({ manifest: ellaManifest, capture: ellaCapture,
  discovery: ellaDiscovery, identity: ellaIdentity, instance: ellaInstance,
  routes: ellaRoutes, pricing: ellaPricing, exact: ellaExact, execution: ellaExecution,
  swap: ellaSwap, actionAdapters: [ellaBuyAction, ellaSellAction] });
