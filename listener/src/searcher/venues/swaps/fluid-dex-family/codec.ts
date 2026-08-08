import { ethers } from "ethers";
import type { AdapterRequestResult } from "../../adapter-request-program.js";

export const FLUID_DEX_ADDRESS_DEAD = ethers.getAddress(
  "0x000000000000000000000000000000000000dEaD",
);
export const FLUID_DEX_SWAP_TOPIC =
  "0xdc004dbca4ef9c966218431ee5d9133d337ad018dd5b5c5493722803f75c64f7";

export const FLUID_DEX_INTERFACE = new ethers.Interface([
  "function swapIn(bool swap0to1_, uint256 amountIn_, uint256 amountOutMin_, address to_) payable returns (uint256 amountOut_)",
  "error FluidDexSwapResult(uint256 amountOut)",
]);
export const FLUID_DEX_SWAP_SELECTOR = FLUID_DEX_INTERFACE.getFunction(
  "swapIn",
)!.selector.toLowerCase() as `0x${string}`;

export const FLUID_DEX_CONSTANTS_INTERFACE = new ethers.Interface([
  "function constantsView() view returns ((uint256 dexId,address liquidity,address factory,(address shift,address admin,address colOperations,address debtOperations,address perfectOperationsAndSwapOut) implementations,address deployerContract,address token0,address token1,bytes32 supplyToken0Slot,bytes32 borrowToken0Slot,bytes32 supplyToken1Slot,bytes32 borrowToken1Slot,bytes32 exchangePriceToken0Slot,bytes32 exchangePriceToken1Slot,uint256 oracleMapping) constantsView_)",
]);
export const FLUID_DEX_FACTORY_INTERFACE = new ethers.Interface([
  "function getDexAddress(uint256 dexId) view returns (address)",
]);
export const FLUID_DEX_ERC20_INTERFACE = new ethers.Interface([
  "function decimals() view returns (uint8)",
]);

export interface FluidDexConstants {
  readonly dexId: bigint;
  readonly factory: string;
  readonly token0: string;
  readonly token1: string;
}

export function canonicalAddress(value: string): string {
  return ethers.getAddress(value);
}

export function lowerAddress(value: string): string {
  return canonicalAddress(value).toLowerCase();
}

export function sameAddress(left: string, right: string): boolean {
  return lowerAddress(left) === lowerAddress(right);
}

export function requireSuccessfulResult(
  results: readonly AdapterRequestResult[],
  id: string,
): Extract<AdapterRequestResult, { readonly ok: true }> {
  const result = results.find((candidate) => candidate.id === id);
  if (result === undefined) throw new Error(`fluid-dex result ${id} is missing`);
  if (!result.ok) throw new Error(`fluid-dex unresolved: ${result.failure}`);
  return result;
}

export function decodeFluidDexConstants(data: string): FluidDexConstants {
  const decoded = FLUID_DEX_CONSTANTS_INTERFACE.decodeFunctionResult(
    "constantsView",
    data,
  )[0] as {
    readonly dexId: bigint;
    readonly factory: string;
    readonly token0: string;
    readonly token1: string;
  };
  const constants = Object.freeze({
    dexId: BigInt(decoded.dexId),
    factory: canonicalAddress(decoded.factory),
    token0: canonicalAddress(decoded.token0),
    token1: canonicalAddress(decoded.token1),
  });
  if (
    constants.dexId <= 0n ||
    constants.factory === ethers.ZeroAddress ||
    constants.token0 === ethers.ZeroAddress ||
    constants.token1 === ethers.ZeroAddress ||
    sameAddress(constants.token0, constants.token1)
  ) {
    throw new Error("fluid-dex constantsView returned an invalid binding");
  }
  return constants;
}

export function decodeAddressResult(data: string, functionName: string): string {
  const iface = functionName === "getDexAddress"
    ? FLUID_DEX_FACTORY_INTERFACE
    : (() => { throw new Error(`unsupported address decoder ${functionName}`); })();
  return canonicalAddress(String(iface.decodeFunctionResult(functionName, data)[0]));
}

export function decodeDecimals(data: string): number {
  const decimals = Number(
    FLUID_DEX_ERC20_INTERFACE.decodeFunctionResult("decimals", data)[0],
  );
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error(`fluid-dex token returned invalid decimals ${decimals}`);
  }
  return decimals;
}

/**
 * Fluid's ADDRESS_DEAD path succeeds only through its declared custom-error
 * payload. An ordinary return, unknown error or malformed revert is not quote
 * evidence and must never be promoted into a price.
 */
export function decodeDeclaredFluidDexQuote(
  result: Extract<AdapterRequestResult, { readonly ok: true }>,
): bigint | null {
  if (result.completion !== "reverted-as-declared") return null;
  if (!/^0x[0-9a-fA-F]{72}$/.test(result.data)) return null;
  const expected = FLUID_DEX_INTERFACE.getError(
    "FluidDexSwapResult",
  )!.selector.toLowerCase();
  if (result.data.slice(0, 10).toLowerCase() !== expected) return null;
  try {
    const amountOut = BigInt(
      FLUID_DEX_INTERFACE.decodeErrorResult(
        "FluidDexSwapResult",
        result.data,
      )[0],
    );
    return amountOut > 0n ? amountOut : null;
  } catch {
    return null;
  }
}

export function assertSource(
  actual: Extract<AdapterRequestResult, { readonly ok: true }>["source"],
  expected: Extract<AdapterRequestResult, { readonly ok: true }>["source"],
): void {
  if (
    actual.number !== expected.number ||
    actual.generation !== expected.generation ||
    actual.hash.toLowerCase() !== expected.hash.toLowerCase()
  ) {
    throw new Error("fluid-dex quote came from a foreign source");
  }
}
