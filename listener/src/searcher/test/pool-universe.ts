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

    const rankedFile = join(dir, "ranked-pools.json");
    writeFileSync(rankedFile, JSON.stringify({
      pools: Array.from({ length: 1502 }, (_unused, i) => ({
        address: poolAddress(0x1000 + i),
        adapter: "univ2",
        token0: poolAddress(0xa000 + i),
        token1: poolAddress(0xb000 + i),
        score: 1502 - i,
      })),
    }));
    const bounded = loadPoolUniverse(rankedFile, { maxPools: 1500, minScore: 1 });
    assert(bounded.length === 1500, `topN=1500 should load 1500 pools, got ${bounded.length}`);
    assert(bounded[0].address === poolAddress(0x1000), "topN=1500 should keep highest score first");
    assert(bounded[1499].address === poolAddress(0x1000 + 1499), "topN=1500 should keep top 1500 by score");
    assert(!bounded.some((pool) => pool.address === poolAddress(0x1000 + 1500)), "topN=1500 should cut rank 1501");
    console.log("[pool-universe] topN=1500 bounded/ranked: PASS");

    const unlimited = loadPoolUniverse(rankedFile, { maxPools: 0, minScore: 1 });
    assert(unlimited.length === 1502, `topN=0 should load all pools, got ${unlimited.length}`);
    console.log("[pool-universe] topN=0 unlimited: PASS");

    const forceFile = join(dir, "force-pools.json");
    const belowCut = poolAddress(0x2003);
    const scoreless = poolAddress(0x2004);
    const v4PoolManager = poolAddress(0x2005);
    writeFileSync(forceFile, JSON.stringify({
      pools: [
        {
          address: poolAddress(0x2001),
          adapter: "univ2",
          token0: poolAddress(0xc001),
          token1: poolAddress(0xc002),
          score: 10,
        },
        {
          address: poolAddress(0x2002),
          adapter: "univ2",
          token0: poolAddress(0xc001),
          token1: poolAddress(0xc003),
          score: 9,
        },
        {
          address: belowCut,
          adapter: "univ3",
          token0: poolAddress(0xc001),
          token1: poolAddress(0xc004),
          score: 1,
        },
        {
          address: scoreless,
          adapter: "curve",
        },
        {
          address: v4PoolManager,
          adapter: "univ4",
          poolId: "0x" + "11".repeat(32),
          currency0: poolAddress(0xc001),
          currency1: poolAddress(0xc005),
          fee: 3000,
          tickSpacing: 60,
          hooks: poolAddress(0),
        },
      ],
    }));
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => { warnings.push(String(message)); };
    let forced: ReturnType<typeof loadPoolUniverse> = [];
    try {
      forced = loadPoolUniverse(forceFile, {
        maxPools: 2,
        minScore: 5,
        forceInclude: [belowCut.toLowerCase(), scoreless, v4PoolManager],
      });
    } finally {
      console.warn = originalWarn;
    }
    assert(forced.length === 4, `forceInclude should append two non-v4 pools, got ${forced.length}`);
    assert(forced.some((pool) => pool.address === belowCut), "forceInclude should promote below-cut pool");
    assert(forced.some((pool) => pool.address === scoreless), "forceInclude should promote scoreless pool");
    assert(!forced.some((pool) => pool.address === v4PoolManager), "forceInclude should skip v4 address identity");
    assert(
      warnings.some((line) => line.includes("forceInclude skipped univ4 entry")),
      "forceInclude v4 skip should warn",
    );
    console.log("[pool-universe] forceInclude minScore-bypass/v4-skip: PASS");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log("pool-universe PASS (6/6)");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
