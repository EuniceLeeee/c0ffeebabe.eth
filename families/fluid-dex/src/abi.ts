export const FLUID_DEX_CONSTANTS_SELECTOR = "0xb7791bf2" as const;
export const FLUID_DEX_SWAP_IN_SELECTOR = "0x2668dfaa" as const;
export const FLUID_DEX_SWAP_RESULT_SELECTOR = "0xb3bfda99" as const;
export const FLUID_DEX_QUOTE_RECIPIENT = "0x000000000000000000000000000000000000dead" as const;
export const FLUID_DEX_ERC20_APPROVE_SELECTOR = "0x095ea7b3" as const;
export const FLUID_DEX_MAX_UINT256 = (1n << 256n) - 1n;

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

export function encodeFluidDexApproveCall(spender: string, amount = FLUID_DEX_MAX_UINT256): string {
  return `${FLUID_DEX_ERC20_APPROVE_SELECTOR}${addressWord(spender, "fluid-dex.approve.spender")}${word(amount, "fluid-dex.approve.amount")}`.toLowerCase();
}

export interface FluidDexSwapEventV1 {
  readonly swap0to1: boolean;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly recipient: string;
}

export function decodeFluidDexSwapEvent(
  topics: readonly string[],
  data: string,
  expectedTopic: string,
): FluidDexSwapEventV1 {
  if (topics.length !== 1 || topics[0] !== expectedTopic) throw new TypeError("fluid-dex Swap topics mismatch");
  if (!/^0x(?:[0-9a-f]{64}){4}$/.test(data)) throw new TypeError("fluid-dex Swap data must contain exactly four canonical ABI words");
  const direction = decodeWord(data, 0, "fluid-dex.Swap.swap0to1");
  if (direction !== 0n && direction !== 1n) throw new TypeError("fluid-dex Swap direction must be an ABI bool");
  const amountIn = decodeWord(data, 1, "fluid-dex.Swap.amountIn");
  const amountOut = decodeWord(data, 2, "fluid-dex.Swap.amountOut");
  if (amountIn === 0n || amountOut === 0n) throw new TypeError("fluid-dex Swap amounts must be positive");
  const recipient = decodeAddressWord(data, 3, "fluid-dex.Swap.recipient");
  if (recipient === "0x0000000000000000000000000000000000000000") throw new TypeError("fluid-dex Swap recipient must be non-zero");
  return Object.freeze({ swap0to1: direction === 1n, amountIn, amountOut, recipient });
}

export function decodeUint256(value: string, path: string): bigint {
  if (!/^0x(?:[0-9a-fA-F]{64})+$/.test(value)) throw new TypeError(`${path} must be ABI uint256 return data`);
  return BigInt(`0x${value.slice(2, 66)}`);
}

export function decodeFluidDexSwapResultRevert(value: string, path: string): bigint {
  if (!/^0x[0-9a-fA-F]{72}$/.test(value)) throw new TypeError(`${path} must be exact FluidDexSwapResult(uint256) revert data`);
  if (value.slice(0, 10).toLowerCase() !== FLUID_DEX_SWAP_RESULT_SELECTOR) throw new TypeError(`${path} has an unknown custom-error selector`);
  return BigInt(`0x${value.slice(10)}`);
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
