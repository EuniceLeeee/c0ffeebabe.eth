import { defineSwapFamily } from "../adapter-family-plugin.js";
import { curveUnderlyingFamilyOwnedAction } from
  "./curve-underlying-family/action.js";
import { curveUnderlyingDiscovery } from
  "./curve-underlying-family/discovery.js";
import { curveUnderlyingExact } from "./curve-underlying-family/exact.js";
import { curveUnderlyingExecution } from
  "./curve-underlying-family/execution.js";
import { curveUnderlyingIdentity } from
  "./curve-underlying-family/identity.js";
import { curveUnderlyingInstance } from
  "./curve-underlying-family/instance.js";
import { curveUnderlyingFamilyManifest } from
  "./curve-underlying-family/manifest.js";
import { curveUnderlyingPricing } from
  "./curve-underlying-family/pricing.js";
import { curveUnderlyingRoutes } from
  "./curve-underlying-family/routes.js";
import { curveUnderlyingSwap } from "./curve-underlying-family/swap.js";

/** Strict S1 shadow definition; production activation happens at cohort cutover. */
export const curveUnderlyingStrictFamilyPlugin = defineSwapFamily({
  manifest: curveUnderlyingFamilyManifest,
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

export {
  curveUnderlyingDiscovery,
  curveUnderlyingExact,
  curveUnderlyingExecution,
  curveUnderlyingFamilyManifest,
  curveUnderlyingFamilyOwnedAction,
  curveUnderlyingIdentity,
  curveUnderlyingInstance,
  curveUnderlyingPricing,
  curveUnderlyingRoutes,
  curveUnderlyingSwap,
};
export type {
  CurveUnderlyingCandidate,
  CurveUnderlyingDescriptor,
  CurveUnderlyingExactEvidence,
  CurveUnderlyingIdentity,
  CurveUnderlyingPricingDescriptor,
  CurveUnderlyingPricingSnapshot,
  CurveUnderlyingRoute,
} from "./curve-underlying-family/types.js";
