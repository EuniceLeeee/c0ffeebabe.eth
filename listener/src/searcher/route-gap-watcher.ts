import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const LISTENER_DIR = resolve(REPO_ROOT, "listener");
const ANALYSIS_DIR = resolve(REPO_ROOT, "analysis");
const DEFAULT_CHECKPOINT_PATH = resolve(
  LISTENER_DIR,
  "searcher",
  "pools",
  ".route-gap-watcher-checkpoint.json",
);
const DEFAULT_PENDING_DEPLOY_PATH = "/tmp/mev-pending-deploy.json";
const DEFAULT_REPORTS_DIR = "/tmp/mev-route-gap-reports";
const EXEC_MAX_BUFFER = 20 * 1024 * 1024;

export interface AutoCloseRunnerResult {
  closedV4PoolIds: string[];
  forceIncludeAdded: string[];
}

export interface RouteGapWatcherOptions {
  eventsPath: string;
  rpcUrl: string;
  checkpointPath?: string;
  pendingDeployPath?: string;
  reportsDir?: string;
  runPostmortem?: (txHash: string) => Promise<string>;
  runAutoClose?: (reportPath: string) => Promise<AutoCloseRunnerResult>;
  log?: (line: string) => void;
  now?: () => Date;
}

export interface RouteGapWatcherSummary {
  eventsScanned: number;
  skippedInvalid: number;
  notIncludedSeen: number;
  postmortemsRun: number;
  routeGapDecisive: number;
  routeGapsClosed: number;
  poolIdsClosed: string[];
  pendingDeployWritten: boolean;
  checkpointPath: string;
  checkpointOffset: number;
}

interface Checkpoint {
  eventsPath?: string;
  offset?: number;
  eventIndex?: number;
  updatedAt?: string;
}

interface JsonlRecord {
  line: string;
  startOffset: number;
  endOffset: number;
}

type JsonRecord = Record<string, unknown>;

