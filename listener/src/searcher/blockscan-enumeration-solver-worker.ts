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
  readonly eventsPath: string;
  readonly runId: string;
  readonly maxFileBytes: number;
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

interface RawRouteBatch {
  readonly sequence: number;
  readonly sourceBlock: number;
  readonly sourceBlockHash: string | null;
  readonly pricingMode:
    | "source_n"
    | "n_minus_one_coarse_current_n_exact"
    | null;
  readonly passOutcome: string;
  readonly passReason: string | null;
  readonly routes: readonly BlockScanRouteLocator[];
  readonly enumeration: readonly number[];
  readonly solver: readonly number[];
  readonly gapBefore: RouteGap | null;
}

interface CatalogEntry {
  readonly ref: number;
  readonly locatorKey: string;
}

const options = workerData as WorkerOptions;
if (!parentPort) {
  throw new Error("route telemetry worker requires parentPort");
}
const port = parentPort;

let routeFile: Awaited<ReturnType<typeof open>> | null = null;
let lockFile: Awaited<ReturnType<typeof open>> | null = null;
let lockPath = "";
let lockNonce = "";
let canonicalParent = "";
let epoch = 1;
let epochStartedAtMs = Date.now();
let fileBytes = 0;
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
    void handleBatch(input.batch as RawRouteBatch).catch((error) => {
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
  if (routePath === eventsPath) {
    throw new Error("route sidecar path equals formal events path");
  }
  await mkdir(dirname(routePath), { recursive: true });
  canonicalParent = await realpath(dirname(routePath));
  const canonicalRoutePath = join(canonicalParent, basename(routePath));
  const eventsParent = await realpath(dirname(eventsPath));
  const canonicalEventsPath = join(eventsParent, basename(eventsPath));
  if (canonicalRoutePath === canonicalEventsPath) {
    throw new Error("route sidecar canonical path equals formal events path");
  }

  lockPath = `${canonicalRoutePath}.lock`;
  lockNonce = `${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  lockFile = await acquireLock(lockPath, lockNonce);

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
    if (
      routeStat.dev === eventsStat.dev &&
      routeStat.ino === eventsStat.ino
    ) {
      throw new Error("route sidecar aliases formal events inode");
    }
    await routeFile.truncate(0);
    await routeFile.sync();
  } finally {
    await eventsFile.close();
  }
}

async function handleBatch(batch: RawRouteBatch): Promise<void> {
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
      schema_version: 1,
      run_id: options.runId,
      catalog_epoch: epoch,
      route_ref: entry.ref,
      route_id: routeId,
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
    schema_version: 1,
    run_id: options.runId,
    catalog_epoch: epoch,
    source_block: batch.sourceBlock,
    source_block_hash: batch.sourceBlockHash,
    pricing_mode: batch.pricingMode,
    pass_outcome: batch.passOutcome,
    pass_reason: batch.passReason,
    enumeration: batch.enumeration.map(lookup),
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
    assertRegularOwnedSingleLink(existing, "route telemetry lock");
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
    throw new Error("route telemetry lock has invalid owner pid");
  }
  if (pidAlive(parsed.pid)) {
    throw new Error(`route telemetry lock is held by live pid ${parsed.pid}`);
  }
  const current = await lstat(path);
  assertRegularOwnedSingleLink(current, "route telemetry lock");
  if (current.dev !== existing.dev || current.ino !== existing.ino) {
    throw new Error("route telemetry lock changed during stale-lock validation");
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
      throw new Error("route telemetry write made no progress");
    }
    written += result.bytesWritten;
  }
}

async function cleanup(): Promise<void> {
  const file = routeFile;
  routeFile = null;
  if (file) {
    try {
      await file.sync();
    } catch {}
    try {
      await file.close();
    } catch {}
  }
  const lock = lockFile;
  lockFile = null;
  if (lock) {
    try {
      await lock.close();
    } catch {}
  }
  if (lockPath && lockNonce) {
    try {
      const parsed = JSON.parse(await readFile(lockPath, "utf8")) as {
        readonly nonce?: unknown;
      };
      if (parsed.nonce === lockNonce) await unlink(lockPath);
    } catch {}
  }
}

function validateBatch(batch: RawRouteBatch): void {
  if (!Number.isSafeInteger(batch.sequence) || batch.sequence <= 0) {
    throw new Error("invalid route telemetry sequence");
  }
  if (!Number.isSafeInteger(batch.sourceBlock) || batch.sourceBlock < 0) {
    throw new Error("invalid route telemetry source block");
  }
  if (!Array.isArray(batch.routes) || !Array.isArray(batch.enumeration) ||
      !Array.isArray(batch.solver)) {
    throw new Error("invalid route telemetry batch arrays");
  }
  const validIndex = (index: number): boolean =>
    Number.isSafeInteger(index) && index >= 0 && index < batch.routes.length;
  if (!batch.enumeration.every(validIndex) || !batch.solver.every(validIndex)) {
    throw new Error("route telemetry batch has invalid route index");
  }
}

function locatorKey(locator: BlockScanRouteLocator): string {
  return JSON.stringify([
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

function assertOptions(value: WorkerOptions): void {
  for (const [label, numeric] of [
    ["maxFileBytes", value.maxFileBytes],
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
