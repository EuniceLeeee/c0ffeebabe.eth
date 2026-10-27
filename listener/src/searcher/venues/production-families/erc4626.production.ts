// Generated from Family JSON by build-declarative-production.ts. Do not edit.
// Definition: src/searcher/venues/protocols/erc4626-family/erc4626.json
// Regenerate with: npm run family-capability-manifest:generate
import { defineFamilyActivation } from "./activation.js";
import { defineProtocolFamily } from "../adapter-family-plugin.js";
import { erc4626Capture as binding_capture } from "../protocols/erc4626-family/capture.js";
import { erc4626Discovery as binding_discovery } from "../protocols/erc4626-family/discovery.js";
import { erc4626Exact as binding_exact } from "../protocols/erc4626-family/exact.js";
import { erc4626Execution as binding_execution } from "../protocols/erc4626-family/execution.js";
import { erc4626Identity as binding_identity } from "../protocols/erc4626-family/identity.js";
import { erc4626Instance as binding_instance } from "../protocols/erc4626-family/instance.js";
import { erc4626FamilyManifest as binding_manifest } from "../protocols/erc4626-family/manifest.js";
import { erc4626Pricing as binding_pricing } from "../protocols/erc4626-family/pricing.js";
import { erc4626Protocol as binding_protocol } from "../protocols/erc4626-family/protocol.js";
import { erc4626Routes as binding_routes } from "../protocols/erc4626-family/routes.js";
import { erc4626DepositFamilyOwnedAction as action0 } from "../protocols/erc4626-family/action.js";
import { erc4626RedeemFamilyOwnedAction as action1 } from "../protocols/erc4626-family/action.js";

export const activation = defineFamilyActivation({"enabled":true,"envKey":"SEARCHER_FAMILY_ERC4626_ENABLED"});

export const plugin = defineProtocolFamily({
  capture: binding_capture,
  discovery: binding_discovery,
  exact: binding_exact,
  execution: binding_execution,
  identity: binding_identity,
  instance: binding_instance,
  manifest: binding_manifest,
  pricing: binding_pricing,
  protocol: binding_protocol,
  routes: binding_routes,
  actionAdapters: [action0, action1],
});
