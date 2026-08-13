import {
  AdapterFamilyDiscoveryCheckpointStore,
  FileAdapterFamilyDiscoveryCheckpointBackend,
  type AdapterFamilyDiscoveryCheckpointCandidateIssuer,
  type AdapterFamilyDiscoveryCheckpointLoadResult,
  type AdapterFamilyDiscoveryCheckpointReceipt,
} from "./adapter-family-discovery-checkpoint.js";
import {
  createCatalogSourceTransitionIssuer,
  createCatalogTerminalRemovalIssuer,
  type CatalogSourceTransitionProof,
  type CatalogTerminalRemovalProof,
} from "./adapter-family-catalog-publication.js";
import {
  StrictAdapterFamilyShadowCatalogPublicationRoot,
} from "./adapter-family-shadow-catalog-publication.js";
import {
  AdapterFamilySnapshotInventoryClosureVerifier,
  assertClosureStagedExactSetCoupling,
  type AdapterFamilySnapshotInventoryClosureCandidateIssuer,
  type AdapterFamilySnapshotInventoryClosureReceipt,
  type AdapterFamilySnapshotInventoryEnumerationInput,
  type ResolvedAdapterFamilySnapshotInventoryClosure,
} from "./adapter-family-snapshot-inventory-closure.js";
import type { FamilyId } from
  "./venues/adapter-family-identifiers.js";
import type { CanonicalSource } from
  "./venues/adapter-request-program.js";
import type { FamilyCapabilityCatalog } from
  "./venues/family-capability-catalog.js";

export interface DurableDiscoveryContinuityCompositionInput {
  readonly catalog: FamilyCapabilityCatalog;
  readonly chainId: string;
  readonly sourceRegistryFingerprint: string;
  readonly checkpointPath: string;
  readonly enumerateSnapshotInventory: (
    source: CanonicalSource,
  ) => AdapterFamilySnapshotInventoryEnumerationInput |
    Promise<AdapterFamilySnapshotInventoryEnumerationInput>;
  readonly verifyCanonicalSource: (
    source: CanonicalSource,
  ) => void | Promise<void>;
  readonly assertGenerationCurrent: (source: CanonicalSource) => void;
}

export interface DurableDiscoveryContinuityComposition {
  readonly store: AdapterFamilyDiscoveryCheckpointStore;
  readonly checkpointIssuer: AdapterFamilyDiscoveryCheckpointCandidateIssuer;
  readonly closureVerifier: AdapterFamilySnapshotInventoryClosureVerifier;
  readonly closureIssuer: AdapterFamilySnapshotInventoryClosureCandidateIssuer;
  readonly catalogRoot: StrictAdapterFamilyShadowCatalogPublicationRoot;
  /**
   * Real canonical-source and generation fences bound to this composition.
   * The final catalogRoot CAS must call these instead of no-ops; the
   * checkpoint store keeps its own (hash-successor enforced) fence because
   * a checkpoint write at the same source/generation as the just-committed
   * catalog is legitimate.
   */
  readonly verifyCanonicalSource: (
    source: CanonicalSource,
  ) => void | Promise<void>;
  readonly assertGenerationCurrent: (source: CanonicalSource) => void;
  loadForRestart(): Promise<AdapterFamilyDiscoveryCheckpointLoadResult>;
  /**
   * Issue the canonical source ancestry proof required by every catalogRoot
   * publication after the first. The caller is responsible for verifying the
   * ancestry claim (for example `current.parentHash === previous.hash`); the
   * proof is runtime-opaque and authority-bound to this composition.
   */
  issueSourceTransition(
    previous: CanonicalSource,
    current: CanonicalSource,
  ): CatalogSourceTransitionProof;
  /**
   * Issue an issuer-bound terminal removal proof for an explicitly settled
   * StateInstance. This is the only way an observed-complete live publication
   * may legally shrink the committed instance set: a missing instance is
   * never tombstoned implicitly, it is either carried (mutation proof, not
   * yet wired) or removed through an explicit terminal settlement the family
   * declared for this canonical source.
   */
  issueTerminalRemoval(input: {
    readonly familyId: FamilyId;
    readonly lineageId: string;
    readonly instanceKey: string;
    readonly source: CanonicalSource;
    readonly reason: string;
    readonly evidenceRef: string;
  }): CatalogTerminalRemovalProof;
  consumeClosureForCatalog(input: {
    readonly receipt: AdapterFamilySnapshotInventoryClosureReceipt;
    readonly source: CanonicalSource;
    readonly stagedByFamily: ReadonlyMap<FamilyId, readonly string[]>;
  }): ResolvedAdapterFamilySnapshotInventoryClosure;
}

