/**
 * PoolStateCache tick-persistence unit test (no RPC, no anvil).
 *
 * AC-3's wstUSR fixtures are all curve/fluid, so they never exercise quoteV3 —
 * this is the only regression guard for the v3 tick cache. It drives quoteV3
 * with mocked I/O and asserts the lifecycle:
 *   - tick words (heavy TickLens walk) are fetched once, then reused;
 *   - clear() drops slot0/liquidity (re-read next hint) but KEEPS tick words;
 *   - tick words are re-fetched only when the block drifts >= TICK_REFRESH_BLOCKS.
 *
 * Uses default SEARCHER_V3_TICK_REFRESH_BLOCKS (4). Synthetic pool: empty tick
 * words + tiny amountIn, so v3SwapExactInput stays within the current tick and
 * never throws.
 */

import { ethers } from "ethers";
import { PoolStateCache } from "../solver/pool-state-cache.js";
import type { StateBackend } from "../../shared/state/state-backend.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

const TICK_LENS = "0xbfd8137f7d1516D3ea5cA83523914859ec47F573";
const POOL = "0x0000000000000000000000000000000000000c01";
const TOKEN0 = "0x00000000000000000000000000000000000000a0";
const TOKEN1 = "0x00000000000000000000000000000000000000b1";

const poolIface = new ethers.Interface([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 a, uint16 b, uint16 c, uint8 d, bool e)",
  "function liquidity() view returns (uint128)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);
const tickLensIface = new ethers.Interface([
  "function getPopulatedTicksInWord(address pool, int16 tickBitmapIndex) view returns ((int24 tick,int128 liquidityNet,uint128 liquidityGross)[])",
]);

const SQRT_PRICE_1_1 = 1n << 96n; // price 1.0, tick 0

const sel = (sig: string): string => poolIface.getFunction(sig)!.selector;

interface Counts {
  tickLens: number; // TickLens words fetched via mainnetProvider
  slot0: number;
  liquidity: number;
}

function makeMocks(): { state: StateBackend; provider: ethers.JsonRpcProvider; counts: Counts } {
  const counts: Counts = { tickLens: 0, slot0: 0, liquidity: 0 };

  const state = {
    async call(req: { to: string; data: string }): Promise<string> {
      const selector = req.data.slice(0, 10);
      if (selector === sel("slot0")) {
        counts.slot0++;
        return poolIface.encodeFunctionResult("slot0", [SQRT_PRICE_1_1, 0n, 0, 0, 0, 0, false]);
      }
      if (selector === sel("liquidity")) {
        counts.liquidity++;
        return poolIface.encodeFunctionResult("liquidity", [10n ** 18n]);
      }
      if (selector === sel("fee")) return poolIface.encodeFunctionResult("fee", [500]);
      if (selector === sel("tickSpacing")) return poolIface.encodeFunctionResult("tickSpacing", [1]);
      if (selector === sel("token0")) return poolIface.encodeFunctionResult("token0", [TOKEN0]);
      if (selector === sel("token1")) return poolIface.encodeFunctionResult("token1", [TOKEN1]);
      throw new Error(`unexpected state.call selector ${selector}`);
    },
  } as unknown as StateBackend;

  // mainnetProvider used only for TickLens word fetches — return empty words.
  const provider = {
    async call(req: { to: string; data: string; blockTag?: number }): Promise<string> {
      assert(req.to === TICK_LENS, `provider.call to=${req.to} expected TickLens`);
      counts.tickLens++;
      return tickLensIface.encodeFunctionResult("getPopulatedTicksInWord", [[]]);
    },
  } as unknown as ethers.JsonRpcProvider;

  return { state, provider, counts };
}

const AMOUNT = 1000n; // tiny: stays within the current tick, no cross

async function main(): Promise<void> {
  const { state, provider, counts } = makeMocks();
  const cache = new PoolStateCache(provider);

  // ── Hint 1, block 100: first quote warms both ticks and live ──
  cache.setTickBlock(100);
  const out1 = await cache.quoteV3(state, POOL, TOKEN0, TOKEN1, AMOUNT);
  assert(out1 > 0n, `first quote should produce output, got ${out1}`);
  const ticksAfter1 = counts.tickLens;
  assert(ticksAfter1 > 0, `tick words should be fetched on first quote (got ${ticksAfter1})`);
  const liqAfter1 = counts.liquidity;
  assert(liqAfter1 === 1, `liquidity read once on first quote, got ${liqAfter1}`);

  // Second quote, same hint: everything cached, no new I/O.
  const out2 = await cache.quoteV3(state, POOL, TOKEN0, TOKEN1, AMOUNT);
  assert(out2 === out1, `same-hint requote should match: ${out2} vs ${out1}`);
  assert(counts.tickLens === ticksAfter1, `no tick refetch same hint (${counts.tickLens} vs ${ticksAfter1})`);
  assert(counts.liquidity === liqAfter1, `no live refetch same hint (${counts.liquidity})`);
  console.log("[poolcache] same-hint reuse (no refetch): PASS");

  // ── Hint 2, same block: clear() drops live, KEEPS ticks ──
  cache.clear();
  cache.setTickBlock(100);
  await cache.quoteV3(state, POOL, TOKEN0, TOKEN1, AMOUNT);
  assert(counts.tickLens === ticksAfter1, `ticks must survive clear() at same block (${counts.tickLens} vs ${ticksAfter1})`);
  assert(counts.liquidity === liqAfter1 + 1, `live must be re-read after clear() (${counts.liquidity})`);
  console.log("[poolcache] clear() keeps ticks, re-reads live: PASS");

  // ── Hint 3, block within refresh window: still no tick refetch ──
  cache.clear();
  cache.setTickBlock(103); // |103-100| = 3 < 4
  await cache.quoteV3(state, POOL, TOKEN0, TOKEN1, AMOUNT);
  assert(counts.tickLens === ticksAfter1, `ticks reused within refresh window (${counts.tickLens} vs ${ticksAfter1})`);
  console.log("[poolcache] tick reuse within refresh window: PASS");

  // ── Hint 4, block past refresh window: tick words re-fetched ──
  cache.clear();
  cache.setTickBlock(104); // |104-100| = 4 >= 4 → refresh
  await cache.quoteV3(state, POOL, TOKEN0, TOKEN1, AMOUNT);
  assert(counts.tickLens === ticksAfter1 * 2, `ticks re-fetched past refresh window (${counts.tickLens} vs ${ticksAfter1 * 2})`);
  console.log("[poolcache] tick refetch past refresh window: PASS");

  await testV2LocalMath();
  await testSeedFreshnessAndOverlayBypass();
  await testBlockScanReorgClear();

  console.log("pool-state-cache PASS (7/7)");
}

async function testBlockScanReorgClear(): Promise<void> {
  const { state, provider, counts } = makeMocks();
  const cache = new PoolStateCache(provider);
  cache.setTickBlock(100);
  await cache.quoteV3(state, POOL, TOKEN0, TOKEN1, AMOUNT);
  const firstTickReads = counts.tickLens;
  cache.clearBlockScanWarmProgress();
  cache.setTickBlock(100);
  await cache.quoteV3(state, POOL, TOKEN0, TOKEN1, AMOUNT);
  assert(
    counts.tickLens === firstTickReads * 2,
    `canonical reset must discard tick data (${counts.tickLens} vs ${firstTickReads * 2})`,
  );
  console.log("[poolcache] canonical reset drops every block-derived layer: PASS");
}

// ── v2 constant-product: warm token0+reserves once, reuse, clear() re-warms ──
async function testV2LocalMath(): Promise<void> {
  const v2Iface = new ethers.Interface([
    "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
    "function token0() view returns (address)",
    "function token1() view returns (address)",
  ]);
  const R0 = 2_000_000n;
  const R1 = 1_000_000n;
  let token0Calls = 0;
  let token1Calls = 0;
  let reserveCalls = 0;

  const state = {
    async call(req: { to: string; data: string }): Promise<string> {
      const s = req.data.slice(0, 10);
      if (s === v2Iface.getFunction("token0")!.selector) {
        token0Calls++;
        return v2Iface.encodeFunctionResult("token0", [TOKEN0]);
      }
      if (s === v2Iface.getFunction("token1")!.selector) {
        token1Calls++;
        return v2Iface.encodeFunctionResult("token1", [TOKEN1]);
      }
      if (s === v2Iface.getFunction("getReserves")!.selector) {
        reserveCalls++;
        return v2Iface.encodeFunctionResult("getReserves", [R0, R1, 0]);
      }
      throw new Error(`unexpected v2 state.call selector ${s}`);
    },
  } as unknown as StateBackend;

  const cache = new PoolStateCache();
  const amt = 10_000n;
  const out1 = await cache.quoteV2(state, POOL, TOKEN0, TOKEN1, amt);
  // token0 == TOKEN0 → zeroForOne → reserveIn=R0, reserveOut=R1.
  const fee = amt * 997n;
  const expected = (fee * R1) / (R0 * 1000n + fee);
  assert(out1 === expected, `v2 math: expected ${expected}, got ${out1}`);
  assert(
    token0Calls === 1 && token1Calls === 1 && reserveCalls === 1,
    `v2 warm once: t0=${token0Calls} t1=${token1Calls} r=${reserveCalls}`,
  );

  // Same hint: cached, no new reads.
  const out2 = await cache.quoteV2(state, POOL, TOKEN0, TOKEN1, amt);
  assert(out2 === out1, `v2 requote same hint matches`);
  assert(
    token0Calls === 1 && token1Calls === 1 && reserveCalls === 1,
    `v2 no refetch same hint: t0=${token0Calls} t1=${token1Calls} r=${reserveCalls}`,
  );

  // clear() drops reserves (shift per hint) → re-warm.
  cache.clear();
  await cache.quoteV2(state, POOL, TOKEN0, TOKEN1, amt);
  assert(token0Calls === 2 && token1Calls === 2, `v2 tokens re-read after clear()`);
  assert(reserveCalls === 2, `v2 reserves re-read after clear() (${reserveCalls})`);
  console.log("[poolcache] v2 local math warm-once + clear() re-warm: PASS");
}

async function testSeedFreshnessAndOverlayBypass(): Promise<void> {
  const v2Iface = new ethers.Interface([
    "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
    "function token0() view returns (address)",
    "function token1() view returns (address)",
  ]);
  let token0Calls = 0;
  let token1Calls = 0;
  let reserveCalls = 0;
  const state = {
    async call(req: { to: string; data: string }): Promise<string> {
      const s = req.data.slice(0, 10);
      if (s === v2Iface.getFunction("token0")!.selector) {
        token0Calls++;
        return v2Iface.encodeFunctionResult("token0", [TOKEN0]);
      }
      if (s === v2Iface.getFunction("token1")!.selector) {
        token1Calls++;
        return v2Iface.encodeFunctionResult("token1", [TOKEN1]);
      }
      if (s === v2Iface.getFunction("getReserves")!.selector) {
        reserveCalls++;
        return v2Iface.encodeFunctionResult("getReserves", [4_000_000n, 1_000_000n, 0]);
      }
      throw new Error(`unexpected v2 state.call selector ${s}`);
    },
  } as unknown as StateBackend;

  const cache = new PoolStateCache();
  cache.seedV2({
    pool: POOL,
    token0: TOKEN0,
    token1: TOKEN1,
    reserve0: 2_000_000n,
    reserve1: 1_000_000n,
    feeBps: 30n,
    blockNumber: 100,
  });
  cache.beginHint(100);
  const fromSeed = await cache.quoteV2(state, POOL, TOKEN0, TOKEN1, 10_000n);
  assert(fromSeed > 0n, `seeded v2 quote should work`);
  assert(token0Calls + token1Calls + reserveCalls === 0, `fresh seed should avoid state calls`);

  cache.beginHint(101);
  const fromState = await cache.quoteV2(state, POOL, TOKEN0, TOKEN1, 10_000n);
  assert(fromState > 0n, `stale seed should re-warm from state`);
  assert(
    token0Calls === 1 && token1Calls === 1 && reserveCalls === 1,
    `stale seed must re-read mutable state: t0=${token0Calls} t1=${token1Calls} r=${reserveCalls}`,
  );

  cache.seedV2({
    pool: POOL,
    token0: TOKEN0,
    token1: TOKEN1,
    reserve0: 2_000_000n,
    reserve1: 1_000_000n,
    feeBps: 30n,
    blockNumber: 102,
  });
  cache.beginHint(102, [POOL]);
  let bypassed = false;
  try {
    await cache.quoteV2(state, POOL, TOKEN0, TOKEN1, 10_000n);
  } catch (err) {
    bypassed = err instanceof Error && err.message.includes("overlay-only");
  }
  assert(bypassed, `impact pool must bypass block seed and read overlay through caller fallback`);
  console.log("[poolcache] seed freshness + overlay bypass: PASS");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
