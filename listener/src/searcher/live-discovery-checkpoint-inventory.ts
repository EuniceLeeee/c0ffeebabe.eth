import type {
  AdapterFamilyDiscoveryCheckpointCandidateWatermark,
  AdapterFamilyDiscoveryCheckpointInventoryCandidateFamily,
} from "./adapter-family-discovery-checkpoint.js";
import { discoveryFamilySourceKey } from
  "./discovery-source-watermark.js";
import type { LiveDiscoveryPublicationState } from
  "./live-discovery-publication.js";
import type { CanonicalSource } from
  "./venues/adapter-request-program.js";
import type { FamilyId } from
  "./venues/adapter-family-identifiers.js";
import type { UnifiedObservation } from
  "./venues/adapter-family-plugin.js";
import type { FamilyCapabilityCatalog } from
  "./venues/family-capability-catalog.js";
import type { DiscoverySourceKind } from
  "./venues/adapter-family-plugin.js";

const EVENT_SOURCE_IDS: ReadonlySet<string> = new Set([
  "factory-log",
  "landed-log",
  "observed-call",
]);
const ZERO_WORD = `0x${"0".repeat(64)}`;

/**
 * Resolve a legacy discovery adapter id (or an already-strict family id) to
 * the strict Family that owns it. Verified protocol candidates and address
 * cache entries are keyed by legacy adapter ids such as
 * `protocol:erc4626`, which equal the strict family ids; family-owned
 * action adapters (for example `fluid-dex`) resolve through the catalog.
 * Returns null when neither path owns the id.
 */
export function resolveStrictFamilyIdForAdapter(
  catalog: FamilyCapabilityCatalog,
  adapterId: string,
): FamilyId | null {
  try {
    return catalog.forStrictFamily(adapterId as FamilyId)
      .plugin.manifest.familyId;
  } catch {
    try {
      return catalog.ownerOfAction(adapterId);
    } catch {
      return null;
    }
  }
}

function addressSurfaceFromVerifiedEvidence(
  evidence: readonly unknown[] | undefined,
): {
  readonly codeHash: string;
  readonly implementationWord: string;
} {
  let codeHash = ZERO_WORD;
  let implementationWord = ZERO_WORD;
  for (const raw of evidence ?? []) {
    if (typeof raw !== "object" || raw === null) continue;
    const item = raw as Record<string, unknown>;
    if (
      typeof item.codeHash === "string" &&
      /^0x[0-9a-fA-F]{64}$/.test(item.codeHash)
    ) {
      codeHash = item.codeHash.toLowerCase();
    }
    if (
      typeof item.implementationWord === "string" &&
      /^0x[0-9a-fA-F]{64}$/.test(item.implementationWord)
    ) {
      implementationWord = item.implementationWord.toLowerCase();
    }
  }
  return Object.freeze({ codeHash, implementationWord });
}

/**
 * Derives a durable checkpoint inventory revision from the current live
 * discovery publication. Honest scope: address-surface incumbents are built
 * from the protocol evidence cache (code hash / implementation word /
 * checked-at block); factory-log and activity families currently yield
 * empty rows because the live publication retains only projections, not the
 * creation-log or call/log evidence those surfaces require. Watermarks
 * claim contiguous event coverage only where the publication's coverage
 * anchors reach the current source; anything else stays append-only.
 */
