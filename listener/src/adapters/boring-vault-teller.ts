import { ethers } from "ethers";
import { encodeCall } from "../encoder.js";
import type { ActionAdapter, ResolvedPlanNode } from "../types.js";

const iface = new ethers.Interface([
  "function bulkWithdraw(address withdrawAsset, uint256 shareAmount, uint256 minAssetsOut, address receiver)",
]);

export const boringVaultWithdrawActionAdapter = Object.freeze({
  id: "boring-vault-withdraw",
  isWrapper: false,
  field2Offset: null,
  descriptor: Object.freeze({
    adapterId: "boring-vault-withdraw",
    lineage: "custom-protocol:boring-vault-teller:v1",
    edgeKind: "protocol",
    action: "redeem",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  }),
  encode(node: ResolvedPlanNode, executor: string, _innerScript: Uint8Array) {
    const target = ethers.getAddress(node.target);
    const asset = ethers.getAddress(String(node.params?.asset ?? node.tokenOut));
    const minimumOut = typeof node.params?.minimumOut === "bigint" ? node.params.minimumOut : 0n;
    return encodeCall(target, ethers.getBytes(iface.encodeFunctionData("bulkWithdraw", [
      asset, node.amount, minimumOut, ethers.getAddress(executor),
    ])));
  },
  matchTrace(target: string, selector: string) {
    return ethers.isAddress(target) && selector.toLowerCase() === iface.getFunction("bulkWithdraw")!.selector;
  },
} satisfies ActionAdapter);
