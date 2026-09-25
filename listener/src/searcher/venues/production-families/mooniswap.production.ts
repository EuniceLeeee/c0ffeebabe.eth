import { defineFamilyActivation } from "./activation.js";
import { defineSwapFamily } from "../adapter-family-plugin.js";
import { mooniswapAction } from "../swaps/mooniswap-family/action.js";
import { mooniswapCapture } from "../swaps/mooniswap-family/capture.js";
import { mooniswapDiscovery } from "../swaps/mooniswap-family/discovery.js";
import { mooniswapExact } from "../swaps/mooniswap-family/exact.js";
import { mooniswapExecution } from "../swaps/mooniswap-family/execution.js";
import { mooniswapIdentity } from "../swaps/mooniswap-family/identity.js";
import { mooniswapInstance } from "../swaps/mooniswap-family/instance.js";
import { mooniswapManifest } from "../swaps/mooniswap-family/manifest.js";
import { mooniswapPricing } from "../swaps/mooniswap-family/pricing.js";
import { mooniswapRoutes } from "../swaps/mooniswap-family/routes.js";
import { mooniswapSwap } from "../swaps/mooniswap-family/swap.js";
import type { MooniswapCandidate, MooniswapIdentity, MooniswapDescriptor, MooniswapRoute, MooniswapSnapshot, MooniswapQuoteEvidence } from "../swaps/mooniswap-family/types.js";

export const plugin = defineSwapFamily<MooniswapCandidate, MooniswapIdentity, MooniswapDescriptor,
  MooniswapRoute, MooniswapDescriptor, MooniswapSnapshot, MooniswapQuoteEvidence>({
  manifest: mooniswapManifest, discovery: mooniswapDiscovery, capture: mooniswapCapture,
  identity: mooniswapIdentity, instance: mooniswapInstance, routes: mooniswapRoutes,
  pricing: mooniswapPricing, exact: mooniswapExact, execution: mooniswapExecution,
  swap: mooniswapSwap, actionAdapters: [mooniswapAction],
});

export const activation = defineFamilyActivation({ enabled: true, envKey: "SEARCHER_FAMILY_MOONISWAP_ENABLED" });
