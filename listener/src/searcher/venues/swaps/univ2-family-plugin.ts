import { defineSwapFamily } from "../adapter-family-plugin.js";
import { univ2FamilyOwnedAction } from "./univ2-family/action.js";
import { univ2Discovery } from "./univ2-family/discovery.js";
import { univ2Exact } from "./univ2-family/exact.js";
import { univ2Execution } from "./univ2-family/execution.js";
import { univ2Identity } from "./univ2-family/identity.js";
import { univ2Instance } from "./univ2-family/instance.js";
import { univ2FamilyManifest } from "./univ2-family/manifest.js";
import { univ2Pricing } from "./univ2-family/pricing.js";
import { univ2Routes } from "./univ2-family/routes.js";
import { univ2Swap } from "./univ2-family/swap.js";

/**
 * Strict S1 UniV2 definition. This is intentionally not a production
 * activation module yet; migration parity can exercise it without creating a
 * second active owner for the legacy UniV2 family.
 */
export const univ2StrictFamilyPlugin = defineSwapFamily({
  manifest: univ2FamilyManifest,
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

// Named direct roots are retained for the capability-content hash builder.
export {
  univ2Discovery,
  univ2Exact,
  univ2Execution,
  univ2FamilyManifest,
  univ2FamilyOwnedAction,
  univ2Identity,
  univ2Instance,
  univ2Pricing,
  univ2Routes,
  univ2Swap,
};
export type {
  UniV2Candidate,
  UniV2Descriptor,
  UniV2ExactEvidence,
  UniV2Identity,
  UniV2PricingDescriptor,
  UniV2PricingSnapshot,
  UniV2Route,
} from "./univ2-family/types.js";
