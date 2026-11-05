import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bigQueryActivityRequest, BIGQUERY_ACTIVITY_SQL, getBigQueryActivityCutoff, dryRunBigQueryActivity,
  queryBigQueryActivityRows, readBigQueryTouchedRange,
  type BigQueryActivityRow, type BigQueryTouchedRangeInput,
} from "../blockscan-bigquery-activity.js";

const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const tx = (n: number) => hash(n + 10_000);
const header = (n: number) => ({ hash: hash(n), parentHash: hash(n - 1), transactionHashes: [tx(n)], passiveTouchedAddresses: [address(99)] });
const base = (end = 102): BigQueryTouchedRangeInput => ({ previousSource: { number: 100, hash: hash(100) },
  targetNumber: end, target: header(end), readHeader: async n => header(n), startTimestamp: 1, endTimestamp: 1000,
  poolManager: address(200), deadlineAtMs: Date.now() + 60_000,
});
const blockRows = (n: number): BigQueryActivityRow[] => [
  { n, k: 0, p: { hash: hash(n), parent_hash: hash(n - 1), transaction_count: 1 } },
  { n, k: 1, p: { hash: tx(n), transaction_index: 0, block_hash: hash(n) } },
  { n, k: 2, p: { log_index: 0, transaction_hash: tx(n), transaction_index: 0, block_hash: hash(n), address: address(3), topics: [], data: "0x" } },
  { n, k: 3, p: { transaction_hash: tx(n), transaction_index: 0, block_hash: hash(n),
    from_address: address(1), to_address: address(2), input: "0x1234", output: "0x", gas: 1000, gas_used: 200,
    trace_type: "call", call_type: "call", value: "0", status: 1, error: null, subtraces: 0, trace_address: "" } },
];
async function* stream(rows: readonly BigQueryActivityRow[]) { for (const row of rows) yield row; }

test("BigQuery range reuses production classifier with original source and deduplicates across blocks", async () => {
  const seen: number[] = [];
  const result = await readBigQueryTouchedRange({ ...base(), resolver: (_observation, source) => {
    seen.push(source.number); return ["shared-state-key"];
  } }, stream([...blockRows(101), ...blockRows(102)]));
  assert.deepEqual([...result].sort(), [address(1), address(2), address(3), address(99), "shared-state-key"].sort());
  assert.deepEqual(seen, [101, 101, 102, 102]);
});

test("public BigQuery NULL root path is accepted, a missing trace path is not", async () => {
  const rows = blockRows(101);
  rows[3]!.p.trace_address = null;
  assert((await readBigQueryTouchedRange(base(101), stream(rows))).has(address(2)));
  delete rows[3]!.p.trace_address;
  await assert.rejects(readBigQueryTouchedRange(base(101), stream(rows)), /trace path/);
});

test("passive dependency owners are refreshed even without an indexed call observation", async () => {
  const resolver = Object.assign((): readonly string[] => [], {
    passiveStateKeys: (addresses: readonly string[]) => addresses.includes(address(99)) ? ["opaque:dependent-pool"] : [],
  });
  const touched = await readBigQueryTouchedRange({ ...base(101), resolver }, stream(blockRows(101)));
  assert(touched.has("opaque:dependent-pool"));
});

test("BigQuery retains failed subtrees, static calls, creations, selfdestruct, Transfer parties and singleton keys", async () => {
  const rows = blockRows(101);
  rows[2]!.p.topics = ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", hash(7), hash(8)];
  rows.splice(3, 0, { n: 101, k: 2, p: { ...rows[2]!.p, log_index: 1, address: address(200), topics: [hash(2000), hash(2001)] } });
  rows[4]!.p.subtraces = 3;
  rows[4]!.p.status = 0;
  const root = rows[4]!.p;
  rows.push({ n: 101, k: 3, p: { ...root, trace_address: "0", subtraces: 0, call_type: "staticcall", to_address: address(20), error: "reverted" } });
  rows.push({ n: 101, k: 3, p: { ...root, trace_address: "1", subtraces: 0, trace_type: "create", to_address: address(21) } });
  rows.push({ n: 101, k: 3, p: { ...root, trace_address: "2", subtraces: 0, trace_type: "suicide", to_address: address(22), gas: null, gas_used: null, input: null } });
  const result = await readBigQueryTouchedRange(base(101), stream(rows));
  for (const value of [7, 8, 20, 21, 22, 200]) assert(result.has(address(value)), `missing ${value}`);
  assert(result.has(hash(2001)));
});

