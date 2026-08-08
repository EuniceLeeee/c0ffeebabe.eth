import { defineProtocolFamily } from "../adapter-family-plugin.js";
import { astraMultiTokenFamilyOwnedAction } from "../protocols/astra-multitoken-family/action.js";
import { astraMultiTokenDiscovery } from "../protocols/astra-multitoken-family/discovery.js";
import { astraMultiTokenExact } from "../protocols/astra-multitoken-family/exact.js";
import { astraMultiTokenExecution } from "../protocols/astra-multitoken-family/execution.js";
import { astraMultiTokenIdentity } from "../protocols/astra-multitoken-family/identity.js";
import { astraMultiTokenInstance } from "../protocols/astra-multitoken-family/instance.js";
import { astraMultiTokenFamilyManifest } from "../protocols/astra-multitoken-family/manifest.js";
import { astraMultiTokenPricing } from "../protocols/astra-multitoken-family/pricing.js";
import { astraMultiTokenProtocol } from "../protocols/astra-multitoken-family/protocol.js";
import { astraMultiTokenRoutes } from "../protocols/astra-multitoken-family/routes.js";

export const plugin = defineProtocolFamily({
  manifest: astraMultiTokenFamilyManifest,
  discovery: astraMultiTokenDiscovery,
  identity: astraMultiTokenIdentity,
  instance: astraMultiTokenInstance,
  routes: astraMultiTokenRoutes,
  pricing: astraMultiTokenPricing,
  exact: astraMultiTokenExact,
  execution: astraMultiTokenExecution,
  protocol: astraMultiTokenProtocol,
  actionAdapters: [astraMultiTokenFamilyOwnedAction],
});
