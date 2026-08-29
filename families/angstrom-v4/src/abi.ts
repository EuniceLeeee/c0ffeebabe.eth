import type { Hash } from "../../../packages/canonical-codec/src/index.ts";

/** Angstrom's pinned v4 manager roots are Family-owned infrastructure facts. */
export const ANGSTROM_V4_POOL_MANAGER = "0x000000000004444c5dc75cB358380D2e3dE08A90" as const;
export const ANGSTROM_V4_QUOTER = "0x52F0E24D1c21C8A0cB1e5a5dD6198556BD9E1203" as const;
export const ANGSTROM_V4_STATE_VIEW = "0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597227" as const;
export const ANGSTROM_MAINNET_HOOK = "0x0000000aa232009084Bd71A5797d089AA4Edfad4" as const;

export const ANGSTROM_V4_GET_SLOT0_SELECTOR = "0xc815641c" as const;
export const ANGSTROM_V4_GET_LIQUIDITY_SELECTOR = "0xfa6793d5" as const;
export const ANGSTROM_V4_QUOTE_SELECTOR = "0xaa9d21cb" as const;
export const ANGSTROM_V4_SWAP_SELECTOR = "0xf3cd914c" as const;

export type AngstromV4PoolKey = Readonly<{
  readonly currency0: string;
  readonly currency1: string;
  readonly fee: string;
  readonly tickSpacing: string;
  readonly hooks: string;
}>;

export type AngstromV4InitializeLogV1 = Readonly<{
  readonly address: string;
  readonly topics: readonly Hash[];
  readonly data: string;
}>;

const HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;

function address(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new TypeError(`${path} must be an address`);
  return value.toLowerCase();
}

function bytes32(value: unknown, path: string): Hash {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new TypeError(`${path} must be bytes32`);
  return value.toLowerCase() as Hash;
}

function word(value: bigint, path: string): string {
  if (value < 0n) value = (1n << 256n) + value;
  if (value < 0n || value >= (1n << 256n)) throw new RangeError(`${path} is outside uint256`);
  return value.toString(16).padStart(64, "0");
}

function uintWord(value: string | bigint, path: string): string {
  const n = typeof value === "bigint" ? value : BigInt(value);
  if (n < 0n || n >= (1n << 256n)) throw new RangeError(`${path} is outside uint256`);
  return word(n, path);
}

function addressWord(value: string, path: string): string {
  return word(BigInt(address(value, path)), path);
}

export function encodePoolIdCall(selector: string, poolId: string): string {
  return `${selector}${bytes32(poolId, "poolId").slice(2)}`.toLowerCase();
}

export function encodeQuoteCall(key: AngstromV4PoolKey, zeroForOne: boolean, amountIn: string): string {
  const body = [
    word(0x20n, "params.offset"),
    addressWord(key.currency0, "poolKey.currency0"),
    addressWord(key.currency1, "poolKey.currency1"),
    uintWord(key.fee, "poolKey.fee"),
    word(BigInt(key.tickSpacing), "poolKey.tickSpacing"),
    addressWord(key.hooks, "poolKey.hooks"),
    word(zeroForOne ? 1n : 0n, "zeroForOne"),
    uintWord(amountIn, "amountIn"),
    word(0x100n, "hookData.offset"),
    word(0n, "hookData.length"),
  ].join("");
  return `${ANGSTROM_V4_QUOTE_SELECTOR}${body}`.toLowerCase();
}

export function encodeSwapCall(key: AngstromV4PoolKey, zeroForOne: boolean, amountIn: string): string {
  const sqrtPriceLimit = zeroForOne ? 4_295_128_740n : (1n << 160n) - 1n;
  const body = [
    addressWord(key.currency0, "poolKey.currency0"),
    addressWord(key.currency1, "poolKey.currency1"),
    uintWord(key.fee, "poolKey.fee"),
    word(BigInt(key.tickSpacing), "poolKey.tickSpacing"),
    addressWord(key.hooks, "poolKey.hooks"),
    word(zeroForOne ? 1n : 0n, "zeroForOne"),
    word(-BigInt(amountIn), "amountSpecified"),
    word(sqrtPriceLimit, "sqrtPriceLimitX96"),
    word(0x120n, "hookData.offset"),
    word(0n, "hookData.length"),
  ].join("");
  return `${ANGSTROM_V4_SWAP_SELECTOR}${body}`.toLowerCase();
}

