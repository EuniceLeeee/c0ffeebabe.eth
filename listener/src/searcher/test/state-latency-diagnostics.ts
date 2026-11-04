import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import ts from "typescript";
import { createStateLatencyDiagnostics, type StateLatencyHost } from "../state-latency-diagnostics.js";

function fixture() {
  let mono = 100, wall = 10_000;
  const cpu = { user: 1_000, system: 2_000 }, heap = { heapUsed: 100, heapTotal: 200, external: 10, rss: 300 };
  const summaries: any[] = [], pending = new Set<() => void>();
  let accepts!: Parameters<StateLatencyHost["observeGc"]>[0], pulse!: () => void;
  let records: Parameters<typeof accepts>[0] = [];
  const counters = { observe: 0, pulse: 0, takes: 0, disconnect: 0, stop: 0, snapshots: 0 };
  const host: StateLatencyHost = {
    now: () => mono, wallNow: () => wall,
    cpu: () => { counters.snapshots++; return cpu; }, heap: () => heap,
    observeGc(accept) { counters.observe++; accepts = accept; return {
      takeRecords() { counters.takes++; const result = records; records = []; return result; },
      disconnect() { counters.disconnect++; },
    }; },
    pulse(callback, interval) { assert.equal(interval, 100); counters.pulse++; pulse = callback; return () => { counters.stop++; }; },
    defer(callback) { pending.add(callback); return () => { pending.delete(callback); }; },
    emit: value => summaries.push(value),
  };
  return { host, counters, summaries, cpu, heap, pending,
    at(n: number) { mono = n; wall = 10_000 + n - 100; },
    deliver(entries: Parameters<typeof accepts>[0]) { accepts(entries); },
    queue(entries: Parameters<typeof accepts>[0]) { records = entries; },
    pulse() { pulse(); },
    flush() { for (const callback of [...pending]) callback(); },
  };
}

test("disabled diagnostics create no observers, timers, snapshots or deferred work", () => {
  const f = fixture();
  assert.equal(createStateLatencyDiagnostics(false, f.host), undefined);
  assert.deepEqual(f.counters, { observe: 0, pulse: 0, takes: 0, disconnect: 0, stop: 0, snapshots: 0 });
  assert.equal(f.pending.size, 0);
});

test("GC uses occurrence-time overlap, takes queued records, and freezes end CPU/heap before one deferred summary", () => {
  const f = fixture(), diagnostics = createStateLatencyDiagnostics(true, f.host)!;
  const sample = diagnostics.begin(123, 9_900)!;
  f.deliver([{ startTime: 80, duration: 10 }, { startTime: 90, duration: 20, detail: { kind: 4, flags: 1 } }]);
  f.queue([{ startTime: 105, duration: 10 }]);
  f.at(130); f.cpu.user = 21_000; f.cpu.system = 7_000; f.heap.heapUsed = 80;
  sample.finish("ran", "0x" + "AB".repeat(32));
  assert.equal(f.summaries.length, 0, "finish never writes or waits for log delivery");
  assert.equal(f.counters.takes, 1);
  f.at(200); f.cpu.user = 999_000; f.heap.heapUsed = 999;
  f.deliver([{ startTime: 120, duration: 20 }, { startTime: 150, duration: 10 }]);
  sample.finish("failed"); f.flush(); f.flush();
  assert.equal(f.summaries.length, 1);
  const result = f.summaries[0];
  assert.equal(result.status, "ran");
  assert.equal(result.sourceBlockHash, "0x" + "ab".repeat(32));
  assert.equal(result.sampleSequence, 1); assert.match(result.scope, /not-unique-block/);
  assert.deepEqual(result.measurement, { startedAtMs: 10_000, finishedAtMs: 10_030,
    startedMonotonicMs: 100, finishedMonotonicMs: 130, wallMs: 30, excludesBackdatedSchedulerWait: true });
  assert.equal(result.timelineStartedAtMs, 9_900);
  assert.deepEqual(result.processCpu, { userMs: 20, systemMs: 5 });
  assert.equal(result.processHeap.after.heapUsed, 80); assert.equal(result.processHeap.heapUsedDelta, -20);
  assert.equal(result.gc.observedOverlappingEntries, 3); assert.equal(result.gc.entryDurationOverlapMs, 30);
  assert.deepEqual(result.gc.slowest.map((item: any) => item.startMonotonicMs), [90, 105, 120]);
  assert.match(result.attribution, /not-exclusive/); assert.match(result.gc.visibility, /not-proof-of-absence/);
  diagnostics.close();
});

