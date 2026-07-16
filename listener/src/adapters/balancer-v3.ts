import { ethers } from "ethers";
import {
  concatBytes,
  encodeCall,
  encodeClearState,
  encodeSetField2,
} from "../encoder.js";
import type { ActionAdapter, ResolvedPlanNode } from "../types.js";

const UNLOCK_FIELD2 = 68;

const unlockIface = new ethers.Interface(["function unlock(bytes data)"]);
const callbackIface = new ethers.Interface(["function unlockCallback(bytes data)"]);
const settleIface = new ethers.Interface([
  "function settle(address token, uint256 amountHint) returns (uint256 credit)",
]);
const swapIface = new ethers.Interface([
  "function swap((uint8 kind,address pool,address tokenIn,address tokenOut,uint256 amountGivenRaw,uint256 limitRaw,bytes userData) params) returns (uint256 amountCalculatedRaw,uint256 amountInRaw,uint256 amountOutRaw)",
]);
const sendToIface = new ethers.Interface([
  "function sendTo(address token, address to, uint256 amount)",
]);

export const balancerV3UnlockAdapter: ActionAdapter = {
  id: "balancer-v3-unlock",
  isWrapper: true,
  field2Offset: UNLOCK_FIELD2,

  encode(node: ResolvedPlanNode, _executor: string, innerScript: Uint8Array) {
    // Balancer V3 calls msg.sender with the raw `data` bytes. Wrap the BotVM
    // sub-script in a bytes-argument calldata shape so fallback field2=68 can
    // locate its length/content. Unlike Uniswap V4, no callback return bytes are required.
    const callbackCalldata = callbackIface.encodeFunctionData("unlockCallback", [innerScript]);
    const calldata = unlockIface.encodeFunctionData("unlock", [callbackCalldata]);
    return concatBytes(
      encodeSetField2(UNLOCK_FIELD2),
      encodeCall(node.target, ethers.getBytes(calldata)),
      encodeClearState(),
    );
  },

  matchTrace(_target: string, selector: string) {
    return selector === unlockIface.getFunction("unlock")!.selector;
  },
};

export const balancerV3SettleAdapter: ActionAdapter = {
  id: "balancer-v3-settle",
  isWrapper: false,
  field2Offset: null,

  encode(node: ResolvedPlanNode) {
    const token = (node.params.token as string) || node.tokenIn;
    const calldata = settleIface.encodeFunctionData("settle", [token, node.amount]);
    return encodeCall(node.target, ethers.getBytes(calldata));
  },

  matchTrace() { return false; },
};

export const balancerV3SwapAdapter: ActionAdapter = {
  id: "balancer-v3-swap",
  isWrapper: false,
  field2Offset: null,

  encode(node: ResolvedPlanNode) {
    const calldata = swapIface.encodeFunctionData("swap", [{
      kind: Number(node.params.kind as bigint),
      pool: node.params.pool as string,
      tokenIn: node.tokenIn,
      tokenOut: node.tokenOut,
      amountGivenRaw: node.amount,
      limitRaw: node.params.limitRaw as bigint,
      userData: (node.params.userData as string) || "0x",
    }]);
    return encodeCall(node.target, ethers.getBytes(calldata));
  },

  matchTrace() { return false; },
};

export const balancerV3SendToAdapter: ActionAdapter = {
  id: "balancer-v3-send-to",
  isWrapper: false,
  field2Offset: null,

  encode(node: ResolvedPlanNode, executor: string) {
    const token = (node.params.token as string) || node.tokenOut;
    const calldata = sendToIface.encodeFunctionData("sendTo", [token, executor, node.amount]);
    return encodeCall(node.target, ethers.getBytes(calldata));
  },

  matchTrace() { return false; },
};
