import { defineCreditFamily } from "../adapter-family-plugin.js";
import { fluidCreditCapture } from "../credit/fluid-family/capture.js";
import {
  fluidCreditLiquidateAction,
  fluidCreditVaultAction,
} from "../credit/fluid-family/action.js";
import { fluidCreditDomain } from "../credit/fluid-family/credit.js";
import { fluidCreditDiscovery } from "../credit/fluid-family/discovery.js";
import { fluidCreditExecution } from "../credit/fluid-family/execution.js";
import { fluidCreditIdentity } from "../credit/fluid-family/identity.js";
import { fluidCreditInstance } from "../credit/fluid-family/instance.js";
import { fluidCreditFamilyManifest } from "../credit/fluid-family/manifest.js";
import { fluidCreditRoutes } from "../credit/fluid-family/routes.js";

export const plugin = defineCreditFamily({
  manifest: fluidCreditFamilyManifest,
  capture: fluidCreditCapture,
  discovery: fluidCreditDiscovery,
  identity: fluidCreditIdentity,
  instance: fluidCreditInstance,
  routes: fluidCreditRoutes,
  execution: fluidCreditExecution,
  credit: fluidCreditDomain,
  actionAdapters: [fluidCreditVaultAction, fluidCreditLiquidateAction],
});
