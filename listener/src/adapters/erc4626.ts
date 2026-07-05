import { ethers } from "ethers";
import { encodeCall } from "../encoder.js";
import type { ActionAdapter, ResolvedPlanNode } from "../types.js";

const iface = new ethers.Interface([
  "function deposit(uint256 assets, address receiver) returns (uint256 shares)",
  "function redeem(uint256 shares, address receiver, address owner) returns (uint256 assets)",
]);

const DEPOSIT_SELECTOR = ethers.id("deposit(uint256,address)").slice(0, 10);
const REDEEM_SELECTOR = ethers.id("redeem(uint256,address,address)").slice(0, 10);

export const erc4626DepositAdapter: ActionAdapter = {
  id: "erc4626-deposit",
  isWrapper: false,
  field2Offset: null,

  encode(node: ResolvedPlanNode, executor: string, _inner: Uint8Array) {
    const calldata = iface.encodeFunctionData("deposit", [node.amount, executor]);
    return encodeCall(node.target, ethers.getBytes(calldata));
  },

  matchTrace(_target: string, selector: string) {
    return selector === DEPOSIT_SELECTOR;
  },
};

export const erc4626RedeemAdapter: ActionAdapter = {
  id: "erc4626-redeem",
  isWrapper: false,
  field2Offset: null,

  encode(node: ResolvedPlanNode, executor: string, _inner: Uint8Array) {
    const calldata = iface.encodeFunctionData("redeem", [node.amount, executor, executor]);
    return encodeCall(node.target, ethers.getBytes(calldata));
  },

  matchTrace(_target: string, selector: string) {
    return selector === REDEEM_SELECTOR;
  },
};
