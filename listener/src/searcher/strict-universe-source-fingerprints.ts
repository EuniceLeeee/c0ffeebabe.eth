import { createHash } from "node:crypto";
import type { FamilyCapabilityCatalog } from
  "./venues/family-capability-catalog.js";
/**
 * F6 Pair D: strict pool-universe source fingerprints derived from the
 * generated strict catalog instead of the legacy IdentityResolverRegistry.
 * The framework walks catalog-issued plugin declarations only; no per-family
 * switch, table, or fixture exists here. A future domain picks its slots
 * through the same applicability table.
 *
 * The identity/lineage part binds: catalogHash (generated capability
 * identities + definition boundary hashes), each family's owned action
 * adapters, its identity lineage ids, and its discovery source kinds. This
 * is exactly the surface the legacy identity-policies fingerprint covered,
 * re-derived from the strict catalog.
 */
export function strictCatalogUniverseSourceFingerprints(input: {
  readonly catalog: FamilyCapabilityCatalog;
}): readonly string[] {
  const families = input.catalog.listAll()
    .map((module) => {
      const plugin = module.plugin;
      const manifest = plugin.manifest;
      const identity = "identity" in plugin ? plugin.identity : null;
      const discovery = "discovery" in plugin ? plugin.discovery : null;
      return Object.freeze({
        familyId: manifest.familyId,
        definitionBoundaryHash: module.definitionBoundaryHash,
        ownedActionAdapterIds: Object.freeze(
          [...manifest.ownedActionAdapterIds].sort(),
        ),
        lineageIds: Object.freeze(
          [...(identity?.variants ?? [])]
            .map((variant) => variant.lineageId)
            .sort(),
        ),
        discoverySources: Object.freeze(
          [...(discovery?.sources ?? [])].sort(),
        ),
        domain: manifest.domain,
      });
    })
    .sort((left, right) =>
      String(left.familyId).localeCompare(String(right.familyId)),
    );
  return Object.freeze([
    `strict-catalog-universe:v1:${fingerprintJson({
      catalogHash: input.catalog.catalogHash,
      families,
    })}`,
  ]);
}

function fingerprintJson(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}
