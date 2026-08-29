import type { ReadyFullFamilyEvidenceReaderPortV1 } from "../ready-full-family-evidence.ts";
import { isReadyFullFamilyEvidenceReader } from "./ready-full-family-evidence-state.ts";

export function assertCheckpointReadyFullFamilyEvidenceReader(
  value: unknown,
): ReadyFullFamilyEvidenceReaderPortV1 {
  if (value === null || typeof value !== "object" || !isReadyFullFamilyEvidenceReader(value)) {
    throw new TypeError("ready full-Family evidence reader is not checkpoint-issued");
  }
  return value as ReadyFullFamilyEvidenceReaderPortV1;
}
