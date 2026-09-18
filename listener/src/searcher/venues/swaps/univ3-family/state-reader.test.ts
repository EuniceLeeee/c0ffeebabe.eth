import assert from "node:assert/strict";
import test from "node:test";
import { getSqrtRatioAtTick, v3SwapToState, type V3PoolState } from "../../../solver/v3-math.js";
import { PANCAKE_V3_FACTORY, UNIV3_CANONICAL_FACTORY } from "../univ3-abi.js";
import { readUniV3State, resolveUniV3StateReader, uniV3StateRequestData } from "./state-reader.js";
import type { UniV3Descriptor } from "./types.js";

const POOL = "0x1111111111111111111111111111111111111111";
const FOREIGN = "0x2222222222222222222222222222222222222222";
const NAME = "getFullStateWithRelativeBitmaps";
const descriptor = (spacing = 60, pancake = false): UniV3Descriptor => ({
  pool: POOL, token0: POOL, token1: FOREIGN, fee: 3000n, tickSpacing: spacing,
  factoryBinding: { factory: pancake ? PANCAKE_V3_FACTORY : UNIV3_CANONICAL_FACTORY, reversePool: POOL },
} as UniV3Descriptor);
function fixture(tick = -1, spacing = 60, entries: readonly (readonly [number, bigint])[] = [
  [-15360, 1000n], [-60, 2000n], [60, -3000n],
]) {
  const bitmaps = new Map<number, bigint>();
  for (const [tk] of entries) {
    const compressed = Math.floor(tk / spacing), word = compressed >> 8;
    bitmaps.set(word, (bitmaps.get(word) ?? 0n) | (1n << BigInt((compressed % 256 + 256) % 256)));
  }
  return {
    pool: POOL, blockTimestamp: (1n << 256n) - 1n,
    slot0: { sqrtPriceX96: getSqrtRatioAtTick(tick), tick, observationIndex: 31,
      observationCardinality: 256, observationCardinalityNext: 65535, feeProtocol: 254, unlocked: true },
    liquidity: 1_000_000_000_000_000n, tickSpacing: spacing, maxLiquidityPerTick: (1n << 128n) - 1n,
    observation: { blockTimestamp: 0xffff_ffff, tickCumulative: -(1n << 55n),
      secondsPerLiquidityCumulativeX128: (1n << 160n) - 1n, initialized: false },
    tickBitmap: [...bitmaps].map(([index, value]) => ({ index, value })),
    ticks: entries.map(([index, liquidityNet]) => ({ index, value: {
      liquidityGross: (liquidityNet < 0n ? -liquidityNet : liquidityNet) + 1n, liquidityNet,
      tickCumulativeOutside: (1n << 55n) - 1n, secondsPerLiquidityOutsideX128: (1n << 160n) - 1n,
      secondsOutside: 0xffff_ffff, initialized: true,
    } })),
  };
}
const encode = (raw: ReturnType<typeof fixture>, d = descriptor()) =>
  resolveUniV3StateReader(d)!.iface.encodeFunctionResult(NAME, [raw]);
const replaceWord = (data: string, index: number, value: bigint) =>
  data.slice(0, 2 + index * 64) + BigInt.asUintN(256, value).toString(16).padStart(64, "0") + data.slice(2 + (index + 1) * 64);
function expected(raw: ReturnType<typeof fixture>, d: UniV3Descriptor): V3PoolState {
  const center = Math.floor(raw.slot0.tick / raw.tickSpacing) >> 8;
  const words = new Map(raw.tickBitmap.map(w => [w.index, w.value]));
  return { sqrtPriceX96: raw.slot0.sqrtPriceX96, tick: raw.slot0.tick, liquidity: raw.liquidity,
    fee: d.fee, tickSpacing: raw.tickSpacing,
    tickBitmap: new Map(Array.from({ length: 49 }, (_, i) => [center - 24 + i, words.get(center - 24 + i) ?? 0n])),
    ticks: new Map(raw.ticks.filter(t => {
      const word = Math.floor(t.index / raw.tickSpacing) >> 8;
      return word >= center - 24 && word <= center + 24;
    }).map(t => [t.index, t.value.liquidityNet])),
  };
}

