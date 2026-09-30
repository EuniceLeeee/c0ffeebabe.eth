import assert from "node:assert/strict";
import test from "node:test";
import { BlockScanActivityPrefetch } from "../blockscan-activity-prefetch.js";
import { readBlockTouchedStateKeys, type BlockTouchedProvider } from "../blockscan-touched-state.js";
import { BlockScanHeaderUnavailableError } from "../blockscan-observed-header.js";
import { LatestHeadScheduler } from "../latest-head-scheduler.js";

const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const address = `0x${"12".repeat(20)}`;
const anchor = (n = 42) => ({ number: n, hash: hash(n), parentHash: hash(n - 1), transactionHashes: [] });
const options = { tracer: "callTracer", tracerConfig: { onlyTopCall: false } };
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const create = (overrides: Partial<BlockTouchedProvider> = {}) => {
  const calls: unknown[] = [];
  const controller = new AbortController();
  const provider: BlockTouchedProvider = {
    getLogs: async filter => { calls.push(filter); return []; },
    send: async (method, params) => { calls.push([method, ...params]); return []; }, ...overrides,
  };
  return { calls, controller, reader: new BlockScanActivityPrefetch(provider, controller.signal) };
};

test("selected head overlaps all three reads; fast header does not await activity or duplicate requests", async () => {
  const full = deferred<ReturnType<typeof anchor>>();
  const logs = deferred<[]>(), traces = deferred<[]>();
  const calls: string[] = [];
  const { reader } = create({ getLogs: async () => { calls.push("logs"); return logs.promise; },
    send: async () => { calls.push("trace"); return traces.promise; } });
  reader.noteHead(42, hash(42));
  const pending = reader.observeHeader(42, () => { calls.push("header"); return full.promise; });
  await tick();
  assert.deepEqual(calls.sort(), ["header", "logs", "trace"]);
  full.resolve(anchor());
  const header = await pending; // Activity is deliberately still pending.
  const touched = readBlockTouchedStateKeys(reader, 42, address, header);
  logs.resolve([]); traces.resolve([]);
  assert.deepEqual([...await touched], []);
  assert.equal(calls.length, 3);
  await reader.closeAndDrain();
});

test("without a WS hint the existing by-number header and anchored activity path is unchanged", async () => {
  const { reader, calls } = create();
  const header = await reader.observeHeader(42, async () => anchor());
  assert.equal(calls.length, 0);
  await readBlockTouchedStateKeys(reader, 42, address, header);
  assert.equal(calls.length, 2);
  reader.noteHead(42, hash(42)); // Late/duplicate notification cannot relaunch the same reads.
  await reader.observeHeader(42, async () => anchor());
  assert.equal(calls.length, 2);
});

test("orphan hint is drained and discarded; actual canonical hash drives fallback reads", async () => {
  const orphan = deferred<[]>();
  const calls: string[] = [];
  const { reader } = create({ getLogs: async filter => {
    assert("blockHash" in filter); calls.push(filter.blockHash); return [];
  }, send: async (_method, params) => {
    calls.push(String(params[0])); return params[0] === hash(99) ? orphan.promise : [];
  } });
  reader.noteHead(42, hash(99));
  let done = false;
  const pending = reader.observeHeader(42, async () => anchor()).then(v => { done = true; return v; });
  await tick(); assert.equal(done, false);
  orphan.resolve([]);
  await readBlockTouchedStateKeys(reader, 42, address, await pending);
  assert.deepEqual(calls, [hash(99), hash(99), hash(42), hash(42)]);
});

test("original touched validator still rejects wrong log hash, trace count/order, and missing trace data", async () => {
  const cases = [
    { logs: [{ address, topics: [], blockHash: hash(99) }], traces: [], expected: /mismatched logs/ },
    { logs: [], traces: [{}], expected: /count mismatch/ },
    { logs: [], traces: null, expected: /must return an array/ },
    { logs: [], traces: [{ txHash: hash(3), result: {} }], txs: [hash(2)], expected: /transaction hash mismatch/ },
  ];
  for (const c of cases) {
    const { reader } = create({ getLogs: async () => c.logs, send: async () => c.traces });
    reader.noteHead(42, hash(42));
    const header = await reader.observeHeader(42, async () => ({ ...anchor(), transactionHashes: c.txs ?? [] }));
    await assert.rejects(readBlockTouchedStateKeys(reader, 42, address, header), c.expected);
  }
});

