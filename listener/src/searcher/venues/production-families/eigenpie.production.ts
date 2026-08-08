import { defineProtocolFamily } from "../adapter-family-plugin.js";
import { eigenpieFamilyOwnedAction } from
  "../protocols/eigenpie-family/action.js";
import { eigenpieDiscovery } from
  "../protocols/eigenpie-family/discovery.js";
import { eigenpieExact } from "../protocols/eigenpie-family/exact.js";
import { eigenpieExecution } from
  "../protocols/eigenpie-family/execution.js";
import { eigenpieIdentity } from
  "../protocols/eigenpie-family/identity.js";
import { eigenpieInstance } from
  "../protocols/eigenpie-family/instance.js";
import { eigenpieFamilyManifest } from
  "../protocols/eigenpie-family/manifest.js";
import { eigenpiePricing } from "../protocols/eigenpie-family/pricing.js";
import { eigenpieProtocol } from "../protocols/eigenpie-family/protocol.js";
import { eigenpieRoutes } from "../protocols/eigenpie-family/routes.js";

export const plugin = defineProtocolFamily({
  manifest: eigenpieFamilyManifest,
  discovery: eigenpieDiscovery,
  identity: eigenpieIdentity,
  instance: eigenpieInstance,
  routes: eigenpieRoutes,
  pricing: eigenpiePricing,
  exact: eigenpieExact,
  execution: eigenpieExecution,
  protocol: eigenpieProtocol,
  actionAdapters: [eigenpieFamilyOwnedAction],
});
