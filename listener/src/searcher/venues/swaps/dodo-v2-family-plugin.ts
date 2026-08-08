import { defineSwapFamily } from "../adapter-family-plugin.js";
import { dodoV2FamilyOwnedAction } from "./dodo-v2-family/action.js";
import { dodoV2Discovery } from "./dodo-v2-family/discovery.js";
import { dodoV2Exact } from "./dodo-v2-family/exact.js";
import { dodoV2Execution } from "./dodo-v2-family/execution.js";
import { dodoV2Identity } from "./dodo-v2-family/identity.js";
import { dodoV2Instance } from "./dodo-v2-family/instance.js";
import { dodoV2FamilyManifest } from "./dodo-v2-family/manifest.js";
import { dodoV2Pricing } from "./dodo-v2-family/pricing.js";
import { dodoV2Routes } from "./dodo-v2-family/routes.js";
import { dodoV2Swap } from "./dodo-v2-family/swap.js";

/**
 * Strict S1 DODO V2 definition. It stays shadow-only until cohort parity and
 * production cutover replace the active legacy Family.
 */
export const dodoV2StrictFamilyPlugin = defineSwapFamily({
  manifest: dodoV2FamilyManifest,
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

export {
  dodoV2Discovery,
  dodoV2Exact,
  dodoV2Execution,
  dodoV2FamilyManifest,
  dodoV2FamilyOwnedAction,
  dodoV2Identity,
  dodoV2Instance,
  dodoV2Pricing,
  dodoV2Routes,
  dodoV2Swap,
};
export type {
  DodoV2Candidate,
  DodoV2Descriptor,
  DodoV2ExactEvidence,
  DodoV2Identity,
  DodoV2PricingDescriptor,
  DodoV2PricingSnapshot,
  DodoV2Route,
} from "./dodo-v2-family/types.js";
