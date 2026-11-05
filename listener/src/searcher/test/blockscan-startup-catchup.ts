import assert from "node:assert/strict";
import test from "node:test";
import { collectStartupActivity, collectIndexedStartupActivity, startupCatchupSource, StartupActivityCollector } from "../blockscan-startup-catchup.js";
import { BlockActivityRangeInvalidatedError, readBlockTouchedStateKeys } from "../blockscan-touched-state.js";

const hash = (number: number) => `0x${number.toString(16).padStart(64, "0")}`;
const header = (number: number) => ({ number, hash: hash(number) });
const base = { number: 100, hash: hash(100) };

test("BigQuery is default and RPC remains an explicit alternative", () => {
  assert.equal(startupCatchupSource(undefined), "bigquery");
  assert.equal(startupCatchupSource("bigquery"), "bigquery");
  assert.equal(startupCatchupSource("rpc"), "rpc");
  assert.throws(() => startupCatchupSource("bogus"));
});

test("RPC startup collects all chunks, deduplicates, and stays at its fixed target", async () => {
  const ranges: unknown[] = [];
  const result = await collectStartupActivity({ target: header(613), range: { previousSource: base },
    readHeader: async number => header(number),
    readRange: async (number, anchor, range) => {
      ranges.push([range.previousSource.number, number]);
      assert.equal(range.previousSource.hash, hash(range.previousSource.number));
      assert.equal(anchor.hash, hash(number));
      return new Set(["SAME", `key-${number}`]);
    },
  });
  assert.deepEqual(ranges, [[100, 356], [356, 612], [612, 613]]);
  assert.deepEqual([...result], ["same", "key-356", "key-612", "key-613"]);
});

test("partial range failure or cancellation cannot return the already collected union", async () => {
  for (const failure of ["missing", "abort", "deadline"] as const) {
    const controller = new AbortController();
    let count = 0;
    const range = { previousSource: base, signal: controller.signal, deadlineAtMs: Date.now() + 60_000 };
    await assert.rejects(collectStartupActivity({ target: header(613), range,
      readHeader: async number => header(number),
      readRange: async () => {
        count++;
        if (count === 2) {
          if (failure === "missing") throw new Error("missing activity chunk");
          if (failure === "abort") controller.abort(new Error("abort activity"));
          if (failure === "deadline") range.deadlineAtMs = 0;
        }
        return new Set(["first-chunk"]);
      },
    }));
    assert.equal(count, 2);
  }
});

test("same-height identity and malformed chunk anchors fail closed", async () => {
  let calls = 0;
  const readRange = async () => { calls++; return new Set<string>(); };
  assert.equal((await collectStartupActivity({ target: header(100), range: { previousSource: base },
    readHeader: async number => header(number), readRange })).size, 0);
  await assert.rejects(collectStartupActivity({ target: { number: 100, hash: hash(101) },
    range: { previousSource: base }, readHeader: async number => header(number), readRange }), /mismatch/);
  await assert.rejects(collectStartupActivity({ target: header(613), range: { previousSource: base },
    readHeader: async number => header(number + 1), readRange }), /height mismatch/);
  assert.equal(calls, 0);
});

for (const cutoff of [null, 356, 613]) test(`indexed prefix ${cutoff} plus RPC suffix forms one complete fixed union`, async () => {
  const ranges: number[][] = [];
  let sqlReads = 0;
  const result = await collectIndexedStartupActivity({ target: header(613), range: { previousSource: base },
    readHeader: async number => header(number), readCutoff: async (first, last) => {
      assert.equal(first.number, 101); assert.equal(last.number, 613); return cutoff;
    }, readIndexed: async (first, last) => {
      sqlReads++; assert.equal(first.number, 101); assert.equal(last.number, cutoff); return new Set(["shared", "sql"]);
    }, readRange: async (n, _header, range) => {
      ranges.push([range.previousSource.number, n]); return new Set(["shared", "rpc"]);
    },
  });
  assert.equal(sqlReads, cutoff === null ? 0 : 1);
  assert.deepEqual(ranges, cutoff === null ? [[100, 356], [356, 612], [612, 613]] : cutoff === 356 ? [[356, 612], [612, 613]] : []);
  assert.deepEqual([...result].sort(), cutoff === null ? ["rpc", "shared"] : cutoff === 613 ? ["shared", "sql"] : ["rpc", "shared", "sql"]);
});

test("indexed read errors never silently fall back to RPC or publish a partial union", async () => {
  for (const cutoff of [99, 614, 356]) {
    let rpcReads = 0;
    await assert.rejects(collectIndexedStartupActivity({ target: header(613), range: { previousSource: base },
      readHeader: async number => header(number), readCutoff: async () => cutoff,
      readIndexed: async () => { throw new Error("missing indexed block"); },
      readRange: async () => { rpcReads++; return new Set<string>(); },
    }));
    assert.equal(rpcReads, 0);
  }
});

