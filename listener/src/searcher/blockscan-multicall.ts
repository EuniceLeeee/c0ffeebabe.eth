import { ethers } from "ethers";

/** Chain-wide execution infrastructure, not owned by any adapter family. */
export const BLOCKSCAN_MULTICALL3 =
  "0xcA11bde05977b3631167028862bE2a173976CA11";

export const blockScanMulticallIface = new ethers.Interface([
  "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[] returnData)",
]);