test("all returned state fields and both-direction quotes match ABI-encoded inputs", () => {
  for (const pancake of [false, true]) for (const tick of [-15361, -15360, -257, -256, -1, 0, 255, 256, 15360]) {
    for (const spacing of [1, 60]) {
      const d = descriptor(spacing, pancake), aligned = Math.floor(tick / spacing) * spacing;
      const raw = fixture(tick, spacing, [[aligned - spacing, 1234n], [aligned + spacing, -1234n]]);
      if (pancake) raw.slot0.feeProtocol = 0xffff_ffff;
      const data = encode(raw, d), wanted = expected(raw, d);
      assert.deepEqual(readUniV3State(data, d), wanted);
      assert.deepEqual(readUniV3State("0x" + data.slice(2).toUpperCase(), d), wanted);
      for (const direction of [false, true]) for (const amount of [1n, 1000n, 1_000_000n]) {
        assert.deepEqual(v3SwapToState(readUniV3State(data, d), direction, amount), v3SwapToState(wanted, direction, amount));
      }
      const iface = resolveUniV3StateReader(d)!.iface;
      const request = iface.decodeFunctionData(NAME, uniV3StateRequestData(d));
      assert.equal(request[4], 25n); assert.equal(request[5], 24n);
    }
  }
});

test("canonical layout: offsets, overlap, lengths, truncated and trailing data", () => {
  const raw = fixture(), data = encode(raw), ticksWord = 20 + raw.tickBitmap.length * 2;
  for (const [word, values] of [
    [0, [0n, 31n, 64n]], [17, [0n, 18n * 32n + 1n, 19n * 32n]],
    [18, [18n * 32n, BigInt(ticksWord * 32), (1n << 256n) - 1n]],
    [19, [0n, BigInt(raw.tickBitmap.length + 1), (1n << 256n) - 1n]],
    [ticksWord, [0n, BigInt(raw.ticks.length - 1), BigInt(raw.ticks.length + 1), (1n << 256n) - 1n]],
  ] as const) for (const value of values) assert.throws(() => readUniV3State(replaceWord(data, word, value), descriptor()), /canonical/);
  for (const bad of ["0x", "0x0", data.slice(0, -1), data.slice(0, -64), data + "00", data + "00".repeat(32), data.replace(/.$/, "g")]) {
    assert.throws(() => readUniV3State(bad, descriptor()), /canonical/);
  }
});

test("every scalar's ABI width, signed extension and bool encoding remain canonical", () => {
  for (const pancake of [false, true]) {
    const d = descriptor(60, pancake), raw = fixture(), data = encode(raw, d);
    const ticksWord = 20 + raw.tickBitmap.length * 2;
    const unsigned: [number, number][] = [[1,160],[3,160],[5,16],[6,16],[7,16],[8,pancake?32:8],[9,1],
      [10,128],[12,128],[13,32],[15,160],[16,1]];
    const signed: [number, number][] = [[4,24],[11,24],[14,56]];
    for (let i = 0; i < raw.tickBitmap.length; i++) signed.push([20 + i * 2, 16]);
    for (let i = 0; i < raw.ticks.length; i++) {
      const start = ticksWord + 1 + i * 7;
      signed.push([start,24],[start+2,128],[start+3,56]);
      unsigned.push([start+1,128],[start+4,160],[start+5,32],[start+6,1]);
    }
    for (const [word, bits] of unsigned) for (const value of [1n << BigInt(bits), (1n << 256n) - 1n]) {
      assert.throws(() => readUniV3State(replaceWord(data, word, value), d), /canonical/, `uint${bits} at ${word}`);
    }
    for (const [word, bits] of signed) for (const value of [
      1n << BigInt(bits - 1), (1n << BigInt(bits)) - 1n, -(1n << BigInt(bits - 1)) - 1n,
    ]) assert.throws(() => readUniV3State(replaceWord(data, word, value), d), /canonical/, `int${bits} at ${word}`);
  }
  const raw = fixture(); raw.slot0.feeProtocol = 256;
  assert.throws(() => readUniV3State(encode(raw, descriptor(60, true)), descriptor()), /canonical/);
});

