/**
 * Deterministic block-scan scanner tests.
 * Pure in-memory: no RPC, no anvil.
 */

import { ADDR } from "../../shared/constants/addresses.js";
import { cycleFingerprint } from "../detector/cycle-fingerprint.js";
import { detectBlockScanOpportunities, type BlockScanConfig, type ProtocolMid } from "../detector/blockscan-scanner.js";
import type { BlockScanOpportunity } from "../detector/detector.js";
import type { TokenEdge } from "../planner/token-graph.js";
import { PoolStateCache } from "../solver/pool-state-cache.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

type TestCase = {
  name: string;
  run: () => void;
};

const BLOCK = 25_455_296;
const UNIT = 10n ** 18n;
const WETH = ADDR.WETH.toLowerCase();
const USDC = ADDR.USDC.toLowerCase();
const USDT = ADDR.USDT.toLowerCase();
const P1 = "0x0000000000000000000000000000000000000101";
const P2 = "0x0000000000000000000000000000000000000102";
const P3 = "0x0000000000000000000000000000000000000103";
const P4 = "0x0000000000000000000000000000000000000104";
const P5 = "0x0000000000000000000000000000000000000105";
const P6 = "0x0000000000000000000000000000000000000106";
const P7 = "0x0000000000000000000000000000000000000107";
const P8 = "0x0000000000000000000000000000000000000108";
const P9 = "0x0000000000000000000000000000000000000109";
const Q96 = 1n << 96n;

function cfg(overrides: Partial<BlockScanConfig> = {}): BlockScanConfig {
  return {
    maxHops: 4,
    minSpreadBps: 10,
    maxCandidates: 8,
    budgetMs: 2_000,
    pricedTokens: new Map([[WETH, { maxBorrow: 10_000n * UNIT }]]),
    ...overrides,
  };
}

function swap(tokenIn: string, tokenOut: string, pool: string, adapterId = "univ2-swap"): TokenEdge {
  return {
    adapterId,
    target: pool,
    tokenIn,
    tokenOut,
    slotKind: "swap",
    ...deriveEdgeTaxonomy("swap"),
    score: 100,
  };
}

function lend(tokenIn: string, tokenOut: string, pool: string, adapterId = "univ2-lend"): TokenEdge {
  return {
    adapterId,
    target: pool,
    tokenIn,
    tokenOut,
    slotKind: "lend",
    ...deriveEdgeTaxonomy("lend"),
    score: 100,
  };
}

function protocol(
  tokenIn: string,
  tokenOut: string,
  pool: string,
  adapterId: "erc4626-deposit" | "erc4626-redeem",
  protocolAction: "wrap" | "redeem",
): TokenEdge {
  return {
    adapterId,
    target: pool,
    tokenIn,
    tokenOut,
    slotKind: "protocol",
    protocolAction,
    ...deriveEdgeTaxonomy("protocol", protocolAction),
    score: 100,
  };
}

function venueEdges(token: string, pool: string, adapterId = "univ2-swap"): TokenEdge[] {
  return [
    swap(token, WETH, pool, adapterId),
    swap(WETH, token, pool, adapterId),
  ];
}

function fluidVenueEdges(token: string, pool: string): TokenEdge[] {
  return [
    { ...swap(token, WETH, pool, "fluid-dex-swap"), poolToken0: token, poolToken1: WETH },
    { ...swap(WETH, token, pool, "fluid-dex-swap"), poolToken0: token, poolToken1: WETH },
  ];
}

function seedV2(cache: PoolStateCache, pool: string, token: string, tokenReserve: bigint, wethReserve: bigint): void {
  cache.seedV2({
    pool,
    token0: token,
    token1: WETH,
    reserve0: tokenReserve,
    reserve1: wethReserve,
    blockNumber: BLOCK,
  });
}

function seedV2Pair(
  cache: PoolStateCache,
  pool: string,
  token0: string,
  token1: string,
  reserve0: bigint,
  reserve1: bigint,
): void {
  cache.seedV2({
    pool,
    token0,
    token1,
    reserve0,
    reserve1,
    blockNumber: BLOCK,
  });
}

function seedV3(cache: PoolStateCache, pool: string, token: string, midWethPerToken: number): void {
  cache.seedV3Ticks({
    pool,
    token0: token,
    token1: WETH,
    fee: 3_000n,
    tickSpacing: 60,
    tickBitmap: new Map([[0, 0n], [-1, 0n]]),
    ticks: new Map(),
    blockNumber: BLOCK,
  });
  cache.seedV3Live({
    pool,
    sqrtPriceX96: sqrtPriceX96FromMid(midWethPerToken),
    tick: 0,
    liquidity: 10_000_000n * UNIT,
    blockNumber: BLOCK,
  });
}

