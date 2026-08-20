import { ethers } from "ethers";

export const UNIV3_FACTORY_INTERFACE = new ethers.Interface([
  "event PoolCreated(address indexed token0,address indexed token1,uint24 indexed fee,int24 tickSpacing,address pool)",
  "function getPool(address tokenA,address tokenB,uint24 fee) view returns (address)",
]);

export const UNIV3_POOL_INTERFACE = new ethers.Interface([
  "event Initialize(uint160 sqrtPriceX96,int24 tick)",
  "event Mint(address sender,address indexed owner,int24 indexed tickLower,int24 indexed tickUpper,uint128 amount,uint256 amount0,uint256 amount1)",
  "event Burn(address indexed owner,int24 indexed tickLower,int24 indexed tickUpper,uint128 amount,uint256 amount0,uint256 amount1)",
  "event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)",
  "function factory() view returns (address)",
  "function fee() view returns (uint24)",
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
  "function swap(address recipient,bool zeroForOne,int256 amountSpecified,uint160 sqrtPriceLimitX96,bytes data)",
  "function tickSpacing() view returns (int24)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);

export const PANCAKE_V3_POOL_INTERFACE = new ethers.Interface([
  "event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint128 protocolFeesToken0,uint128 protocolFeesToken1)",
]);

export const UNIV3_QUOTER_V2_INTERFACE = new ethers.Interface([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);

export const UNIV3_ROUTER_INTERFACE = new ethers.Interface([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut)",
]);

/** Mainnet TickLens. It reads pool tick state only and is factory-agnostic,
 *  so quoter-less reverse-verified V3 fork pools can be quoted locally. */
export const UNIV3_TICK_LENS = ethers.getAddress(
  "0xbfd8137f7d1516D3ea5cA83523914859ec47F573",
);
export const UNIV3_TICK_LENS_INTERFACE = new ethers.Interface([
  "function getPopulatedTicksInWord(address pool, int16 tickBitmapIndex) view returns ((int24 tick,int128 liquidityNet,uint128 liquidityGross)[])",
]);

export const UNIV3_POOL_CREATED_TOPIC = ethers.id(
  "PoolCreated(address,address,uint24,int24,address)",
).toLowerCase();
export const UNIV3_SWAP_TOPIC = ethers.id(
  "Swap(address,address,int256,int256,uint160,uint128,int24)",
).toLowerCase();
export const PANCAKE_V3_SWAP_TOPIC = ethers.id(
  "Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)",
).toLowerCase();
export const UNIV3_INITIALIZE_TOPIC = ethers.id(
  "Initialize(uint160,int24)",
).toLowerCase();
export const UNIV3_MINT_TOPIC = ethers.id(
  "Mint(address,address,int24,int24,uint128,uint256,uint256)",
).toLowerCase();
export const UNIV3_BURN_TOPIC = ethers.id(
  "Burn(address,int24,int24,uint128,uint256,uint256)",
).toLowerCase();
export const UNIV3_SWAP_SELECTOR = UNIV3_POOL_INTERFACE.getFunction("swap")!
  .selector.toLowerCase() as `0x${string}`;

export const UNIV3_CANONICAL_FACTORY = ethers.getAddress(
  "0x1F98431c8aD98523631AE4a59f267346ea31F984",
);
export const PANCAKE_V3_FACTORY = ethers.getAddress(
  "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865",
);
export const UNIV3_QUOTER_V2 = ethers.getAddress(
  "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
);
export const PANCAKE_V3_QUOTER_V2 = ethers.getAddress(
  "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997",
);
export const UNIV3_SWAP_ROUTER = ethers.getAddress(
  "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
);

export function factoryBoundUniV3Quoter(factory: string): string | null {
  const canonical = ethers.getAddress(factory);
  if (canonical === UNIV3_CANONICAL_FACTORY) return UNIV3_QUOTER_V2;
  if (canonical === PANCAKE_V3_FACTORY) return PANCAKE_V3_QUOTER_V2;
  return null;
}