export function decodeWords(value: string, count: number, path: string): readonly bigint[] {
  if (typeof value !== "string" || !HEX_BYTES.test(value) || (value.length - 2) % 64 !== 0) throw new TypeError(`${path} must be ABI words`);
  const available = (value.length - 2) / 64;
  if (available < count) throw new TypeError(`${path} has too few ABI words`);
  return Object.freeze(Array.from({ length: count }, (_, index) => BigInt(`0x${value.slice(2 + index * 64, 2 + (index + 1) * 64)}`)));
}

export function assertPoolKey(value: unknown, path = "poolKey"): AngstromV4PoolKey {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${path} must be an object`);
  const record = value as Record<string, unknown>;
  const keys = ["currency0", "currency1", "fee", "hooks", "tickSpacing"];
  if (Reflect.ownKeys(record).length !== keys.length || keys.some(key => !Object.hasOwn(record, key))) throw new TypeError(`${path} has invalid fields`);
  const result = Object.freeze({
    currency0: address(record.currency0, `${path}.currency0`),
    currency1: address(record.currency1, `${path}.currency1`),
    fee: BigInt(String(record.fee)).toString(10),
    tickSpacing: BigInt(String(record.tickSpacing)).toString(10),
    hooks: address(record.hooks, `${path}.hooks`),
  });
  const fee = BigInt(result.fee);
  const tickSpacing = BigInt(result.tickSpacing);
  if (fee < 0n || fee >= (1n << 24n)) throw new TypeError(`${path}.fee is outside uint24`);
  if (tickSpacing < -(1n << 23n) || tickSpacing >= (1n << 23n)) throw new TypeError(`${path}.tickSpacing is outside int24`);
  if (BigInt(result.currency0) >= BigInt(result.currency1)) throw new TypeError(`${path} currencies are not ordered`);
  return result;
}

export function decodeAngstromV4InitializeLog(raw: AngstromV4InitializeLogV1, expectedTopic: Hash): Readonly<{
  readonly poolId: Hash;
  readonly poolKey: AngstromV4PoolKey;
}> {
  if (
    raw.address !== ANGSTROM_V4_POOL_MANAGER.toLowerCase()
    || raw.topics.length !== 4
    || raw.topics[0] !== expectedTopic
    || !/^0x[0-9a-f]{64}$/.test(raw.topics[1] ?? "")
    || !/^0x0{24}[0-9a-f]{40}$/.test(raw.topics[2] ?? "")
    || !/^0x0{24}[0-9a-f]{40}$/.test(raw.topics[3] ?? "")
    || !/^0x(?:[0-9a-f]{64}){5}$/.test(raw.data)
  ) throw new TypeError("angstrom-v4 Initialize log binding mismatch");
  const fee = abiUint(raw.data, 0, 24, "angstrom-v4.Initialize.fee");
  const tickSpacing = abiInt(raw.data, 1, 24, "angstrom-v4.Initialize.tickSpacing");
  const hooks = abiUint(raw.data, 2, 160, "angstrom-v4.Initialize.hooks");
  const sqrtPriceX96 = abiUint(raw.data, 3, 160, "angstrom-v4.Initialize.sqrtPriceX96");
  abiInt(raw.data, 4, 24, "angstrom-v4.Initialize.tick");
  if (sqrtPriceX96 === 0n) throw new TypeError("angstrom-v4 Initialize sqrtPriceX96 is zero");
  const poolKey = assertPoolKey({
    currency0: `0x${raw.topics[2]!.slice(-40)}`,
    currency1: `0x${raw.topics[3]!.slice(-40)}`,
    fee: fee.toString(),
    tickSpacing: tickSpacing.toString(),
    hooks: `0x${hooks.toString(16).padStart(40, "0")}`,
  }, "angstrom-v4.Initialize.poolKey");
  if (poolKey.hooks !== ANGSTROM_MAINNET_HOOK.toLowerCase()) throw new TypeError("angstrom-v4 Initialize hook binding mismatch");
  const poolId = bytes32(raw.topics[1], "angstrom-v4.Initialize.poolId");
  if (poolIdForKey(poolKey) !== poolId) throw new TypeError("angstrom-v4 Initialize PoolKey reverse binding mismatch");
  return Object.freeze({ poolId, poolKey });
}

function keccak256Hex(input: Uint8Array): Hash {
  const state = new BigInt64Array(25);
  const rate = 136;
  const padded = new Uint8Array(Math.ceil((input.length + 1) / rate) * rate);
  padded.set(input);
  padded[input.length] = 0x01;
  padded[padded.length - 1] |= 0x80;
  for (let offset = 0; offset < padded.length; offset += rate) {
    for (let lane = 0; lane < rate / 8; lane++) {
      let value = 0n;
      for (let byte = 0; byte < 8; byte++) value |= BigInt(padded[offset + lane * 8 + byte]!) << BigInt(byte * 8);
      state[lane] = BigInt.asIntN(64, state[lane]! ^ BigInt.asIntN(64, value));
    }
    keccakF(state);
  }
  const output = new Uint8Array(32);
  for (let index = 0; index < 32; index++) output[index] = Number((state[Math.floor(index / 8)]! >> BigInt((index % 8) * 8)) & 0xffn);
  return `0x${Array.from(output, byte => byte.toString(16).padStart(2, "0")).join("")}` as Hash;
}

function keccakF(state: BigInt64Array): void {
  const rotation = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
  const roundConstants = [
    0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
    0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
    0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
    0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
    0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
    0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
  ];
  const mask = (1n << 64n) - 1n;
  const rotl = (value: bigint, amount: number) => {
    const n = BigInt.asUintN(64, value);
    return BigInt.asIntN(64, ((n << BigInt(amount)) | (n >> BigInt(64 - amount))) & mask);
  };
  for (const rc of roundConstants) {
    const c = new BigInt64Array(5);
    const d = new BigInt64Array(5);
    for (let x = 0; x < 5; x++) c[x] = BigInt.asIntN(64, state[x]! ^ state[x + 5]! ^ state[x + 10]! ^ state[x + 15]! ^ state[x + 20]!);
    for (let x = 0; x < 5; x++) d[x] = BigInt.asIntN(64, c[(x + 4) % 5]! ^ rotl(c[(x + 1) % 5]!, 1));
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) state[x + 5 * y] = BigInt.asIntN(64, state[x + 5 * y]! ^ d[x]!);
    const b = new BigInt64Array(25);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(state[x + 5 * y]!, rotation[x + 5 * y]!);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) state[x + 5 * y] = BigInt.asIntN(64, b[x + 5 * y]! ^ ((~b[(x + 1) % 5 + 5 * y]!) & b[(x + 2) % 5 + 5 * y]!));
    state[0] = BigInt.asIntN(64, state[0]! ^ rc);
  }
}

export function poolIdForKey(key: AngstromV4PoolKey): Hash {
  const normalized = assertPoolKey(key);
  const encoded = new Uint8Array(160);
  const values = [BigInt(normalized.currency0), BigInt(normalized.currency1), BigInt(normalized.fee), BigInt(normalized.tickSpacing), BigInt(normalized.hooks)];
  values.forEach((value, index) => {
    const encodedWord = BigInt.asUintN(256, value).toString(16).padStart(64, "0");
    for (let byte = 0; byte < 32; byte++) encoded[index * 32 + byte] = Number.parseInt(encodedWord.slice(byte * 2, byte * 2 + 2), 16);
  });
  return keccak256Hex(encoded);
}

function abiWord(data: string, index: number, path: string): bigint {
  if (!/^0x(?:[0-9a-f]{64})+$/.test(data) || data.length < 2 + (index + 1) * 64) throw new TypeError(`${path} is not an ABI word`);
  return BigInt(`0x${data.slice(2 + index * 64, 2 + (index + 1) * 64)}`);
}

function abiUint(data: string, index: number, bits: number, path: string): bigint {
  const value = abiWord(data, index, path);
  if (value >= (1n << BigInt(bits))) throw new TypeError(`${path} is not canonical uint${bits}`);
  return value;
}

function abiInt(data: string, index: number, bits: number, path: string): bigint {
  const encoded = abiWord(data, index, path);
  const value = BigInt.asIntN(bits, encoded);
  if (BigInt.asUintN(256, value) !== encoded) throw new TypeError(`${path} is not canonical int${bits}`);
  return value;
}
