import { ethers } from "ethers";
import { encodeCall } from "../encoder.js";
import type { ActionAdapter, ResolvedPlanNode } from "../types.js";

const iface = new ethers.Interface([
  "function approve(address spender, uint256 amount)",
  "function transfer(address to, uint256 amount)",
]);

export const erc20ApproveAdapter: ActionAdapter = {
  id: "erc20-approve",
  isWrapper: false,
  field2Offset: null,

  encode(node: ResolvedPlanNode, executor: string, _inner: Uint8Array) {
    const spender = (node.params.spender as string) || executor;
    const amount = (node.params.amount as bigint) ?? node.amount;
    const calldata = iface.encodeFunctionData("approve", [spender, amount]);
    return encodeCall(node.target, ethers.getBytes(calldata));
  },

  matchTrace(_target: string, selector: string) {
    return selector === "0x095ea7b3";
  },
};

export const erc20TransferAdapter: ActionAdapter = {
  id: "erc20-transfer",
  isWrapper: false,
  field2Offset: null,

  encode(node: ResolvedPlanNode, executor: string, _inner: Uint8Array) {
    const to = (node.params.to as string) || executor;
    const amount = (node.params.amount as bigint) ?? node.amount;
    const calldata = iface.encodeFunctionData("transfer", [to, amount]);
    return encodeCall(node.target, ethers.getBytes(calldata));
  },

  matchTrace(_target: string, selector: string) {
    return selector === "0xa9059cbb";
  },
};
