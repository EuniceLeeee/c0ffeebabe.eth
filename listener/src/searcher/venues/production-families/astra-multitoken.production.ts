// Generated from Family JSON by build-declarative-production.ts. Do not edit.
// Definition: src/searcher/venues/protocols/astra-multitoken-family/astra-multitoken.json
// Regenerate with: npm run family-capability-manifest:generate
import { defineFamilyActivation } from "./activation.js";
import { defineProtocolFamily } from "../adapter-family-plugin.js";
import { compileDeclarativeProtocol } from "../declarative-protocol.js";
import definition from "../protocols/astra-multitoken-family/astra-multitoken.json";

export const activation = defineFamilyActivation({"enabled":true,"envKey":"SEARCHER_FAMILY_ASTRA_MULTITOKEN_ENABLED"});

export const plugin = defineProtocolFamily(compileDeclarativeProtocol(definition, []));
