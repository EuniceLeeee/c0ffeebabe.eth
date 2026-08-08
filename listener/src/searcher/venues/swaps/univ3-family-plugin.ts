import { defineSwapFamily } from "../adapter-family-plugin.js";
import { univ3FamilyOwnedAction } from "./univ3-family/action.js";
import { univ3Discovery } from "./univ3-family/discovery.js";
import { univ3Exact } from "./univ3-family/exact.js";
import { univ3Execution } from "./univ3-family/execution.js";
import { univ3Identity } from "./univ3-family/identity.js";
import { univ3Instance } from "./univ3-family/instance.js";
import { univ3FamilyManifest } from "./univ3-family/manifest.js";
import { univ3Pricing } from "./univ3-family/pricing.js";
import { univ3Routes } from "./univ3-family/routes.js";
import { univ3Swap } from "./univ3-family/swap.js";
import { univ3VictimReplay } from "./univ3-family/victim.js";

/**
 * Strict S1 UniV3 definition. It remains shadow-only until the cohort parity
 * and production cutover gates replace the legacy active Family.
 */
export const univ3StrictFamilyPlugin = defineSwapFamily({
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

// Named direct roots are retained for capability-content hashing.
export {
  univ3Discovery,
  univ3Exact,
  univ3Execution,
  univ3FamilyManifest,
  univ3FamilyOwnedAction,
  univ3Identity,
  univ3Instance,
  univ3Pricing,
  univ3Routes,
  univ3Swap,
  univ3VictimReplay,
};
export type {
  UniV3Candidate,
  UniV3Descriptor,
  UniV3ExactEvidence,
  UniV3Identity,
  UniV3PricingDescriptor,
  UniV3PricingSnapshot,
  UniV3Route,
} from "./univ3-family/types.js";
