import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, truncateSync, openSync, writeSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { benchmarkFileSha256 } from "./live-stage.js";

test("benchmark hashes multi-GiB Ready inputs and detects changes without a whole-file read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mev-stage-hash-")), path = join(dir, "ready");
  try {
    const small = Buffer.from("source-bound Ready\n");
    writeFileSync(path, small);
    const digest = createHash("sha256").update(small).digest("hex");
    assert.equal(await benchmarkFileSha256(path), digest);
    writeFileSync(path, "changed");
    assert.notEqual(await benchmarkFileSha256(path), digest);
    writeFileSync(path, "");
    const size = 2 ** 31 + 17;
    truncateSync(path, size); // sparse file, no multi-GiB allocation/write
    const markers = new Map([[0, 19], [65535, 71], [65536, 33], [2 ** 31, 91], [size - 1, 243]]);
    const fd = openSync(path, "r+");
    try { for (const [offset, value] of markers) writeSync(fd, Buffer.from([value]), 0, 1, offset); }
    finally { closeSync(fd); }
    const chunk = Buffer.alloc(1024 * 1024), expected = createHash("sha256");
    for (let offset = 0; offset < size; offset += chunk.length) {
      chunk.fill(0);
      for (const [position, value] of markers) if (position >= offset && position < offset + chunk.length)
        chunk[position - offset] = value;
      expected.update(chunk.subarray(0, Math.min(size - offset, chunk.length)));
    }
    assert.equal(await benchmarkFileSha256(path), expected.digest("hex"));
    await assert.rejects(benchmarkFileSha256(join(dir, "missing")), { code: "ENOENT" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
