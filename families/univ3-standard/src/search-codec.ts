import { canonicalAddress } from "./types.ts";

const UINT256 = 1n << 256n;
const WORD_HEX = 64;
const WORD_RE = /^[0-9a-fA-F]{64}$/;
const BYTES_RE = /^0x(?:[0-9a-fA-F]{2})*$/;

export const UNIV3_SEARCH_SELECTORS = Object.freeze({
  slot0: "0x3850c7bd",
  liquidity: "0x1a686502",
  fee: "0xddca3f43",
  tickSpacing: "0xd0c93a7c",
  tickBitmap: "0x5339c296",
  ticks: "0xf30dba93",
  quoteExactInputSingle: "0xc6a5026a",
} as const);

const UNIV3_CANONICAL_FACTORY = "0x1f98431c8ad98523631ae4a59f267346ea31f984";
const UNIV3_CANONICAL_QUOTER = "0x61ffe014ba17989e743c5f6cb21bf9697530b21e";
const PANCAKE_V3_FACTORY = "0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865";
const PANCAKE_V3_QUOTER = "0xb048bbc1ee6b733fffcfb9e9cef7375518e25997";

function raw(value: string, path: string): string {
  if (!BYTES_RE.test(value)) throw new TypeError(`${path} must be raw even-length ABI bytes`);
  return value.slice(2).toLowerCase();
}

function word(value: bigint, path: string): string {
  if (value < 0n || value >= UINT256) throw new RangeError(`${path} is outside uint256`);
  return value.toString(16).padStart(WORD_HEX, "0");
}

function signedWord(value: number, bits: number, path: string): string {
  if (!Number.isInteger(value)) throw new TypeError(`${path} must be an integer`);
  const bound = 1n << BigInt(bits - 1);
  const encoded = BigInt(value);
  if (encoded < -bound || encoded >= bound) throw new RangeError(`${path} is outside int${bits}`);
  return word(encoded < 0n ? UINT256 + encoded : encoded, path);
}

function call(selector: string, args: readonly string[] = []): string {
  return `0x${selector.slice(2)}${args.join("")}`;
}

export function factoryBoundUniV3Quoter(factory: string): string | null {
  const value = canonicalAddress(factory).toLowerCase();
  if (value === UNIV3_CANONICAL_FACTORY) return UNIV3_CANONICAL_QUOTER;
  if (value === PANCAKE_V3_FACTORY) return PANCAKE_V3_QUOTER;
  return null;
}

export function encodeUniV3QuoterCall(input: { readonly quoter: string; readonly tokenIn: string; readonly tokenOut: string; readonly amountIn: string; readonly fee: string }): { readonly target: string; readonly data: string; readonly responseEncoding: "abi-univ3-quoter-v2-v1" } {
  return Object.freeze({
    target: canonicalAddress(input.quoter),
    data: call(UNIV3_SEARCH_SELECTORS.quoteExactInputSingle, [
      word(BigInt(canonicalAddress(input.tokenIn)), "quoter tokenIn"),
      word(BigInt(canonicalAddress(input.tokenOut)), "quoter tokenOut"),
      word(BigInt(input.amountIn), "quoter amountIn"),
      word(BigInt(input.fee), "quoter fee"),
      word(0n, "quoter sqrtPriceLimitX96"),
    ]),
    responseEncoding: "abi-univ3-quoter-v2-v1",
  });
}

export function encodeUniV3StateCall(
  kind: "slot0" | "liquidity" | "fee" | "tickSpacing" | "tickBitmap" | "ticks",
  pool: string,
  index?: number,
): { readonly target: string; readonly data: string; readonly responseEncoding: `abi-${string}` } {
  const target = canonicalAddress(pool);
  if (kind === "tickBitmap") {
    if (index === undefined) throw new TypeError("univ3 tick bitmap index is required");
    return Object.freeze({ target, data: call(UNIV3_SEARCH_SELECTORS.tickBitmap, [signedWord(index, 16, "tick bitmap index")]), responseEncoding: "abi-univ3-tick-bitmap-v1" });
  }
  if (kind === "ticks") {
    if (index === undefined) throw new TypeError("univ3 tick index is required");
    return Object.freeze({ target, data: call(UNIV3_SEARCH_SELECTORS.ticks, [signedWord(index, 24, "tick index")]), responseEncoding: "abi-univ3-tick-v1" });
  }
  return Object.freeze({ target, data: call(UNIV3_SEARCH_SELECTORS[kind]), responseEncoding: `abi-univ3-${kind}-v1` });
}

