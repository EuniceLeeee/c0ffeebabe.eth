import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deserialize, serialize } from "node:v8";
import { createHash } from "node:crypto";
import { LivePricingContinuationStore, LivePricingContinuationWriter, type LiveContinuationDelta } from "../blockscan-live-continuation.js";
import { buildEffectiveMids, exportEffectiveMidReplayState, exportEffectiveMidReplayDelta,
  restoreEffectiveMidReplayState, effectiveRowAmountReference, effectiveAmountReferences } from "../blockscan-effective-mid.js";
import { BlockScanAmountReference } from "../blockscan-amount-reference.js";
import { BlockScanSimRejectCache } from "../blockscan-sim-reject-cache.js";
import { ADDR } from "../../shared/constants/addresses.js";
import type { TokenEdge } from "../planner/token-graph.js";

const hash = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const token = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const source = (n: number) => ({ number: n, hash: hash(n), generation: n });
const edges: readonly TokenEdge[] = Object.freeze(Array.from({ length: 200 }, (_, n) => Object.freeze({
  canonicalEdgeId: `edge-${n}`, instanceKey: `pool-${n}`, adapterId: "fixture", target: token(n + 10),
  tokenIn: ADDR.WETH, tokenOut: token(n + 1), slotKind: "swap" as const, edgeKind: "swap" as const,
  leavesStandingPosition: false,
})));
const pricing = (n: number, effectiveMids?: any): any => ({ sourceBlock: n, sourceBlockHash: hash(n), generation: n,
  graph: { edges }, mids: new Map(), coverage: { resolvedEdgeKeys: edges.map(e => e.canonicalEdgeId!) },
  effectiveMids, pricingStateKeyByEdgeKey: new Map(edges.map(e => [e.canonicalEdgeId!, e.instanceKey!])) });
const build = (n: number, previous?: any, disabled = new Set<string>()) => buildEffectiveMids({
  pricing: pricing(n), weth: ADDR.WETH, fixedWethInput: 100n, gasCostWei: null,
  enumerationSpreadBps: 0, concurrency: 8, control: {}, previous,
  ...(previous ? { touchedStateKeys: new Set(["pool-1", "pool-2"]) } : {}), disabledEdgeIds: disabled,
  quote: async ({ amountIn, edge }) => {
    if (n === 11 && edge.instanceKey === "pool-2") throw Error("quote failed");
    return { source: source(n), amountIn, amountOut: amountIn * BigInt(n) };
  } });
const baseline = (effective: any, identity: string, amounts = new BlockScanAmountReference().exportHistoricalBaseline()): any => ({
  version: 1, identity, pricing: { version: 1, raw: pricing(10), pricing: pricing(10, effective),
    lineage: exportEffectiveMidReplayState(effective), disabledInstances: [] }, amounts,
  startup: { version: 1, rows: [] }, simRejects: { version: 1, routes: [], pools: [] } });
const aux = () => ({ disabled: [], amounts: new BlockScanAmountReference().takeContinuationDelta(),
  startup: { reset: false, rows: [] }, simRejects: { reset: false, routes: [], pools: [] } });

