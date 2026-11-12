// Generated from Family JSON by build-declarative-production.ts. Do not edit.
// Definition: src/searcher/venues/swaps/curve-underlying-family/curve-underlying.json
// Regenerate with: npm run family-capability-manifest:generate
import { defineFamilyActivation } from "./activation.js";
import { defineSwapFamily } from "../adapter-family-plugin.js";
import { compileDeclarativeSwap } from "../declarative-swap.js";
import definition from "../swaps/curve-underlying-family/curve-underlying.json";
import child0 from "../swaps/curve-underlying-family/legacy-factory-execution-sim.json";
import child1 from "../swaps/curve-underlying-family/factory-v1-execution-sim.json";
import child2 from "../swaps/curve-underlying-family/lending-execution-sim.json";
import child3 from "../swaps/curve-underlying-family/ng-factory-execution-sim.json";

export const activation = defineFamilyActivation({"enabled":true,"envKey":"SEARCHER_FAMILY_CURVE_UNDERLYING_ENABLED"});

export const plugin = defineSwapFamily(compileDeclarativeSwap(definition, [child0, child1, child2, child3]));
