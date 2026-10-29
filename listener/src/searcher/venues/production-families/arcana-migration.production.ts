// Generated from Family JSON by build-declarative-production.ts. Do not edit.
// Definition: src/searcher/venues/protocols/arcana-migration-family/arcana-migration.json
// Regenerate with: npm run family-capability-manifest:generate
import { defineFamilyActivation } from "./activation.js";
import { defineProtocolFamily } from "../adapter-family-plugin.js";
import { compileDeclarativeProtocol } from "../declarative-protocol.js";
import type { FamilyTypes } from "../../generated/declarative-family-types/arcana-migration.generated.js";
import definition from "../protocols/arcana-migration-family/arcana-migration.json";

export const activation = defineFamilyActivation({"enabled":true,"envKey":"SEARCHER_FAMILY_ARCANA_MIGRATION_ENABLED"});

export const plugin = defineProtocolFamily(compileDeclarativeProtocol<FamilyTypes>(definition, []));
