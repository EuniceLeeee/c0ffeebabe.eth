import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  UniverseRebuildCheckpointStore, envelopeFingerprint, canonicalJson, canonicalJsonFingerprint,
  type DurableVerifiedMemo, type StartupCheckpointEnvelope,
} from "../universe-rebuild-checkpoint.js";
import { hashReadyCatalogSnapshot, hashReadyGraphSnapshot, hashReadyPublicationSet } from "../universe-rebuild-runner.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "checkpoint-stream-"));
  const path = join(directory, "checkpoint.json");
  return { path, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
function envelope(probe: unknown): StartupCheckpointEnvelope {
  const unsigned = {
    revision: 1,
    verifiedMemos: { probe: probe as DurableVerifiedMemo },
    inProgressRun: null,
    retryableAttemptsByCandidateKey: {},
    readyGeneration: null,
  };
  return { ...unsigned, checkpointFingerprint: envelopeFingerprint(unsigned) };
}

test("streamed catalog, graph and publication roots are byte-compatible with legacy canonical JSON", () => {
  const values = [null, true, 1.25, "中文😀", [], {}, { z: [3, -0, { a: 1, b: "\\\"" }], a: {} },
    JSON.parse('{"__proto__":{"x":1},"2":2,"1":1}')];
  for (const value of values) {
    for (const prefix of ["", "catalog-v1:", "graph-v2:", "publications-v2:", "universe-candidate-partition-v1:"]) {
      const expected = createHash("sha256").update(prefix + canonicalJson(value)).digest("hex");
      assert.equal(canonicalJsonFingerprint(value, prefix), expected);
    }
    assert.equal(hashReadyCatalogSnapshot(value), canonicalJsonFingerprint(value, "catalog-v1:"));
    assert.equal(hashReadyGraphSnapshot(value), canonicalJsonFingerprint(value, "graph-v2:"));
    assert.equal(hashReadyPublicationSet(value), canonicalJsonFingerprint(value, "publications-v2:"));
  }
  for (const value of [NaN, Infinity, undefined, 1n, new Date()]) assert.throws(() => canonicalJsonFingerprint(value));
});

test("catalog roots exceed V8's single-string capacity without changing the digest", {
  skip: process.env.MEV_CHECKPOINT_LARGE_IO_TEST !== "1",
}, () => {
  const entry = { text: "x".repeat(8 * 1024 * 1024) };
  const values = Array.from({ length: 65 }, () => entry);
  assert.throws(() => canonicalJson(values), /Invalid string length/);
  const encodedEntry = canonicalJson(entry);
  for (const [prefix, hash] of [
    ["catalog-v1:", hashReadyCatalogSnapshot],
    ["publications-v2:", hashReadyPublicationSet],
    ["graph-v2:", hashReadyGraphSnapshot],
  ] as const) {
    const expected = createHash("sha256").update(prefix + "[");
    for (let i = 0; i < values.length; i++) expected.update((i ? "," : "") + encodedEntry);
    expected.update("]");
    assert.equal(hash(values), expected.digest("hex"));
  }
});

test("nested JSON round-trips with scalar tokens and UTF-8 split at every byte", async () => {
  const f = await fixture();
  try {
    const probe = JSON.parse('{"__proto__":{"safe":true},"constructor":2,"empty":{},"array":[[],null,true,false,-12.5,1e-9,"中文😀","\\\\\\\"\\n\\u0000"],"0":"zero"}');
    const expected = envelope(probe);
    for (const chunkBytes of [1, 2, 3, 7, 64, 1024]) {
      await writeFile(f.path, JSON.stringify(expected, null, 2));
      const actual = await new UniverseRebuildCheckpointStore({ path: f.path, readChunkBytes: chunkBytes }).load();
      assert.deepEqual(actual, expected);
      assert.equal(Object.getPrototypeOf(actual!.verifiedMemos.probe), Object.prototype);
      assert.equal(Object.hasOwn(actual!.verifiedMemos.probe!, "__proto__"), true);
      assert.equal(({} as { safe?: boolean }).safe, undefined);
    }
  } finally { await f.cleanup(); }
});

test("nested duplicate keys match JSON.parse; duplicate root fields fail closed", async () => {
  const f = await fixture();
  try {
    const expected = envelope({ a: 2 });
    await writeFile(f.path, JSON.stringify(expected).replace('"a":2', '"a":1,"a":2'));
    assert.deepEqual(await new UniverseRebuildCheckpointStore({ path: f.path, readChunkBytes: 1 }).load(), expected);
    await writeFile(f.path, JSON.stringify(expected).replace('"revision":1', '"revision":1,"revision":1'));
    await assert.rejects(new UniverseRebuildCheckpointStore({ path: f.path }).load(), /duplicate top-level/);
    await assert.rejects(stat(f.path + ".lock"), { code: "ENOENT" });
  } finally { await f.cleanup(); }
});

test("malformed nested grammar, scalars and trailing content fail closed", async () => {
  const f = await fixture();
  try {
    const invalid = ['{"a":[1,]}', '{"a":{,}}', '{"a":{"b":1,}}', '{"a":[1 2]}',
      '{"a":{"b" 1}}', '{"a":01}', '{"a":tru}', '{"a":NaN}', '{"a":"\\x"}',
      '{"a":"\n"}', '{"a":[1}', '{"a":{]}', '{"a":true}{}', '{"a":true,}',
      '{"a":true}x', '{"a":', '[]', 'null', '{"a":1e}', '{1:2}', '{"a":false true}',
      '{"a":[,]}', '{"a":[1,,2]}', '{"a":{"b":[]', '{"a":"unterminated'];
    for (const raw of invalid) {
      await writeFile(f.path, raw);
      await assert.rejects(new UniverseRebuildCheckpointStore({ path: f.path, readChunkBytes: 1 }).load(), /not valid JSON/, raw);
      await assert.rejects(stat(f.path + ".lock"), { code: "ENOENT" });
    }
    await writeFile(f.path, " \n\t\r ");
    assert.equal(await new UniverseRebuildCheckpointStore({ path: f.path, readChunkBytes: 1 }).load(), null);
  } finally { await f.cleanup(); }
});

test("writer preserves compact JSON encoding, nested maps, arrays and cold-load fingerprint", async () => {
  const f = await fixture();
  try {
    const memo = {
      familyCandidateKey: "probe", candidateSnapshot: {
        nested: Array.from({ length: 5000 }, (_, i) => ({ i, text: "中文😀\\\"".repeat(20) })),
      },
    } as unknown as DurableVerifiedMemo;
    const original = envelope(memo);
    await writeFile(f.path, JSON.stringify(original));
    const store = new UniverseRebuildCheckpointStore({ path: f.path, readChunkBytes: 31 });
    const compacted = await store.casUpsertMemo(memo);
    assert.equal(compacted.revision, 2);
    assert.equal(await readFile(f.path, "utf8"), JSON.stringify(compacted) + "\n");
    assert.deepEqual(await new UniverseRebuildCheckpointStore({ path: f.path, readChunkBytes: 1023 }).load(), compacted);
    assert.deepEqual(compacted.verifiedMemos, original.verifiedMemos);
  } finally { await f.cleanup(); }
});

async function journalFixture() {
  const f = await fixture();
  const store = new UniverseRebuildCheckpointStore({ path: f.path });
  const source = { number: 100, hash: "0x" + "a1".repeat(32), generation: 1 };
  await store.beginOrResumeRun({
    expectedRevision: 0, runId: "stream-test", cutoff: source, fromBlock: 1,
    universeHash: "universe", candidateSetHash: "candidates", candidateCount: 2,
    candidatesByKey: { a: { id: "a" }, b: { id: "b" } }, observedThrough: source,
    sourceReceipts: [{ sourceKey: "1".repeat(64), sourceKind: "startup-candidate-union",
      providerIdentity: "fixture", queryFingerprint: "2".repeat(64), fromBlock: 1,
      toBlock: 100, cutoffNumber: 100, cutoffHash: source.hash, coverageKeys: ["fixture|startup-universe"],
      completedChunks: [{ fromBlock: 1, toBlock: 100, resultCount: 2, resultHash: "3".repeat(64) }],
      observationSetHash: "4".repeat(64), observedThrough: source, appliedThrough: source,
      retryableCount: 0, status: "complete" }],
  });
  const outcome = (key: string) => ({ status: "terminal-rejected" as const,
    familyCandidateKey: key, reasonCode: "拒绝😀", familyDefinitionHash: "definition",
    requestFingerprint: "request", trustedResultsFingerprint: "trusted", authorityFingerprint: "authority",
    candidateFingerprint: "candidate", cutoff: source });
  return { ...f, store, outcome, journal: f.path + ".attestation-journal" };
}

test("journal UTF-8 byte offsets retain LF-committed records and repair only torn tail", async () => {
  const f = await journalFixture();
  try {
    const before = await f.store.casMergeRunOutcomes("stream-test", [f.outcome("a")]);
    const committed = await readFile(f.journal);
    await appendFile(f.journal, Buffer.concat([Buffer.from('{"残尾":"'), Buffer.from([0xf0, 0x9f])]));
    const store = new UniverseRebuildCheckpointStore({ path: f.path, readChunkBytes: 1 });
    assert.deepEqual(await store.load(), before);
    const after = await store.casMergeRunOutcomes("stream-test", [f.outcome("b")]);
    const bytes = await readFile(f.journal);
    assert.deepEqual(bytes.subarray(0, committed.length), committed);
    assert.equal(bytes.toString("utf8").includes("残尾"), false);
    assert.deepEqual(await new UniverseRebuildCheckpointStore({ path: f.path, readChunkBytes: 3 }).load(), after);
  } finally { await f.cleanup(); }
});

test("empty or LF-free journal is uncommitted; complete invalid records release lock and fail", async () => {
  const f = await journalFixture();
  try {
    const base = await f.store.load();
    for (const raw of ["", "\n\n", "not-json", '{"partial":']) {
      await writeFile(f.journal, raw);
      assert.deepEqual(await new UniverseRebuildCheckpointStore({ path: f.path, readChunkBytes: 2 }).load(), base);
    }
    for (const raw of ["not-json\n", "{}\n", " \n"]) {
      await writeFile(f.journal, raw);
      await assert.rejects(new UniverseRebuildCheckpointStore({ path: f.path, readChunkBytes: 2 }).load(), /journal/);
      await assert.rejects(stat(f.path + ".lock"), { code: "ENOENT" });
    }
  } finally { await f.cleanup(); }
});

test("complete journal tampering, reordering and replay conflicts stay fail-closed", async () => {
  const f = await journalFixture();
  try {
    await f.store.casMergeRunOutcomes("stream-test", [f.outcome("a")]);
    await f.store.casMergeRunOutcomes("stream-test", [f.outcome("b")]);
    const raw = await readFile(f.journal, "utf8"), lines = raw.trimEnd().split("\n");
    for (const corrupt of [raw.replace("拒绝", "改动"), lines.reverse().join("\n") + "\n", raw + raw]) {
      await writeFile(f.journal, corrupt);
      await assert.rejects(new UniverseRebuildCheckpointStore({ path: f.path, readChunkBytes: 7 }).load(), /fingerprint|revision|compacted-state/);
      await assert.rejects(stat(f.path + ".lock"), { code: "ENOENT" });
    }
  } finally { await f.cleanup(); }
});

test("journal read failure and partial envelope write close handles and preserve incumbent bytes", async t => {
  const f = await journalFixture();
  const open = fs.open;
  let closed = 0;
  try {
    await f.store.casMergeRunOutcomes("stream-test", [f.outcome("a")]);
    const base = await readFile(f.path), journal = await readFile(f.journal);
    for (const failure of ["read", "write"]) {
      closed = 0;
      t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
        const file = await open(...args), path = String(args[0]);
        const fail = failure === "read" ? path === f.journal : path.startsWith(f.path + ".tmp.");
        if (!fail) return file;
        return new Proxy(file, {
          get(target, property) {
            if (property === "close") return async () => { closed++; return target.close(); };
            if (property === (failure === "read" ? "read" : "writeFile")) return async () => {
              if (failure === "write") await target.writeFile('{"partial":');
              throw Object.assign(new Error("injected EIO"), { code: "EIO" });
            };
            const value = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      });
      syncBuiltinESMExports();
      const store = new UniverseRebuildCheckpointStore({ path: f.path });
      await assert.rejects(failure === "read" ? store.load() : store.casUpsertMemo({ familyCandidateKey: "probe" } as DurableVerifiedMemo), /injected EIO/);
      assert.equal(closed, 1);
      await assert.rejects(stat(f.path + ".lock"), { code: "ENOENT" });
      assert.deepEqual(await readFile(f.path), base);
      assert.deepEqual(await readFile(f.journal), journal);
      t.mock.restoreAll(); syncBuiltinESMExports();
    }
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await f.cleanup(); }
});

test("status raw JSON export streams the same envelope with stdout backpressure", async () => {
  const f = await fixture();
  try {
    const expected = envelope({ nested: Array.from({ length: 3000 }, (_, i) => ({ i, text: "中文😀".repeat(50) })) });
    await writeFile(f.path, JSON.stringify(expected));
    const result = spawnSync(process.execPath, [
      "--import", "tsx", fileURLToPath(new URL("../universe-rebuild-status-cli.ts", import.meta.url)),
      "--checkpoint", f.path, "--json",
    ], { cwd: fileURLToPath(new URL("../../..", import.meta.url)), encoding: "utf8", maxBuffer: 16 * 1024 ** 2 });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), expected);
    await assert.rejects(stat(f.path + ".lock"), { code: "ENOENT" });
  } finally { await f.cleanup(); }
});
