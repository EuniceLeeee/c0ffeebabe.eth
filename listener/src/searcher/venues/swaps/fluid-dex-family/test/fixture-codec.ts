import { familyId, lineageId } from "../../../adapter-family-identifiers.js";
import { ethers } from "ethers";
import type { IdentityAssetDeclaration } from "../../../../identity-asset-metadata.js";

// Fluid's protocol identifier, not an ERC20 or a graph token address.
export const FLUID_DEX_NATIVE_TOKEN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
export function isFluidDexNative(token: string): boolean {
  return sameAddress(token, FLUID_DEX_NATIVE_TOKEN);
}
export function fluidDexAsset(key: string, token: string): IdentityAssetDeclaration {
  return isFluidDexNative(token) ? { key, kind: "native" }
    : { key, kind: "erc20", address: ethers.getAddress(token) };
}

export const FLUID_DEX_ADDRESS_DEAD = ethers.getAddress(
  "0x000000000000000000000000000000000000dEaD",
);
export const FLUID_DEX_SWAP_TOPIC =
  "0xdc004dbca4ef9c966218431ee5d9133d337ad018dd5b5c5493722803f75c64f7";

export const FLUID_DEX_INTERFACE = new ethers.Interface([
  "function swapIn(bool swap0to1_, uint256 amountIn_, uint256 amountOutMin_, address to_) payable returns (uint256 amountOut_)",
  "error FluidDexSwapResult(uint256 amountOut)",
  "error FluidDexError(uint256 errorId)",
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

export const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();


export const FLUID_DEX_FAMILY_ID = familyId("fluid-dex");
export const FLUID_DEX_FACTORY_LINEAGE_ID = lineageId(
  "fluid-dex:factory-child",
);
