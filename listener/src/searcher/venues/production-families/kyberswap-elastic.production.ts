// Generated from Family JSON by build-declarative-production.ts. Do not edit.
// Definition: src/searcher/venues/swaps/kyberswap-elastic-family/kyberswap-elastic.json
// Regenerate with: npm run family-capability-manifest:generate
import { defineFamilyActivation } from "./activation.js";
import { defineSwapFamily } from "../adapter-family-plugin.js";
import { compileDeclarativeSwap } from "../declarative-swap.js";
import definition from "../swaps/kyberswap-elastic-family/kyberswap-elastic.json";

export const activation = defineFamilyActivation({"enabled":false,"envKey":"SEARCHER_FAMILY_KYBERSWAP_ELASTIC_ENABLED"});

export const plugin = defineSwapFamily(compileDeclarativeSwap(definition, []));
