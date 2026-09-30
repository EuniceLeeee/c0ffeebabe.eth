import { createHash, randomUUID } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import type { BigIntStats } from "node:fs";
import { link, lstat, mkdir, open, opendir, rename, rm, rmdir, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createGzip, createGunzip } from "node:zlib";

export type ReadyActivityTraceMethod = "trace_block" | "debug_traceBlockByNumber";
export interface ReadyActivityArchiveOptions {
  directory: string;
  chainId: number;
  fromBlock: number;
  toBlock: number;
  cutoffHash: string;
  /** Local resource ceiling; does not change immutable archive identity. */
  maxEntryBytes?: number;
}
export type ReadyActivityArchiveScope = Pick<ReadyActivityArchiveOptions, "chainId" | "fromBlock" | "toBlock" | "cutoffHash">;
type Range = { fromBlock: number; toBlock: number };
type TraceKey = { blockNumber: number; method: ReadyActivityTraceMethod };
type Key = Range & { kind: "logs" | "trace"; method: "eth_getLogs" | ReadyActivityTraceMethod };
type Receipt = Key & {
  contextHash: string; rawBytes: number; gzipBytes: number; count: number;
  rawSha256: string; gzipSha256: string;
};
type Classification = { schema: "ready-activity-classified/v1"; classifierKey: string; rawReceiptSha256: string };
type Entry = {
  key: Key; classification?: Classification; path: string; receipt: Receipt;
  receiptText: string; dataStamp: string; fence: string;
};
export interface ReadyActivityArchiveCoverage {
  complete: boolean;
  method: ReadyActivityTraceMethod;
  missingLogs: Range[];
  missingTraceBlocks: number[];
  stats: { entries: number; logChunks: number; traceBlocks: number; items: number; rawBytes: number; gzipBytes: number };
}

export const READY_ACTIVITY_MAX_BLOCKS = 14_400;
/** Per-entry uncompressed JSON limit, not an archive disk quota. Reads retain at most
 * one bounded entry (plus its parsed array); writes stream gzip. Typical entries are
 * ~500-block log chunks or one trace block. No archive is automatically evicted. */
export const READY_ACTIVITY_MAX_ENTRY_BYTES = 256 * 1024 * 1024;
const MAX_GZIP_BYTES = READY_ACTIVITY_MAX_ENTRY_BYTES + 1024 * 1024;
const MAX_ENTRIES = READY_ACTIVITY_MAX_BLOCKS * 3 + 1024;
const METHODS = ["trace_block", "debug_traceBlockByNumber"] as const;
const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const fail = (reason: string): never => { throw new Error(`ReadyActivityArchive: ${reason}`); };
const entryLimit = (reason: string): never => {
  throw Object.assign(new Error(`ReadyActivityArchive: ${reason}`), { code: "READY_ACTIVITY_ENTRY_LIMIT" });
};
const hasCode = (error: unknown, code: string) => (error as NodeJS.ErrnoException)?.code === code;
const integer = (value: number) => Number.isSafeInteger(value) && value >= 0;
const filename = (key: Key) => `${key.kind}-${key.method}-${key.fromBlock}-${key.toBlock}`;
// Nanosecond ctime detects in-place rewrites even when size and mtime are restored.
// Root directories use identity only: publishing a different entry must not evict
// all verified entries. Entry directories and files use their full mutation stamp.
const stamp = (stat: BigIntStats, identityOnly = false) =>
  [stat.dev, stat.ino, stat.mode, stat.birthtimeNs,
    ...(identityOnly ? [] : [stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs])].join(":");
async function pathStamp(path: string, directory = false, identityOnly = false): Promise<string> {
  const stat = await lstat(path, { bigint: true });
  if (directory ? !stat.isDirectory() : !stat.isFile()) fail(`invalid ${directory ? "entry directory" : "archive file"}`);
  return stamp(stat, identityOnly);
}

