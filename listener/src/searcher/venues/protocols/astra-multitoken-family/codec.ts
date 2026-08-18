import { ethers } from "ethers";
import type { AdapterRequestResult } from "../../adapter-request-program.js";

export const ASTRA_MULTITOKEN_INTERFACE = new ethers.Interface([
  "function supportsInterface(bytes4 interfaceId) view returns (bool)",
  "function tokensCount() view returns (uint256)",
  "function tokens(uint256 index) view returns (address)",
  "function weights(address token) view returns (uint256)",
  "function changesEnabled() view returns (bool)",
  "function inLendingMode() view returns (uint256)",
  "function changeFee() view returns (uint256)",
  "function TOTAL_PERCRENTS() view returns (uint256)",
  "function getReturn(address fromToken,address toToken,uint256 amount) view returns (uint256)",
  "function change(address fromToken,address toToken,uint256 amount,uint256 minReturn) returns (uint256)",
  "event Change(address indexed fromToken,address indexed toToken,address indexed changer,uint256 amount,uint256 returnAmount)",
]);

export const ASTRA_ERC20_INTERFACE = new ethers.Interface([
  "function decimals() view returns (uint8)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
]);

export const ASTRA_MULTITOKEN_CHANGE_SELECTOR = ASTRA_MULTITOKEN_INTERFACE
  .getFunction("change")!.selector.toLowerCase() as `0x${string}`;
export const ASTRA_MULTITOKEN_CHANGE_TOPIC = ASTRA_MULTITOKEN_INTERFACE
  .getEvent("Change")!.topicHash.toLowerCase() as `0x${string}`;
export const ASTRA_MULTITOKEN_INTERFACE_ID = "0x81624e24";
export const ASTRA_MULTITOKEN_BASE_INTERFACE_ID = "0xd5c368b6";
export const MAX_ASTRA_MULTITOKEN_TOKENS = 32;

export function canonicalAddress(value: string): string {
  return ethers.getAddress(value);
}

export function lowerAddress(value: string): string {
  return canonicalAddress(value).toLowerCase();
}

export function sameAddress(left: string, right: string): boolean {
  return lowerAddress(left) === lowerAddress(right);
}

export function successfulResult(
  results: readonly AdapterRequestResult[],
  id: string,
): Extract<AdapterRequestResult, { readonly ok: true }> {
  const result = results.find((candidate) => candidate.id === id);
  if (result === undefined) {
    throw new Error(`astra-multitoken request result ${id} is missing`);
  }
  if (!result.ok) {
    throw new Error(
      `astra-multitoken request result ${id} is unresolved: ${result.failure}`,
    );
  }
  return result;
}

export function returnedResult(
  results: readonly AdapterRequestResult[],
  id: string,
): Extract<AdapterRequestResult, { readonly ok: true }> {
  const result = successfulResult(results, id);
  if (result.completion !== "returned") {
    throw new Error(`astra-multitoken request result ${id} did not return`);
  }
  return result;
}

export function decodeOptionalBoolean(
  results: readonly AdapterRequestResult[],
  id: string,
  functionName: "supportsInterface",
): boolean | null {
  const result = successfulResult(results, id);
  if (result.completion === "reverted-as-declared") return null;
  if (result.data === "0x") return null;
  return Boolean(
    ASTRA_MULTITOKEN_INTERFACE.decodeFunctionResult(functionName, result.data)[0],
  );
}

export function decodeOptionalUint(
  results: readonly AdapterRequestResult[],
  id: string,
  functionName: "inLendingMode",
): bigint | null {
  const result = successfulResult(results, id);
  if (result.completion === "reverted-as-declared") return null;
  if (result.data === "0x") return null;
  return BigInt(
    ASTRA_MULTITOKEN_INTERFACE.decodeFunctionResult(functionName, result.data)[0],
  );
}

export function decodeUint(
  results: readonly AdapterRequestResult[],
  id: string,
  functionName:
    | "tokensCount"
    | "weights"
    | "changeFee"
    | "TOTAL_PERCRENTS"
    | "getReturn"
    | "change",
): bigint {
  return BigInt(
    ASTRA_MULTITOKEN_INTERFACE.decodeFunctionResult(
      functionName,
      returnedResult(results, id).data,
    )[0],
  );
}

export function decodeToken(
  results: readonly AdapterRequestResult[],
  id: string,
): string {
  return canonicalAddress(String(
    ASTRA_MULTITOKEN_INTERFACE.decodeFunctionResult(
      "tokens",
      returnedResult(results, id).data,
    )[0],
  ));
}

export function assertSameSource(
  results: readonly Extract<AdapterRequestResult, { readonly ok: true }>[],
): void {
  const source = results[0]?.source;
  if (source === undefined) {
    throw new Error("astra-multitoken evidence result set is empty");
  }
  for (const result of results.slice(1)) {
    if (
      result.source.number !== source.number ||
      result.source.hash.toLowerCase() !== source.hash.toLowerCase() ||
      result.source.generation !== source.generation
    ) {
      throw new Error("astra-multitoken evidence came from mixed sources");
    }
  }
}

export function assertSource(
  actual: { readonly number: number; readonly hash: string; readonly generation: number },
  expected: { readonly number: number; readonly hash: string; readonly generation: number },
): void {
  if (
    actual.number !== expected.number ||
    actual.hash.toLowerCase() !== expected.hash.toLowerCase() ||
    actual.generation !== expected.generation
  ) {
    throw new Error("astra-multitoken result came from a foreign source");
  }
}

export function assertTokenSet(tokens: readonly string[]): void {
  const unique = new Set(tokens.map(lowerAddress));
  if (
    tokens.length < 2 ||
    tokens.length > MAX_ASTRA_MULTITOKEN_TOKENS ||
    unique.size !== tokens.length ||
    tokens.some((token) => sameAddress(token, ethers.ZeroAddress))
  ) {
    throw new Error(
      "astra-multitoken registry contains duplicate, zero, or invalid tokens",
    );
  }
}

export function tokenPairKey(tokenIn: string, tokenOut: string): string {
  return `${lowerAddress(tokenIn)}\u001f${lowerAddress(tokenOut)}`;
}
