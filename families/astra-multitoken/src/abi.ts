import { ASTRA_CHANGE_SELECTOR } from "./manifest.ts";

export const ASTRA_GET_RETURN_SELECTOR = "0x1e1401f8" as const;

const WORD = 64;
const BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;

function addressWord(value: string, path: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new TypeError(`${path} must be an address`);
  return value.slice(2).toLowerCase().padStart(WORD, "0");
}
function uintWord(value: string, path: string): string {
  if (!/^\d+$/.test(value)) throw new TypeError(`${path} must be a uint256 decimal`);
  const encoded = BigInt(value).toString(16);
  if (encoded.length > WORD) throw new RangeError(`${path} exceeds uint256`);
  return encoded.padStart(WORD, "0");
}

export function encodeAstraGetReturn(tokenIn: string, tokenOut: string, amountIn: string): string {
  return `${ASTRA_GET_RETURN_SELECTOR}${addressWord(tokenIn, "astra.getReturn.tokenIn")}${addressWord(tokenOut, "astra.getReturn.tokenOut")}${uintWord(amountIn, "astra.getReturn.amountIn")}`.toLowerCase();
}

export function encodeAstraChange(tokenIn: string, tokenOut: string, amountIn: string, minAmountOut: string): string {
  return `${ASTRA_CHANGE_SELECTOR}${addressWord(tokenIn, "astra.change.tokenIn")}${addressWord(tokenOut, "astra.change.tokenOut")}${uintWord(amountIn, "astra.change.amountIn")}${uintWord(minAmountOut, "astra.change.minAmountOut")}`.toLowerCase();
}

export function decodeAstraUint256(value: string, path: string): bigint {
  if (!BYTES.test(value) || value.length < 2 + WORD) throw new TypeError(`${path} must contain a uint256 return word`);
  return BigInt(`0x${value.slice(2, 2 + WORD)}`);
}
