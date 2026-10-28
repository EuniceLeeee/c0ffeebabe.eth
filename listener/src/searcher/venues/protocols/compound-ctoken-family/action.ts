import { ethers } from "ethers";
import { runtimeProgramScript } from "../../../../adapters/runtime-amount-program.js";
import { redeemProgram } from "./redeem-program.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";
import { CTOKEN_INTERFACE } from "./abi.js";
import { lower } from "./codec.js";
import { CTOKEN_REDEEM_ACTION } from "./manifest.js";

const REDEEM_SELECTOR = CTOKEN_INTERFACE.getFunction("redeem")!
  .selector.toLowerCase();

/**
 * Plugin-owned action: `redeem(uint256 redeemTokens)` burns the executor's own
 * cTokens, so the quoted fragment needs no approval and the action never sends
 * value. The action id, encoder and trace matcher all live in this family — the
 * central action catalog is not touched.
 */
export const compoundCTokenRedeemAction = bindFamilyOwnedAction({
  action: {
    id: CTOKEN_REDEEM_ACTION,
    isWrapper: false,
    field2Offset: null,
    encode(node, executor, inner) {
      const target = lower(node.target);
      const actor = lower(executor);
      if (
        node.adapterId !== CTOKEN_REDEEM_ACTION ||
        typeof node.amount !== "bigint" ||
        node.amount <= 0n ||
        node.amount > ethers.MaxUint256 ||
        typeof node.params.minUnderlyingOut !== "bigint" ||
        lower(node.tokenIn) !== target ||
        inner.length !== 0 ||
        node.children.length !== 0 ||
        target === actor ||
        lower(node.tokenIn) === lower(node.tokenOut)
      ) {
        throw new Error("compound cToken invalid action");
      }
      return runtimeProgramScript(redeemProgram(target, node.tokenOut, actor,
        node.params.minUnderlyingOut).bytes(), node.amount);
    },
    matchTrace: (_target, selector) =>
      selector.toLowerCase() === REDEEM_SELECTOR,
  },
  descriptor: {
    adapterId: CTOKEN_REDEEM_ACTION,
    lineage: "custom-protocol:compound-ctoken",
    edgeKind: "protocol",
    action: "redeem",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
});
