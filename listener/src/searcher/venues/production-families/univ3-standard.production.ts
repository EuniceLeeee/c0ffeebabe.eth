import { defineSwapFamily } from "../adapter-family-plugin.js";
import { univ3FamilyOwnedAction } from "../swaps/univ3-family/action.js";
import { univ3Discovery } from "../swaps/univ3-family/discovery.js";
import { univ3Exact } from "../swaps/univ3-family/exact.js";
import { univ3Execution } from "../swaps/univ3-family/execution.js";
import { univ3Identity } from "../swaps/univ3-family/identity.js";
import { univ3Instance } from "../swaps/univ3-family/instance.js";
import { univ3FamilyManifest } from "../swaps/univ3-family/manifest.js";
import { univ3Pricing } from "../swaps/univ3-family/pricing.js";
import { univ3Routes } from "../swaps/univ3-family/routes.js";
import { univ3Swap } from "../swaps/univ3-family/swap.js";

export const plugin = defineSwapFamily({
  manifest: univ3FamilyManifest,
  discovery: univ3Discovery,
  identity: univ3Identity,
  instance: univ3Instance,
  routes: univ3Routes,
  pricing: univ3Pricing,
  exact: univ3Exact,
  execution: univ3Execution,
  swap: univ3Swap,
  actionAdapters: [univ3FamilyOwnedAction],
});
