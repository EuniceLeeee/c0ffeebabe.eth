import { defineFamilyActivation } from "./activation.js";
import { defineSwapFamily } from "../adapter-family-plugin.js";
import { curvePlainReceivedAction, curvePlainNoReceiverAction, curvePlainRegularAction, curvePlainUintReceivedAction, curvePlainUintExchangeAction } from "../swaps/curve-plain-family/action.js";
import { curvePlainCapture } from "../swaps/curve-plain-family/capture.js";
import { curvePlainDiscovery } from "../swaps/curve-plain-family/discovery.js";
import { curvePlainExact } from "../swaps/curve-plain-family/exact.js";
import { curvePlainExecution } from "../swaps/curve-plain-family/execution.js";
import { curvePlainIdentity } from "../swaps/curve-plain-family/identity.js";
import { curvePlainInstance } from "../swaps/curve-plain-family/instance.js";
import { curvePlainManifest } from "../swaps/curve-plain-family/manifest.js";
import { curvePlainPricing } from "../swaps/curve-plain-family/pricing.js";
import { curvePlainRoutes } from "../swaps/curve-plain-family/routes.js";
import { curvePlainSwap } from "../swaps/curve-plain-family/swap.js";
export const activation = defineFamilyActivation({ enabled: true, envKey: "SEARCHER_FAMILY_CURVE_PLAIN_ENABLED" });

export const plugin = defineSwapFamily({ manifest: curvePlainManifest, capture: curvePlainCapture,
  discovery: curvePlainDiscovery, identity: curvePlainIdentity, instance: curvePlainInstance,
  routes: curvePlainRoutes, pricing: curvePlainPricing, exact: curvePlainExact,
  execution: curvePlainExecution, swap: curvePlainSwap,
  actionAdapters: [curvePlainReceivedAction, curvePlainNoReceiverAction, curvePlainRegularAction, curvePlainUintReceivedAction, curvePlainUintExchangeAction] });