export function deriveLiveDiscoveryCheckpointInventory(input: {
  readonly publication: LiveDiscoveryPublicationState;
  readonly source: CanonicalSource;
  readonly catalog: FamilyCapabilityCatalog;
  readonly familyIdForAdapter: (adapterId: string) => FamilyId | null;
}): {
  readonly watermarks:
    readonly AdapterFamilyDiscoveryCheckpointCandidateWatermark[];
  readonly inventoryFamilies:
    readonly AdapterFamilyDiscoveryCheckpointInventoryCandidateFamily[];
} {
  const discoveryFamilies: {
    readonly familyId: FamilyId;
    readonly sources: readonly DiscoverySourceKind[];
    readonly surfaceEligible: boolean;
  }[] = [];
  for (const family of input.catalog.listAll()) {
    if (!("discovery" in family.plugin)) continue;
    const discovery = family.plugin.discovery;
    discoveryFamilies.push(Object.freeze({
      familyId: family.plugin.manifest.familyId,
      sources: discovery.sources,
      surfaceEligible:
        discovery.sources.includes("address-surface") &&
        (discovery.addressSurfaces?.length ?? 0) > 0,
    }));
  }
  const sourceAnchor = Object.freeze({
    completeThroughBlock: input.source.number,
    completeThroughHash: input.source.hash,
  });
  const eventCovered = (familyId: FamilyId, sourceId: string): boolean => {
    const protocol = input.publication.protocolFamilySourceCoverage.get(
      discoveryFamilySourceKey(familyId, sourceId),
    );
    if (protocol !== undefined) {
      return protocol.completeThroughBlock >= input.source.number;
    }
    return (
      input.publication.dexSourceAnchor.completeThroughBlock >=
        input.source.number ||
      input.publication.protocolObservedCursor.completeThroughBlock >=
        input.source.number
    );
  };
  const byFamily = new Map<string, {
    readonly familyId: FamilyId;
    readonly surfaceEligible: boolean;
    readonly incumbents: {
      readonly inventoryKey: string;
      readonly address: string;
      readonly currentSurface: UnifiedObservation &
        { readonly kind: "address-surface" };
    }[];
  }>();
  const interfaceFingerprintsFor = (
    familyId: FamilyId,
  ): readonly string[] | undefined => {
    const family = input.catalog.forStrictFamily(familyId);
    if (!("discovery" in family.plugin)) return undefined;
    return family.plugin.discovery.addressSurfaces?.filter(
      (pattern) => pattern.kind === "interface",
    ).map((pattern) => pattern.fingerprint);
  };
  for (const family of discoveryFamilies) {
    byFamily.set(family.familyId, {
      familyId: family.familyId,
      surfaceEligible: family.surfaceEligible,
      incumbents: [],
    });
  }
  for (const [address, entry] of input.publication.protocolEvidenceCache
    .addressEntries) {
    if (entry.candidate === null) continue;
    const familyId = input.familyIdForAdapter(entry.adapterId);
    if (familyId === null) continue;
    const family = byFamily.get(familyId);
    if (family === undefined || !family.surfaceEligible) continue;
    const interfaceFingerprints = interfaceFingerprintsFor(familyId);
    family.incumbents.push(Object.freeze({
      inventoryKey: address.toLowerCase(),
      address: address.toLowerCase(),
      currentSurface: Object.freeze({
        kind: "address-surface" as const,
        source: input.source,
        address: address.toLowerCase(),
        codeHash: entry.codeHash.toLowerCase(),
        implementationWord: entry.implementationWord.toLowerCase(),
        ...(interfaceFingerprints === undefined ||
            interfaceFingerprints.length === 0
          ? {}
          : { interfaceFingerprints: Object.freeze(interfaceFingerprints) }),
      }),
    }));
  }
  const seenVerifiedInventoryAddresses = new Set<string>();
  for (const { adapterId, candidate } of input.publication.protocolEvidenceCache
    .verifiedCandidates.values()) {
    let address: string;
    try {
      address = candidate.pool.address.toLowerCase();
    } catch {
      continue;
    }
    const familyId = input.familyIdForAdapter(adapterId);
    if (familyId === null) continue;
    const family = byFamily.get(familyId);
    if (family === undefined || !family.surfaceEligible) continue;
    const dedupeKey = `${familyId}\0${address}`;
    if (seenVerifiedInventoryAddresses.has(dedupeKey)) continue;
    seenVerifiedInventoryAddresses.add(dedupeKey);
    const surface = addressSurfaceFromVerifiedEvidence(candidate.evidence);
    const interfaceFingerprints = interfaceFingerprintsFor(familyId);
    family.incumbents.push(Object.freeze({
      inventoryKey: address,
      address,
      currentSurface: Object.freeze({
        kind: "address-surface" as const,
        source: input.source,
        address,
        codeHash: surface.codeHash,
        implementationWord: surface.implementationWord,
        ...(interfaceFingerprints === undefined ||
            interfaceFingerprints.length === 0
          ? {}
          : { interfaceFingerprints: Object.freeze(interfaceFingerprints) }),
      }),
    }));
  }
  const watermarks = Object.freeze(discoveryFamilies.flatMap((family) => {
    return family.sources.map((sourceId) => {
      const event = EVENT_SOURCE_IDS.has(sourceId);
      const covered = event && eventCovered(family.familyId, sourceId);
      return Object.freeze({
        familyId: family.familyId,
        sourceId,
        coverageAuthority: covered
          ? "contiguous-history" as const
          : "append-only" as const,
        completeThroughBlock: covered
          ? sourceAnchor.completeThroughBlock
          : -1,
        completeThroughHash: covered
          ? sourceAnchor.completeThroughHash
          : null,
      });
    });
  }));
  const inventoryFamilies = Object.freeze(
    [...byFamily.values()].sort((left, right) =>
      left.familyId.localeCompare(right.familyId)
    ).map((family) => Object.freeze({
      familyId: family.familyId,
      incumbents: Object.freeze(family.incumbents.sort((left, right) =>
        left.inventoryKey.localeCompare(right.inventoryKey)
      )),
    })),
  );
  return Object.freeze({ watermarks, inventoryFamilies });
}

