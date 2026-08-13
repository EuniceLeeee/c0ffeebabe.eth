import { defineProtocolFamily } from "../adapter-family-plugin.js";
import { metronomeSynthCapture } from "../protocols/metronome-synth-family/capture.js";
import { metronomeSynthFamilyOwnedAction } from "../protocols/metronome-synth-family/action.js";
import { metronomeSynthDiscovery } from "../protocols/metronome-synth-family/discovery.js";
import { metronomeSynthExact } from "../protocols/metronome-synth-family/exact.js";
import { metronomeSynthExecution } from "../protocols/metronome-synth-family/execution.js";
import { metronomeSynthIdentity } from "../protocols/metronome-synth-family/identity.js";
import { metronomeSynthInstance } from "../protocols/metronome-synth-family/instance.js";
import { metronomeSynthFamilyManifest } from "../protocols/metronome-synth-family/manifest.js";
import { metronomeSynthPricing } from "../protocols/metronome-synth-family/pricing.js";
import { metronomeSynthProtocol } from "../protocols/metronome-synth-family/protocol.js";
import { metronomeSynthRoutes } from "../protocols/metronome-synth-family/routes.js";

export const plugin = defineProtocolFamily({
  manifest: metronomeSynthFamilyManifest,
  capture: metronomeSynthCapture,
  discovery: metronomeSynthDiscovery,
  identity: metronomeSynthIdentity,
  instance: metronomeSynthInstance,
  routes: metronomeSynthRoutes,
  pricing: metronomeSynthPricing,
  exact: metronomeSynthExact,
  execution: metronomeSynthExecution,
  protocol: metronomeSynthProtocol,
  actionAdapters: [metronomeSynthFamilyOwnedAction],
});