for (const [name, mutate] of [
  ["missing interior block", (rows: BigQueryActivityRow[]) => rows.splice(0, 4)],
  ["missing target block", (rows: BigQueryActivityRow[]) => rows.splice(4)],
  ["duplicate block", (rows: BigQueryActivityRow[]) => rows.splice(1, 0, rows[0]!)],
  ["missing transaction", (rows: BigQueryActivityRow[]) => rows.splice(1, 1)],
  ["wrong transaction", (rows: BigQueryActivityRow[]) => { rows[1]!.p.hash = hash(3); }],
  ["missing trace", (rows: BigQueryActivityRow[]) => rows.splice(3, 1)],
  ["missing child", (rows: BigQueryActivityRow[]) => { rows[3]!.p.subtraces = 1; }],
  ["orphan trace", (rows: BigQueryActivityRow[]) => { rows[3]!.p.trace_address = "0"; }],
  ["unknown trace kind", (rows: BigQueryActivityRow[]) => { rows[3]!.p.trace_type = "other"; }],
  ["wrong log source", (rows: BigQueryActivityRow[]) => { rows[2]!.p.block_hash = hash(9); }],
  ["missing first log", (rows: BigQueryActivityRow[]) => { rows[2]!.p.log_index = 1; }],
  ["broken parent", (rows: BigQueryActivityRow[]) => { rows[4]!.p.parent_hash = hash(99); }],
] as const) test(`BigQuery refuses ${name} instead of publishing partial touched`, async () => {
  const rows = [...blockRows(101), ...blockRows(102)]; mutate(rows);
  await assert.rejects(readBigQueryTouchedRange(base(), stream(rows)));
});

test("BigQuery empty blocks still require contiguous block rows and canonical passive activity", async () => {
  const input = { ...base(101), target: { ...header(101), transactionHashes: [] } };
  const rows = blockRows(101).slice(0, 1); rows[0]!.p.transaction_count = 0;
  assert.deepEqual([...await readBigQueryTouchedRange(input, stream(rows))], [address(99)]);
  await assert.rejects(readBigQueryTouchedRange(input, stream([])), /missing or duplicate block/);
});

test("BigQuery abort and exhausted deadline do not return accumulated activity", async () => {
  const controller = new AbortController();
  async function* interrupted() { yield* blockRows(101); controller.abort(); yield* blockRows(102); }
  await assert.rejects(readBigQueryTouchedRange({ ...base(), signal: controller.signal }, interrupted()));
  await assert.rejects(readBigQueryTouchedRange({ ...base(), deadlineAtMs: 0 }, stream([])), /deadline/);
});

test("BigQuery refuses unsupported consensus coverage at target or any interior block", async () => {
  const rows = [...blockRows(101), ...blockRows(102)];
  await assert.rejects(readBigQueryTouchedRange({ ...base(), target: { ...header(102), passiveTouchedAddresses: undefined } }, stream(rows)), /consensus activity coverage/);
  await assert.rejects(readBigQueryTouchedRange({ ...base(), readHeader: async n => ({ ...header(n), passiveTouchedAddresses: undefined }) }, stream(rows)), /consensus activity coverage/);
});