function sqrtPriceX96FromMid(mid: number): bigint {
  return BigInt(Math.floor(Math.sqrt(mid) * Number(Q96)));
}

function run(edges: TokenEdge[], cache: PoolStateCache, overrides: Partial<BlockScanConfig> = {}, touched: Set<string> | null = null) {
  return detectBlockScanOpportunities({
    edges,
    cache,
    sourceBlock: BLOCK,
    swapTouched: touched,
    cfg: cfg(overrides),
  });
}

function mainAnchor(): { cache: PoolStateCache; edges: TokenEdge[] } {
  const cache = new PoolStateCache();
  seedV2(cache, P1, USDC, 2_000_000n * UNIT, 1_000n * UNIT);
  seedV3(cache, P2, USDC, 0.00055);
  return { cache, edges: [...venueEdges(USDC, P1), ...venueEdges(USDC, P2, "univ3-swap")] };
}

function pairEdges(token0: string, token1: string, pool: string): TokenEdge[] {
  return [
    swap(token0, token1, pool),
    swap(token1, token0, pool),
  ];
}

function erc4626Edges(underlying: string, vault: string): TokenEdge[] {
  return [
    protocol(underlying, vault, vault, "erc4626-deposit", "wrap"),
    protocol(vault, underlying, vault, "erc4626-redeem", "redeem"),
  ];
}

function protocolKey(pool: string, tokenIn: string, tokenOut: string): string {
  return `${pool.toLowerCase()}|${tokenIn.toLowerCase()}|${tokenOut.toLowerCase()}`;
}

function navProtocolMids(underlying: string, vault: string, redeemMid: number): ReadonlyMap<string, ProtocolMid> {
  return new Map<string, ProtocolMid>([
    [protocolKey(vault, underlying, vault), { mid: 1 / redeemMid, feeBps: 0, depthIn: 10_000_000n * UNIT }],
    [protocolKey(vault, vault, underlying), { mid: redeemMid, feeBps: 0, depthIn: 10_000_000n * UNIT }],
  ]);
}

function fluidMid(pool: string, token: string, midWethPerToken: number): ReadonlyMap<string, ProtocolMid> {
  return new Map<string, ProtocolMid>([
    [protocolKey(pool, token, WETH), { mid: midWethPerToken, feeBps: 0, depthIn: 10_000_000n * UNIT }],
  ]);
}

function navFixture(redeemMid: number): {
  cache: PoolStateCache;
  edges: TokenEdge[];
  protocolMids: ReadonlyMap<string, ProtocolMid>;
  underlying: string;
  vault: string;
} {
  const cache = new PoolStateCache();
  const underlying = tokenAt(60);
  const vault = tokenAt(61);
  seedV2Pair(cache, P8, vault, USDT, 1_000_000n * UNIT, 1_000_000n * UNIT);
  seedV2Pair(cache, P9, underlying, USDT, 1_000_000n * UNIT, 1_000_000n * UNIT);
  return {
    cache,
    edges: [...erc4626Edges(underlying, vault), ...pairEdges(vault, USDT, P8), ...pairEdges(underlying, USDT, P9)],
    protocolMids: navProtocolMids(underlying, vault, redeemMid),
    underlying,
    vault,
  };
}

function addWethAnchor(cache: PoolStateCache, edges: TokenEdge[]): void {
  seedV2(cache, P6, USDC, 2_000_000n * UNIT, 1_000n * UNIT);
  seedV2(cache, P7, USDC, 2_000_000n * UNIT, 1_040n * UNIT);
  edges.push(...venueEdges(USDC, P6), ...venueEdges(USDC, P7));
}

function triangleFixture(profitable: boolean): { cache: PoolStateCache; edges: TokenEdge[]; ringPools: string[] } {
  const cache = new PoolStateCache();
  const edges: TokenEdge[] = [];
  const a = tokenAt(20);
  const b = tokenAt(21);
  addWethAnchor(cache, edges);
  seedV2Pair(cache, P1, WETH, a, 1_000n * UNIT, 1_200n * UNIT);
  seedV2Pair(cache, P2, a, b, 1_000n * UNIT, 1_000n * UNIT);
  seedV2Pair(cache, P3, b, WETH, 1_000n * UNIT, (profitable ? 860n : 833n) * UNIT);
  edges.push(...pairEdges(WETH, a, P1), ...pairEdges(a, b, P2), ...pairEdges(b, WETH, P3));
  return { cache, edges, ringPools: [P1, P2, P3] };
}

