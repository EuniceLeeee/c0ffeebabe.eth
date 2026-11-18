import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";

/** Ready checkpoints can exceed Node's single-Buffer limit. Hash every byte
 * without materializing the file, and reject an input replaced during the read. */
export function sha256EvidenceFile(path: string): string {
  const fd = openSync(path, "r");
  try {
    const before = fstatSync(fd, { bigint: true });
    assert(before.isFile(), "evidence input must be a regular file");
    const digest = createHash("sha256"), chunk = Buffer.allocUnsafe(1024 * 1024);
    let total = 0n;
    for (;;) {
      const length = readSync(fd, chunk, 0, chunk.length, null);
      if (length === 0) break;
      digest.update(chunk.subarray(0, length));
      total += BigInt(length);
    }
    const after = fstatSync(fd, { bigint: true }), current = statSync(path, { bigint: true });
    for (const observed of [after, current]) {
      assert(observed.dev === before.dev && observed.ino === before.ino &&
        observed.size === before.size && observed.mtimeNs === before.mtimeNs &&
        observed.ctimeNs === before.ctimeNs && total === before.size,
      "evidence file changed while hashing");
    }
    return digest.digest("hex");
  } finally {
    closeSync(fd);
  }
}
