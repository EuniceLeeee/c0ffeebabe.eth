import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

/** Publishes complete bytes with no replace; concurrent identical writers converge. */
export function writeImmutableFile(
  path: string,
  bytes: Uint8Array,
  changedMessage: string,
): void {
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    const descriptor = openSync(temporaryPath, "wx", 0o600);
    try {
      writeFileSync(descriptor, bytes);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    try {
      linkSync(temporaryPath, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new TypeError(`immutable path is not a regular file: ${path}`);
      if (!readFileSync(path).equals(Buffer.from(bytes))) throw new TypeError(`${changedMessage}: ${path}`);
    }
  } finally {
    try {
      unlinkSync(temporaryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
