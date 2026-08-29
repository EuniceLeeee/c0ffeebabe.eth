import { CURVE_METAREGISTRY } from "./manifest.ts";
import { canonicalAddress } from "./types.ts";

const UINT256 = 1n << 256n;
const WORD_HEX = 64;
const WORD_RE = /^[0-9a-fA-F]{64}$/;
const BYTES_RE = /^0x(?:[0-9a-fA-F]{2})*$/;

export const CURVE_SEARCH_SELECTORS = Object.freeze({
  A: "0xf446c1d0",
  fee: "0xddca3f43",
  offpegFeeMultiplier: "0x8edfdd5f",
  storedRates: "0xfd0684b1",
  underlyingBalances: "0x59f4f351",
  underlyingDecimals: "0x4cb088f1",
  getDyUnderlying: "0x85f11d1e",
} as const);

function word(value: bigint, path: string): string {
  if (value < 0n || value >= UINT256) throw new RangeError(`${path} is outside uint256`);
  return value.toString(16).padStart(WORD_HEX, "0");
}

function signedWord(value: bigint, bits: number, path: string): string {
  const bound = 1n << BigInt(bits - 1);
  if (value < -bound || value >= bound) throw new RangeError(`${path} is outside int${bits}`);
  return word(value < 0n ? UINT256 + value : value, path);
}

function raw(value: string, path: string): string {
  if (!BYTES_RE.test(value)) throw new TypeError(`${path} must be raw even-length ABI bytes`);
  return value.slice(2).toLowerCase();
}

function call(selector: string, args: readonly string[] = []): string {
  return `0x${selector.slice(2)}${args.join("")}`;
}

export function encodeCurveStateCall(
  kind: keyof typeof CURVE_SEARCH_SELECTORS,
  pool: string,
  indices?: readonly [number, number, string],
): { readonly target: string; readonly data: string; readonly responseEncoding: `abi-${string}` } {
  const target = kind === "underlyingBalances" || kind === "underlyingDecimals"
    ? canonicalAddress(CURVE_METAREGISTRY)
    : canonicalAddress(pool);
  const data = kind === "underlyingBalances" || kind === "underlyingDecimals"
    ? call(CURVE_SEARCH_SELECTORS[kind], [word(BigInt(canonicalAddress(pool)), "pool")])
    : kind === "getDyUnderlying"
    ? indices === undefined
      ? (() => { throw new TypeError("curve get_dy_underlying indices are required"); })()
      : call(CURVE_SEARCH_SELECTORS[kind], [signedWord(BigInt(indices[0]), 128, "curve i"), signedWord(BigInt(indices[1]), 128, "curve j"), word(BigInt(indices[2]), "curve amount")])
    : call(CURVE_SEARCH_SELECTORS[kind]);
  return Object.freeze({
    target,
    data,
    responseEncoding: `abi-curve-${kind}-v1`,
  });
}

export function decodeCurveUint256(data: string, path: string): bigint {
  const body = raw(data, path);
  if (body.length !== WORD_HEX || !WORD_RE.test(body)) throw new TypeError(`${path} must contain one uint256 ABI word`);
  return BigInt(`0x${body}`);
}

export function decodeCurveUint256Array8(data: string, path: string): readonly bigint[] {
  const body = raw(data, path);
  if (body.length !== WORD_HEX * 8) throw new TypeError(`${path} must contain exactly eight uint256 ABI words`);
  const output: bigint[] = [];
  for (let index = 0; index < 8; index += 1) {
    const item = body.slice(index * WORD_HEX, (index + 1) * WORD_HEX);
    if (!WORD_RE.test(item)) throw new TypeError(`${path}[${index}] is not a uint256 ABI word`);
    output.push(BigInt(`0x${item}`));
  }
  return Object.freeze(output);
}

export function decodeCurveUint256Array(data: string, path: string): readonly bigint[] {
  const body = raw(data, path);
  if (body.length < WORD_HEX * 2) throw new TypeError(`${path} is missing its dynamic-array header`);
  const offset = BigInt(`0x${body.slice(0, WORD_HEX)}`);
  if (offset !== 32n || body.length < WORD_HEX * 2) throw new TypeError(`${path} has an invalid ABI array offset`);
  const length = BigInt(`0x${body.slice(WORD_HEX, WORD_HEX * 2)}`);
  if (length > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError(`${path} length is not safely representable`);
  const count = Number(length);
  if (body.length !== WORD_HEX * (2 + count)) throw new TypeError(`${path} has an invalid ABI array length`);
  const output: bigint[] = [];
  for (let index = 0; index < count; index += 1) {
    const item = body.slice(WORD_HEX * (2 + index), WORD_HEX * (3 + index));
    if (!WORD_RE.test(item)) throw new TypeError(`${path}[${index}] is not a uint256 ABI word`);
    output.push(BigInt(`0x${item}`));
  }
  return Object.freeze(output);
}

export function trimCurveArray(values: readonly bigint[], count: number, path: string): readonly bigint[] {
  if (!Number.isInteger(count) || count < 1 || count > values.length) throw new RangeError(`${path} count is outside the ABI array`);
  if (values.slice(count).some(value => value !== 0n)) throw new TypeError(`${path} has non-zero trailing ABI entries`);
  return Object.freeze(values.slice(0, count));
}
