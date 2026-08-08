import { defineProtocolFamily } from "../adapter-family-plugin.js";
import { goldxFamilyOwnedAction } from "./goldx-family/action.js";
import { goldxDiscovery } from "./goldx-family/discovery.js";
import { goldxExact } from "./goldx-family/exact.js";
import { goldxExecution } from "./goldx-family/execution.js";
import { goldxIdentity } from "./goldx-family/identity.js";
import { goldxInstance } from "./goldx-family/instance.js";
import { goldxFamilyManifest } from "./goldx-family/manifest.js";
import { goldxPricing } from "./goldx-family/pricing.js";
import { goldxProtocol } from "./goldx-family/protocol.js";
import { goldxRoutes } from "./goldx-family/routes.js";

/** Compatibility assembly export; production imports each semantic root. */
export const goldxStrictFamilyPlugin = defineProtocolFamily({
  manifest: goldxFamilyManifest,
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

export {
  goldxDiscovery,
  goldxExact,
  goldxExecution,
  goldxFamilyManifest,
  goldxFamilyOwnedAction,
  goldxIdentity,
  goldxInstance,
  goldxPricing,
  goldxProtocol,
  goldxRoutes,
};
export type {
  GoldxCandidate,
  GoldxDescriptor,
  GoldxExactEvidence,
  GoldxIdentity,
  GoldxPricingDescriptor,
  GoldxRoute,
} from "./goldx-family/types.js";
