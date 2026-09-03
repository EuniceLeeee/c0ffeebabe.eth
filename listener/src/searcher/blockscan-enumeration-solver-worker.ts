import { constants } from "node:fs";
import {
  mkdir,
  lstat,
  open,
  readFile,
  realpath,
  stat,
  statfs,
  unlink,
} from "node:fs/promises";
import { dirname, basename, join, resolve } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import type { BlockScanRouteLocator } from "./blockscan-route-identity.js";

interface WorkerOptions {
  readonly routePath: string;
  readonly midHistoryPath: string;
  readonly eventsPath: string;
  readonly runId: string;
  readonly maxFileBytes: number;
  readonly maxMidFileBytes: number;
  readonly maxMidRecordBytes: number;
  readonly maxCatalogEntries: number;
  readonly minFreeBytes: number;
  readonly epochMs: number;
  readonly maxEncodedBatchBytes: number;
}

interface RouteGap {
  readonly droppedBatches: number;
  readonly firstDroppedBlock: number;
  readonly lastDroppedBlock: number;
}

type CompactExactValue = number | null;

interface RawRouteBatch {
  readonly kind: "route";
  readonly sequence: number;
  readonly sourceBlock: number;
  readonly sourceBlockHash: string | null;
  readonly midSourceBlock: number | null;
  readonly midSourceBlockHash: string | null;
  readonly pricingMode:
    | "source_n"
    | "n_minus_one_coarse_current_n_exact"
    | null;
  readonly passOutcome: string;
  readonly passReason: string | null;
  readonly routes: readonly BlockScanRouteLocator[];
  readonly enumeration: readonly number[];
  readonly exact: readonly CompactExactValue[] | null;
  readonly planner: readonly number[];
  readonly solver: readonly number[];
  readonly gapBefore: RouteGap | null;
}

interface CompactRouteVenueMid {
  readonly kind: string;
  readonly mid: number;
  readonly fee_bps: number;
  readonly reserve_a?: string;
  readonly reserve_b?: string;
  readonly sqrt_ab_x96?: string;
  readonly liquidity?: string;
  readonly depth_proxy: number;
}

interface MidHistoryAnchor {
  readonly generation: number;
  readonly sourceBlock: number;
  readonly sourceBlockHash: string;
  readonly graphFingerprint: string;
}

interface MidHistoryGap {
  readonly droppedPublications: number;
  readonly firstDroppedBlock: number;
  readonly lastDroppedBlock: number;
}

type RawMidBatch =
  | (MidHistoryAnchor & {
      readonly kind: "mid-baseline";
      readonly sequence: number;
      readonly mids: readonly (readonly [string, CompactRouteVenueMid])[];
      readonly gapBefore: MidHistoryGap | null;
    })
  | (MidHistoryAnchor & {
      readonly kind: "mid-delta";
      readonly sequence: number;
      readonly previousGeneration: number;
      readonly previousSourceBlock: number;
      readonly previousSourceBlockHash: string;
      readonly updates: readonly (readonly [string, CompactRouteVenueMid])[];
      readonly removals: readonly string[];
      readonly gapBefore: null;
    });

type RawTelemetryBatch = RawRouteBatch | RawMidBatch;

interface CatalogEntry {
  readonly ref: number;
  readonly locatorKey: string;
}

const MAX_MID_ENTRIES = 100_000;
const MID_KINDS = new Set([
  "v2",
  "v3",
  "v4",
  "curve",
  "curve-underlying",
  "external-swap",
  "protocol",
]);

const options = workerData as WorkerOptions;
if (!parentPort) {
  throw new Error("route telemetry worker requires parentPort");
}
const port = parentPort;

