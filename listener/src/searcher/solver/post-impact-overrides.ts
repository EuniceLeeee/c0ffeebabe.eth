import { ethers } from "ethers";
import { balanceStorageKey } from "./balance-slots.js";
import type { OverlayStateOverride } from "../revm-sim-client.js";
import type {
  PostImpactSeed,
  V2PostImpactSeed,
  V3PostImpactSeed,
  V4PostImpactSeed,
} from "./pool-state-cache.js";

// UniV2 packs reserve0 (uint112) | reserve1 (uint112) | blockTimestampLast (uint32)
// at slot 8 (slots 0-4 are the ERC20 base, 5/6/7 are factory/token0/token1).
const V2_RESERVES_SLOT = 8n;
const V3_SLOT0_SLOT = 0n;
const V3_LIQUIDITY_SLOT = 4n;
// UNVERIFIED against deployed PoolManager storage: v4-core PoolManager inherits
// owner/protocol-fee/ERC6909 storage before `mapping(PoolId => Pool.State) _pools`.
// Keep this single constant evaluator-adjustable if the deployed layout differs.
export const UNIV4_POOLS_BASE_SLOT = 6n;
const V4_SLOT0_OFFSET = 0n;
const V4_LIQUIDITY_OFFSET = 3n;

const UINT112_MAX = (1n << 112n) - 1n;
const UINT128_MAX = (1n << 128n) - 1n;
const UINT160_MAX = (1n << 160n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;
const UINT24_MAX = (1n << 24n) - 1n;

/** Resolves a token's ERC20 balanceOf mapping slot index (null = unknown). */
export type BalanceSlotResolver = (token: string) => Promise<number | null>;

export function postImpactSupportsStateOverrides(post: PostImpactSeed): boolean {
  return post.kind === "v2" || post.kind === "v3" || post.kind === "v4";
}

export async function postImpactStateOverrides(
  post: PostImpactSeed,
  resolveBalanceSlot?: BalanceSlotResolver,
): Promise<OverlayStateOverride[]> {
  if (post.kind === "v2") return v2PostImpactStateOverrides(post, resolveBalanceSlot);
  if (post.kind === "v3") return v3PostImpactStateOverrides(post);
  if (post.kind === "v4") return v4PostImpactStateOverrides(post);
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

export function univ4PoolStateBaseSlot(poolId: string): bigint {
  return BigInt(ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256"], [poolId, UNIV4_POOLS_BASE_SLOT]),
  ));
}

export function packUniv4Slot0(post: V4PostImpactSeed, currentSlot0?: bigint): bigint {
  assertUint(post.sqrtPriceX96, UINT160_MAX, "sqrtPriceX96");
  assertUint(post.liquidity, UINT128_MAX, "liquidity");
  const tick = BigInt.asUintN(24, BigInt(post.tick));
  const protocolFee = checkedField(post.protocolFee ?? 0, 24, "protocolFee");
  const lpFee = checkedField(post.lpFee ?? 0, 24, "lpFee");
  const replaceMask = UINT160_MAX | (UINT24_MAX << 160n);
  const preserved = currentSlot0 === undefined
    ? (protocolFee << 184n) | (lpFee << 208n)
    : currentSlot0 & (UINT256_MAX ^ replaceMask);
  return preserved | post.sqrtPriceX96 | (tick << 160n);
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

function v4PostImpactStateOverrides(post: V4PostImpactSeed): OverlayStateOverride[] {
  const base = univ4PoolStateBaseSlot(post.poolId);
  return [
    {
      address: ethers.getAddress(post.poolManager),
      slot: wordHex(base + V4_SLOT0_OFFSET),
      // No storage reader is available in this override API. This writes the
      // event-exact sqrtPriceX96/tick, the event fee as lpFee when present, and
      // protocolFee=0 unless the caller used packUniv4Slot0(post, currentSlot0).
      value: wordHex(packUniv4Slot0(post)),
    },
    {
      address: ethers.getAddress(post.poolManager),
      slot: wordHex(base + V4_LIQUIDITY_OFFSET),
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
