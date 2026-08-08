import { defineProtocolFamily } from "../adapter-family-plugin.js";
import { psmFamilyOwnedAction } from "./psm-family/action.js";
import { psmDiscovery } from "./psm-family/discovery.js";
import { psmExact } from "./psm-family/exact.js";
import { psmExecution } from "./psm-family/execution.js";
import { psmIdentity } from "./psm-family/identity.js";
import { psmInstance } from "./psm-family/instance.js";
import { psmFamilyManifest } from "./psm-family/manifest.js";
import { psmPricing } from "./psm-family/pricing.js";
import { psmProtocol } from "./psm-family/protocol.js";
import { psmRoutes } from "./psm-family/routes.js";

/** Compatibility assembly export; production imports each semantic root. */
export const psmStrictFamilyPlugin = defineProtocolFamily({
  manifest: psmFamilyManifest,
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

export {
  psmDiscovery,
  psmExact,
  psmExecution,
  psmFamilyManifest,
  psmFamilyOwnedAction,
  psmIdentity,
  psmInstance,
  psmPricing,
  psmProtocol,
  psmRoutes,
};
export type {
  PsmCandidate,
  PsmDescriptor,
  PsmExactEvidence,
  PsmIdentity,
  PsmPricingDescriptor,
  PsmRoute,
} from "./psm-family/types.js";
