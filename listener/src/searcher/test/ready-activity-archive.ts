import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { cp, mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import zlib, { gzipSync, gunzipSync } from "node:zlib";
import { ReadyActivityArchive, READY_ACTIVITY_MAX_ENTRY_BYTES } from "../ready-activity-archive.js";
import type { ReadyActivityArchiveOptions } from "../ready-activity-archive.js";

const cutoffHash = `0x${"ab".repeat(32)}`;
const method = "trace_block" as const;
const range = { fromBlock: 100, toBlock: 102 };
const logsName = "logs-eth_getLogs-100-102";
const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const classifierKey = sha("test-parser-and-family-identity/v1");

function workCounts(t: TestContext) {
  const counts = { decompressions: 0, arrays: 0 };
  const gunzip = zlib.createGunzip, parse = JSON.parse;
  const gzipMock = t.mock.method(zlib, "createGunzip", (...args: Parameters<typeof gunzip>) => {
    counts.decompressions++; return gunzip(...args);
  });
  t.mock.method(JSON, "parse", (text: string, reviver?: Parameters<typeof parse>[1]) => {
    if (text.startsWith("[")) counts.arrays++;
    return parse(text, reviver);
  });
  syncBuiltinESMExports();
  t.after(() => { gzipMock.mock.restore(); syncBuiltinESMExports(); });
  return counts;
}

async function cachePaths(directory: string): Promise<string[]> {
  const base = `${directory}.classified-v1`;
  return (await readdir(base)).filter(name => /^[0-9a-f]{64}$/.test(name)).map(name => join(base, name));
}

async function alterReceipt(path: string, changes: Record<string, unknown>) {
  const { receiptSha256: _, ...receipt } = JSON.parse(await readFile(join(path, "receipt.json"), "utf8"));
  Object.assign(receipt, changes);
  await writeFile(join(path, "receipt.json"), JSON.stringify({ ...receipt, receiptSha256: sha(JSON.stringify(receipt)) }));
}

async function replacePayload(path: string, text: string) {
  const gzip = gzipSync(text);
  await writeFile(join(path, "data.json.gz"), gzip);
  await alterReceipt(path, { rawBytes: Buffer.byteLength(text), gzipBytes: gzip.length, rawSha256: sha(text), gzipSha256: sha(gzip) });
}

async function fixture(run: (directory: string, options: ReadyActivityArchiveOptions) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "ready-activity-archive-test-"));
  const directory = join(root, "archive");
  try { await run(directory, { directory, chainId: 1, ...range, cutoffHash }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function complete(archive: ReadyActivityArchive) {
  await archive.writeLogs({ ...range, logs: [] });
  for (let blockNumber = 100; blockNumber <= 102; blockNumber++) {
    await archive.writeTrace({ blockNumber, method, trace: [] });
  }
}

test("assertScope synchronously matches every constructor field exactly without I/O", async () => fixture(async (directory, options) => {
  const archive = new ReadyActivityArchive(options);
  const scope = { chainId: options.chainId, ...range, cutoffHash };
  assert.equal(archive.assertScope(scope), undefined);
  for (const override of [{ chainId: 2 }, { fromBlock: 99 }, { fromBlock: 101 },
    { toBlock: 101 }, { toBlock: 103 }, { cutoffHash: `0x${"cd".repeat(32)}` },
    { cutoffHash: `0x${"AB".repeat(32)}` }, { chainId: NaN }, { cutoffHash: "" }]) {
    assert.throws(() => archive.assertScope({ ...scope, ...override }), /scope mismatch/);
  }
  // Capture constructor values, not the caller's subsequently mutable options.
  options.chainId = 2;
  options.cutoffHash = `0x${"cd".repeat(32)}`;
  assert.equal(archive.assertScope(scope), undefined);
  assert.throws(() => archive.assertScope(options), /scope mismatch/);
  const uppercaseScope = { ...scope, cutoffHash: `0x${"AB".repeat(32)}` };
  const uppercaseArchive = new ReadyActivityArchive({ directory, ...uppercaseScope });
  assert.equal(uppercaseArchive.assertScope(uppercaseScope), undefined);
  assert.throws(() => uppercaseArchive.assertScope(scope), /scope mismatch/);
  await assert.rejects(stat(directory), { code: "ENOENT" });
}));

test("optional entry ceiling bounds reads/writes without changing archive identity or existing bytes", async () => fixture(async (directory, options) => {
  const archive = new ReadyActivityArchive(options);
  const bounded = archive.withEntryLimit(64);
  assert.equal(archive.maxEntryBytes, READY_ACTIVITY_MAX_ENTRY_BYTES);
  assert.equal(bounded.maxEntryBytes, 64);
  assert.equal(bounded.withEntryLimit(128), bounded, "a bounded handle cannot widen its own ceiling");
  bounded.assertScope(options);
  const exact = ["x".repeat(60)]; // 64 canonical JSON bytes including brackets/quotes.
  await bounded.writeLogs({ ...range, logs: exact });
  const original = await readFile(join(directory, logsName, "data.json.gz"));
  assert.deepEqual(await archive.readLogs(range), exact);
  assert.deepEqual(await bounded.readLogs(range), exact);
  await assert.rejects(bounded.writeLogs({ ...range, logs: ["x".repeat(61)] }), /entry exceeds/);
  assert.deepEqual(await readFile(join(directory, logsName, "data.json.gz")), original);
  await archive.writeTrace({ blockNumber: 100, method, trace: ["x".repeat(61)] });
  await assert.rejects(bounded.readTrace({ blockNumber: 100, method }), /configured read byte limit/);
  await assert.rejects(bounded.coverage({ method }), /configured read byte limit/);
  assert.deepEqual(await archive.readTrace({ blockNumber: 100, method }), ["x".repeat(61)]);
  assert.equal(JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")).maxEntryBytes, READY_ACTIVITY_MAX_ENTRY_BYTES);
  const resumed = new ReadyActivityArchive({ ...options, maxEntryBytes: 64 });
  assert.deepEqual(await resumed.readLogs(range), exact);
  for (const maxEntryBytes of [0, 1, NaN, Infinity, 2.5, READY_ACTIVITY_MAX_ENTRY_BYTES + 1]) {
    assert.throws(() => new ReadyActivityArchive({ ...options, maxEntryBytes }), /invalid entry byte limit/);
    assert.throws(() => archive.withEntryLimit(maxEntryBytes), /invalid entry byte limit/);
  }
}));

test("successful assertScope does not bypass manifest validation on either read API", async () => fixture(async (directory, options) => {
  const archive = new ReadyActivityArchive(options);
  await archive.writeLogs({ ...range, logs: [] });
  await archive.writeTrace({ blockNumber: 100, method, trace: [] });
  archive.assertScope(options);
  const path = join(directory, "manifest.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...manifest, chainId: 2 }));
  assert.equal(archive.assertScope(options), undefined);
  await assert.rejects(archive.readLogs(range), /context mismatch/);
  await assert.rejects(archive.readTrace({ blockNumber: 100, method }), /context mismatch/);
}));

test("constructor/read have no write side effects; context and operation bounds", async () => fixture(async (directory, options) => {
  const archive = new ReadyActivityArchive(options);
  assert.equal(await archive.readLogs(range), null);
  assert.equal(await archive.readTrace({ blockNumber: 100, method }), null);
  assert.deepEqual((await archive.coverage({ method })).missingLogs, [range]);
  await assert.rejects(stat(directory), { code: "ENOENT" });
  for (const override of [{ chainId: 0 }, { chainId: 1.5 }, { fromBlock: -1 }, { toBlock: 99 },
    { toBlock: 14_500 }, { cutoffHash: "not-a-hash" }]) {
    assert.throws(() => new ReadyActivityArchive({ ...options, ...override }), /invalid archive context/);
  }
  new ReadyActivityArchive({ ...options, fromBlock: 1, toBlock: 14_400 });
  await assert.rejects(archive.readLogs({ fromBlock: 99, toBlock: 100 }), /bounds/);
  await assert.rejects(archive.writeLogs({ fromBlock: 100, toBlock: 103, logs: [] }), /bounds/);
  await assert.rejects(archive.readTrace({ blockNumber: 103, method }), /bounds/);
  await assert.rejects(archive.readTrace({ blockNumber: 100, method: "wrong" as typeof method }), /unsupported/);
}));

test("gzip roundtrip preserves full raw nested JSON, empty arrays and Unicode", async () => fixture(async (directory, options) => {
  const archive = new ReadyActivityArchive(options);
  const logs = [{ blockNumber: "0x64", topics: ["0xabc"], data: "0x" + "ab".repeat(80000),
    extra: { null: null, yes: true, zero: 0, text: '"\\\n' + "a".repeat(8191) + "😀\ud800" } }];
  await archive.writeLogs({ ...range, logs });
  assert.deepEqual(await archive.readLogs(range), logs);
  const compressed = await readFile(join(directory, logsName, "data.json.gz"));
  assert.equal(compressed.readUInt16BE(0), 0x1f8b);
  assert.ok(compressed.length < JSON.stringify(logs).length / 10);
  assert.deepEqual(JSON.parse(gunzipSync(compressed).toString()), logs);
  await archive.writeTrace({ blockNumber: 100, method, trace: [] });
  await archive.writeTrace({ blockNumber: 101, method: "debug_traceBlockByNumber", trace: [{ result: { calls: [] } }] });
  assert.deepEqual(await archive.readTrace({ blockNumber: 100, method }), []);
  assert.deepEqual(await archive.readTrace({ blockNumber: 101, method: "debug_traceBlockByNumber" }), [{ result: { calls: [] } }]);
  assert.equal(await archive.readTrace({ blockNumber: 101, method }), null);
  // Exact keys: a subset cannot be fabricated by filtering an opaque raw array.
  assert.equal(await archive.readLogs({ fromBlock: 100, toBlock: 101 }), null);
}));

test("manifest pins identity and source metadata, rejects every context mismatch without changing bytes", async () => fixture(async (directory, options) => {
  const archive = new ReadyActivityArchive(options);
  await archive.writeLogs({ ...range, logs: ["original"] });
  const original = await readFile(join(directory, logsName, "data.json.gz"));
  const manifestBytes = await readFile(join(directory, "manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString());
  assert.equal(manifest.source.logs, "eth_getLogs");
  assert.equal(manifest.cutoffHash, cutoffHash);
  for (const override of [{ chainId: 2 }, { fromBlock: 99 }, { toBlock: 103 }, { cutoffHash: `0x${"cd".repeat(32)}` }]) {
    const foreign = new ReadyActivityArchive({ ...options, ...override });
    await assert.rejects(foreign.readLogs(range), /context mismatch/);
    await assert.rejects(foreign.writeLogs({ ...range, logs: [] }), /context mismatch/);
    await assert.rejects(foreign.coverage({ method }), /context mismatch/);
  }
  await writeFile(join(directory, "manifest.json"), JSON.stringify({ ...manifest, schema: "other/v2" }));
  await assert.rejects(archive.readLogs(range), /context mismatch/);
  assert.deepEqual(await readFile(join(directory, logsName, "data.json.gz")), original);
}));

test("tampered gzip and receipt fail closed, including duplicate writes and completion", async () => fixture(async (directory, options) => {
  const archive = new ReadyActivityArchive(options);
  await complete(archive);
  const path = join(directory, logsName, "data.json.gz");
  const original = await readFile(path);
  const damaged = Buffer.from(original); damaged[damaged.length - 1] ^= 1;
  await writeFile(path, damaged);
  await assert.rejects(archive.readLogs(range));
  await assert.rejects(archive.assertComplete({ method }));
  await assert.rejects(archive.writeLogs({ ...range, logs: [] }));
  assert.deepEqual(await readFile(path), damaged);
  await writeFile(path, original);
  const receiptPath = join(directory, logsName, "receipt.json");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  await writeFile(receiptPath, JSON.stringify({ ...receipt, count: 1000 }));
  await assert.rejects(archive.readLogs(range), /receipt/);
  await assert.rejects(archive.assertComplete({ method }), /receipt/);
}));

test("valid gzip replacement is detected by SHA; foreign copied entries are rejected", async () => fixture(async (directory, options) => {
  const archive = new ReadyActivityArchive(options);
  await archive.writeLogs({ ...range, logs: ["a"] });
  const path = join(directory, logsName, "data.json.gz");
  await writeFile(path, gzipSync('["b"]'));
  await assert.rejects(archive.readLogs(range), /hash mismatch/);
  const foreignDir = join(directory, "..", "foreign");
  const foreign = new ReadyActivityArchive({ ...options, directory: foreignDir, chainId: 2 });
  await foreign.writeLogs({ ...range, logs: [] });
  await writeFile(join(directory, logsName, "receipt.json"), await readFile(join(foreignDir, logsName, "receipt.json")));
  await assert.rejects(archive.readLogs(range), /metadata mismatch/);
}));

test("incomplete scratch files never prove completion; incomplete published entry throws", async () => fixture(async (directory, options) => {
  const archive = new ReadyActivityArchive(options);
  await archive.writeTrace({ blockNumber: 100, method, trace: [] });
  const scratch = join(directory, ".pending-11111111-1111-4111-8111-111111111111");
  await mkdir(scratch); await writeFile(join(scratch, "data.json.gz"), "partial");
  assert.equal(await archive.readLogs(range), null);
  await assert.rejects(archive.assertComplete({ method }), /incomplete/);
  await archive.writeLogs({ ...range, logs: [] });
  assert.equal(await readFile(join(scratch, "data.json.gz"), "utf8"), "partial");
  await mkdir(join(directory, "trace-trace_block-101-101"));
  await assert.rejects(archive.readTrace({ blockNumber: 101, method }), /receipt/);
  await assert.rejects(archive.coverage({ method }), /receipt/);
}));

test("coverage reports real gaps, requires one selected trace method and supports resume", async () => fixture(async (_directory, options) => {
  let archive = new ReadyActivityArchive(options);
  await archive.writeLogs({ fromBlock: 100, toBlock: 100, logs: [] });
  await archive.writeLogs({ fromBlock: 102, toBlock: 102, logs: [] });
  await archive.writeTrace({ blockNumber: 100, method, trace: [] });
  await archive.writeTrace({ blockNumber: 101, method: "debug_traceBlockByNumber", trace: [] });
  let report = await archive.coverage({ method });
  assert.deepEqual(report.missingLogs, [{ fromBlock: 101, toBlock: 101 }]);
  assert.deepEqual(report.missingTraceBlocks, [101, 102]);
  assert.equal(report.complete, false);
  archive = new ReadyActivityArchive(options);
  await archive.writeLogs({ fromBlock: 101, toBlock: 101, logs: [] });
  for (const blockNumber of [101, 102]) await archive.writeTrace({ blockNumber, method, trace: [] });
  report = await archive.assertComplete({ method });
  assert.equal(report.complete, true);
  assert.deepEqual(report.stats, { entries: 7, logChunks: 3, traceBlocks: 4, items: 0, rawBytes: 14, gzipBytes: 154 });
  await assert.rejects(archive.assertComplete({ method: "debug_traceBlockByNumber" }), /incomplete/);
}));

test("overlapping chunks cannot replace bytes or double count coverage, including concurrent writers", async () => fixture(async (directory, options) => {
  const a = new ReadyActivityArchive(options), b = new ReadyActivityArchive(options);
  const results = await Promise.allSettled([
    a.writeLogs({ fromBlock: 100, toBlock: 101, logs: [] }),
    b.writeLogs({ fromBlock: 101, toBlock: 102, logs: [] }),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.match(String((results.find(result => result.status === "rejected") as PromiseRejectedResult).reason), /overlapping/);
  const report = await a.coverage({ method });
  assert.equal(report.stats.logChunks, 1);
  assert.equal(report.missingLogs.length, 1);
  assert.equal((await readdir(directory)).filter(name => name.startsWith("logs-")).length, 1);
}));

test("duplicate writes canonicalize object keys; same data succeeds and different data preserves winner bytes", async () => fixture(async (directory, options) => {
  const a = new ReadyActivityArchive(options), b = new ReadyActivityArchive(options);
  await Promise.all([
    a.writeLogs({ ...range, logs: [{ a: 1, b: 2 }] }),
    b.writeLogs({ ...range, logs: [{ b: 2, a: 1 }] }),
  ]);
  const path = join(directory, logsName, "data.json.gz");
  const original = await readFile(path);
  await assert.rejects(b.writeLogs({ ...range, logs: [{ a: 2, b: 2 }] }), /conflicting/);
  assert.deepEqual(await readFile(path), original);
  const results = await Promise.allSettled([
    a.writeTrace({ blockNumber: 100, method, trace: ["a"] }),
    b.writeTrace({ blockNumber: 100, method, trace: ["b"] }),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.match(String((results.find(result => result.status === "rejected") as PromiseRejectedResult).reason), /conflicting/);
  assert.ok(!(await readdir(directory)).some(name => name.startsWith(".")));
}));

test("publication is consistent across independent processes", async () => fixture(async (directory, options) => {
  const moduleURL = new URL("../ready-activity-archive.ts", import.meta.url).href;
  const script = `import {ReadyActivityArchive} from ${JSON.stringify(moduleURL)};
    await new ReadyActivityArchive(${JSON.stringify(options)}).writeLogs({...${JSON.stringify(range)}, logs:[{ok:true}]});`;
  const run = () => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe"] });
    let error = "";
    child.stderr.on("data", chunk => { error += String(chunk); });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(error)));
  });
  await Promise.all([run(), run()]);
  assert.deepEqual(await new ReadyActivityArchive(options).readLogs(range), [{ ok: true }]);
  assert.equal((await readdir(directory)).length, 2);
}));

test("non JSON-safe responses fail without publishing, including a late serialization failure", async () => fixture(async (directory, options) => {
  const archive = new ReadyActivityArchive(options);
  const cycle: unknown[] = []; cycle.push(cycle);
  for (const logs of [[undefined], [NaN], [Infinity], [1n], [() => 1], [new Date()], cycle,
    new Array(2), [{ get value() { throw new Error("getter must not run"); } }], ["x".repeat(70000), undefined]]) {
    await assert.rejects(archive.writeLogs({ ...range, logs }));
    assert.equal(await archive.readLogs(range), null);
  }
  assert.deepEqual(await readdir(directory), ["manifest.json"]);
  await archive.writeLogs({ ...range, logs: [] });
  assert.deepEqual(await archive.readLogs(range), []);
}));

test("256 MiB entry bound rejects a streamed oversized response without publishing or altering prior data", async () => fixture(async (directory, options) => {
  const archive = new ReadyActivityArchive(options);
  await archive.writeLogs({ ...range, logs: ["keep"] });
  const original = await readFile(join(directory, logsName, "data.json.gz"));
  // Reuse one small string in memory; exercise the real streamed byte limit.
  const logs = Array(READY_ACTIVITY_MAX_ENTRY_BYTES / (1024 * 1024) + 1).fill("x".repeat(1024 * 1024));
  await assert.rejects(archive.writeLogs({ ...range, logs }), /exceeds 256 MiB/);
  assert.deepEqual(await readFile(join(directory, logsName, "data.json.gz")), original);
  assert.ok(!(await readdir(directory)).some(name => name.startsWith(".")));
}));

test("decompression bound is enforced even for valid gzip and a self-consistent receipt checksum", async () => fixture(async (directory, options) => {
  const archive = new ReadyActivityArchive(options);
  await archive.writeLogs({ ...range, logs: ["x".repeat(100000)] });
  const path = join(directory, logsName, "receipt.json");
  const { receiptSha256: _, ...receipt } = JSON.parse(await readFile(path, "utf8"));
  receipt.rawBytes = 2;
  await writeFile(path, JSON.stringify({ ...receipt, receiptSha256: sha(JSON.stringify(receipt)) }));
  await assert.rejects(archive.readLogs(range), /decompressed entry exceeds/);
}));

test("missing manifest, missing payload, symlinks and foreign entry names fail closed", async () => fixture(async (directory, options) => {
  const archive = new ReadyActivityArchive(options);
  await archive.writeLogs({ ...range, logs: [] });
  const manifestPath = join(directory, "manifest.json"), manifest = await readFile(manifestPath);
  await rm(manifestPath);
  await assert.rejects(archive.readLogs(range), /manifest/);
  await assert.rejects(archive.writeLogs({ ...range, logs: [] }), /manifest/);
  await assert.rejects(new ReadyActivityArchive(options).readLogs(range), /missing manifest/);
  await writeFile(manifestPath, manifest);
  const path = join(directory, logsName, "data.json.gz");
  await rm(path);
  await assert.rejects(archive.readLogs(range));
  await symlink(manifestPath, path);
  await assert.rejects(archive.readLogs(range));
  await mkdir(join(directory, "logs-eth_getLogs-99-99"));
  await assert.rejects(archive.coverage({ method }));
}));

test("coverage rejects valid but overlapping disk receipts and out-of-range entry keys", async () => fixture(async (directory, options) => {
  const archive = new ReadyActivityArchive(options);
  await archive.writeLogs({ fromBlock: 100, toBlock: 101, logs: [] });
  const sibling = join(directory, "..", "sibling");
  await new ReadyActivityArchive({ ...options, directory: sibling }).writeLogs({ fromBlock: 101, toBlock: 102, logs: [] });
  const overlapping = "logs-eth_getLogs-101-102";
  await cp(join(sibling, overlapping), join(directory, overlapping), { recursive: true });
  await assert.rejects(archive.coverage({ method }), /overlapping/);
  await rm(join(directory, overlapping), { recursive: true });
  await mkdir(join(directory, "trace-trace_block-103-103"));
  await assert.rejects(archive.coverage({ method }), /bounds/);
}));

test("the successful initial writer pins the context during a foreign-context race", async () => fixture(async (directory, options) => {
  const a = new ReadyActivityArchive(options);
  const b = new ReadyActivityArchive({ ...options, chainId: 2 });
  const results = await Promise.allSettled([
    a.writeLogs({ ...range, logs: ["chain1"] }),
    b.writeLogs({ ...range, logs: ["chain2"] }),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.match(String((results.find(result => result.status === "rejected") as PromiseRejectedResult).reason), /context mismatch/);
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  const winner = manifest.chainId === 1 ? a : b;
  assert.deepEqual(await winner.readLogs(range), [manifest.chainId === 1 ? "chain1" : "chain2"]);
}));

test("legacy v1 raw archives migrate lazily without rewriting raw bytes or decompressing twice", async t => fixture(async (directory, options) => {
  // Construct an old v1 entry independently of the current writer.
  const manifest = JSON.stringify({ schema: "ready-activity-archive/v1", chainId: 1, ...range, cutoffHash,
    source: { logs: "eth_getLogs", traceMethods: ["trace_block", "debug_traceBlockByNumber"], responses: "complete-raw-arrays" },
    encoding: "canonical-json+gzip", maxEntryBytes: READY_ACTIVITY_MAX_ENTRY_BYTES }) + "\n";
  const raw = '["legacy-raw"]', gzip = gzipSync(raw);
  const receipt = { kind: "logs", method: "eth_getLogs", ...range, contextHash: sha(manifest),
    rawBytes: Buffer.byteLength(raw), gzipBytes: gzip.length, count: 1, rawSha256: sha(raw), gzipSha256: sha(gzip) };
  const receiptText = JSON.stringify({ ...receipt, receiptSha256: sha(JSON.stringify(receipt)) });
  await mkdir(join(directory, logsName), { recursive: true });
  await writeFile(join(directory, "manifest.json"), manifest);
  await writeFile(join(directory, logsName, "receipt.json"), receiptText);
  await writeFile(join(directory, logsName, "data.json.gz"), gzip);
  const counts = workCounts(t), archive = new ReadyActivityArchive(options);
  assert.equal(await archive.readClassifiedLogs(range, classifierKey), null);
  await assert.rejects(stat(`${directory}.classified-v1`), { code: "ENOENT" });
  assert.deepEqual(counts, { decompressions: 0, arrays: 0 });
  assert.deepEqual(await archive.readLogs(range), ["legacy-raw"]);
  await archive.writeClassifiedLogs(range, classifierKey, [{ selected: "legacy-raw" }]);
  await archive.coverage({ method });
  await archive.coverage({ method });
  assert.deepEqual(counts, { decompressions: 1, arrays: 1 });
  assert.deepEqual((await readdir(directory)).sort(), [logsName, "manifest.json"]);
  assert.equal(await readFile(join(directory, "manifest.json"), "utf8"), manifest);
  assert.equal(await readFile(join(directory, logsName, "receipt.json"), "utf8"), receiptText);
  assert.deepEqual(await readFile(join(directory, logsName, "data.json.gz")), gzip);
}));

test("fresh writes and repeated coverage reuse verification; resumed cache hits decode only derived arrays", async t => fixture(async (_directory, options) => {
  const counts = workCounts(t), archive = new ReadyActivityArchive(options);
  await complete(archive);
  await archive.writeClassifiedLogs(range, classifierKey, []);
  const trace = [{ digestInput: '{"call":1}\0{"call":2}\0', representatives: [{ candidate: { id: "local" } }] }];
  for (let blockNumber = 100; blockNumber <= 102; blockNumber++) {
    await archive.writeClassifiedTrace({ blockNumber, method }, classifierKey, trace);
  }
  const expected = await archive.assertComplete({ method });
  assert.equal(expected.stats.entries, 4, "derived entries are not raw coverage");
  assert.deepEqual(await archive.assertComplete({ method }), expected);
  assert.deepEqual(counts, { decompressions: 0, arrays: 0 });
  const resumed = new ReadyActivityArchive(options);
  assert.deepEqual(await resumed.readClassifiedLogs(range, classifierKey), []);
  for (let blockNumber = 100; blockNumber <= 102; blockNumber++) {
    assert.deepEqual(await resumed.readClassifiedTrace({ blockNumber, method }, classifierKey), trace);
  }
  assert.deepEqual(counts, { decompressions: 4, arrays: 4 });
  assert.deepEqual(await resumed.assertComplete({ method }), expected);
  assert.deepEqual(await resumed.assertComplete({ method }), expected);
  assert.deepEqual(counts, { decompressions: 4, arrays: 4 });
  // Merely finding a cache on disk is never verification or proof of coverage.
  const independent = new ReadyActivityArchive(options);
  await independent.assertComplete({ method });
  await independent.assertComplete({ method });
  assert.deepEqual(counts, { decompressions: 8, arrays: 8 });
}));

test("classification misses, exact keys and partial progress survive independent readers", async () => fixture(async (directory, options) => {
  const archive = new ReadyActivityArchive(options), key = { blockNumber: 100, method };
  assert.equal(await archive.readClassifiedLogs(range, classifierKey), null);
  assert.equal(await archive.readClassifiedTrace(key, classifierKey), null);
  await assert.rejects(archive.writeClassifiedLogs(range, classifierKey, []), /missing raw entry/);
  await assert.rejects(archive.writeClassifiedTrace(key, classifierKey, []), /missing raw entry/);
  await assert.rejects(stat(directory), { code: "ENOENT" });
  for (const bad of ["", "../escape", "0x" + classifierKey, "g".repeat(64), "a".repeat(63)]) {
    await assert.rejects(archive.readClassifiedLogs(range, bad), /classifier key/);
    await assert.rejects(archive.writeClassifiedLogs(range, bad, []), /classifier key/);
    await assert.rejects(archive.readClassifiedTrace(key, bad), /classifier key/);
    await assert.rejects(archive.writeClassifiedTrace(key, bad, []), /classifier key/);
  }
  await complete(archive);
  await archive.writeTrace({ blockNumber: 100, method: "debug_traceBlockByNumber", trace: [] });
  await archive.writeClassifiedLogs(range, classifierKey.toUpperCase(), [{ selected: true }]);
  await archive.writeClassifiedTrace(key, classifierKey, []);
  const resumed = new ReadyActivityArchive(options);
  assert.deepEqual(await resumed.readClassifiedLogs(range, classifierKey), [{ selected: true }]);
  assert.deepEqual(await resumed.readClassifiedTrace(key, classifierKey.toUpperCase()), []);
  assert.equal(await resumed.readClassifiedTrace({ blockNumber: 101, method }, classifierKey), null);
  assert.equal(await resumed.readClassifiedTrace({ blockNumber: 100, method: "debug_traceBlockByNumber" }, classifierKey), null);
  assert.equal(await resumed.readClassifiedLogs({ fromBlock: 100, toBlock: 101 }, classifierKey), null);
  const changedFamilyKey = sha("test-parser-and-family-identity/v2");
  assert.equal(await resumed.readClassifiedLogs(range, changedFamilyKey), null);
  await resumed.writeClassifiedLogs(range, changedFamilyKey, []);
  await resumed.writeClassifiedTrace({ blockNumber: 101, method }, classifierKey, [{ resumed: true }]);
  assert.deepEqual(await new ReadyActivityArchive(options).readClassifiedTrace({ blockNumber: 101, method }, classifierKey), [{ resumed: true }]);
  assert.deepEqual(await archive.readClassifiedLogs(range, classifierKey), [{ selected: true }]);
  await assert.rejects(archive.readClassifiedLogs({ fromBlock: 99, toBlock: 100 }, classifierKey), /bounds/);
  await assert.rejects(archive.writeClassifiedTrace({ blockNumber: 103, method }, classifierKey, []), /bounds/);
  await assert.rejects(archive.readClassifiedTrace({ ...key, method: "wrong" as typeof method }, classifierKey), /unsupported/);
}));

test("optional derived resource ceilings skip publication or miss; raw limit failures remain typed and fatal", async () => fixture(async (directory, options) => {
  const archive = new ReadyActivityArchive({ ...options, maxEntryBytes: 64 });
  await archive.writeLogs({ ...range, logs: [] });
  const exact = ["x".repeat(60)];
  await archive.writeClassifiedLogs(range, classifierKey, exact);
  const [cache] = await cachePaths(directory), original = await readFile(join(cache, "data.json.gz"));
  await archive.writeClassifiedLogs(range, classifierKey, ["x".repeat(61)]);
  await archive.writeClassifiedLogs(range, sha("another"), ["x".repeat(61)]);
  assert.equal(await archive.readClassifiedLogs(range, sha("another")), null);
  assert.deepEqual(await readFile(join(cache, "data.json.gz")), original);
  assert.equal((await readdir(`${directory}.classified-v1`)).length, 1, "no partial cache is published");
  assert.deepEqual(await new ReadyActivityArchive(options).readClassifiedLogs(range, classifierKey), exact);
  for (const bounded of [archive.withEntryLimit(63), new ReadyActivityArchive({ ...options, maxEntryBytes: 63 })]) {
    assert.equal(await bounded.readClassifiedLogs(range, classifierKey), null);
    assert.deepEqual(await bounded.readLogs(range), []);
  }
  await archive.writeTrace({ blockNumber: 100, method, trace: exact });
  await archive.writeClassifiedTrace({ blockNumber: 100, method }, classifierKey, []);
  await assert.rejects(archive.withEntryLimit(63).readClassifiedTrace({ blockNumber: 100, method }, classifierKey), { code: "READY_ACTIVITY_ENTRY_LIMIT" });
  await assert.rejects(archive.writeTrace({ blockNumber: 101, method, trace: ["x".repeat(61)] }), { code: "READY_ACTIVITY_ENTRY_LIMIT" });
  await writeFile(join(cache, "data.json.gz"), gzipSync(JSON.stringify(["y".repeat(60)])));
  await assert.rejects(archive.withEntryLimit(63).readClassifiedLogs(range, classifierKey), /hash mismatch/);
  for (const data of [[undefined], [1n], new Array(2), [{ get value() { throw new Error("must not run"); } }]]) {
    await assert.rejects(archive.writeClassifiedLogs(range, sha("invalid-json"), data));
  }
  await assert.rejects(archive.writeClassifiedLogs(range, classifierKey, {} as unknown[]), /must be an array/);
}));

test("persistent cache hits verify raw compressed SHA even after a successful same-session hit", async () => fixture(async (directory, options) => {
  const archive = new ReadyActivityArchive(options);
  await archive.writeLogs({ ...range, logs: ["a"] });
  await archive.writeClassifiedLogs(range, classifierKey, [{ selected: "a" }]);
  const resumed = new ReadyActivityArchive(options);
  assert.deepEqual(await resumed.readClassifiedLogs(range, classifierKey), [{ selected: "a" }]);
  const path = join(directory, logsName, "data.json.gz"), before = await stat(path);
  await writeFile(path, gzipSync('["b"]'));
  await utimes(path, before.atime, before.mtime);
  for (const reader of [archive, resumed, new ReadyActivityArchive(options)]) {
    await assert.rejects(reader.readClassifiedLogs(range, classifierKey), /hash mismatch/);
    await assert.rejects(reader.coverage({ method }), /hash mismatch/);
    await assert.rejects(reader.writeClassifiedLogs(range, sha("new-classifier"), []), /hash mismatch|changed since verification/);
  }
  await assert.rejects(resumed.readClassifiedLogs(range, sha("cache-miss")), /hash mismatch/);
}));

test("raw receipt/content replacement cannot reuse a prior classification or forge array-count coverage", async () => fixture(async (directory, options) => {
  const archive = new ReadyActivityArchive(options);
  await archive.writeLogs({ ...range, logs: ["a"] });
  await archive.writeClassifiedLogs(range, classifierKey, ["classified-a"]);
  const path = join(directory, logsName);
  await replacePayload(path, '["b"]');
  assert.equal(await archive.readClassifiedLogs(range, classifierKey), null);
  assert.deepEqual(await archive.readLogs(range), ["b"]);
  await archive.writeClassifiedLogs(range, classifierKey, ["classified-b"]);
  assert.deepEqual(await new ReadyActivityArchive(options).readClassifiedLogs(range, classifierKey), ["classified-b"]);
  await alterReceipt(path, { count: 2 });
  assert.equal(await archive.readClassifiedLogs(range, classifierKey), null);
  await assert.rejects(archive.coverage({ method }), /array\/count/);
  await assert.rejects(archive.writeClassifiedLogs(range, classifierKey, []), /changed since verification/);
  await assert.rejects(new ReadyActivityArchive(options).writeClassifiedLogs(range, classifierKey, []), /array\/count/);
  // Valid compressed hashes alone do not establish valid raw JSON or array shape.
  await replacePayload(path, '{}');
  await assert.rejects(new ReadyActivityArchive(options).coverage({ method }), /array\/count/);
}));

test("corrupt classified data, counts, receipts and bindings fail closed without overwriting", async () => fixture(async (directory, options) => {
  const archive = new ReadyActivityArchive(options);
  await archive.writeLogs({ ...range, logs: [] });
  await archive.writeClassifiedLogs(range, classifierKey, ["kept"]);
  const [path] = await cachePaths(directory);
  const receiptPath = join(path, "receipt.json"), dataPath = join(path, "data.json.gz");
  const originalReceipt = await readFile(receiptPath), originalData = await readFile(dataPath);
  const restore = async () => { await writeFile(receiptPath, originalReceipt); await writeFile(dataPath, originalData); };
  await writeFile(dataPath, gzipSync('["lost"]'));
  await assert.rejects(archive.readClassifiedLogs(range, classifierKey), /hash mismatch/);
  await assert.rejects(archive.writeClassifiedLogs(range, classifierKey, ["kept"]), /hash mismatch/);
  for (const text of ['{}', '[1,2]', '[ ']) {
    await restore();
    await replacePayload(path, text);
    await assert.rejects(new ReadyActivityArchive(options).readClassifiedLogs(range, classifierKey), /array\/count|invalid entry JSON/);
  }
  for (const change of [{ schema: "other/v1" }, { classifierKey: sha("other") }, { rawReceiptSha256: sha("other") },
    { contextHash: sha("other") }, { method: "trace_block" }, { fromBlock: 101 }, { toBlock: 101 }]) {
    await restore(); await alterReceipt(path, change);
    await assert.rejects(archive.readClassifiedLogs(range, classifierKey), /receipt|metadata/);
  }
  await restore(); await writeFile(receiptPath, '{"receiptSha256":"bad"}');
  await assert.rejects(archive.readClassifiedLogs(range, classifierKey), /receipt/);
  await restore(); await rm(dataPath);
  await assert.rejects(archive.readClassifiedLogs(range, classifierKey));
  await restore(); await rm(receiptPath);
  await assert.rejects(archive.readClassifiedLogs(range, classifierKey), /receipt/);
}));

test("memo invalidates on identical-byte file, entry-directory and archive-directory replacement", async t => fixture(async (directory, options) => {
  const writer = new ReadyActivityArchive(options);
  await writer.writeLogs({ ...range, logs: ["verified"] });
  const counts = workCounts(t), reader = new ReadyActivityArchive(options);
  await reader.coverage({ method });
  assert.deepEqual(counts, { decompressions: 1, arrays: 1 });
  const payload = join(directory, logsName, "data.json.gz");
  const original = await readFile(payload), oldStat = await stat(payload);
  await writeFile(payload, original); await utimes(payload, oldStat.atime, oldStat.mtime);
  await reader.coverage({ method });
  assert.equal(counts.decompressions, 2, "ctime detects an in-place rewrite with restored mtime");
  for (const path of [payload, join(directory, logsName, "receipt.json"), join(directory, "manifest.json"), join(directory, logsName), directory]) {
    const copy = `${path}.replacement`;
    await cp(path, copy, { recursive: true, preserveTimestamps: true });
    await rename(path, `${path}.retired`);
    await rename(copy, path);
    // Leave only valid archive names before checking coverage.
    await rm(`${path}.retired`, { recursive: true, force: true });
    const before: number = counts.decompressions;
    await reader.coverage({ method });
    assert.equal(counts.decompressions, before + 1);
    await reader.coverage({ method });
    assert.equal(counts.decompressions, before + 1);
  }
}));

test("manifest changes and disappearance invalidate classified reads and memoized coverage", async () => fixture(async (directory, options) => {
  const archive = new ReadyActivityArchive(options);
  await complete(archive);
  await archive.writeClassifiedLogs(range, classifierKey, []);
  await archive.assertComplete({ method });
  const path = join(directory, "manifest.json"), original = await readFile(path);
  await writeFile(path, original.toString().replace('"chainId":1', '"chainId":2'));
  await assert.rejects(archive.readClassifiedLogs(range, classifierKey), /context mismatch/);
  await assert.rejects(archive.assertComplete({ method }), /context mismatch/);
  await assert.rejects(archive.writeClassifiedLogs(range, classifierKey, []), /context mismatch/);
  await writeFile(path, original);
  await rm(path);
  await assert.rejects(archive.readClassifiedLogs(range, classifierKey), /manifest/);
  await assert.rejects(new ReadyActivityArchive(options).readClassifiedLogs(range, classifierKey), /manifest/);
}));

test("missing raw entries cannot borrow completeness from derived entries or remembered coverage", async () => fixture(async (directory, options) => {
  const archive = new ReadyActivityArchive(options);
  await complete(archive);
  await archive.writeClassifiedLogs(range, classifierKey, []);
  await archive.assertComplete({ method });
  await rm(join(directory, logsName), { recursive: true });
  assert.equal(await archive.readClassifiedLogs(range, classifierKey), null);
  assert.equal(await new ReadyActivityArchive(options).readClassifiedLogs(range, classifierKey), null);
  assert.deepEqual((await archive.coverage({ method })).missingLogs, [range]);
  await assert.rejects(archive.assertComplete({ method }), /incomplete/);
}));

test("symlinks at raw and classified directory/file boundaries fail closed", async () => {
  for (const target of ["archive", "raw-entry", "raw-data", "raw-receipt", "manifest", "cache", "cache-entry", "cache-data", "cache-receipt"]) {
    await fixture(async (directory, options) => {
      const archive = new ReadyActivityArchive(options);
      await archive.writeLogs({ ...range, logs: [] });
      await archive.writeClassifiedLogs(range, classifierKey, []);
      const [cache] = await cachePaths(directory);
      const path = { archive: directory, "raw-entry": join(directory, logsName), "raw-data": join(directory, logsName, "data.json.gz"),
        "raw-receipt": join(directory, logsName, "receipt.json"), manifest: join(directory, "manifest.json"),
        cache: `${directory}.classified-v1`, "cache-entry": cache, "cache-data": join(cache, "data.json.gz"),
        "cache-receipt": join(cache, "receipt.json") }[target]!;
      await rename(path, `${path}.saved`);
      await symlink(`${path}.saved`, path);
      await assert.rejects(archive.readClassifiedLogs(range, classifierKey), Error, target);
      await assert.rejects(archive.writeClassifiedLogs(range, classifierKey, []), Error, target);
    });
  }
});

test("mutation during raw decode, derived decode and memo verification is fenced before success", async t => {
  const parse = JSON.parse;
  let mutate: ((text: string) => void) | undefined;
  t.mock.method(JSON, "parse", (text: string) => { const result = parse(text); mutate?.(text); return result; });
  for (const phase of ["raw", "classified", "memo"]) {
    await fixture(async (directory, options) => {
      const archive = new ReadyActivityArchive(options);
      await archive.writeLogs({ ...range, logs: ["raw-mutation"] });
      await archive.writeClassifiedLogs(range, classifierKey, ["derived-mutation"]);
      const path = join(directory, logsName, "data.json.gz"), original = await readFile(path);
      let receipts = 0, fired = false;
      mutate = text => {
        const trigger = phase === "raw" ? text === '["raw-mutation"]'
          : phase === "classified" ? text === '["derived-mutation"]'
          : text.includes('"kind":"logs"') && ++receipts === 2;
        if (trigger && !fired) { fired = true; writeFileSync(path, original); }
      };
      try {
        await assert.rejects(phase === "raw" ? archive.readLogs(range)
          : phase === "classified" ? archive.readClassifiedLogs(range, classifierKey)
          : archive.coverage({ method }), /changed/);
        assert.equal(fired, true, phase);
      } finally { mutate = undefined; }
      assert.deepEqual(await archive.readLogs(range), ["raw-mutation"]);
    });
  }
});

test("derived publication is immutable, crash scratch is ignored, and independent processes agree", async () => fixture(async (directory, options) => {
  const archive = new ReadyActivityArchive(options);
  await archive.writeLogs({ ...range, logs: [] });
  const moduleURL = new URL("../ready-activity-archive.ts", import.meta.url).href;
  const script = `import {ReadyActivityArchive} from ${JSON.stringify(moduleURL)};
    await new ReadyActivityArchive(${JSON.stringify(options)}).writeClassifiedLogs(${JSON.stringify(range)}, ${JSON.stringify(classifierKey)}, [{a:1,b:2}]);`;
  const run = () => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe"] });
    let error = "";
    child.stderr.on("data", chunk => { error += String(chunk); });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(error)));
  });
  await Promise.all([run(), run()]);
  assert.deepEqual(await archive.readClassifiedLogs(range, classifierKey), [{ a: 1, b: 2 }]);
  const [path] = await cachePaths(directory), original = await readFile(join(path, "data.json.gz"));
  await archive.writeClassifiedLogs(range, classifierKey, [{ b: 2, a: 1 }]);
  await assert.rejects(archive.writeClassifiedLogs(range, classifierKey, [{ a: 2, b: 2 }]), /conflicting/);
  assert.deepEqual(await readFile(join(path, "data.json.gz")), original);
  const scratch = join(`${directory}.classified-v1`, ".pending-11111111-1111-4111-8111-111111111111");
  await mkdir(scratch); await writeFile(join(scratch, "data.json.gz"), "partial");
  assert.equal(await archive.readClassifiedLogs(range, sha("unfinished")), null);
  await assert.rejects(archive.assertComplete({ method }), /incomplete/);
  assert.equal(await readFile(join(scratch, "data.json.gz"), "utf8"), "partial");
}));

test("classification cannot rebind old derived data to a self-consistent replacement after a raw read", async () => fixture(async (directory, options) => {
  const archive = new ReadyActivityArchive(options);
  await archive.writeLogs({ ...range, logs: ["A"] });
  assert.deepEqual(await archive.readLogs(range), ["A"]);
  const replacement = join(directory, "..", "replacement");
  const writer = new ReadyActivityArchive({ ...options, directory: replacement });
  await writer.writeLogs({ ...range, logs: ["B"] });
  await rename(join(directory, logsName), join(directory, "..", "retired-entry"));
  await rename(join(replacement, logsName), join(directory, logsName));
  for (const handle of [archive, archive.withEntryLimit(32)]) {
    await assert.rejects(handle.writeClassifiedLogs(range, classifierKey, ["derived-from-A"]), /changed since verification/);
  }
  await assert.rejects(stat(`${directory}.classified-v1`), { code: "ENOENT" });
  // A deliberate fresh raw read establishes the new classification input.
  assert.deepEqual(await archive.readLogs(range), ["B"]);
  await archive.writeClassifiedLogs(range, classifierKey, ["derived-from-B"]);
  assert.deepEqual(await new ReadyActivityArchive(options).readClassifiedLogs(range, classifierKey), ["derived-from-B"]);
}));

test("tighter handles share only fenced verification and enforce their own raw bounds", async t => fixture(async (_directory, options) => {
  const archive = new ReadyActivityArchive(options);
  await complete(archive);
  const counts = workCounts(t);
  const bounded = archive.withEntryLimit(16);
  await bounded.writeClassifiedLogs(range, classifierKey, []);
  await bounded.assertComplete({ method });
  await archive.assertComplete({ method });
  assert.deepEqual(counts, { decompressions: 0, arrays: 0 });
  // Sharing proof never shares the broader handle's local byte ceiling.
  const other = new ReadyActivityArchive({ ...options, directory: `${options.directory}-large` });
  await other.writeLogs({ ...range, logs: ["x".repeat(40)] });
  await assert.rejects(other.withEntryLimit(16).writeClassifiedLogs(range, classifierKey, []), { code: "READY_ACTIVITY_ENTRY_LIMIT" });
  await assert.rejects(other.withEntryLimit(16).coverage({ method }), { code: "READY_ACTIVITY_ENTRY_LIMIT" });
}));

test("coverage and sibling reads cannot overwrite the classification-input fence", async () => {
  for (const interleaving of ["same-handle-coverage", "sibling-coverage", "sibling-read"] as const) {
    await fixture(async (directory, options) => {
      const archive = new ReadyActivityArchive(options);
      await archive.writeLogs({ ...range, logs: ["A"] });
      for (let blockNumber = range.fromBlock; blockNumber <= range.toBlock; blockNumber++) {
        await archive.writeTrace({ blockNumber, method, trace: [] });
      }
      assert.deepEqual(await archive.readLogs(range), ["A"]);
      const sibling = archive.withEntryLimit(32);
      const replacement = join(directory, "..", "replacement");
      await new ReadyActivityArchive({ ...options, directory: replacement }).writeLogs({ ...range, logs: ["B"] });
      await rename(join(directory, logsName), join(directory, "..", "retired-entry"));
      await rename(join(replacement, logsName), join(directory, logsName));
      if (interleaving === "sibling-read") assert.deepEqual(await sibling.readLogs(range), ["B"]);
      else await (interleaving === "same-handle-coverage" ? archive : sibling).assertComplete({ method });
      // Integrity proof now describes B, but this caller's classification still
      // came from A. The two facts must never share an overwriteable memo.
      await assert.rejects(archive.writeClassifiedLogs(range, classifierKey, ["derived-from-A"]), /changed since verification/, interleaving);
      assert.equal(await new ReadyActivityArchive(options).readClassifiedLogs(range, classifierKey), null);
      assert.deepEqual(await archive.readLogs(range), ["B"]);
      await archive.writeClassifiedLogs(range, classifierKey, ["derived-from-B"]);
      assert.deepEqual(await new ReadyActivityArchive(options).readClassifiedLogs(range, classifierKey), ["derived-from-B"]);
    });
  }
});
