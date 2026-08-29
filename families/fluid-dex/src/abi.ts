export const FLUID_DEX_CONSTANTS_SELECTOR = "0xb7791bf2" as const;
export const FLUID_DEX_SWAP_IN_SELECTOR = "0x2668dfaa" as const;

const WORD_BYTES = 32;

function word(value: bigint, path: string): string {
  if (value < 0n || value >= (1n << 256n)) throw new RangeError(`${path} is outside uint256`);
  return value.toString(16).padStart(64, "0");
}

function addressWord(value: string, path: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new TypeError(`${path} must be an address`);
  return word(BigInt(value), path);
}

export function encodeConstantsView(): string {
  return FLUID_DEX_CONSTANTS_SELECTOR;
}

export function encodeSwapInCall(swap0to1: boolean, amountIn: string, amountOutMin: string, to: string): string {
  return `${FLUID_DEX_SWAP_IN_SELECTOR}${[
    word(swap0to1 ? 1n : 0n, "fluid-dex.swapIn.swap0to1"),
    word(BigInt(amountIn), "fluid-dex.swapIn.amountIn"),
    word(BigInt(amountOutMin), "fluid-dex.swapIn.amountOutMin"),
    addressWord(to, "fluid-dex.swapIn.to"),
  ].join("")}`.toLowerCase();
}

export function decodeUint256(value: string, path: string): bigint {
  if (!/^0x(?:[0-9a-fA-F]{64})+$/.test(value)) throw new TypeError(`${path} must be ABI uint256 return data`);
  return BigInt(`0x${value.slice(2, 66)}`);
}

function decodeAddressWord(value: string, index: number, path: string): string {
  const wordValue = decodeWord(value, index, path);
  if (wordValue >= (1n << 160n)) throw new TypeError(`${path} is not an ABI address word`);
  return `0x${wordValue.toString(16).padStart(40, "0")}`;
}

function decodeWord(value: string, index: number, path: string): bigint {
  if (!/^0x(?:[0-9a-fA-F]{64})+$/.test(value) || (value.length - 2) % (WORD_BYTES * 2) !== 0) throw new TypeError(`${path} must be ABI words`);
  const count = (value.length - 2) / (WORD_BYTES * 2);
  if (index < 0 || index >= count) throw new TypeError(`${path} is missing ABI word ${index}`);
  return BigInt(`0x${value.slice(2 + index * 64, 2 + (index + 1) * 64)}`);
}

export interface FluidDexConstantsV1 {
  readonly dexId: bigint;
  readonly token0: string;
  readonly token1: string;
}

export function decodeConstantsView(value: string, path = "fluid-dex.constantsView"): FluidDexConstantsV1 {
  if (!/^0x(?:[0-9a-fA-F]{64}){18}$/.test(value)) throw new TypeError(`${path} must contain exactly eighteen ABI words`);
  return Object.freeze({
    dexId: decodeWord(value, 0, `${path}.dexId`),
    token0: decodeAddressWord(value, 9, `${path}.token0`),
    token1: decodeAddressWord(value, 10, `${path}.token1`),
  });
}
