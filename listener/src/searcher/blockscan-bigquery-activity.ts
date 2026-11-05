import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { open as openTokenFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  BlockActivityRangeInvalidatedError, readBlockTouchedStateKeys,
  type BlockTouchedCanonicalAnchor, type BlockTouchedProvider, type BlockTouchedStateKeyResolver,
} from "./blockscan-touched-state.js";

export interface BigQueryActivityConfig {
  readonly project?: string;
  readonly location?: string;
  readonly gcloudConfiguration?: string;
  readonly authMode?: "gcloud" | "metadata" | "token-file";
  readonly tokenFile?: string;
  readonly maximumBytesBilled?: string;
}

export interface BigQueryActivityRow {
  readonly n: number;
  readonly k: number;
  readonly p: Record<string, unknown>;
}

export interface BigQueryTouchedRangeInput {
  readonly previousSource: { readonly number: number; readonly hash: string };
  readonly targetNumber: number;
  readonly target: BlockTouchedCanonicalAnchor;
  /** Canonical RPC headers retain the existing consensus/passive-activity gate. */
  readonly readHeader: (number: number) => Promise<BlockTouchedCanonicalAnchor>;
  readonly startTimestamp: number;
  readonly endTimestamp: number;
  readonly poolManager: string;
  readonly resolver?: BlockTouchedStateKeyResolver;
  readonly signal?: AbortSignal;
  readonly deadlineAtMs: number;
  readonly config?: BigQueryActivityConfig;
}

type BigQueryQueryWindow = Pick<BigQueryTouchedRangeInput,
  "targetNumber" | "startTimestamp" | "endTimestamp" | "signal" | "deadlineAtMs" | "config"> & {
    readonly previousSource: { readonly number: number };
  };

const HASH = /^0x[0-9a-f]{64}$/i;
const DEFAULT_MAX_BYTES = String(100 * 1024 ** 3);
const DATASET = "bigquery-public-data.crypto_ethereum";
const MAX_BLOCK_ROWS = 1_000_000;

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`BigQuery activity: ${message}`);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function integer(value: unknown): number {
  requireValue(typeof value === "number" || (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)), "invalid integer");
  const number = Number(value);
  requireValue(Number.isSafeInteger(number) && number >= 0, "integer outside safe range");
  return number;
}
function hash(value: unknown): string {
  requireValue(typeof value === "string" && HASH.test(value), "invalid hash");
  return value.toLowerCase();
}
function quantity(value: unknown): string {
  requireValue(typeof value === "number" ? Number.isSafeInteger(value) && value >= 0
    : typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value), "invalid quantity");
  return `0x${BigInt(value as string | number).toString(16)}`;
}
function open(input: Pick<BigQueryTouchedRangeInput, "signal" | "deadlineAtMs">): void {
  input.signal?.throwIfAborted();
  requireValue(Date.now() < input.deadlineAtMs, "deadline exceeded");
}

/** No discovery predicates: failed/static/internal calls and every log are retained. */
export const BIGQUERY_ACTIVITY_SQL = `
WITH activity AS (
  SELECT number AS n, 0 AS k, TO_JSON_STRING(STRUCT(\`hash\`, parent_hash, transaction_count)) AS p
  FROM \`${DATASET}.blocks\`
  WHERE timestamp BETWEEN TIMESTAMP_SECONDS(@start_ts) AND TIMESTAMP_SECONDS(@end_ts)
    AND number BETWEEN @first AND @last
  UNION ALL
  SELECT block_number, 1, TO_JSON_STRING(STRUCT(\`hash\`, transaction_index, block_hash))
  FROM \`${DATASET}.transactions\`
  WHERE block_timestamp BETWEEN TIMESTAMP_SECONDS(@start_ts) AND TIMESTAMP_SECONDS(@end_ts)
    AND block_number BETWEEN @first AND @last
  UNION ALL
  SELECT block_number, 2, TO_JSON_STRING(STRUCT(log_index, transaction_hash, transaction_index, block_hash, address, topics, data))
  FROM \`${DATASET}.logs\`
  WHERE block_timestamp BETWEEN TIMESTAMP_SECONDS(@start_ts) AND TIMESTAMP_SECONDS(@end_ts)
    AND block_number BETWEEN @first AND @last
  UNION ALL
  SELECT block_number, 3, TO_JSON_STRING(STRUCT(transaction_hash, transaction_index, block_hash,
    from_address, to_address, input, output, trace_type, call_type, gas, gas_used, value,
    subtraces, trace_address, error, status))
  FROM \`${DATASET}.traces\`
  WHERE block_timestamp BETWEEN TIMESTAMP_SECONDS(@start_ts) AND TIMESTAMP_SECONDS(@end_ts)
    AND block_number BETWEEN @first AND @last
)
SELECT TO_JSON_STRING(STRUCT(n, k, p)) AS row_json FROM activity ORDER BY n, k`;

