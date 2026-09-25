import { defineSwapFamily } from "../../adapter-family-plugin.js";
import { mooniswapAction } from "./action.js";
import { mooniswapCapture } from "./capture.js";
import { mooniswapDiscovery } from "./discovery.js";
import { mooniswapExact } from "./exact.js";
import { mooniswapExecution } from "./execution.js";
import { mooniswapIdentity } from "./identity.js";
import { mooniswapInstance } from "./instance.js";
import { mooniswapManifest } from "./manifest.js";
import { mooniswapPricing } from "./pricing.js";
import { mooniswapRoutes } from "./routes.js";
import { mooniswapSwap } from "./swap.js";
import type { MooniswapCandidate, MooniswapIdentity, MooniswapDescriptor, MooniswapRoute, MooniswapSnapshot, MooniswapQuoteEvidence } from "./types.js";

// Prerequisite gate assembly. The production catalog requires direct imports
// in its own entry. Both retain each-block; never remove it to admit this Family.
export function defineMooniswapFamily() {
  return defineSwapFamily<MooniswapCandidate, MooniswapIdentity, MooniswapDescriptor,
    MooniswapRoute, MooniswapDescriptor, MooniswapSnapshot, MooniswapQuoteEvidence>({
    manifest: mooniswapManifest, discovery: mooniswapDiscovery,
    capture: mooniswapCapture, identity: mooniswapIdentity,
    instance: mooniswapInstance, routes: mooniswapRoutes,
    pricing: mooniswapPricing, exact: mooniswapExact,
    execution: mooniswapExecution, swap: mooniswapSwap,
    actionAdapters: [mooniswapAction],
  });
}
