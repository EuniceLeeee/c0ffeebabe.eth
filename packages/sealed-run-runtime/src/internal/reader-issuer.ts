import type { SealedRunReaderPortV1 } from "../contract.ts";
import { registerSealedRunReader } from "./reader-state.ts";
export function issueCheckpointSealedRunReader(reader: SealedRunReaderPortV1): SealedRunReaderPortV1 {
  if (reader === null || typeof reader !== "object") throw new TypeError("sealed run reader invalid");
  return registerSealedRunReader(reader);
}