export function bigQueryActivityRequest(input: BigQueryQueryWindow): Record<string, unknown> {
  const first = input.previousSource.number + 1;
  requireValue(Number.isSafeInteger(first) && first > 0 && Number.isSafeInteger(input.targetNumber) && input.targetNumber >= first,
    "invalid forward range");
  requireValue(Number.isSafeInteger(input.startTimestamp) && input.startTimestamp >= 0 &&
    Number.isSafeInteger(input.endTimestamp) && input.endTimestamp >= input.startTimestamp, "invalid timestamp bounds");
  const maximumBytesBilled = input.config?.maximumBytesBilled ?? DEFAULT_MAX_BYTES;
  requireValue(/^[1-9][0-9]*$/.test(maximumBytesBilled) && BigInt(maximumBytesBilled) <= BigInt(DEFAULT_MAX_BYTES),
    "billing cap must be positive and at most 100 GiB");
  return { query: BIGQUERY_ACTIVITY_SQL, useLegacySql: false, parameterMode: "NAMED", maximumBytesBilled,
    location: input.config?.location ?? "US", timeoutMs: 10_000, maxResults: 2_000,
    queryParameters: Object.entries({ first, last: input.targetNumber, start_ts: input.startTimestamp, end_ts: input.endTimestamp })
      .map(([name, value]) => ({ name, parameterType: { type: "INT64" }, parameterValue: { value: String(value) } })),
  };
}

/** Reuse Ready's short-lived { token, expiresAt } receipt; never expose file errors
 * or JSON parser excerpts, which can contain the credential or its private path. */
async function tokenFileAccessToken(path: string | undefined): Promise<string> {
  try {
    if (typeof path !== "string" || !isAbsolute(path) || typeof process.getuid !== "function") throw new Error();
    // NOFOLLOW protects the opened file, not just a racy pre-open lstat. NONBLOCK
    // lets fstat reject a FIFO/device without waiting for another process.
    const handle = await openTokenFile(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.uid !== process.getuid() || (before.mode & 0o077) !== 0 || (before.mode & 0o400) === 0 ||
          before.size <= 0 || before.size > 16_384) throw new Error();
      const buffer = Buffer.alloc(16_385);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const after = await handle.stat();
      if (bytesRead !== before.size || after.size !== before.size || after.uid !== before.uid ||
          after.mode !== before.mode || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error();
      const value: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
      if (!record(value) || typeof value.token !== "string" || !/^[A-Za-z0-9._~-]{30,8192}$/.test(value.token) ||
          !Number.isSafeInteger(value.expiresAt) || (value.expiresAt as number) <= Date.now()) throw new Error();
      return value.token;
    } finally {
      await handle.close();
    }
  } catch {
    throw new Error("BigQuery activity: token-file authentication failed");
  }
}

