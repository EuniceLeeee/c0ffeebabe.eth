import type { AttestationIdentityOriginV1, CandidateFinalOutcomeV1 } from "../../attestation/src/index.ts";
import type { Hash } from "../../canonical-codec/src/index.ts";
import type { InstanceCatalogV1, InstancePublicationV1 } from "../../catalog/src/index.ts";
import type { CandidateRecordV1, CanonicalCutoffV1, SourceCoverageCertificateV1 } from "../../discovery/src/index.ts";
import type { PersistedGraphV1 } from "../../graph/src/index.ts";
import type { ReadyGenerationV1 } from "../../ready-generation/src/index.ts";
import type { CandidatePartitionCommitmentV1 } from "../../../specs/candidate-partition-authority/src/index.ts";

export interface ReadyStage12EvidenceBindingV1 {
  readonly readyRecordHash: Hash;
  readonly generationId: string;
  readonly cutoff: CanonicalCutoffV1;
  readonly definitionCatalogRoot: Hash;
  readonly sourceCoverageRoot: Hash;
  readonly candidatePartitionRoot: Hash;
  readonly exactOutcomePartitionRoot: Hash;
  readonly verifiedMemoSetRoot: Hash;
  readonly instanceCatalogRoot: Hash;
  readonly graphRoot: Hash;
  readonly promotionRevision: string;
}

export type ReadyStage12EvidenceCapabilityV1 = object;

export interface ReadyStage12VerifiedInstanceV1 {
  readonly candidate: CandidateRecordV1;
  readonly outcome: Extract<CandidateFinalOutcomeV1, { readonly kind: "verified" }>;
  readonly publication: InstancePublicationV1;
  readonly identityCommitment: Extract<CandidateFinalOutcomeV1, { readonly kind: "verified" }>["identityCommitment"];
  readonly attestationOrigin: AttestationIdentityOriginV1;
  readonly edges: PersistedGraphV1["edges"];
}

export interface ReadyStage12EvidenceSnapshotV1 {
  readonly binding: ReadyStage12EvidenceBindingV1;
  readonly runId: string;
  readonly candidates: readonly CandidateRecordV1[];
  readonly outcomes: readonly CandidateFinalOutcomeV1[];
  readonly candidatePartitionCommitment: CandidatePartitionCommitmentV1;
  readonly sourceCoverage: SourceCoverageCertificateV1;
  readonly verifiedInstances: readonly ReadyStage12VerifiedInstanceV1[];
  readonly instanceCatalog: InstanceCatalogV1;
  readonly graph: PersistedGraphV1;
  readonly promotionLineage: {
    readonly candidatePartitionRevision: string;
    readonly sealedRevision: string;
    readonly stageRevision: string;
    readonly stageRecordHash: Hash;
    readonly readyBaseHash: Hash;
    readonly promotionRevision: string;
    readonly promotionFreshness: ReadyGenerationV1["promotionFreshness"];
    readonly promotedAtMonotonicNs: string;
  };
}

export interface ReadyStage12EvidenceReaderPortV1 {
  binding(capability: ReadyStage12EvidenceCapabilityV1): ReadyStage12EvidenceBindingV1;
  read(capability: ReadyStage12EvidenceCapabilityV1): Promise<ReadyStage12EvidenceSnapshotV1>;
  verify(
    capability: ReadyStage12EvidenceCapabilityV1,
    snapshot: ReadyStage12EvidenceSnapshotV1,
  ): Promise<ReadyStage12EvidenceSnapshotV1>;
  routeParents(
    capability: ReadyStage12EvidenceCapabilityV1,
    orderedEdgeIds: readonly Hash[],
  ): Readonly<{
    readonly stage1: readonly object[];
    readonly stage2: readonly object[];
  }>;
}
