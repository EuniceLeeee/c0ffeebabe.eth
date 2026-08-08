import { defineProtocolFamily } from "../adapter-family-plugin.js";
import { erc4626SiloRedeemFamilyOwnedAction } from "./erc4626-silo-redeem-family/action.js";
import { erc4626SiloRedeemDiscovery } from "./erc4626-silo-redeem-family/discovery.js";
import { erc4626SiloRedeemExact } from "./erc4626-silo-redeem-family/exact.js";
import { erc4626SiloRedeemExecution } from "./erc4626-silo-redeem-family/execution.js";
import { erc4626SiloRedeemIdentity } from "./erc4626-silo-redeem-family/identity.js";
import { erc4626SiloRedeemInstance } from "./erc4626-silo-redeem-family/instance.js";
import { erc4626SiloRedeemFamilyManifest } from "./erc4626-silo-redeem-family/manifest.js";
import { erc4626SiloRedeemPricing } from "./erc4626-silo-redeem-family/pricing.js";
import { erc4626SiloRedeemProtocol } from "./erc4626-silo-redeem-family/protocol.js";
import { erc4626SiloRedeemRoutes } from "./erc4626-silo-redeem-family/routes.js";

export const erc4626SiloRedeemStrictFamilyPlugin = defineProtocolFamily({
  manifest: erc4626SiloRedeemFamilyManifest,
  discovery: erc4626SiloRedeemDiscovery,
  identity: erc4626SiloRedeemIdentity,
  instance: erc4626SiloRedeemInstance,
  routes: erc4626SiloRedeemRoutes,
  pricing: erc4626SiloRedeemPricing,
  exact: erc4626SiloRedeemExact,
  execution: erc4626SiloRedeemExecution,
  protocol: erc4626SiloRedeemProtocol,
  actionAdapters: [erc4626SiloRedeemFamilyOwnedAction],
});

export {
  erc4626SiloRedeemDiscovery,
  erc4626SiloRedeemExact,
  erc4626SiloRedeemExecution,
  erc4626SiloRedeemFamilyManifest,
  erc4626SiloRedeemFamilyOwnedAction,
  erc4626SiloRedeemIdentity,
  erc4626SiloRedeemInstance,
  erc4626SiloRedeemPricing,
  erc4626SiloRedeemProtocol,
  erc4626SiloRedeemRoutes,
};
export type {
  Erc4626SiloRedeemCandidate,
  Erc4626SiloRedeemDescriptor,
  Erc4626SiloRedeemExactEvidence,
  Erc4626SiloRedeemIdentity,
  Erc4626SiloRedeemPricingDescriptor,
  Erc4626SiloRedeemPricingSnapshot,
  Erc4626SiloRedeemRoute,
} from "./erc4626-silo-redeem-family/types.js";
