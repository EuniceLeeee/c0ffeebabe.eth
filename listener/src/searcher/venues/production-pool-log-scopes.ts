import { GENERATED_PRODUCTION_FAMILY_ENTRIES } from "../generated/production-family-entries.generated.js";
import { createSqlEdgePriceLogScopes } from "./sql-edge-price-log-scopes.js";
import type { SelectorNativeExecutionDefinition } from "./selector-native-definition.js";

let cachedDefs: readonly SelectorNativeExecutionDefinition[] | undefined;
let cachedScopes: ReturnType<typeof createSqlEdgePriceLogScopes> | undefined;

/** Evidence from enabled execution declarations, not names or hard-coded topics. */
export function productionPoolLogScopes() {
  const defs = GENERATED_PRODUCTION_FAMILY_ENTRIES
    .map(entry => entry.module.selectorFamilyModule)
    .filter(f => f.activation.enabled)
    .map(f => f.definition)
    .filter((d): d is SelectorNativeExecutionDefinition => d.domain === "swap" || d.domain === "protocol");
  if (
    cachedScopes &&
    cachedDefs &&
    cachedDefs.length === defs.length &&
    defs.every((d, i) => d === cachedDefs![i] && Object.isFrozen(d))
  ) {
    return cachedScopes;
  }
  const scopes = createSqlEdgePriceLogScopes(defs);
  if (defs.every(d => Object.isFrozen(d))) {
    cachedDefs = defs;
    cachedScopes = scopes;
  }
  return scopes;
}
