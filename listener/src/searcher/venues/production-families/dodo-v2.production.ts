import { defineSwapFamily } from "../adapter-family-plugin.js";
import { dodoV2Capture } from "../swaps/dodo-v2-family/capture.js";
import { dodoV2FamilyOwnedAction } from "../swaps/dodo-v2-family/action.js";
import { dodoV2Discovery } from "../swaps/dodo-v2-family/discovery.js";
import { dodoV2Exact } from "../swaps/dodo-v2-family/exact.js";
import { dodoV2Execution } from "../swaps/dodo-v2-family/execution.js";
import { dodoV2Identity } from "../swaps/dodo-v2-family/identity.js";
import { dodoV2Instance } from "../swaps/dodo-v2-family/instance.js";
import { dodoV2FamilyManifest } from "../swaps/dodo-v2-family/manifest.js";
import { dodoV2Pricing } from "../swaps/dodo-v2-family/pricing.js";
import { dodoV2Routes } from "../swaps/dodo-v2-family/routes.js";
import { dodoV2Swap } from "../swaps/dodo-v2-family/swap.js";

export const plugin = defineSwapFamily({
  manifest: dodoV2FamilyManifest,
  capture: dodoV2Capture,
  discovery: dodoV2Discovery,
  identity: dodoV2Identity,
  instance: dodoV2Instance,
  routes: dodoV2Routes,
  pricing: dodoV2Pricing,
  exact: dodoV2Exact,
  execution: dodoV2Execution,
  swap: dodoV2Swap,
  actionAdapters: [dodoV2FamilyOwnedAction],
});
