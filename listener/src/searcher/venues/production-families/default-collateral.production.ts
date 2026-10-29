// Generated from Family JSON by build-declarative-production.ts. Do not edit.
// Definition: src/searcher/venues/protocols/default-collateral-family/default-collateral.json
// Regenerate with: npm run family-capability-manifest:generate
import { defineFamilyActivation } from "./activation.js";
import { defineProtocolFamily } from "../adapter-family-plugin.js";
import { compileDeclarativeProtocol } from "../declarative-protocol.js";
import type { FamilyTypes } from "../../generated/declarative-family-types/default-collateral.generated.js";
import definition from "../protocols/default-collateral-family/default-collateral.json";

export const activation = defineFamilyActivation({"enabled":false,"envKey":"SEARCHER_FAMILY_DEFAULT_COLLATERAL_ENABLED"});

export const plugin = defineProtocolFamily(compileDeclarativeProtocol<FamilyTypes>(definition, []));
