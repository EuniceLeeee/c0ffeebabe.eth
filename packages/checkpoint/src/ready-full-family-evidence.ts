import type { Hash } from "../../canonical-codec/src/index.ts";
import type {
  PersistedSourcePlanExecutionSetV1,
  RawEvidenceLocatorContentV1,
  SourcePlanEvidenceReceiptV1,
} from "../../discovery/src/index.ts";
import type { ReadyGenerationV1 } from "../../ready-generation/src/index.ts";
import type { NominationClosureV1 } from "../../../specs/nomination-authority/src/index.ts";
import type {
  ReadyStage12EvidenceCapabilityV1,
  ReadyStage12EvidenceSnapshotV1,
} from "./ready-stage12-evidence.ts";

/**
 * Checkpoint-owned, root-reachable durable facts needed by the full-Family
 * observer.  Stage 1/2 remains the existing snapshot and hash contract; this
 * view only adds independently persisted discovery/nomination closure facts.
 */
export interface ReadyFullFamilyEvidenceSnapshotV1 {
  readonly ready: ReadyGenerationV1;
  readonly stage12: ReadyStage12EvidenceSnapshotV1;
  readonly nominationClosure: NominationClosureV1;
  readonly sourceExecutionSet: PersistedSourcePlanExecutionSetV1;
  readonly sourcePlanEvidenceReceipts: readonly SourcePlanEvidenceReceiptV1[];
  readonly rawEvidenceLocatorContents: readonly RawEvidenceLocatorContentV1[];
  readonly sourceCoverageStorageHash: Hash;
  readonly sourceExecutionSetStorageHash: Hash;
  readonly sourcePlanEvidenceStorageHash: Hash;
  readonly nominationClosureStorageHash: Hash;
  readonly candidatePartitionStorageHash: Hash;
  readonly candidatePartitionProofStorageHash: Hash;
}

export interface ReadyFullFamilyEvidenceReaderPortV1 {
  read(capability: ReadyStage12EvidenceCapabilityV1): Promise<ReadyFullFamilyEvidenceSnapshotV1>;
}