test("retained chunks survive an RPC failure without exposing a partial union", async () => {
  const ranges: number[][] = [], headers: number[] = [];
  let fail = true, delivered = false;
  const collector = new StartupActivityCollector({ readHeader: async number => { headers.push(number); return header(number); },
    readRange: async (number, _header, range) => {
      ranges.push([range.previousSource.number, number]);
      if (number === 868 && fail) { fail = false; throw new Error("RPC Internal error"); }
      return new Set(["SHARED", `chunk-${number}`]);
    } });
  await assert.rejects(collector.collect({ target: header(869), range: { previousSource: base } })
    .then(value => { delivered = true; return value; }), /Internal error/);
  assert.equal(delivered, false);
  headers.length = 0;
  const result = await collector.collect({ target: header(869), range: { previousSource: base } });
  assert.deepEqual(ranges, [[100, 356], [356, 612], [612, 868], [612, 868], [868, 869]]);
  assert.deepEqual(headers.slice(0, 2), [100, 612]);
  assert.deepEqual([...result], ["shared", "chunk-356", "chunk-612", "chunk-868", "chunk-869"]);
  (result as Set<string>).clear();
  const next = await collector.collect({ target: header(870), range: { previousSource: base } });
  assert.deepEqual(ranges.at(-1), [869, 870]);
  assert.equal(next.size, 6, "caller mutation cannot erase the retained prefix");
});

test("same injected failure repeats prefixes before the change, skips them after, and preserves the complete union", async () => {
  const compare = async (resumable: boolean) => {
    const calls: number[][] = [];
    let fail = true;
    const readHeader = async (number: number) => header(number);
    const readRange = async (number: number, _header: ReturnType<typeof header>, range: { previousSource: typeof base }) => {
      calls.push([range.previousSource.number, number]);
      if (number === 868 && fail) { fail = false; throw new Error("same RPC Internal error"); }
      return new Set(["same", `chunk-${number}`]);
    };
    const collector = new StartupActivityCollector({ readHeader, readRange });
    const input = { target: header(869), range: { previousSource: base } };
    const collect = () => resumable ? collector.collect(input) : collectStartupActivity({ ...input, readHeader, readRange });
    await assert.rejects(collect(), /same RPC Internal error/);
    const result = await collect();
    return { calls, result: [...result] };
  };
  const before = await compare(false), after = await compare(true);
  assert.deepEqual(before.calls, [[100, 356], [356, 612], [612, 868], [100, 356], [356, 612], [612, 868], [868, 869]]);
  assert.deepEqual(after.calls, [[100, 356], [356, 612], [612, 868], [612, 868], [868, 869]]);
  assert.deepEqual(after.result, before.result);
  assert.equal(before.calls.filter(([from]) => from === 100 || from === 356).length, 4);
  assert.equal(after.calls.filter(([from]) => from === 100 || from === 356).length, 2);
});

test("real touched reader retries a failed block without repeating completed 256-block chunks", async () => {
  const traces = new Map<number, number>(), ranges: number[][] = [];
  const fullHeader = (number: number) => ({ ...header(number), parentHash: hash(number - 1), transactionHashes: [] as string[] });
  let fail = true;
  const provider = {
    getLogs: async (filter: any) => [{ address: "0x" + BigInt(filter.blockHash).toString(16).padStart(40, "0"),
      blockHash: filter.blockHash, topics: [], data: "0x" }],
    send: async (_method: string, params: unknown[]) => {
      const number = Number(BigInt(params[0] as string));
      traces.set(number, (traces.get(number) ?? 0) + 1);
      if (number === 500 && fail) { fail = false; throw new Error("RPC Internal error"); }
      return [];
    },
  };
  const collector = new StartupActivityCollector({ readHeader: async number => fullHeader(number),
    readRange: async (number, anchor, range) => {
      ranges.push([range.previousSource.number, number]);
      return readBlockTouchedStateKeys(provider, number, `0x${"ff".repeat(20)}`, anchor,
        { ...range, readHeader: async number => fullHeader(number) });
    } });
  await assert.rejects(collector.collect({ target: fullHeader(613), range: { previousSource: base } }), /Internal error/);
  const result = await collector.collect({ target: fullHeader(613), range: { previousSource: base } });
  assert.deepEqual(ranges, [[100, 356], [356, 612], [356, 612], [612, 613]]);
  assert.equal(result.size, 513);
  for (let number = 101; number <= 613; number++) assert.equal(traces.get(number), number === 500 ? 2 : 1);
});

