import { ethers } from "ethers";

/**
 * Compound V2 cToken surfaces used by the share-redemption capability.
 * Only redemption-side functions are declared: borrow / repay / liquidation /
 * collateral management are deliberately absent from this family.
 */
export const CTOKEN_INTERFACE = new ethers.Interface([
  "function comptroller() view returns (address)",
  "function underlying() view returns (address)",
  "function exchangeRateStored() view returns (uint256)",
  "function exchangeRateCurrent() returns (uint256)",
  "function getCash() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function balanceOfUnderlying(address) returns (uint256)",
  "function redeem(uint256) returns (uint256)",
  "function redeemUnderlying(uint256) returns (uint256)",
  // Compound V2 cToken Redeem carries NO indexed parameters: every real log has
  // exactly one topic (topic0) plus 96 data bytes. Declaring `redeemer` indexed
  // made decodeEventLog throw on every real log, leaving the landed-log channel
  // inert (discovery still worked through the call patterns).
  "event Redeem(address redeemer,uint256 redeemAmount,uint256 redeemTokens)",
]);

/** The Comptroller is the on-chain registry that admits a market. */
export const COMPTROLLER_INTERFACE = new ethers.Interface([
  "function markets(address) view returns (bool,uint256,uint256)",
  "function getAllMarkets() view returns (address[])",
]);

export const CT_ERC20_INTERFACE = new ethers.Interface([
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);

export const CTOKEN_REDEEM_SELECTOR = CTOKEN_INTERFACE.getFunction("redeem")!
  .selector as `0x${string}`;
export const CTOKEN_REDEEM_UNDERLYING_SELECTOR = CTOKEN_INTERFACE
  .getFunction("redeemUnderlying")!.selector as `0x${string}`;
export const CTOKEN_REDEEM_TOPIC = CTOKEN_INTERFACE.getEvent("Redeem")!
  .topicHash.toLowerCase();

export const CTOKEN_REDEEM_CALL_PATTERN_ID = "compound-ctoken-redeem-call";
export const CTOKEN_REDEEM_UNDERLYING_CALL_PATTERN_ID =
  "compound-ctoken-redeem-underlying-call";
export const CTOKEN_REDEEM_LOG_PATTERN_ID = "compound-ctoken-redeem-log";
export const CTOKEN_SURFACE_PATTERN_ID = "compound-ctoken-comptroller-surface";

/** Sample share amounts for the family's specified-amount quote contracts. */
export const CTOKEN_SAMPLE_SHARES = [10n ** 6n, 10n ** 18n] as const;

/** cToken exchange rates are mantissa-scaled: underlying = shares * rate / 1e18. */
export const CTOKEN_EXCHANGE_RATE_SCALE = 10n ** 18n;
