// Generated from Family JSON by build-declarative-production.ts. Do not edit.
// Definition: src/searcher/venues/swaps/curve-plain-family/curve-plain.json
// Regenerate with: npm run family-capability-manifest:generate
import { defineFamilyActivation } from "./activation.js";
import { defineSwapFamily } from "../adapter-family-plugin.js";
import { compileDeclarativeSwap } from "../declarative-swap.js";
import definition from "../swaps/curve-plain-family/curve-plain.json";
import child0 from "../swaps/curve-plain-family/clone-execution-sim.json";

export const activation = defineFamilyActivation({"enabled":true,"envKey":"SEARCHER_FAMILY_CURVE_PLAIN_ENABLED"});

export const plugin = defineSwapFamily(compileDeclarativeSwap(definition, [child0]));