test("native deltas restore prices, failures, disabled rows, lineage and filters without rewarm", async () => {
  const dir = await mkdtemp(join(tmpdir(), "continuation-delta-"));
  try {
    const store = new LivePricingContinuationStore(dir, "a".repeat(64));
    const b = await build(10), data = baseline(b, store.identity);
    await store.write(data);
    await assert.rejects(store.write(data), /only complete|already exists/);
    const b1 = await build(11, b, new Set(["edge-3"]));
    const edit = exportEffectiveMidReplayDelta(b1, b);
    assert.equal(edit.updates.length, 3, "only two touched directions and one tombstone, not 200 rows");
    const delta: LiveContinuationDelta = { version: 2, previous: b.source, source: b1.source,
      effective: edit, ...aux(), simRejects: { reset: false, routes: ["route-1"], pools: ["pool-3"] }, disabled: ["instance"] };
    const bytes = await store.append(delta);
    assert(bytes < (await readFile(join(dir, (await readdir(dir)).find(f => f.startsWith("baseline-"))!))).length / 4);
    const b2 = await build(12, b1, new Set(["edge-3"]));
    await store.append({ version: 2, previous: b1.source, source: b2.source, effective: exportEffectiveMidReplayDelta(b2, b1), ...aux() });
    await writeFile(join(dir, "pending-interrupted.tmp"), "partial", { mode: 0o600 });
    const restored = (await new LivePricingContinuationStore(dir, store.identity).read())!;
    const effective = restored.pricing.pricing.effectiveMids!;
    restoreEffectiveMidReplayState(effective, restored.pricing.lineage, edges, ADDR.WETH);
    assert.deepEqual(effective.rows, b2.rows);
    assert.deepEqual(effectiveAmountReferences(effective), effectiveAmountReferences(b2));
    for (const [id, row] of effective.rows) assert.deepEqual(effectiveRowAmountReference(row), effectiveRowAmountReference(b2.rows.get(id)!));
    assert.deepEqual(restored.simRejects, { version: 1, routes: ["route-1"], pools: ["pool-3"] });
    assert.deepEqual(restored.pricing.disabledInstances, ["instance"]);
    let calls = 0;
    const next = await buildEffectiveMids({ pricing: pricing(13), weth: ADDR.WETH, fixedWethInput: 100n,
      gasCostWei: null, enumerationSpreadBps: 0, concurrency: 1, control: {}, previous: effective,
      touchedStateKeys: new Set(), disabledEdgeIds: new Set(["edge-3"]),
      quote: async () => { calls++; throw Error("must carry"); } });
    assert(next.complete); assert.equal(calls, 0);
    await assert.rejects(store.append(delta), /does not follow/);
    const pointer = deserialize((await readFile(join(dir, "current.bin"))).subarray(65)).pointer;
    const corrupted = await readFile(join(dir, pointer.head.file)); corrupted[80] ^= 1;
    await writeFile(join(dir, pointer.head.file), corrupted);
    await assert.rejects(new LivePricingContinuationStore(dir, store.identity).read(), /checksum/);
    await store.beginFreshRound();
    assert.equal(await new LivePricingContinuationStore(dir, store.identity).read(), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("live writer exports exactly one baseline, then captures native edits and post-sim changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "continuation-writer-"));
  try {
    const store = new LivePricingContinuationStore(dir, "a".repeat(64)), amounts = new BlockScanAmountReference();
    const simRejects = new BlockScanSimRejectCache(), startup = { exportContinuation: () => ({ version: 1 as const, rows: [] }),
      takeContinuationDelta: () => ({ reset: false, rows: [] }) };
    let effective = await build(10), current = pricing(10, effective), exports = 0;
    const raw = pricing(10), events: any[] = [];
    const coordinator: any = { continuationPricing: () => ({ pricing: current, raw }),
      takeContinuationDisabled: () => [], exportHistoricalBaseline: () => { exports++; return baseline(effective, store.identity).pricing; } };
    const writer = new LivePricingContinuationWriter({ store, coordinator, amounts, startup, simRejects, onEvent: e => events.push(e) });
    writer.capture(); await writer.flush();
    for (let n = 11; n < 15; n++) {
      effective = await build(n, effective); current = pricing(n, effective);
      writer.capture(); await writer.flush();
    }
    const revert: any = { success: false, failure: { kind: "revert", code: "TRANSACTION_REVERTED" } };
    simRejects.recordPool(edges[0]!, revert, { amount: 1n, p: 1n });
    writer.capture(); await writer.flush();
    assert.equal(exports, 1); assert.equal(events.filter(e => e.kind === "baseline").length, 1);
    assert.equal(events.filter(e => e.kind === "delta").length, 5);
    assert.equal(events.filter(e => e.phase === "save-failed").length, 0);
    assert.deepEqual((await store.read())!.simRejects.pools, ["pool-0"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("historical CLI seeds existing serialized bytes and uses the same delta chain", async () => {
  const dir = await mkdtemp(join(tmpdir(), "continuation-seed-"));
  try {
    const store = new LivePricingContinuationStore(join(dir, "journal"), "b".repeat(64));
    const before = await build(10), data = baseline(before, store.identity);
    const bytes = serialize({ version: 1, pricing: data.pricing }), file = join(dir, "existing.bin");
    await writeFile(file, bytes, { mode: 0o600 });
    const { pricing: _pricing, ...state } = data;
    await store.seedHistorical(file, createHash("sha256").update(bytes).digest("hex"), state, before.source);
    const after = await build(11, before);
    await store.append({ version: 2, previous: before.source, source: after.source,
      effective: exportEffectiveMidReplayDelta(after, before), ...aux() });
    const restored = (await new LivePricingContinuationStore(join(dir, "journal"), store.identity).read())!;
    restoreEffectiveMidReplayState(restored.pricing.pricing.effectiveMids!, restored.pricing.lineage, edges, ADDR.WETH);
    assert.deepEqual(restored.pricing.pricing.effectiveMids!.rows, after.rows);
    assert.deepEqual(await readFile(file), bytes, "original baseline bytes stay unchanged");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("auxiliary commits preserve resets, header eviction and successful-sim gas without repricing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "continuation-aux-"));
  try {
    const amounts = new BlockScanAmountReference(2), store = new LivePricingContinuationStore(dir, "c".repeat(64));
    const effective = await build(10);
    const header = (n: number) => ({ ...source(n), parentHash: hash(n - 1), baseFeePerGas: 1n, gasUsed: 1n, gasLimit: 100n });
    amounts.observeHeader(header(8)); amounts.observeHeader(header(9));
    await store.write(baseline(effective, store.identity, amounts.exportHistoricalBaseline()));
    amounts.takeContinuationDelta(); amounts.observeHeader(header(10));
    amounts.recordSimulation({ source: source(10), gasUsed: 20n, success: true, opportunity: {} as any });
    await store.append({ version: 2, previous: effective.source, source: effective.source, effective: null, ...aux(),
      amounts: amounts.takeContinuationDelta(), startup: { reset: false, rows: [["edge-0", { key: hash(1), observation: { edgeId: "edge-0" } }]] },
      simRejects: { reset: false, routes: ["r"], pools: ["pool-0"] } });
    let result = (await store.read())!;
    assert.deepEqual(result.amounts, amounts.exportHistoricalBaseline());
    assert.equal(result.startup.rows.length, 1); assert.equal(result.simRejects.pools.length, 1);
    amounts.observeHeader({ ...header(10), hash: hash(99) });
    await store.append({ version: 2, previous: effective.source, source: effective.source, effective: null, ...aux(),
      amounts: amounts.takeContinuationDelta(), startup: { reset: true, rows: [] }, simRejects: { reset: true, routes: [], pools: [] } });
    result = (await store.read())!;
    assert.deepEqual(result.amounts, amounts.exportHistoricalBaseline());
    assert.equal(result.startup.rows.length, 0); assert.equal(result.simRejects.pools.length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("explicit v1 compatibility keeps the old file/evidence identity and appends only deltas", async () => {
  const dir = await mkdtemp(join(tmpdir(), "continuation-v1-"));
  try {
    const oldIdentity = "a".repeat(64), newIdentity = "b".repeat(64);
    const first = await build(10), payload = serialize(baseline(first, oldIdentity));
    const bytes = Buffer.concat([Buffer.from(createHash("sha256").update(payload).digest("hex") + "\n"), payload]);
    const file = join(dir, "latest.bin");
    await writeFile(file, bytes, { mode: 0o600 });
    await assert.rejects(new LivePricingContinuationStore(dir, newIdentity).read(), /incompatible/);
    const store = new LivePricingContinuationStore(dir, newIdentity, oldIdentity);
    assert.equal((await store.read())!.identity, oldIdentity);
    const second = await build(11, first);
    await store.append({ version: 2, previous: first.source, source: second.source,
      effective: exportEffectiveMidReplayDelta(second, first), ...aux() });
    const restored = (await new LivePricingContinuationStore(dir, newIdentity, oldIdentity).read())!;
    assert.equal(restored.identity, oldIdentity, "original producer evidence not relabelled");
    assert.equal(restored.pricing.pricing.sourceBlock, 11);
    assert.deepEqual(await readFile(file), bytes, "v1 baseline remains byte-identical");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("disk failure retains the last commit and never falls back to a full-table write", async () => {
  const dir = await mkdtemp(join(tmpdir(), "continuation-disk-failure-"));
  try {
    const store = new LivePricingContinuationStore(dir, "d".repeat(64));
    let effective = await build(10), current = pricing(10, effective), exports = 0;
    const raw = pricing(10), events: any[] = [];
    const coordinator: any = { continuationPricing: () => ({ pricing: current, raw }),
      takeContinuationDisabled: () => [], exportHistoricalBaseline: () => { exports++; return baseline(effective, store.identity).pricing; } };
    const writer = new LivePricingContinuationWriter({ store, coordinator, amounts: new BlockScanAmountReference(),
      startup: { exportContinuation: () => ({ version: 1, rows: [] }), takeContinuationDelta: () => ({ reset: false, rows: [] }) },
      simRejects: new BlockScanSimRejectCache(), onEvent: event => events.push(event) });
    writer.capture(); await writer.flush();
    store.append = async () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); };
    effective = await build(11, effective); current = pricing(11, effective);
    writer.capture(); await assert.rejects(writer.flush(), /disk full/);
    effective = await build(12, effective); current = pricing(12, effective);
    writer.capture(); await assert.rejects(writer.flush(), /disk full/);
    assert.equal(exports, 1);
    assert.equal(events.filter(event => event.phase === "save-failed").length, 1);
    assert.equal((await new LivePricingContinuationStore(dir, store.identity).read())!.pricing.pricing.sourceBlock, 10);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("reviewed v2 producers resume one journal without rewriting baseline or old deltas", async () => {
  const dir = await mkdtemp(join(tmpdir(), "continuation-multi-producer-"));
  try {
    const a = "a".repeat(64), b = "b".repeat(64), c = "c".repeat(64);
    const first = await build(10), initial = new LivePricingContinuationStore(dir, a);
    await initial.write(baseline(first, a));
    const second = await build(11, first), prior = new LivePricingContinuationStore(dir, b, a);
    await prior.read();
    await prior.append({ version: 2, previous: first.source, source: second.source,
      effective: exportEffectiveMidReplayDelta(second, first), ...aux(),
      simRejects: { reset: false, routes: ["route-old"], pools: ["pool-3"] } });
    const immutable = new Map(await Promise.all((await readdir(dir)).filter(f => f !== "current.bin")
      .map(async file => [file, await readFile(join(dir, file))] as const)));
    await assert.rejects(new LivePricingContinuationStore(dir, c, a).read(), /incompatible/);
    await assert.rejects(new LivePricingContinuationStore(dir, c, b).read(), /incompatible/);
    const next = new LivePricingContinuationStore(dir, c, [a, b]);
    const restored = (await next.read())!;
    assert.equal(restored.identity, a, "do not relabel the original baseline");
    assert.deepEqual(restored.pricing.pricing.effectiveMids!.rows, second.rows);
    assert.deepEqual(restored.simRejects.pools, ["pool-3"]);
    const third = await build(12, second);
    await next.append({ version: 2, previous: second.source, source: third.source,
      effective: exportEffectiveMidReplayDelta(third, second), ...aux() });
    const resumed = (await new LivePricingContinuationStore(dir, c, [a, b]).read())!;
    assert.equal(resumed.identity, a);
    assert.deepEqual(resumed.pricing.pricing.effectiveMids!.rows, third.rows);
    assert.deepEqual(resumed.simRejects.routes, ["route-old"]);
    await assert.rejects(new LivePricingContinuationStore(dir, c, a).read(), /broken continuation chain/);
    for (const [file, bytes] of immutable) assert.deepEqual(await readFile(join(dir, file)), bytes);
    const pointerBytes = await readFile(join(dir, "current.bin"));
    const pointer = deserialize(pointerBytes.subarray(65));
    assert.equal(pointer.pointer.identity, c);
    assert.equal(pointer.pointer.baseline.identity, a);
    pointer.pointer.identity = b;
    const payload = serialize(pointer);
    await writeFile(join(dir, "current.bin"), Buffer.concat([
      Buffer.from(createHash("sha256").update(payload).digest("hex") + "\n"), payload,
    ]));
    await assert.rejects(new LivePricingContinuationStore(dir, c, [a, b]).read(), /broken continuation chain/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a missing committed delta is rejected, not silently skipped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "continuation-missing-"));
  try {
    const store = new LivePricingContinuationStore(dir, "e".repeat(64));
    const first = await build(10), second = await build(11, first);
    await store.write(baseline(first, store.identity));
    await store.append({ version: 2, previous: first.source, source: second.source,
      effective: exportEffectiveMidReplayDelta(second, first), ...aux() });
    const pointer = deserialize((await readFile(join(dir, "current.bin"))).subarray(65)).pointer;
    await rm(join(dir, pointer.head.file));
    await assert.rejects(new LivePricingContinuationStore(dir, store.identity).read(), { code: "ENOENT" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("repeated amount-header updates preserve eviction order across restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "continuation-header-order-"));
  try {
    const amounts = new BlockScanAmountReference(3), store = new LivePricingContinuationStore(dir, "f".repeat(64));
    const header = (n: number) => ({ ...source(n), parentHash: hash(n - 1), baseFeePerGas: 1n, gasUsed: 1n, gasLimit: 100n });
    for (const n of [7, 8, 9]) amounts.observeHeader(header(n));
    const effective = await build(10);
    await store.write(baseline(effective, store.identity, amounts.exportHistoricalBaseline()));
    amounts.takeContinuationDelta();
    for (const n of [8, 9, 8]) amounts.observeHeader(header(n));
    await store.append({ version: 2, previous: effective.source, source: effective.source, effective: null, ...aux(),
      amounts: amounts.takeContinuationDelta() });
    const saved = (await store.read())!.amounts;
    assert.deepEqual(saved, amounts.exportHistoricalBaseline());
    const restored = new BlockScanAmountReference(3); restored.restoreHistoricalBaseline(saved);
    for (const n of [10, 11]) { amounts.observeHeader(header(n)); restored.observeHeader(header(n)); }
    assert.deepEqual(restored.exportHistoricalBaseline(), amounts.exportHistoricalBaseline());
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("amount-reference tracking stays off without a writer and stops after saving fails", () => {
  const amounts = new BlockScanAmountReference(2);
  const header = (n: number) => ({ ...source(n), parentHash: hash(n - 1), baseFeePerGas: 1n, gasUsed: 1n, gasLimit: 100n });
  for (let n = 1; n <= 10_000; n++) amounts.observeHeader(header(n));
  assert.equal(amounts.exportHistoricalBaseline().headers.length, 2);
  assert.equal(amounts.takeContinuationDelta().removedHeaders.length, 0, "no-writer mode retains no eviction history");
  amounts.observeHeader(header(10_001));
  assert.deepEqual(amounts.takeContinuationDelta().removedHeaders, [9999]);
  amounts.stopContinuationTracking();
  for (let n = 10_002; n <= 20_000; n++) amounts.observeHeader(header(n));
  assert.equal(amounts.takeContinuationDelta().removedHeaders.length, 0, "failed-writer mode retains no eviction history");
});
