import type { Hash } from "../../canonical-codec/src/index.ts";
import type { InstanceCatalogV1 } from "../../catalog/src/index.ts";
import type { BlockRangeV1, CanonicalCutoffV1, SourceCoverageCertificateV1 } from "../../discovery/src/index.ts";
import type { AttestationPartitionV1 } from "../../attestation/src/index.ts";
import type { RuntimeAuthorityProjectionV1 } from "../../runtime-authority/src/index.ts";

export type SealedRunCapabilityV1 = object;

export interface SealedRunBindingV1 {
  readonly runId: string;
  readonly parentGenerationId: string | null;
  readonly cutoff: CanonicalCutoffV1;
  readonly recentObservationRange: BlockRangeV1;
  readonly definitionCatalogRoot: Hash;
  readonly sourceCoverageRoot: Hash;
  readonly candidatePartitionRoot: Hash;
  readonly candidatePartitionStorageHash: Hash;
  readonly nominationClosureRoot: Hash;
  readonly nominationClosureStorageHash: Hash;
  readonly candidatePartitionCommitmentStorageHash: Hash;
  readonly exactOutcomePartitionRoot: Hash;
  readonly verifiedMemoSetRoot: Hash;
  readonly checkpointRevision: string;
  readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
  readonly attestationAuthorityRoot: Hash;
  readonly frameworkAuthorityRoot: Hash;
  readonly executorAuthorityRoot: Hash;
}

export interface SealedRunSnapshotV1 extends SealedRunBindingV1 {
  readonly sourceCoverage: SourceCoverageCertificateV1;
  readonly candidateKeys: readonly Hash[];
  readonly partition: AttestationPartitionV1;
}

export interface SealedRunReaderPortV1 {
  binding(capability: SealedRunCapabilityV1): SealedRunBindingV1;
  readForPromotion(capability: SealedRunCapabilityV1, instanceCatalog: InstanceCatalogV1): SealedRunSnapshotV1;
}
