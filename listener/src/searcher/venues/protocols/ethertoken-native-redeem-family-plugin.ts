import { defineProtocolFamily } from "../adapter-family-plugin.js";
import { etherTokenNativeRedeemFamilyOwnedAction } from "./ethertoken-native-redeem-family/action.js";
import { etherTokenNativeRedeemDiscovery } from "./ethertoken-native-redeem-family/discovery.js";
import { etherTokenNativeRedeemExact } from "./ethertoken-native-redeem-family/exact.js";
import { etherTokenNativeRedeemExecution } from "./ethertoken-native-redeem-family/execution.js";
import { etherTokenNativeRedeemIdentity } from "./ethertoken-native-redeem-family/identity.js";
import { etherTokenNativeRedeemInstance } from "./ethertoken-native-redeem-family/instance.js";
import { etherTokenNativeRedeemFamilyManifest } from "./ethertoken-native-redeem-family/manifest.js";
import { etherTokenNativeRedeemPricing } from "./ethertoken-native-redeem-family/pricing.js";
import { etherTokenNativeRedeemProtocol } from "./ethertoken-native-redeem-family/protocol.js";
import { etherTokenNativeRedeemRoutes } from "./ethertoken-native-redeem-family/routes.js";

export const etherTokenNativeRedeemStrictFamilyPlugin = defineProtocolFamily({
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

export {
  etherTokenNativeRedeemDiscovery,
  etherTokenNativeRedeemExact,
  etherTokenNativeRedeemExecution,
  etherTokenNativeRedeemFamilyManifest,
  etherTokenNativeRedeemFamilyOwnedAction,
  etherTokenNativeRedeemIdentity,
  etherTokenNativeRedeemInstance,
  etherTokenNativeRedeemPricing,
  etherTokenNativeRedeemProtocol,
  etherTokenNativeRedeemRoutes,
};
export type {
  EtherTokenNativeRedeemCandidate,
  EtherTokenNativeRedeemDescriptor,
  EtherTokenNativeRedeemExactEvidence,
  EtherTokenNativeRedeemIdentity,
  EtherTokenNativeRedeemPricingDescriptor,
  EtherTokenNativeRedeemPricingSnapshot,
  EtherTokenNativeRedeemRoute,
} from "./ethertoken-native-redeem-family/types.js";
