import { ethers } from "ethers";
import { encodeCall } from "../encoder.js";
import type { ActionAdapter, ResolvedPlanNode } from "../types.js";

const iface = new ethers.Interface([
  "function lockAndBridge(bytes32 tokenId, uint256 amount, address recipient)",
]);

export const arcanaMigrationActionAdapter = Object.freeze({
  id: "arcana-migration",
  isWrapper: false,
  field2Offset: null,
  descriptor: Object.freeze({
    adapterId: "arcana-migration",
    lineage: "custom-protocol:arcana-migration",
    edgeKind: "protocol",
    action: "convert",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  }),
  encode(node: ResolvedPlanNode, executor: string, _innerScript: Uint8Array) {
    const target = ethers.getAddress(node.target);
    const tokenId = String(node.params?.tokenId ?? "");
    if (!/^0x[0-9a-fA-F]{64}$/.test(tokenId)) throw new Error("arcana migration requires a bytes32 tokenId");
    const recipient = typeof node.params?.recipient === "string"
      ? ethers.getAddress(node.params.recipient)
      : ethers.getAddress(executor);
    const calldata = iface.encodeFunctionData("lockAndBridge", [tokenId, node.amount, recipient]);
    return encodeCall(target, ethers.getBytes(calldata));
  },
  matchTrace(target: string, selector: string) {
    return ethers.isAddress(target) &&
      selector.toLowerCase() === iface.getFunction("lockAndBridge")!.selector;
  },
} satisfies ActionAdapter);
