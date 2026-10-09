import { defineFamilyActivation } from "./activation.js";
import { defineProtocolFamily } from "../adapter-family-plugin.js";
import { yieldBasisLtWithdrawAction, yieldBasisLtDepositAction } from
  "../protocols/yieldbasis-lt-family/action.js";
import { yieldBasisLtCapture } from
  "../protocols/yieldbasis-lt-family/capture.js";
import { yieldBasisLtDiscovery } from
  "../protocols/yieldbasis-lt-family/discovery.js";
import { yieldBasisLtExact } from
  "../protocols/yieldbasis-lt-family/exact.js";
import { yieldBasisLtExecution } from
  "../protocols/yieldbasis-lt-family/execution.js";
import { yieldBasisLtIdentity } from
  "../protocols/yieldbasis-lt-family/identity.js";
import { yieldBasisLtInstance } from
  "../protocols/yieldbasis-lt-family/instance.js";
import { yieldBasisLtManifest } from
  "../protocols/yieldbasis-lt-family/manifest.js";
import { yieldBasisLtPricing } from
  "../protocols/yieldbasis-lt-family/pricing.js";
import { yieldBasisLtProtocol } from
  "../protocols/yieldbasis-lt-family/protocol.js";
import { yieldBasisLtRoutes } from
  "../protocols/yieldbasis-lt-family/routes.js";

/**
 * Registered DISABLED by default: adding this family must not change the
 * production default enabled set. Acceptance runs opt in explicitly with
 * SEARCHER_FAMILY_YIELDBASIS_LT_ENABLED=1; whether it becomes enabled by
 * default is an integrator decision.
 */
export const activation = defineFamilyActivation({
  enabled: false,
  envKey: "SEARCHER_FAMILY_YIELDBASIS_LT_ENABLED",
});

export const plugin = defineProtocolFamily({
  manifest: yieldBasisLtManifest,
  capture: yieldBasisLtCapture,
  discovery: yieldBasisLtDiscovery,
  identity: yieldBasisLtIdentity,
  instance: yieldBasisLtInstance,
  routes: yieldBasisLtRoutes,
  pricing: yieldBasisLtPricing,
  exact: yieldBasisLtExact,
  execution: yieldBasisLtExecution,
  protocol: yieldBasisLtProtocol,
  actionAdapters: [yieldBasisLtWithdrawAction, yieldBasisLtDepositAction],
});
