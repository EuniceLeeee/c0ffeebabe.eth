import { defineSwapFamily } from "../adapter-family-plugin.js";
import { univ2Capture } from "../swaps/univ2-family/capture.js";
import { univ2FamilyOwnedAction } from "../swaps/univ2-family/action.js";
import { univ2Discovery } from "../swaps/univ2-family/discovery.js";
import { univ2Exact } from "../swaps/univ2-family/exact.js";
import { univ2Execution } from "../swaps/univ2-family/execution.js";
import { univ2Identity } from "../swaps/univ2-family/identity.js";
import { univ2Instance } from "../swaps/univ2-family/instance.js";
import { univ2FamilyManifest } from "../swaps/univ2-family/manifest.js";
import { univ2Pricing } from "../swaps/univ2-family/pricing.js";
import { univ2Routes } from "../swaps/univ2-family/routes.js";
import { univ2Swap } from "../swaps/univ2-family/swap.js";

export const plugin = defineSwapFamily({
  manifest: univ2FamilyManifest,
  capture: univ2Capture,
  discovery: univ2Discovery,
  identity: univ2Identity,
  instance: univ2Instance,
  routes: univ2Routes,
  pricing: univ2Pricing,
  exact: univ2Exact,
  execution: univ2Execution,
  swap: univ2Swap,
  actionAdapters: [univ2FamilyOwnedAction],
});
