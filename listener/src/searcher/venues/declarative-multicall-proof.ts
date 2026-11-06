import { getAddress, isHexString } from "ethers";
import { BLOCKSCAN_MULTICALL3, blockScanMulticallIface } from "../blockscan-multicall.js";

/** Read one actual inner call and result out of an issuer-attested aggregate3 read.
 * The declared index cannot introduce bytes, omit the outer provenance, or turn a reverted item into a quote. */
export function verifiedMulticallItem(input: {
  outerTarget: string;
  calldata: string;
  returndata: string;
  index: unknown;
  target: unknown;
  expectedCalldata: unknown;
}): { calldata: string; returndata: string } {
  if (getAddress(input.outerTarget) !== BLOCKSCAN_MULTICALL3 || typeof input.target !== "string" ||
      typeof input.index !== "number" || !Number.isSafeInteger(input.index) || input.index < 0 ||
      !isHexString(input.expectedCalldata, true)) throw new Error("invalid aggregate quote binding");
  const args = blockScanMulticallIface.decodeFunctionData("aggregate3", input.calldata);
  const result = blockScanMulticallIface.decodeFunctionResult("aggregate3", input.returndata);
  if (blockScanMulticallIface.encodeFunctionData("aggregate3", args).toLowerCase() !== input.calldata.toLowerCase() ||
      blockScanMulticallIface.encodeFunctionResult("aggregate3", result).toLowerCase() !== input.returndata.toLowerCase())
    throw new Error("noncanonical aggregate quote encoding");
  const calls = args[0], outputs = result[0];
  if (!calls.length || calls.length > 256 || calls.length !== outputs.length || input.index >= calls.length)
    throw new Error("aggregate quote cardinality mismatch");
  const call = calls[input.index], output = outputs[input.index];
  if (getAddress(call.target) !== getAddress(input.target) || call.callData.toLowerCase() !== String(input.expectedCalldata).toLowerCase() ||
      !output.success || output.returnData === "0x") throw new Error("aggregate quote member failed its binding");
  return { calldata: call.callData, returndata: output.returnData };
}
