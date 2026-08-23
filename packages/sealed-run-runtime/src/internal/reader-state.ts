import type { SealedRunReaderPortV1 } from "../contract.ts";
const readers = new WeakSet<object>();
export function registerSealedRunReader(reader: SealedRunReaderPortV1): SealedRunReaderPortV1 {
  readers.add(reader);
  return reader;
}
export function isSealedRunReader(value: unknown): value is SealedRunReaderPortV1 {
  return value !== null && typeof value === "object" && readers.has(value);
}
