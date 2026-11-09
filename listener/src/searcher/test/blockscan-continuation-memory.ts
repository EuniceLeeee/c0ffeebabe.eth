import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { LivePricingContinuationStore } from "../blockscan-live-continuation.js";

const identity = "a".repeat(64);
const hash = "0x" + "1".repeat(64);
const source = { number: 10, hash, generation: 1 };
const repeated = "quote-path-" + "0123456789abcdef".repeat(128);
const base = (rows: any[] = []): any => ({
  version: 1, identity,
  pricing: { version: 1, raw: { sourceBlock: 10, sourceBlockHash: hash },
    pricing: { sourceBlock: 10, sourceBlockHash: hash, generation: 1,
      graph: { sourceBlock: 10, sourceBlockHash: hash, generation: 1, edges: [] },
      effectiveMids: { source, complete: true, rows: new Map() } },
    lineage: { version: 1, weth: "weth", references: [], byToken: [], byRow: [] }, disabledInstances: [] },
  amounts: { version: 1, headers: [], samples: [] },
  startup: { version: 1, rows }, simRejects: { version: 1, routes: [], pools: [] },
});
const files = async (dir: string) => Promise.all((await readdir(dir)).sort().map(async file =>
  [file, createHash("sha256").update(await readFile(join(dir, file))).digest("hex")]));

if (process.argv[2] === "--restore-memory-child") {
  assert(global.gc, "memory regression needs an isolated --expose-gc process");
  global.gc();
  const before = process.memoryUsage().heapUsed;
  const restored = (await new LivePricingContinuationStore(process.argv[3]!, identity).read())!;
  await new Promise<void>(resolve => setImmediate(resolve));
  global.gc();
  const heapGrowth = process.memoryUsage().heapUsed - before;
  assert.equal(restored.startup.rows.length, 12_000);
  for (const [index, [key, entry]] of restored.startup.rows.entries()) {
    assert.equal(key, "edge-" + index);
    assert.deepEqual(entry, { key: repeated, observation: {
      edgeId: key, prefix: repeated, amountIn: BigInt(index), success: index % 2 === 0,
    } });
  }
  assert.deepEqual(restored.pricing.pricing.effectiveMids!.source, source);
  // The unshared decode retains >45 MiB for this fixture. The shared result
  // needs only its distinct rows/keys; leave ample room for VM/test variance.
  assert(heapGrowth < 12 * 1024 * 1024, "restored duplicate strings retained " + heapGrowth + " bytes");
  console.log(JSON.stringify({ heapGrowth, rows: restored.startup.rows.length }));
} else {
  test("continuation restore bounds duplicate-string retention without changing journal bytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "continuation-memory-"));
    try {
      const rows = Array.from({ length: 12_000 }, (_, index) => ["edge-" + index, {
        key: repeated, observation: { edgeId: "edge-" + index, prefix: repeated,
          amountIn: BigInt(index), success: index % 2 === 0 },
      }]);
      await new LivePricingContinuationStore(dir, identity).write(base(rows));
      const before = await files(dir);
      const { stdout } = await promisify(execFile)(process.execPath,
        ["--expose-gc", "--import", "tsx", fileURLToPath(import.meta.url), "--restore-memory-child", dir],
        { timeout: 60_000, maxBuffer: 1024 * 1024 });
      const result = JSON.parse(stdout.trim());
      assert.equal(result.rows, rows.length);
      assert.deepEqual(await files(dir), before, "read/compaction must never rewrite authenticated evidence");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("continuation string sharing preserves values, aliasing, cycles and collection order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "continuation-sharing-"));
    try {
      const key = { name: repeated };
      const equalButDistinct = { name: repeated };
      const fixture: any = {
        key, alias: key, equalButDistinct,
        values: [repeated, repeated, "中文🙂".repeat(32), "", null, undefined, -0, NaN, 23n],
        map: new Map<any, any>([[repeated, key], [key, equalButDistinct], ["tail", repeated]]),
        set: new Set<any>([repeated, key, equalButDistinct]),
      };
      fixture.self = fixture;
      const data = { ...base(), fixture };
      await new LivePricingContinuationStore(dir, identity).write(data);
      const before = await files(dir);
      const restored = await new LivePricingContinuationStore(dir, identity).read() as any;
      assert.deepEqual(restored.fixture, fixture);
      assert.equal(restored.fixture.key, restored.fixture.alias);
      assert.notEqual(restored.fixture.key, restored.fixture.equalButDistinct);
      assert.equal(restored.fixture.self, restored.fixture);
      assert.equal(restored.fixture.map.get(restored.fixture.key), restored.fixture.equalButDistinct);
      assert.deepEqual([...restored.fixture.map.keys()], [...fixture.map.keys()]);
      assert.deepEqual([...restored.fixture.set], [...fixture.set]);
      assert.deepEqual(await files(dir), before);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}
