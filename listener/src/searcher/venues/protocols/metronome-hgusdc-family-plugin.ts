import { defineProtocolFamily } from "../adapter-family-plugin.js";
import { metronomeHgUsdcFamilyOwnedAction } from "./metronome-hgusdc-family/action.js";
import { metronomeHgUsdcDiscovery } from "./metronome-hgusdc-family/discovery.js";
import { metronomeHgUsdcExact } from "./metronome-hgusdc-family/exact.js";
import { metronomeHgUsdcExecution } from "./metronome-hgusdc-family/execution.js";
import { metronomeHgUsdcIdentity } from "./metronome-hgusdc-family/identity.js";
import { metronomeHgUsdcInstance } from "./metronome-hgusdc-family/instance.js";
import { metronomeHgUsdcFamilyManifest } from "./metronome-hgusdc-family/manifest.js";
import { metronomeHgUsdcPricing } from "./metronome-hgusdc-family/pricing.js";
import { metronomeHgUsdcProtocol } from "./metronome-hgusdc-family/protocol.js";
import { metronomeHgUsdcRoutes } from "./metronome-hgusdc-family/routes.js";

export const metronomeHgUsdcStrictFamilyPlugin = defineProtocolFamily({
  manifest: metronomeHgUsdcFamilyManifest,
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

export {
  metronomeHgUsdcDiscovery,
  metronomeHgUsdcExact,
  metronomeHgUsdcExecution,
  metronomeHgUsdcFamilyManifest,
  metronomeHgUsdcFamilyOwnedAction,
  metronomeHgUsdcIdentity,
  metronomeHgUsdcInstance,
  metronomeHgUsdcPricing,
  metronomeHgUsdcProtocol,
  metronomeHgUsdcRoutes,
};
export type {
  MetronomeHgUsdcCandidate,
  MetronomeHgUsdcDescriptor,
  MetronomeHgUsdcExactEvidence,
  MetronomeHgUsdcIdentity,
  MetronomeHgUsdcPricingDescriptor,
  MetronomeHgUsdcPricingSnapshot,
  MetronomeHgUsdcRoute,
} from "./metronome-hgusdc-family/types.js";
