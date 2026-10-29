import { ethers } from "ethers";
import { encodeCall } from "../encoder.js";
import type { ActionAdapter, ResolvedPlanNode } from "../types.js";

const iface = new ethers.Interface([
  "function deposit(uint224 assets, address referral, bytes32[] merkleProof)",
  "function redeem(uint256 shares, address receiver)",
]);

const ZERO = ethers.ZeroAddress;

/** Family-owned route root for Mellow sync deposit queues. */
export const mellowDepositActionAdapter = Object.freeze({
  id: "mellow-deposit",
  isWrapper: false,
  field2Offset: null,
  descriptor: Object.freeze({
    adapterId: "mellow-deposit",
    lineage: "custom-protocol:mellow-queue",
    edgeKind: "protocol",
    action: "wrap",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  }),
  encode(node: ResolvedPlanNode, _executor: string, _innerScript: Uint8Array) {
    const target = ethers.getAddress(node.target);
    const referral = typeof node.params?.referral === "string"
      ? ethers.getAddress(node.params.referral)
      : ZERO;
    const calldata = iface.encodeFunctionData("deposit", [node.amount, referral, []]);
    return encodeCall(target, ethers.getBytes(calldata));
  },
  matchTrace(target: string, selector: string) {
    return ethers.isAddress(target) &&
      selector.toLowerCase() === iface.getFunction("deposit")!.selector;
  },
} satisfies ActionAdapter);

/** Family-owned route root for Mellow sync redeem queues. */
export const mellowRedeemActionAdapter = Object.freeze({
  id: "mellow-redeem",
  isWrapper: false,
  field2Offset: null,
  descriptor: Object.freeze({
    adapterId: "mellow-redeem",
    lineage: "custom-protocol:mellow-queue",
    edgeKind: "protocol",
    action: "redeem",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  }),
  encode(node: ResolvedPlanNode, executor: string, _innerScript: Uint8Array) {
    const target = ethers.getAddress(node.target);
    const receiver = typeof node.params?.receiver === "string"
      ? ethers.getAddress(node.params.receiver)
      : ethers.getAddress(executor);
    const calldata = iface.encodeFunctionData("redeem", [node.amount, receiver]);
    return encodeCall(target, ethers.getBytes(calldata));
  },
  matchTrace(target: string, selector: string) {
    return ethers.isAddress(target) &&
      selector.toLowerCase() === iface.getFunction("redeem")!.selector;
  },
} satisfies ActionAdapter);
