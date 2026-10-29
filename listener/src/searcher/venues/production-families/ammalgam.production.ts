import { defineFamilyActivation } from "./activation.js";
import { defineSwapFamily } from "../adapter-family-plugin.js";
import { action as ammalgamAction } from "../swaps/ammalgam-family/action.js";
import { capture as ammalgamCapture } from "../swaps/ammalgam-family/capture.js";
import { discovery as ammalgamDiscovery } from "../swaps/ammalgam-family/discovery.js";
import { exact as ammalgamExact } from "../swaps/ammalgam-family/exact.js";
import { execution as ammalgamExecution } from "../swaps/ammalgam-family/execution.js";
import { identity as ammalgamIdentity } from "../swaps/ammalgam-family/identity.js";
import { instance as ammalgamInstance } from "../swaps/ammalgam-family/instance.js";
import { manifest as ammalgamManifest } from "../swaps/ammalgam-family/manifest.js";
import { pricing as ammalgamPricing } from "../swaps/ammalgam-family/pricing.js";
import { routes as ammalgamRoutes } from "../swaps/ammalgam-family/routes.js";
import { swap as ammalgamSwap } from "../swaps/ammalgam-family/swap.js";

export const activation = defineFamilyActivation({ enabled: true, envKey: "SEARCHER_FAMILY_AMMALGAM_ENABLED" });

export const plugin = defineSwapFamily({
  manifest: ammalgamManifest,
  capture: ammalgamCapture,
  discovery: ammalgamDiscovery,
  identity: ammalgamIdentity,
  instance: ammalgamInstance,
  routes: ammalgamRoutes,
  pricing: ammalgamPricing,
  exact: ammalgamExact,
  execution: ammalgamExecution,
  swap: ammalgamSwap,
  actionAdapters: [ammalgamAction],
});
