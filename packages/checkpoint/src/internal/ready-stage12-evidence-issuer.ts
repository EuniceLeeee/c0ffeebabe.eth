import { registerReadyStage12EvidenceReader } from "./ready-stage12-evidence-state.ts";
import type { ReadyStage12EvidenceReaderPortV1 } from "../ready-stage12-evidence.ts";

export function registerCheckpointReadyStage12EvidenceReader(
  reader: ReadyStage12EvidenceReaderPortV1,
): void {
  registerReadyStage12EvidenceReader(reader);
}
