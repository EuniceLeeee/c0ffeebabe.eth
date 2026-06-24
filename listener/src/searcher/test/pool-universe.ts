import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadPoolUniverse } from "../pool-universe.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function poolAddress(n: number): string {
  return "0x" + n.toString(16).padStart(40, "0");
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "pool-universe-"));
  try {
    const file = join(dir, "active-pools.json");
    writeFileSync(file, JSON.stringify({
      pools: [
        {
          address: poolAddress(1),
          adapter: "univ3",
          token0: poolAddress(0xa0),
          token1: poolAddress(0xb1),
          swapCount30d: 9,
        },
        {
          address: poolAddress(2),
          adapter: "univ2",
          token0: poolAddress(0xa0),
          token1: poolAddress(0xc1),
          score: 4,
          swapCount30d: 99,
        },
        {
          address: poolAddress(3),
          adapter: "curve",
          swapCount30d: 1,
        },
      ],
    }));

    const pools = loadPoolUniverse(file, { maxPools: 2, minScore: 2 });
    assert(pools.length === 2, `expected 2 filtered pools, got ${pools.length}`);
    assert(pools[0].address === poolAddress(1), "swapCount30d should be the default score");
    assert(pools[0].score === 9, `expected score 9, got ${pools[0].score}`);
    assert(pools[1].address === poolAddress(2), "explicit score should rank second");
    assert(pools[1].score === 4, `expected explicit score 4, got ${pools[1].score}`);
    assert(pools[1].swapCount30d === 99, "swapCount30d should be preserved");
    console.log("[pool-universe] load/filter/rank: PASS");

    const missing = loadPoolUniverse(join(dir, "missing.json"));
    assert(missing.length === 0, `missing universe should default to empty, got ${missing.length}`);
    console.log("[pool-universe] missing file defaults empty: PASS");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log("pool-universe PASS (2/2)");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
