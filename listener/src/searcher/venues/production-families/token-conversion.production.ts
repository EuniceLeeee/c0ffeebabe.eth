// Generated from Family JSON by build-declarative-production.ts. Do not edit.
// Definition: src/searcher/venues/protocols/token-conversion-family/token-conversion.json
// Regenerate with: npm run family-capability-manifest:generate
import { defineFamilyActivation } from "./activation.js";
import { defineProtocolFamily } from "../adapter-family-plugin.js";
import { compileDeclarativeProtocol } from "../declarative-protocol.js";
import definition from "../protocols/token-conversion-family/token-conversion.json";
import child0 from "../protocols/token-conversion-family/xwin-allocations-v1.json";

export const activation = defineFamilyActivation({"enabled":true,"envKey":"SEARCHER_FAMILY_TOKEN_CONVERSION_ENABLED"});

export const plugin = defineProtocolFamily(compileDeclarativeProtocol(definition, [child0]));
