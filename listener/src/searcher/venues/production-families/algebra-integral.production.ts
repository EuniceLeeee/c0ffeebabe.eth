// Generated from Family JSON by build-declarative-production.ts. Do not edit.
// Definition: src/searcher/venues/swaps/algebra-integral-family/algebra-integral.json
// Regenerate with: npm run family-capability-manifest:generate
import { defineFamilyActivation } from "./activation.js";
import { defineSwapFamily } from "../adapter-family-plugin.js";
import { compileDeclarativeSwap } from "../declarative-swap.js";
import definition from "../swaps/algebra-integral-family/algebra-integral.json";
import child0 from "../swaps/algebra-integral-family/algebra-dynamic-fee.json";

export const activation = defineFamilyActivation({"enabled":false,"envKey":"SEARCHER_FAMILY_ALGEBRA_INTEGRAL_ENABLED"});

export const plugin = defineSwapFamily(compileDeclarativeSwap(definition, [child0]));
