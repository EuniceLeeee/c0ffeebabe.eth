import { defineFamilyActivation } from "./activation.js";
import { defineSwapFamily } from "../adapter-family-plugin.js";
import { ekuboAction } from "../swaps/ekubo-family/action.js";
import { ekuboCapture } from "../swaps/ekubo-family/capture.js";
import { ekuboDiscovery } from "../swaps/ekubo-family/discovery.js";
import { ekuboExact } from "../swaps/ekubo-family/exact.js";
import { ekuboExecution } from "../swaps/ekubo-family/execution.js";
import { ekuboIdentity } from "../swaps/ekubo-family/identity.js";
import { ekuboInstance } from "../swaps/ekubo-family/instance.js";
import { ekuboManifest } from "../swaps/ekubo-family/manifest.js";
import { ekuboPricing } from "../swaps/ekubo-family/pricing.js";
import { ekuboRoutes } from "../swaps/ekubo-family/routes.js";
import { ekuboSwap } from "../swaps/ekubo-family/swap.js";

export const activation = defineFamilyActivation({ enabled: false, envKey: "SEARCHER_FAMILY_EKUBO_ENABLED" });

export const plugin = defineSwapFamily({ manifest: ekuboManifest, discovery: ekuboDiscovery,
  identity: ekuboIdentity, instance: ekuboInstance, routes: ekuboRoutes, pricing: ekuboPricing,
  exact: ekuboExact, execution: ekuboExecution, capture: ekuboCapture, swap: ekuboSwap,
  actionAdapters: [ekuboAction] });
