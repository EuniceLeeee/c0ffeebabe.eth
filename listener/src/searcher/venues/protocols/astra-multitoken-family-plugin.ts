import { defineProtocolFamily } from "../adapter-family-plugin.js";
import { astraMultiTokenFamilyOwnedAction } from "./astra-multitoken-family/action.js";
import { astraMultiTokenDiscovery } from "./astra-multitoken-family/discovery.js";
import { astraMultiTokenExact } from "./astra-multitoken-family/exact.js";
import { astraMultiTokenExecution } from "./astra-multitoken-family/execution.js";
import { astraMultiTokenIdentity } from "./astra-multitoken-family/identity.js";
import { astraMultiTokenInstance } from "./astra-multitoken-family/instance.js";
import { astraMultiTokenFamilyManifest } from "./astra-multitoken-family/manifest.js";
import { astraMultiTokenPricing } from "./astra-multitoken-family/pricing.js";
import { astraMultiTokenProtocol } from "./astra-multitoken-family/protocol.js";
import { astraMultiTokenRoutes } from "./astra-multitoken-family/routes.js";

/**
 * Strict S1 Astra MultiToken definition. It remains shadow-only until the
 * sealed cohort parity and an independent production cutover authorize it.
 */
export const astraMultiTokenStrictFamilyPlugin = defineProtocolFamily({
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

export {
  astraMultiTokenDiscovery,
  astraMultiTokenExact,
  astraMultiTokenExecution,
  astraMultiTokenFamilyManifest,
  astraMultiTokenFamilyOwnedAction,
  astraMultiTokenIdentity,
  astraMultiTokenInstance,
  astraMultiTokenPricing,
  astraMultiTokenProtocol,
  astraMultiTokenRoutes,
};
export type {
  AstraMultiTokenCandidate,
  AstraMultiTokenDescriptor,
  AstraMultiTokenExactEvidence,
  AstraMultiTokenIdentity,
  AstraMultiTokenPricingDescriptor,
  AstraMultiTokenPricingSnapshot,
  AstraMultiTokenRoute,
} from "./astra-multitoken-family/types.js";
