import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { Worker } from "node:worker_threads";
import ts from "typescript";
import { createStateLatencyDiagnostics, type StateLatencyHost } from "../state-latency-diagnostics.js";

function fixture() {
  let mono = 100, wall = 10_000;
  const cpu = { user: 1_000, system: 2_000 }, heap = { heapUsed: 100, heapTotal: 200, external: 10, rss: 300 };
  const thread = { user: 500, system: 800 };
  const summaries: any[] = [], pending = new Set<() => void>();
  let accepts!: Parameters<StateLatencyHost["observeGc"]>[0], pulse!: () => void;
  let records: Parameters<typeof accepts>[0] = [];
  const counters = { observe: 0, pulse: 0, takes: 0, disconnect: 0, stop: 0, snapshots: 0, threadSnapshots: 0 };
  const host: StateLatencyHost = {
    now: () => mono, wallNow: () => wall,
    cpu: () => { counters.snapshots++; return cpu; }, heap: () => heap,
    threadCpu: () => { counters.threadSnapshots++; return thread; },
    observeGc(accept) { counters.observe++; accepts = accept; return {
      takeRecords() { counters.takes++; const result = records; records = []; return result; },
      disconnect() { counters.disconnect++; },
    }; },
    pulse(callback, interval) { assert.equal(interval, 100); counters.pulse++; pulse = callback; return () => { counters.stop++; }; },
    defer(callback) { pending.add(callback); return () => { pending.delete(callback); }; },
    emit: value => summaries.push(value),
  };
  return { host, counters, summaries, cpu, thread, heap, pending,
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
  assert.deepEqual(f.counters, { observe: 0, pulse: 0, takes: 0, disconnect: 0, stop: 0, snapshots: 0, threadSnapshots: 0 });
  assert.equal(f.pending.size, 0);
  Object.defineProperty(f.host, "threadCpu", { get() { throw new Error("disabled accessor"); } });
  assert.equal(createStateLatencyDiagnostics(false, f.host), undefined);
});

test("GC uses occurrence-time overlap, takes queued records, and freezes end CPU/heap before one deferred summary", () => {
  const f = fixture(), diagnostics = createStateLatencyDiagnostics(true, f.host)!;
  const sample = diagnostics.begin(123, 9_900)!;
  f.deliver([{ startTime: 80, duration: 10 }, { startTime: 90, duration: 20, detail: { kind: 4, flags: 1 } }]);
  f.queue([{ startTime: 105, duration: 10 }]);
  f.at(130); f.cpu.user = 21_000; f.cpu.system = 7_000; f.heap.heapUsed = 80;
  f.thread.user = 12_500; f.thread.system = 3_800;
  sample.finish("ran", "0x" + "AB".repeat(32));
  assert.equal(f.summaries.length, 0, "finish never writes or waits for log delivery");
  assert.equal(f.counters.takes, 1);
  assert.equal(f.counters.threadSnapshots, 2);
  f.at(200); f.cpu.user = 999_000; f.heap.heapUsed = 999;
  f.thread.user = 999_000; f.thread.system = 888_000;
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
  assert.deepEqual(result.mainThreadCpu, { scope: "main-thread", availability: "available", userMs: 12, systemMs: 3 });
  assert.equal(f.counters.threadSnapshots, 2, "deferred or duplicate finish must not resample thread CPU");
  assert.equal(result.processHeap.after.heapUsed, 80); assert.equal(result.processHeap.heapUsedDelta, -20);
  assert.equal(result.gc.observedOverlappingEntries, 3); assert.equal(result.gc.entryDurationOverlapMs, 30);
  assert.deepEqual(result.gc.slowest.map((item: any) => item.startMonotonicMs), [90, 105, 120]);
  assert.match(result.attribution, /not-exclusive/); assert.match(result.gc.visibility, /not-proof-of-absence/);
  diagnostics.close();
});

test("missing, throwing and invalid thread counters at either boundary preserve the rest of the summary", () => {
  const cases: [string, PropertyDescriptor][] = [
    ["missing", { value: undefined }],
    ["null", { value: () => null }],
    ["non-callable", { value: 1 }],
    ["throwing call", { value: () => { throw new Error("unsupported"); } }],
    ["throwing accessor", { get() { throw new Error("unsupported accessor"); } }],
    ["throwing counter accessor", { value: () => ({ get user() { throw new Error("invalid counter"); }, system: 0 }) }],
  ];
  for (const key of ["user", "system"]) {
    for (const value of [NaN, Infinity, -Infinity, -1, "1", undefined]) {
      cases.push([`${key}=${String(value)}`, { value: () => ({ user: 500, system: 800, [key]: value }) }]);
    }
  }
  for (const [name, descriptor] of cases) for (const boundary of ["before", "after"]) {
    const f = fixture(), threadCpu = f.host.threadCpu;
    if (boundary === "before") Object.defineProperty(f.host, "threadCpu", { ...descriptor, configurable: true });
    const diagnostics = createStateLatencyDiagnostics(true, f.host)!;
    const sample = diagnostics.begin(123, 9_900);
    assert(sample, `${name} at ${boundary} must not lose the sample`);
    Object.defineProperty(f.host, "threadCpu", boundary === "after"
      ? { ...descriptor, configurable: true } : { value: threadCpu, configurable: true });
    f.at(130); f.cpu.user += 20_000; f.cpu.system += 5_000; f.heap.heapUsed = 80;
    const status = boundary === "before" ? "ran" : "failed";
    assert.doesNotThrow(() => sample.finish(status)); f.flush();
    assert.equal(f.summaries.length, 1, `${name} at ${boundary}`);
    const result = f.summaries[0];
    assert.deepEqual(result.mainThreadCpu, { scope: "main-thread", availability: "unavailable", userMs: null, systemMs: null });
    assert.deepEqual(result.processCpu, { userMs: 20, systemMs: 5 });
    assert.equal(result.status, status); assert.equal(result.measurement.wallMs, 30);
    assert.equal(result.processHeap.heapUsedDelta, -20);
    assert.equal(result.gc.observedOverlappingEntries, 0); assert.equal(result.eventLoop.intervalMs, 100);
    diagnostics.close();
  }
});

