import { ethers } from "ethers";
import { concatBytes, encodeCall } from "../../../../encoder.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";
import { ABI, ERC20, MAX, nonzero } from "./codec.js";
export const action = bindFamilyOwnedAction({
  action: {
    id: "token-migration", isWrapper: false, field2Offset: null,
    encode(node, executor, inner) {
      nonzero(executor); nonzero(node.target); nonzero(node.tokenIn); nonzero(node.tokenOut);
      if (node.adapterId !== "token-migration" || node.tokenIn.toLowerCase() === node.tokenOut.toLowerCase() ||
          typeof node.amount !== "bigint" || node.amount <= 0n || node.amount > MAX || inner.length || node.children.length) {
        throw new Error("invalid migration action");
      }
      const approve = (amount: bigint) => encodeCall(node.tokenIn, ethers.getBytes(ERC20.encodeFunctionData("approve", [node.target, amount])));
      // Only the selected amount is pulled. Never encode migrateAllBIT, balance
      // sweeps, or a quoted-output transfer. The migrator pays msg.sender itself.
      return concatBytes(approve(0n), approve(node.amount),
        encodeCall(node.target, ethers.getBytes(ABI.encodeFunctionData("migrateBIT", [node.amount]))), approve(0n));
    },
    matchTrace: (target, selector) => ethers.isAddress(target) && selector.toLowerCase() === ABI.getFunction("migrateBIT")!.selector,
  },
  descriptor: { adapterId: "token-migration", lineage: "custom-protocol:token-migration", edgeKind: "protocol", action: "convert",
    canSendValue: false, leavesStandingPositionDefault: false },
});
