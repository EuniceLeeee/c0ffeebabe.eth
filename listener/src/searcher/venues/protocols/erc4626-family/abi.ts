import { ethers } from "ethers";
import { canonicalAddress } from "../standard-family/common.js";

export const ERC4626_INTERFACE = new ethers.Interface([
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function convertToShares(uint256 assets) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function previewDeposit(uint256 assets) view returns (uint256)",
  "function previewRedeem(uint256 shares) view returns (uint256)",
  "function deposit(uint256 assets,address receiver) returns (uint256 shares)",
  "function redeem(uint256 shares,address receiver,address owner) returns (uint256 assets)",
  "event Deposit(address indexed sender,address indexed owner,uint256 assets,uint256 shares)",
  "event Withdraw(address indexed sender,address indexed receiver,address indexed owner,uint256 assets,uint256 shares)",
]);

export const ERC4626_ERC20_INTERFACE = new ethers.Interface([
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function approve(address spender,uint256 amount) returns (bool)",
]);

export const ERC4626_PROBE_ACTOR = canonicalAddress(
  `0x${"00".repeat(18)}face`,
);
export const ERC4626_SAMPLE_AMOUNTS = [10n ** 6n, 10n ** 18n] as const;
export const ERC4626_DEPOSIT_CALL_PATTERN_ID = "erc4626-deposit-call";
export const ERC4626_REDEEM_CALL_PATTERN_ID = "erc4626-redeem-call";
export const ERC4626_DEPOSIT_LOG_PATTERN_ID = "erc4626-deposit-log";
export const ERC4626_WITHDRAW_LOG_PATTERN_ID = "erc4626-withdraw-log";
export const ERC4626_SURFACE_PATTERN_ID = "erc4626-standard-surface";
export const ERC4626_DEPOSIT_TOPIC = ERC4626_INTERFACE
  .getEvent("Deposit")!.topicHash.toLowerCase();
export const ERC4626_WITHDRAW_TOPIC = ERC4626_INTERFACE
  .getEvent("Withdraw")!.topicHash.toLowerCase();