test("foreign pool, inconsistent sparse maps, duplicate/out-of-range ticks stay rejected", () => {
  const raw = fixture();
  const cases: ReturnType<typeof fixture>[] = [
    { ...raw, pool: FOREIGN }, { ...raw, tickSpacing: 1 }, { ...raw, tickSpacing: 0 },
    { ...raw, slot0: { ...raw.slot0, tick: 887273 } },
    { ...raw, ticks: raw.ticks.slice(1) }, { ...raw, tickBitmap: raw.tickBitmap.slice(1) },
    { ...raw, tickBitmap: [...raw.tickBitmap, raw.tickBitmap[0]!] },
    { ...raw, ticks: [...raw.ticks, raw.ticks[0]!] },
    { ...raw, tickBitmap: raw.tickBitmap.map(w => ({ ...w, value: 0n })) },
    { ...raw, tickBitmap: raw.tickBitmap.map(w => ({ ...w, value: w.value | 8n })) },
    { ...raw, ticks: raw.ticks.map(t => ({ ...t, index: t.index + 1 })) },
    ...[0n, 1n].map(gross => ({ ...raw, ticks: raw.ticks.map(t => ({ ...t, value: { ...t.value, liquidityGross: gross } })) })),
    { ...raw, ticks: raw.ticks.map(t => ({ ...t, value: { ...t.value, initialized: false } })) },
    fixture(0, 60, [[-26 * 256 * 60, 1n]]), fixture(0, 60, [[25 * 256 * 60, 1n]]),
  ];
  for (const malformed of cases) assert.throws(() => readUniV3State(encode(malformed), descriptor()));
  assert.throws(() => readUniV3State(encode(raw), { ...descriptor(), factoryBinding: { ...descriptor().factoryBinding, reversePool: FOREIGN } }), /foreign/);
  const reversed = { ...raw, ticks: [...raw.ticks].reverse(), tickBitmap: [...raw.tickBitmap].reverse() };
  assert.deepEqual(readUniV3State(encode(reversed), descriptor()), expected(reversed, descriptor()));
});

test("extra helper words are fully validated even when clipped to 49 output words", () => {
  for (const [tick, boundary] of [[0, -25], [-1, 24]] as const) {
    const raw = fixture(tick, 60, [[boundary * 256 * 60, 1n]]), d = descriptor();
    const state = readUniV3State(encode(raw), d);
    assert.equal(state.tickBitmap.size, 49); assert.equal(state.ticks.size, 0);
    assert.throws(() => readUniV3State(encode({ ...raw, ticks: [] }), d), /incomplete/);
    const data = encode(raw), tickWord = 21 + raw.tickBitmap.length * 2;
    assert.throws(() => readUniV3State(replaceWord(data, tickWord + 3, 1n << 55n), d), /canonical/);
  }
  const raw = fixture(-1, 60, [[-25 * 256 * 60, 1n]]);
  assert.equal(readUniV3State(encode(raw), descriptor()).ticks.size, 1, "negative tick retains required extra-left boundary");
});

test("seeded word mutations never bypass ethers ABI canonicality", () => {
  const d = descriptor(), iface = resolveUniV3StateReader(d)!.iface, data = encode(fixture());
  let seed = 0x51a7e;
  for (let i = 0; i < 200; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const word = seed % ((data.length - 2) / 64);
    const original = BigInt("0x" + data.slice(2 + word * 64, 2 + (word + 1) * 64));
    const changed = replaceWord(data, word, original ^ (1n << BigInt((seed >>> 8) % 256)));
    let canonical = false;
    try { canonical = iface.encodeFunctionResult(NAME, iface.decodeFunctionResult(NAME, changed)).toLowerCase() === changed; } catch {}
    if (!canonical) assert.throws(() => readUniV3State(changed, d));
  }
});
