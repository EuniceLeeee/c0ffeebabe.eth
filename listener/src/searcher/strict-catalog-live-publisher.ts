import type {
  DurableDiscoveryContinuityComposition,
} from "./adapter-family-discovery-continuity-composition.js";
import {
  catalogDiscoverySourceFingerprint,
} from "./adapter-family-catalog-publication.js";
import type {
  AdapterFamilyPublication,
} from "./venues/adapter-family-runtime.js";
import type { CanonicalSource } from
  "./venues/adapter-request-program.js";
import type { FamilyCapabilityCatalog } from
  "./venues/family-capability-catalog.js";

/**
 * Strict production publication pipeline step 2-3 (see Phase E plan): given
 * lifecycle-issued publications for a set of families at one canonical
 * source, stage every catalog Family (published families as
 * observed-complete, the rest as unsupported) and atomically commit the
 * catalogRoot publication. Live publications are observed-complete only:
 * the verified-candidate inventory is a nomination journal, not an exact
 * complete enumeration, so granting complete-snapshot here would create
 * omission/tombstone authority from a circular proof. The snapshot closure
 * verifier remains available for an exact bootstrap path. Returns the
 * committed revision or unresolved with the store untouched.
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
    const publishedByFamily = new Map(
      input.publications.map((entry) => [entry.familyId, entry]),
    );
    const stages = catalog.listAll().map((family) => {
      const familyId = family.plugin.manifest.familyId;
      const entry = publishedByFamily.get(familyId);
      if (entry !== undefined) {
        return composition.catalogRoot.stageRouteFamily({
          publication: entry.publication,
          inventoryMode: "observed-complete",
        });
      }
      // Every catalog Family must appear in the staged publication; families
      // without a lifecycle result this pass are staged unsupported with an
      // explicit outcome ref (the shadow-catalog publication contract).
      return composition.catalogRoot.stageUnsupported({
        familyId,
        source,
        outcomeRefs: Object.freeze(["strict-live:no-publication"]),
      });
    });
    const anchors = catalog.listAll().flatMap((family) => {
      if (!("discovery" in family.plugin)) return [];
      const familyId = family.plugin.manifest.familyId;
      return family.plugin.discovery.sources.map((sourceId) => {
        return Object.freeze({
          familyId,
          sourceId,
          sourceFingerprint: catalogDiscoverySourceFingerprint({
            familyId,
            sourceId,
            source,
          }),
          authority: "append-only-nomination" as const,
          status: "complete" as const,
          completeThroughBlock: source.number,
          completeThroughHash: source.hash,
        });
      });
    });
    const previous = composition.catalogRoot.capture();
    const prepared = composition.catalogRoot.prepare({
      source,
      previous,
      stages: Object.freeze(stages),
      sourceAnchors: Object.freeze(anchors),
      ...(previous === null
        ? {}
        : {
            sourceTransitionProof: composition.issueSourceTransition(
              previous.envelope.snapshot.source,
              source,
            ),
          }),
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
