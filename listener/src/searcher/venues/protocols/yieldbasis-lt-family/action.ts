import { ethers } from "ethers";
import {
  concatBytes,
  encodeCall,
} from "../../../../encoder.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";
import {
  LT_INTERFACE,
  LT_WITHDRAW_SELECTOR,
} from "./abi.js";
import { lower } from "./codec.js";
import { YIELDBASIS_WITHDRAW_ACTION } from "./manifest.js";

/**
 * Plugin-owned action: `withdraw(uint256 shares, uint256 min_assets)` burns the
 * executor's own LT shares and sends `ASSET_TOKEN()` to `msg.sender`, so the
 * quoted fragment needs no approval and the action never sends value. The action
 * id, encoder and trace matcher all live in this family — the central action
 * catalog is not touched.
 *
 * `matchTrace` accepts ONLY the two-argument selector. `deposit`,
 * `emergency_withdraw` and the three-argument `withdraw(...,address)` overload
 * therefore never match this family's action, so no unsupported entry point can
 * ever be claimed by a routed leg.
 */
export const yieldBasisLtWithdrawAction = bindFamilyOwnedAction({
  action: {
    id: YIELDBASIS_WITHDRAW_ACTION,
    isWrapper: false,
    field2Offset: null,
    encode(node, executor, inner) {
      const target = lower(node.target);
      const actor = lower(executor);
      const minAssetsOut = (node.params as { readonly minAssetsOut?: unknown })
        .minAssetsOut;
      if (
        node.adapterId !== YIELDBASIS_WITHDRAW_ACTION ||
        typeof node.amount !== "bigint" ||
        node.amount <= 0n ||
        typeof minAssetsOut !== "bigint" ||
        minAssetsOut <= 0n ||
        Object.keys(node.params).length !== 1 ||
        inner.length !== 0 ||
        node.children.length !== 0 ||
        target === actor ||
        lower(node.tokenIn) === lower(node.tokenOut)
      ) {
        throw new Error(
          "yield basis LT invalid action: only withdraw(uint256 shares,uint256 min_assets) is supported",
        );
      }
      return ethers.getBytes(concatBytes(
        encodeCall(
          target,
          ethers.getBytes(LT_INTERFACE.encodeFunctionData(
            "withdraw(uint256,uint256)",
            [node.amount, minAssetsOut],
          )),
        ),
      ));
    },
    matchTrace: (_target, selector) =>
      selector.toLowerCase() === LT_WITHDRAW_SELECTOR.toLowerCase(),
  },
  descriptor: {
    adapterId: YIELDBASIS_WITHDRAW_ACTION,
    lineage: "custom-protocol:yieldbasis-lt",
    edgeKind: "protocol",
    action: "redeem",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
});
