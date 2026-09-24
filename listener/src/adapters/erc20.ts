import { ethers } from "ethers";
import { addressToBytes, concatBytes, encodeCall, uint256ToBytes } from "../encoder.js";
import type { ActionAdapter, ResolvedPlanNode } from "../types.js";

const iface = new ethers.Interface([
  "function approve(address spender, uint256 amount)",
  "function transfer(address to, uint256 amount)",
]);

export const erc20ApproveAdapter: ActionAdapter = {
  id: "erc20-approve",
  isWrapper: false,
  field2Offset: null,
  descriptor: {
    adapterId: "erc20-approve",
    lineage: "erc20-infra",
    edgeKind: null,
    action: "approve",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },

  encode(node: ResolvedPlanNode, executor: string, _inner: Uint8Array) {
    const spender = (node.params.spender as string) || executor;
    const amount = (node.params.amount as bigint) ?? node.amount;
    const minimum = node.params.minimumAllowance;
    if (minimum !== undefined) {
      if (typeof minimum !== "bigint" || minimum <= 0n || typeof amount !== "bigint" ||
          amount < minimum || amount >= 1n << 256n || node.children.length || _inner.length ||
          ethers.getAddress(node.target) === ethers.ZeroAddress || ethers.getAddress(spender) === ethers.ZeroAddress) {
        throw new Error("invalid conditional ERC20 allowance");
      }
      // Generic runtime primitive: reuse current allowance, never a quote-time
      // cache. Preserve the Family's grant ceiling; no implicit MAX_UINT policy.
      return concatBytes(new Uint8Array([0x0a]), addressToBytes(node.target), addressToBytes(spender),
        uint256ToBytes(minimum), uint256ToBytes(amount));
    }
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
  descriptor: {
    adapterId: "erc20-transfer",
    lineage: "erc20-infra",
    edgeKind: null,
    action: "transfer",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },

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
