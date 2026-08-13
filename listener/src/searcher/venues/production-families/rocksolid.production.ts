import { defineProtocolFamily } from "../adapter-family-plugin.js";
import { rocksolidCapture } from "../protocols/rocksolid-family/capture.js";
import { rocksolidFamilyOwnedAction } from "../protocols/rocksolid-family/action.js";
import { rocksolidDiscovery } from "../protocols/rocksolid-family/discovery.js";
import { rocksolidExact } from "../protocols/rocksolid-family/exact.js";
import { rocksolidExecution } from "../protocols/rocksolid-family/execution.js";
import { rocksolidIdentity } from "../protocols/rocksolid-family/identity.js";
import { rocksolidInstance } from "../protocols/rocksolid-family/instance.js";
import { rocksolidFamilyManifest } from "../protocols/rocksolid-family/manifest.js";
import { rocksolidPricing } from "../protocols/rocksolid-family/pricing.js";
import { rocksolidProtocol } from "../protocols/rocksolid-family/protocol.js";
import { rocksolidRoutes } from "../protocols/rocksolid-family/routes.js";

export const plugin = defineProtocolFamily({
  manifest: rocksolidFamilyManifest,
  capture: rocksolidCapture,
  discovery: rocksolidDiscovery,
  identity: rocksolidIdentity,
  instance: rocksolidInstance,
  routes: rocksolidRoutes,
  pricing: rocksolidPricing,
  exact: rocksolidExact,
  execution: rocksolidExecution,
  protocol: rocksolidProtocol,
  actionAdapters: [rocksolidFamilyOwnedAction],
});
