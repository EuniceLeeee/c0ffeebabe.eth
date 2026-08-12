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
    assertGenerationCurrent: input.assertGenerationCurrent,
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
