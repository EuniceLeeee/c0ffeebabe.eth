import { ethers } from "ethers";

export const MELLOW_QUEUE_INTERFACE = new ethers.Interface([
  "function name() view returns (string)",
  "function asset() view returns (address)",
  "function vault() view returns (address)",
  "function syncDepositParams() view returns (uint256 penaltyD6, uint32 maxAge)",
  "function syncRedeemParams() view returns (uint256 penaltyD6, uint32 maxAge, uint256 usage, uint256 dailyLimit, uint256 latestRequestTimestamp)",
  "function remainingDailyLimit() view returns (uint256 usage, uint256 remainingDailyLimit)",
  "function getLiquidAssets() view returns (uint256)",
  "function deposit(uint224 assets, address referral, bytes32[] merkleProof)",
  "function redeem(uint256 shares, address receiver)",
  "event Deposited(address indexed caller, address indexed referral, uint224 assets, uint256 shares, uint256 feeShares)",
  "event Redeemed(address indexed caller, uint256 shares, uint256 assets, uint256 feeShares)",
]);

export const MELLOW_VAULT_INTERFACE = new ethers.Interface([
  "function assetAt(uint256) view returns (address)",
  "function feeManager() view returns (address)",
  "function getLiquidAssets() view returns (uint256)",
  "function hasQueue(address) view returns (bool)",
  "function isDepositQueue(address) view returns (bool)",
  "function oracle() view returns (address)",
  "function shareManager() view returns (address)",
]);

export const MELLOW_ORACLE_INTERFACE = new ethers.Interface([
  "function getReport(address asset) view returns (uint224 priceD18, uint32 timestamp, bool isSuspicious)",
]);

export const MELLOW_FEE_MANAGER_INTERFACE = new ethers.Interface([
  "function calculateDepositFee(uint256 shares) view returns (uint256)",
  "function calculateRedeemFee(uint256 shares) view returns (uint256)",
]);

export const MELLOW_SHARE_INTERFACE = new ethers.Interface([
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
