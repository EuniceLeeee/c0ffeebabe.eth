import { defineSwapFamily } from "../adapter-family-plugin.js";
import { angstromV4Capture } from "../swaps/angstrom-v4-family/capture.js";
import { angstromV4FamilyOwnedAction } from "../swaps/angstrom-v4-family/action.js";
import { angstromV4Discovery } from "../swaps/angstrom-v4-family/discovery.js";
import { angstromV4Exact } from "../swaps/angstrom-v4-family/exact.js";
import { angstromV4Execution } from "../swaps/angstrom-v4-family/execution.js";
import { angstromV4Identity } from "../swaps/angstrom-v4-family/identity.js";
import { angstromV4Instance } from "../swaps/angstrom-v4-family/instance.js";
import { angstromV4FamilyManifest } from "../swaps/angstrom-v4-family/manifest.js";
import { angstromV4Pricing } from "../swaps/angstrom-v4-family/pricing.js";
import { angstromV4Routes } from "../swaps/angstrom-v4-family/routes.js";
import { angstromV4Swap } from "../swaps/angstrom-v4-family/swap.js";

export const plugin = defineSwapFamily({
  manifest: angstromV4FamilyManifest,
  capture: angstromV4Capture,
  discovery: angstromV4Discovery,
  identity: angstromV4Identity,
  instance: angstromV4Instance,
  routes: angstromV4Routes,
  pricing: angstromV4Pricing,
  exact: angstromV4Exact,
  execution: angstromV4Execution,
  swap: angstromV4Swap,
  actionAdapters: [angstromV4FamilyOwnedAction],
});