let routeFile: Awaited<ReturnType<typeof open>> | null = null;
let midFile: Awaited<ReturnType<typeof open>> | null = null;
let lockFile: Awaited<ReturnType<typeof open>> | null = null;
let midLockFile: Awaited<ReturnType<typeof open>> | null = null;
let lockPath = "";
let midLockPath = "";
let lockNonce = "";
let midLockNonce = "";
let canonicalParent = "";
let canonicalMidParent = "";
let epoch = 1;
let epochStartedAtMs = Date.now();
let fileBytes = 0;
let midFileBytes = 0;
let nextRouteRef = 1;
let failed = false;
const catalog = new Map<string, CatalogEntry>();

void initialize()
  .then(() => {
    port.postMessage({ type: "ready", enabled: true });
  })
  .catch(async (error) => {
    await cleanup();
    port.postMessage({
      type: "ready",
      enabled: false,
      reason: message(error),
    });
  });

port.on("message", (input: unknown) => {
  if (!isRecord(input)) return;
  if (input.type === "batch") {
    if (failed) return;
    void handleBatch(input.batch as RawTelemetryBatch).catch((error) => {
      failed = true;
      const sequence = isRecord(input.batch) &&
          typeof input.batch.sequence === "number"
        ? input.batch.sequence
        : -1;
      port.postMessage({
        type: "ack",
        sequence,
        ok: false,
        bytesWritten: fileBytes,
        midBytesWritten: midFileBytes,
        reason: message(error),
      });
    });
    return;
  }
  if (input.type === "shutdown") {
    void cleanup().finally(() => {
      port.postMessage({ type: "shutdown-complete" });
      port.close();
    });
  }
});

