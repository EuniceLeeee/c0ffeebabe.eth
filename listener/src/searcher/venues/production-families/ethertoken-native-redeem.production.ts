import { defineProtocolFamily } from "../adapter-family-plugin.js";
import { etherTokenNativeRedeemFamilyOwnedAction } from "../protocols/ethertoken-native-redeem-family/action.js";
import { etherTokenNativeRedeemDiscovery } from "../protocols/ethertoken-native-redeem-family/discovery.js";
import { etherTokenNativeRedeemExact } from "../protocols/ethertoken-native-redeem-family/exact.js";
import { etherTokenNativeRedeemExecution } from "../protocols/ethertoken-native-redeem-family/execution.js";
import { etherTokenNativeRedeemIdentity } from "../protocols/ethertoken-native-redeem-family/identity.js";
import { etherTokenNativeRedeemInstance } from "../protocols/ethertoken-native-redeem-family/instance.js";
import { etherTokenNativeRedeemFamilyManifest } from "../protocols/ethertoken-native-redeem-family/manifest.js";
import { etherTokenNativeRedeemPricing } from "../protocols/ethertoken-native-redeem-family/pricing.js";
import { etherTokenNativeRedeemProtocol } from "../protocols/ethertoken-native-redeem-family/protocol.js";
import { etherTokenNativeRedeemRoutes } from "../protocols/ethertoken-native-redeem-family/routes.js";

export const plugin = defineProtocolFamily({
  manifest: etherTokenNativeRedeemFamilyManifest,
  discovery: etherTokenNativeRedeemDiscovery,
  identity: etherTokenNativeRedeemIdentity,
  instance: etherTokenNativeRedeemInstance,
  routes: etherTokenNativeRedeemRoutes,
  pricing: etherTokenNativeRedeemPricing,
  exact: etherTokenNativeRedeemExact,
  execution: etherTokenNativeRedeemExecution,
  protocol: etherTokenNativeRedeemProtocol,
  actionAdapters: [etherTokenNativeRedeemFamilyOwnedAction],
});
