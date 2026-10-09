import { ethers } from "ethers";
import { canonicalAddress } from "../standard-family/common.js";

/**
 * Yield Basis `LT.vy` (Vyper 0.4.3) surfaces used by the single-asset
 * crypto-redemption capability.
 *
 * SUPPORTED entry point (the only one this family routes):
 *   withdraw(uint256 shares, uint256 min_assets) -> uint256 crypto_received
 * `withdraw(uint256,uint256,address)` is the same call with an explicit
 * receiver; it is declared here as OBSERVED evidence only (see discovery.ts)
 * so the negative contracts can prove it is never routed.
 *
 * DECLARED-ONLY, NOT IMPLEMENTED AS A ROUTE:
 *   deposit(uint256 assets, uint256 debt, uint256 min_shares[, address receiver])
 *     The caller pays crypto; the stablecoin is pulled from the LT's AMM,
 *     not from the caller. `debt` is an internal AMM parameter, not evidence
 *     of a second caller-funded input. Supporting this direction still needs
 *     a validated amount/debt policy, quote and dual execution implementation.
 * EXCLUDED DIFFERENT SEMANTICS (chain evidence in the family report):
 *   emergency_withdraw(uint256 shares[, address receiver[, address owner]])
 *     -> (uint256 assets, int256 stables) : two outputs, the second SIGNED.
 *     The LT source states it "does not necessarily work as single asset
 *     withdrawal" and specifies no minimal output, and the caller may have to
 *     bring stablecoins IN (negative second return value). The framework route
 *     shape (one tokenIn -> one tokenOut) cannot express that, so both are
 *     excluded before any route is projected.
 */
export const LT_INTERFACE = new ethers.Interface([
  "function ASSET_TOKEN() view returns (address)",
  "function STABLECOIN() view returns (address)",
  "function CRYPTOPOOL() view returns (address)",
  "function amm() view returns (address)",
  "function staker() view returns (address)",
  "function agg() view returns (address)",
  "function admin() view returns (address)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function pricePerShare() view returns (uint256)",
  "function is_killed() view returns (bool)",
  "function liquidity() view returns (int256,uint256,uint256,uint256)",
  "function updated_balances() view returns (uint256,uint256)",
  "function preview_withdraw(uint256) view returns (uint256)",
  "function preview_emergency_withdraw(uint256) view returns (uint256,int256)",
  "function withdraw(uint256,uint256) returns (uint256)",
  "function withdraw(uint256,uint256,address) returns (uint256)",
  "function deposit(uint256,uint256,uint256) returns (uint256)",
  "function deposit(uint256,uint256,uint256,address) returns (uint256)",
  "function emergency_withdraw(uint256) returns (uint256,int256)",
  "function emergency_withdraw(uint256,address) returns (uint256,int256)",
  "function emergency_withdraw(uint256,address,address) returns (uint256,int256)",
  "event Deposit(address indexed sender,address indexed owner,uint256 assets,uint256 shares)",
  "event Withdraw(address indexed sender,address indexed receiver,address indexed owner,uint256 assets,uint256 shares)",
]);

/**
 * The LevAMM contract the LT itself names via `amm()`. `LT_CONTRACT()` is the
 * reverse pointer: this family's identity proof requires the AMM named by the
 * LT to name the SAME LT back (see identity.ts). No `factory()` exists on the
 * LT, so this mutual reference replaces the factory-child relation.
 */
export const LEVAMM_INTERFACE = new ethers.Interface([
  "function LT_CONTRACT() view returns (address)",
  "function COLLATERAL() view returns (address)",
  "function STABLECOIN() view returns (address)",
  "function PRICE_ORACLE_CONTRACT() view returns (address)",
  "function is_killed() view returns (bool)",
  "function get_state() view returns (uint256,uint256,uint256)",
  "function collateral_amount() view returns (uint256)",
  "function get_debt() view returns (uint256)",
  "function max_debt() view returns (uint256)",
  "function value_oracle() view returns (uint256,uint256)",
  "function fee() view returns (uint256)",
]);

/**
 * The Curve cryptoswap pool the LT names via `CRYPTOPOOL()`. `coins(0)` is the
 * stablecoin leg and `coins(1)` the crypto leg (the LT source builds it with
 * `add_liquidity([debt, assets], ...)`); both are cross-checked against the
 * LT's own immutables during identity.
 */
export const CRYPTOPOOL_INTERFACE = new ethers.Interface([
  "function coins(uint256) view returns (address)",
  "function balances(uint256) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint256)",
  "function price_scale() view returns (uint256)",
  "function lp_price() view returns (uint256)",
  "function calc_withdraw_fixed_out(uint256,uint256,uint256) view returns (uint256)",
]);

export const ERC20_INTERFACE = new ethers.Interface([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
]);

export const LT_WITHDRAW_SELECTOR = LT_INTERFACE.getFunction("withdraw(uint256,uint256)")!
  .selector as `0x${string}`;
export const LT_WITHDRAW_RECEIVER_SELECTOR = LT_INTERFACE
  .getFunction("withdraw(uint256,uint256,address)")!.selector as `0x${string}`;
export const LT_DEPOSIT_SELECTOR = LT_INTERFACE
  .getFunction("deposit(uint256,uint256,uint256)")!.selector as `0x${string}`;
export const LT_EMERGENCY_WITHDRAW_SELECTOR = LT_INTERFACE
  .getFunction("emergency_withdraw(uint256)")!.selector as `0x${string}`;
export const LT_WITHDRAW_TOPIC = LT_INTERFACE.getEvent("Withdraw")!
  .topicHash.toLowerCase();
export const LT_DEPOSIT_TOPIC = LT_INTERFACE.getEvent("Deposit")!
  .topicHash.toLowerCase();

export const LT_WITHDRAW_CALL_PATTERN_ID = "yieldbasis-lt-withdraw-call";
export const LT_WITHDRAW_RECEIVER_CALL_PATTERN_ID =
  "yieldbasis-lt-withdraw-receiver-call";
export const LT_WITHDRAW_LOG_PATTERN_ID = "yieldbasis-lt-withdraw-log";
export const LT_SURFACE_PATTERN_ID = "yieldbasis-lt-levamm-surface";

/**
 * Read-only behaviour probe amount for the active identity round: one whole
 * share unit. Verified to succeed on all three production instances at the
 * pinned blocks (yb-WETH -> 1005642419965475619 wei WETH at 26030452), whereas
 * sub-share probes revert in the cryptopool (`!tokens`).
 */
export const LT_PROBE_SHARES = 10n ** 18n;

/**
 * `MIN_SHARE_REMAINDER: constant(uint256) = 10**6` from LT.vy. `withdraw`
 * asserts `supply >= MIN_SHARE_REMAINDER + shares or supply == shares`; the
 * quote enforces the same rule so it can never quote a call that would revert.
 */
export const LT_MIN_SHARE_REMAINDER = 10n ** 6n;

/** LT shares are 18 decimals (`decimals: public(constant(uint8)) = 18`). */
export const LT_SHARE_DECIMALS = 18;

/** Fixed probe actor for read-only identity/quote calls (never an allowlist). */
export const LT_PROBE_ACTOR = canonicalAddress(`0x${"00".repeat(18)}face`);

/** Sample share amounts for this family's specified-amount quote contracts. */
export const LT_SAMPLE_SHARES = [10n ** 18n, 10n ** 16n] as const;
