// Generated from Family JSON by build-declarative-production.ts. Do not edit.
// Definition: src/searcher/venues/swaps/balancer-v1-family/balancer-v1.json
// Regenerate with: npm run family-capability-manifest:generate
import { defineFamilyActivation } from "./activation.js";
import { defineSwapFamily } from "../adapter-family-plugin.js";
import { compileDeclarativeSwap } from "../declarative-swap.js";
import definition from "../swaps/balancer-v1-family/balancer-v1.json";
import child0 from "../swaps/balancer-v1-family/crpt-bpool.json";

export const activation = defineFamilyActivation({"enabled":true,"envKey":"SEARCHER_FAMILY_BALANCER_V1_ENABLED"});

export const plugin = defineSwapFamily(compileDeclarativeSwap(definition, [child0]));
