import { defineSwapFamily } from "../adapter-family-plugin.js";
import { curveUnderlyingCapture } from "../swaps/curve-underlying-family/capture.js";
import { curveUnderlyingFamilyOwnedAction } from "../swaps/curve-underlying-family/action.js";
import { curveUnderlyingDiscovery } from "../swaps/curve-underlying-family/discovery.js";
import { curveUnderlyingExact } from "../swaps/curve-underlying-family/exact.js";
import { curveUnderlyingExecution } from "../swaps/curve-underlying-family/execution.js";
import { curveUnderlyingIdentity } from "../swaps/curve-underlying-family/identity.js";
import { curveUnderlyingInstance } from "../swaps/curve-underlying-family/instance.js";
import { curveUnderlyingFamilyManifest } from "../swaps/curve-underlying-family/manifest.js";
import { curveUnderlyingPricing } from "../swaps/curve-underlying-family/pricing.js";
import { curveUnderlyingRoutes } from "../swaps/curve-underlying-family/routes.js";
import { curveUnderlyingSwap } from "../swaps/curve-underlying-family/swap.js";

export const plugin = defineSwapFamily({
  manifest: curveUnderlyingFamilyManifest,
  capture: curveUnderlyingCapture,
  discovery: curveUnderlyingDiscovery,
  identity: curveUnderlyingIdentity,
  instance: curveUnderlyingInstance,
  routes: curveUnderlyingRoutes,
  pricing: curveUnderlyingPricing,
  exact: curveUnderlyingExact,
  execution: curveUnderlyingExecution,
  swap: curveUnderlyingSwap,
  actionAdapters: [curveUnderlyingFamilyOwnedAction],
});