test("late GC callback is not assigned to the next block merely because it arrives there", () => {
  const f = fixture(), diagnostics = createStateLatencyDiagnostics(true, f.host)!;
  const first = diagnostics.begin(1, 10_000)!;
  f.at(120); first.finish("ran"); f.flush();
  f.at(130); const next = diagnostics.begin(2, 10_030)!;
  f.deliver([{ startTime: 110, duration: 5 }]);
  f.at(150); next.finish("ran"); f.flush();
  assert.equal(f.summaries[0].gc.observedOverlappingEntries, 0);
  assert.match(f.summaries[0].gc.visibility, /not-proof-of-absence/);
  assert.equal(f.summaries[1].gc.observedOverlappingEntries, 0);
  assert.equal(f.summaries[1].sourceBlockHash, null);
  assert.equal(f.summaries[1].sampleSequence, 2);
  diagnostics.close();
});

test("event-loop evidence names overlapping timer windows instead of exact state stall duration", () => {
  const f = fixture(), diagnostics = createStateLatencyDiagnostics(true, f.host)!;
  f.at(150); const sample = diagnostics.begin(4, 10_050)!;
  f.at(220); sample.finish("ran");
  f.at(250); f.pulse(); f.flush();
  const loop = f.summaries[0].eventLoop;
  assert.equal(loop.sumWholeWindowLateByMs, 50);
  assert.deepEqual(loop.slowest[0], { startMonotonicMs: 100, endMonotonicMs: 250, elapsedMs: 150, lateByMs: 50, overlapWindowMs: 70 });
  assert.equal(loop.pendingTimerAtFinish.lateByMs, 20);
  assert.match(loop.attribution, /not-exact-state/); assert.match(loop.visibility, /straddle/);
  diagnostics.close();
});

test("GC batches, retained slow events and simultaneous samples are bounded with explicit omission counts", () => {
  const f = fixture(), diagnostics = createStateLatencyDiagnostics(true, f.host)!;
  const samples = Array.from({ length: 8 }, (_, index) => diagnostics.begin(index, 10_000)!);
  assert.equal(diagnostics.begin(99, 10_000), undefined);
  f.deliver(Array.from({ length: 1_000 }, (_, index) => ({ startTime: 101, duration: 1 + index / 1_000 })));
  f.at(110); for (const sample of samples) sample.finish("ran");
  assert.equal(f.pending.size, 8); f.flush();
  assert.equal(f.summaries.length, 8);
  for (const summary of f.summaries) {
    assert.equal(summary.gc.observedOverlappingEntries, 256);
    assert.equal(summary.gc.droppedDeliveryEntries, 744);
    assert.equal(summary.gc.slowest.length, 6);
    assert.equal(summary.gc.omittedSlowEvents, 250);
    assert.equal(summary.droppedSamples, 1);
  }
  assert.equal(f.pending.size, 0); diagnostics.close();
});

