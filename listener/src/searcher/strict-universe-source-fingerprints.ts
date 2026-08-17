import { createHash } from "node:crypto";
import {
  PRODUCTION_IDENTITY_ADMISSION,
  type IdentityAdmissionPolicy,
} from "./venues/admission.js";
import {
  VENUE_IDENTITY_CATALOG,
  type VenueIdentityCatalogEntry,
} from "./venues/capability.js";
import type { FamilyCapabilityCatalog } from
  "./venues/family-capability-catalog.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG } from
  "./venues/production-family-composition.js";
import {
  V2_LINEAGES,
  type V2LineageDescriptor,
} from "./venues/v2-lineage.js";

const POOL_UNIVERSE_DISCOVERY_CONTRACT_VERSION = 1;
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

export function productionPoolUniverseSourceFingerprintsStrict():
  readonly string[] {
  const catalog = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG;
  const swapPoolAdapters = catalog.listAll()
    .filter((loaded) => loaded.plugin.manifest.domain === "swap")
    .flatMap((loaded) => [...(loaded.plugin.manifest.poolAdapterIds ?? [])]);
  return poolUniverseSourceFingerprints({
    landedSourceFingerprints: strictCatalogUniverseSourceFingerprints({
      catalog,
    }),
    admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
    identityCatalog: VENUE_IDENTITY_CATALOG,
    matureDexUniversePoolAdapters: swapPoolAdapters,
    v2Lineages: V2_LINEAGES,
  });
}

export function poolUniverseSourceFingerprints(input: {
  readonly landedSourceFingerprints: readonly string[];
  readonly admissionPolicy: IdentityAdmissionPolicy;
  readonly identityCatalog: readonly VenueIdentityCatalogEntry[];
  readonly matureDexUniversePoolAdapters: readonly string[];
  readonly v2Lineages: readonly V2LineageDescriptor[];
}): readonly string[] {
  const fingerprints = [
    ...input.landedSourceFingerprints,
    `pool-universe-discovery-contract:v${POOL_UNIVERSE_DISCOVERY_CONTRACT_VERSION}`,
    `identity-admission:${fingerprintJson({
      unknownFactory: input.admissionPolicy.unknownFactory,
      unregisteredCurveUnderlying:
        input.admissionPolicy.unregisteredCurveUnderlying,
    })}`,
    `identity-catalog:${fingerprintJson(
      input.identityCatalog.map((entry) => ({
        venue: entry.venue,
        compatibility: entry.compatibility,
        poolAdapter:
          entry.compatibility === "standard" ? entry.poolAdapter : null,
        discovery: entry.discovery.mode === "factory"
          ? {
              mode: "factory",
              factories: entry.discovery.factories
                .map((address) => address.toLowerCase())
                .sort(),
            }
          : {
              mode: "pool-registry",
              registries: entry.discovery.registries
                .map((address) => address.toLowerCase())
                .sort(),
            },
      })),
    )}`,
    `mature-dex-pool-adapters:${fingerprintJson(
      [...new Set(input.matureDexUniversePoolAdapters)].sort(),
    )}`,
    `v2-lineages:${fingerprintJson(
      [...input.v2Lineages]
        .map((lineage) => ({
          venue: lineage.venue,
          factory: lineage.factory.toLowerCase(),
          executionFamily: lineage.executionFamily,
          measuredFeeRule: lineage.measuredFeeRule === null
            ? null
            : {
                kind: lineage.measuredFeeRule.kind,
                feeBps: lineage.measuredFeeRule.feeBps.toString(),
                evidence: lineage.measuredFeeRule.evidence,
              },
        }))
        .sort((a, b) => a.factory.localeCompare(b.factory)),
    )}`,
  ];
  return Object.freeze([...new Set(fingerprints)].sort());
}

function fingerprintJson(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}
