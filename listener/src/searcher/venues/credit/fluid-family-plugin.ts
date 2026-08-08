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

/** Strict S1 Credit-domain shadow definition; not a fake Swap/Protocol route. */
export const fluidCreditStrictFamilyPlugin = defineCreditFamily({
  manifest: fluidCreditFamilyManifest,
  discovery: fluidCreditDiscovery,
  identity: fluidCreditIdentity,
  instance: fluidCreditInstance,
  routes: fluidCreditRoutes,
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
  fluidCreditVaultAction,
};
export type {
  FluidCreditCandidate,
  FluidCreditDescriptor,
  FluidCreditIdentity,
  FluidCreditRiskEvidence,
  FluidCreditRoute,
} from "./fluid-family/types.js";
