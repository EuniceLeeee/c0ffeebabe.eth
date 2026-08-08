import { defineProtocolFamily } from "../adapter-family-plugin.js";
import { erc4626SiloRedeemFamilyOwnedAction } from "../protocols/erc4626-silo-redeem-family/action.js";
import { erc4626SiloRedeemDiscovery } from "../protocols/erc4626-silo-redeem-family/discovery.js";
import { erc4626SiloRedeemExact } from "../protocols/erc4626-silo-redeem-family/exact.js";
import { erc4626SiloRedeemExecution } from "../protocols/erc4626-silo-redeem-family/execution.js";
import { erc4626SiloRedeemIdentity } from "../protocols/erc4626-silo-redeem-family/identity.js";
import { erc4626SiloRedeemInstance } from "../protocols/erc4626-silo-redeem-family/instance.js";
import { erc4626SiloRedeemFamilyManifest } from "../protocols/erc4626-silo-redeem-family/manifest.js";
import { erc4626SiloRedeemPricing } from "../protocols/erc4626-silo-redeem-family/pricing.js";
import { erc4626SiloRedeemProtocol } from "../protocols/erc4626-silo-redeem-family/protocol.js";
import { erc4626SiloRedeemRoutes } from "../protocols/erc4626-silo-redeem-family/routes.js";

export const plugin = defineProtocolFamily({
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
