import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { envelopeFingerprint, type DurableVerifiedMemo } from "../universe-rebuild-checkpoint.js";

test("cold Ready load does not retain repeated scalar string allocations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ready-string-memory-"));
  const path = join(directory, "checkpoint.json");
  try {
    const text = "0123456789abcdef".repeat(128);
    const unsigned = {
      revision: 1,
      verifiedMemos: {
        probe: { rows: Array.from({ length: 16_000 }, (_, i) => ({ i, text })) } as unknown as DurableVerifiedMemo,
      },
      inProgressRun: null,
      retryableAttemptsByCandidateKey: {},
      readyGeneration: null,
    };
    const fingerprint = envelopeFingerprint(unsigned);
    await writeFile(path, JSON.stringify({ ...unsigned, checkpointFingerprint: fingerprint }));
    const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
    const before = digest(await readFile(path));
    const moduleUrl = new URL("../universe-rebuild-checkpoint.js", import.meta.url).href;
    const result = spawnSync(process.execPath, ["--expose-gc", "--import", "tsx", "--input-type=module", "--eval", `
      import assert from 'node:assert/strict';
      import { setImmediate as nextTurn } from 'node:timers/promises';
      const { UniverseRebuildCheckpointStore } = await import(${JSON.stringify(moduleUrl)});
      const gc = async () => { for (let i = 0; i < 3; i++) { await nextTurn(); global.gc(); } };
      await gc();
      const before = process.memoryUsage().heapUsed;
      const store = new UniverseRebuildCheckpointStore({ path: ${JSON.stringify(path)} });
      const value = await store.load();
      await gc();
      const retainedHeapBytes = process.memoryUsage().heapUsed - before;
      assert.equal(value.checkpointFingerprint, ${JSON.stringify(fingerprint)});
      const rows = value.verifiedMemos.probe.rows;
      assert.equal(rows.length, 16_000);
      for (let i = 0; i < rows.length; i++) {
        assert.equal(rows[i].i, i);
        assert.equal(rows[i].text, '0123456789abcdef'.repeat(128));
      }
      console.log(JSON.stringify({ retainedHeapBytes, rowCount: rows.length }));
    `], { encoding: "utf8", timeout: 60_000 });
    assert.equal(result.status, 0, result.stderr);
    const measured = JSON.parse(result.stdout.trim());
    // The original loader retained > 32 MB of duplicate text in this fixture.
    // This generous bound includes the rows and read/verification bookkeeping.
    assert.ok(measured.retainedHeapBytes < 12 * 1024 * 1024, JSON.stringify(measured));
    assert.equal(digest(await readFile(path)), before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
