// Generated from Family JSON by build-declarative-production.ts. Do not edit.
// Definition: src/searcher/venues/protocols/metafactory-family/metafactory.json
// Regenerate with: npm run family-capability-manifest:generate
import { defineFamilyActivation } from "./activation.js";
import { defineProtocolFamily } from "../adapter-family-plugin.js";
import { compileDeclarativeProtocol } from "../declarative-protocol.js";
import definition from "../protocols/metafactory-family/metafactory.json";

export const activation = defineFamilyActivation({"enabled":false,"envKey":"SEARCHER_FAMILY_METAFACTORY_ENABLED"});

export const plugin = defineProtocolFamily(compileDeclarativeProtocol(definition, []));
