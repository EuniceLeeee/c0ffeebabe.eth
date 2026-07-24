import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mergePoolRegistries } from "../active-pool-discovery.js";
import {
  loadPoolUniverse,
  loadPoolUniverseCoverageMetadata,
  POOL_UNIVERSE_BUILD_MANIFEST_PROFILE,
  poolUniverseCanonicalAnchorMatches,
  selectPairCompletionPools,
} from "../pool-universe.js";
import type { PoolEntry } from "../planner/token-graph.js";
import {
  poolUniverseSourceFingerprints,
} from "../venues/production-registry.js";
import type { IdentityResolverDescriptor } from "../venues/identity.js";
import type { V2LineageDescriptor } from "../venues/v2-lineage.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function poolAddress(n: number): string {
  return "0x" + n.toString(16).padStart(40, "0");
}

const CFG_V4_POOL_ID = "0x267d01a3b23fe2340482242db5396f7544d36f398862efa591e92a079348cd9c";
const OTHER_V4_POOL_ID = "0x" + "22".repeat(32);

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

    const legacyCoverage = loadPoolUniverseCoverageMetadata(file);
    assert(
      legacyCoverage.registrySourceFingerprints === null,
      "legacy universe must not authorize discovery-registry completeness",
    );
    const coverageFile = join(dir, "coverage-pools.json");
    const coveragePayload = JSON.stringify({
      schemaVersion: 3,
      fromBlock: 10,
      toBlock: 20,
      generatedAt: "2026-07-24T00:00:00.000Z",
      registry: { sourceFingerprints: ["source-a", "source-b"] },
      pools: [],
    });
    writeFileSync(coverageFile, coveragePayload);
    writeFileSync(`${coverageFile}.manifest.json`, JSON.stringify({
      schemaVersion: 1,
      profile: POOL_UNIVERSE_BUILD_MANIFEST_PROFILE,
      chainId: 1,
      source: {
        number: 20,
        hash: `0x${"12".repeat(32)}`,
        stateRoot: `0x${"34".repeat(32)}`,
      },
      inputs: { fromBlock: 10, toBlock: 20 },
      registry: { sourceFingerprints: ["source-a", "source-b"] },
      output: {
        contentSha256: createHash("sha256")
          .update(coveragePayload)
          .digest("hex"),
        pools: 0,
      },
    }));
    const coverage = loadPoolUniverseCoverageMetadata(coverageFile);
    assert(coverage.fromBlock === 10 && coverage.toBlock === 20, "coverage range");
    assert(
      coverage.registrySourceFingerprints?.join(",") === "source-a,source-b",
      "exact sorted registry fingerprints must load",
    );
    assert(coverage.manifestVerified, "matching sidecar must verify");
    assert(
      poolUniverseCanonicalAnchorMatches(coverage, {
        number: 20,
        hash: `0x${"12".repeat(32)}`,
        stateRoot: `0x${"34".repeat(32)}`,
      }),
      "manifest source must match its canonical header",
    );
    assert(
      !poolUniverseCanonicalAnchorMatches(coverage, {
        number: 20,
        hash: `0x${"56".repeat(32)}`,
        stateRoot: `0x${"34".repeat(32)}`,
      }),
      "orphaned manifest source must fail closed",
    );
    writeFileSync(coverageFile, JSON.stringify({
      schemaVersion: 3,
      fromBlock: 10,
      toBlock: 20,
      registry: { sourceFingerprints: ["source-b", "source-a"] },
      pools: [],
    }));
    assert(
      loadPoolUniverseCoverageMetadata(coverageFile)
        .registrySourceFingerprints === null,
      "reordered/unverifiable registry fingerprints must fail closed",
    );
    console.log("[pool-universe] discovery registry provenance: PASS");

    const identityPolicies: readonly IdentityResolverDescriptor[] = [{
      poolAdapter: "univ2",
      policy: "trusted-singleton-seed",
    }];
    const lineage: V2LineageDescriptor = {
      venue: "v2-factory:0x0000000000000000000000000000000000000123",
      factory: poolAddress(0x123),
      executionFamily: "univ2-standard",
      runtimeAdapter: "univ2",
      discoverable: true,
      quotable: true,
      buildable: true,
      measuredFeeRule: {
        kind: "constant-bps",
        feeBps: 30n,
        evidence: "fixture",
      },
    };
    const provenance = (feeBps: bigint, unknownFactory: "probe" | "reject") =>
      poolUniverseSourceFingerprints({
        landedSourceFingerprints: ["landed-a"],
        identityPolicies,
        admissionPolicy: {
          unknownFactory,
          unregisteredCurveUnderlying: "probe",
        },
        v2Lineages: [{
          ...lineage,
          measuredFeeRule: { ...lineage.measuredFeeRule!, feeBps },
        }],
      });
    assert(
      provenance(30n, "probe").join(",") !==
        provenance(25n, "probe").join(","),
      "measured V2 fee changes must invalidate universe provenance",
    );
    assert(
      provenance(30n, "probe").join(",") !==
        provenance(30n, "reject").join(","),
      "identity admission changes must invalidate universe provenance",
    );
    console.log("[pool-universe] discovery semantics fingerprint: PASS");

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

    const highSpreadFile = join(dir, "high-spread-pools.json");
    const topPairA = [poolAddress(0xd001), poolAddress(0xd002)] as const;
    const topPairB = [poolAddress(0xd003), poolAddress(0xd004)] as const;
    const topPairC = [poolAddress(0xd005), poolAddress(0xd006)] as const;
    const rank4 = poolAddress(0x4104);
    const rank5 = poolAddress(0x4105);
    const highSpreadSamePair = poolAddress(0x4106);
    const highSpreadTail = poolAddress(0x4107);
    writeFileSync(highSpreadFile, JSON.stringify({
      pools: [
        { address: poolAddress(0x4101), adapter: "univ3", token0: topPairA[0], token1: topPairA[1], fee: 500, score: 100 },
        { address: poolAddress(0x4102), adapter: "univ3", token0: topPairB[0], token1: topPairB[1], fee: 500, score: 99 },
        { address: poolAddress(0x4103), adapter: "univ3", token0: topPairC[0], token1: topPairC[1], fee: 500, score: 98 },
        { address: rank4, adapter: "univ3", token0: poolAddress(0xd007), token1: poolAddress(0xd008), fee: 500, score: 97 },
        { address: rank5, adapter: "univ3", token0: poolAddress(0xd009), token1: poolAddress(0xd00a), fee: 500, score: 96 },
        { address: highSpreadSamePair, adapter: "univ3", token0: topPairA[0], token1: topPairA[1], fee: 10000, score: 4 },
        { address: highSpreadTail, adapter: "univ3", token0: poolAddress(0xd00b), token1: poolAddress(0xd00c), fee: 10000, score: 3 },
      ],
    }));
    const oldHighSpreadSelection = loadPoolUniverse(highSpreadFile, {
      maxPools: 5,
      minScore: 1,
      highSpreadPairQuota: 0,
    });
    assert(!oldHighSpreadSelection.some((pool) => pool.address === highSpreadTail), "old score-only topN should cut low-score high-fee tail");
    const highSpreadSelected = loadPoolUniverse(highSpreadFile, {
      maxPools: 5,
      minScore: 1,
      highSpreadPairQuota: 2,
      highSpreadMinFee: 10000,
    });
    assert(highSpreadSelected.length === 5, `high-spread quota should preserve cap, got ${highSpreadSelected.length}`);
    assert(highSpreadSelected.some((pool) => pool.address === highSpreadTail), "high-spread quota should admit unique low-score high-fee pair");
    assert(!highSpreadSelected.some((pool) => pool.address === highSpreadSamePair), "high-spread quota should not duplicate an already represented pair");
    assert(highSpreadSelected.some((pool) => pool.address === rank4), "high-spread quota should fill unused quota by score");
    assert(!highSpreadSelected.some((pool) => pool.address === rank5), "high-spread quota should displace the lowest score-only slot");
    console.log("[pool-universe] high-spread pair quota admission: PASS");

    const unlimited = loadPoolUniverse(rankedFile, { maxPools: 0, minScore: 1 });
    assert(unlimited.length === 1502, `topN=0 should load all pools, got ${unlimited.length}`);
    console.log("[pool-universe] topN=0 unlimited: PASS");

    const pairCompletionFile = join(dir, "pair-completion-pools.json");
    const pairAHigh = poolAddress(0x3001);
    const pairAAlt = poolAddress(0x3002);
    const pairBHigh = poolAddress(0x3003);
    const pairCAlt = poolAddress(0x3004);
    writeFileSync(pairCompletionFile, JSON.stringify({
      pools: [
        {
          address: pairAHigh,
          adapter: "univ3",
          token0: poolAddress(0xa001),
          token1: poolAddress(0xa002),
          score: 100,
        },
        {
          address: pairAAlt,
          adapter: "univ3",
          token0: poolAddress(0xa001),
          token1: poolAddress(0xa002),
          score: 3,
        },
        {
          address: pairBHigh,
          adapter: "univ2",
          token0: poolAddress(0xb001),
          token1: poolAddress(0xb002),
          score: 50,
        },
        {
          address: pairCAlt,
          adapter: "univ2",
          token0: poolAddress(0xc001),
          token1: poolAddress(0xc002),
          score: 2,
        },
      ],
    }));
    const admitted = loadPoolUniverse(pairCompletionFile, { maxPools: 2, minScore: 1 });
    assert(
      admitted.map((pool) => pool.address).join(",") === `${pairAHigh},${pairBHigh}`,
      "pair-completion setup should admit pairA-high + pairB-high in topN=2",
    );
    const admittedRuntime: PoolEntry[] = admitted.map((pool) =>
      pool.address === pairAHigh
        ? { address: pool.address, adapter: pool.adapter, score: pool.score }
        : pool,
    );
    const pairCompletion = selectPairCompletionPools(
      admittedRuntime,
      loadPoolUniverse(pairCompletionFile, { maxPools: 0, minScore: 1 }),
    );
    const completed = mergePoolRegistries(admittedRuntime, pairCompletion);
    assert(completed.length === 3, `pair-completion should append one alternate, got ${completed.length}`);
    assert(completed.some((pool) => pool.address === pairAAlt), "pair-completion should append pairA score-3 alternate");
    assert(!completed.some((pool) => pool.address === pairCAlt), "pair-completion should not append unadmitted pairC");
    console.log("[pool-universe] pair-completion alternate admission: PASS");

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
          poolId: CFG_V4_POOL_ID,
          currency0: poolAddress(0),
          currency1: poolAddress(0xc005),
          fee: 10001,
          tickSpacing: 200,
          hooks: poolAddress(0),
          score: 1,
        },
        {
          address: v4PoolManager,
          adapter: "univ4",
          poolId: CFG_V4_POOL_ID,
          currency0: poolAddress(0),
          currency1: poolAddress(0xc005),
          fee: 10001,
          tickSpacing: 200,
          hooks: poolAddress(0),
          score: 1,
        },
        {
          address: v4PoolManager,
          adapter: "univ4",
          poolId: OTHER_V4_POOL_ID,
          currency0: poolAddress(0xc001),
          currency1: poolAddress(0xc005),
          fee: 3000,
          tickSpacing: 60,
          hooks: poolAddress(0),
          score: 1,
        },
      ],
    }));
    const withoutForcedV4 = loadPoolUniverse(forceFile, { maxPools: 2, minScore: 1 });
    assert(
      !withoutForcedV4.some((pool) => pool.poolId === CFG_V4_POOL_ID),
      "low-score v4 pool should be absent without forceInclude",
    );
    console.log("[pool-universe] forceInclude v4 poolId baseline absent: PASS");

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => { warnings.push(String(message)); };
    let forced: ReturnType<typeof loadPoolUniverse> = [];
    try {
      forced = loadPoolUniverse(forceFile, {
        maxPools: 2,
        minScore: 5,
        forceInclude: [belowCut.toLowerCase(), scoreless],
      });
    } finally {
      console.warn = originalWarn;
    }
    assert(forced.length === 4, `forceInclude should append two non-v4 pools, got ${forced.length}`);
    assert(forced.some((pool) => pool.address === belowCut), "forceInclude should promote below-cut pool");
    assert(forced.some((pool) => pool.address === scoreless), "forceInclude should promote scoreless pool");
    assert(
      warnings.every((line) => !line.includes("forceInclude skipped univ4 entry")),
      "non-v4 forceInclude should not warn about v4 entries",
    );
    console.log("[pool-universe] forceInclude minScore-bypass non-v4: PASS");

    const v4Warnings: string[] = [];
    console.warn = (message?: unknown) => { v4Warnings.push(String(message)); };
    let forcedV4: ReturnType<typeof loadPoolUniverse> = [];
    try {
      forcedV4 = loadPoolUniverse(forceFile, {
        maxPools: 2,
        minScore: 1,
        forceInclude: [CFG_V4_POOL_ID, "0x" + CFG_V4_POOL_ID.slice(2).toUpperCase(), OTHER_V4_POOL_ID],
      });
    } finally {
      console.warn = originalWarn;
    }
    const cfgV4Matches = forcedV4.filter((pool) => pool.poolId?.toLowerCase() === CFG_V4_POOL_ID);
    const otherV4Matches = forcedV4.filter((pool) => pool.poolId?.toLowerCase() === OTHER_V4_POOL_ID);
    assert(cfgV4Matches.length === 1, `forceInclude should dedup same v4 poolId, got ${cfgV4Matches.length}`);
    assert(otherV4Matches.length === 1, `forceInclude should include distinct v4 poolId, got ${otherV4Matches.length}`);
    assert(
      cfgV4Matches[0].address === v4PoolManager && cfgV4Matches[0].adapter === "univ4",
      "forceInclude should promote v4 entry by poolId",
    );
    assert(
      v4Warnings.every((line) => !line.includes("forceInclude skipped univ4 entry")),
      "v4 poolId forceInclude should not warn about address ambiguity",
    );
    console.log("[pool-universe] forceInclude v4 poolId admission/dedup: PASS");

    const addressOnlyWarnings: string[] = [];
    console.warn = (message?: unknown) => { addressOnlyWarnings.push(String(message)); };
    let forcedV4Address: ReturnType<typeof loadPoolUniverse> = [];
    try {
      forcedV4Address = loadPoolUniverse(forceFile, {
        maxPools: 2,
        minScore: 1,
        forceInclude: [v4PoolManager],
      });
    } finally {
      console.warn = originalWarn;
    }
    assert(
      !forcedV4Address.some((pool) => pool.address === v4PoolManager),
      "v4 address forceInclude should skip ambiguous PoolManager identity",
    );
    assert(
      addressOnlyWarnings.some((line) => line.includes("forceInclude skipped univ4 entry")),
      "v4 address forceInclude should warn about ambiguity",
    );
    console.log("[pool-universe] forceInclude v4 address ambiguity skip: PASS");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log("pool-universe PASS (11/11)");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
