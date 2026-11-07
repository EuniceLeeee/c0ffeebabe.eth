import { defineFamilyActivation } from "./activation.js";
import { defineProtocolFamily } from "../adapter-family-plugin.js";
import { stakedUsdatDepositFamilyOwnedAction } from "../protocols/staked-usdat-family/action.js";
import { stakedUsdatCapture } from "../protocols/staked-usdat-family/capture.js";
import { stakedUsdatDiscovery } from "../protocols/staked-usdat-family/discovery.js";
import { stakedUsdatExact } from "../protocols/staked-usdat-family/exact.js";
import { stakedUsdatExecution } from "../protocols/staked-usdat-family/execution.js";
import { stakedUsdatIdentity } from "../protocols/staked-usdat-family/identity.js";
import { stakedUsdatInstance } from "../protocols/staked-usdat-family/instance.js";
import { stakedUsdatFamilyManifest } from "../protocols/staked-usdat-family/manifest.js";
import { stakedUsdatPricing } from "../protocols/staked-usdat-family/pricing.js";
import { stakedUsdatProtocol } from "../protocols/staked-usdat-family/protocol.js";
import { stakedUsdatRoutes } from "../protocols/staked-usdat-family/routes.js";

export const activation = defineFamilyActivation({ enabled: true, envKey: "SEARCHER_FAMILY_STAKED_USDAT_ENABLED" });

export const plugin = defineProtocolFamily({
  manifest: stakedUsdatFamilyManifest,
  capture: stakedUsdatCapture,
  discovery: stakedUsdatDiscovery,
  identity: stakedUsdatIdentity,
  instance: stakedUsdatInstance,
  routes: stakedUsdatRoutes,
  pricing: stakedUsdatPricing,
  exact: stakedUsdatExact,
  execution: stakedUsdatExecution,
  protocol: stakedUsdatProtocol,
  actionAdapters: [stakedUsdatDepositFamilyOwnedAction],
});
