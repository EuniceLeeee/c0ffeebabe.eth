// Generated from Family JSON by build-declarative-production.ts. Do not edit.
// Definition: src/searcher/venues/swaps/ella-exchange-family/ella-exchange.json
// Regenerate with: npm run family-capability-manifest:generate
import { defineFamilyActivation } from "./activation.js";
import { defineSwapFamily } from "../adapter-family-plugin.js";
import { compileDeclarativeSwap } from "../declarative-swap.js";
import definition from "../swaps/ella-exchange-family/ella-exchange.json";

export const activation = defineFamilyActivation({"enabled":true,"envKey":"SEARCHER_FAMILY_ELLA_EXCHANGE_ENABLED"});

export const plugin = defineSwapFamily(compileDeclarativeSwap(definition, []));
