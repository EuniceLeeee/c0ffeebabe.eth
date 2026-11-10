// Generated from Family JSON by build-declarative-production.ts. Do not edit.
// Definition: src/searcher/venues/swaps/dodo-v2-family/dodo-v2.json
// Regenerate with: npm run family-capability-manifest:generate
import { defineFamilyActivation } from "./activation.js";
import { defineSwapFamily } from "../adapter-family-plugin.js";
import { compileDeclarativeSwap } from "../declarative-swap.js";
import definition from "../swaps/dodo-v2-family/dodo-v2.json";
import child0 from "../swaps/dodo-v2-family/registry-member-1.json";
import child1 from "../swaps/dodo-v2-family/registry-member-2.json";
import child2 from "../swaps/dodo-v2-family/registry-member-3.json";

export const activation = defineFamilyActivation({"enabled":true,"envKey":"SEARCHER_FAMILY_DODO_V2_ENABLED"});

export const plugin = defineSwapFamily(compileDeclarativeSwap(definition, [child0, child1, child2]));