test("SQL selects all observations with partition bounds and fixed range, never discovery predicates", () => {
  const request = bigQueryActivityRequest(base());
  assert.equal(request.maximumBytesBilled, String(100 * 1024 ** 3));
  assert.equal(request.useLegacySql, false);
  assert.equal((BIGQUERY_ACTIVITY_SQL.match(/TIMESTAMP_SECONDS\(@start_ts\)/g) ?? []).length, 4);
  assert.equal((BIGQUERY_ACTIVITY_SQL.match(/STRUCT\(`hash`,/g) ?? []).length, 2, "BigQuery HASH keyword must be quoted in both projections");
  assert(!/WHERE[^;]*(status\s*=|call_type\s*=)/.test(BIGQUERY_ACTIVITY_SQL));
  assert.throws(() => bigQueryActivityRequest({ ...base(), config: { maximumBytesBilled: String(101 * 1024 ** 3) } }), /billing cap/);
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
function page(rows: BigQueryActivityRow[], total: number, pageToken?: string) {
  return { jobComplete: true, jobReference: { jobId: "job_1" }, totalRows: String(total),
    rows: rows.map(row => ({ f: [{ v: JSON.stringify({ ...row, p: JSON.stringify(row.p) }) }] })),
    ...(pageToken === undefined ? {} : { pageToken }),
  };
}

test("REST dry-runs before bounded SELECT and consumes all pages", async context => {
  const rows = blockRows(101), calls: Array<{ url: string; body?: any }> = [];
  context.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined; calls.push({ url, body });
    if (url.startsWith("http://metadata")) return json({ access_token: "private-test-token" });
    if (body?.dryRun) return json({ totalBytesProcessed: "1000" });
    if (body) return json(page(rows.slice(0, 2), 4, "next"));
    assert(url.includes("pageToken=next")); return json(page(rows.slice(2), 4));
  });
  const actual: BigQueryActivityRow[] = [];
  for await (const row of queryBigQueryActivityRows(base(101))) actual.push(row);
  assert.deepEqual(actual, rows);
  assert.equal(calls[1]!.body.dryRun, true);
  assert.equal(calls[2]!.body.maximumBytesBilled, String(100 * 1024 ** 3));
});

test("dry-run-only entry validates SQL without submitting a SELECT", async context => {
  let requests = 0;
  context.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    if (url.startsWith("http://metadata")) return json({ access_token: "private-test-token" });
    const body = JSON.parse(String(init?.body));
    assert.equal(body.dryRun, true);
    requests++; return json({ totalBytesProcessed: "1234" });
  });
  assert.deepEqual(await dryRunBigQueryActivity(base()), { totalBytesProcessed: "1234" });
  assert.equal(requests, 1);
});

test("REST rejects truncated pagination and oversized dry-run before activity can publish", async context => {
  let oversized = false, submitted = 0;
  context.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.startsWith("http://metadata")) return json({ access_token: "private-test-token" });
    if (body?.dryRun) return json({ totalBytesProcessed: oversized ? String(200 * 1024 ** 3) : "1000" });
    submitted++; return json(page(blockRows(101).slice(0, 2), 4));
  });
  await assert.rejects(readBigQueryTouchedRange(base(101)), /truncated result set/);
  oversized = true;
  await assert.rejects(readBigQueryTouchedRange(base(101)), /dry-run estimate/);
  assert.equal(submitted, 1);
});

test("cutoff is conservative table watermark and null requires RPC coverage", async context => {
  let cutoff: number | null = 101;
  context.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.startsWith("http://metadata")) return json({ access_token: "private-test-token" });
    if (body?.dryRun) return json({ totalBytesProcessed: "1000" });
    assert(body.query.includes("COUNT(tip) = 4"));
    return json({ jobComplete: true, jobReference: { jobId: "job_1" }, totalRows: "1", rows: [{ f: [{ v: JSON.stringify({ cutoff }) }] }] });
  });
  const input = { fromNumber: 101, toNumber: 102, startTimestamp: 1, endTimestamp: 1000, deadlineAtMs: Date.now() + 60_000 };
  assert.equal(await getBigQueryActivityCutoff(input), 101);
  cutoff = null; assert.equal(await getBigQueryActivityCutoff(input), null);
});

