import { defineProtocolFamily } from "../adapter-family-plugin.js";
import {
  wstethUnwrapFamilyOwnedAction,
  wstethWrapFamilyOwnedAction,
} from "./wsteth-family/action.js";
import { wstethDiscovery } from "./wsteth-family/discovery.js";
import { wstethExact } from "./wsteth-family/exact.js";
import { wstethExecution } from "./wsteth-family/execution.js";
import { wstethIdentity } from "./wsteth-family/identity.js";
import { wstethInstance } from "./wsteth-family/instance.js";
import { wstethFamilyManifest } from "./wsteth-family/manifest.js";
import { wstethPricing } from "./wsteth-family/pricing.js";
import { wstethProtocol } from "./wsteth-family/protocol.js";
import { wstethRoutes } from "./wsteth-family/routes.js";

/** Compatibility assembly export; production imports each semantic root. */
export const wstethStrictFamilyPlugin = defineProtocolFamily({
  manifest: wstethFamilyManifest,
  discovery: wstethDiscovery,
  identity: wstethIdentity,
  instance: wstethInstance,
  routes: wstethRoutes,
  pricing: wstethPricing,
  exact: wstethExact,
  execution: wstethExecution,
  protocol: wstethProtocol,
  actionAdapters: [
    wstethWrapFamilyOwnedAction,
    wstethUnwrapFamilyOwnedAction,
  ],
});

export {
  wstethDiscovery,
  wstethExact,
  wstethExecution,
  wstethFamilyManifest,
  wstethIdentity,
  wstethInstance,
  wstethPricing,
  wstethProtocol,
  wstethRoutes,
  wstethUnwrapFamilyOwnedAction,
  wstethWrapFamilyOwnedAction,
};
export type {
  WstethCandidate,
  WstethDescriptor,
  WstethExactEvidence,
  WstethIdentity,
  WstethPricingDescriptor,
  WstethRoute,
} from "./wsteth-family/types.js";
