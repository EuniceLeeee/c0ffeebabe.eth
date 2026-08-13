import { defineProtocolFamily } from "../adapter-family-plugin.js";
import { wstethCapture } from "../protocols/wsteth-family/capture.js";
import {
  wstethUnwrapFamilyOwnedAction,
  wstethWrapFamilyOwnedAction,
} from "../protocols/wsteth-family/action.js";
import { wstethDiscovery } from "../protocols/wsteth-family/discovery.js";
import { wstethExact } from "../protocols/wsteth-family/exact.js";
import { wstethExecution } from "../protocols/wsteth-family/execution.js";
import { wstethIdentity } from "../protocols/wsteth-family/identity.js";
import { wstethInstance } from "../protocols/wsteth-family/instance.js";
import { wstethFamilyManifest } from "../protocols/wsteth-family/manifest.js";
import { wstethPricing } from "../protocols/wsteth-family/pricing.js";
import { wstethProtocol } from "../protocols/wsteth-family/protocol.js";
import { wstethRoutes } from "../protocols/wsteth-family/routes.js";

export const plugin = defineProtocolFamily({
  manifest: wstethFamilyManifest,
  capture: wstethCapture,
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