for (const changed of [100, 356]) test(`canonical mismatch at ${changed} invalidates a retained prefix`, async () => {
  const ranges: number[][] = [];
  let fail = true, reorg = false;
  const collector = new StartupActivityCollector({ readHeader: async number => ({ number,
    hash: reorg && number === changed ? hash(number + 10_000) : hash(number) }),
    readRange: async (number, _header, range) => {
      ranges.push([range.previousSource.number, number]);
      if (number === 612 && fail) { fail = false; throw new Error("RPC failure"); }
      return new Set([`chunk-${number}`]);
    } });
  const input = { target: header(613), range: { previousSource: base } };
  await assert.rejects(collector.collect(input), /RPC failure/);
  reorg = true;
  await assert.rejects(collector.collect(input), BlockActivityRangeInvalidatedError);
  reorg = false;
  await collector.collect(input);
  assert.deepEqual(ranges, [[100, 356], [356, 612], [100, 356], [356, 612], [612, 613]]);
});

test("target shrink and a changed price base discard the old union", async () => {
  const ranges: number[][] = [];
  const collector = new StartupActivityCollector({ readHeader: async number => header(number),
    readRange: async (number, _header, range) => { ranges.push([range.previousSource.number, number]); return new Set([`chunk-${number}`]); } });
  await collector.collect({ target: header(613), range: { previousSource: base } });
  assert.deepEqual([...await collector.collect({ target: header(400), range: { previousSource: base } })], ["chunk-356", "chunk-400"]);
  assert.deepEqual([...await collector.collect({ target: header(650), range: { previousSource: header(600) } })], ["chunk-650"]);
  assert.deepEqual(ranges, [[100, 356], [356, 612], [612, 613], [100, 356], [356, 400], [600, 650]]);
});

for (const failure of ["abort", "deadline"] as const) test(`${failure} cannot commit a late chunk or race a successor`, async () => {
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const controller = new AbortController(), ranges: number[][] = [];
  const range = { previousSource: base, signal: controller.signal, deadlineAtMs: Date.now() + 60_000 };
  let block = true;
  const collector = new StartupActivityCollector({ readHeader: async number => header(number),
    readRange: async (number, _header, chunk) => {
      ranges.push([chunk.previousSource.number, number]);
      if (number === 612 && block) { block = false; entered(); await blocked; }
      return new Set([`chunk-${number}`]);
    } });
  const pending = collector.collect({ target: header(613), range });
  await started;
  if (failure === "abort") controller.abort(new Error("cancelled owner"));
  else range.deadlineAtMs = 0;
  await assert.rejects(collector.collect({ target: header(700), range: { previousSource: base } }), /already active/);
  const rejected = assert.rejects(pending, failure === "abort" ? /cancelled owner/ : /deadline/);
  release(); await rejected;
  const result = await collector.collect({ target: header(613), range: { previousSource: base } });
  assert.deepEqual(ranges, [[100, 356], [356, 612], [356, 612], [612, 613]]);
  assert.deepEqual([...result], ["chunk-356", "chunk-612", "chunk-613"]);
});

test("a final target recheck failure retains data but cannot publish until rechecked", async () => {
  const ranges: number[][] = [];
  let failure: "rpc" | "reorg" | null = "rpc";
  const collector = new StartupActivityCollector({ readHeader: async number => {
    if (number === 400 && failure === "rpc") throw new Error("header unavailable");
    return number === 400 && failure === "reorg" ? { number, hash: hash(401) } : header(number);
  }, readRange: async (number, _header, range) => { ranges.push([range.previousSource.number, number]); return new Set([`chunk-${number}`]); } });
  const input = { target: header(400), range: { previousSource: base } };
  await assert.rejects(collector.collect(input), /unavailable/);
  failure = null;
  assert.equal((await collector.collect(input)).size, 2);
  assert.deepEqual(ranges, [[100, 356], [356, 400]], "canonical recheck does not reread completed activity");
  failure = "reorg";
  await assert.rejects(collector.collect(input), BlockActivityRangeInvalidatedError);
  failure = null;
  await collector.collect(input);
  assert.deepEqual(ranges.slice(2), [[100, 356], [356, 400]]);
});

test("typed chain invalidation clears all retained prefix; malformed chunk keys cannot be partially committed", async () => {
  for (const failure of ["chain", "keys"] as const) {
    let fail = true;
    const ranges: number[][] = [];
    const collector = new StartupActivityCollector({ readHeader: async number => header(number),
      readRange: async (number, _header, range) => {
        ranges.push([range.previousSource.number, number]);
        if (number === 612 && fail) {
          fail = false;
          if (failure === "chain") throw new BlockActivityRangeInvalidatedError("chain changed");
          return new Set(["must-not-leak", ""]);
        }
        return new Set([`chunk-${number}`]);
      } });
    const input = { target: header(613), range: { previousSource: base } };
    await assert.rejects(collector.collect(input), failure === "chain" ? /chain changed/ : /invalid.*state key/);
    const result = await collector.collect(input);
    assert.equal(result.has("must-not-leak"), false);
    assert.deepEqual(ranges.slice(2), failure === "chain" ? [[100, 356], [356, 612], [612, 613]] : [[356, 612], [612, 613]]);
  }
});