/**
 * Pipeline step 4 feed: derive address-surface UnifiedObservations per
 * strict Family from the live protocol evidence cache (code hash /
 * implementation word / checked-at block), for address-surface eligible
 * families only. Families without observations yield no entries; the
 * caller feeds these into runStrictFamilyLifecycle and then the live
 * publisher.
 */
export function deriveLiveDiscoveryAddressSurfaceObservations(input: {
  readonly publication: LiveDiscoveryPublicationState;
  readonly source: CanonicalSource;
  readonly catalog: FamilyCapabilityCatalog;
  readonly familyIdForAdapter: (adapterId: string) => FamilyId | null;
}): ReadonlyMap<FamilyId, readonly UnifiedObservation[]> {
  const eligible = new Set<FamilyId>();
  for (const family of input.catalog.listAll()) {
    if (!("discovery" in family.plugin)) continue;
    if (
      family.plugin.discovery.sources.includes("address-surface") &&
      (family.plugin.discovery.addressSurfaces?.length ?? 0) > 0
    ) {
      eligible.add(family.plugin.manifest.familyId);
    }
  }
  const byFamily = new Map<FamilyId, UnifiedObservation[]>();
  for (const [address, entry] of input.publication.protocolEvidenceCache
    .addressEntries) {
    if (entry.candidate === null) continue;
    const familyId = input.familyIdForAdapter(entry.adapterId);
    if (familyId === null || !eligible.has(familyId)) continue;
    const family = input.catalog.forStrictFamily(familyId);
    const interfaceFingerprints = "discovery" in family.plugin
      ? family.plugin.discovery.addressSurfaces?.filter(
          (pattern) => pattern.kind === "interface",
        ).map((pattern) => pattern.fingerprint)
      : undefined;
    const observation: UnifiedObservation = Object.freeze({
      kind: "address-surface",
      source: input.source,
      address: address.toLowerCase(),
      codeHash: entry.codeHash.toLowerCase(),
      implementationWord: entry.implementationWord.toLowerCase(),
      ...(interfaceFingerprints === undefined ||
          interfaceFingerprints.length === 0
        ? {}
        : { interfaceFingerprints: Object.freeze(interfaceFingerprints) }),
    });
    const existing = byFamily.get(familyId);
    if (existing === undefined) {
      byFamily.set(familyId, [observation]);
    } else {
      existing.push(observation);
    }
  }
  // Verified protocol candidates are retained nominations from the legacy
  // discovery pipeline. Re-enter them as current-source address-surface
  // observations so the strict lifecycle re-verifies and publishes the same
  // instances instead of silently dropping production-known protocols.
  const seenVerifiedAddresses = new Set<string>();
  for (const { adapterId, candidate } of input.publication.protocolEvidenceCache
    .verifiedCandidates.values()) {
    let address: string;
    try {
      address = candidate.pool.address.toLowerCase();
    } catch {
      continue;
    }
    const familyId = input.familyIdForAdapter(adapterId);
    if (familyId === null || !eligible.has(familyId)) continue;
    const dedupeKey = `${familyId}\0${address}`;
    if (seenVerifiedAddresses.has(dedupeKey)) continue;
    seenVerifiedAddresses.add(dedupeKey);
    const family = input.catalog.forStrictFamily(familyId);
    const interfaceFingerprints = "discovery" in family.plugin
      ? family.plugin.discovery.addressSurfaces?.filter(
          (pattern) => pattern.kind === "interface",
        ).map((pattern) => pattern.fingerprint)
      : undefined;
    const surface = addressSurfaceFromVerifiedEvidence(candidate.evidence);
    const observation: UnifiedObservation = Object.freeze({
      kind: "address-surface",
      source: input.source,
      address,
      codeHash: surface.codeHash,
      implementationWord: surface.implementationWord,
      ...(interfaceFingerprints === undefined ||
          interfaceFingerprints.length === 0
        ? {}
        : { interfaceFingerprints: Object.freeze(interfaceFingerprints) }),
    });
    const existing = byFamily.get(familyId);
    if (existing === undefined) {
      byFamily.set(familyId, [observation]);
    } else {
      existing.push(observation);
    }
  }
  for (const observations of byFamily.values()) {
    Object.freeze(observations);
  }
  return byFamily;
}
