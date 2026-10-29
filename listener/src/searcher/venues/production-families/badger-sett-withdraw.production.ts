// Generated from Family JSON by build-declarative-production.ts. Do not edit.
// Definition: src/searcher/venues/protocols/badger-sett-withdraw-family/badger-sett-withdraw.json
// Regenerate with: npm run family-capability-manifest:generate
import { defineFamilyActivation } from "./activation.js";
import { defineProtocolFamily } from "../adapter-family-plugin.js";
import { compileDeclarativeProtocol } from "../declarative-protocol.js";
import type { FamilyTypes } from "../../generated/declarative-family-types/badger-sett-withdraw.generated.js";
import definition from "../protocols/badger-sett-withdraw-family/badger-sett-withdraw.json";

export const activation = defineFamilyActivation({"enabled":true,"envKey":"SEARCHER_FAMILY_BADGER_SETT_WITHDRAW_ENABLED"});

export const plugin = defineProtocolFamily(compileDeclarativeProtocol<FamilyTypes>(definition, []));
