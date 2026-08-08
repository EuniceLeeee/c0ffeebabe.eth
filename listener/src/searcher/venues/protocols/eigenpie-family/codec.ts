import { ethers } from "ethers";
import { canonicalAddress } from "../standard-family/common.js";

export const EIGENPIE_INTERFACE = new ethers.Interface([
  "function depositAsset(address asset,uint256 depositAmount,uint256 minRec,address referral)",
  "function getMLRTAmountToMint(address asset,uint256 amount) view returns (uint256 amountOut,address receiptToken)",
  "event AssetDeposit(address indexed depositor,address indexed asset,uint256 depositAmount,address indexed referral,uint256 mintedAmount,bool isPreDeposit)",
]);

export const EIGENPIE_ERC20_INTERFACE = new ethers.Interface([
  "function decimals() view returns (uint8)",
]);

export const EIGENPIE_CALL_PATTERN_ID = "eigenpie-deposit-asset-call";
export const EIGENPIE_LOG_PATTERN_ID = "eigenpie-asset-deposit-log";
export const EIGENPIE_DEPOSIT_TOPIC = EIGENPIE_INTERFACE
  .getEvent("AssetDeposit")!.topicHash.toLowerCase();

export function decodeEigenpieQuote(data: string): {
  readonly amountOut: bigint;
  readonly tokenOut: string;
} {
  const decoded = EIGENPIE_INTERFACE.decodeFunctionResult(
    "getMLRTAmountToMint",
    data,
  );
  return Object.freeze({
    amountOut: BigInt(decoded[0]),
    tokenOut: canonicalAddress(String(decoded[1])),
  });
}
