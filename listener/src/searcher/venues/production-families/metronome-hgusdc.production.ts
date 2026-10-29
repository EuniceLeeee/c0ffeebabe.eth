// Generated from Family JSON by build-declarative-production.ts. Do not edit.
// Definition: src/searcher/venues/protocols/metronome-hgusdc-family/metronome-hgusdc.json
// Regenerate with: npm run family-capability-manifest:generate
import { defineFamilyActivation } from "./activation.js";
import { defineProtocolFamily } from "../adapter-family-plugin.js";
import { compileDeclarativeProtocol } from "../declarative-protocol.js";
import definition from "../protocols/metronome-hgusdc-family/metronome-hgusdc.json";

export const activation = defineFamilyActivation({"enabled":true,"envKey":"SEARCHER_FAMILY_METRONOME_HGUSDC_ENABLED"});

export const plugin = defineProtocolFamily(compileDeclarativeProtocol(definition, []));
