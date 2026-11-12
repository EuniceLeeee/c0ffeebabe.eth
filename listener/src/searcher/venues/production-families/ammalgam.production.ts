// Generated from Family JSON by build-declarative-production.ts. Do not edit.
// Definition: src/searcher/venues/swaps/ammalgam-family/ammalgam.json
// Regenerate with: npm run family-capability-manifest:generate
import { defineFamilyActivation } from "./activation.js";
import { defineSwapFamily } from "../adapter-family-plugin.js";
import { capture as binding_capture } from "../swaps/ammalgam-family/capture.js";
import { discovery as binding_discovery } from "../swaps/ammalgam-family/discovery.js";
import { exact as binding_exact } from "../swaps/ammalgam-family/exact.js";
import { execution as binding_execution } from "../swaps/ammalgam-family/execution.js";
import { identity as binding_identity } from "../swaps/ammalgam-family/identity.js";
import { instance as binding_instance } from "../swaps/ammalgam-family/instance.js";
import { manifest as binding_manifest } from "../swaps/ammalgam-family/manifest.js";
import { pricing as binding_pricing } from "../swaps/ammalgam-family/pricing.js";
import { routes as binding_routes } from "../swaps/ammalgam-family/routes.js";
import { swap as binding_swap } from "../swaps/ammalgam-family/swap.js";
import { action as action0 } from "../swaps/ammalgam-family/action.js";

export const activation = defineFamilyActivation({"enabled":true,"envKey":"SEARCHER_FAMILY_AMMALGAM_ENABLED"});

export const plugin = defineSwapFamily({
  capture: binding_capture,
  discovery: binding_discovery,
  exact: binding_exact,
  execution: binding_execution,
  identity: binding_identity,
  instance: binding_instance,
  manifest: binding_manifest,
  pricing: binding_pricing,
  routes: binding_routes,
  swap: binding_swap,
  actionAdapters: [action0],
});
