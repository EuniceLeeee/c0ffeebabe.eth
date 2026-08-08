import { defineSwapFamily } from "../adapter-family-plugin.js";
import { univ4FamilyOwnedActions } from "./univ4-family/action.js";
import { univ4Discovery } from "./univ4-family/discovery.js";
import { univ4Exact } from "./univ4-family/exact.js";
import { univ4Execution } from "./univ4-family/execution.js";
import { univ4Identity } from "./univ4-family/identity.js";
import { univ4Instance } from "./univ4-family/instance.js";
import { univ4FamilyManifest } from "./univ4-family/manifest.js";
import { univ4Pricing } from "./univ4-family/pricing.js";
import { univ4Routes } from "./univ4-family/routes.js";
import { univ4Swap } from "./univ4-family/swap.js";
import { univ4VictimReplay } from "./univ4-family/victim.js";

/** Strict shadow-only S1 UniV4 Family. */
export const univ4StrictFamilyPlugin = defineSwapFamily({
  manifest: univ4FamilyManifest,
  discovery: univ4Discovery,
  identity: univ4Identity,
  instance: univ4Instance,
  routes: univ4Routes,
  pricing: univ4Pricing,
  exact: univ4Exact,
  execution: univ4Execution,
  swap: univ4Swap,
  actionAdapters: univ4FamilyOwnedActions,
});

export {
  univ4Discovery,
  univ4Exact,
  univ4Execution,
  univ4FamilyManifest,
  univ4FamilyOwnedActions,
  univ4Identity,
  univ4Instance,
  univ4Pricing,
  univ4Routes,
  univ4Swap,
  univ4VictimReplay,
};
export type {
  UniV4Candidate,
  UniV4Descriptor,
  UniV4ExactEvidence,
  UniV4Identity,
  UniV4PricingDescriptor,
  UniV4PricingSnapshot,
  UniV4Route,
} from "./univ4-family/types.js";
