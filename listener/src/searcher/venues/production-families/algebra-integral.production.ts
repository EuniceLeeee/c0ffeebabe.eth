import { defineFamilyActivation } from "./activation.js";
import { defineSwapFamily } from "../adapter-family-plugin.js";
import { algebraIntegralSwapAction } from
  "../swaps/algebra-integral-family/action.js";
import { algebraIntegralCapture } from
  "../swaps/algebra-integral-family/capture.js";
import { algebraIntegralDiscovery } from
  "../swaps/algebra-integral-family/discovery.js";
import { algebraIntegralExact } from
  "../swaps/algebra-integral-family/exact.js";
import { algebraIntegralExecution } from
  "../swaps/algebra-integral-family/execution.js";
import { algebraIntegralIdentity } from
  "../swaps/algebra-integral-family/identity.js";
import { algebraIntegralInstance } from
  "../swaps/algebra-integral-family/instance.js";
import { algebraIntegralManifest } from
  "../swaps/algebra-integral-family/manifest.js";
import { algebraIntegralPricing } from
  "../swaps/algebra-integral-family/pricing.js";
import { algebraIntegralRoutes } from
  "../swaps/algebra-integral-family/routes.js";
import { algebraIntegralSwap } from
  "../swaps/algebra-integral-family/swap.js";

/**
 * Registered DISABLED by default: adding this family must not change the
 * production default enabled set. Acceptance runs opt in explicitly with
 * SEARCHER_FAMILY_ALGEBRA_INTEGRAL_ENABLED=1; whether it becomes enabled by
 * default is an integrator decision.
 */
export const activation = defineFamilyActivation({
  enabled: false,
  envKey: "SEARCHER_FAMILY_ALGEBRA_INTEGRAL_ENABLED",
});

export const plugin = defineSwapFamily({
  manifest: algebraIntegralManifest,
  capture: algebraIntegralCapture,
  discovery: algebraIntegralDiscovery,
  identity: algebraIntegralIdentity,
  instance: algebraIntegralInstance,
  routes: algebraIntegralRoutes,
  pricing: algebraIntegralPricing,
  exact: algebraIntegralExact,
  execution: algebraIntegralExecution,
  swap: algebraIntegralSwap,
  actionAdapters: [algebraIntegralSwapAction],
});
