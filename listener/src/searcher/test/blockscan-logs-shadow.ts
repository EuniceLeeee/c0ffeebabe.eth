import assert from "node:assert/strict";
import test from "node:test";
import { BlockScanActivityPrefetch } from "../blockscan-activity-prefetch.js";
import {
  collectBlockTraceTouchedStateKeys,
  readBlockTouchedStateKeys,
  readRetainedBlockTouchedStateKeys,
  type BlockTouchedProvider,
  type BlockTouchedStateKeyResolver,
} from "../blockscan-touched-state.js";

const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const manager = address(900);
const logPool = address(1), tracePool = address(2), sender = address(3), passive = address(4);
const logKey = "state:log-pool", traceKey = "state:trace-pool", passiveKey = "state:passive-owner";
const anchor = (number = 42) => ({
  number, hash: hash(number), parentHash: hash(number - 1),
  transactionHashes: [hash(number + 1000)], passiveTouchedAddresses: [passive],
});
type Anchor = ReturnType<typeof anchor>;
const log = (h: Anchor, emitter = logPool) => ({
  address: emitter, topics: [], data: "0x", blockHash: h.hash, transactionHash: h.transactionHashes[0],
});
const traces = (h: Anchor) => [{ txHash: h.transactionHashes[0], result: {
  type: "CALL", from: sender, to: tracePool, input: "0x12345678", gas: "0x100", gasUsed: "0x10", output: "0x",
} }];
const resolver: BlockTouchedStateKeyResolver = Object.assign(
  (observation: Parameters<BlockTouchedStateKeyResolver>[0]) =>
    observation.kind === "log" ? [logKey] : [traceKey],
  { passiveStateKeys: () => [passiveKey] },
);
const logsOnly = { mode: "logs-shadow" as const };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const never = new Promise<never>(() => {});

async function promptly<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("foreground waited for shadow activity")), 1500);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

function fixture(h = anchor()) {
  const calls: string[] = [];
  const provider: BlockTouchedProvider = {
    async getLogs(filter) {
      assert("blockHash" in filter);
      calls.push(`logs:${filter.blockHash}`);
      return [log(h)];
    },
    async send(method) { calls.push(method); return traces(h); },
  };
  return { h, calls, provider };
}

test("logs-only touched returns while a shadow observer remains unresolved and excludes all call-only keys", async () => {
  const f = fixture();
  f.provider.send = async () => { f.calls.push("unexpected-trace"); return never; };
  const observed: string[][] = [];
  const value = await promptly(readBlockTouchedStateKeys(f.provider, f.h.number, manager, f.h, undefined, resolver, {
    ...logsOnly,
    shadow: { begin(number, source) {
      assert.equal(number, f.h.number); assert.equal(source.hash, f.h.hash);
      return { observeLogs(keys) { observed.push([...keys]); return never; }, failLogs() { assert.fail("valid logs failed"); } };
    } },
  }));
  assert.deepEqual(value, new Set([logPool, logKey, passive, passiveKey]));
  assert(!value.has(tracePool) && !value.has(traceKey) && !value.has(sender));
  assert.deepEqual(observed, [[...value]]);
  assert.deepEqual(f.calls, [`logs:${f.h.hash}`]);
});

test("hinted prefetch, canonical read, activity scope and close never launch or await a live trace", async () => {
  const f = fixture();
  f.provider.send = async () => { f.calls.push("unexpected-trace"); return never; };
  const reader = new BlockScanActivityPrefetch(f.provider, new AbortController().signal, "logs-shadow");
  reader.noteHead(f.h.number, f.h.hash);
  const h = await promptly(reader.observeHeader(f.h.number, async () => f.h));
  const result = await promptly(reader.withBlockActivity(h.hash, () => readBlockTouchedStateKeys(
    reader, h.number, manager, h, undefined, resolver, logsOnly,
  )));
  assert.deepEqual(result, new Set([logPool, logKey, passive, passiveKey]));
  await promptly(reader.closeAndDrain());
  assert.deepEqual(f.calls, [`logs:${f.h.hash}`], "the confirmed speculative logs are consumed once");
});

