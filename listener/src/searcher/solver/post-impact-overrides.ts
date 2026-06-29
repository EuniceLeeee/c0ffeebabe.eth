import { ethers } from "ethers";
import { balanceStorageKey } from "./balance-slots.js";
import type { OverlayStateOverride } from "../revm-sim-client.js";
import type { PostImpactSeed, V2PostImpactSeed, V3PostImpactSeed } from "./pool-state-cache.js";

// UniV2 packs reserve0 (uint112) | reserve1 (uint112) | blockTimestampLast (uint32)
// at slot 8 (slots 0-4 are the ERC20 base, 5/6/7 are factory/token0/token1).
const V2_RESERVES_SLOT = 8n;
const V3_SLOT0_SLOT = 0n;
const V3_LIQUIDITY_SLOT = 4n;

const UINT112_MAX = (1n << 112n) - 1n;
const UINT128_MAX = (1n << 128n) - 1n;
const UINT160_MAX = (1n << 160n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;

/** Resolves a token's ERC20 balanceOf mapping slot index (null = unknown). */
export type BalanceSlotResolver = (token: string) => Promise<number | null>;

export function postImpactSupportsStateOverrides(post: PostImpactSeed): boolean {
  return post.kind === "v2" || post.kind === "v3";
}

export async function postImpactStateOverrides(
  post: PostImpactSeed,
  resolveBalanceSlot?: BalanceSlotResolver,
): Promise<OverlayStateOverride[]> {
  if (post.kind === "v2") return v2PostImpactStateOverrides(post, resolveBalanceSlot);
  if (post.kind === "v3") return v3PostImpactStateOverrides(post);
  return [];
}

export function packUniv2ReservesSlot(post: V2PostImpactSeed): bigint {
  assertUint(post.reserve0, UINT112_MAX, "reserve0");
  assertUint(post.reserve1, UINT112_MAX, "reserve1");
  const timestamp = BigInt(post.blockTimestampLast ?? 0) & ((1n << 32n) - 1n);
  return post.reserve0 | (post.reserve1 << 112n) | (timestamp << 224n);
}

export function packUniv3Slot0(post: V3PostImpactSeed): bigint {
  assertUint(post.sqrtPriceX96, UINT160_MAX, "sqrtPriceX96");
  assertUint(post.liquidity, UINT128_MAX, "liquidity");
  const tick = BigInt.asUintN(24, BigInt(post.tick));
  const observationIndex = checkedField(post.observationIndex ?? 0, 16, "observationIndex");
  const observationCardinality = checkedField(post.observationCardinality ?? 0, 16, "observationCardinality");
  const observationCardinalityNext = checkedField(
    post.observationCardinalityNext ?? 0,
    16,
    "observationCardinalityNext",
  );
  const feeProtocol = checkedField(post.feeProtocol ?? 0, 8, "feeProtocol");
  const unlocked = post.unlocked ?? true ? 1n : 0n;

  return post.sqrtPriceX96 |
    (tick << 160n) |
    (observationIndex << 184n) |
    (observationCardinality << 200n) |
    (observationCardinalityNext << 216n) |
    (feeProtocol << 232n) |
    (unlocked << 240n);
}

async function v2PostImpactStateOverrides(
  post: V2PostImpactSeed,
  resolveBalanceSlot?: BalanceSlotResolver,
): Promise<OverlayStateOverride[]> {
  // UniV2 swap() reads BOTH the packed reserves (slot 8) AND token.balanceOf(pair)
  // (amountIn = balance - reserve, plus the K check). _update syncs reserve ==
  // balanceOf(pair) after every swap, so the post-victim balances equal the post
  // reserves. Override all three or the sim runs against an inconsistent state.
  if (!resolveBalanceSlot) return [];
  const slot0 = await resolveBalanceSlot(post.token0);
  const slot1 = await resolveBalanceSlot(post.token1);
  if (slot0 === null || slot1 === null) return []; // probe failed → caller uses cold overlay
  return [
    {
      address: ethers.getAddress(post.pool),
      slot: wordHex(V2_RESERVES_SLOT),
      value: wordHex(packUniv2ReservesSlot(post)),
    },
    {
      address: ethers.getAddress(post.token0),
      slot: balanceStorageKey(post.pool, slot0),
      value: wordHex(post.reserve0),
    },
    {
      address: ethers.getAddress(post.token1),
      slot: balanceStorageKey(post.pool, slot1),
      value: wordHex(post.reserve1),
    },
  ];
}

function v3PostImpactStateOverrides(post: V3PostImpactSeed): OverlayStateOverride[] {
  return [
    {
      address: ethers.getAddress(post.pool),
      slot: wordHex(V3_SLOT0_SLOT),
      value: wordHex(packUniv3Slot0(post)),
    },
    {
      address: ethers.getAddress(post.pool),
      slot: wordHex(V3_LIQUIDITY_SLOT),
      value: wordHex(post.liquidity),
    },
  ];
}

function checkedField(value: number, bits: number, label: string): bigint {
  if (!Number.isInteger(value) || value < 0 || value >= 2 ** bits) {
    throw new Error(`${label} out of uint${bits} range: ${value}`);
  }
  return BigInt(value);
}

function assertUint(value: bigint, max: bigint, label: string): void {
  if (value < 0n || value > max) {
    throw new Error(`${label} out of range: ${value}`);
  }
}

function wordHex(value: bigint): string {
  assertUint(value, UINT256_MAX, "storage word");
  return ethers.toBeHex(value, 32);
}
