import { defineProtocolFamily } from "../adapter-family-plugin.js";
import { rocksolidFamilyOwnedAction } from "./rocksolid-family/action.js";
import { rocksolidDiscovery } from "./rocksolid-family/discovery.js";
import { rocksolidExact } from "./rocksolid-family/exact.js";
import { rocksolidExecution } from "./rocksolid-family/execution.js";
import { rocksolidIdentity } from "./rocksolid-family/identity.js";
import { rocksolidInstance } from "./rocksolid-family/instance.js";
import { rocksolidFamilyManifest } from "./rocksolid-family/manifest.js";
import { rocksolidPricing } from "./rocksolid-family/pricing.js";
import { rocksolidProtocol } from "./rocksolid-family/protocol.js";
import { rocksolidRoutes } from "./rocksolid-family/routes.js";

/** Compatibility assembly export; production imports each semantic root. */
export const rocksolidStrictFamilyPlugin = defineProtocolFamily({
  manifest: rocksolidFamilyManifest,
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

export {
  rocksolidDiscovery,
  rocksolidExact,
  rocksolidExecution,
  rocksolidFamilyManifest,
  rocksolidFamilyOwnedAction,
  rocksolidIdentity,
  rocksolidInstance,
  rocksolidPricing,
  rocksolidProtocol,
  rocksolidRoutes,
};
export type {
  RocksolidCandidate,
  RocksolidDescriptor,
  RocksolidExactEvidence,
  RocksolidIdentity,
  RocksolidPricingDescriptor,
  RocksolidRoute,
} from "./rocksolid-family/types.js";
