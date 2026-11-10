import { ethers } from "ethers";

export const ONDO_MANAGER_INTERFACE = new ethers.Interface([
  "function redeem(uint256 rwaAmount, address receivingToken, uint256 minimumTokenReceived) returns (uint256)",
  "function redeemPaused() view returns (bool)",
  "function minimumRwaPrice() view returns (uint256)",
  "function rwaToken() view returns (address)",
  "function ondoOracle() view returns (address)",
  "function ondoRedemptionFees() view returns (address)",
  "function RWA_NORMALIZER() view returns (uint256)",
  "function acceptedRedemptionTokens(address token) view returns (bool)",
  "event Redemption(address indexed user, bytes32 indexed userId, uint256 rwaAmount, address receivingToken, uint256 receiveTokenAmount, uint256 usdValue, uint256 fee)",
]);

export const ONDO_ORACLE_INTERFACE = new ethers.Interface([
  "function getAssetPrice(address asset) view returns (uint256)",
]);

export const ONDO_FEES_INTERFACE = new ethers.Interface([
  "function getActiveFeeConfig(address rwaToken, address stablecoin, bytes32 userID) view returns ((bool active, uint256 flatFee, uint256 bpsFee) activeFeeConfig, ((bool active, uint256 flatFee, uint256 bpsFee) feeConfig, uint8 userFeeMode, uint256 limitVolume, uint256 currentVolume, uint256 lastReset, uint256 volumeWindow) activeUserFeeConfig)",
  "function FEE_PRECISION() view returns (uint256)",
]);

export const ONDO_ERC20_INTERFACE = new ethers.Interface([
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);
