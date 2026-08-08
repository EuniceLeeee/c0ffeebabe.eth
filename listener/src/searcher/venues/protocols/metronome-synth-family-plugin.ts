import { defineProtocolFamily } from "../adapter-family-plugin.js";
import { metronomeSynthFamilyOwnedAction } from "./metronome-synth-family/action.js";
import { metronomeSynthDiscovery } from "./metronome-synth-family/discovery.js";
import { metronomeSynthExact } from "./metronome-synth-family/exact.js";
import { metronomeSynthExecution } from "./metronome-synth-family/execution.js";
import { metronomeSynthIdentity } from "./metronome-synth-family/identity.js";
import { metronomeSynthInstance } from "./metronome-synth-family/instance.js";
import { metronomeSynthFamilyManifest } from "./metronome-synth-family/manifest.js";
import { metronomeSynthPricing } from "./metronome-synth-family/pricing.js";
import { metronomeSynthProtocol } from "./metronome-synth-family/protocol.js";
import { metronomeSynthRoutes } from "./metronome-synth-family/routes.js";

export const metronomeSynthStrictFamilyPlugin = defineProtocolFamily({
  manifest: metronomeSynthFamilyManifest,
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

export {
  metronomeSynthDiscovery,
  metronomeSynthExact,
  metronomeSynthExecution,
  metronomeSynthFamilyManifest,
  metronomeSynthFamilyOwnedAction,
  metronomeSynthIdentity,
  metronomeSynthInstance,
  metronomeSynthPricing,
  metronomeSynthProtocol,
  metronomeSynthRoutes,
};
export type {
  MetronomeSynthCandidate,
  MetronomeSynthDescriptor,
  MetronomeSynthExactEvidence,
  MetronomeSynthIdentity,
  MetronomeSynthPricingDescriptor,
  MetronomeSynthPricingSnapshot,
  MetronomeSynthRoute,
} from "./metronome-synth-family/types.js";
