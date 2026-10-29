// Generated from Family JSON by build-declarative-production.ts. Do not edit.
// Definition: src/searcher/venues/protocols/boring-vault-teller-family/boring-vault-teller.json
// Regenerate with: npm run family-capability-manifest:generate
import { defineFamilyActivation } from "./activation.js";
import { defineProtocolFamily } from "../adapter-family-plugin.js";
import { compileDeclarativeProtocol } from "../declarative-protocol.js";
import type { FamilyTypes } from "../../generated/declarative-family-types/boring-vault-teller.generated.js";
import definition from "../protocols/boring-vault-teller-family/boring-vault-teller.json";

export const activation = defineFamilyActivation({"enabled":true,"envKey":"SEARCHER_FAMILY_BORING_VAULT_TELLER_ENABLED"});

export const plugin = defineProtocolFamily(compileDeclarativeProtocol<FamilyTypes>(definition, []));
