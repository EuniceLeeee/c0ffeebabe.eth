import { ethers } from "ethers";
import type { AdapterRequestResult } from "../../adapter-request-program.js";

export const FLUID_CREDIT_PROBE_ACTOR = ethers.getAddress(
  "0x000000000000000000000000000000000000f1d2",
);

export const FLUID_VAULT_INTERFACE = new ethers.Interface([
  "function constantsView() view returns ((address liquidity,address factory,address adminImplementation,address secondaryImplementation,address supplyToken,address borrowToken,uint8 supplyDecimals,uint8 borrowDecimals,uint256 vaultId,bytes32 liquiditySupplyExchangePriceSlot,bytes32 liquidityBorrowExchangePriceSlot,bytes32 liquidityUserSupplySlot,bytes32 liquidityUserBorrowSlot) constantsView_)",
  "function operate(uint256 nftId,int256 newCol,int256 newDebt,address to) payable returns (uint256,int256,int256)",
]);
export const FLUID_VAULT_OPERATE_SELECTOR = FLUID_VAULT_INTERFACE.getFunction(
  "operate",
)!.selector.toLowerCase() as `0x${string}`;
export const FLUID_VAULT_FACTORY_INTERFACE = new ethers.Interface([
  "function getVaultAddress(uint256 vaultId) view returns (address)",
]);
export const FLUID_ERC20_INTERFACE = new ethers.Interface([
  "function approve(address spender,uint256 amount) returns (bool)",
]);

export interface FluidVaultConstants {
  readonly factory: string;
  readonly supplyToken: string;
  readonly borrowToken: string;
  readonly supplyDecimals: number;
  readonly borrowDecimals: number;
  readonly vaultId: bigint;
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
  if (result === undefined) throw new Error(`fluid-credit result ${id} is missing`);
  if (!result.ok) throw new Error(`fluid-credit unresolved: ${result.failure}`);
  if (result.completion !== "returned") {
    throw new Error(`fluid-credit ${id} unexpectedly completed by revert`);
  }
  return result;
}

export function decodeFluidVaultConstants(data: string): FluidVaultConstants {
  const decoded = FLUID_VAULT_INTERFACE.decodeFunctionResult(
    "constantsView",
    data,
  )[0] as {
    readonly factory: string;
    readonly supplyToken: string;
    readonly borrowToken: string;
    readonly supplyDecimals: bigint;
    readonly borrowDecimals: bigint;
    readonly vaultId: bigint;
  };
  const constants = Object.freeze({
    factory: canonicalAddress(decoded.factory),
    supplyToken: canonicalAddress(decoded.supplyToken),
    borrowToken: canonicalAddress(decoded.borrowToken),
    supplyDecimals: Number(decoded.supplyDecimals),
    borrowDecimals: Number(decoded.borrowDecimals),
    vaultId: BigInt(decoded.vaultId),
  });
  if (
    constants.factory === ethers.ZeroAddress ||
    constants.supplyToken === ethers.ZeroAddress ||
    constants.borrowToken === ethers.ZeroAddress ||
    sameAddress(constants.supplyToken, constants.borrowToken) ||
    !validDecimals(constants.supplyDecimals) ||
    !validDecimals(constants.borrowDecimals) ||
    constants.vaultId <= 0n
  ) {
    throw new Error("fluid-credit constantsView returned an invalid binding");
  }
  return constants;
}

export function decodeFactoryVault(data: string): string {
  return canonicalAddress(String(
    FLUID_VAULT_FACTORY_INTERFACE.decodeFunctionResult(
      "getVaultAddress",
      data,
    )[0],
  ));
}

export function decodeOperateResult(data: string): {
  readonly nftId: bigint;
  readonly finalSupply: bigint;
  readonly finalBorrow: bigint;
} {
  const decoded = FLUID_VAULT_INTERFACE.decodeFunctionResult("operate", data);
  return Object.freeze({
    nftId: BigInt(decoded[0]),
    finalSupply: BigInt(decoded[1]),
    finalBorrow: BigInt(decoded[2]),
  });
}

export function tokenDelta(
  result: Extract<AdapterRequestResult, { readonly ok: true }>,
  token: string,
  account: string,
): bigint | null {
  const matches = result.effects?.tokenDeltas?.filter((delta) =>
    sameAddress(delta.token, token) && sameAddress(delta.account, account)
  ) ?? [];
  if (matches.length !== 1) return null;
  return matches[0].delta;
}

export function fluidDebtAmount(input: {
  readonly collateralAmount: bigint;
  readonly debtBps: bigint;
  readonly supplyDecimals: number;
  readonly borrowDecimals: number;
}): bigint {
  if (input.collateralAmount < 0n || input.debtBps < 0n) {
    throw new Error("fluid-credit risk inputs cannot be negative");
  }
  let amount = input.collateralAmount * input.debtBps / 10_000n;
  const decimalDelta = input.supplyDecimals - input.borrowDecimals;
  if (decimalDelta > 0) amount /= 10n ** BigInt(decimalDelta);
  else if (decimalDelta < 0) amount *= 10n ** BigInt(-decimalDelta);
  return amount;
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
    throw new Error("fluid-credit evidence came from a foreign source");
  }
}

function validDecimals(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 36;
}
