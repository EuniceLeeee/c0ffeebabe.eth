import { ethers } from "ethers";
import { MAX_TICK, MIN_TICK, type V3PoolState } from "../../../solver/v3-math.js";
import { sameAddress } from "./codec.js";
import type { UniV3Descriptor } from "./types.js";
import { PANCAKE_V3_FACTORY, UNIV3_CANONICAL_FACTORY } from "../univ3-abi.js";

// Mainnet ParaSwap read-only infrastructure; factory.getPool binds the result.
// This address is not a factory/pool admission allowlist.
export const UNIV3_STATE_READER = ethers.getAddress("0x9c764D2e92dA68E4CDfD784B902283A095ff8b63");
export const UNIV3_STATE_WORD_RADIUS = 24;
function stateInterface(feeProtocolType: "uint8" | "uint32") {
  return new ethers.Interface([
    `function getFullStateWithRelativeBitmaps(address factory,address tokenIn,address tokenOut,uint24 fee,int16 leftBitmapAmount,int16 rightBitmapAmount) view returns ((address pool,uint256 blockTimestamp,(uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,${feeProtocolType} feeProtocol,bool unlocked) slot0,uint128 liquidity,int24 tickSpacing,uint128 maxLiquidityPerTick,(uint32 blockTimestamp,int56 tickCumulative,uint160 secondsPerLiquidityCumulativeX128,bool initialized) observation,(int16 index,uint256 value)[] tickBitmap,(int24 index,(uint128 liquidityGross,int128 liquidityNet,int56 tickCumulativeOutside,uint160 secondsPerLiquidityOutsideX128,uint32 secondsOutside,bool initialized) value)[] ticks) state)`,
  ]);
}
export const UNIV3_STATE_READER_INTERFACE = stateInterface("uint8");
export const PANCAKE_V3_STATE_READER = ethers.getAddress("0x80898f80cFA3Fa3AbF410d90e69aDc432AE5D4c2");
export const PANCAKE_V3_STATE_READER_INTERFACE = stateInterface("uint32");
const UNI_READER = Object.freeze({ address: UNIV3_STATE_READER, iface: UNIV3_STATE_READER_INTERFACE });
const PANCAKE_READER = Object.freeze({ address: PANCAKE_V3_STATE_READER, iface: PANCAKE_V3_STATE_READER_INTERFACE });

/** Infrastructure compatibility, never admission. Other reverse-verified
 * factories keep the existing direct TickLens state path. */
export function resolveUniV3StateReader(descriptor: UniV3Descriptor) {
  const factory = descriptor.factoryBinding.factory;
  if (sameAddress(factory, UNIV3_CANONICAL_FACTORY)) return UNI_READER;
  if (sameAddress(factory, PANCAKE_V3_FACTORY)) return PANCAKE_READER;
  return null;
}

export function uniV3StateRequestData(descriptor: UniV3Descriptor): string {
  const reader = resolveUniV3StateReader(descriptor);
  if (reader === null) throw new Error("univ3 state reader compatibility unavailable");
  return reader.iface.encodeFunctionData("getFullStateWithRelativeBitmaps", [
    descriptor.factoryBinding.factory, descriptor.token0, descriptor.token1, descriptor.fee,
    // The deployed helper truncates signed tick/spacing. One extra left word
    // covers the floor-rounded window even at negative word boundaries. Decode
    // retains exactly the original 49 words, not an enlarged quote range.
    UNIV3_STATE_WORD_RADIUS + 1, UNIV3_STATE_WORD_RADIUS,
  ]);
}

/** Decode a complete sparse response; absent words are zero only inside its
 * source-bound requested range. Missing/extra tick bits are malformed state. */
export function readUniV3State(data: string, descriptor: UniV3Descriptor): V3PoolState {
  const reader = resolveUniV3StateReader(descriptor);
  if (reader === null) throw new Error("univ3 state reader compatibility unavailable");
  const decoded = reader.iface.decodeFunctionResult("getFullStateWithRelativeBitmaps", data);
  if (reader.iface.encodeFunctionResult("getFullStateWithRelativeBitmaps", decoded).toLowerCase() !== data.toLowerCase()) {
    throw new Error("univ3 non-canonical pool state");
  }
  const raw = decoded[0];
  const tick = Number(raw.slot0.tick), spacing = Number(raw.tickSpacing);
  if (!sameAddress(raw.pool, descriptor.pool) || !sameAddress(raw.pool, descriptor.factoryBinding.reversePool)) {
    throw new Error("univ3 pool state belongs to a foreign pool");
  }
  if (!Number.isSafeInteger(tick) || tick < MIN_TICK || tick > MAX_TICK ||
      !Number.isSafeInteger(spacing) || spacing <= 0 || spacing !== descriptor.tickSpacing) {
    throw new Error("univ3 invalid state tick/spacing");
  }
  const readerCenter = Math.trunc(tick / spacing) >> 8;
  const firstReadWord = readerCenter - UNIV3_STATE_WORD_RADIUS - 1;
  const lastReadWord = readerCenter + UNIV3_STATE_WORD_RADIUS;
  const center = Math.floor(tick / spacing) >> 8;
  const firstWord = center - UNIV3_STATE_WORD_RADIUS, lastWord = center + UNIV3_STATE_WORD_RADIUS;
  const bitmaps = new Map<number, bigint>();
  for (const entry of raw.tickBitmap) {
    const word = Number(entry.index), value = BigInt(entry.value);
    if (word < firstReadWord || word > lastReadWord || value === 0n || bitmaps.has(word)) {
      throw new Error("univ3 duplicate or out-of-range bitmap");
    }
    bitmaps.set(word, value);
  }
  const populatedBits = new Map<number, bigint>();
  const allTicks = new Set<number>(), ticks = new Map<number, bigint>();
  for (const entry of raw.ticks) {
    const tk = Number(entry.index), net = BigInt(entry.value.liquidityNet), gross = BigInt(entry.value.liquidityGross);
    const compressed = Math.floor(tk / spacing), word = compressed >> 8;
    if (tk < MIN_TICK || tk > MAX_TICK || tk % spacing !== 0 || allTicks.has(tk) ||
        !entry.value.initialized || gross <= 0n || net > gross || -net > gross ||
        word < firstReadWord || word > lastReadWord) {
      throw new Error("univ3 invalid initialized tick");
    }
    allTicks.add(tk);
    const bit = 1n << BigInt(((compressed % 256) + 256) % 256);
    if (((bitmaps.get(word) ?? 0n) & bit) === 0n) throw new Error("univ3 tick missing matching bitmap bit");
    populatedBits.set(word, (populatedBits.get(word) ?? 0n) | bit);
    if (word >= firstWord && word <= lastWord) ticks.set(tk, net);
  }
  for (const [word, value] of bitmaps) {
    if (populatedBits.get(word) !== value) throw new Error("univ3 incomplete tick bitmap data");
  }
  const tickBitmap = new Map<number, bigint>();
  for (let word = firstWord; word <= lastWord; word++) tickBitmap.set(word, bitmaps.get(word) ?? 0n);
  return { sqrtPriceX96: BigInt(raw.slot0.sqrtPriceX96), tick, liquidity: BigInt(raw.liquidity),
    fee: descriptor.fee, tickSpacing: spacing, tickBitmap, ticks };
}
