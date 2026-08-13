import { defineSwapFamily } from "../adapter-family-plugin.js";
import { fluidDexCapture } from "../swaps/fluid-dex-family/capture.js";
import { fluidDexFamilyOwnedAction } from "../swaps/fluid-dex-family/action.js";
import { fluidDexDiscovery } from "../swaps/fluid-dex-family/discovery.js";
import { fluidDexExact } from "../swaps/fluid-dex-family/exact.js";
import { fluidDexExecution } from "../swaps/fluid-dex-family/execution.js";
import { fluidDexIdentity } from "../swaps/fluid-dex-family/identity.js";
import { fluidDexInstance } from "../swaps/fluid-dex-family/instance.js";
import { fluidDexFamilyManifest } from "../swaps/fluid-dex-family/manifest.js";
import { fluidDexPricing } from "../swaps/fluid-dex-family/pricing.js";
import { fluidDexRoutes } from "../swaps/fluid-dex-family/routes.js";
import { fluidDexSwap } from "../swaps/fluid-dex-family/swap.js";

export const plugin = defineSwapFamily({
  manifest: fluidDexFamilyManifest,
  capture: fluidDexCapture,
  discovery: fluidDexDiscovery,
  identity: fluidDexIdentity,
  instance: fluidDexInstance,
  routes: fluidDexRoutes,
  pricing: fluidDexPricing,
  exact: fluidDexExact,
  execution: fluidDexExecution,
  swap: fluidDexSwap,
  actionAdapters: [fluidDexFamilyOwnedAction],
});