/**
 * Shadow production composition root for the durable discovery continuity
 * stack: file-backed checkpoint CAS -> snapshot inventory closure verifier ->
 * strict shadow catalog root, with the staged exact-set coupling enforced at
 * closure consumption time. Production startup can adopt this one entry
 * point; the strict catalog `prepare` still refuses `complete-snapshot`, so
 * this composition alone does not open omission/tombstone authority.
 */
export function createDurableDiscoveryContinuityComposition(
  input: DurableDiscoveryContinuityCompositionInput,
): DurableDiscoveryContinuityComposition {
  const backend = new FileAdapterFamilyDiscoveryCheckpointBackend({
    path: input.checkpointPath,
  });
  const store = new AdapterFamilyDiscoveryCheckpointStore({
    catalog: input.catalog,
    chainId: input.chainId,
    sourceRegistryFingerprint: input.sourceRegistryFingerprint,
    backend,
    verifyCanonicalCheckpoint: (snapshot) =>
      input.verifyCanonicalSource(snapshot.source),
    // Checkpoint source succession is hash-anchored by assertSourceSuccessor;
    // generation is monotonic by the live chain and must not be compared to
    // the catalogRoot (the checkpoint write follows a successful publish at
    // the same generation).
    assertGenerationCurrent: () => {},
  });
  const terminalIssuer = createCatalogTerminalRemovalIssuer();
  const transitionIssuer = createCatalogSourceTransitionIssuer();
  const catalogRoot = new StrictAdapterFamilyShadowCatalogPublicationRoot({
    catalog: input.catalog,
    chainId: input.chainId,
    terminalRemovalAuthority: terminalIssuer.authority,
    sourceTransitionAuthority: transitionIssuer.authority,
  });
  const closureVerifier = new AdapterFamilySnapshotInventoryClosureVerifier({
    catalog: input.catalog,
    chainId: input.chainId,
    sourceRegistryFingerprint: input.sourceRegistryFingerprint,
    checkpointStore: store,
    enumerateSnapshotInventory: input.enumerateSnapshotInventory,
    captureCatalogPublication: () => {
      const committed = catalogRoot.capture();
      return committed === null
        ? Object.freeze({ revision: 0, publicationFingerprint: null })
        : Object.freeze({
            revision: committed.envelope.snapshot.revision,
            publicationFingerprint:
              committed.envelope.snapshot.publicationFingerprint,
          });
    },
    verifyCanonicalSource: input.verifyCanonicalSource,
    assertGenerationCurrent: input.assertGenerationCurrent,
  });
  catalogRoot.bindSnapshotInventoryClosureVerifier(closureVerifier);
  const composition: DurableDiscoveryContinuityComposition = Object.freeze({
    store,
    checkpointIssuer: store.takeCandidateIssuer(),
    closureVerifier,
    closureIssuer: closureVerifier.takeCandidateIssuer(),
    catalogRoot,
    verifyCanonicalSource: input.verifyCanonicalSource,
    assertGenerationCurrent: (source: CanonicalSource) => {
      const committed = catalogRoot.capture();
      if (
        committed !== null &&
        source.generation <=
          committed.envelope.snapshot.source.generation
      ) {
        throw new Error(
          `strict catalog source generation is stale: ${source.generation}`,
        );
      }
    },
    loadForRestart: () => store.loadForRestart(),
    issueSourceTransition: (
      previous: CanonicalSource,
      current: CanonicalSource,
    ) =>
      transitionIssuer.issue({
        previous,
        current,
        status: "canonical-descendant",
        evidenceRef: "live-chain-canonical-ancestry",
      }),
    issueTerminalRemoval: (input: {
      readonly familyId: FamilyId;
      readonly lineageId: string;
      readonly instanceKey: string;
      readonly source: CanonicalSource;
      readonly reason: string;
      readonly evidenceRef: string;
    }) =>
      terminalIssuer.issue({
        familyId: input.familyId,
        lineageId: input.lineageId,
        instanceKey: input.instanceKey,
        source: input.source,
        status: "terminal",
        reason: input.reason,
        evidenceRef: input.evidenceRef,
      }),
    consumeClosureForCatalog: (consumption: {
      readonly receipt: AdapterFamilySnapshotInventoryClosureReceipt;
      readonly source: CanonicalSource;
      readonly stagedByFamily: ReadonlyMap<FamilyId, readonly string[]>;
    }) => {
      const resolved = closureVerifier.consumeForCatalog(
        consumption.receipt,
        { source: consumption.source },
      );
      assertClosureStagedExactSetCoupling({
        closure: resolved,
        stagedByFamily: consumption.stagedByFamily,
      });
      return resolved;
    },
  });
  return composition;
}
