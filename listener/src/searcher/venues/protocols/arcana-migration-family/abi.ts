import { ethers } from "ethers";

export const ARCANA_SOURCE_INTERFACE = new ethers.Interface([
  "function lockAndBridge(bytes32 tokenId, uint256 amount, address recipient) payable returns (bytes32 messageId, uint256 arcAmount)",
  "function previewArcAmount(bytes32 tokenId, uint256 amount) view returns (uint256)",
  "function tokenConfigs(bytes32 tokenId) view returns (address token, uint8 tokenDecimals, uint256 tokenTwapValue, uint256 tokenMultiplier, uint256 maxMigratableAmount, uint256 migrationWindow, bool burnOnMigration, bool enabled)",
  "function MULTIPLIER_SCALE() view returns (uint256)",
  "function publicMigrationEnabled() view returns (bool)",
  "function bridgeEnabled() view returns (bool)",
  "function destinationReceiver() view returns (address)",
  "function totalLocked(bytes32 tokenId) view returns (uint256)",
  "event MigrationLocked(bytes32 indexed tokenId, address indexed account, address indexed recipient, address token, uint256 amount, uint256 arcAmount, uint256 nonce, bytes32 messageId)",
]);

export const ARCANA_DESTINATION_INTERFACE = new ethers.Interface([
  "function arc() view returns (address)",
  "function receiveMigration(bytes payload)",
]);

export const ARCANA_TOKEN_INTERFACE = new ethers.Interface([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);