test("canonical header failure drains both siblings and never leaks rejected speculative promises", async () => {
  const trace = deferred<[]>();
  const failure = new Error("canonical failure");
  const { reader } = create({ getLogs: async () => { throw new Error("log failure"); }, send: () => trace.promise });
  reader.noteHead(42, hash(42));
  let done = false;
  const pending = reader.observeHeader(42, async () => { throw failure; }).catch(e => { done = true; return e; });
  await tick(); assert.equal(done, false);
  trace.reject(new Error("trace failure"));
  assert.equal(await pending, failure);
  await reader.closeAndDrain();
});

test("matching hint preserves transport rejection and completed range memo retains its identity", async () => {
  const failure = Object.assign(new Error("RPC throttle"), { statusCode: 429 });
  const { reader } = create({ send: async () => { throw failure; } });
  reader.noteHead(42, hash(42));
  const header = await reader.observeHeader(42, async () => anchor());
  await assert.rejects(readBlockTouchedStateKeys(reader, 42, address, header), e => e === failure);
  const good = create();
  good.reader.noteHead(42, hash(42));
  const ok = await good.reader.observeHeader(42, async () => anchor());
  const range = { previousSource: { number: 41, hash: hash(41) }, readHeader: async () => anchor() };
  for (let i = 0; i < 2; i++) await readBlockTouchedStateKeys(good.reader, 42, address, ok, range);
  assert.equal(good.calls.length, 2);
});

test("abort/deadline before launch issue no requests; abort after header starts drains activity", async () => {
  const before = create(); before.controller.abort();
  before.reader.noteHead(42, hash(42));
  await assert.rejects(before.reader.observeHeader(42, async () => anchor()), /aborted/);
  assert.equal(before.calls.length, 0);
  const expired = create(); expired.reader.noteHead(42, hash(42));
  await assert.rejects(expired.reader.observeHeader(42, async () => anchor(), { deadlineAtMs: 0 }), /deadline/);
  assert.equal(expired.calls.length, 0);
  const full = deferred<ReturnType<typeof anchor>>(), trace = deferred<[]>();
  const later = create({ send: () => trace.promise }); later.reader.noteHead(42, hash(42));
  let done = false;
  const pending = later.reader.observeHeader(42, () => full.promise).catch(e => { done = true; return e; });
  await tick(); later.controller.abort(); full.resolve(anchor());
  await tick(); assert.equal(done, false);
  trace.resolve([]); assert.match(String(await pending), /aborted/);
});

test("queued heads never issue I/O; hints and speculative work are bounded and close drains them", async () => {
  const trace = deferred<[]>();
  let count = 0;
  const { reader } = create({ send: async () => { count++; return trace.promise; } });
  for (let i = 1; i <= 1000; i++) reader.noteHead(i, hash(i));
  assert.equal(count, 0);
  await reader.observeHeader(1, async () => anchor(1)); // Evicted hint.
  for (const n of [998, 999, 1000]) await reader.observeHeader(n, async () => anchor(n));
  assert.equal(count, 2);
  let closed = false;
  const closing = reader.closeAndDrain().then(() => { closed = true; });
  await tick(); assert.equal(closed, false);
  assert.throws(() => reader.getLogs({ blockHash: hash(998) }), /aborted/);
  trace.resolve([]); await closing;
  await assert.rejects(reader.observeHeader(1001, async () => anchor(1001)), /aborted/);
});

test("trace options are not silently replaced by the prefetched callTracer configuration", async () => {
  const { reader, calls } = create(); reader.noteHead(42, hash(42));
  await reader.observeHeader(42, async () => anchor());
  await reader.send("debug_traceBlockByHash", [hash(42), { ...options, timeout: "2s" }]);
  await reader.send("debug_traceBlockByHash", [hash(42), options]);
  await reader.getLogs({ blockHash: hash(42) });
  assert.equal(calls.length, 3);
});

