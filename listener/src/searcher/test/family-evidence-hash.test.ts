import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sha256EvidenceFile } from "./family-evidence-hash.js";

test("evidence hashing preserves empty files and partial final chunks", () => {
  const directory = mkdtempSync(join(tmpdir(), "family-evidence-hash-"));
  try {
    const path = join(directory, "evidence");
    for (const bytes of [Buffer.alloc(0), Buffer.from("source-pinned ready"), Buffer.alloc(1024 * 1024 + 19, 0x9b)]) {
      writeFileSync(path, bytes);
      assert.equal(sha256EvidenceFile(path), createHash("sha256").update(bytes).digest("hex"));
    }
    assert.throws(() => sha256EvidenceFile(directory), /regular file|EISDIR/);
    assert.throws(() => sha256EvidenceFile(join(directory, "absent")), /ENOENT/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("Ready evidence exceeding 2 GiB hashes in a bounded-memory process", () => {
  const directory = mkdtempSync(join(tmpdir(), "family-large-evidence-"));
  try {
    const path = join(directory, "ready.checkpoint");
    writeFileSync(path, "");
    truncateSync(path, 3_148_296_082);
    const moduleUrl = new URL("./family-evidence-hash.ts", import.meta.url).href;
    const code = `
      import assert from 'node:assert/strict';
      import { readFileSync } from 'node:fs';
      import { sha256EvidenceFile } from ${JSON.stringify(moduleUrl)};
      assert.throws(() => readFileSync(process.argv[1]), { code: 'ERR_FS_FILE_TOO_LARGE' });
      // Independently computed with Python hashlib over exactly this many zero bytes.
      assert.equal(sha256EvidenceFile(process.argv[1]),
        '946003bed04eeaec609b4be869a0aec8aa3b46b499bb6576fd4033d40b2fe76a');
      console.log(JSON.stringify({ bytes: 3148296082, maxRssKiB: process.resourceUsage().maxRSS }));
    `;
    const child = spawnSync(process.execPath,
      ["--max-old-space-size=64", "--import", "tsx", "--input-type=module", "--eval", code, path],
      { encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024 });
    assert.equal(child.status, 0, child.stderr || String(child.error));
    const report = JSON.parse(child.stdout);
    assert.equal(report.bytes, 3_148_296_082);
    assert(report.maxRssKiB < 256 * 1024, "hashing must not allocate a checkpoint-sized buffer");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
