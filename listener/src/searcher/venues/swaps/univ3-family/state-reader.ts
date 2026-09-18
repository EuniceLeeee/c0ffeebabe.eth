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
  // This ABI has one dynamic tuple with an 18-word head and two arrays of
  // static tuples (2 words per bitmap, 7 per tick). Validate its exact packed
  // layout and EVERY scalar, including unused observation fields. This is the
  // same canonicality check as decode + re-encode, without ethers Result trees
  // and their repeated copying for large tick arrays. No decoded-state cache.
  const failCanonical = (): never => { throw new Error("univ3 non-canonical pool state"); };
  if (!/^0x[0-9a-fA-F]+$/.test(data) || (data.length - 2) % 64 !== 0) failCanonical();
  const wordCount = (data.length - 2) / 64;
  if (wordCount < 21) failCanonical();
  const uint = (word: number, bits = 256): bigint => {
    if (word >= wordCount) failCanonical();
    const value = BigInt("0x" + data.slice(2 + word * 64, 2 + (word + 1) * 64));
    if (bits !== 256 && value !== BigInt.asUintN(bits, value)) failCanonical();
    return value;
  };
  const sint = (word: number, bits: number): bigint => {
    const value = BigInt.asIntN(256, uint(word));
    if (value !== BigInt.asIntN(bits, value)) failCanonical();
    return value;
  };
  if (uint(0) !== 32n || uint(17) !== 18n * 32n) failCanonical();
  const bitmapCount = uint(19);
  if (bitmapCount > BigInt(Math.floor((wordCount - 21) / 2))) failCanonical();
  const ticksOffset = 20 + 2 * Number(bitmapCount);
  if (uint(18) !== BigInt((ticksOffset - 1) * 32)) failCanonical();
  const tickCount = uint(ticksOffset);
  if (tickCount * 7n !== BigInt(wordCount - ticksOffset - 1)) failCanonical();

  uint(1, 160); // pool address padding
  uint(2); // blockTimestamp
  const sqrtPriceX96 = uint(3, 160), tick = Number(sint(4, 24));
  uint(5, 16); uint(6, 16); uint(7, 16); // observation indices/cardinalities
  uint(8, reader === PANCAKE_READER ? 32 : 8); // feeProtocol
  uint(9, 1); // unlocked bool
  const liquidity = uint(10, 128), spacing = Number(sint(11, 24));
  uint(12, 128); // maxLiquidityPerTick
  uint(13, 32); sint(14, 56); uint(15, 160); uint(16, 1); // observation
  const pool = "0x" + data.slice(2 + 64 + 24, 2 + 2 * 64).toLowerCase();
  if (!sameAddress(pool, descriptor.pool) || !sameAddress(pool, descriptor.factoryBinding.reversePool)) {
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
  for (let i = 0; i < Number(bitmapCount); i++) {
    const offset = 20 + i * 2;
    const word = Number(sint(offset, 16)), value = uint(offset + 1);
    if (word < firstReadWord || word > lastReadWord || value === 0n || bitmaps.has(word)) {
      throw new Error("univ3 duplicate or out-of-range bitmap");
    }
    bitmaps.set(word, value);
  }
  const populatedBits = new Map<number, bigint>();
  const allTicks = new Set<number>(), ticks = new Map<number, bigint>();
  for (let i = 0; i < Number(tickCount); i++) {
    const offset = ticksOffset + 1 + i * 7;
    const tk = Number(sint(offset, 24)), gross = uint(offset + 1, 128), net = sint(offset + 2, 128);
    sint(offset + 3, 56); uint(offset + 4, 160); uint(offset + 5, 32);
    const initialized = uint(offset + 6, 1) === 1n;
    const compressed = Math.floor(tk / spacing), word = compressed >> 8;
    if (tk < MIN_TICK || tk > MAX_TICK || tk % spacing !== 0 || allTicks.has(tk) ||
        !initialized || gross <= 0n || net > gross || -net > gross ||
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
  return { sqrtPriceX96, tick, liquidity,
    fee: descriptor.fee, tickSpacing: spacing, tickBitmap, ticks };
}
