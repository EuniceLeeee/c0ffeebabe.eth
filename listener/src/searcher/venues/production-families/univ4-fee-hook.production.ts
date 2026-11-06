// Generated from Family JSON by build-declarative-production.ts. Do not edit.
// Definition: src/searcher/venues/swaps/univ4-fee-hook-family/univ4-fee-hook.json
// Regenerate with: npm run family-capability-manifest:generate
import { defineFamilyActivation } from "./activation.js";
import { defineSwapFamily } from "../adapter-family-plugin.js";
import { compileDeclarativeSwap } from "../declarative-swap.js";
import definition from "../swaps/univ4-fee-hook-family/univ4-fee-hook.json";
import child0 from "../swaps/univ4-fee-hook-family/sat1.json";

export const activation = defineFamilyActivation({"enabled":true,"envKey":"SEARCHER_FAMILY_UNIV4_FEE_HOOK_ENABLED"});

export const plugin = defineSwapFamily(compileDeclarativeSwap(definition, [child0]));
