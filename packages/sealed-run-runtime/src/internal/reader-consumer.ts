import type { SealedRunReaderPortV1 } from "../contract.ts";
import { isSealedRunReader } from "./reader-state.ts";
export function assertCheckpointSealedRunReader(value: unknown): SealedRunReaderPortV1 {
  if (!isSealedRunReader(value)) throw new TypeError("sealed run reader is not checkpoint-issued");
  return value;
}
