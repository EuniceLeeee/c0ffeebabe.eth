import type { ReadyFullFamilyEvidenceReaderPortV1 } from "../ready-full-family-evidence.ts";
import { registerReadyFullFamilyEvidenceReader } from "./ready-full-family-evidence-state.ts";

export function registerCheckpointReadyFullFamilyEvidenceReader(
  reader: ReadyFullFamilyEvidenceReaderPortV1,
): void {
  registerReadyFullFamilyEvidenceReader(reader);
}