function assertMainAnchor(opp: BlockScanOpportunity): void {
  assert(opp.kind === "block-scan-arb", "opportunity kind");
  assert(opp.seedEdges.length === 2, "seed edge count");
  assert(opp.seedEdges[0].tokenIn.toLowerCase() === WETH, "first edge starts in WETH");
  assert(opp.seedEdges[0].tokenOut.toLowerCase() === USDC, "first edge buys USDC");
  assert(opp.seedEdges[0].target.toLowerCase() === P1, "first edge uses cheap venue");
  assert(opp.seedEdges[1].tokenIn.toLowerCase() === USDC, "second edge sells USDC");
  assert(opp.seedEdges[1].tokenOut.toLowerCase() === WETH, "second edge ends in WETH");
  assert(opp.seedEdges[1].target.toLowerCase() === P2, "second edge uses rich venue");
  assert(opp.flashToken === WETH, "flashToken is WETH");
  assert(opp.searchSeed.startToken === WETH, "search seed startToken is WETH");
  assert(opp.searchSeed.searchCenter > 8n, "search center is usable");
  assert(opp.searchSeed.maxInput >= opp.searchSeed.searchCenter, "max input covers search center");
}

const tests: TestCase[] = [
  {
    name: "anchor found",
    run: () => {
      const { cache, edges } = mainAnchor();
      const outcome = run(edges, cache);
      assert(outcome.outcome === "ran", "scanner should run");
      assert(outcome.opportunities.length === 1, `expected one opportunity, got ${outcome.opportunities.length}`);
      assertMainAnchor(outcome.opportunities[0]);
      console.log("[blockscan-scanner] anchor found: PASS");
    },
  },
  {
    name: "no-spread control",
    run: () => {
      const cache = new PoolStateCache();
      seedV2(cache, P1, USDC, 2_000_000n * UNIT, 1_000n * UNIT);
      seedV2(cache, P2, USDC, 2_000_000n * UNIT, 1_002n * UNIT);
      const outcome = run([...venueEdges(USDC, P1), ...venueEdges(USDC, P2)], cache);
      assert(outcome.opportunities.length === 0, "fee-adjusted near-equal mids should not emit");
      console.log("[blockscan-scanner] no-spread control: PASS");
    },
  },
  {
    name: "single venue",
    run: () => {
      const cache = new PoolStateCache();
      seedV2(cache, P1, USDC, 2_000_000n * UNIT, 1_000n * UNIT);
      const outcome = run(venueEdges(USDC, P1), cache);
      assert(outcome.opportunities.length === 0, "single venue should not emit");
      console.log("[blockscan-scanner] single venue: PASS");
    },
  },
  {
    name: "delta-restrict",
    run: () => {
      const { cache, edges } = mainAnchor();
      const gatedOut = run(edges, cache, {}, new Set([P3]));
      assert(gatedOut.opportunities.length === 0, "untouched anchor should be filtered");
      assert(gatedOut.swapTouchedPools === 1, "touched pool count");

      const gatedIn = run(edges, cache, {}, new Set([P1]));
      assert(gatedIn.opportunities.length === 1, "one touched anchor pool should admit the pair");
      assertMainAnchor(gatedIn.opportunities[0]);
      console.log("[blockscan-scanner] delta-restrict: PASS");
    },
  },
  {
    name: "priced-token gate",
    run: () => {
      const { cache, edges } = mainAnchor();
      const outcome = run(edges, cache, { pricedTokens: new Map() });
      assert(outcome.opportunities.length === 0, "unfunded ring should not emit");
      console.log("[blockscan-scanner] priced-token gate: PASS");
    },
  },
  {
    name: "ranking and cap",
    run: () => {
      const cache = new PoolStateCache();
      const edges: TokenEdge[] = [];
      const expectedTop: string[] = [];
      for (let i = 0; i < 5; i++) {
        const token = tokenAt(i);
        const cheapPool = poolAt(i, 0);
        const richPool = poolAt(i, 1);
        seedV2(cache, cheapPool, token, 2_000_000n * UNIT, 1_000n * UNIT);
        seedV2(cache, richPool, token, 2_000_000n * UNIT, BigInt(1_040 + i * 10) * UNIT);
        edges.push(...venueEdges(token, cheapPool), ...venueEdges(token, richPool));
      }
      for (let i = 4; i >= 2; i--) expectedTop.push(tokenAt(i));

      const outcome = run(edges, cache, { maxCandidates: 3 });
      assert(outcome.opportunities.length === 3, `cap expected 3, got ${outcome.opportunities.length}`);
      const actualTop = outcome.opportunities.map((opp) => opp.seedEdges[0].tokenOut.toLowerCase());
      assert(
        actualTop.join(",") === expectedTop.join(","),
        `ranking expected ${expectedTop.join(",")}, got ${actualTop.join(",")}`,
      );
      console.log("[blockscan-scanner] ranking and cap: PASS");
    },
  },
  {
    name: "cycleFingerprint set",
    run: () => {
      const { cache, edges } = mainAnchor();
      const outcome = run(edges, cache);
      const opp = outcome.opportunities[0];
      assert(opp.cycleFingerprint === cycleFingerprint(BLOCK, [WETH, USDC]), "cycle fingerprint");
      console.log("[blockscan-scanner] cycleFingerprint set: PASS");
    },
  },
  {
    name: "3-hop cycle found",
    run: () => {
      const { cache, edges, ringPools } = triangleFixture(true);
      const outcome = run(edges, cache);
      const rings = outcome.opportunities.filter((opp) => opp.seedEdges.length === 3);
      assert(rings.length === 1, `expected one 3-hop ring, got ${rings.length}`);
      const ring = rings[0];
      assert(ring.seedEdges[0].tokenIn.toLowerCase() === WETH, "3-hop ring starts at WETH");
      assert(ring.seedEdges[2].tokenOut.toLowerCase() === WETH, "3-hop ring ends at WETH");
      const actualPools = [...new Set(ring.seedEdges.map((edge) => edge.target.toLowerCase()))].sort();
      assert(actualPools.join(",") === ringPools.sort().join(","), "3-hop ring pools");
      assert(ring.searchSeed.searchCenter > 8n, "3-hop ring search center is usable");
      console.log("[blockscan-scanner] 3-hop cycle found: PASS");
    },
  },
  {
    name: "unprofitable-cycle control",
    run: () => {
      const { cache, edges, ringPools } = triangleFixture(false);
      const outcome = run(edges, cache);
      const ringPoolKey = ringPools.sort().join(",");
      const falsePositive = outcome.opportunities.some((opp) => {
        if (opp.seedEdges.length !== 3) return false;
        const pools = [...new Set(opp.seedEdges.map((edge) => edge.target.toLowerCase()))].sort();
        return pools.join(",") === ringPoolKey;
      });
      assert(!falsePositive, "unprofitable 3-hop ring should not emit");
      console.log("[blockscan-scanner] unprofitable-cycle control: PASS");
    },
  },
  {
    name: "cycleFingerprint dedup",
    run: () => {
      const { cache, edges } = triangleFixture(true);
      const outcome = run(edges, cache);
      const seen = new Set<string>();
      for (const opp of outcome.opportunities) {
        assert(!seen.has(opp.cycleFingerprint), "duplicate cycleFingerprint");
        seen.add(opp.cycleFingerprint);
      }
      console.log("[blockscan-scanner] cycleFingerprint dedup: PASS");
    },
  },
  {
    name: "T-nav-dislocation",
    run: () => {
      const { cache, edges, protocolMids } = navFixture(1.05);
      const outcome = run(edges, cache, {
        pricedTokens: new Map([[USDT, { maxBorrow: 100_000n * UNIT }]]),
        protocolMids,
      });
      const protocolOpp = outcome.opportunities.find((opp) =>
        opp.seedEdges.some((edge) => edge.adapterId === "erc4626-redeem"),
      );
      assert(protocolOpp !== undefined, "expected NAV protocol opportunity");
      assert(protocolOpp.leavesStandingPosition === false, "NAV opportunity should not leave a standing position");
      assert(protocolOpp.searchSeed.searchCenter > 8n, "NAV search center is usable");
      assert(protocolOpp.flashToken === USDT, "NAV flashToken is USDT");
      assert(protocolOpp.seedEdges[0].tokenIn.toLowerCase() === USDT, "NAV ring starts at USDT");
      assert(
        protocolOpp.seedEdges[protocolOpp.seedEdges.length - 1].tokenOut.toLowerCase() === USDT,
        "NAV ring closes at USDT",
      );
      console.log("[blockscan-scanner] T-nav-dislocation: PASS");
    },
  },
  {
    name: "T-fluid-mid-flip",
    run: () => {
      const cache = new PoolStateCache();
      const token = tokenAt(90);
      const v2Pool = poolAt(90, 0);
      const fluidPool = poolAt(90, 1);
      const edges = [...venueEdges(token, v2Pool), ...fluidVenueEdges(token, fluidPool)];
      seedV2(cache, v2Pool, token, 2_000_000n * UNIT, 1_000n * UNIT);

      const noMid = run(edges, cache);
      assert(noMid.opportunities.length === 0, "missing Fluid mid should not emit a Fluid candidate");
      assert(noMid.debug?.skippedVenues === 1, `expected one skipped Fluid venue, got ${noMid.debug?.skippedVenues}`);

      const withMid = run(edges, cache, { protocolMids: fluidMid(fluidPool, token, 0.00056) });
      const fluidOpp = withMid.opportunities.find((opp) =>
        opp.seedEdges.some((edge) => edge.adapterId === "fluid-dex-swap"),
      );
      assert(fluidOpp !== undefined, "supplied Fluid mid should emit a candidate through Fluid DEX");
      assert(fluidOpp.searchSeed.searchCenter > 8n, "Fluid candidate search center is usable");
      console.log("[blockscan-scanner] T-fluid-mid-flip: PASS");
    },
  },
  {
    name: "T-nav-par control",
    run: () => {
      const { cache, edges, protocolMids } = navFixture(1.00);
      const outcome = run(edges, cache, {
        pricedTokens: new Map([[USDT, { maxBorrow: 100_000n * UNIT }]]),
        protocolMids,
      });
      const protocolOpp = outcome.opportunities.some((opp) =>
        opp.seedEdges.some((edge) => edge.slotKind === "protocol"),
      );
      assert(!protocolOpp, "par NAV protocol ring should not emit");
      console.log("[blockscan-scanner] T-nav-par control: PASS");
    },
  },
  {
    name: "T-standing-ring-rejected",
    run: () => {
      const cache = new PoolStateCache();
      const edges: TokenEdge[] = [];
      const a = tokenAt(70);
      const b = tokenAt(71);
      addWethAnchor(cache, edges);
      seedV2Pair(cache, P1, WETH, a, 1_000n * UNIT, 1_200n * UNIT);
      seedV2Pair(cache, P2, a, b, 1_000n * UNIT, 1_000n * UNIT);
      seedV2Pair(cache, P3, b, WETH, 1_000n * UNIT, 1_000n * UNIT);
      edges.push(...pairEdges(WETH, a, P1), lend(a, b, P2), ...pairEdges(b, WETH, P3));
      const outcome = run(edges, cache);
      const standingOpp = outcome.opportunities.some((opp) =>
        opp.seedEdges.some((edge) => edge.slotKind === "lend"),
      );
      assert(!standingOpp, "standing-position ring should not emit");
      console.log("[blockscan-scanner] T-standing-ring-rejected: PASS");
    },
  },
  {
    name: "T-missing-protocolMids",
    run: () => {
      const { cache, edges } = mainAnchor();
      const vault = tokenAt(80);
      seedV2Pair(cache, P8, USDC, vault, 1_000_000n * UNIT, 1_000_000n * UNIT);
      edges.push(...pairEdges(USDC, vault, P8), ...erc4626Edges(USDC, vault));
      const outcome = run(edges, cache);
      assert(outcome.opportunities.length === 1, "swap-only opportunity should remain");
      assertMainAnchor(outcome.opportunities[0]);
      assert(
        outcome.opportunities.every((opp) => opp.seedEdges.every((edge) => edge.slotKind !== "protocol")),
        "missing protocol mids should not emit protocol opportunities",
      );
      assert(outcome.debug?.skippedVenues === 1, `expected one skipped protocol venue, got ${outcome.debug?.skippedVenues}`);
      console.log("[blockscan-scanner] T-missing-protocolMids: PASS");
    },
  },
];

function tokenAt(i: number): string {
  return `0x0000000000000000000000000000000000000${(0x200 + i).toString(16).padStart(3, "0")}`;
}

function poolAt(i: number, j: number): string {
  return `0x000000000000000000000000000000000000${(0x300 + i * 2 + j).toString(16).padStart(4, "0")}`;
}

let passed = 0;
for (const test of tests) {
  try {
    test.run();
    passed++;
  } catch (err) {
    console.error(`[blockscan-scanner] ${test.name}: FAIL`);
    console.error(err instanceof Error ? err.message : String(err));
    console.error(`blockscan-scanner FAIL (${passed}/${tests.length})`);
    process.exit(1);
  }
}

console.log(`blockscan-scanner PASS (${passed}/${tests.length})`);
