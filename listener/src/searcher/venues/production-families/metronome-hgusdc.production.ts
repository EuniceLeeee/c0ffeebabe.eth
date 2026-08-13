import { defineProtocolFamily } from "../adapter-family-plugin.js";
import { metronomeHgUsdcCapture } from "../protocols/metronome-hgusdc-family/capture.js";
import { metronomeHgUsdcFamilyOwnedAction } from "../protocols/metronome-hgusdc-family/action.js";
import { metronomeHgUsdcDiscovery } from "../protocols/metronome-hgusdc-family/discovery.js";
import { metronomeHgUsdcExact } from "../protocols/metronome-hgusdc-family/exact.js";
import { metronomeHgUsdcExecution } from "../protocols/metronome-hgusdc-family/execution.js";
import { metronomeHgUsdcIdentity } from "../protocols/metronome-hgusdc-family/identity.js";
import { metronomeHgUsdcInstance } from "../protocols/metronome-hgusdc-family/instance.js";
import { metronomeHgUsdcFamilyManifest } from "../protocols/metronome-hgusdc-family/manifest.js";
import { metronomeHgUsdcPricing } from "../protocols/metronome-hgusdc-family/pricing.js";
import { metronomeHgUsdcProtocol } from "../protocols/metronome-hgusdc-family/protocol.js";
import { metronomeHgUsdcRoutes } from "../protocols/metronome-hgusdc-family/routes.js";

export const plugin = defineProtocolFamily({
  manifest: metronomeHgUsdcFamilyManifest,
  capture: metronomeHgUsdcCapture,
  discovery: metronomeHgUsdcDiscovery,
  identity: metronomeHgUsdcIdentity,
  instance: metronomeHgUsdcInstance,
  routes: metronomeHgUsdcRoutes,
  pricing: metronomeHgUsdcPricing,
  exact: metronomeHgUsdcExact,
  execution: metronomeHgUsdcExecution,
  protocol: metronomeHgUsdcProtocol,
  actionAdapters: [metronomeHgUsdcFamilyOwnedAction],
});
