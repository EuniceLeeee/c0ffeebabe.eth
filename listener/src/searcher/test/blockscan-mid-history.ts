import assert from "node:assert/strict";
import { link, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  initBlockScanEnumerationSolverTelemetry,
} from "../blockscan-enumeration-solver-telemetry.js";
import type { StrictPricingPublication } from
  "../strict-current-runtime-coordinator.js";
import type { RouteVenueMid } from "../venues/mid-readers.js";
import type { EffectiveMidRow, EffectiveMidSnapshot } from "../blockscan-effective-mid.js";

test("writes one baseline followed by compact ordered deltas", async () => {
  await withTempDir(async (directory) => {
    const historyPath = join(directory, "mids.jsonl");
    const routePath = join(directory, "routes.jsonl");
    const eventsPath = join(directory, "events.jsonl");
    await writeFile(eventsPath, "");
    const sink = await initBlockScanEnumerationSolverTelemetry({
      path: routePath,
      midHistoryPath: historyPath,
      eventsPath,
      runId: "mid-history-functional",
      minFreeBytes: 1,
    });
    assert.equal(sink.enabled, true);

    const midA = { ...mid("v2", 2, 30, 1_000n, 2_000n), balanceHeadroomIn: 5192296858534827628530496329219095n };
    const midB = mid("v3", 3, 5, 3_000n, 9_000n);
    sink.recordPricing(baseline(100, new Map([
      ["edge-a", midA],
      ["edge-b", midB],
    ])));
    sink.recordNotStarted({
      sourceBlock: 100,
      sourceBlockHash: null,
      pricingMode: null,
      passOutcome: "not_started",
      passReason: "scheduler_coalesced",
    });
    const refreshedA = { ...mid("v2", 2.5, 30, 1_000n, 2_500n), balanceHeadroomIn: 0n };
    sink.recordPricing(delta({
      previousBlock: 100,
      block: 101,
      updates: [["edge-a", refreshedA]],
      removals: ["edge-b"],
      mids: new Map([["edge-a", refreshedA]]),
    }));
    await sink.shutdown(5_000);

    const records = await readJsonl(historyPath);
    assert.equal(records.length, 2);
    assert.deepEqual(records[0], {
      type: "block_scan_mid_baseline",
      schema_version: 1,
      run_id: "mid-history-functional",
      sequence: 1,
      source_block: 100,
      source_block_hash: blockHash(100),
      generation: 100,
      graph_fingerprint: "graph-v1",
      mid_count: 2,
      mids: [
        ["edge-a", {
          kind: "v2",
          mid: 2,
          fee_bps: 30,
          reserve_a: "1000",
          reserve_b: "2000",
          balance_headroom_in: "5192296858534827628530496329219095",
          depth_proxy: 1000,
        }],
        ["edge-b", {
          kind: "v3",
          mid: 3,
          fee_bps: 5,
          reserve_a: "3000",
          reserve_b: "9000",
          depth_proxy: 3000,
        }],
      ],
    });
    assert.deepEqual(records[1], {
      type: "block_scan_mid_delta",
      schema_version: 1,
      run_id: "mid-history-functional",
      sequence: 3,
      source_block: 101,
      source_block_hash: blockHash(101),
      generation: 101,
      graph_fingerprint: "graph-v1",
      previous_source_block: 100,
      previous_source_block_hash: blockHash(100),
      previous_generation: 100,
      update_count: 1,
      removal_count: 1,
      updates: [["edge-a", {
        kind: "v2",
        mid: 2.5,
        fee_bps: 30,
        reserve_a: "1000",
        reserve_b: "2500",
        balance_headroom_in: "0",
        depth_proxy: 1000,
      }]],
      removals: ["edge-b"],
    });
    assert.equal(sink.telemetry().droppedMidPublications, 0);
    assert.equal(sink.telemetry().midBaselines, 1);
    assert.equal(sink.telemetry().midDeltas, 1);
    const routeRecords = await readJsonl(routePath);
    assert.equal(routeRecords.length, 1);
    assert.equal(routeRecords[0]!.type, "block_scan_enumeration_solver");
    assert.equal(routeRecords[0]!.sequence, undefined);
  });
});

