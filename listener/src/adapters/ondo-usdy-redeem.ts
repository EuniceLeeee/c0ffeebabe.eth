import { ethers } from "ethers";
import { encodeCall } from "../encoder.js";
import type { ActionAdapter, ResolvedPlanNode } from "../types.js";
import { buildOndoHelperCalldata } from "../searcher/venues/protocols/ondo-usdy-family/helper.js";
const iface = new ethers.Interface(["function redeem(uint256 rwaAmount, address receivingToken, uint256 minimumTokenReceived)"]);
export const ondoUsdyRedeemActionAdapter = Object.freeze({
  id: "ondo-usdy-redeem", isWrapper: false, field2Offset: null,
  descriptor: Object.freeze({ adapterId: "ondo-usdy-redeem", lineage: "custom-protocol:ondo-usdy-instant-redeem", edgeKind: "protocol", action: "redeem", canSendValue: false, leavesStandingPositionDefault: false }),
  encode(node: ResolvedPlanNode, executor: string, _innerScript: Uint8Array) {
    const target = ethers.getAddress(node.target);
    const receive = typeof node.params?.receive === "string" ? ethers.getAddress(node.params.receive) : ethers.getAddress(executor);
    if (node.params?.helper === true) {
      const usdy = typeof node.params?.usdy === "string" ? ethers.getAddress(node.params.usdy) : ethers.getAddress(node.tokenIn);
      return encodeCall(target, ethers.getBytes(buildOndoHelperCalldata(executor, receive, usdy)));
    }
    const minimumOut = typeof node.params?.minimumOut === "bigint" ? node.params.minimumOut : 0n;
    return encodeCall(target, ethers.getBytes(iface.encodeFunctionData("redeem", [node.amount, receive, minimumOut])));
  },
  matchTrace(target: string, selector: string) {
    return ethers.isAddress(target) && selector.toLowerCase() === iface.getFunction("redeem")!.selector;
  },
} satisfies ActionAdapter);
