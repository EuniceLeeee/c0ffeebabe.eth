import {
  FAMILY_CAPABILITY_NAMES,
  type FamilyCapabilityCatalog,
  type FamilyCapabilityName,
} from "./venues/family-capability-catalog.js";
import type { FamilyId } from
  "./venues/adapter-family-identifiers.js";
import {
  hashCanonical,
  type CanonicalValue,
} from "./venues/canonical-value.js";
import {
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
} from "./venues/production-family-composition.js";

export const PRODUCTION_FAMILY_STARTUP_MANIFEST_FORMAT =
  "production-family-startup-manifest-v1" as const;

export interface ProductionFamilyStartupEntry {
  readonly familyId: FamilyId;
  readonly sourceFile: string;
  readonly definitionBoundaryHash: string;
  readonly capabilityContentHash: string;
  readonly applicableCapabilities: readonly FamilyCapabilityName[];
  readonly declaredAbsentCapabilities: readonly FamilyCapabilityName[];
}

export interface ProductionFamilyStartupManifest {
  readonly format: typeof PRODUCTION_FAMILY_STARTUP_MANIFEST_FORMAT;
  readonly familyCount: number;
  readonly capabilityCount: number;
  readonly families: readonly ProductionFamilyStartupEntry[];
  readonly manifestHash: string;
}

/**
 * §18.3.1/§18.3.7 startup listing: derives the strict catalog's static
 * source/family/capability closure and fails closed on any legacy module,
 * duplicate family, non-strict plugin, or missing capability hash. The
 * manifest is deterministic and frozen; production startup must log it as
 * evidence of a legacy-free composition root.
 */
export function productionFamilyStartupManifest(
  catalog: FamilyCapabilityCatalog =
    PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
): ProductionFamilyStartupManifest {
  const families = catalog.listAll().map((family) => {
    const familyId = family.plugin.manifest.familyId;
    const capabilityIdentities = FAMILY_CAPABILITY_NAMES.map((capability) => {
      const identity = family.hashes[capability];
      if (identity === undefined || identity.familyId !== familyId) {
        throw new Error(
          `production Family ${familyId} lacks capability hash ${capability}`,
        );
      }
      return identity;
    });
    const applicable = [...FAMILY_CAPABILITY_NAMES].filter((capability) =>
      family.applicableCapabilities.includes(capability)
    );
    const declaredAbsent = [...FAMILY_CAPABILITY_NAMES].filter((capability) =>
      !family.applicableCapabilities.includes(capability)
    );
    return Object.freeze({
      familyId,
      sourceFile: family.sourceFile,
      definitionBoundaryHash: family.definitionBoundaryHash,
      capabilityContentHash: hashCanonical(
        Object.fromEntries(capabilityIdentities.map((identity) => [
          identity.capability,
          identity.contentHash,
        ])) as unknown as CanonicalValue,
      ),
      applicableCapabilities: Object.freeze([...applicable]),
      declaredAbsentCapabilities: Object.freeze([...declaredAbsent]),
    });
  }).sort((left, right) =>
    left.familyId.localeCompare(right.familyId)
  );
  const seen = new Set<string>();
  for (const family of families) {
    if (seen.has(family.familyId)) {
      throw new Error(
        `production startup manifest has duplicate Family ${family.familyId}`,
      );
    }
    seen.add(family.familyId);
  }
  const capabilityCount = families.reduce(
    (total, family) => total + FAMILY_CAPABILITY_NAMES.length,
    0,
  );
  const projection = families.map((family) => ({
    familyId: family.familyId,
    sourceFile: family.sourceFile,
    definitionBoundaryHash: family.definitionBoundaryHash,
    capabilityContentHash: family.capabilityContentHash,
    applicableCapabilities: family.applicableCapabilities,
    declaredAbsentCapabilities: family.declaredAbsentCapabilities,
  }));
  return Object.freeze({
    format: PRODUCTION_FAMILY_STARTUP_MANIFEST_FORMAT,
    familyCount: families.length,
    capabilityCount,
    families: Object.freeze(families),
    manifestHash: hashCanonical(
      projection as unknown as CanonicalValue,
    ),
  });
}
