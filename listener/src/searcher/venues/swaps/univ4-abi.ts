import { ethers } from "ethers";

export const UNIV4_INITIALIZE_SIGNATURE =
  "Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)";
export const UNIV4_SWAP_SIGNATURE =
  "Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)";
export const UNIV4_MODIFY_LIQUIDITY_SIGNATURE =
  "ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)";

export const UNIV4_INITIALIZE_TOPIC = ethers.id(
  UNIV4_INITIALIZE_SIGNATURE,
).toLowerCase();
export const UNIV4_SWAP_TOPIC = ethers.id(UNIV4_SWAP_SIGNATURE).toLowerCase();
export const UNIV4_MODIFY_LIQUIDITY_TOPIC = ethers.id(
  UNIV4_MODIFY_LIQUIDITY_SIGNATURE,
).toLowerCase();

export const UNIV4_POOL_MANAGER_INTERFACE = new ethers.Interface([
  "event Initialize(bytes32 indexed id,address indexed currency0,address indexed currency1,uint24 fee,int24 tickSpacing,address hooks,uint160 sqrtPriceX96,int24 tick)",
  "event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)",
  "event ModifyLiquidity(bytes32 indexed id,address indexed sender,int24 tickLower,int24 tickUpper,int256 liquidityDelta,bytes32 salt)",
  "function swap((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,(bool zeroForOne,int256 amountSpecified,uint160 sqrtPriceLimitX96) params,bytes hookData) returns (int256 swapDelta)",
]);

export const UNIV4_SWAP_SELECTOR = UNIV4_POOL_MANAGER_INTERFACE.getFunction(
  "swap",
)!.selector as `0x${string}`;

export const UNIV4_STATE_VIEW_INTERFACE = new ethers.Interface([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
]);

export const UNIV4_QUOTER_INTERFACE = new ethers.Interface([
  "function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)",
]);

export const ANGSTROM_HOOK_STATE_INTERFACE = new ethers.Interface([
  "function extsload(uint256 slot) view returns (uint256 value)",
]);

export const ANGSTROM_CONTROLLER_INTERFACE = new ethers.Interface([
  "function ANGSTROM() view returns (address)",
]);