async function initialize(): Promise<void> {
  assertOptions(options);
  const routePath = resolve(options.routePath);
  const eventsPath = resolve(options.eventsPath);
  const configuredMidPath = options.midHistoryPath.trim();
  const midHistoryPath = configuredMidPath ? resolve(configuredMidPath) : null;
  if (
    routePath === eventsPath ||
    midHistoryPath === routePath ||
    midHistoryPath === eventsPath
  ) {
    throw new Error("route, mid history, and formal events paths must differ");
  }
  await mkdir(dirname(routePath), { recursive: true });
  if (midHistoryPath) {
    await mkdir(dirname(midHistoryPath), { recursive: true });
  }
  canonicalParent = await realpath(dirname(routePath));
  const canonicalRoutePath = join(canonicalParent, basename(routePath));
  const eventsParent = await realpath(dirname(eventsPath));
  const canonicalEventsPath = join(eventsParent, basename(eventsPath));
  let canonicalMidPath: string | null = null;
  if (midHistoryPath) {
    canonicalMidParent = await realpath(dirname(midHistoryPath));
    canonicalMidPath = join(canonicalMidParent, basename(midHistoryPath));
  }
  if (
    canonicalRoutePath === canonicalEventsPath ||
    canonicalMidPath === canonicalRoutePath ||
    canonicalMidPath === canonicalEventsPath
  ) {
    throw new Error("route, mid history, and formal events canonical paths must differ");
  }

  lockPath = `${canonicalRoutePath}.lock`;
  lockNonce = `${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  lockFile = await acquireLock(lockPath, lockNonce, "route telemetry lock");
  if (canonicalMidPath) {
    midLockPath = `${canonicalMidPath}.lock`;
    midLockNonce =
      `${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    midLockFile = await acquireLock(
      midLockPath,
      midLockNonce,
      "mid history lock",
    );
  }

  const eventsFile = await open(
    canonicalEventsPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const eventsStat = await eventsFile.stat();
    assertRegularOwnedSingleLink(eventsStat, "formal events file");
    routeFile = await open(
      canonicalRoutePath,
      constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    const routeStat = await routeFile.stat();
    assertRegularOwnedSingleLink(routeStat, "route sidecar");
    if (sameInode(routeStat, eventsStat)) {
      throw new Error("route sidecar aliases formal events inode");
    }
    if (canonicalMidPath) {
      midFile = await open(
        canonicalMidPath,
        constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      const midStat = await midFile.stat();
      assertRegularOwnedSingleLink(midStat, "mid history file");
      if (sameInode(midStat, eventsStat)) {
        throw new Error("mid history file aliases formal events inode");
      }
      if (sameInode(midStat, routeStat)) {
        throw new Error("mid history file aliases route sidecar inode");
      }
    }
    await routeFile.truncate(0);
    await routeFile.sync();
    if (midFile) {
      await midFile.truncate(0);
      await midFile.sync();
    }
  } finally {
    await eventsFile.close();
  }
}

async function handleBatch(batch: RawTelemetryBatch): Promise<void> {
  if (batch.kind === "route") {
    await handleRouteBatch(batch);
    return;
  }
  await handleMidBatch(batch);
}

async function handleRouteBatch(batch: RawRouteBatch): Promise<void> {
  if (!routeFile) throw new Error("route sidecar is not ready");
  validateBatch(batch);
  const now = Date.now();
  if (now - epochStartedAtMs >= options.epochMs) {
    await resetEpoch(now);
  }

  const staged = new Map<string, CatalogEntry>();
  let stagedNextRef = nextRouteRef;
  const routeRefs = batch.routes.map((locator) => {
    const key = locatorKey(locator);
    const existing = catalog.get(locator.routeId) ?? staged.get(locator.routeId);
    if (existing) {
      if (existing.locatorKey !== key) {
        throw new Error(`route id collision ${locator.routeId}`);
      }
      return existing.ref;
    }
    const entry = { ref: stagedNextRef++, locatorKey: key };
    staged.set(locator.routeId, entry);
    return entry.ref;
  });
  if (catalog.size + staged.size > options.maxCatalogEntries) {
    throw new Error("route catalog entry cap reached");
  }

  const catalogLines: string[] = [];
  for (const [routeId, entry] of staged) {
    const locator = batch.routes.find((item) => item.routeId === routeId);
    if (!locator) throw new Error("staged route locator disappeared");
    catalogLines.push(JSON.stringify({
      type: "block_scan_route_catalog",
      schema_version: 2,
      run_id: options.runId,
      catalog_epoch: epoch,
      route_ref: entry.ref,
      route_id: routeId,
      edge_ids: locator.edgeIds,
      token_ring: locator.tokenRing,
      venue_path: locator.venuePath,
      flash_token: locator.flashToken,
    }));
  }
  const lookup = (index: number): number => {
    const ref = routeRefs[index];
    if (ref === undefined) throw new Error(`route batch index out of range ${index}`);
    return ref;
  };
  const blockRecord: Record<string, unknown> = {
    type: "block_scan_enumeration_solver",
    schema_version: 2,
    run_id: options.runId,
    catalog_epoch: epoch,
    source_block: batch.sourceBlock,
    source_block_hash: batch.sourceBlockHash,
    mid_source_block: batch.midSourceBlock,
    mid_source_block_hash: batch.midSourceBlockHash,
    pricing_mode: batch.pricingMode,
    pass_outcome: batch.passOutcome,
    pass_reason: batch.passReason,
    enumeration: batch.enumeration.map(lookup),
    exact: batch.exact,
    planner: batch.planner.map(lookup),
    solver: batch.solver.map(lookup),
    ...(batch.gapBefore
      ? {
          dropped_batches: batch.gapBefore.droppedBatches,
          first_dropped_block: batch.gapBefore.firstDroppedBlock,
          last_dropped_block: batch.gapBefore.lastDroppedBlock,
        }
      : {}),
    encoded_bytes: 0,
  };
  const { payload, payloadBytes } = encodeCountedPayload(
    catalogLines,
    blockRecord,
  );
  if (payloadBytes > options.maxEncodedBatchBytes) {
    throw new Error(`route batch exceeds encoded cap ${payloadBytes}`);
  }
  if (fileBytes + payloadBytes > options.maxFileBytes) {
    throw new Error("route telemetry epoch byte cap reached");
  }
  const fsStats = await statfs(canonicalParent);
  const freeBytes = Number(fsStats.bavail) * Number(fsStats.bsize);
  if (!Number.isFinite(freeBytes) || freeBytes < options.minFreeBytes) {
    throw new Error("route telemetry disk reserve reached");
  }

  const payloadBuffer = Buffer.from(payload);
  await writeAll(routeFile, payloadBuffer, fileBytes);
  await routeFile.sync();
  for (const [routeId, entry] of staged) catalog.set(routeId, entry);
  nextRouteRef = stagedNextRef;
  fileBytes += payloadBytes;
  port.postMessage({
    type: "ack",
    sequence: batch.sequence,
    ok: true,
    bytesWritten: fileBytes,
    midBytesWritten: midFileBytes,
  });
}

async function handleMidBatch(batch: RawMidBatch): Promise<void> {
  if (!midFile) throw new Error("mid history file is not ready");
  validateMidBatch(batch);
  const record = batch.kind === "mid-baseline"
    ? {
        type: "block_scan_mid_baseline",
        schema_version: 1,
        run_id: options.runId,
        sequence: batch.sequence,
        source_block: batch.sourceBlock,
        source_block_hash: batch.sourceBlockHash,
        generation: batch.generation,
        graph_fingerprint: batch.graphFingerprint,
        mid_count: batch.mids.length,
        mids: batch.mids,
        ...(batch.gapBefore === null
          ? {}
          : {
              dropped_publications_before:
                batch.gapBefore.droppedPublications,
              first_dropped_block: batch.gapBefore.firstDroppedBlock,
              last_dropped_block: batch.gapBefore.lastDroppedBlock,
            }),
      }
    : {
        type: "block_scan_mid_delta",
        schema_version: 1,
        run_id: options.runId,
        sequence: batch.sequence,
        source_block: batch.sourceBlock,
        source_block_hash: batch.sourceBlockHash,
        generation: batch.generation,
        graph_fingerprint: batch.graphFingerprint,
        previous_source_block: batch.previousSourceBlock,
        previous_source_block_hash: batch.previousSourceBlockHash,
        previous_generation: batch.previousGeneration,
        update_count: batch.updates.length,
        removal_count: batch.removals.length,
        updates: batch.updates,
        removals: batch.removals,
      };
  const payload = `${JSON.stringify(record)}\n`;
  const payloadBytes = Buffer.byteLength(payload);
  if (payloadBytes > options.maxMidRecordBytes) {
    throw new Error(`mid history record exceeds encoded cap ${payloadBytes}`);
  }
  if (midFileBytes + payloadBytes > options.maxMidFileBytes) {
    throw new Error("mid history file byte cap reached");
  }
  const fsStats = await statfs(canonicalMidParent);
  const freeBytes = Number(fsStats.bavail) * Number(fsStats.bsize);
  if (!Number.isFinite(freeBytes) || freeBytes < options.minFreeBytes) {
    throw new Error("mid history disk reserve reached");
  }
  await writeAll(midFile, Buffer.from(payload), midFileBytes);
  await midFile.sync();
  midFileBytes += payloadBytes;
  port.postMessage({
    type: "ack",
    sequence: batch.sequence,
    ok: true,
    bytesWritten: fileBytes,
    midBytesWritten: midFileBytes,
  });
}

async function resetEpoch(now: number): Promise<void> {
  if (!routeFile) throw new Error("route sidecar is not ready");
  await routeFile.truncate(0);
  await routeFile.sync();
  epoch++;
  epochStartedAtMs = now;
  fileBytes = 0;
  nextRouteRef = 1;
  catalog.clear();
}

function encodePayload(
  catalogLines: readonly string[],
  blockRecord: Readonly<Record<string, unknown>>,
): string {
  return `${[...catalogLines, JSON.stringify(blockRecord)].join("\n")}\n`;
}

function encodeCountedPayload(
  catalogLines: readonly string[],
  blockRecord: Record<string, unknown>,
): { readonly payload: string; readonly payloadBytes: number } {
  for (let attempt = 0; attempt < 8; attempt++) {
    const payload = encodePayload(catalogLines, blockRecord);
    const payloadBytes = Buffer.byteLength(payload);
    if (blockRecord.encoded_bytes === payloadBytes) {
      return { payload, payloadBytes };
    }
    blockRecord.encoded_bytes = payloadBytes;
  }
  throw new Error("route telemetry encoded byte count did not converge");
}

async function acquireLock(
  path: string,
  nonce: string,
  label: string,
): Promise<Awaited<ReturnType<typeof open>>> {
  const flags =
    constants.O_CREAT |
    constants.O_EXCL |
    constants.O_WRONLY |
    constants.O_NOFOLLOW;
  try {
    const handle = await open(path, flags, 0o600);
    await handle.writeFile(JSON.stringify({ pid: process.pid, nonce }));
    await handle.sync();
    return handle;
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }

  const existingHandle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let existing: Awaited<ReturnType<typeof stat>>;
  let parsed: { readonly pid?: unknown };
  try {
    existing = await existingHandle.stat();
    assertRegularOwnedSingleLink(existing, label);
    parsed = JSON.parse(await existingHandle.readFile("utf8")) as {
      readonly pid?: unknown;
    };
  } finally {
    await existingHandle.close();
  }
  if (
    typeof parsed.pid !== "number" ||
    !Number.isSafeInteger(parsed.pid) ||
    parsed.pid <= 0
  ) {
    throw new Error(`${label} has invalid owner pid`);
  }
  if (pidAlive(parsed.pid)) {
    throw new Error(`${label} is held by live pid ${parsed.pid}`);
  }
  const current = await lstat(path);
  assertRegularOwnedSingleLink(current, label);
  if (current.dev !== existing.dev || current.ino !== existing.ino) {
    throw new Error(`${label} changed during stale-lock validation`);
  }
  await unlink(path);
  const handle = await open(path, flags, 0o600);
  await handle.writeFile(JSON.stringify({ pid: process.pid, nonce }));
  await handle.sync();
  return handle;
}

async function writeAll(
  file: Awaited<ReturnType<typeof open>>,
  payload: Buffer,
  position: number,
): Promise<void> {
  let written = 0;
  while (written < payload.length) {
    const result = await file.write(
      payload,
      written,
      payload.length - written,
      position + written,
    );
    if (result.bytesWritten <= 0) {
      throw new Error("telemetry write made no progress");
    }
    written += result.bytesWritten;
  }
}

async function cleanup(): Promise<void> {
  const files = [routeFile, midFile];
  routeFile = null;
  midFile = null;
  for (const file of files) {
    if (!file) continue;
    try {
      await file.sync();
    } catch {}
    try {
      await file.close();
    } catch {}
  }
  const locks = [lockFile, midLockFile];
  lockFile = null;
  midLockFile = null;
  for (const lock of locks) {
    if (!lock) continue;
    try {
      await lock.close();
    } catch {}
  }
  for (const [path, nonce] of [
    [lockPath, lockNonce],
    [midLockPath, midLockNonce],
  ] as const) {
    if (!path || !nonce) continue;
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as {
        readonly nonce?: unknown;
      };
      if (parsed.nonce === nonce) await unlink(path);
    } catch {}
  }
}

function validateBatch(batch: RawRouteBatch): void {
  if (batch.kind !== "route") {
    throw new Error("invalid route telemetry kind");
  }
  if (!Number.isSafeInteger(batch.sequence) || batch.sequence <= 0) {
    throw new Error("invalid route telemetry sequence");
  }
  if (!Number.isSafeInteger(batch.sourceBlock) || batch.sourceBlock < 0) {
    throw new Error("invalid route telemetry source block");
  }
  if (!Array.isArray(batch.routes) || !Array.isArray(batch.enumeration) ||
      !Array.isArray(batch.planner) || !Array.isArray(batch.solver) ||
      (batch.exact !== null && !Array.isArray(batch.exact))) {
    throw new Error("invalid route telemetry batch arrays");
  }
  const validIndex = (index: number): boolean =>
    Number.isSafeInteger(index) && index >= 0 && index < batch.routes.length;
  if (
    !batch.enumeration.every(validIndex) ||
    !batch.planner.every(validIndex) ||
    !batch.solver.every(validIndex) ||
    (
      batch.exact !== null &&
      (
        batch.exact.length !== batch.enumeration.length * 4 ||
        !validCompactExactDiagnostics(batch.exact)
      )
    )
  ) {
    throw new Error("route telemetry batch has invalid route index");
  }
  if (
    batch.midSourceBlock !== null &&
    (!Number.isSafeInteger(batch.midSourceBlock) || batch.midSourceBlock < 0)
  ) {
    throw new Error("invalid route telemetry mid source block");
  }
  if (
    (batch.midSourceBlock === null) !== (batch.midSourceBlockHash === null)
  ) {
    throw new Error("route telemetry mid source anchor is incomplete");
  }
}

function validateMidBatch(batch: RawMidBatch): void {
  if (!Number.isSafeInteger(batch.sequence) || batch.sequence <= 0) {
    throw new Error("invalid mid history sequence");
  }
  if (
    !Number.isSafeInteger(batch.sourceBlock) || batch.sourceBlock < 0 ||
    !Number.isSafeInteger(batch.generation) || batch.generation < 0 ||
    !validText(batch.sourceBlockHash, 128) ||
    !validText(batch.graphFingerprint, 512)
  ) {
    throw new Error("invalid mid history source anchor");
  }
  if (batch.kind === "mid-baseline") {
    if (!Array.isArray(batch.mids) || batch.mids.length > MAX_MID_ENTRIES) {
      throw new Error("invalid mid history baseline size");
    }
    validateMidEntries(batch.mids);
    if (batch.gapBefore !== null && (
      !Number.isSafeInteger(batch.gapBefore.droppedPublications) ||
      batch.gapBefore.droppedPublications <= 0 ||
      !Number.isSafeInteger(batch.gapBefore.firstDroppedBlock) ||
      !Number.isSafeInteger(batch.gapBefore.lastDroppedBlock) ||
      batch.gapBefore.firstDroppedBlock < 0 ||
      batch.gapBefore.lastDroppedBlock < batch.gapBefore.firstDroppedBlock
    )) {
      throw new Error("invalid mid history writer gap");
    }
    return;
  }
  if (batch.kind !== "mid-delta") {
    throw new Error("invalid mid history kind");
  }
  if (
    !Number.isSafeInteger(batch.previousSourceBlock) ||
    batch.previousSourceBlock < 0 ||
    !Number.isSafeInteger(batch.previousGeneration) ||
    batch.previousGeneration < 0 ||
    !validText(batch.previousSourceBlockHash, 128) ||
    !Array.isArray(batch.updates) ||
    !Array.isArray(batch.removals) ||
    batch.updates.length + batch.removals.length > MAX_MID_ENTRIES
  ) {
    throw new Error("invalid mid history delta");
  }
  validateMidEntries(batch.updates);
  const updateKeys = new Set(batch.updates.map(([edgeKey]) => edgeKey));
  const removalKeys = new Set<string>();
  for (const edgeKey of batch.removals) {
    if (
      !validText(edgeKey, 1_024) ||
      removalKeys.has(edgeKey) ||
      updateKeys.has(edgeKey)
    ) {
      throw new Error("invalid mid history removal");
    }
    removalKeys.add(edgeKey);
  }
}

function validateMidEntries(
  entries: readonly (readonly [string, CompactRouteVenueMid])[],
): void {
  const keys = new Set<string>();
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new Error("invalid mid history entry");
    }
    const [edgeKey, mid] = entry;
    if (!validText(edgeKey, 1_024) || keys.has(edgeKey) || !validMid(mid)) {
      throw new Error("invalid mid history entry");
    }
    keys.add(edgeKey);
  }
}

