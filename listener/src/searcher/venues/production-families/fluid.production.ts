// Generated from Family JSON by build-declarative-production.ts. Do not edit.
// Definition: src/searcher/venues/credit/fluid-family/fluid.json
// Regenerate with: npm run family-capability-manifest:generate
import { defineFamilyActivation } from "./activation.js";
import { defineCreditFamily } from "../adapter-family-plugin.js";
import { compileDeclarativeCredit } from "../declarative-credit.js";
import definition from "../credit/fluid-family/fluid.json";

export const activation = defineFamilyActivation({"enabled":true,"envKey":"SEARCHER_FAMILY_FLUID_CREDIT_ENABLED"});

export const plugin = defineCreditFamily(compileDeclarativeCredit(definition, []));
