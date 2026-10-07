// Offline storage regression: re-emit saved observations through the real writer.
// No Graph authority, quoting, chain calls or simulation is manufactured here.
import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { initBlockScanEnumerationSolverTelemetry } from "../blockscan-enumeration-solver-telemetry.js";
import type { StrictPricingPublication } from "../strict-current-runtime-coordinator.js";
import type { RouteVenueMid } from "../venues/mid-readers.js";
import type { EffectiveMidSnapshot } from "../blockscan-effective-mid.js";
import { EffectiveMidHistoryReplay } from "../blockscan-effective-mid-history.js";

const arg = (name: string) => process.argv[process.argv.indexOf(name) + 1];
assert(process.argv.includes("--input") && process.argv.includes("--out-dir"));
const input = resolve(arg("--input")!), directory = resolve(arg("--out-dir")!);
await mkdir(directory, { recursive: true });
const historyPath = join(directory, "compact-history.jsonl"), eventsPath = join(directory, "formal-events.jsonl");
assert.notEqual(input, historyPath);
// Preserve the saved run identity so the ordinary analysis CLI can join its
// existing route/event evidence to either encoding without synthetic locators.
const headerStream = createReadStream(input, { encoding: "utf8" });
const headerLines = createInterface({ input: headerStream, crlfDelay: Infinity });
let runId: string | undefined;
try {
  for await (const line of headerLines) {
    if (!line) continue;
    const record = JSON.parse(line);
    if (record.type !== "block_scan_mid_baseline" && record.type !== "block_scan_mid_delta") continue;
    assert.equal(typeof record.run_id, "string");
    runId = record.run_id;
    break;
  }
} finally { headerLines.close(); headerStream.destroy(); }
assert(runId);
await writeFile(eventsPath, "", { flag: "wx", mode: 0o600 });
const sink = await initBlockScanEnumerationSolverTelemetry({
  path: join(directory, "route-history.jsonl"), midHistoryPath: historyPath,
  eventsPath, runId, onWarning: message => { throw new Error(message); },
});
assert(sink.enabled);
const expected: string[] = [], raw = new Map<string, RouteVenueMid>();
const originals = new EffectiveMidHistoryReplay();
function rawMid(value: any): RouteVenueMid {
  return { kind: value.kind, pool: "history-only", edges: [], mid: value.mid, feeBps: value.fee_bps,
    depthProxy: value.depth_proxy,
    ...(value.reserve_a === undefined ? {} : { reserveA: BigInt(value.reserve_a) }),
    ...(value.reserve_b === undefined ? {} : { reserveB: BigInt(value.reserve_b) }),
    ...(value.balance_headroom_in === undefined ? {} : { balanceHeadroomIn: BigInt(value.balance_headroom_in) }),
    ...(value.sqrt_ab_x96 === undefined ? {} : { sqrtABX96: BigInt(value.sqrt_ab_x96) }),
    ...(value.liquidity === undefined ? {} : { liquidity: BigInt(value.liquidity) }),
  };
}
function effective(value: any): EffectiveMidSnapshot {
  return { source: value.source, reference: value.reference, referenceWethInput: BigInt(value.reference_weth_input),
    complete: value.complete, wallMs: value.wall_ms,
    rows: new Map(value.rows.map(([key, row]: [string, any]) => [key, {
      edgeId: row.edge_id, instanceKey: row.instance_key, tokenIn: row.token_in, tokenOut: row.token_out,
      amountIn: row.amount_in === null ? null : BigInt(row.amount_in), amountOut: row.amount_out === null ? null : BigInt(row.amount_out),
      effectiveMid: row.effective_mid, status: row.status,
      ...(row.quoted_at === undefined ? {} : { quotedAt: row.quoted_at }), ...(row.carried ? { carried: true } : {}),
    }])) };
}
// Key-order independent, lossless comparison; integer amount strings stay strings.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
const fingerprint = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const lines = (path: string) => createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
try {
  for await (const line of lines(input)) {
    if (!line) continue;
    const record = JSON.parse(line), baseline = record.type === "block_scan_mid_baseline";
    if (!baseline && record.type !== "block_scan_mid_delta") continue;
    assert.equal(record.run_id, runId, "saved price observations change run identity");
    if (baseline) { raw.clear(); originals.reset(); }
    const updates = new Map<string, RouteVenueMid>((baseline ? record.mids : record.updates).map(([key, value]: [string, any]) => [key, rawMid(value)]));
    for (const [key, value] of updates) raw.set(key, value);
    for (const key of record.removals ?? []) raw.delete(key);
    const full = originals.apply(record.effective_mids, { number: record.source_block, hash: record.source_block_hash, generation: record.generation });
    expected.push(fingerprint(full));
    sink.recordPricing({ kind: baseline ? "baseline" : "delta", graphFingerprint: record.graph_fingerprint,
      previousSourceBlock: record.previous_source_block, previousSourceBlockHash: record.previous_source_block_hash,
      previousGeneration: record.previous_generation, updates, removals: record.removals ?? [],
      snapshot: { sourceBlock: record.source_block, sourceBlockHash: record.source_block_hash, generation: record.generation,
        mids: new Map(raw), ...(record.raw_mid_source === undefined ? {} : { rawMidSource: record.raw_mid_source }),
        ...(full === null ? {} : { effectiveMids: effective(full) }) },
    } as unknown as StrictPricingPublication);
    const until = Date.now() + 30000;
    while (sink.telemetry().acknowledged < expected.length) {
      assert(!sink.telemetry().failed && Date.now() < until, "writer failed or did not acknowledge");
      await sleep(5);
    }
  }
} finally {
  // Production intentionally unrefs telemetry. This standalone replay has no
  // live listener to keep Node running until the shutdown acknowledgement.
  const shutdownKeepAlive = setInterval(() => {}, 1000);
  try { await sink.shutdown(5000); } finally { clearInterval(shutdownKeepAlive); }
}
assert.equal(sink.telemetry().droppedMidPublications, 0);
const replay = new EffectiveMidHistoryReplay(), sizes: number[] = [];
let count = 0, baselines = 0, changedRows = 0;
for await (const line of lines(historyPath)) {
  const record = JSON.parse(line), value = record.effective_mids;
  if (record.type === "block_scan_mid_baseline") replay.reset();
  assert.equal(fingerprint(replay.apply(value)), expected[count], `effective table differs at source ${record.source_block}`);
  if (value?.encoding === "delta") { sizes.push(Buffer.byteLength(line) + 1); changedRows += value.updates.length; }
  else baselines++;
  count++;
}
assert.equal(count, expected.length);
const originalBytes = (await stat(input)).size, compactBytes = (await stat(historyPath)).size;
const firstBytes = compactBytes - sizes.reduce((sum, size) => sum + size, 0);
const maximumDeltaBytes = sizes.reduce((maximum, size) => Math.max(maximum, size), 0);
const result = { scope: "offline saved observations, not new live or RPC", count, baselines, deltas: sizes.length,
  changedRows, originalBytes, compactBytes, savingsPercent: (1 - compactBytes / originalBytes) * 100,
  allEffectiveTablesExactlyRestored: true, maximumDeltaBytes,
  projected2500UsingObservedMaximumDelta: firstBytes + 2499 * maximumDeltaBytes,
  projectionScope: "observed maximum per-delta, not a guarantee for future all-row refreshes",
  writer: sink.telemetry() };
await writeFile(join(directory, "summary.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log(JSON.stringify(result, null, 2));
