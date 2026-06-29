import { ethers } from "ethers";
import { balanceStorageKey } from "../solver/balance-slots.js";
import {
  packUniv2ReservesSlot,
  packUniv3Slot0,
  postImpactStateOverrides,
} from "../solver/post-impact-overrides.js";
import type { V2PostImpactSeed } from "../solver/pool-state-cache.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

const POOL = "0x0000000000000000000000000000000000000c01";
const TOKEN0 = "0x00000000000000000000000000000000000000a0";
const TOKEN1 = "0x00000000000000000000000000000000000000b1";

function v2Seed(): V2PostImpactSeed {
  return {
    kind: "v2",
    pool: POOL,
    token0: TOKEN0,
    token1: TOKEN1,
    reserve0: 111n,
    reserve1: 222n,
    blockTimestampLast: 7,
    blockNumber: 123,
  };
}

function testV2Packing(): void {
  const packed = packUniv2ReservesSlot({
    kind: "v2",
    pool: POOL,
    token0: TOKEN0,
    token1: TOKEN1,
    reserve0: 1n,
    reserve1: 2n,
    blockTimestampLast: 3,
    blockNumber: 123,
  });
  assert(packed === (1n | (2n << 112n) | (3n << 224n)), `bad v2 packed word ${packed}`);
  console.log("[post-impact-overrides] v2 reserves packing: PASS");
}

function testV3Packing(): void {
  const packed = packUniv3Slot0({
    kind: "v3",
    pool: POOL,
    sqrtPriceX96: 123n,
    tick: -1,
    liquidity: 456n,
    observationIndex: 2,
    observationCardinality: 3,
    observationCardinalityNext: 4,
    feeProtocol: 5,
    unlocked: true,
    blockNumber: 123,
  });
  const tickMask = (1n << 24n) - 1n;
  assert((packed & ((1n << 160n) - 1n)) === 123n, "sqrtPriceX96 not in low 160 bits");
  assert(((packed >> 160n) & tickMask) === tickMask, "negative tick not two's-complement packed");
  assert(((packed >> 184n) & 0xffffn) === 2n, "observationIndex mismatch");
  assert(((packed >> 200n) & 0xffffn) === 3n, "observationCardinality mismatch");
  assert(((packed >> 216n) & 0xffffn) === 4n, "observationCardinalityNext mismatch");
  assert(((packed >> 232n) & 0xffn) === 5n, "feeProtocol mismatch");
  assert(((packed >> 240n) & 1n) === 1n, "unlocked mismatch");
  console.log("[post-impact-overrides] v3 slot0 packing: PASS");
}

async function testV3OverrideShape(): Promise<void> {
  const overrides = await postImpactStateOverrides({
    kind: "v3",
    pool: POOL,
    sqrtPriceX96: 1n,
    tick: 0,
    liquidity: 2n,
    blockNumber: 123,
  });
  assert(overrides.length === 2, `expected 2 v3 overrides, got ${overrides.length}`);
  assert(overrides[0].slot.endsWith("0".repeat(64)), "v3 slot0 key mismatch");
  assert(overrides[1].slot.endsWith("4".padStart(64, "0")), "v3 liquidity slot key mismatch");
  console.log("[post-impact-overrides] v3 override shape: PASS");
}

async function testV2Overrides(): Promise<void> {
  const post = v2Seed();
  // token0 -> slot 0, token1 -> slot 9 (exercise distinct probed slots).
  const resolver = async (token: string): Promise<number | null> =>
    token.toLowerCase() === TOKEN0 ? 0 : token.toLowerCase() === TOKEN1 ? 9 : null;
  const overrides = await postImpactStateOverrides(post, resolver);
  assert(overrides.length === 3, `expected 3 v2 overrides, got ${overrides.length}`);

  // [0] packed reserves at slot 8.
  assert(ethers.getAddress(overrides[0].address) === ethers.getAddress(POOL), "reserves address");
  assert(overrides[0].slot === ethers.toBeHex(8n, 32), `reserves slot != 8: ${overrides[0].slot}`);
  assert(BigInt(overrides[0].value) === packUniv2ReservesSlot(post), "reserves value");

  // [1] token0.balanceOf(pair) = reserve0 at probed slot 0.
  assert(ethers.getAddress(overrides[1].address) === ethers.getAddress(TOKEN0), "token0 address");
  assert(overrides[1].slot === balanceStorageKey(POOL, 0), "token0 balanceOf key");
  assert(BigInt(overrides[1].value) === post.reserve0, "token0 balance value");

  // [2] token1.balanceOf(pair) = reserve1 at probed slot 9.
  assert(ethers.getAddress(overrides[2].address) === ethers.getAddress(TOKEN1), "token1 address");
  assert(overrides[2].slot === balanceStorageKey(POOL, 9), "token1 balanceOf key");
  assert(BigInt(overrides[2].value) === post.reserve1, "token1 balance value");
  console.log("[post-impact-overrides] v2 overrides (slot 8 + balanceOf): PASS");
}

async function testV2ProbeFail(): Promise<void> {
  const post = v2Seed();
  // Either token's slot unknown → no overrides → caller falls back to cold overlay.
  const missing = await postImpactStateOverrides(post, async () => null);
  assert(missing.length === 0, `probe-fail must yield 0 overrides, got ${missing.length}`);
  const noResolver = await postImpactStateOverrides(post);
  assert(noResolver.length === 0, `missing resolver must yield 0 overrides, got ${noResolver.length}`);
  console.log("[post-impact-overrides] v2 probe-fail -> cold fallback: PASS");
}

async function main(): Promise<void> {
  testV2Packing();
  testV3Packing();
  await testV3OverrideShape();
  await testV2Overrides();
  await testV2ProbeFail();
  console.log("post-impact-overrides PASS (5/5)");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
