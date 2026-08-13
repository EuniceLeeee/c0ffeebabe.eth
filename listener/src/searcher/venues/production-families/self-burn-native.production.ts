import { defineProtocolFamily } from "../adapter-family-plugin.js";
import { selfBurnNativeCapture } from "../protocols/self-burn-native-family/capture.js";
import { selfBurnNativeFamilyOwnedAction } from "../protocols/self-burn-native-family/action.js";
import { selfBurnNativeDiscovery } from "../protocols/self-burn-native-family/discovery.js";
import { selfBurnNativeExact } from "../protocols/self-burn-native-family/exact.js";
import { selfBurnNativeExecution } from "../protocols/self-burn-native-family/execution.js";
import { selfBurnNativeIdentity } from "../protocols/self-burn-native-family/identity.js";
import { selfBurnNativeInstance } from "../protocols/self-burn-native-family/instance.js";
import { selfBurnNativeFamilyManifest } from "../protocols/self-burn-native-family/manifest.js";
import { selfBurnNativePricing } from "../protocols/self-burn-native-family/pricing.js";
import { selfBurnNativeProtocol } from "../protocols/self-burn-native-family/protocol.js";
import { selfBurnNativeRoutes } from "../protocols/self-burn-native-family/routes.js";

export const plugin = defineProtocolFamily({
  manifest: selfBurnNativeFamilyManifest,
  capture: selfBurnNativeCapture,
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
