import { ethers } from "ethers";

export const TELLER_INTERFACE = new ethers.Interface([
  "function vault() view returns (address)",
  "function accountant() view returns (address)",
  "function isPaused() view returns (bool)",
  "function shareLockPeriod() view returns (uint64)",
  "function isSupported(address asset) view returns (bool)",
  "function bulkWithdraw(address withdrawAsset, uint256 shareAmount, uint256 minAssetsOut, address receiver)",
]);

export const ACCOUNTANT_INTERFACE = new ethers.Interface([
  "function vault() view returns (address)",
  "function base() view returns (address)",
  "function getRate() view returns (uint256)",
  "function getRateInQuoteSafe(address quote) view returns (uint256)",
]);

export const VAULT_INTERFACE = new ethers.Interface([
  "function authority() view returns (address)",
  "function hook() view returns (address)",
]);

export const ERC20_INTERFACE = new ethers.Interface([
  "function decimals() view returns (uint8)",
]);