test("full effective snapshots survive empty raw deltas, raw changes and missing legacy snapshots", async () => {
  await withTempDir(async (directory) => {
    const historyPath = join(directory, "mids.jsonl");
    const eventsPath = join(directory, "events.jsonl");
    await writeFile(eventsPath, "");
    const sink = await initBlockScanEnumerationSolverTelemetry({
      path: join(directory, "routes.jsonl"),
      midHistoryPath: historyPath,
      eventsPath,
      runId: "effective-history",
      minFreeBytes: 1,
    });
    assert.equal(sink.enabled, true);
    const initial = mid("v2", 1, 30, 100n, 100n);
    const rawMids = new Map([["edge-a", initial], ["edge-b", initial]]);
    const first = effectiveSnapshot(300);
    const refreshed = effectiveSnapshot(301, EFFECTIVE_UNIT * 102n);
    const precise = effectiveSnapshot(302, EFFECTIVE_UNIT * 101n + 1n);
    const empty: EffectiveMidSnapshot = {
      ...effectiveSnapshot(304), rows: new Map(), complete: false, wallMs: 0,
    };
    const changedRaw = mid("v2", 1.5, 30, 100n, 150n);
    try {
      sink.recordPricing(baseline(300, rawMids, first));
      sink.recordPricing(delta({ previousBlock: 300, block: 301,
        updates: [], removals: [], mids: rawMids, effectiveMids: refreshed }));
      sink.recordPricing(delta({ previousBlock: 301, block: 302,
        updates: [["edge-a", changedRaw]], removals: ["edge-b"],
        mids: new Map([["edge-a", changedRaw]]), effectiveMids: precise }));
      sink.recordPricing(delta({ previousBlock: 302, block: 303,
        updates: [], removals: [], mids: new Map([["edge-a", changedRaw]]) }));
      sink.recordPricing(delta({ previousBlock: 303, block: 304,
        updates: [], removals: [], mids: new Map([["edge-a", changedRaw]]),
        effectiveMids: empty }));
    } finally {
      await sink.shutdown(5_000);
    }
    assert.equal(sink.telemetry().failed, false);
    assert.equal(sink.telemetry().droppedMidPublications, 0);
    assert.equal(sink.telemetry().acknowledged, 5);
    assert.equal(sink.telemetry().midBaselines, 1);
    assert.equal(sink.telemetry().midDeltas, 4);
    const records = await readJsonl(historyPath);
    assert.equal(records.length, 5);
    const expectedFirst = {
      source: { number: 300, hash: blockHash(300), generation: 300 },
      reference: "default",
      reference_weth_input: "1000000000000000000000000000001",
      complete: true,
      wall_ms: 12.5,
      rows: [
        ["edge-a", { edge_id: "edge-a", instance_key: "venue-a",
          token_in: "token-a", token_out: "token-b",
          amount_in: "100000000000000000000000000000000",
          amount_out: "101000000000000000000000000000000",
          effective_mid: 1.01, status: "quoted" }],
        ["edge-b", { edge_id: "edge-b", instance_key: "venue-b",
          token_in: "token-b", token_out: "token-a",
          amount_in: "100000000000000000000000000000000",
          amount_out: "100000000000000000000000000000000",
          effective_mid: 1, status: "quoted" }],
      ],
      summary: { directions: 2, quoted: 2, by_status: { quoted: 2 },
        comparable_pairs: 1, pairs_above_threshold: 0, threshold_bps: 100 },
    };
    assert.deepEqual(records[0]!.effective_mids, expectedFirst);
    const second = records[1]!.effective_mids as JsonRecord;
    assert.deepEqual(second, { ...expectedFirst,
      source: { number: 301, hash: blockHash(301), generation: 301 },
      reference: "gas", reference_weth_input: "1000000000000000000000000000002",
      wall_ms: 13.5,
      rows: [
        ["edge-a", { ...(expectedFirst.rows[0]![1] as JsonRecord),
          amount_out: "102000000000000000000000000000000", effective_mid: 1.0199999999999998 }],
        expectedFirst.rows[1],
      ],
      summary: { ...expectedFirst.summary, pairs_above_threshold: 1 },
    });
    const third = records[2]!.effective_mids as JsonRecord;
    assert.deepEqual(third, { ...expectedFirst,
      source: { number: 302, hash: blockHash(302), generation: 302 },
      reference: "gas", reference_weth_input: "1000000000000000000000000000003",
      wall_ms: 14.5,
      rows: [
        ["edge-a", { ...(expectedFirst.rows[0]![1] as JsonRecord),
          amount_out: "101000000000000000000000000000001" }],
        expectedFirst.rows[1],
      ],
      summary: { ...expectedFirst.summary, pairs_above_threshold: 1 },
    }, "strict >100bps uses BigInts even when the displayed mid rounds to 1.01");
    assert.equal(Object.hasOwn(records[3]!, "effective_mids"), false,
      "missing effective snapshots must not inherit an earlier publication");
    assert.deepEqual(records[4]!.effective_mids, {
      source: { number: 304, hash: blockHash(304), generation: 304 },
      reference: "gas", reference_weth_input: "1000000000000000000000000000005",
      complete: false, wall_ms: 0, rows: [],
      summary: { directions: 0, quoted: 0, by_status: {},
        comparable_pairs: 0, pairs_above_threshold: 0, threshold_bps: 100 },
    });

    // The raw chain remains independently replayable, including empty deltas.
    const reconstructed = new Map(records[0]!.mids as [string, JsonRecord][]);
    for (let index = 1; index < records.length; index++) {
      const record = records[index]!;
      assert.equal(record.type, "block_scan_mid_delta");
      assert.equal(record.previous_generation, 299 + index);
      assert.equal(record.previous_source_block, 299 + index);
      assert.equal(record.previous_source_block_hash, blockHash(299 + index));
      assert.equal(record.update_count, index === 2 ? 1 : 0);
      assert.equal(record.removal_count, index === 2 ? 1 : 0);
      for (const [key, value] of record.updates as [string, JsonRecord][]) reconstructed.set(key, value);
      for (const key of record.removals as string[]) reconstructed.delete(key);
      assert.equal(reconstructed.get("edge-a")!.mid, index < 2 ? 1 : 1.5);
      assert.equal(reconstructed.has("edge-b"), index < 2);
    }
  });
});