test("logs-only prefetch rejects accidental block trace calls before transport and leaves other reads usable", async () => {
  const f = fixture();
  const reader = new BlockScanActivityPrefetch(f.provider, new AbortController().signal, "logs-shadow");
  for (const method of ["debug_traceBlockByHash", "debug_traceBlockByNumber"]) {
    await assert.rejects(Promise.resolve().then(() => reader.send(method, [f.h.hash, {}])));
  }
  assert.deepEqual(f.calls, []);
  await reader.send("eth_getBlockByNumber", ["0x2a", true]);
  assert.deepEqual(f.calls, ["eth_getBlockByNumber"]);
  await reader.closeAndDrain();
});

test("orphan hints and failed canonical headers do not secretly drain trace in logs-only mode", async () => {
  for (const kind of ["orphan", "header-error"] as const) {
    const f = fixture();
    f.provider.getLogs = async filter => {
      assert("blockHash" in filter); f.calls.push(`logs:${filter.blockHash}`);
      return filter.blockHash === f.h.hash ? [log(f.h)] : [];
    };
    f.provider.send = async () => { f.calls.push("unexpected-trace"); return never; };
    const reader = new BlockScanActivityPrefetch(f.provider, new AbortController().signal, "logs-shadow");
    reader.noteHead(f.h.number, hash(999));
    if (kind === "header-error") {
      const error = new Error("canonical header invalid");
      await assert.rejects(promptly(reader.observeHeader(f.h.number, async () => { throw error; })), e => e === error);
    } else {
      const h = await promptly(reader.observeHeader(f.h.number, async () => f.h));
      const value = await promptly(reader.withBlockActivity(h.hash, () => readBlockTouchedStateKeys(
        reader, h.number, manager, h, undefined, resolver, logsOnly,
      )));
      assert(value.has(logKey));
      assert.deepEqual(f.calls, [`logs:${hash(999)}`, `logs:${f.h.hash}`]);
    }
    await promptly(reader.closeAndDrain());
    assert(!f.calls.includes("unexpected-trace"));
  }
});

test("observer exceptions cannot change successful foreground activity or mask a real log failure", async () => {
  for (const throwsAt of ["begin", "observeLogs", "failLogs"] as const) {
    const f = fixture();
    const logError = new Error("actual log transport failure");
    if (throwsAt === "failLogs") f.provider.getLogs = async () => { throw logError; };
    const read = readBlockTouchedStateKeys(f.provider, f.h.number, manager, f.h, undefined, resolver, {
      ...logsOnly,
      shadow: { begin() {
        if (throwsAt === "begin") throw new Error("observer begin failure");
        return {
          observeLogs() { if (throwsAt === "observeLogs") throw new Error("observer completion failure"); },
          failLogs() { throw new Error("observer failure handler failure"); },
        };
      } },
    });
    if (throwsAt === "failLogs") await assert.rejects(read, e => e === logError);
    else assert.deepEqual(await promptly(read), new Set([logPool, logKey, passive, passiveKey]));
    assert(!f.calls.some(call => call.startsWith("debug_trace")));
  }
});

test("async observer rejections are consumed without rejecting live activity or masking log errors", async () => {
  for (const rejectsAt of ["observeLogs", "failLogs"] as const) {
    const f = fixture();
    const logError = new Error("actual log transport failure");
    let callbacks = 0;
    if (rejectsAt === "failLogs") f.provider.getLogs = async () => { throw logError; };
    const read = readBlockTouchedStateKeys(f.provider, f.h.number, manager, f.h, undefined, resolver, {
      ...logsOnly,
      shadow: { begin() { return {
        observeLogs() {
          assert.equal(rejectsAt, "observeLogs"); callbacks++;
          return Promise.reject(new Error("asynchronous observer completion failure"));
        },
        failLogs() {
          assert.equal(rejectsAt, "failLogs"); callbacks++;
          return Promise.reject(new Error("asynchronous observer failure handler failure"));
        },
      }; } },
    });
    if (rejectsAt === "failLogs") await assert.rejects(read, error => error === logError);
    else assert.deepEqual(await promptly(read), new Set([logPool, logKey, passive, passiveKey]));
    // node:test reports an unhandled rejection as a test failure. Advance past
    // the rejection turn so a detached callback cannot escape the assertion.
    await tick(); await tick();
    assert.equal(callbacks, 1);
    assert(!f.calls.some(call => call.startsWith("debug_trace")));
  }
});

