import { ethers } from "ethers";
import { encodeCall } from "../encoder.js";
import { ADDR } from "../shared/constants/addresses.js";
import type { ActionAdapter, ResolvedPlanNode } from "../types.js";

const iface = new ethers.Interface([
  "function withdraw(uint256 amount)",
]);

/** Family-owned route root for EtherToken-compatible native redemption. */
export const etherTokenNativeRedeemActionAdapter = Object.freeze({
  id: "ethertoken-native-redeem",
  isWrapper: false,
  field2Offset: null,
  descriptor: Object.freeze({
    adapterId: "ethertoken-native-redeem",
    lineage: "custom-protocol:ethertoken-native-redeem",
    edgeKind: "protocol",
    action: "redeem",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  }),

  encode(
    node: ResolvedPlanNode,
    _executor: string,
    _innerScript: Uint8Array,
  ) {
    const target = ethers.getAddress(node.target);
    if (target.toLowerCase() === ADDR.WETH.toLowerCase()) {
      throw new Error(
        "ethertoken-native-redeem cannot claim canonical WETH execution",
      );
    }
    const calldata = iface.encodeFunctionData("withdraw", [node.amount]);
    return encodeCall(target, ethers.getBytes(calldata));
  },

  matchTrace(target: string, selector: string) {
    return ethers.isAddress(target) &&
      target.toLowerCase() !== ADDR.WETH.toLowerCase() &&
      selector.toLowerCase() === iface.getFunction("withdraw")!.selector;
  },
} satisfies ActionAdapter);
