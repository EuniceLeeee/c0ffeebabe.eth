import { defineProtocolFamily } from "../adapter-family-plugin.js";
import { eigenpieFamilyOwnedAction } from "./eigenpie-family/action.js";
import { eigenpieDiscovery } from "./eigenpie-family/discovery.js";
import { eigenpieExact } from "./eigenpie-family/exact.js";
import { eigenpieExecution } from "./eigenpie-family/execution.js";
import { eigenpieIdentity } from "./eigenpie-family/identity.js";
import { eigenpieInstance } from "./eigenpie-family/instance.js";
import { eigenpieFamilyManifest } from "./eigenpie-family/manifest.js";
import { eigenpiePricing } from "./eigenpie-family/pricing.js";
import { eigenpieProtocol } from "./eigenpie-family/protocol.js";
import { eigenpieRoutes } from "./eigenpie-family/routes.js";

/** Compatibility assembly export; production imports each semantic root. */
export const eigenpieStrictFamilyPlugin = defineProtocolFamily({
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

export {
  eigenpieDiscovery,
  eigenpieExact,
  eigenpieExecution,
  eigenpieFamilyManifest,
  eigenpieFamilyOwnedAction,
  eigenpieIdentity,
  eigenpieInstance,
  eigenpiePricing,
  eigenpieProtocol,
  eigenpieRoutes,
};
export type {
  EigenpieCandidate,
  EigenpieDescriptor,
  EigenpieExactEvidence,
  EigenpieIdentity,
  EigenpiePricingDescriptor,
  EigenpieRoute,
} from "./eigenpie-family/types.js";