test("effective history preserves every status, null and zero amounts, and incomplete metadata", async () => {
  await withTempDir(async (directory) => {
    const historyPath = join(directory, "mids.jsonl");
    const eventsPath = join(directory, "events.jsonl");
    await writeFile(eventsPath, "");
    const sink = await initBlockScanEnumerationSolverTelemetry({
      path: join(directory, "routes.jsonl"), midHistoryPath: historyPath,
      eventsPath, runId: "effective-statuses", minFreeBytes: 1,
    });
    assert.equal(sink.enabled, true);
    const base = effectiveSnapshot(300);
    const statuses = ["missing-valuation", "unsupported", "quote-failed", "no-output", "cancelled"] as const;
    const rows = new Map(base.rows);
    for (const status of statuses) rows.set(status, {
      edgeId: status, instanceKey: `venue-${status}`, tokenIn: "token-a", tokenOut: "token-b",
      amountIn: status === "missing-valuation" ? null : EFFECTIVE_UNIT,
      amountOut: status === "no-output" ? 0n : null, effectiveMid: null, status,
    });
    try {
      sink.recordPricing(baseline(300, new Map(), { ...base, rows, complete: false, wallMs: 99.25 }));
    } finally {
      await sink.shutdown(5_000);
    }
    assert.equal(sink.telemetry().failed, false);
    assert.equal(sink.telemetry().acknowledged, 1);
    const [record] = await readJsonl(historyPath);
    const effective = record!.effective_mids as JsonRecord;
    assert.equal(effective.complete, false);
    assert.equal(effective.wall_ms, 99.25);
    assert.deepEqual(effective.summary, {
      directions: 7, quoted: 2,
      by_status: { quoted: 2, "missing-valuation": 1, unsupported: 1,
        "quote-failed": 1, "no-output": 1, cancelled: 1 },
      comparable_pairs: 1, pairs_above_threshold: 0, threshold_bps: 100,
    });
    const persisted = new Map(effective.rows as [string, JsonRecord][]);
    for (const status of statuses) assert.deepEqual(persisted.get(status), {
      edge_id: status, instance_key: `venue-${status}`, token_in: "token-a", token_out: "token-b",
      amount_in: status === "missing-valuation" ? null : "1000000000000000000000000000000",
      amount_out: status === "no-output" ? "0" : null, effective_mid: null, status,
    });
  });
});

