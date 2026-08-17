import { AdapterFamilyRegistry } from
  "../venues/adapter-family-registry.js";
import { IdentityResolverRegistry } from "../venues/identity.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG } from
  "../venues/production-family-composition.js";
import { createStrictRegistryProjection } from
  "../venues/strict-catalog-registry-projection.js";
import type {
  LoadedProductionFamilyModule,
  ProductionFamilyLoadIssue,
} from "../venues/production-families/loader.js";

/**
 * Test-only compatibility projection for historical fixture suites. It is not
 * imported by production, performs no discovery/admission/publication, and is
 * deliberately excluded from acceptance evidence. New contracts must target
 * the strict catalog/declarations/runtime directly.
 */
export const STRICT_PROJECTED_FAMILY_TEST_REGISTRY =
  new AdapterFamilyRegistry(
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

export const STRICT_EMPTY_POOL_IDENTITY_TEST_REGISTRY =
  new IdentityResolverRegistry(Object.freeze([]), () => false);

export const STRICT_EMPTY_PROTOCOL_IDENTITY_TEST_REGISTRY =
  new IdentityResolverRegistry(Object.freeze([]), () => false);

export const STRICT_PROJECTED_FAMILY_TEST_MODULES:
  readonly LoadedProductionFamilyModule[] = Object.freeze([]);
export const STRICT_PROJECTED_FAMILY_TEST_LOAD_ISSUES:
  readonly ProductionFamilyLoadIssue[] = Object.freeze([]);
