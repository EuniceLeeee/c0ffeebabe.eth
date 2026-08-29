import { isReadyStage12EvidenceReader } from "./ready-stage12-evidence-state.ts";
import type { ReadyStage12EvidenceReaderPortV1 } from "../ready-stage12-evidence.ts";

export function assertCheckpointReadyStage12EvidenceReader(
  value: unknown,
): ReadyStage12EvidenceReaderPortV1 {
  if (value === null || typeof value !== "object" || !isReadyStage12EvidenceReader(value)) {
    throw new TypeError("ready stage1/2 evidence reader is not checkpoint-issued");
  }
  return value as ReadyStage12EvidenceReaderPortV1;
}
