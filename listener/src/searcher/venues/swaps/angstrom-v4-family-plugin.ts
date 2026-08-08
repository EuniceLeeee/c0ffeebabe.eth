import { defineSwapFamily } from "../adapter-family-plugin.js";
import { angstromV4FamilyOwnedAction } from "./angstrom-v4-family/action.js";
import { angstromV4Discovery } from "./angstrom-v4-family/discovery.js";
import { angstromV4Exact } from "./angstrom-v4-family/exact.js";
import { angstromV4Execution } from "./angstrom-v4-family/execution.js";
import { angstromV4Identity } from "./angstrom-v4-family/identity.js";
import { angstromV4Instance } from "./angstrom-v4-family/instance.js";
import { angstromV4FamilyManifest } from "./angstrom-v4-family/manifest.js";
import { angstromV4Pricing } from "./angstrom-v4-family/pricing.js";
import { angstromV4Routes } from "./angstrom-v4-family/routes.js";
import { angstromV4Swap } from "./angstrom-v4-family/swap.js";
import { angstromV4VictimReplay } from "./angstrom-v4-family/victim.js";

/** Strict shadow-only S1 Angstrom V4 Family. */
export const angstromV4StrictFamilyPlugin = defineSwapFamily({
  manifest: angstromV4FamilyManifest,
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

export {
  angstromV4Discovery,
  angstromV4Exact,
  angstromV4Execution,
  angstromV4FamilyManifest,
  angstromV4FamilyOwnedAction,
  angstromV4Identity,
  angstromV4Instance,
  angstromV4Pricing,
  angstromV4Routes,
  angstromV4Swap,
  angstromV4VictimReplay,
};
export type {
  AngstromV4Candidate,
  AngstromV4Descriptor,
  AngstromV4ExactEvidence,
  AngstromV4Identity,
  AngstromV4PricingDescriptor,
  AngstromV4PricingSnapshot,
  AngstromV4Route,
} from "./angstrom-v4-family/types.js";