const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export async function routeGapWatcher(
  opts: RouteGapWatcherOptions,
): Promise<RouteGapWatcherSummary> {
  if (!opts.eventsPath) throw new Error("--events is required");
  if (!opts.rpcUrl) throw new Error("--rpc is required");

  const log = opts.log ?? console.log;
  const eventsPath = resolveCliPath(opts.eventsPath);
  const checkpointPath = resolveCliPath(opts.checkpointPath ?? DEFAULT_CHECKPOINT_PATH);
  const pendingDeployPath = resolveCliPath(
    opts.pendingDeployPath ?? DEFAULT_PENDING_DEPLOY_PATH,
  );
  const reportsDir = resolveCliPath(opts.reportsDir ?? DEFAULT_REPORTS_DIR);
  mkdirSync(reportsDir, { recursive: true });
  const now = opts.now ?? (() => new Date());
  const checkpoint = checkpointForEvents(readCheckpoint(checkpointPath), eventsPath);
  const file = readFileSync(eventsPath);
  const rawStartOffset = checkpoint.offset === undefined
    ? offsetForEventIndex(file, checkpoint.eventIndex ?? 0)
    : clampOffset(checkpoint.offset, file.length);
  const startOffset = rawStartOffset;
  const records = jsonlRecordsFromOffset(file, startOffset);
  const runPostmortem =
    opts.runPostmortem ?? ((txHash: string) => runBundlePostmortem({
      eventsPath,
      rpcUrl: opts.rpcUrl,
      reportsDir,
      txHash,
    }));
  const runAutoClose =
    opts.runAutoClose ?? ((reportPath: string) => runAutoCloseRouteGap({
      reportPath,
      rpcUrl: opts.rpcUrl,
    }));

  const summary: RouteGapWatcherSummary = {
    eventsScanned: 0,
    skippedInvalid: 0,
    notIncludedSeen: 0,
    postmortemsRun: 0,
    routeGapDecisive: 0,
    routeGapsClosed: 0,
    poolIdsClosed: [],
    pendingDeployWritten: false,
    checkpointPath,
    checkpointOffset: startOffset,
  };
  let eventIndex =
    checkpoint.offset === startOffset
      ? checkpoint.eventIndex ?? countJsonEventsBeforeOffset(file, startOffset)
      : countJsonEventsBeforeOffset(file, startOffset);

  for (const record of records) {
    const line = record.line.trim();
    if (!line) {
      writeCheckpoint(checkpointPath, eventsPath, record.endOffset, eventIndex, now());
      summary.checkpointOffset = record.endOffset;
      continue;
    }

    let event: JsonRecord;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isRecord(parsed)) throw new Error("event must be a JSON object");
      event = parsed;
    } catch {
      summary.skippedInvalid++;
      writeCheckpoint(checkpointPath, eventsPath, record.endOffset, eventIndex, now());
      summary.checkpointOffset = record.endOffset;
      continue;
    }

    summary.eventsScanned++;
    eventIndex++;

    if (event.type !== "bundle_not_included") {
      writeCheckpoint(checkpointPath, eventsPath, record.endOffset, eventIndex, now());
      summary.checkpointOffset = record.endOffset;
      continue;
    }

    const txHash = typeof event.tx_hash === "string" ? event.tx_hash.trim() : "";
    if (!txHash) {
      writeCheckpoint(checkpointPath, eventsPath, record.endOffset, eventIndex, now());
      summary.checkpointOffset = record.endOffset;
      continue;
    }

    summary.notIncludedSeen++;
    const reportPath = await runPostmortem(txHash);
    summary.postmortemsRun++;
    const report = readJsonObject(reportPath, "postmortem report");
    if (!isRouteGapDecisive(report)) {
      writeCheckpoint(checkpointPath, eventsPath, record.endOffset, eventIndex, now());
      summary.checkpointOffset = record.endOffset;
      continue;
    }

    summary.routeGapDecisive++;
    const closeResult = await runAutoClose(reportPath);
    const closedPoolIds = uniquePoolIds([
      ...closeResult.closedV4PoolIds,
      ...closeResult.forceIncludeAdded,
    ]);
    if (closedPoolIds.length > 0) {
      summary.routeGapsClosed++;
      appendUnique(summary.poolIdsClosed, closedPoolIds);
      appendPendingDeployMarker(pendingDeployPath, closedPoolIds, now());
      summary.pendingDeployWritten = true;
      log(
        `[route-gap-watcher] ${closedPoolIds.length} poolIds closed, pending deploy: ` +
          closedPoolIds.join(","),
      );
    }

    writeCheckpoint(checkpointPath, eventsPath, record.endOffset, eventIndex, now());
    summary.checkpointOffset = record.endOffset;
  }

  log(
    "[route-gap-watcher] summary " +
      `events_scanned=${summary.eventsScanned} ` +
      `not_included_seen=${summary.notIncludedSeen} ` +
      `route_gaps_closed=${summary.routeGapsClosed} ` +
      `pending_deploy_written=${summary.pendingDeployWritten ? "yes" : "no"}`,
  );
  return summary;
}

async function runBundlePostmortem(opts: {
  eventsPath: string;
  rpcUrl: string;
  reportsDir: string;
  txHash: string;
}): Promise<string> {
  mkdirSync(opts.reportsDir, { recursive: true });
  const reportPath = join(opts.reportsDir, `pm-${txPrefix(opts.txHash)}.json`);
  await execFileChecked(
    "npm",
    [
      "run",
      "bundle-postmortem",
      "--",
      "--events",
      opts.eventsPath,
      "--tx",
      opts.txHash,
      "--rpc",
      opts.rpcUrl,
      "--out",
      reportPath,
    ],
    ANALYSIS_DIR,
  );
  return reportPath;
}