function validMid(mid: CompactRouteVenueMid): boolean {
  if (!isRecord(mid)) return false;
  return typeof mid.kind === "string" && MID_KINDS.has(mid.kind) &&
    typeof mid.mid === "number" && Number.isFinite(mid.mid) && mid.mid > 0 &&
    typeof mid.fee_bps === "number" && Number.isFinite(mid.fee_bps) &&
    mid.fee_bps >= 0 &&
    typeof mid.depth_proxy === "number" &&
    Number.isFinite(mid.depth_proxy) && mid.depth_proxy >= 0 &&
    validOptionalIntegerString(mid.reserve_a) &&
    validOptionalIntegerString(mid.reserve_b) &&
    validOptionalIntegerString(mid.sqrt_ab_x96) &&
    validOptionalIntegerString(mid.liquidity);
}

function validOptionalIntegerString(value: unknown): boolean {
  return value === undefined ||
    (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value));
}

function validCompactExactDiagnostics(
  values: readonly CompactExactValue[],
): boolean {
  for (let offset = 0; offset < values.length; offset += 4) {
    const status = values[offset];
    const attempted = values[offset + 1];
    const margin = values[offset + 2];
    const failure = values[offset + 3];
    if (
      status === null || status === undefined ||
      !Number.isSafeInteger(status) || status < 1 || status > 4 ||
      (attempted !== 0 && attempted !== 1) ||
      (margin !== null && (margin === undefined || !Number.isFinite(margin))) ||
      failure === null || failure === undefined ||
      !Number.isSafeInteger(failure) || failure < 0 || failure > 7
    ) return false;
  }
  return true;
}

