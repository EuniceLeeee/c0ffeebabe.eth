import { defineSwapFamily } from "../adapter-family-plugin.js";
import { fluidDexFamilyOwnedAction } from "./fluid-dex-family/action.js";
import { fluidDexDiscovery } from "./fluid-dex-family/discovery.js";
import { fluidDexExact } from "./fluid-dex-family/exact.js";
import { fluidDexExecution } from "./fluid-dex-family/execution.js";
import { fluidDexIdentity } from "./fluid-dex-family/identity.js";
import { fluidDexInstance } from "./fluid-dex-family/instance.js";
import { fluidDexFamilyManifest } from "./fluid-dex-family/manifest.js";
import { fluidDexPricing } from "./fluid-dex-family/pricing.js";
import { fluidDexRoutes } from "./fluid-dex-family/routes.js";
import { fluidDexSwap } from "./fluid-dex-family/swap.js";

/** Strict S1 shadow definition; production activation happens at cohort cutover. */
export const fluidDexStrictFamilyPlugin = defineSwapFamily({
  manifest: fluidDexFamilyManifest,
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

export {
  fluidDexDiscovery,
  fluidDexExact,
  fluidDexExecution,
  fluidDexFamilyManifest,
  fluidDexFamilyOwnedAction,
  fluidDexIdentity,
  fluidDexInstance,
  fluidDexPricing,
  fluidDexRoutes,
  fluidDexSwap,
};
export type {
  FluidDexCandidate,
  FluidDexDescriptor,
  FluidDexExactEvidence,
  FluidDexIdentity,
  FluidDexPricingDescriptor,
  FluidDexPricingSnapshot,
  FluidDexRoute,
} from "./fluid-dex-family/types.js";
