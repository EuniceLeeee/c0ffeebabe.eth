// Generated from Family JSON by build-declarative-production.ts. Do not edit.
// Definition: src/searcher/venues/swaps/univ2-family/univ2.json
// Regenerate with: npm run family-capability-manifest:generate
import { defineFamilyActivation } from "./activation.js";
import { defineSwapFamily } from "../adapter-family-plugin.js";
import { compileDeclarativeSwap } from "../declarative-swap.js";
import definition from "../swaps/univ2-family/univ2.json";
import child0 from "../swaps/univ2-family/pool-get-amount-out.json";

export const activation = defineFamilyActivation({"enabled":true,"envKey":"SEARCHER_FAMILY_UNIV2_STANDARD_ENABLED"});

export const plugin = defineSwapFamily(compileDeclarativeSwap(definition, [child0]));
