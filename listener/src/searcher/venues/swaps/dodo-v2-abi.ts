import { ethers } from "ethers";

export const DODO_V2_POOL_INTERFACE = new ethers.Interface([
  "function _BASE_TOKEN_() view returns (address)",
  "function _QUOTE_TOKEN_() view returns (address)",
  "function _BASE_RESERVE_() view returns (uint256)",
  "function _QUOTE_RESERVE_() view returns (uint256)",
  "function getPMMStateForCall() view returns (uint256 i,uint256 K,uint256 B,uint256 Q,uint256 B0,uint256 Q0,uint256 R)",
  "function getUserFeeRate(address user) view returns (uint256 lpFeeRate,uint256 mtFeeRate)",
  "function getBaseInput() view returns (uint256 input)",
  "function getQuoteInput() view returns (uint256 input)",
  "function getMtFeeTotal() view returns (uint256 mtFeeBase,uint256 mtFeeQuote)",
  "function querySellBase(address trader,uint256 payBaseAmount) view returns (uint256 receiveQuoteAmount)",
  "function querySellQuote(address trader,uint256 payQuoteAmount) view returns (uint256 receiveBaseAmount)",
  "function sellBase(address to) returns (uint256 receiveQuoteAmount)",
  "function sellQuote(address to) returns (uint256 receiveBaseAmount)",
]);

export const DODO_V2_REGISTRY_INTERFACE = new ethers.Interface([
  "function getDODOPool(address baseToken,address quoteToken) view returns (address[] pools)",
]);

export const DODO_V2_ERC20_INTERFACE = new ethers.Interface([
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

export const DODO_V2_EVENT_INTERFACE = new ethers.Interface([
  "event DODOSwap(address fromToken,address toToken,uint256 fromAmount,uint256 toAmount,address trader,address receiver)",
]);

export const DODO_V2_SWAP_TOPIC = DODO_V2_EVENT_INTERFACE.getEvent(
  "DODOSwap",
)!.topicHash.toLowerCase() as `0x${string}`;

export const DODO_V2_SELL_BASE_SELECTOR = DODO_V2_POOL_INTERFACE.getFunction(
  "sellBase",
)!.selector.toLowerCase() as `0x${string}`;

export const DODO_V2_SELL_QUOTE_SELECTOR = DODO_V2_POOL_INTERFACE.getFunction(
  "sellQuote",
)!.selector.toLowerCase() as `0x${string}`;

/** Canonical DODO registry singletons are identity roots, never pool allowlists. */
export const DODO_V2_REGISTRIES = Object.freeze([
  ethers.getAddress("0x72d220cE168C4f361dD4deE5D826a01AD8598f6C"),
  ethers.getAddress("0x5336edE8F971339F6c0e304c66ba16F1296A2Fbe"),
  ethers.getAddress("0x6fdDB76c93299D985f4d3FC7ac468F9A168577A4"),
]);
