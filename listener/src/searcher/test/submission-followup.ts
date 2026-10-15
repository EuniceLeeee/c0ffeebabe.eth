import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mock } from "node:test";
import { parseChronyTracking, SubmissionFollowup } from "../../shared/submission-followup.js";
import { queryTitanBundleStats, type BuilderEvidence } from "../../shared/builder-observations.js";

const TX = "0x" + "ab".repeat(32), BUNDLE = "0x" + "cd".repeat(32);
const HASH = "0x" + "11".repeat(32), FORK = "0x" + "22".repeat(32);
const CHRONY = "secret-reference,192.0.2.1,3,1792037500,-0.000075,0.000081,0.000027,-0.5,0.009,0.01,0.00022,0.000149,1033,Normal";
const tests: Array<[string, () => void | Promise<void>]> = [];
const test = (name: string, run: () => void | Promise<void>): void => { tests.push([name, run]); };

test("head evidence retains first observation by feed and same-height reorg hashes", async () => {
  const rows: BuilderEvidence[] = [];
  const observer = new SubmissionFollowup({ evidence: row => rows.push(row), onError: () => {},
    monotonicNow: () => 42, readClock: async () => parseChronyTracking(CHRONY) });
  await observer.sampleClock();
  observer.noteHead(99, null, "startup");
  observer.noteHead(100, HASH, "ws"); observer.noteHead(100, HASH, "ws");
  observer.noteHead(100, null, "http"); observer.noteHead(100, FORK, "ws");
  observer.noteHead(-1, HASH, "ws");
  const heads = rows.filter(row => row.type === "submission_head_observed");
  assert.equal(heads.length, 4);
  assert.deepEqual(heads.map(row => row.block_hash), [null, HASH, null, FORK]);
  assert.ok(heads.every(row => typeof row.observed_at_ms === "number" && row.observed_at_monotonic_ms === 42 &&
    row.clock_snapshot_id === rows[0]!.clock_snapshot_id));
  await observer.close();
  observer.noteHead(101, HASH, "ws"); assert.equal(rows.length, 5);
});

test("clock parser records actual signed offsets, not server identity or fabricated zero", () => {
  const clock = parseChronyTracking(CHRONY);
  assert.equal(clock.status, "synchronized"); assert.equal(clock.system_time_offset_seconds, -0.000075);
  assert.ok(!JSON.stringify(clock).includes("secret-reference") && !JSON.stringify(clock).includes("192.0.2.1"));
  assert.equal(parseChronyTracking(CHRONY.replace("Normal", "Not synchronised")).status, "unsynchronized");
  for (const bad of ["", "not CSV", CHRONY.replace("0.000081", "NaN"), CHRONY.replace("0.000081", "")]) {
    assert.equal(parseChronyTracking(bad).status, "unavailable");
    assert.equal(parseChronyTracking(bad).system_time_offset_seconds, null);
  }
});

test("15s, 1m and 3m produce no queries; only the 5m local clock sample remains", async () => {
  const savedFetch = globalThis.fetch, rows: BuilderEvidence[] = [];
  let requests = 0, clockReads = 0;
  globalThis.fetch = async () => { requests++; throw new Error("unexpected network request"); };
  mock.timers.enable({ apis: ["setInterval"] });
  const observer = new SubmissionFollowup({ evidence: row => rows.push(row), onError: () => {},
    readClock: async () => { clockReads++; return parseChronyTracking(CHRONY); } });
  try {
    observer.start(); observer.start(); await observer.sampleClock();
    for (const elapsed of [15_000, 45_000, 120_000]) {
      mock.timers.tick(elapsed); await Promise.resolve();
      assert.equal(clockReads, 1); assert.equal(requests, 0);
    }
    mock.timers.tick(120_000); await observer.sampleClock();
    assert.equal(clockReads, 2); assert.equal(requests, 0);
    assert.ok(rows.every(row => row.type === "submission_clock_snapshot"));
    await observer.close(); observer.start(); mock.timers.tick(300_000);
    assert.equal(clockReads, 2);
  } finally { await observer.close(); mock.timers.reset(); globalThis.fetch = savedFetch; }
});

test("shutdown drains an existing clock read and suppresses post-shutdown output", async () => {
  const rows: BuilderEvidence[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const observer = new SubmissionFollowup({ evidence: row => rows.push(row), onError: () => {},
    readClock: async () => { await gate; return parseChronyTracking(CHRONY); } });
  const pending = observer.sampleClock(), closing = observer.close();
  release(); await Promise.all([pending, closing]); assert.equal(rows.length, 0);
  await observer.close();
});

test("clock evidence write failure remains explicit", async () => {
  const observer = new SubmissionFollowup({ evidence: () => { throw new Error("disk-full"); }, onError: () => {},
    readClock: async () => parseChronyTracking(CHRONY) });
  await assert.rejects(observer.sampleClock(), /disk-full/); await observer.close();
});

test("explicit offline Titan query still works and retains the response-size protection", async () => {
  const rows: BuilderEvidence[] = [];
  const queried = await queryTitanBundleStats({ txHash: TX, bundleHash: BUNDLE, evidence: row => rows.push(row),
    fetch: async () => new Response(JSON.stringify({ result: { status: "Submitted" } })) });
  assert.equal(queried.ok, true); assert.equal(rows.at(-1)!.type, "builder_stats_snapshot");
  let cancelled = false;
  await assert.rejects(queryTitanBundleStats({ txHash: TX, bundleHash: BUNDLE, evidence: row => rows.push(row),
    fetch: async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(600_000)); }, cancel() { cancelled = true; },
    })) }), { name: "BuilderResponseTooLargeError" });
  assert.equal(cancelled, true); assert.equal(rows.at(-1)!.response_truncated, true);
});

test("live wiring retains submission/timing evidence without any stats-query hook or scheduler", () => {
  const main = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
  const observer = readFileSync(new URL("../../shared/submission-followup.ts", import.meta.url), "utf8");
  assert.match(main, /config\.dryRun \? undefined : new SubmissionFollowup/);
  assert.match(main, /evidence: recordSubmissionEvidence,/);
  assert.match(main, /submissionFollowup\?\.noteHead\(number, hash, "ws"\)/);
  assert.match(main, /submissionFollowup\?\.noteHead\(blockNumber, null, "http"\)/);
  assert.doesNotMatch(main, /submissionFollowup\?\.observe|queryTitanBundleStats/);
  assert.doesNotMatch(observer, /queryTitanBundleStats|builder_tracking|DELAYS_MS|MAX_PENDING|fetch[(:?]|\.tick\(/);
});

for (const [name, run] of tests) { await run(); console.log(`[submission-followup] ${name}: PASS`); }
console.log(`submission-followup: ${tests.length}/${tests.length} offline checks passed`);