async function accessToken(input: BigQueryQueryWindow, signal: AbortSignal): Promise<string> {
  requireValue(input.config?.authMode === undefined || ["gcloud", "metadata", "token-file"].includes(input.config.authMode), "invalid authentication mode");
  if (input.config?.authMode === "token-file") return tokenFileAccessToken(input.config.tokenFile);
  if ((input.config?.authMode ?? "metadata") === "metadata") {
    const response = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", {
      headers: { "Metadata-Flavor": "Google" }, signal,
    });
    requireValue(response.ok, "metadata authentication failed");
    const value: unknown = await response.json();
    requireValue(record(value) && typeof value.access_token === "string" && value.access_token.length > 0, "metadata authentication malformed");
    return value.access_token;
  }
  const configuration = input.config?.gcloudConfiguration ?? "mev-rpc-latency";
  requireValue(/^[a-zA-Z0-9_-]+$/.test(configuration), "invalid gcloud configuration");
  // Never propagate child errors/stderr: they can contain credential material.
  return new Promise((resolve, reject) => {
    execFile("gcloud", [`--configuration=${configuration}`, "auth", "print-access-token"],
      { encoding: "utf8", maxBuffer: 16_384, timeout: 30_000, signal }, (error, stdout) => {
        if (error || !stdout.trim() || /\s/.test(stdout.trim())) reject(new Error("BigQuery activity: gcloud authentication failed"));
        else resolve(stdout.trim());
      });
  });
}

/** One bounded SELECT job; streamed pages never retain the entire historical gap. */
export async function* queryBigQueryActivityRows(input: BigQueryTouchedRangeInput): AsyncGenerator<BigQueryActivityRow> {
  for await (const value of queryBigQueryJsonRows(input, bigQueryActivityRequest(input))) {
    requireValue(typeof value.p === "string", "malformed activity row");
    const payload: unknown = JSON.parse(value.p);
    requireValue(record(payload), "malformed activity payload");
    yield { n: integer(value.n), k: integer(value.k), p: payload };
  }
}

