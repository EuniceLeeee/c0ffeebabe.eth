import { defineFamilyActivation } from "./activation.js";
import { defineProtocolFamily } from "../adapter-family-plugin.js";
import { compoundCTokenRedeemAction } from
  "../protocols/compound-ctoken-family/action.js";
import { compoundCTokenCapture } from
  "../protocols/compound-ctoken-family/capture.js";
import { compoundCTokenDiscovery } from
  "../protocols/compound-ctoken-family/discovery.js";
import { compoundCTokenExact } from
  "../protocols/compound-ctoken-family/exact.js";
import { compoundCTokenExecution } from
  "../protocols/compound-ctoken-family/execution.js";
import { compoundCTokenIdentity } from
  "../protocols/compound-ctoken-family/identity.js";
import { compoundCTokenInstance } from
  "../protocols/compound-ctoken-family/instance.js";
import { compoundCTokenManifest } from
  "../protocols/compound-ctoken-family/manifest.js";
import { compoundCTokenPricing } from
  "../protocols/compound-ctoken-family/pricing.js";
import { compoundCTokenProtocol } from
  "../protocols/compound-ctoken-family/protocol.js";
import { compoundCTokenRoutes } from
  "../protocols/compound-ctoken-family/routes.js";

/**
 * Registered DISABLED by default: adding this family must not change the
 * production default enabled set. Acceptance runs opt in explicitly with
 * SEARCHER_FAMILY_COMPOUND_CTOKEN_ENABLED=1; whether it becomes enabled by
 * default is an integrator decision.
 */
export const activation = defineFamilyActivation({
  enabled: false,
  envKey: "SEARCHER_FAMILY_COMPOUND_CTOKEN_ENABLED",
});

export const plugin = defineProtocolFamily({
  manifest: compoundCTokenManifest,
  capture: compoundCTokenCapture,
  discovery: compoundCTokenDiscovery,
  identity: compoundCTokenIdentity,
  instance: compoundCTokenInstance,
  routes: compoundCTokenRoutes,
  pricing: compoundCTokenPricing,
  exact: compoundCTokenExact,
  execution: compoundCTokenExecution,
  protocol: compoundCTokenProtocol,
  actionAdapters: [compoundCTokenRedeemAction],
});
