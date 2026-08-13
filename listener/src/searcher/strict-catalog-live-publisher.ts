import type {
  DurableDiscoveryContinuityComposition,
} from "./adapter-family-discovery-continuity-composition.js";
import {
  catalogDiscoverySourceFingerprint,
  type CatalogStateInstanceMutationProof,
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
    /**
     * Explicit terminal settlements declared by the family for this source.
     * Each entry names a previously published instance that the family
     * re-verified as terminally settled; the publisher issues an issuer-bound
     * terminal removal proof so the catalogRoot may legally shrink. Omitting
     * an instance without such a declaration stays fail-closed (observed
     * complete grants no implicit omission/tombstone authority).
     */
    readonly terminalRemovals?: readonly {
      readonly lineageId: string;
      readonly instanceKey: string;
      readonly reason: string;
      readonly evidenceRef: string;
    }[];
  }[];
  /**
   * Central re-verification of state continuity for a previously committed
   * instance that this family did not re-stage at the current source. Return
   * an evidence ref when continuity is verified, or null when it cannot be
   * proven — a null result leaves the instance without a mutation proof and
   * the whole publication fails closed (observed-complete never carries
   * silently). Absent callback, no carries are admitted.
   */
  readonly verifyCarriedInstance?: (input: {
    readonly familyId: string;
    readonly lineageId: string;
    readonly instanceKey: string;
    readonly previous: CanonicalSource;
    readonly current: CanonicalSource;
  }) => Promise<string | null>;
}): Promise<
  | { readonly status: "published"; readonly revision: number }
  | { readonly status: "unresolved"; readonly reason: string }
> {
  const { composition, catalog, source } = input;
  try {
    const publishedByFamily = new Map(
      input.publications.map((entry) => [entry.familyId, entry]),
    );
    const previous = composition.catalogRoot.capture();
    const priorInstancesByFamily = new Map<string, {
      readonly familyId: FamilyId;
      readonly lineageId: string;
      readonly instanceKey: string;
      readonly key: string;
    }[]>();
    if (previous !== null) {
      for (const [key, instance] of previous.envelope.privateState.instances) {
        const familyInstances = priorInstancesByFamily.get(instance.familyId) ??
          [];
        familyInstances.push(Object.freeze({
          familyId: instance.familyId,
          lineageId: instance.lineageId,
          instanceKey: instance.instanceKey,
          key,
        }));
        priorInstancesByFamily.set(instance.familyId, familyInstances);
      }
    }
    const stateMutationProofs = new Map<
      string,
      CatalogStateInstanceMutationProof
    >();
    if (
      previous !== null &&
      input.verifyCarriedInstance !== undefined
    ) {
      for (const family of catalog.listAll()) {
        const familyId = family.plugin.manifest.familyId;
        if (publishedByFamily.has(familyId)) continue;
        const priorInstances = priorInstancesByFamily.get(familyId) ?? [];
        for (const prior of priorInstances) {
          const evidenceRef = await input.verifyCarriedInstance({
            familyId: prior.familyId,
            lineageId: prior.lineageId,
            instanceKey: prior.instanceKey,
            previous: previous.envelope.snapshot.source,
            current: source,
          });
          if (evidenceRef === null) continue;
          stateMutationProofs.set(
            prior.key,
            composition.issueStateInstanceMutation({
              familyId: prior.familyId,
              lineageId: prior.lineageId,
              instanceKey: prior.instanceKey,
              previous: previous.envelope.snapshot.source,
              current: source,
              evidenceRef,
            }),
          );
        }
      }
    }
    const stages = catalog.listAll().map((family) => {
      const familyId = family.plugin.manifest.familyId;
      const entry = publishedByFamily.get(familyId);
      if (entry !== undefined) {
        const terminalRemovals = (entry.terminalRemovals ?? []).map(
          (removal) =>
            composition.issueTerminalRemoval({
              familyId,
              lineageId: removal.lineageId,
              instanceKey: removal.instanceKey,
              source,
              reason: removal.reason,
              evidenceRef: removal.evidenceRef,
            }),
        );
        const outcomeRefs = Object.freeze([
          ...new Set(
            entry.publication.outcomes.flatMap(
              (outcome) => outcome.evidenceRefs,
            ),
          ),
        ]);
        return composition.catalogRoot.stageRouteFamily({
          publication: entry.publication,
          inventoryMode: "observed-complete",
          outcomeRefs,
          terminalRemovals: Object.freeze(terminalRemovals),
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
    const prepared = composition.catalogRoot.prepare({
      source,
      previous,
      stages: Object.freeze(stages),
      sourceAnchors: Object.freeze(anchors),
      stateMutationProofs: Object.freeze(stateMutationProofs),
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
      verifyCanonicalSource: composition.verifyCanonicalSource,
      assertGenerationCurrent: composition.assertGenerationCurrent,
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