// Canonical JSON without toJSON coercion, dropped fields, holes, non-finite values,
// getters or cyclic/excessively deep objects. Chunk strings before escaping them.
function* json(value: unknown, ancestors = new Set<object>()): Generator<string> {
  if (value === null) { yield "null"; return; }
  if (typeof value === "string") {
    yield '"';
    for (let i = 0; i < value.length;) {
      let end = Math.min(i + 8192, value.length);
      if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1])) end--;
      yield JSON.stringify(value.slice(i, end)).slice(1, -1);
      i = end;
    }
    yield '"'; return;
  }
  if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
    yield JSON.stringify(value); return;
  }
  if (typeof value !== "object") fail("payload must be JSON-safe");
  const object = value as object;
  if (ancestors.has(object) || ancestors.size >= 256) fail("cyclic or overly deep payload");
  const array = Array.isArray(object);
  if (!array && Object.getPrototypeOf(object) !== Object.prototype && Object.getPrototypeOf(object) !== null) {
    fail("payload must contain plain JSON objects");
  }
  if (Object.getOwnPropertySymbols(object).length) fail("payload contains symbol keys");
  const keys = Object.keys(object);
  if (array && keys.length !== object.length) fail("payload contains array holes or extra fields");
  ancestors.add(object);
  yield array ? "[" : "{";
  const ordered = array ? keys : keys.sort();
  for (let i = 0; i < ordered.length; i++) {
    const key = ordered[i];
    if (array && key !== String(i)) fail("payload contains non-index array fields");
    const descriptor = Object.getOwnPropertyDescriptor(object, key)!;
    if (!("value" in descriptor)) fail("payload contains an accessor");
    if (i) yield ",";
    if (!array) { yield* json(key, ancestors); yield ":"; }
    yield* json(descriptor.value, ancestors);
  }
  yield array ? "]" : "}";
  ancestors.delete(object);
}

function* encoded(value: readonly unknown[], maxEntryBytes: number): Generator<Buffer> {
  let bytes = 0, pending = "";
  for (const token of json(value)) {
    bytes += Buffer.byteLength(token);
    if (bytes > maxEntryBytes) entryLimit(`entry exceeds ${maxEntryBytes / (1024 * 1024)} MiB`);
    pending += token;
    if (pending.length >= 65536) { yield Buffer.from(pending); pending = ""; }
  }
  if (pending) yield Buffer.from(pending);
}

/** Count canonical JSON incrementally without constructing a second full payload. */
export function readyActivityPayloadBytes(value: readonly unknown[], maxEntryBytes: number): number {
  let bytes = 0;
  for (const chunk of encoded(value, maxEntryBytes)) bytes += chunk.length;
  return bytes;
}

async function sync(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function smallFile(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || stat.size > 8192n) fail("invalid metadata file");
    // Bound the read itself, even if another process grows the file after stat.
    const buffer = Buffer.alloc(8193);
    let size = 0;
    while (size < buffer.length) {
      const result = await handle.read(buffer, size, buffer.length - size, null);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > 8192) fail("metadata exceeds limit");
    if (stamp(stat) !== stamp(await handle.stat({ bigint: true })) || stamp(stat) !== await pathStamp(path)) {
      fail("metadata changed during read");
    }
    return buffer.subarray(0, size);
  } finally { await handle.close(); }
}

/** Disk-backed raw-response archive with optional opaque classified arrays. The
 * caller owns parser/Family identity in classifierKey and supplies only complete,
 * unfiltered responses, and must not mutate inputs until the write settles. This
 * class cannot authenticate RPC completeness or infer missing/empty blocks. Hashes
 * detect corruption/context mixing, not a malicious actor rewriting all local files.
 * Use a dedicated directory on a local filesystem supporting atomic rename/link.
 * Constructors perform no I/O. Read-only calls never create an archive.
 */