function locatorKey(locator: BlockScanRouteLocator): string {
  return JSON.stringify([
    locator.edgeIds,
    locator.tokenRing,
    locator.venuePath,
    locator.flashToken,
  ]);
}

function assertRegularOwnedSingleLink(
  value: Awaited<ReturnType<typeof stat>>,
  label: string,
): void {
  if (!value.isFile()) throw new Error(`${label} is not a regular file`);
  if (value.nlink !== 1) throw new Error(`${label} must have one link`);
  if (typeof process.getuid === "function" && value.uid !== process.getuid()) {
    throw new Error(`${label} is not owned by the current user`);
  }
}

function sameInode(
  left: Awaited<ReturnType<typeof stat>>,
  right: Awaited<ReturnType<typeof stat>>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertOptions(value: WorkerOptions): void {
  if (
    !validText(value.routePath, 4_096) ||
    typeof value.midHistoryPath !== "string" ||
    !validText(value.eventsPath, 4_096) ||
    !validText(value.runId, 256)
  ) {
    throw new Error("invalid route telemetry worker identity");
  }
  for (const [label, numeric] of [
    ["maxFileBytes", value.maxFileBytes],
    ["maxMidFileBytes", value.maxMidFileBytes],
    ["maxMidRecordBytes", value.maxMidRecordBytes],
    ["maxCatalogEntries", value.maxCatalogEntries],
    ["minFreeBytes", value.minFreeBytes],
    ["epochMs", value.epochMs],
    ["maxEncodedBatchBytes", value.maxEncodedBatchBytes],
  ] as const) {
    if (!Number.isSafeInteger(numeric) || numeric <= 0) {
      throw new Error(`invalid route telemetry ${label}`);
    }
  }
}

function validText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= maxLength;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

function errorCode(error: unknown): string | null {
  return isRecord(error) && typeof error.code === "string"
    ? error.code
    : null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}
