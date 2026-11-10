import { ethers } from "ethers";
import { concatBytes, encodeCall } from "../../../../encoder.js";
import type { ActionAdapter } from "../../../../types.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";
import {
  METAFACTORY_ERC20_INTERFACE,
  METAFACTORY_INTERFACE,
  METAFACTORY_MAX_UINT256,
} from "./codec.js";
import { METAFACTORY_ACTION_ID } from "./manifest.js";

const COMPOST_AND_REDEEM_SELECTOR = METAFACTORY_INTERFACE
  .getFunction("compostAndRedeem")!.selector.toLowerCase();

/**
 * Only the selected ROBOT amount is pulled: approve(0), approve(amount),
 * compostAndRedeem(amount, 0), approve(0). The passport recipient is zero in
 * the observed transaction and the composter pays the native ETH to msg.sender
 * (the executor), so no output transfer or sweep is encoded here.
 */
const metafactoryActionAdapter: ActionAdapter = {
  id: METAFACTORY_ACTION_ID,
  isWrapper: false,
  field2Offset: null,
  encode(node, executor, inner) {
    if (
      node.adapterId !== METAFACTORY_ACTION_ID ||
      !ethers.isAddress(node.target) ||
      !ethers.isAddress(node.tokenIn) ||
      !ethers.isAddress(node.tokenOut) ||
      !ethers.isAddress(executor) ||
      ethers.getAddress(executor) === ethers.ZeroAddress ||
      ethers.getAddress(node.tokenIn) === ethers.getAddress(node.target) ||
      ethers.getAddress(node.tokenIn) === ethers.getAddress(node.tokenOut) ||
      typeof node.amount !== "bigint" ||
      node.amount <= 0n ||
      node.amount > METAFACTORY_MAX_UINT256 ||
      inner.length !== 0 ||
      node.children.length !== 0
    ) {
      throw new Error("metafactory invalid compost redemption action");
    }
    const approve = (amount: bigint) => encodeCall(
      node.tokenIn,
      ethers.getBytes(METAFACTORY_ERC20_INTERFACE.encodeFunctionData(
        "approve",
        [node.target, amount],
      )),
    );
    return concatBytes(
      approve(0n),
      approve(node.amount),
      encodeCall(
        node.target,
        ethers.getBytes(METAFACTORY_INTERFACE.encodeFunctionData(
          "compostAndRedeem",
          [node.amount, ethers.ZeroAddress],
        )),
      ),
      approve(0n),
    );
  },
  matchTrace: (target, selector) =>
    ethers.isAddress(target) &&
    selector.toLowerCase() === COMPOST_AND_REDEEM_SELECTOR,
};

export const metafactoryFamilyOwnedAction = bindFamilyOwnedAction({
  action: metafactoryActionAdapter,
  descriptor: {
    adapterId: METAFACTORY_ACTION_ID,
    lineage: "custom-protocol:metafactory",
    edgeKind: "protocol",
    action: "convert",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
});
