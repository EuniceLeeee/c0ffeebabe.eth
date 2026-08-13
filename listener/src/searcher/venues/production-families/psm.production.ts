import { defineProtocolFamily } from "../adapter-family-plugin.js";
import { psmCapture } from "../protocols/psm-family/capture.js";
import { psmFamilyOwnedAction } from "../protocols/psm-family/action.js";
import { psmDiscovery } from "../protocols/psm-family/discovery.js";
import { psmExact } from "../protocols/psm-family/exact.js";
import { psmExecution } from "../protocols/psm-family/execution.js";
import { psmIdentity } from "../protocols/psm-family/identity.js";
import { psmInstance } from "../protocols/psm-family/instance.js";
import { psmFamilyManifest } from "../protocols/psm-family/manifest.js";
import { psmPricing } from "../protocols/psm-family/pricing.js";
import { psmProtocol } from "../protocols/psm-family/protocol.js";
import { psmRoutes } from "../protocols/psm-family/routes.js";

export const plugin = defineProtocolFamily({
  manifest: psmFamilyManifest,
  capture: psmCapture,
  discovery: psmDiscovery,
  identity: psmIdentity,
  instance: psmInstance,
  routes: psmRoutes,
  pricing: psmPricing,
  exact: psmExact,
  execution: psmExecution,
  protocol: psmProtocol,
  actionAdapters: [psmFamilyOwnedAction],
});
