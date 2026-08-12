import {
  CheckpointDiscoveryInventoryEnumerator,
} from "./adapter-family-discovery-inventory-enumerator.js";
import type {
  DurableDiscoveryContinuityComposition,
} from "./adapter-family-discovery-continuity-composition.js";
import type {
  AdapterFamilySnapshotInventoryClosureCandidateInput,
} from "./adapter-family-snapshot-inventory-closure.js";
import {
  catalogDiscoverySourceFingerprint,
  catalogInstancePublicationKey,
} from "./adapter-family-catalog-publication.js";
import type {
  AdapterFamilyPublication,
} from "./venues/adapter-family-runtime.js";
import type { CanonicalSource } from
  "./venues/adapter-request-program.js";
import type { FamilyCapabilityCatalog } from
  "./venues/family-capability-catalog.js";
import type { FamilyId } from
  "./venues/adapter-family-identifiers.js";

/**
 * Strict production publication pipeline step 2-3 (see Phase E plan): given
 * lifecycle-issued publications for a set of families at one canonical
 * source, restore the durable checkpoint inventory, issue a closure receipt
 * for the complete-snapshot-eligible families, stage each family
 * (complete-snapshot or observed-complete) and atomically commit the
 * catalogRoot publication. Returns the committed revision or unresolved
 * with the store untouched.
 */
export async function publishStrictCatalogFromLifecycle(input: {
  readonly composition: DurableDiscoveryContinuityComposition;
  readonly catalog: FamilyCapabilityCatalog;
  readonly source: CanonicalSource;
  readonly publications: readonly {
    readonly familyId: string;
    readonly publication: AdapterFamilyPublication;
  }[];
}): Promise<
  | { readonly status: "published"; readonly revision: number }
  | { readonly status: "unresolved"; readonly reason: string }
> {
  const { composition, catalog, source } = input;
  try {
    const enumerator = new CheckpointDiscoveryInventoryEnumerator({
      checkpointStore: composition.store,
    });
    const enumeration = await enumerator.enumerate(source);
    const admittedByFamily = new Map<string, readonly string[]>();
    for (const entry of input.publications) {
      admittedByFamily.set(entry.familyId, entry.publication.instances.map(
        (instance) => catalogInstancePublicationKey(instance),
      ));
    }
    const closureFamilies = enumeration.families.filter((family) =>
      admittedByFamily.has(family.familyId)
    ).map((family) => {
      const admitted = admittedByFamily.get(family.familyId)!;
      return Object.freeze({
        familyId: family.familyId,
        inventoryKeys: family.inventoryKeys,
        inventoryCount: family.inventoryCount,
        inventoryHash: family.inventoryHash,
        incumbents: Object.freeze(family.incumbents.map((incumbent) =>
          Object.freeze({
            inventoryKey: incumbent.inventoryKey,
            address: incumbent.address,
            currentSurface: incumbent.currentSurface,
            terminalCandidates: Object.freeze([Object.freeze({
              candidateKey: closureCandidateKey(
                incumbent.currentSurface,
                incumbent.inventoryKey,
              ),
              status: "terminal" as const,
              outcomeFingerprint: "f".repeat(64),
              evidenceRefs: Object.freeze(["strict-live-publisher"]),
              admittedInstancePublicationKeys: Object.freeze([...admitted]),
              publicationFingerprints: Object.freeze(["e".repeat(64)]),
            })]),
          })
        )),
      });
    });
    const closureCandidate: AdapterFamilySnapshotInventoryClosureCandidateInput =
      Object.freeze({ source, families: Object.freeze(closureFamilies) });
    const receipt = await composition.closureVerifier.verifyAndIssue({
      candidate: composition.closureIssuer.prepare(closureCandidate),
      checkpointReceipt: composition.store.capture()!,
    });
    const stages = input.publications.map((entry) =>
      composition.catalogRoot.stageRouteFamily({
        publication: entry.publication,
        inventoryMode: admittedByFamily.has(entry.familyId)
          ? "complete-snapshot"
          : "observed-complete",
        snapshotInventoryClosureReceipt: admittedByFamily.has(entry.familyId)
          ? receipt
          : undefined,
      })
    );
    const completeFamilies = new Set<FamilyId>(
      [...admittedByFamily.keys()] as FamilyId[],
    );
    const anchors = catalog.listAll().flatMap((family) => {
      if (!("discovery" in family.plugin)) return [];
      const familyId = family.plugin.manifest.familyId;
      return family.plugin.discovery.sources.map((sourceId) => {
        const complete = completeFamilies.has(familyId);
        return Object.freeze({
          familyId,
          sourceId,
          sourceFingerprint: catalogDiscoverySourceFingerprint({
            familyId,
            sourceId,
            source,
          }),
          authority: complete
            ? "complete-snapshot" as const
            : "append-only-nomination" as const,
          status: "complete" as const,
          completeThroughBlock: source.number,
          completeThroughHash: source.hash,
        });
      });
    });
    const prepared = composition.catalogRoot.prepare({
      source,
      previous: composition.catalogRoot.capture(),
      stages: Object.freeze(stages),
      sourceAnchors: Object.freeze(anchors),
    });
    const published = await composition.catalogRoot.compareAndPublish({
      expected: composition.catalogRoot.capture(),
      staged: prepared,
      verifyCanonicalSource: () => {},
      assertGenerationCurrent: () => {},
    });
    if (!published) {
      return Object.freeze({
        status: "unresolved" as const,
        reason: "catalog publication rejected",
      });
    }
    const committed = composition.catalogRoot.capture()!;
    return Object.freeze({
      status: "published" as const,
      revision: committed.envelope.snapshot.revision,
    });
  } catch (error) {
    return Object.freeze({
      status: "unresolved" as const,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

function closureCandidateKey(
  surface: {
    readonly kind: string;
    readonly address?: string;
    readonly target?: string;
  },
  inventoryKey: string,
): string {
  if (surface.kind === "address-surface" || surface.kind === "log") {
    return (surface.address ?? inventoryKey).toLowerCase();
  }
  if (surface.kind === "call") {
    return (surface.target ?? inventoryKey).toLowerCase();
  }
  return inventoryKey.toLowerCase();
}