test("observer receives detached facts and cannot inject shadow-only keys into the live result", async () => {
  const f = fixture();
  let captured: Iterable<string> | undefined;
  const result = await readBlockTouchedStateKeys(f.provider, f.h.number, manager, f.h, undefined, resolver, {
    ...logsOnly,
    shadow: { begin() { return { observeLogs(keys) { captured = keys; }, failLogs() {} }; } },
  });
  if (captured instanceof Set) { captured.clear(); captured.add(traceKey); }
  else if (Array.isArray(captured) && !Object.isFrozen(captured)) captured.push(traceKey);
  assert.deepEqual(result, new Set([logPool, logKey, passive, passiveKey]));
  const retained = await readRetainedBlockTouchedStateKeys(f.provider, f.h.number, manager, f.h, resolver, undefined, logsOnly);
  assert.deepEqual(retained, result, "the retained logs cache must not receive shadow mutations either");
});

test("range cache is partitioned across trace and logs modes on the same provider and resolver", async () => {
  const f = fixture();
  const range = { previousSource: { number: f.h.number - 1, hash: f.h.parentHash },
    readHeader: async () => { throw new Error("target header was already supplied"); } };
  const read = (mode: "trace" | "logs-shadow") => readBlockTouchedStateKeys(
    f.provider, f.h.number, manager, f.h, range, resolver, { mode },
  );
  assert((await read("trace")).has(traceKey));
  const tracesBefore = f.calls.filter(call => call.startsWith("debug_trace")).length;
  const logs = await read("logs-shadow");
  assert.deepEqual(logs, new Set([logPool, logKey, passive, passiveKey]));
  assert.equal(f.calls.filter(call => call.startsWith("debug_trace")).length, tracesBefore);
  assert((await read("trace")).has(traceKey), "returning to trace mode cannot borrow the smaller logs-only set");
  assert.deepEqual(await read("logs-shadow"), logs);
});

test("retained orphan cache is partitioned across modes and independent resolver roots", async () => {
  const f = fixture();
  await readBlockTouchedStateKeys(f.provider, f.h.number, manager, f.h, undefined, resolver, { mode: "trace" });
  const tracesBefore = f.calls.filter(call => call.startsWith("debug_trace")).length;
  const logs = await readRetainedBlockTouchedStateKeys(f.provider, f.h.number, manager, f.h, resolver, undefined, logsOnly);
  assert.deepEqual(logs, new Set([logPool, logKey, passive, passiveKey]));
  assert.equal(f.calls.filter(call => call.startsWith("debug_trace")).length, tracesBefore);
  const otherResolver: BlockTouchedStateKeyResolver = () => ["state:new-root"];
  const other = await readRetainedBlockTouchedStateKeys(f.provider, f.h.number, manager, f.h, otherResolver, undefined, logsOnly);
  assert(other.has("state:new-root") && !other.has(logKey) && !other.has(passiveKey));
  const restored = await readRetainedBlockTouchedStateKeys(f.provider, f.h.number, manager, f.h, resolver, undefined, { mode: "trace" });
  assert(restored.has(traceKey) && !restored.has("state:new-root"));
});

