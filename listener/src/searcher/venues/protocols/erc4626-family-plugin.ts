import { defineProtocolFamily } from "../adapter-family-plugin.js";
import {
  erc4626DepositFamilyOwnedAction,
  erc4626RedeemFamilyOwnedAction,
} from "./erc4626-family/action.js";
import { erc4626Discovery } from "./erc4626-family/discovery.js";
import { erc4626Exact } from "./erc4626-family/exact.js";
import { erc4626Execution } from "./erc4626-family/execution.js";
import { erc4626Identity } from "./erc4626-family/identity.js";
import { erc4626Instance } from "./erc4626-family/instance.js";
import { erc4626FamilyManifest } from "./erc4626-family/manifest.js";
import { erc4626Pricing } from "./erc4626-family/pricing.js";
import { erc4626Protocol } from "./erc4626-family/protocol.js";
import { erc4626Routes } from "./erc4626-family/routes.js";

/** Shadow-compatible assembly; production imports each semantic root directly. */
export const erc4626StrictFamilyPlugin = defineProtocolFamily({
  manifest: erc4626FamilyManifest,
  discovery: erc4626Discovery,
  identity: erc4626Identity,
  instance: erc4626Instance,
  routes: erc4626Routes,
  pricing: erc4626Pricing,
  exact: erc4626Exact,
  execution: erc4626Execution,
  protocol: erc4626Protocol,
  actionAdapters: [
    erc4626DepositFamilyOwnedAction,
    erc4626RedeemFamilyOwnedAction,
  ],
});