export class ReadyActivityArchive {
  readonly maxEntryBytes: number;
  private readonly directory: string;
  private readonly range: Range;
  private readonly scope: Readonly<ReadyActivityArchiveScope>;
  private readonly manifest: string;
  private readonly contextHash: string;
  private observedManifest = false;
  // Verification evidence only; never retain raw arrays or compressed payloads.
  private verified = new Map<string, string>();
  // The bytes handed to this caller for classification are a separate fact from
  // the most recently verified coverage. Coverage (including a sibling handle)
  // may verify newer bytes, but cannot rebind a result computed from an old read.
  private classificationInputs = new Map<string, string>();

  constructor(options: ReadyActivityArchiveOptions) {
    const maxEntryBytes = options.maxEntryBytes ?? READY_ACTIVITY_MAX_ENTRY_BYTES;
    if (!Number.isSafeInteger(maxEntryBytes) || maxEntryBytes < 2 || maxEntryBytes > READY_ACTIVITY_MAX_ENTRY_BYTES) fail("invalid entry byte limit");
    this.maxEntryBytes = maxEntryBytes;
    if (!options.directory || !integer(options.chainId) || options.chainId === 0 ||
        !integer(options.fromBlock) || !integer(options.toBlock) || options.toBlock < options.fromBlock ||
        options.toBlock - options.fromBlock >= READY_ACTIVITY_MAX_BLOCKS ||
        !/^0x[0-9a-fA-F]{64}$/.test(options.cutoffHash)) fail("invalid archive context");
    this.directory = resolve(options.directory);
    this.range = { fromBlock: options.fromBlock, toBlock: options.toBlock };
    this.scope = { chainId: options.chainId, ...this.range, cutoffHash: options.cutoffHash };
    this.manifest = JSON.stringify({ schema: "ready-activity-archive/v1", chainId: options.chainId,
      ...this.range, cutoffHash: options.cutoffHash.toLowerCase(),
      source: { logs: "eth_getLogs", traceMethods: METHODS, responses: "complete-raw-arrays" },
      encoding: "canonical-json+gzip", maxEntryBytes: READY_ACTIVITY_MAX_ENTRY_BYTES }) + "\n";
    this.contextHash = hash(this.manifest);
  }

  /** Independent reader/writer with a tighter local limit and identical disk identity. */
  withEntryLimit(maxEntryBytes: number): ReadyActivityArchive {
    const bounded = new ReadyActivityArchive({ ...this.scope, directory: this.directory, maxEntryBytes });
    if (bounded.maxEntryBytes >= this.maxEntryBytes) return this;
    bounded.observedManifest = this.observedManifest;
    bounded.verified = this.verified;
    bounded.classificationInputs = new Map(this.classificationInputs);
    return bounded;
  }

  /** Synchronous, exact comparison with the constructor's scope (including hash
   * spelling). Performs no I/O; every disk read/write still validates the manifest. */
  public assertScope(scope: ReadyActivityArchiveScope): void {
    if (scope.chainId !== this.scope.chainId || scope.fromBlock !== this.scope.fromBlock ||
        scope.toBlock !== this.scope.toBlock || scope.cutoffHash !== this.scope.cutoffHash) {
      fail("archive scope mismatch");
    }
  }

  private logsKey(range: Range): Key {
    if (!integer(range.fromBlock) || !integer(range.toBlock) || range.fromBlock > range.toBlock ||
        range.fromBlock < this.range.fromBlock || range.toBlock > this.range.toBlock) fail("range out of bounds");
    return { kind: "logs", method: "eth_getLogs", fromBlock: range.fromBlock, toBlock: range.toBlock };
  }
  private traceKey(key: TraceKey): Key {
    if (!METHODS.includes(key.method)) fail("unsupported trace method");
    return { ...this.logsKey({ fromBlock: key.blockNumber, toBlock: key.blockNumber }), kind: "trace", method: key.method };
  }

