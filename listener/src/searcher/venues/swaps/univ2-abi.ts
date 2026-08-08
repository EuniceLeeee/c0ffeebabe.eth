import { ethers } from "ethers";

/** Shared protocol ABI surface used by both legacy and strict UniV2 paths. */
export const UNIV2_PAIR_INTERFACE = new ethers.Interface([
  "function factory() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes data)",
  "event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)",
  "event Sync(uint112 reserve0,uint112 reserve1)",
]);

export const UNIV2_FACTORY_INTERFACE = new ethers.Interface([
  "function getPair(address tokenA,address tokenB) view returns (address pair)",
  "event PairCreated(address indexed token0,address indexed token1,address pair,uint256)",
]);

export const UNIV2_PAIR_CREATED_TOPIC = ethers.id(
  "PairCreated(address,address,address,uint256)",
) as `0x${string}`;
export const UNIV2_SWAP_TOPIC = ethers.id(
  "Swap(address,uint256,uint256,uint256,uint256,address)",
) as `0x${string}`;
export const UNIV2_SYNC_TOPIC = ethers.id(
  "Sync(uint112,uint112)",
) as `0x${string}`;
export const UNIV2_SWAP_SELECTOR = UNIV2_PAIR_INTERFACE.getFunction("swap")!
  .selector as `0x${string}`;