test("regression of either thread counter makes the whole delta unavailable; zero deltas remain available", () => {
  for (const regressing of ["user", "system", null] as const) {
    const f = fixture(), diagnostics = createStateLatencyDiagnostics(true, f.host)!;
    const sample = diagnostics.begin(123, 9_900)!;
    if (regressing) f.thread[regressing]--;
    f.at(130); f.cpu.user += 20_000; f.cpu.system += 5_000;
    sample.finish("ran"); f.flush();
    assert.equal(f.summaries.length, 1);
    assert.deepEqual(f.summaries[0].mainThreadCpu, { scope: "main-thread", availability: regressing ? "unavailable" : "available",
      userMs: regressing ? null : 0, systemMs: regressing ? null : 0 });
    assert.deepEqual(f.summaries[0].processCpu, { userMs: 20, systemMs: 5 });
    assert.equal(f.summaries[0].measurement.wallMs, 30);
    diagnostics.close();
  }
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
  const supported = typeof (process as NodeJS.Process & { threadCpuUsage?: () => unknown }).threadCpuUsage === "function";
  assert.equal(result.mainThreadCpu.scope, "main-thread");
  assert.equal(result.mainThreadCpu.availability, supported ? "available" : "unavailable");
  if (supported) {
    assert(Number.isFinite(result.mainThreadCpu.userMs)); assert(Number.isFinite(result.mainThreadCpu.systemMs));
    assert(result.mainThreadCpu.userMs >= 0 && result.mainThreadCpu.systemMs >= 0);
    assert(result.mainThreadCpu.userMs + result.mainThreadCpu.systemMs > 0);
  } else {
    assert.equal(result.mainThreadCpu.userMs, null); assert.equal(result.mainThreadCpu.systemMs, null);
  }
  assert(result.eventLoop.pendingTimerAtFinish.lateByMs >= 20);
  assert(result.measurement.wallMs >= 130);
});

test("native feature detection keeps import/disabled paths inert and retains summaries when unavailable", { timeout: 10_000 }, () => {
  const module = new URL("../state-latency-diagnostics.ts", import.meta.url).href;
  const script = `import assert from 'node:assert/strict';
    let reads=0;
    Object.defineProperty(process,'threadCpuUsage',{configurable:true,get(){reads++;throw new Error('accessor');}});
    const {createStateLatencyDiagnostics}=await import(${JSON.stringify(module)});
    assert.equal(reads,0); assert.equal(createStateLatencyDiagnostics(false),undefined); assert.equal(reads,0);
    const cases=[{value:undefined},{value:1},{get(){throw new Error('accessor');}},
      {value(){throw new Error('call');}}];
    for(const descriptor of cases){
      Object.defineProperty(process,'threadCpuUsage',{...descriptor,configurable:true});
      const d=createStateLatencyDiagnostics(true); const s=d.begin(55,Date.now());
      assert(s); s.finish('ran'); d.close();
    }`;
  const run = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script],
    { encoding: "utf8", timeout: 8_000 });
  assert.equal(run.status, 0, run.stderr);
  const lines = run.stdout.split("\n").filter(line => line.startsWith("[searcher/state-latency-diagnostics] "));
  assert.equal(lines.length, 4);
  for (const line of lines) {
    const result = JSON.parse(line.slice(line.indexOf("{")));
    assert.deepEqual(result.mainThreadCpu, { scope: "main-thread", availability: "unavailable", userMs: null, systemMs: null });
    assert.equal(result.status, "ran"); assert(Number.isFinite(result.processCpu.userMs));
    assert(Number.isFinite(result.processHeap.heapUsedDelta)); assert(Number.isFinite(result.measurement.wallMs));
    assert.equal(result.gc.flush, "shutdown"); assert.equal(result.eventLoop.intervalMs, 100);
  }
});

test("a native worker never reports its current-thread counters as main-thread CPU", { timeout: 10_000 }, async () => {
  const source = readFileSync(new URL("../state-latency-diagnostics.ts", import.meta.url), "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const messages: any[] = [];
  const code = await new Promise<number>((resolve, reject) => {
    const worker = new Worker(`const {parentPort,isMainThread}=require('node:worker_threads');
      let reads=0;
      Object.defineProperty(process,'threadCpuUsage',{configurable:true,value(){reads++;return {user:reads*1000,system:reads*1000};}});
      ${js}
      console.log=line=>parentPort.postMessage({isMainThread,reads,summary:JSON.parse(line.slice(line.indexOf('{')))});
      const d=exports.createStateLatencyDiagnostics(true); const s=d.begin(55,Date.now());
      s.finish('ran'); d.close();`, { eval: true });
    worker.on("message", message => messages.push(message));
    worker.once("error", reject); worker.once("exit", resolve);
  });
  assert.equal(code, 0); assert.equal(messages.length, 1);
  const { isMainThread, reads, summary } = messages[0];
  assert.equal(isMainThread, false); assert.equal(reads, 0);
  assert.deepEqual(summary.mainThreadCpu, { scope: "main-thread", availability: "unavailable", userMs: null, systemMs: null });
  assert.equal(summary.status, "ran"); assert(Number.isFinite(summary.processCpu.userMs));
});
