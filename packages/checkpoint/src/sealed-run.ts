import { deepFreeze, encodeCanonicalJson } from "../../canonical-codec/src/index.ts";
import { assertPromotablePartition, type AttestationPartitionV1 } from "../../attestation/src/index.ts";
import { type InstanceCatalogV1 } from "../../catalog/src/index.ts";
import type { SourceCoverageCertificateV1 } from "../../discovery/src/index.ts";
import {
  type SealedRunBindingV1,
  type SealedRunCapabilityV1,
  type SealedRunReaderPortV1,
  type SealedRunSnapshotV1,
} from "../../sealed-run-runtime/src/contract.ts";
import { issueCheckpointSealedRunReader } from "../../sealed-run-runtime/src/internal/reader-issuer.ts";

interface StateV1 {
  readonly binding: SealedRunBindingV1;
  readonly read: () => SealedRunSnapshotV1;
}

export class SealedRunCapabilityRegistryV1 {
  readonly #states = new WeakMap<object, StateV1>();
  readonly reader: SealedRunReaderPortV1;

  constructor() {
    this.reader = issueCheckpointSealedRunReader(Object.freeze({
      binding: (capability: SealedRunCapabilityV1) => this.#state(capability).binding,
      readForPromotion: (capability: SealedRunCapabilityV1, instanceCatalog: InstanceCatalogV1) => {
        const state = this.#state(capability);
        const snapshot = cloneFrozen(state.read());
        assertSnapshotBinding(state.binding, snapshot);
        assertPromotablePartition(snapshot.partition, snapshot.candidateKeys);
        const verifiedHashes = snapshot.partition.outcomes
          .filter(outcome => outcome.kind === "verified")
          .map(outcome => outcome.publication.instancePublicationHash)
          .sort();
        const catalogHashes = instanceCatalog.publications.map(value => value.instancePublicationHash).sort();
        if (verifiedHashes.length !== catalogHashes.length
          || verifiedHashes.some((hash, index) => hash !== catalogHashes[index])) {
          throw new TypeError("sealed run instance catalog mismatch");
        }
        return snapshot;
      },
    }));
  }

  issue(binding: SealedRunBindingV1, read: () => SealedRunSnapshotV1): SealedRunCapabilityV1 {
    const capability = Object.freeze({});
    this.#states.set(capability, { binding: cloneFrozen(binding), read });
    return capability;
  }

  binding(capability: SealedRunCapabilityV1): SealedRunBindingV1 {
    return cloneFrozen(this.#state(capability).binding);
  }

  read(capability: SealedRunCapabilityV1): SealedRunSnapshotV1 {
    const state = this.#state(capability);
    const snapshot = cloneFrozen(state.read());
    assertSnapshotBinding(state.binding, snapshot);
    return snapshot;
  }

  #state(capability: SealedRunCapabilityV1): StateV1 {
    if (capability === null || typeof capability !== "object") throw new TypeError("sealed run capability invalid");
    const state = this.#states.get(capability);
    if (!state) throw new TypeError("sealed run capability is not checkpoint-issued");
    return state;
  }
}

function cloneFrozen<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function assertSnapshotBinding(binding: SealedRunBindingV1, snapshot: SealedRunSnapshotV1): void {
  if (encodeCanonicalJson(sealedRunBinding(snapshot)) !== encodeCanonicalJson(binding)) {
    throw new TypeError("sealed-run-capability-binding-mismatch");
  }
}

export function sealedRunBinding(snapshot: SealedRunSnapshotV1): SealedRunBindingV1 {
  return deepFreeze({
    runId: snapshot.runId,
    parentGenerationId: snapshot.parentGenerationId,
    cutoff: snapshot.cutoff,
    recentObservationRange: snapshot.recentObservationRange,
    definitionCatalogRoot: snapshot.definitionCatalogRoot,
    sourceCoverageRoot: snapshot.sourceCoverage.sourceCoverageRoot,
    candidatePartitionRoot: snapshot.candidatePartitionRoot,
    candidatePartitionStorageHash: snapshot.candidatePartitionStorageHash,
    nominationClosureRoot: snapshot.nominationClosureRoot,
    nominationClosureStorageHash: snapshot.nominationClosureStorageHash,
    candidatePartitionProofStorageHash: snapshot.candidatePartitionProofStorageHash,
    exactOutcomePartitionRoot: snapshot.partition.exactOutcomePartitionRoot,
    verifiedMemoSetRoot: snapshot.verifiedMemoSetRoot,
    checkpointRevision: snapshot.checkpointRevision,
    attestationAuthorityRoot: snapshot.attestationAuthorityRoot,
    releaseAuthorityRoot: snapshot.releaseAuthorityRoot,
    releaseProvenanceHash: snapshot.releaseProvenanceHash,
    executorAuthorityRoot: snapshot.executorAuthorityRoot,
  });
}
