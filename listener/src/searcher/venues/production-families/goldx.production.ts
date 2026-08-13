import { defineProtocolFamily } from "../adapter-family-plugin.js";
import { goldxCapture } from "../protocols/goldx-family/capture.js";
import { goldxFamilyOwnedAction } from "../protocols/goldx-family/action.js";
import { goldxDiscovery } from "../protocols/goldx-family/discovery.js";
import { goldxExact } from "../protocols/goldx-family/exact.js";
import { goldxExecution } from "../protocols/goldx-family/execution.js";
import { goldxIdentity } from "../protocols/goldx-family/identity.js";
import { goldxInstance } from "../protocols/goldx-family/instance.js";
import { goldxFamilyManifest } from "../protocols/goldx-family/manifest.js";
import { goldxPricing } from "../protocols/goldx-family/pricing.js";
import { goldxProtocol } from "../protocols/goldx-family/protocol.js";
import { goldxRoutes } from "../protocols/goldx-family/routes.js";

export const plugin = defineProtocolFamily({
  manifest: goldxFamilyManifest,
  capture: goldxCapture,
  discovery: goldxDiscovery,
  identity: goldxIdentity,
  instance: goldxInstance,
  routes: goldxRoutes,
  pricing: goldxPricing,
  exact: goldxExact,
  execution: goldxExecution,
  protocol: goldxProtocol,
  actionAdapters: [goldxFamilyOwnedAction],
});
