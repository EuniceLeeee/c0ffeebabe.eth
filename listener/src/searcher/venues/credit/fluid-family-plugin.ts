import { defineCreditFamily } from "../adapter-family-plugin.js";
import {
  fluidCreditLiquidateAction,
  fluidCreditVaultAction,
} from "./fluid-family/action.js";
import { fluidCreditDomain } from "./fluid-family/credit.js";
import { fluidCreditDiscovery } from "./fluid-family/discovery.js";
import { fluidCreditExecution } from "./fluid-family/execution.js";
import { fluidCreditIdentity } from "./fluid-family/identity.js";
import { fluidCreditInstance } from "./fluid-family/instance.js";
import { fluidCreditFamilyManifest } from "./fluid-family/manifest.js";
import { fluidCreditRoutes } from "./fluid-family/routes.js";
import { fluidCreditPricing } from "./fluid-family/pricing.js";
import { fluidCreditExact } from "./fluid-family/exact.js";

/** Strict S1 Credit-domain shadow definition; not a fake Swap/Protocol route. */
export const fluidCreditStrictFamilyPlugin = defineCreditFamily({
  manifest: fluidCreditFamilyManifest,
  discovery: fluidCreditDiscovery,
  identity: fluidCreditIdentity,
  instance: fluidCreditInstance,
  routes: fluidCreditRoutes,
  pricing: fluidCreditPricing,
  exact: fluidCreditExact,
  execution: fluidCreditExecution,
  credit: fluidCreditDomain,
  actionAdapters: [fluidCreditVaultAction, fluidCreditLiquidateAction],
});

export {
  fluidCreditDiscovery,
  fluidCreditDomain,
  fluidCreditExecution,
  fluidCreditFamilyManifest,
  fluidCreditIdentity,
  fluidCreditInstance,
  fluidCreditLiquidateAction,
  fluidCreditRoutes,
  fluidCreditPricing,
  fluidCreditExact,
  fluidCreditVaultAction,
};
export type {
  FluidCreditCandidate,
  FluidCreditDescriptor,
  FluidCreditExactEvidence,
  FluidCreditIdentity,
  FluidCreditRiskEvidence,
  FluidCreditRoute,
} from "./fluid-family/types.js";