test("diagnostic failures never escape and shutdown disconnects observers, timers and pending emissions", () => {
  const f = fixture(); f.host.emit = () => { throw new Error("sink unavailable"); };
  const diagnostics = createStateLatencyDiagnostics(true, f.host)!;
  const sample = diagnostics.begin(1, 10_000)!; f.at(110); sample.finish("failed");
  assert.doesNotThrow(() => f.flush());
  const next = diagnostics.begin(2, 10_000)!; f.at(120); next.finish("ran");
  assert.doesNotThrow(() => diagnostics.close()); diagnostics.close(); f.flush();
  assert.equal(f.counters.disconnect, 1); assert.equal(f.counters.stop, 1); assert.equal(f.pending.size, 0);
  assert.equal(diagnostics.begin(3, 10_000), undefined);
  const broken = fixture(); broken.host.observeGc = () => { throw new Error("unsupported observer"); };
  assert.equal(createStateLatencyDiagnostics(true, broken.host)?.begin(1, 0), undefined);
  const snapshots = fixture(); snapshots.host.cpu = () => { throw new Error("snapshot failed"); };
  const failOpen = createStateLatencyDiagnostics(true, snapshots.host)!;
  assert.equal(failOpen.begin(1, 0), undefined); failOpen.close();
});

test("runtime finish wrapper preserves original stage order/errors and diagnostics finish exactly at state exit", () => {
  const source = readFileSync(new URL("../blockscan-runtime-loop.ts", import.meta.url), "utf8");
  const start = source.indexOf("    let stateLatencySample: StateLatencySample | undefined;");
  const end = source.indexOf("    const mergeAtomicStage =", start);
  assert(start > 0 && end > start);
  const js = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const calls: unknown[] = [];
  const timeline = { finish(name: string, status: string) { calls.push(["timeline", name, status]); if (name === "invalid") throw new Error("original failure"); } };
  const sample = { finish(status: string) { calls.push(["diagnostics", status]); } };
  const finish = new Function("passTimeline", "sample", "observedSourceBlockHash", `${js}; stateLatencySample=sample; return finishStage;`)(timeline, sample, null);
  finish("enumeration", "ran"); finish("state", "failed");
  assert.deepEqual(calls, [["timeline", "enumeration", "ran"], ["timeline", "state", "failed"], ["diagnostics", "failed"]]);
  assert.throws(() => finish("invalid", "ran"), /original failure/);
  assert(source.includes('stateLatencySample = this.stateLatencyDiagnostics?.begin(blockNumber, passStartedAtMs);\n    beginStage("state",'));
  assert(source.includes('stateLatencySample?.finish("failed", observedSourceBlockHash);\n        if ('));
  assert(source.includes('deps.enabled && process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS === "1"'));
});

test("native observer captures a real GC entry from its original interval without awaiting finish", { timeout: 10_000 }, () => {
  const module = new URL("../state-latency-diagnostics.ts", import.meta.url).href;
  const script = `import {createStateLatencyDiagnostics} from ${JSON.stringify(module)};
    import {performance} from 'node:perf_hooks';
    const d=createStateLatencyDiagnostics(true); const s=d.begin(55,Date.now());
    global.gc(); const end=performance.now()+130; while(performance.now()<end){};
    s.finish('ran'); await new Promise(setImmediate); await new Promise(setImmediate); d.close();`;
  const run = spawnSync(process.execPath, ["--expose-gc", "--import", "tsx", "--input-type=module", "-e", script],
    { encoding: "utf8", timeout: 8_000 });
  assert.equal(run.status, 0, run.stderr);
  const lines = run.stdout.split("\n").filter(line => line.startsWith("[searcher/state-latency-diagnostics] "));
  assert.equal(lines.length, 1);
  const result = JSON.parse(lines[0]!.slice(lines[0]!.indexOf("{")));
  assert(result.gc.observedOverlappingEntries > 0);
  assert(result.gc.slowest.some((entry: any) => entry.kind === 4), "forced major GC must be observed");
  assert(result.processCpu.userMs + result.processCpu.systemMs > 0);
  assert(result.eventLoop.pendingTimerAtFinish.lateByMs >= 20);
  assert(result.measurement.wallMs >= 130);
});