async function queryClient(input: BigQueryQueryWindow) {
  open(input);
  const project = input.config?.project ?? "eth-token-480803";
  const location = input.config?.location ?? "US";
  requireValue(/^[a-z][a-z0-9-]+$/.test(project) && /^[a-zA-Z0-9-]+$/.test(location), "invalid project/location");
  const signal = AbortSignal.any([...(input.signal ? [input.signal] : []), AbortSignal.timeout(Math.max(1, input.deadlineAtMs - Date.now()))]);
  const token = await accessToken(input, signal);
  const root = `https://bigquery.googleapis.com/bigquery/v2/projects/${project}`;
  const request = async (path: string, init?: RequestInit): Promise<Record<string, unknown>> => {
    open(input);
    const response = await fetch(`${root}${path}`, { ...init, signal,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
    requireValue(response.ok, `query HTTP ${response.status}`);
    const value: unknown = await response.json();
    requireValue(record(value) && !value.error &&
      (value.errors === undefined || (Array.isArray(value.errors) && value.errors.length === 0)), "query failed");
    return value;
  };
  const post = (value: unknown) => request("/queries", { method: "POST", body: JSON.stringify(value) });
  const cancel = async (jobId: string): Promise<void> => {
    // A caller abort does not cancel a server-side query. Never leak auth on failure.
    try {
      await fetch(`${root}/jobs/${jobId}/cancel?location=${location}`, { method: "POST",
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000) });
    } catch { /* The job deadline and maximumBytesBilled remain server-side caps. */ }
  };
  return { request, post, cancel, location };
}

async function checkedDryRun(client: Awaited<ReturnType<typeof queryClient>>, body: Record<string, unknown>): Promise<{ totalBytesProcessed: string }> {
  const dry = await client.post({ ...body, dryRun: true });
  requireValue(typeof dry.totalBytesProcessed === "string" && /^[0-9]+$/.test(dry.totalBytesProcessed) &&
    BigInt(dry.totalBytesProcessed) <= BigInt(body.maximumBytesBilled as string), "dry-run estimate exceeds cap or is missing");
  return { totalBytesProcessed: dry.totalBytesProcessed };
}

/** Validate real SQL schema/cost without submitting a billable SELECT job. */
export async function dryRunBigQueryActivity(input: BigQueryQueryWindow): Promise<{ totalBytesProcessed: string }> {
  const body = bigQueryActivityRequest(input);
  return checkedDryRun(await queryClient(input), body);
}

async function* queryBigQueryJsonRows(input: BigQueryQueryWindow, body: Record<string, unknown>): AsyncGenerator<Record<string, unknown>> {
  const client = await queryClient(input);
  const { post, request, cancel, location } = client;
  await checkedDryRun(client, body);
  let page = await post({ ...body, jobTimeoutMs: String(Math.max(1, input.deadlineAtMs - Date.now())) });
  requireValue(record(page.jobReference) && typeof page.jobReference.jobId === "string" &&
    /^[a-zA-Z0-9_-]+$/.test(page.jobReference.jobId), "missing job identity");
  const jobId = page.jobReference.jobId;
  let yielded = 0;
  let expectedRows: number | undefined;
  const seenPages = new Set<string>();
  let jobComplete = false;
  try {
  while (true) {
    open(input);
    if (page.jobComplete !== true) {
      requireValue(page.rows === undefined, "incomplete query returned rows");
      page = await request(`/queries/${jobId}?location=${location}&maxResults=2000&timeoutMs=10000`);
      continue;
    }
    jobComplete = true;
    const total = integer(page.totalRows);
    if (expectedRows === undefined) expectedRows = total;
    requireValue(total === expectedRows && (page.rows === undefined || Array.isArray(page.rows)), "inconsistent result pages");
    for (const raw of (page.rows ?? []) as unknown[]) {
      requireValue(record(raw) && Array.isArray(raw.f) && raw.f.length === 1 && record(raw.f[0]) && typeof raw.f[0].v === "string", "malformed row");
      const value: unknown = JSON.parse(raw.f[0].v);
      requireValue(record(value), "malformed JSON row");
      yielded++;
      requireValue(yielded <= expectedRows, "excess rows");
      yield value;
    }
    if (page.pageToken === undefined) break;
    requireValue(typeof page.pageToken === "string" && page.pageToken.length > 0 && !seenPages.has(page.pageToken), "repeated page token");
    seenPages.add(page.pageToken);
    page = await request(`/queries/${jobId}?location=${location}&maxResults=2000&pageToken=${encodeURIComponent(page.pageToken)}`);
  }
  requireValue(yielded === expectedRows, "truncated result set");
  } finally {
    if (!jobComplete) {
      // Cancelling the caller is not sufficient to cancel a server-side query.
      // Bounded best effort preserves the original failure and keeps credentials private.
      await cancel(jobId);
    }
  }
}

export interface BigQueryActivityCutoffInput {
  readonly fromNumber: number;
  readonly toNumber: number;
  readonly startTimestamp: number;
  readonly endTimestamp: number;
  readonly signal?: AbortSignal;
  readonly deadlineAtMs: number;
  readonly config?: BigQueryActivityConfig;
}

/** A conservative index watermark, NOT a coverage proof. The range reader still
 * checks every block. No indexed suffix means RPC must cover it, never clean carry. */
export async function getBigQueryActivityCutoff(input: BigQueryActivityCutoffInput): Promise<number | null> {
  // The query transport only uses range/timing fields; no observation interpreter
  // or synthetic header is involved in this index metadata query.
  const range = { ...input, previousSource: { number: input.fromNumber - 1 }, targetNumber: input.toNumber };
  const body = bigQueryActivityRequest(range);
  body.query = `WITH tips AS (
    SELECT MAX(number) AS tip FROM \`${DATASET}.blocks\`
    WHERE timestamp BETWEEN TIMESTAMP_SECONDS(@start_ts) AND TIMESTAMP_SECONDS(@end_ts) AND number BETWEEN @first AND @last
    UNION ALL
    SELECT MAX(block_number) FROM \`${DATASET}.transactions\`
    WHERE block_timestamp BETWEEN TIMESTAMP_SECONDS(@start_ts) AND TIMESTAMP_SECONDS(@end_ts) AND block_number BETWEEN @first AND @last
    UNION ALL
    SELECT MAX(block_number) FROM \`${DATASET}.logs\`
    WHERE block_timestamp BETWEEN TIMESTAMP_SECONDS(@start_ts) AND TIMESTAMP_SECONDS(@end_ts) AND block_number BETWEEN @first AND @last
    UNION ALL
    SELECT MAX(block_number) FROM \`${DATASET}.traces\`
    WHERE block_timestamp BETWEEN TIMESTAMP_SECONDS(@start_ts) AND TIMESTAMP_SECONDS(@end_ts) AND block_number BETWEEN @first AND @last
  ) SELECT TO_JSON_STRING(STRUCT(IF(COUNT(tip) = 4, MIN(tip), NULL) AS cutoff)) AS row_json FROM tips`;
  const rows: Record<string, unknown>[] = [];
  for await (const row of queryBigQueryJsonRows(range, body)) rows.push(row);
  requireValue(rows.length === 1, "invalid cutoff result");
  if (rows[0]!.cutoff === null) return null;
  const cutoff = integer(rows[0]!.cutoff);
  requireValue(cutoff >= input.fromNumber && cutoff <= input.toNumber, "cutoff outside requested range");
  return cutoff;
}

function normalizedTraces(rows: readonly Record<string, unknown>[], transactions: readonly string[]): unknown[] {
  const groups = transactions.map(() => new Map<string, { row: Record<string, unknown>; frame: Record<string, unknown> }>());
  for (const row of rows) {
    const index = integer(row.transaction_index);
    requireValue(index < transactions.length && hash(row.transaction_hash) === transactions[index], "trace transaction mismatch");
    // The public ethereum-etl table stores an empty root path as SQL NULL.
    // Missing fields are not roots; explicit NULL and empty string are equivalent.
    const path = row.trace_address === null ? "" : row.trace_address;
    requireValue(typeof path === "string" && /^(?:[0-9]+(?:,[0-9]+)*)?$/.test(path), "invalid trace path");
    requireValue(path === "" || path.split(",").every(part => String(integer(part)) === part), "noncanonical trace path");
    requireValue(!groups[index]!.has(path), "duplicate trace path");
    requireValue(row.status === 0 || row.status === 1 || row.status === "0" || row.status === "1", "missing trace status");
    let type: string;
    if (row.trace_type === "call") {
      requireValue(typeof row.call_type === "string" && ["call", "callcode", "delegatecall", "staticcall"].includes(row.call_type), "unknown call type");
      type = row.call_type.toUpperCase();
    } else if (row.trace_type === "create") type = "CREATE";
    else if (row.trace_type === "suicide") type = "SELFDESTRUCT";
    else throw new Error("BigQuery activity: unsupported trace type");
    const suicide = type === "SELFDESTRUCT";
    const failed = row.status === 0 || row.status === "0";
    const frame: Record<string, unknown> = { type, from: row.from_address,
      input: suicide && row.input == null ? "0x" : row.input,
      gas: quantity(suicide && row.gas == null ? 0 : row.gas),
      gasUsed: quantity((suicide || failed) && row.gas_used == null ? 0 : row.gas_used),
      ...(row.output == null ? {} : { output: row.output }),
      ...(row.value == null ? {} : { value: quantity(row.value) }),
      ...(row.to_address == null ? {} : { to: row.to_address }),
      ...(row.error == null || row.error === "" ? {} : { error: row.error }),
      calls: [],
    };
    if (type === "CREATE" && row.to_address == null && failed && !frame.error) frame.error = "creation failed";
    groups[index]!.set(path, { row, frame });
  }
  return groups.map((group, index) => {
    requireValue(group.has(""), "missing transaction root trace");
    const childIndexes = new Map<string, Set<number>>();
    for (const [path, { frame }] of group) {
      if (path === "") continue;
      const parts = path.split(",");
      const child = integer(parts.pop());
      const parent = parts.join(",");
      const node = group.get(parent);
      requireValue(node, "orphan trace");
      const indexes = childIndexes.get(parent) ?? new Set<number>();
      indexes.add(child); childIndexes.set(parent, indexes);
      (node.frame.calls as unknown[]).push(frame);
    }
    for (const [path, { row }] of group) {
      const count = integer(row.subtraces), children = childIndexes.get(path) ?? new Set<number>();
      requireValue(count === children.size && [...children].every(child => child < count), "incomplete trace children");
    }
    return { txHash: transactions[index], result: group.get("")!.frame };
  });
}

/** Same production touched classifier, only the observation transport differs.
 * Like RPC's full callTracer/getLogs, complete provider extraction is a trust
 * boundary; SQL continuity/count/tree checks reject partial ingestion, not forge
 * cryptographic execution proofs from the indexer's own rows. */
export async function readBigQueryTouchedRange(
  input: BigQueryTouchedRangeInput,
  rows: AsyncIterable<BigQueryActivityRow> = queryBigQueryActivityRows(input),
): Promise<ReadonlySet<string>> {
  open(input);
  bigQueryActivityRequest(input);
  requireValue(Array.isArray(input.target.passiveTouchedAddresses), "target lacks supported consensus activity coverage");
  const touched = new Set<string>();
  let previous = { number: input.previousSource.number, hash: hash(input.previousSource.hash) };
  const targetHash = hash(input.target.hash);
  let pending: BigQueryActivityRow[] = [];
  let pendingNumber = previous.number + 1;
  let lastKind = -1;
  const consume = async (): Promise<void> => {
    open(input);
    requireValue(pending.length > 0 && pending[0]!.k === 0 && pending.filter(row => row.k === 0).length === 1, "missing or duplicate block");
    const block = pending[0]!.p;
    const anchor = pendingNumber === input.targetNumber ? input.target : await input.readHeader(pendingNumber);
    requireValue(Array.isArray(anchor.passiveTouchedAddresses), "block lacks supported consensus activity coverage");
    const blockHash = hash(block.hash);
    if (blockHash !== hash(anchor.hash) || hash(block.parent_hash) !== hash(anchor.parentHash) ||
        hash(anchor.parentHash) !== previous.hash) throw new BlockActivityRangeInvalidatedError("BigQuery activity canonical chain mismatch");
    const transactions = pending.filter(row => row.k === 1).map(row => row.p)
      .sort((a, b) => integer(a.transaction_index) - integer(b.transaction_index));
    requireValue(integer(block.transaction_count) === transactions.length && transactions.length === anchor.transactionHashes.length,
      "missing transaction coverage");
    transactions.forEach((row, index) => requireValue(integer(row.transaction_index) === index && hash(row.hash) === hash(anchor.transactionHashes[index]),
      "transaction order/hash mismatch"));
    for (const row of pending) if (row.k !== 0) requireValue(hash(row.p.block_hash) === blockHash, "observation block mismatch");
    const rawLogs = pending.filter(row => row.k === 2).map(row => row.p)
      .sort((a, b) => integer(a.log_index) - integer(b.log_index));
    const logs = rawLogs.map((row, index) => {
      requireValue(integer(row.log_index) === index && integer(row.transaction_index) < transactions.length &&
        hash(row.transaction_hash) === hash(anchor.transactionHashes[integer(row.transaction_index)]), "log index/transaction mismatch");
      return { address: row.address as string, topics: row.topics as string[], data: row.data as string,
        transactionHash: row.transaction_hash as string, blockHash };
    });
    const traces = normalizedTraces(pending.filter(row => row.k === 3).map(row => row.p), anchor.transactionHashes.map(hash));
    const provider: BlockTouchedProvider = {
      async getLogs() { return logs; },
      async send() { return traces; },
    };
    const keys = await readBlockTouchedStateKeys(provider, pendingNumber, input.poolManager, anchor, {
      previousSource: previous, readHeader: input.readHeader, signal: input.signal, deadlineAtMs: input.deadlineAtMs,
    }, input.resolver);
    open(input);
    for (const key of keys) touched.add(key);
    previous = { number: pendingNumber, hash: blockHash };
    pending = []; lastKind = -1;
  };
  for await (const row of rows) {
    open(input);
    requireValue(Number.isSafeInteger(row.n) && row.n >= pendingNumber && row.n <= input.targetNumber &&
      Number.isSafeInteger(row.k) && row.k >= 0 && row.k <= 3 && record(row.p), "out-of-range activity row");
    if (row.n !== pendingNumber) {
      await consume();
      requireValue(row.n === pendingNumber + 1, "missing block coverage");
      pendingNumber = row.n;
    }
    requireValue(row.k >= lastKind, "unordered activity rows");
    pending.push(row); lastKind = row.k;
    requireValue(pending.length <= MAX_BLOCK_ROWS, "block exceeds bounded observation limit");
  }
  await consume();
  requireValue(previous.number === input.targetNumber && previous.hash === targetHash, "incomplete target coverage");
  open(input);
  return touched;
}