test("carried effective history keeps its observed amounts and quote block, not the new reference", async () => {
  await withTempDir(async (directory) => {
    const historyPath = join(directory, "mids.jsonl");
    const eventsPath = join(directory, "events.jsonl");
    await writeFile(eventsPath, "");
    const sink = await initBlockScanEnumerationSolverTelemetry({
      path: join(directory, "routes.jsonl"), midHistoryPath: historyPath,
      eventsPath, runId: "effective-carried-observation", minFreeBytes: 1,
    });
    const previous = effectiveSnapshot(300);
    const current = effectiveSnapshot(301);
    const rows = new Map([...previous.rows].map(([id, row]) => [id,
      { ...row, carried: true as const, quotedAt: previous.source },
    ]));
    try { sink.recordPricing(baseline(301, new Map(), { ...current, rows })); }
    finally { await sink.shutdown(5_000); }
    assert.equal(sink.telemetry().failed, false);
    const [record] = await readJsonl(historyPath);
    const effective = record!.effective_mids as JsonRecord;
    assert.deepEqual(effective.source, current.source);
    assert.equal(effective.reference_weth_input, current.referenceWethInput.toString());
    const persisted = new Map(effective.rows as [string, JsonRecord][]);
    for (const [id, prior] of previous.rows) {
      assert.equal(persisted.get(id)!.amount_in, prior.amountIn!.toString());
      assert.equal(persisted.get(id)!.amount_out, prior.amountOut!.toString());
      assert.deepEqual(persisted.get(id)!.quoted_at, previous.source);
      assert.equal(persisted.get(id)!.carried, true);
    }
  });
});

test("a full queue records a gap and resumes only with a fresh baseline", async () => {
  await withTempDir(async (directory) => {
    const historyPath = join(directory, "mids.jsonl");
    const routePath = join(directory, "routes.jsonl");
    const eventsPath = join(directory, "events.jsonl");
    await writeFile(eventsPath, "");
    const sink = await initBlockScanEnumerationSolverTelemetry({
      path: routePath,
      midHistoryPath: historyPath,
      eventsPath,
      runId: "mid-history-gap",
      queueCredits: 2,
      minFreeBytes: 1,
    });
    const initial = mid("v2", 1, 30, 100n, 100n);
    sink.recordPricing(baseline(200, new Map([["edge-a", initial]])));
    sink.recordPricing(delta({
      previousBlock: 200,
      block: 201,
      updates: [],
      removals: [],
      mids: new Map([["edge-a", initial]]),
    }));
    sink.recordPricing(delta({
      previousBlock: 201,
      block: 202,
      updates: [],
      removals: [],
      mids: new Map([["edge-a", initial]]),
    }));
    sink.recordPricing(delta({
      previousBlock: 202,
      block: 203,
      updates: [],
      removals: [],
      mids: new Map([["edge-a", initial]]),
    }));
    assert.equal(sink.telemetry().droppedMidPublications, 2);
    await waitFor(() => sink.telemetry().acknowledged === 2);
    const recovered = mid("v2", 1.5, 30, 100n, 150n);
    sink.recordPricing(delta({
      previousBlock: 203,
      block: 204,
      updates: [["edge-a", recovered]],
      removals: [],
      mids: new Map([["edge-a", recovered]]),
    }));
    await sink.shutdown(5_000);

    const records = await readJsonl(historyPath);
    assert.equal(records.length, 3);
    assert.equal(records[2]!.type, "block_scan_mid_baseline");
    assert.equal(records[2]!.source_block, 204);
    assert.equal(records[2]!.dropped_publications_before, 2);
    assert.equal(records[2]!.first_dropped_block, 202);
    assert.equal(records[2]!.last_dropped_block, 203);
  });
});

test("disabled history is a zero-work sink", async () => {
  const sink = await initBlockScanEnumerationSolverTelemetry({
    path: "",
    midHistoryPath: "",
    eventsPath: "unused",
    runId: "run",
  });
  assert.equal(sink.enabled, false);
  sink.recordPricing(baseline(1, new Map()));
  await sink.shutdown();
  assert.equal(sink.telemetry().midBaselines, 0);
});

