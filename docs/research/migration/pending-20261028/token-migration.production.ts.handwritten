import { defineFamilyActivation } from "./activation.js";
import { defineProtocolFamily } from "../adapter-family-plugin.js";
import { manifest } from "../protocols/token-migration-family/manifest.js";
import { discovery } from "../protocols/token-migration-family/discovery.js";
import { identity } from "../protocols/token-migration-family/identity.js";
import { instance } from "../protocols/token-migration-family/instance.js";
import { routes } from "../protocols/token-migration-family/routes.js";
import { pricing } from "../protocols/token-migration-family/pricing.js";
import { exact } from "../protocols/token-migration-family/exact.js";
import { execution } from "../protocols/token-migration-family/execution.js";
import { action } from "../protocols/token-migration-family/action.js";
import { capture } from "../protocols/token-migration-family/capture.js";
import { protocol } from "../protocols/token-migration-family/protocol.js";
export const plugin = defineProtocolFamily({ manifest, discovery, identity, instance, routes, pricing, exact, execution,
  capture, protocol, actionAdapters: [action] });

export const activation = defineFamilyActivation({ enabled: true, envKey: "SEARCHER_FAMILY_TOKEN_MIGRATION_ENABLED" });
