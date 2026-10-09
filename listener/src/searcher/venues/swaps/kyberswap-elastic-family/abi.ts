import { ethers } from "ethers";

/**
 * KyberSwap Elastic Pool surfaces (solc 0.8.9). Only the reads this family
 * proves and the single routed entry point `swap` are declared: `mint`,
 * `burn`, `burnRTokens`, `flash`, position management and the pool oracle are
 * deliberately absent.
 */
export const KYSWAP_POOL_INTERFACE = new ethers.Interface([
  "function factory() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function swapFeeUnits() view returns (uint24)",
  "function tickDistance() view returns (int24)",
  "function getPoolState() view returns (uint160 sqrtP, int24 currentTick, int24 nearestCurrentTick, bool locked)",
  "function getLiquidityState() view returns (uint128 baseL, uint128 reinvestL, uint128 reinvestLLast)",
  "function initializedTicks(int24) view returns (int24 previous, int24 next)",
  "function swap(address recipient, int256 swapQty, bool isToken0, uint160 limitSqrtP, bytes data) returns (int256 deltaQty0, int256 deltaQty1)",
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtP, uint128 liquidity, int24 tick)",
  "event Mint(address indexed sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "event BurnRTokens(address indexed owner, uint256 qty, uint256 qty0, uint256 qty1)",
]);

/** The Elastic factory is addressed by the pool's own `factory()` read. */
export const KYSWAP_FACTORY_INTERFACE = new ethers.Interface([
  "function getPool(address tokenA, address tokenB, uint24 feeUnits) view returns (address pool)",
]);

/**
 * Callback the pool invokes on `msg.sender`; the pool pulls the input token from
 * the callback scope (selector `0xfa483e72`, keccak-verified against the cached
 * `contracts/interfaces/callback/ISwapCallback.sol`).
 */
export const KYSWAP_CALLBACK_INTERFACE = new ethers.Interface([
  "function swapCallback(int256 deltaQty0, int256 deltaQty1, bytes data)",
]);

export const KYSWAP_SWAP_SELECTOR = KYSWAP_POOL_INTERFACE.getFunction("swap")!
  .selector as `0x${string}`;
export const KYSWAP_SWAP_TOPIC = KYSWAP_POOL_INTERFACE.getEvent("Swap")!
  .topicHash.toLowerCase();
export const KYSWAP_MINT_TOPIC = KYSWAP_POOL_INTERFACE.getEvent("Mint")!
  .topicHash.toLowerCase();
export const KYSWAP_BURN_TOPIC = KYSWAP_POOL_INTERFACE.getEvent("Burn")!
  .topicHash.toLowerCase();
export const KYSWAP_BURN_RTOKENS_TOPIC = KYSWAP_POOL_INTERFACE
  .getEvent("BurnRTokens")!.topicHash.toLowerCase();

export const KYSWAP_SWAP_CALL_PATTERN_ID = "kyberswap-elastic-swap-call";
export const KYSWAP_SWAP_LOG_PATTERN_ID = "kyberswap-elastic-swap-log";
export const KYSWAP_MUTATION_LOG_PATTERN_ID =
  "kyberswap-elastic-liquidity-log";
export const KYSWAP_SURFACE_PATTERN_ID = "kyberswap-elastic-pool-surface";

/**
 * `MathConstants.FEE_UNITS` of the verified pool source: fee units are
 * hundred-thousandths, and a pool fee of 300 is 0.3%.
 */
export const KYSWAP_FEE_UNITS = 100_000n;
/** `MathConstants.TWO_FEE_UNITS` (the source doubles the fee unit base). */
export const KYSWAP_TWO_FEE_UNITS = 200_000n;
/** `MathConstants.TWO_POW_96`. */
export const KYSWAP_TWO_POW_96 = 2n ** 96n;
/**
 * `MathConstants.MAX_TICK_DISTANCE`: a single swap step never travels further
 * than 480 ticks from the current tick, so the step target is capped by it.
 */
export const KYSWAP_MAX_TICK_DISTANCE = 480;
/** Fixed swap-call calldata offsets (`recipient, swapQty, isToken0, limit, bytes`). */
export const KYSWAP_SWAP_QTY_OFFSET = 36;
export const KYSWAP_SWAP_DATA_LENGTH_OFFSET = 164;
export const KYSWAP_SWAP_DATA_OFFSET = 196;
/** `swapCallback(int256,int256,bytes)` head is three words: the bytes content
 * starts at 4 + 3 * 32 + 32. */
export const KYSWAP_CALLBACK_DATA_OFFSET = 132;
/** Callback debt word offsets: `deltaQty0` first, then `deltaQty1`. */
export const KYSWAP_DELTA0_OFFSET = 4;
export const KYSWAP_DELTA1_OFFSET = 36;