test("an event-file hardlink is rejected without truncating the event file", async () => {
  await withTempDir(async (directory) => {
    const eventsPath = join(directory, "events.jsonl");
    const routePath = join(directory, "routes.jsonl");
    const historyPath = join(directory, "mids-hardlink.jsonl");
    const formalEvents = '{"type":"must-survive"}\n';
    await writeFile(eventsPath, formalEvents);
    await link(eventsPath, historyPath);
    const warnings: string[] = [];
    const sink = await initBlockScanEnumerationSolverTelemetry({
      path: routePath,
      midHistoryPath: historyPath,
      eventsPath,
      runId: "mid-history-hardlink",
      minFreeBytes: 1,
      onWarning: (warning) => warnings.push(warning),
    });
    assert.equal(sink.enabled, false);
    assert.match(warnings.join("\n"), /one link|aliases formal events inode/);
    assert.equal(await readFile(eventsPath, "utf8"), formalEvents);
  });
});

function baseline(
  block: number,
  mids: ReadonlyMap<string, RouteVenueMid>,
  effectiveMids?: EffectiveMidSnapshot,
): StrictPricingPublication {
  return Object.freeze({
    kind: "baseline" as const,
    graphFingerprint: "graph-v1",
    snapshot: snapshot(block, mids, effectiveMids),
  });
}

function delta(input: {
  readonly previousBlock: number;
  readonly block: number;
  readonly updates: readonly (readonly [string, RouteVenueMid])[];
  readonly removals: readonly string[];
  readonly mids: ReadonlyMap<string, RouteVenueMid>;
  readonly effectiveMids?: EffectiveMidSnapshot;
}): StrictPricingPublication {
  return Object.freeze({
    kind: "delta" as const,
    graphFingerprint: "graph-v1",
    previousGeneration: input.previousBlock,
    previousSourceBlock: input.previousBlock,
    previousSourceBlockHash: blockHash(input.previousBlock),
    updates: input.updates,
    removals: input.removals,
    snapshot: snapshot(input.block, input.mids, input.effectiveMids),
  });
}

function snapshot(
  block: number,
  mids: ReadonlyMap<string, RouteVenueMid>,
  effectiveMids?: EffectiveMidSnapshot,
): StrictPricingPublication["snapshot"] {
  return {
    generation: block,
    sourceBlock: block,
    sourceBlockHash: blockHash(block),
    mids,
    ...(effectiveMids === undefined ? {} : { effectiveMids }),
  } as StrictPricingPublication["snapshot"];
}

const EFFECTIVE_UNIT = 10n ** 30n;

function effectiveSnapshot(block: number, amountOut = EFFECTIVE_UNIT * 101n): EffectiveMidSnapshot {
  const amountIn = EFFECTIVE_UNIT * 100n;
  const rows: EffectiveMidRow[] = [
    { edgeId: "edge-a", instanceKey: "venue-a", tokenIn: "token-a", tokenOut: "token-b",
      amountIn, amountOut, effectiveMid: Number(amountOut) / Number(amountIn), status: "quoted" },
    { edgeId: "edge-b", instanceKey: "venue-b", tokenIn: "token-b", tokenOut: "token-a",
      amountIn, amountOut: amountIn, effectiveMid: 1, status: "quoted" },
  ];
  return {
    source: { number: block, hash: blockHash(block), generation: block },
    reference: block === 300 ? "default" : "gas",
    referenceWethInput: EFFECTIVE_UNIT + BigInt(block - 299),
    rows: new Map(rows.map(row => [row.edgeId, row])),
    complete: true, wallMs: 12.5 + block - 300,
  };
}

function mid(
  kind: RouteVenueMid["kind"],
  price: number,
  feeBps: number,
  reserveA: bigint,
  reserveB: bigint,
): RouteVenueMid {
  return Object.freeze({
    kind,
    pool: "0xpool",
    edges: [],
    mid: price,
    feeBps,
    reserveA,
    reserveB,
    depthProxy: Number(reserveA < reserveB ? reserveA : reserveB),
  });
}

function blockHash(block: number): string {
  return `0x${block.toString(16).padStart(64, "0")}`;
}

async function readJsonl(path: string): Promise<JsonRecord[]> {
  return (await readFile(path, "utf8")).trim().split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JsonRecord);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function withTempDir(
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "mev-mid-history-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

type JsonRecord = Record<string, unknown>;