  private async names(): Promise<string[]> {
    const names: string[] = [];
    try {
      const directory = await opendir(this.directory);
      for await (const entry of directory) {
        if (names.length >= MAX_ENTRIES) fail("too many archive entries");
        if (entry.name === "manifest.json") {
          if (!entry.isFile()) fail("invalid manifest file");
        } else if (entry.name === ".publish-lock" || /^\.pending-[0-9a-f-]{36}$/.test(entry.name)) {
          // Crash leftovers are never receipts. Do not remove another writer's files.
        } else if (!/^(logs-eth_getLogs|trace-(trace_block|debug_traceBlockByNumber))-\d+-\d+$/.test(entry.name) || !entry.isDirectory()) {
          fail("foreign or invalid archive entry");
        }
        names.push(entry.name);
      }
    } catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
    return names;
  }

  private async context(create = false): Promise<string | null> {
    try {
      const root = await pathStamp(this.directory, true, true);
      const manifestPath = join(this.directory, "manifest.json");
      const manifestStamp = await pathStamp(manifestPath);
      if (!(await smallFile(manifestPath)).equals(Buffer.from(this.manifest))) {
        fail("manifest/context mismatch");
      }
      if (root !== await pathStamp(this.directory, true, true) || manifestStamp !== await pathStamp(manifestPath)) {
        fail("manifest/context changed during read");
      }
      this.observedManifest = true;
      return `${root}|${manifestStamp}`;
    } catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
    if (this.observedManifest) fail("previously verified manifest disappeared");
    const names = await this.names();
    if (names.includes("manifest.json")) return this.context(create);
    if (names.some(name => !name.startsWith("."))) fail("missing manifest for existing archive");
    if (!create) return null;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await pathStamp(this.directory, true);
    await sync(dirname(this.directory));
    const temp = join(this.directory, `.pending-${randomUUID()}`);
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(this.manifest); await handle.sync(); await handle.close();
      try { await link(temp, join(this.directory, "manifest.json")); }
      catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
      await sync(this.directory);
    } finally { await handle.close(); await unlink(temp); }
    return this.context();
  }

  private keyFromName(name: string): Key {
    const match = /^(logs-eth_getLogs|trace-(trace_block|debug_traceBlockByNumber))-(\d+)-(\d+)$/.exec(name);
    if (!match) return fail("invalid entry key");
    const fromBlock = Number(match[3]), toBlock = Number(match[4]);
    const key = match[2] ? this.traceKey({ blockNumber: fromBlock, method: match[2] as ReadyActivityTraceMethod }) : this.logsKey({ fromBlock, toBlock });
    if (filename(key) !== name) fail("noncanonical or out-of-range entry key");
    return key;
  }

  private base(classification?: Classification): string {
    // A sibling keeps v1 directory names/layout readable by existing readers.
    return classification ? `${this.directory}.classified-v1` : this.directory;
  }

  private entryPath(key: Key, classification?: Classification): string {
    return join(this.base(classification), classification
      ? hash(JSON.stringify({ ...key, contextHash: this.contextHash, ...classification })) : filename(key));
  }

  private async inspect(key: Key, classification?: Classification): Promise<Entry | null> {
    const context = await this.context();
    if (!context) return null;
    const path = this.entryPath(key, classification);
    let root: string, directory: string;
    try {
      root = await pathStamp(this.base(classification), true, true);
      directory = await pathStamp(path, true);
    }
    catch (error) { if (hasCode(error, "ENOENT")) return null; throw error; }
    let receipt: Receipt;
    let receiptText: string, receiptStamp: string;
    try {
      const receiptPath = join(path, "receipt.json");
      receiptStamp = await pathStamp(receiptPath);
      receiptText = (await smallFile(receiptPath)).toString("utf8");
      const { receiptSha256, ...fields } = JSON.parse(receiptText);
      if (hash(JSON.stringify(fields)) !== receiptSha256) fail("receipt checksum mismatch");
      if (classification && Object.entries(classification).some(([field, value]) => fields[field] !== value)) {
        fail("classification binding mismatch");
      }
      receipt = fields as Receipt;
    }
    catch { return fail("missing or invalid entry receipt"); }
    if (!receipt || receipt.contextHash !== this.contextHash ||
        Object.entries(key).some(([field, value]) => receipt[field as keyof Receipt] !== value) ||
        !integer(receipt.rawBytes) || receipt.rawBytes < 2 || receipt.rawBytes > READY_ACTIVITY_MAX_ENTRY_BYTES ||
        !integer(receipt.gzipBytes) || receipt.gzipBytes > MAX_GZIP_BYTES || !integer(receipt.count) ||
        !/^[0-9a-f]{64}$/.test(receipt.rawSha256) || !/^[0-9a-f]{64}$/.test(receipt.gzipSha256)) fail("entry metadata mismatch");
    if (!classification && receipt.rawBytes > this.maxEntryBytes) entryLimit("entry exceeds configured read byte limit");
    const dataStamp = await pathStamp(join(path, "data.json.gz"));
    return { key, classification, path, receipt, receiptText, dataStamp,
      fence: [context, root, directory, receiptStamp, dataStamp, hash(receiptText)].join("|") };
  }

  private async unchanged(entry: Entry): Promise<void> {
    const current = await this.inspect(entry.key, entry.classification);
    if (!current || current.fence !== entry.fence || current.receiptText !== entry.receiptText) {
      this.verified.delete(filename(entry.key));
      fail("entry changed during verification");
    }
  }

  private remember(entry: Entry): void {
    const name = filename(entry.key);
    this.verified.delete(name);
    if (this.verified.size >= MAX_ENTRIES) this.verified.delete(this.verified.keys().next().value!);
    this.verified.set(name, entry.fence);
  }

  private rememberClassificationInput(entry: Entry): void {
    const name = filename(entry.key);
    this.classificationInputs.delete(name);
    if (this.classificationInputs.size >= MAX_ENTRIES) this.classificationInputs.delete(this.classificationInputs.keys().next().value!);
    this.classificationInputs.set(name, entry.fence);
  }

  /** With decode=false, verify compressed content only. A cache hit additionally
   * binds a receipt previously issued after full raw JSON/array/count verification. */
  private async consume(entry: Entry, decode: boolean): Promise<readonly unknown[]> {
    const { path, receipt } = entry;
    const handle = await open(join(path, "data.json.gz"), constants.O_RDONLY | constants.O_NOFOLLOW);
    const compressedHash = createHash("sha256"), rawHash = createHash("sha256");
    let gzipBytes = 0, rawBytes = 0;
    const chunks: Buffer[] = [];
    try {
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile() || stat.size !== BigInt(receipt.gzipBytes)) fail("compressed size mismatch");
      if (stamp(stat) !== entry.dataStamp) fail("entry changed before read");
      const compressed = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          gzipBytes += chunk.length;
          if (gzipBytes > receipt.gzipBytes) { callback(new Error("ReadyActivityArchive: compressed entry exceeds limit")); return; }
          compressedHash.update(chunk); callback(null, chunk);
        },
      });
      const output = new Writable({
        write(chunk: Buffer, _encoding, callback) {
          if (!decode) { callback(); return; }
          rawBytes += chunk.length;
          if (rawBytes > receipt.rawBytes) { callback(new Error("ReadyActivityArchive: decompressed entry exceeds receipt limit")); return; }
          rawHash.update(chunk);
          chunks.push(chunk);
          callback();
        },
      });
      const input = handle.createReadStream({ autoClose: false });
      if (decode) await pipeline(input, compressed, createGunzip(), output);
      else await pipeline(input, compressed, output);
      if (gzipBytes !== receipt.gzipBytes || compressedHash.digest("hex") !== receipt.gzipSha256 ||
          (decode && (rawBytes !== receipt.rawBytes || rawHash.digest("hex") !== receipt.rawSha256))) fail("entry hash mismatch");
      let data: unknown = [];
      if (decode) {
        try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { fail("invalid entry JSON"); }
        if (!Array.isArray(data) || data.length !== receipt.count) fail("entry array/count mismatch");
      }
      if (stamp(stat) !== stamp(await handle.stat({ bigint: true }))) fail("entry changed during read");
      await this.unchanged(entry);
      return data as readonly unknown[];
    } finally { await handle.close(); }
  }

  private async load(key: Key, retain: boolean, classification?: Classification, expectedFence?: string): Promise<(Entry & { data: readonly unknown[] }) | null> {
    const entry = await this.inspect(key, classification);
    if (!entry) { if (!classification) this.verified.delete(filename(key)); return null; }
    if (expectedFence !== undefined && entry.fence !== expectedFence) fail("raw entry changed since verification; read it again before classifying");
    if (entry.receipt.rawBytes > this.maxEntryBytes) entryLimit("entry exceeds configured read byte limit");
    if (!classification && !retain && this.verified.get(filename(key)) === entry.fence) {
      await this.unchanged(entry);
      return { ...entry, data: [] };
    }
    // Even receipt-only callers must establish JSON array/count validity once.
    const data = await this.consume(entry, true);
    if (!classification) this.remember(entry);
    return { ...entry, data: retain ? data : [] };
  }

  async readLogs(range: Range): Promise<readonly unknown[] | null> {
    const key = this.logsKey(range);
    const entry = await this.load(key, true);
    if (entry) this.rememberClassificationInput(entry);
    return entry?.data ?? null;
  }
  async readTrace(key: TraceKey): Promise<readonly unknown[] | null> {
    const entry = await this.load(this.traceKey(key), true);
    if (entry) this.rememberClassificationInput(entry);
    return entry?.data ?? null;
  }
  async writeLogs(input: Range & { logs: readonly unknown[] }): Promise<void> {
    await this.write(this.logsKey(input), input.logs);
  }
  async writeTrace(input: TraceKey & { trace: readonly unknown[] }): Promise<void> {
    await this.write(this.traceKey(input), input.trace);
  }

  async readClassifiedLogs(range: Range, classifierKey: string): Promise<readonly unknown[] | null> {
    return this.readClassified(this.logsKey(range), classifierKey);
  }
  async writeClassifiedLogs(range: Range, classifierKey: string, data: readonly unknown[]): Promise<void> {
    await this.writeClassified(this.logsKey(range), classifierKey, data);
  }
  async readClassifiedTrace(key: TraceKey, classifierKey: string): Promise<readonly unknown[] | null> {
    return this.readClassified(this.traceKey(key), classifierKey);
  }
  async writeClassifiedTrace(key: TraceKey, classifierKey: string, data: readonly unknown[]): Promise<void> {
    await this.writeClassified(this.traceKey(key), classifierKey, data);
  }

  private classifierKey(key: string): string {
    if (typeof key !== "string" || !/^[0-9a-fA-F]{64}$/.test(key)) fail("invalid classifier key");
    return key.toLowerCase();
  }

  private classification(raw: Entry, classifierKey: string): Classification {
    return { schema: "ready-activity-classified/v1", classifierKey, rawReceiptSha256: hash(raw.receiptText) };
  }

  private async readClassified(key: Key, classifierKey: string): Promise<readonly unknown[] | null> {
    classifierKey = this.classifierKey(classifierKey);
    const raw = await this.inspect(key);
    if (!raw) return null;
    const classified = await this.inspect(key, this.classification(raw, classifierKey));
    // Always hash the raw compressed bytes, including on persistent hits. A miss
    // never asserts raw completeness or seeds the verified memo; the normal raw
    // reader will do the one full decode needed to migrate a legacy v1 entry.
    await this.consume(raw, false);
    if (!classified) return null;
    if (classified.receipt.rawBytes > this.maxEntryBytes) {
      // Optional derived data may expand beyond a readable raw entry. Still check
      // its compressed integrity; only the local resource ceiling is a cache miss.
      await this.consume(classified, false);
      await this.unchanged(raw);
      return null;
    }
    const data = await this.consume(classified, true);
    await this.unchanged(raw);
    this.remember(raw);
    return data;
  }

  private async writeClassified(key: Key, classifierKey: string, data: readonly unknown[]): Promise<void> {
    classifierKey = this.classifierKey(classifierKey);
    // A caller may have computed data from an earlier raw read. Never silently
    // rebind that result to replacement content, even with self-consistent hashes.
    const raw = await this.load(key, false, undefined, this.classificationInputs.get(filename(key)));
    if (!raw) fail("cannot classify missing raw entry");
    await this.write(key, data, this.classification(raw!, classifierKey), raw!);
  }

  private async write(key: Key, data: readonly unknown[], classification?: Classification, source?: Entry): Promise<void> {
    if (!Array.isArray(data)) fail("response must be an array");
    if (!await this.context(!classification)) fail("manifest disappeared before write");
    const base = this.base(classification);
    if (classification) {
      try { await mkdir(base, { mode: 0o700 }); }
      catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
      await pathStamp(base, true);
      await sync(dirname(base));
    }
    const temp = join(base, `.pending-${randomUUID()}`);
    await mkdir(temp, { mode: 0o700 });
    const lock = join(base, ".publish-lock");
    let locked = false;
    try {
      const rawHash = createHash("sha256"), gzipHash = createHash("sha256");
      let rawBytes = 0, gzipBytes = 0;
      try { await pipeline(Readable.from(encoded(data, this.maxEntryBytes)), new Transform({
        transform(chunk: Buffer, _encoding, callback) { rawBytes += chunk.length; rawHash.update(chunk); callback(null, chunk); },
      }), createGzip(), new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          gzipBytes += chunk.length;
          if (gzipBytes > MAX_GZIP_BYTES) {
            callback(Object.assign(new Error("ReadyActivityArchive: compressed entry exceeds limit"), { code: "READY_ACTIVITY_ENTRY_LIMIT" })); return;
          }
          gzipHash.update(chunk); callback(null, chunk);
        },
      }), createWriteStream(join(temp, "data.json.gz"), { flags: "wx", mode: 0o600 })); }
      catch (error) {
        // Only serialization resource failures of the optional derived payload
        // skip publication. Raw limits and all integrity errors remain fatal.
        if (classification && hasCode(error, "READY_ACTIVITY_ENTRY_LIMIT")) return;
        throw error;
      }
      const receipt: Receipt = { ...key, ...classification, contextHash: this.contextHash, rawBytes, gzipBytes,
        count: data.length, rawSha256: rawHash.digest("hex"), gzipSha256: gzipHash.digest("hex") };
      const receiptText = JSON.stringify({ ...receipt, receiptSha256: hash(JSON.stringify(receipt)) });
      const handle = await open(join(temp, "receipt.json"), "wx", 0o600);
      try {
        await handle.writeFile(receiptText);
        await handle.sync();
      } finally { await handle.close(); }
      await sync(join(temp, "data.json.gz")); await sync(temp);
      // Cross-process lock covers only publication, including overlap checks. A crash
      // leaving this lock fails closed; never steal/remove a different writer's lock.
      const deadline = Date.now() + 30_000;
      while (!locked) {
        try { await mkdir(lock); locked = true; }
        catch (error) {
          if (!hasCode(error, "EEXIST")) throw error;
          if (Date.now() >= deadline) fail("publication lock busy; inspect interrupted writer");
          await delay(20);
        }
      }
      if (!await this.context()) fail("manifest disappeared before publication");
      if (source) await this.unchanged(source);
      const existing = await this.load(key, false, classification);
      if (existing) {
        if (existing.receipt.rawSha256 !== receipt.rawSha256 || existing.receipt.rawBytes !== rawBytes || existing.receipt.count !== data.length) {
          fail("conflicting immutable entry");
        }
        if (source) await this.unchanged(source);
        if (!classification) this.rememberClassificationInput(existing);
        return;
      }
      if (!classification && key.kind === "logs") {
        for (const name of await this.names()) {
          if (!name.startsWith("logs-")) continue;
          const other = this.keyFromName(name);
          if (other.fromBlock <= key.toBlock && other.toBlock >= key.fromBlock) fail("overlapping log ranges");
        }
      }
      await rename(temp, this.entryPath(key, classification));
      await sync(base);
      // The serializer already established JSON/array/count validity. Authenticate
      // the published receipt and gzip under a stable fence without re-decompressing
      // our own output merely to bind classification or to report coverage.
      const published = await this.inspect(key, classification);
      if (!published || published.receiptText !== receiptText) fail("published entry changed");
      await this.consume(published!, false);
      if (source) await this.unchanged(source);
      if (!classification) {
        this.remember(published!);
        this.rememberClassificationInput(published!);
      }
    } finally {
      if (locked) await rmdir(lock);
      // Only this call's unpublished scratch directory is eligible for removal.
      await rm(temp, { recursive: true, force: true });
    }
  }

  /** Verifies every committed raw entry, reusing only mutation-fenced verification
   * evidence from this handle. A persistent classification alone is never coverage.
   * Stats include
   * both trace methods; traceBlocks counts entries, not unique heights. No complete
   * flag is persisted. Concurrent publication may require retrying an incomplete report. */
  async coverage({ method }: { method: ReadyActivityTraceMethod }): Promise<ReadyActivityArchiveCoverage> {
    this.traceKey({ blockNumber: this.range.fromBlock, method });
    const report: ReadyActivityArchiveCoverage = { complete: false, method, missingLogs: [], missingTraceBlocks: [],
      stats: { entries: 0, logChunks: 0, traceBlocks: 0, items: 0, rawBytes: 0, gzipBytes: 0 } };
    const logs = new Set<number>(), traces = new Set<number>();
    if (await this.context()) {
      for (const name of await this.names()) {
        if (name === "manifest.json" || name.startsWith(".")) continue;
        const key = this.keyFromName(name);
        const entry = await this.load(key, false);
        if (!entry) fail("entry disappeared during coverage verification");
        const receipt = entry!.receipt;
        report.stats.entries++; report.stats.items += receipt.count;
        report.stats.rawBytes += receipt.rawBytes; report.stats.gzipBytes += receipt.gzipBytes;
        if (key.kind === "logs") {
          report.stats.logChunks++;
          for (let block = key.fromBlock; block <= key.toBlock; block++) {
            if (logs.has(block)) fail("overlapping log ranges");
            logs.add(block);
          }
        } else { report.stats.traceBlocks++; if (key.method === method) traces.add(key.fromBlock); }
      }
    }
    for (let block = this.range.fromBlock; block <= this.range.toBlock; block++) {
      if (!logs.has(block)) {
        const last = report.missingLogs.at(-1);
        if (last && last.toBlock === block - 1) last.toBlock = block;
        else report.missingLogs.push({ fromBlock: block, toBlock: block });
      }
      if (!traces.has(block)) report.missingTraceBlocks.push(block);
    }
    report.complete = !report.missingLogs.length && !report.missingTraceBlocks.length;
    return report;
  }

  async assertComplete(input: { method: ReadyActivityTraceMethod }): Promise<ReadyActivityArchiveCoverage> {
    const report = await this.coverage(input);
    if (!report.complete) fail("archive coverage incomplete");
    return report;
  }
}