function words(data: string, count: number, path: string): readonly string[] {
  const body = raw(data, path);
  if (body.length !== WORD_HEX * count) throw new TypeError(`${path} must contain exactly ${count} ABI words`);
  const output: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const item = body.slice(index * WORD_HEX, (index + 1) * WORD_HEX);
    if (!WORD_RE.test(item)) throw new TypeError(`${path}[${index}] is not an ABI word`);
    output.push(item);
  }
  return output;
}

function uintWord(value: string, bits: number, path: string): bigint {
  const decoded = BigInt(`0x${value}`);
  if (decoded >= (1n << BigInt(bits))) throw new TypeError(`${path} exceeds uint${bits}`);
  return decoded;
}

function intWord(value: string, bits: number, path: string): bigint {
  const decoded = BigInt(`0x${value}`);
  const signed = decoded >= (1n << 255n) ? decoded - UINT256 : decoded;
  if (signed < -(1n << BigInt(bits - 1)) || signed >= (1n << BigInt(bits - 1))) throw new TypeError(`${path} exceeds int${bits}`);
  return signed;
}

export function decodeUniV3Slot0(data: string, path = "univ3.slot0"): { readonly sqrtPriceX96: bigint; readonly tick: number } {
  const values = words(data, 7, path);
  const sqrtPriceX96 = uintWord(values[0]!, 160, `${path}.sqrtPriceX96`);
  const tick = Number(intWord(values[1]!, 24, `${path}.tick`));
  uintWord(values[2]!, 16, `${path}.observationIndex`);
  uintWord(values[3]!, 16, `${path}.observationCardinality`);
  uintWord(values[4]!, 16, `${path}.observationCardinalityNext`);
  uintWord(values[5]!, 8, `${path}.feeProtocol`);
  const unlocked = uintWord(values[6]!, 8, `${path}.unlocked`);
  if (unlocked !== 0n && unlocked !== 1n) throw new TypeError(`${path}.unlocked is not a bool`);
  return Object.freeze({ sqrtPriceX96, tick });
}

export function decodeUniV3Liquidity(data: string, path = "univ3.liquidity"): bigint {
  return uintWord(words(data, 1, path)[0]!, 128, path);
}

export function decodeUniV3Fee(data: string, path = "univ3.fee"): bigint {
  return uintWord(words(data, 1, path)[0]!, 24, path);
}

export function decodeUniV3TickSpacing(data: string, path = "univ3.tickSpacing"): number {
  const value = Number(intWord(words(data, 1, path)[0]!, 24, path));
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${path} is not a positive int24`);
  return value;
}

export function decodeUniV3TickBitmap(data: string, path = "univ3.tickBitmap"): bigint {
  return uintWord(words(data, 1, path)[0]!, 256, path);
}

export function decodeUniV3Tick(data: string, path = "univ3.tick"): { readonly liquidityNet: bigint; readonly initialized: boolean } {
  const values = words(data, 8, path);
  uintWord(values[0]!, 128, `${path}.liquidityGross`);
  const liquidityNet = intWord(values[1]!, 128, `${path}.liquidityNet`);
  uintWord(values[2]!, 256, `${path}.feeGrowthOutside0X128`);
  uintWord(values[3]!, 256, `${path}.feeGrowthOutside1X128`);
  intWord(values[4]!, 56, `${path}.tickCumulativeOutside`);
  uintWord(values[5]!, 160, `${path}.secondsPerLiquidityOutsideX128`);
  uintWord(values[6]!, 32, `${path}.secondsOutside`);
  const initialized = uintWord(values[7]!, 8, `${path}.initialized`);
  if (initialized !== 0n && initialized !== 1n) throw new TypeError(`${path}.initialized is not a bool`);
  return Object.freeze({ liquidityNet, initialized: initialized === 1n });
}

export function decodeUniV3Quoter(data: string, path = "univ3.quoter"): bigint {
  const values = words(data, 4, path);
  return uintWord(values[0]!, 256, `${path}.amountOut`);
}
