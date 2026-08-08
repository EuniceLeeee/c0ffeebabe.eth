import { defineProtocolFamily } from "../adapter-family-plugin.js";
import { selfBurnNativeFamilyOwnedAction } from "./self-burn-native-family/action.js";
import { selfBurnNativeDiscovery } from "./self-burn-native-family/discovery.js";
import { selfBurnNativeExact } from "./self-burn-native-family/exact.js";
import { selfBurnNativeExecution } from "./self-burn-native-family/execution.js";
import { selfBurnNativeIdentity } from "./self-burn-native-family/identity.js";
import { selfBurnNativeInstance } from "./self-burn-native-family/instance.js";
import { selfBurnNativeFamilyManifest } from "./self-burn-native-family/manifest.js";
import { selfBurnNativePricing } from "./self-burn-native-family/pricing.js";
import { selfBurnNativeProtocol } from "./self-burn-native-family/protocol.js";
import { selfBurnNativeRoutes } from "./self-burn-native-family/routes.js";

export const selfBurnNativeStrictFamilyPlugin = defineProtocolFamily({
  manifest: selfBurnNativeFamilyManifest,
  discovery: selfBurnNativeDiscovery,
  identity: selfBurnNativeIdentity,
  instance: selfBurnNativeInstance,
  routes: selfBurnNativeRoutes,
  pricing: selfBurnNativePricing,
  exact: selfBurnNativeExact,
  execution: selfBurnNativeExecution,
  protocol: selfBurnNativeProtocol,
  actionAdapters: [selfBurnNativeFamilyOwnedAction],
});

export {
  selfBurnNativeDiscovery,
  selfBurnNativeExact,
  selfBurnNativeExecution,
  selfBurnNativeFamilyManifest,
  selfBurnNativeFamilyOwnedAction,
  selfBurnNativeIdentity,
  selfBurnNativeInstance,
  selfBurnNativePricing,
  selfBurnNativeProtocol,
  selfBurnNativeRoutes,
};
export type {
  SelfBurnNativeCandidate,
  SelfBurnNativeDescriptor,
  SelfBurnNativeExactEvidence,
  SelfBurnNativeIdentity,
  SelfBurnNativePricingDescriptor,
  SelfBurnNativePricingSnapshot,
  SelfBurnNativeRoute,
} from "./self-burn-native-family/types.js";