test("a skipped-head range includes every intermediate log and shadow receives per-block facts", async () => {
  const blocks = [anchor(40), anchor(41), anchor(42)];
  const byHash = new Map(blocks.map(h => [h.hash, h]));
  const reads: string[] = [], headerReads: number[] = [];
  const observations = new Map<number, string[]>();
  const provider: BlockTouchedProvider = {
    async getLogs(filter) {
      assert("blockHash" in filter); reads.push(filter.blockHash);
      const h = byHash.get(filter.blockHash)!; return [log(h, address(h.number))];
    },
    async send() { assert.fail("range must not issue foreground trace"); },
  };
  const value = await readBlockTouchedStateKeys(provider, 42, manager, blocks[2], {
    previousSource: { number: 39, hash: hash(39) },
    async readHeader(number) { headerReads.push(number); return blocks.find(h => h.number === number)!; },
  }, undefined, { ...logsOnly, shadow: { begin(number, h) {
    assert.equal(h.hash, hash(number));
    return { observeLogs(keys) { observations.set(number, [...keys]); }, failLogs() { assert.fail("valid block failed"); } };
  } } });
  assert.deepEqual(headerReads, [40, 41]);
  assert.deepEqual(reads, blocks.map(h => h.hash));
  assert.deepEqual(value, new Set([address(40), address(41), address(42), passive]));
  assert.deepEqual([...observations], blocks.map(h => [h.number, [address(h.number), passive]]));
});

test("middle-block log failure does not return a partial range or submit later shadow blocks", async () => {
  const observed: number[] = [], failed: number[] = [], started: number[] = [], reads: number[] = [];
  const error = new Error("middle log read unavailable");
  const provider: BlockTouchedProvider = {
    async getLogs(filter) {
      assert("blockHash" in filter); const number = Number(BigInt(filter.blockHash)); reads.push(number);
      if (number === 41) throw error;
      return [log(anchor(number), address(number))];
    },
    async send() { assert.fail("range must not issue foreground trace"); },
  };
  let returned = false;
  await assert.rejects(readBlockTouchedStateKeys(provider, 42, manager, anchor(42), {
    previousSource: { number: 39, hash: hash(39) }, readHeader: async number => anchor(number),
  }, undefined, { ...logsOnly, shadow: { begin(number) {
    started.push(number);
    return { observeLogs() { observed.push(number); }, failLogs() { failed.push(number); } };
  } } }).then(value => { returned = true; return value; }), e => e === error);
  assert.equal(returned, false);
  assert.deepEqual(reads, [40, 41]); assert.deepEqual(started, [40, 41]);
  assert.deepEqual(observed, [40]); assert.deepEqual(failed, [41]);
});

test("malformed logs remain fatal and cannot be submitted as successful shadow observations", async () => {
  const h = anchor();
  for (const invalid of [
    { ...log(h), blockHash: hash(99) },
    { ...log(h), removed: true },
    { ...log(h), topics: ["0x1234"] },
    { ...log(h), data: "0x1" },
    { ...log(h), transactionHash: hash(99) },
  ]) {
    let complete = 0, failed = 0, traceReads = 0;
    const provider: BlockTouchedProvider = {
      getLogs: async () => [invalid], send: async () => { traceReads++; return traces(h); },
    };
    await assert.rejects(readBlockTouchedStateKeys(provider, h.number, manager, h, undefined, resolver, {
      ...logsOnly, shadow: { begin() { return {
        observeLogs() { complete++; }, failLogs() { failed++; },
      }; } },
    }));
    assert.equal(complete, 0); assert.equal(failed, 1); assert.equal(traceReads, 0);
  }
});

test("trace-only interpretation retains complete anchored validation without contributing to live caches", async () => {
  const f = fixture();
  const expected = collectBlockTraceTouchedStateKeys(traces(f.h), f.h.number, f.h, resolver);
  assert(expected.has(traceKey) && expected.has(tracePool) && !expected.has(logKey));
  for (const malformed of [null, [], [{ ...traces(f.h)[0], txHash: hash(99) }], [{ ...traces(f.h)[0], truncated: true }]]) {
    assert.throws(() => collectBlockTraceTouchedStateKeys(malformed, f.h.number, f.h, resolver));
  }
  const logged = await readBlockTouchedStateKeys(f.provider, f.h.number, manager, f.h, undefined, resolver, logsOnly);
  assert(!logged.has(traceKey) && !logged.has(tracePool));
  await tick();
  assert.deepEqual(f.calls, [`logs:${f.h.hash}`]);
});
