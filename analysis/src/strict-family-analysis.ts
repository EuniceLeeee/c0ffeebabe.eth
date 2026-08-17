import { AdapterFamilyRegistry } from
  "../../listener/src/searcher/venues/adapter-family-registry.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG } from
  "../../listener/src/searcher/venues/production-family-composition.js";
import { createStrictRegistryProjection } from
  "../../listener/src/searcher/venues/strict-catalog-registry-projection.js";

/**
 * Read-only analysis projection generated from the strict catalog. It cannot
 * discover, admit, publish, price, plan, or execute and is never imported by
 * the listener runtime.
 */
export const STRICT_FAMILY_ANALYSIS_REGISTRY = new AdapterFamilyRegistry(
  createStrictRegistryProjection(
    PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
  ),
  {
    definitionBoundaryHashFor: (familyId) => {
      try {
        return PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG
          .forStrictFamily(familyId as never)
          .definitionBoundaryHash;
      } catch {
        return null;
      }
    },
  },
  { strictProjected: true },
);