test("early HTTP availability rejection retries once after canonical header, never retries malformed success", async () => {
  let confirmed = false, logs = 0, traces = 0;
  const full = deferred<ReturnType<typeof anchor>>();
  const { reader } = create({ getLogs: async () => {
    logs++; if (!confirmed) throw new Error("block not yet available"); return [];
  }, send: async () => { traces++; if (!confirmed) throw new Error("block not yet available"); return []; } });
  reader.noteHead(42, hash(42));
  const pending = reader.observeHeader(42, () => full.promise);
  await tick(); confirmed = true; full.resolve(anchor());
  const header = await pending;
  await reader.withBlockActivity(header.hash, () => readBlockTouchedStateKeys(reader, 42, address, header));
  assert.equal(logs, 2); assert.equal(traces, 2);
});

test("cancelled range before consumption joins confirmed speculative work and does not retry", async () => {
  const trace = deferred<[]>(); let calls = 0;
  const { reader } = create({ getLogs: async () => { calls++; throw new Error("early rejection"); },
    send: () => { calls++; return trace.promise; } });
  reader.noteHead(42, hash(42));
  const header = await reader.observeHeader(42, async () => anchor());
  const cancelled = new AbortController(); cancelled.abort(new Error("range cancelled"));
  const range = { previousSource: { number: 41, hash: hash(41) }, readHeader: async () => anchor(), signal: cancelled.signal };
  let done = false;
  const pending = reader.withBlockActivity(header.hash,
    () => readBlockTouchedStateKeys(reader, 42, address, header, range), range).catch(e => { done = true; return e; });
  await tick(); assert.equal(done, false); assert.equal(calls, 2);
  trace.resolve([]); assert.match(String(await pending), /range cancelled/);
  assert.equal(calls, 2);
});

test("retirement after consumption does not turn speculative rejection into a new RPC", async () => {
  const raw = deferred<[]>(); let calls = 0;
  const { reader } = create({ getLogs: () => { calls++; return raw.promise; } });
  reader.noteHead(42, hash(42));
  const header = await reader.observeHeader(42, async () => anchor());
  const cancelled = new AbortController();
  const pending = reader.withBlockActivity(header.hash,
    () => readBlockTouchedStateKeys(reader, 42, address, header), { signal: cancelled.signal });
  await tick(); cancelled.abort(); raw.reject(new Error("early rejection"));
  await assert.rejects(pending, /aborted/); assert.equal(calls, 1);
});

test("WS before full HTTP header availability recovers within the same scheduled pass", async () => {
  const { reader } = create(); let reads = 0, successes = 0;
  const scheduler = new LatestHeadScheduler(async number => {
    await reader.observeHeader(number, async () => {
      if (++reads === 1) throw new BlockScanHeaderUnavailableError("not yet available");
      return anchor();
    }, { deadlineAtMs: Date.now() + 1000 });
    successes++;
  });
  reader.noteHead(42, hash(42)); scheduler.schedule(42);
  await tick(); scheduler.schedule(42); // HTTP's same-height notification is correctly coalesced.
  await scheduler.shutdown(); await reader.closeAndDrain();
  assert.equal(successes, 1); assert.equal(reads, 2); assert.equal(scheduler.telemetry().started, 1);
});

test("missing-header retry is bounded and cancelled/deadline/fatal reads cannot silently retry", async () => {
  const { reader } = create(); reader.noteHead(42, hash(42)); let calls = 0;
  await assert.rejects(reader.observeHeader(42, async () => {
    calls++; throw new BlockScanHeaderUnavailableError("unavailable");
  }), BlockScanHeaderUnavailableError);
  assert.equal(calls, 3);
  for (const failure of [new Error("malformed header"), Object.assign(new Error("HTTP 429"), { statusCode: 429 })]) {
    const sample = create(); sample.reader.noteHead(42, hash(42)); let attempts = 0;
    await assert.rejects(sample.reader.observeHeader(42, async () => { attempts++; throw failure; }), e => e === failure);
    assert.equal(attempts, 1);
  }
  for (const abort of [true, false]) {
    const sample = create(); sample.reader.noteHead(42, hash(42)); let attempts = 0;
    const pending = sample.reader.observeHeader(42, async () => {
      attempts++; throw new BlockScanHeaderUnavailableError("unavailable");
    }, { deadlineAtMs: Date.now() + (abort ? 1000 : 20) });
    const failed = assert.rejects(pending, /aborted|deadline/);
    if (abort) { await tick(); sample.controller.abort(); }
    await failed; assert.equal(attempts, 1);
  }
});
