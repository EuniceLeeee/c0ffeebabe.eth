import assert from "node:assert/strict";
import test from "node:test";
import { collectStartupActivity, collectIndexedStartupActivity, startupCatchupSource } from "../blockscan-startup-catchup.js";

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
