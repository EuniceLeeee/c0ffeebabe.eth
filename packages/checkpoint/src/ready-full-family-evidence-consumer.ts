import type { ReadyStage12EvidenceCapabilityV1 } from "./ready-stage12-evidence.ts";
import type {
  ReadyFullFamilyEvidenceReaderPortV1,
  ReadyFullFamilyEvidenceSnapshotV1,
} from "./ready-full-family-evidence.ts";
import { assertCheckpointReadyFullFamilyEvidenceReader } from "./internal/ready-full-family-evidence-consumer.ts";

/**
 * Narrow read-only bridge for qualified observers.  The supplied reader must
 * be the exact object registered by Checkpoint; a structural clone cannot
 * invoke the durable full-Family view.
 */
export function readCheckpointReadyFullFamilyEvidence(
  reader: ReadyFullFamilyEvidenceReaderPortV1,
  capability: ReadyStage12EvidenceCapabilityV1,
): Promise<ReadyFullFamilyEvidenceSnapshotV1> {
  return assertCheckpointReadyFullFamilyEvidenceReader(reader).read(capability);
}

export type {
  ReadyFullFamilyEvidenceReaderPortV1,
  ReadyFullFamilyEvidenceSnapshotV1,
} from "./ready-full-family-evidence.ts";
export type { ReadyStage12EvidenceCapabilityV1 } from "./ready-stage12-evidence.ts";
