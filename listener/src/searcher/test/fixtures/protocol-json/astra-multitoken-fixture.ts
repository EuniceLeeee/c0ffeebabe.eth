import { ethers } from "ethers";

// Recorded protocol ABI used by the independent fixture transport.
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
export const ASTRA_MULTITOKEN_CHANGE_CALL_PATTERN_ID = "astra-multitoken-change-call";
export const ASTRA_MULTITOKEN_CHANGE_LOG_PATTERN_ID = "astra-multitoken-change-log";