async function runAutoCloseRouteGap(opts: {
  reportPath: string;
  rpcUrl: string;
}): Promise<AutoCloseRunnerResult> {
  const inferred = inferAutoClosePoolIds(opts.reportPath);
  await execFileChecked(
    "npm",
    [
      "run",
      "auto-close-route-gap",
      "--",
      "--report",
      opts.reportPath,
      "--rpc",
      opts.rpcUrl,
    ],
    LISTENER_DIR,
  );
  return inferred;
}

function execFileChecked(
  command: string,
  args: string[],
  cwd: string,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      command,
      args,
      { cwd, maxBuffer: EXEC_MAX_BUFFER },
      (err, stdout, stderr) => {
        if (!err) {
          resolvePromise();
          return;
        }
        const output = [stdout, stderr].filter(Boolean).join("\n").trim();
        reject(
          new Error(
            `${command} ${args.join(" ")} failed` +
              (output ? `\n${output}` : ""),
          ),
        );
      },
    );
  });
}

function inferAutoClosePoolIds(reportPath: string): AutoCloseRunnerResult {
  const report = readJsonObject(reportPath, "postmortem report");
  const closedV4PoolIds: string[] = [];
  const forceIncludeAdded: string[] = [];
  for (const venue of missingTouchedVenues(report)) {
    const protocol = venue.protocol;
    const id = venue.id;
    if (typeof protocol !== "string" || typeof id !== "string") continue;
    if (protocol === "univ4" && BYTES32_RE.test(id)) {
      closedV4PoolIds.push(id.toLowerCase());
      forceIncludeAdded.push(id.toLowerCase());
    } else if ((protocol === "univ2" || protocol === "univ3") && ADDRESS_RE.test(id)) {
      forceIncludeAdded.push(id);
    }
  }
  return {
    closedV4PoolIds: uniquePoolIds(closedV4PoolIds),
    forceIncludeAdded: uniquePoolIds(forceIncludeAdded),
  };
}

function missingTouchedVenues(report: JsonRecord): JsonRecord[] {
  const competitors = Array.isArray(report.analyzed_competitors)
    ? report.analyzed_competitors
    : [];
  const out: JsonRecord[] = [];
  for (const competitor of competitors) {
    if (!isRecord(competitor) || !Array.isArray(competitor.touchedVenues)) continue;
    for (const venue of competitor.touchedVenues) {
      if (!isRecord(venue) || venue.in_graph !== false) continue;
      out.push(venue);
    }
  }
  return out;
}

function readCheckpoint(path: string): Checkpoint {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error(`checkpoint ${path} must be a JSON object`);
  return parsed as Checkpoint;
}

function checkpointForEvents(checkpoint: Checkpoint, eventsPath: string): Checkpoint {
  if (!checkpoint.eventsPath) return checkpoint;
  return resolveCliPath(checkpoint.eventsPath) === eventsPath ? checkpoint : {};
}

function writeCheckpoint(
  path: string,
  eventsPath: string,
  offset: number,
  eventIndex: number,
  now: Date,
): void {
  writeJsonAtomic(path, {
    eventsPath,
    offset,
    eventIndex,
    updatedAt: now.toISOString(),
  });
}

function appendPendingDeployMarker(
  path: string,
  poolIds: string[],
  now: Date,
): void {
  const existing = readPendingDeployEntries(path);
  existing.push({
    source: "route-gap-watcher",
    writtenAt: now.toISOString(),
    poolIds,
  });
  writeJsonAtomic(path, existing);
}

function readPendingDeployEntries(path: string): unknown[] {
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`pending-deploy marker ${path} must be a JSON array`);
  }
  return parsed;
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmpPath, path);
}

function readJsonObject(path: string, label: string): JsonRecord {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error(`${label} ${path} must be a JSON object`);
  return parsed;
}

function isRouteGapDecisive(report: JsonRecord): boolean {
  return isRecord(report.verdict) && report.verdict.route_gap_decisive === true;
}

