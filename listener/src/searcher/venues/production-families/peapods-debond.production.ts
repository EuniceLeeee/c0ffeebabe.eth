// Generated from Family JSON by build-declarative-production.ts. Do not edit.
// Definition: src/searcher/venues/protocols/peapods-debond-family/peapods-debond.json
// Regenerate with: npm run family-capability-manifest:generate
import { defineFamilyActivation } from "./activation.js";
import { defineProtocolFamily } from "../adapter-family-plugin.js";
import { compileDeclarativeProtocol } from "../declarative-protocol.js";
import definition from "../protocols/peapods-debond-family/peapods-debond.json";

export const activation = defineFamilyActivation({"enabled":false,"envKey":"SEARCHER_FAMILY_PEAPODS_DEBOND_ENABLED"});

export const plugin = defineProtocolFamily(compileDeclarativeProtocol(definition, []));
