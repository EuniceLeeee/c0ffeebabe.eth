import { ethers } from "ethers";

export const ROCKSOLID_INTERFACE = new ethers.Interface([
  "function convertToShares(uint256 assets) view returns (uint256 shares)",
  "function syncDeposit(uint256 assets,address receiver,address referral) returns (uint256 shares)",
]);

export const ROCKSOLID_SAMPLE = 10n ** 18n;
