import { createHash } from "node:crypto";
import { AdapterFamilyRegistry } from "./adapter-family-registry.js";
import {
  PRODUCTION_IDENTITY_ADMISSION,
  type IdentityAdmissionPolicy,
} from "./admission.js";
import { IdentityResolverRegistry } from "./identity.js";
import {
  V2_LINEAGES,
  type V2LineageDescriptor,
} from "./v2-lineage.js";
import {
  VENUE_IDENTITY_CATALOG,
  type VenueIdentityCatalogEntry,
} from "./capability.js";
import type { AdapterFamily } from "./route-leg-adapter.js";
import type {
  LoadedProductionFamilyModule,
  ProductionFamilyLoadIssue,
} from "./production-families/loader.js";
import { strictCatalogUniverseSourceFingerprints } from
  "../strict-universe-source-fingerprints.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG } from
  "./production-family-composition.js";

import {
  createStrictRegistryProjection,
  strictProjectionFingerprint,
} from "./strict-catalog-registry-projection.js";

/**
 * F8: the strict catalog is the sole production authority. The legacy-shaped
 * AdapterFamily projection below carries only bridged metadata and
 * fail-closed runtime surfaces (StrictOnlySurfaceError); every runtime
 * capability is owned by the strict pipeline. The legacy Family closure is
 * deleted; nothing routes, prices, builds or simulates through it.
 */
export const PRODUCTION_FAMILY_MODULES: readonly LoadedProductionFamilyModule[] =
  Object.freeze([]);
export const PRODUCTION_FAMILY_LOAD_ISSUES: readonly ProductionFamilyLoadIssue[] =
  Object.freeze([]);
export const PRODUCTION_FAMILY_SCAN_SHA256 = createHash("sha256")
  .update(JSON.stringify({
    kind: "strict-catalog-registry-projection-v1",
    projectionFingerprint: strictProjectionFingerprint(
      PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
    ),
  }))
  .digest("hex");

/**
 * F8: strict-catalog projection registry. This is a metadata bridge for the
 * remaining legacy-shaped call sites; it is forbidden as a strict lifecycle,
 * descriptor-cache or capability authority. Block-scan schema/cache revisions
 * derive from the strict catalog definition-boundary hashes (F6 Pair F).
 */
export const PRODUCTION_STRICT_PROJECTED_FAMILIES =
  createStrictRegistryProjection(PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG);

export const PRODUCTION_ADAPTER_FAMILIES = new AdapterFamilyRegistry(
  PRODUCTION_STRICT_PROJECTED_FAMILIES,
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

/**
 * F8: legacy identity-policy machinery is removed. Startup admission is
 * strict-only (attestStartupPoolSetsStrict); protocol discovery is catalog
 * driven. These empty registries exist only so remaining legacy-shaped call
 * sites keep their shape; no admission flows through them, and a lookup that
 * reaches them fails closed (no policy for any pool adapter).
 */
export const PRODUCTION_IDENTITY_RESOLVERS = new IdentityResolverRegistry(
  Object.freeze([]),
  () => false,
);

export const PRODUCTION_PROTOCOL_DISCOVERY_IDENTITY_RESOLVERS =
  new IdentityResolverRegistry(
    Object.freeze([]),
    () => false,
  );

const POOL_UNIVERSE_DISCOVERY_CONTRACT_VERSION = 1;

/**
 * Exact production semantics which can change the set admitted from historical
 * landed/factory evidence. The universe artifact persists this set and live
 * startup refuses to inherit its cursor when any item differs.
 */
export function productionPoolUniverseSourceFingerprintsStrict():
  readonly string[] {
  return Object.freeze([
    ...poolUniverseSourceFingerprints({
      landedSourceFingerprints: PRODUCTION_ADAPTER_FAMILIES
        .landedPoolDiscovery()
        .list()
        .map((descriptor) => descriptor.sourceFingerprint),
      admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
      identityCatalog: VENUE_IDENTITY_CATALOG,
      matureDexUniversePoolAdapters:
        PRODUCTION_ADAPTER_FAMILIES.matureDexUniversePoolAdapters(),
      v2Lineages: V2_LINEAGES,
    }),
    ...strictCatalogUniverseSourceFingerprints({
      catalog: PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
    }),
  ]);
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

function identityPolicyFingerprintInput(
  descriptor: import("./identity.js").IdentityResolverDescriptor,
): Record<string, unknown> {
  return {
    poolAdapter: descriptor.poolAdapter,
    policy: descriptor.policy,
    canonicalAddress: descriptor.policy === "trusted-singleton-seed"
      ? descriptor.canonicalAddress?.toLowerCase() ?? null
      : null,
    canonicalVenueId: descriptor.policy === "trusted-singleton-seed"
      ? descriptor.canonicalVenueId ?? null
      : null,
    canonicalIdentitySource: descriptor.policy === "trusted-singleton-seed"
      ? descriptor.canonicalIdentitySource ?? null
      : null,
    registeredVenueIds: [...(descriptor.registeredVenueIds ?? [])].sort(),
    registeredIdentitySources:
      [...(descriptor.registeredIdentitySources ?? [])].sort(),
    legacyReason: descriptor.legacyReason ?? null,
    // This binds direct resolver edits. The explicit discovery-contract
    // version above remains the required bump for shared helper semantics.
    resolverSourceSha256: descriptor.policy === "onchain-resolver"
      ? createHash("sha256")
          .update(Function.prototype.toString.call(descriptor.resolve))
          .digest("hex")
      : null,
  };
}

function fingerprintJson(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}
