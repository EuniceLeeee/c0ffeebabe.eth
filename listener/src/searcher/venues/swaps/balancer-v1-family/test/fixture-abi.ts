import { ethers } from "ethers";
export const MAX_UINT = (1n << 256n) - 1n;
export const BONE = 10n ** 18n;
// Infrastructure provenance, never a pool-address admission list. Membership
// is reverse-read for every candidate; the supported factory creates BPools.
export const FACTORY_ADDRESS = "0x9424b1412450d0f8fc2255faf6046b98213b76bd";
export const POOL_CODE_HASH = "0x974df1c33872ba8aab782be5117ff348802441590f84ed7701d734bb9c21683e";
export const FACTORY_CODE_HASH = "0xd185d385218c275c7ed71ca8430e79bcddbe8a7058d7e9fe4a1fe06b542deb2e";
export const MODEL = "balancer-v1-finalized-bpool-0.5.12";
export const POOL = new ethers.Interface([
  "function isFinalized() view returns(bool)", "function isPublicSwap() view returns(bool)",
  "function getFinalTokens() view returns(address[])", "function getSwapFee() view returns(uint256)",
  "function getDenormalizedWeight(address) view returns(uint256)", "function getBalance(address) view returns(uint256)",
  "function calcOutGivenIn(uint256,uint256,uint256,uint256,uint256,uint256) pure returns(uint256)",
  "function calcSpotPrice(uint256,uint256,uint256,uint256,uint256) pure returns(uint256)",
  "function swapExactAmountIn(address,uint256,address,uint256,uint256) returns(uint256,uint256)",
  "function swapExactAmountOut(address,uint256,address,uint256,uint256) returns(uint256,uint256)",
  "event LOG_SWAP(address indexed caller,address indexed tokenIn,address indexed tokenOut,uint256 tokenAmountIn,uint256 tokenAmountOut)",
]);
export const FACTORY = new ethers.Interface(["function isBPool(address) view returns(bool)"]);
export const TOKEN = new ethers.Interface(["function balanceOf(address) view returns(uint256)",
  "function allowance(address,address) view returns(uint256)", "function approve(address,uint256) returns(bool)"]);
