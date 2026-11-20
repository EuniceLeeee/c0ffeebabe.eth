import { GENERATED_PRODUCTION_FAMILY_ENTRIES } from "../generated/production-family-entries.generated.js";
import { createSqlEdgePriceLogScopes } from "./sql-edge-price-log-scopes.js";
import type {SelectorNativeExecutionDefinition} from "./selector-native-definition.js";

/** Evidence from enabled execution declarations, not names or hard-coded topics. */
export function productionPoolLogScopes() {
  return createSqlEdgePriceLogScopes(GENERATED_PRODUCTION_FAMILY_ENTRIES.map(entry=>entry.module.selectorFamilyModule)
    .filter(f=>f.activation.enabled).map(f=>f.definition)
    .filter((d):d is SelectorNativeExecutionDefinition=>d.domain==="swap"||d.domain==="protocol"));
}