test("unfinished server query is cancelled when its owner aborts", async context => {
  const controller = new AbortController();
  let cancelled = 0;
  context.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.startsWith("http://metadata")) return json({ access_token: "private-test-token" });
    if (body?.dryRun) return json({ totalBytesProcessed: "1000" });
    if (url.includes("/cancel")) { cancelled++; return json({}); }
    if (body) {
      assert(Number(body.jobTimeoutMs) > 0);
      controller.abort();
      return json({ jobComplete: false, jobReference: { jobId: "job_1" } });
    }
    throw new Error("unexpected poll");
  });
  await assert.rejects(readBigQueryTouchedRange({ ...base(101), signal: controller.signal }));
  assert.equal(cancelled, 1);
});

test("Ready-format private token file authenticates dry-run and query without metadata or gcloud", async context => {
  const directory = await mkdtemp(join(tmpdir(), "mev-bq-token-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const tokenFile = join(directory, "bigquery-auth.json"), token = "fixture-token-" + "x".repeat(40);
  await writeFile(tokenFile, JSON.stringify({ token, expiresAt: Date.now() + 60_000 }), { mode: 0o600 });
  let requests = 0;
  context.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    assert(url.startsWith("https://bigquery.googleapis.com/"), "token-file mode cannot contact metadata");
    assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${token}`);
    requests++;
    const body = JSON.parse(String(init?.body));
    return body.dryRun ? json({ totalBytesProcessed: "1000" }) : json(page(blockRows(101), 4));
  });
  const rows: BigQueryActivityRow[] = [];
  for await (const row of queryBigQueryActivityRows({ ...base(101), config: { authMode: "token-file", tokenFile } })) rows.push(row);
  assert.deepEqual(rows, blockRows(101));
  assert.equal(requests, 2);
});

for (const failure of ["expired", "malformed-json", "missing-token", "invalid-token", "invalid-expiry",
  "public-mode", "unreadable-mode", "symlink", "missing-file", "relative", "missing-path", "oversize", "directory", "wrong-owner"] as const) {
  test(`token file ${failure} fails before HTTP and hides credential, path and cause`, async context => {
    const directory = await mkdtemp(join(tmpdir(), "mev-bq-token-test-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    let tokenFile: string | undefined = join(directory, "private-bigquery-auth.json");
    const token = "fixture-secret-" + "y".repeat(40);
    let contents = JSON.stringify({ token, expiresAt: Date.now() + 60_000 });
    if (failure === "expired") contents = JSON.stringify({ token, expiresAt: Date.now() - 1 });
    if (failure === "malformed-json") contents = `{"token":"${token}", BROKEN`;
    if (failure === "missing-token") contents = JSON.stringify({ expiresAt: Date.now() + 60_000 });
    if (failure === "invalid-token") contents = JSON.stringify({ token: token + "\r\n", expiresAt: Date.now() + 60_000 });
    if (failure === "invalid-expiry") contents = JSON.stringify({ token, expiresAt: String(Date.now() + 60_000) });
    if (failure === "oversize") contents += " ".repeat(16_384);
    await writeFile(tokenFile, contents, { mode: 0o600 });
    if (failure === "public-mode") await chmod(tokenFile, 0o640);
    if (failure === "unreadable-mode") await chmod(tokenFile, 0o200);
    if (failure === "symlink") {
      const link = join(directory, "credential-link.json");
      await symlink(tokenFile, link); tokenFile = link;
    }
    if (failure === "missing-file") tokenFile += ".missing";
    if (failure === "relative") tokenFile = "private-bigquery-auth.json";
    if (failure === "missing-path") tokenFile = undefined;
    if (failure === "directory") tokenFile = directory;
    if (failure === "wrong-owner") {
      const wrongUid = process.getuid!() + 1;
      context.mock.method(process, "getuid", () => wrongUid);
    }
    let requests = 0;
    context.mock.method(globalThis, "fetch", async () => { requests++; throw new Error("unexpected HTTP"); });
    await assert.rejects(dryRunBigQueryActivity({ ...base(), config: { authMode: "token-file", tokenFile } }), error => {
      assert(error instanceof Error);
      assert.equal(error.message, "BigQuery activity: token-file authentication failed");
      assert.equal(error.cause, undefined);
      assert(!String(error.stack).includes(token));
      assert(!String(error.stack).includes(directory));
      return true;
    });
    assert.equal(requests, 0);
  });
}
