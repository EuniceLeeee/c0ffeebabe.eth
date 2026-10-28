import { ethers } from "ethers";

/**
 * Algebra Integral 1.2.1 pool surface (`contract AlgebraPool`, solc 0.8.20),
 * taken from the verified metadata of the observed instance
 * 0x76a278bd71f566ee6ba2fe438f6099c8d8f98f43. Only the 40-function surface
 * actually read or called by this family is declared here.
 */
export const ALGEBRA_POOL_INTERFACE = new ethers.Interface([
  "function swap(address recipient, bool zeroToOne, int256 amountRequired, uint160 limitSqrtPrice, bytes data) returns (int256 amount0, int256 amount1)",
  "function factory() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function plugin() view returns (address)",
  "function fee() view returns (uint16)",
  "function tickSpacing() view returns (int24)",
  "function liquidity() view returns (uint128)",
  "function nextTickGlobal() view returns (int24)",
  "function prevTickGlobal() view returns (int24)",
  "function globalState() view returns (uint160 price, int24 tick, uint16 lastFee, uint8 pluginConfig, uint16 communityFee, bool unlocked)",
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 price, uint128 liquidity, int24 tick, uint24 overrideFee, uint24 pluginFee)",
  "event Initialize(uint160 price, int24 tick)",
  "event Mint(address sender, address indexed owner, int24 indexed bottomTick, int24 indexed topTick, uint128 liquidityAmount, uint256 amount0, uint256 amount1)",
  "event Burn(address indexed owner, int24 indexed bottomTick, int24 indexed topTick, uint128 liquidityAmount, uint256 amount0, uint256 amount1, uint24 pluginFee)",
  "event Fee(uint16 fee)",
  "event Plugin(address newPluginAddress)",
  "event PluginConfig(uint8 newPluginConfig)",
  "event TickSpacing(int24 newTickSpacing)",
  "event CommunityFee(uint16 communityFeeNew)",
]);

/**
 * Algebra factory surface. `poolByPair` is the reverse-binding admission source:
 * the identity variant reads it and requires it to return the candidate pool.
 * Like UniV3's `getPool`, it reverts when no pool exists for the pair, so an
 * empty/reverting answer is chain-proven negative evidence.
 */
export const ALGEBRA_FACTORY_INTERFACE = new ethers.Interface([
  "function poolByPair(address tokenA, address tokenB) view returns (address pool)",
  "event Pool(address indexed token0, address indexed token1, address pool)",
]);

export const ALGEBRA_INTEGRAL_ADAPTER_ID = "algebra-integral-swap";

/** Family-owned log/call pattern ids (declared by this family only). */
export const ALGEBRA_FACTORY_POOL_PATTERN_ID = "algebra-integral-factory-pool";
export const ALGEBRA_SWAP_LOG_PATTERN_ID = "algebra-integral-pool-swap-log";
export const ALGEBRA_INITIALIZE_LOG_PATTERN_ID =
  "algebra-integral-pool-initialize-log";
export const ALGEBRA_MINT_LOG_PATTERN_ID = "algebra-integral-pool-mint-log";
export const ALGEBRA_BURN_LOG_PATTERN_ID = "algebra-integral-pool-burn-log";
export const ALGEBRA_SWAP_CALL_PATTERN_ID = "algebra-integral-pool-swap-call";
export const ALGEBRA_POOL_SURFACE_PATTERN_ID = "algebra-integral-pool-surface";

export const ALGEBRA_SWAP_SELECTOR = selectorOf("swap") as `0x${string}`;
export const ALGEBRA_SWAP_TOPIC = topicOf(ALGEBRA_POOL_INTERFACE, "Swap");
export const ALGEBRA_INITIALIZE_TOPIC = topicOf(
  ALGEBRA_POOL_INTERFACE,
  "Initialize",
);
export const ALGEBRA_MINT_TOPIC = topicOf(ALGEBRA_POOL_INTERFACE, "Mint");
export const ALGEBRA_BURN_TOPIC = topicOf(ALGEBRA_POOL_INTERFACE, "Burn");
export const ALGEBRA_FEE_TOPIC = topicOf(ALGEBRA_POOL_INTERFACE, "Fee");
export const ALGEBRA_PLUGIN_TOPIC = topicOf(ALGEBRA_POOL_INTERFACE, "Plugin");
export const ALGEBRA_PLUGIN_CONFIG_TOPIC = topicOf(
  ALGEBRA_POOL_INTERFACE,
  "PluginConfig",
);
export const ALGEBRA_TICK_SPACING_TOPIC = topicOf(
  ALGEBRA_POOL_INTERFACE,
  "TickSpacing",
);
export const ALGEBRA_COMMUNITY_FEE_TOPIC = topicOf(
  ALGEBRA_POOL_INTERFACE,
  "CommunityFee",
);
export const ALGEBRA_FACTORY_POOL_TOPIC = topicOf(
  ALGEBRA_FACTORY_INTERFACE,
  "Pool",
);

/** `library Plugins` of AlgebraPool.sol: the last plugin-config bit. */
export const ALGEBRA_PLUGIN_DYNAMIC_FEE_FLAG = 1 << 7;
/** `Constants.FEE_DENOMINATOR` — the fee unit is hundredths of a bip (1e-6). */
export const ALGEBRA_FEE_DENOMINATOR = 1_000_000n;
/** `library Constants`: 2**96. */
export const ALGEBRA_Q96 = 1n << 96n;
/** `TickMath` bounds of Algebra Integral. */
export const ALGEBRA_MIN_TICK = -887272;
export const ALGEBRA_MAX_TICK = 887272;
export const ALGEBRA_MIN_SQRT_RATIO = 4295128739n;
export const ALGEBRA_MAX_SQRT_RATIO =
  1461446703485210103287273052203988822378723970342n;

function selectorOf(functionName: string): string {
  const fragment = ALGEBRA_POOL_INTERFACE.getFunction(functionName);
  if (fragment === null) {
    throw new Error(`algebra pool abi is missing ${functionName}`);
  }
  return fragment.selector.toLowerCase();
}

function topicOf(iface: ethers.Interface, eventName: string): string {
  const fragment = iface.getEvent(eventName);
  if (fragment === null) {
    throw new Error(`algebra abi is missing event ${eventName}`);
  }
  return fragment.topicHash.toLowerCase();
}
