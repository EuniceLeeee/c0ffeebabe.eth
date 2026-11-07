// Generated from Family JSON by build-declarative-production.ts. Do not edit.
// Definition: src/searcher/venues/swaps/precision-pool-family/precision-pool.json
// Regenerate with: npm run family-capability-manifest:generate
import { defineFamilyActivation } from "./activation.js";
import { defineSwapFamily } from "../adapter-family-plugin.js";
import { compileDeclarativeSwap } from "../declarative-swap.js";
import definition from "../swaps/precision-pool-family/precision-pool.json";

export const activation = defineFamilyActivation({"enabled":false,"envKey":"SEARCHER_FAMILY_PRECISION_POOL_ENABLED"});

export const plugin = defineSwapFamily(compileDeclarativeSwap(definition, []));