function jsonlRecordsFromOffset(file: Buffer, offset: number): JsonlRecord[] {
  const records: JsonlRecord[] = [];
  let start = offset;
  while (start < file.length) {
    const newline = file.indexOf(0x0a, start);
    if (newline === -1) break;
    const lineEnd = newline > start && file[newline - 1] === 0x0d
      ? newline - 1
      : newline;
    records.push({
      line: file.subarray(start, lineEnd).toString("utf8"),
      startOffset: start,
      endOffset: newline + 1,
    });
    start = newline + 1;
  }
  return records;
}

function offsetForEventIndex(file: Buffer, eventIndex: number): number {
  if (eventIndex <= 0) return 0;
  let parsed = 0;
  for (const record of jsonlRecordsFromOffset(file, 0)) {
    const line = record.line.trim();
    if (!line) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (isRecord(value)) parsed++;
    } catch {
      continue;
    }
    if (parsed >= eventIndex) return record.endOffset;
  }
  return file.length;
}

function countJsonEventsBeforeOffset(file: Buffer, offset: number): number {
  let parsed = 0;
  for (const record of jsonlRecordsFromOffset(file.subarray(0, offset), 0)) {
    const line = record.line.trim();
    if (!line) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (isRecord(value)) parsed++;
    } catch {
      continue;
    }
  }
  return parsed;
}

function clampOffset(offset: number, fileLength: number): number {
  if (!Number.isFinite(offset) || offset < 0) return 0;
  if (offset > fileLength) return 0;
  return Math.floor(offset);
}

function txPrefix(txHash: string): string {
  return txHash.trim().toLowerCase().replace(/^0x/, "").slice(0, 12) || "unknown";
}

function uniquePoolIds(values: string[]): string[] {
  const out: string[] = [];
  appendUnique(out, values);
  return out;
}

function appendUnique(out: string[], values: string[]): void {
  const seen = new Set(out.map((value) => value.toLowerCase()));
  for (const value of values) {
    if (typeof value !== "string" || !value.trim()) continue;
    const normalized = normalizePoolIdLike(value);
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
}

function normalizePoolIdLike(value: string): string {
  const trimmed = value.trim();
  if (BYTES32_RE.test(trimmed)) return trimmed.toLowerCase();
  return trimmed;
}

function resolveCliPath(path: string): string {
  return isAbsolute(path) ? path : resolve(path);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArgs(args: string[]): {
  eventsPath: string;
  rpcUrl: string;
  checkpointPath?: string;
  pendingDeployPath?: string;
  reportsDir?: string;
} {
  let eventsPath = "";
  let rpcUrl = "";
  let checkpointPath: string | undefined;
  let pendingDeployPath: string | undefined;
  let reportsDir: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--events") {
      eventsPath = requireValue(args, ++i, "--events");
    } else if (arg === "--rpc") {
      rpcUrl = requireValue(args, ++i, "--rpc");
    } else if (arg === "--checkpoint") {
      checkpointPath = requireValue(args, ++i, "--checkpoint");
    } else if (arg === "--pending-deploy") {
      pendingDeployPath = requireValue(args, ++i, "--pending-deploy");
    } else if (arg === "--reports-dir") {
      reportsDir = requireValue(args, ++i, "--reports-dir");
    } else if (arg === "--help" || arg === "-h") {
      throw new Error(usage());
    } else {
      throw new Error(`unknown option ${arg}\n${usage()}`);
    }
  }

  if (!eventsPath || !rpcUrl) throw new Error(usage());
  return { eventsPath, rpcUrl, checkpointPath, pendingDeployPath, reportsDir };
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function usage(): string {
  return (
    "usage: npm run route-gap-watcher -- --events <jsonl> --rpc <url> " +
    "[--checkpoint <path>] [--pending-deploy <path>] [--reports-dir <dir>]"
  );
}

async function main(): Promise<void> {
  await routeGapWatcher(parseArgs(process.argv.slice(2)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[route-gap-watcher] FAIL: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
