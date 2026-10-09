import { bindProtocolLegAction } from "../standard-family/common.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";
import { runtimeProgramScript } from "../../../../adapters/runtime-amount-program.js";
import { CUSTODIAN_VARIANT } from "./custodian.js";
import { custodianProgram } from "./custodian-execution.js";

const standardDeposit = bindProtocolLegAction(
  "erc4626-deposit",
  {
    adapterId: "erc4626-deposit",
    lineage: "erc4626",
    edgeKind: "protocol",
    action: "deposit",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
);

const standardRedeem = bindProtocolLegAction(
  "erc4626-redeem",
  {
    adapterId: "erc4626-redeem",
    lineage: "erc4626",
    edgeKind: "protocol",
    action: "redeem",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
);

function custodianAction(standard: typeof standardRedeem, direction: "deposit" | "redeem") {
return bindFamilyOwnedAction({
  descriptor: standard.descriptor,
  action: {
    id: standard.id, isWrapper: false, field2Offset: null, matchTrace: standard.matchTrace,
    encode(node, executor, inner) {
      if (node.params.variant === undefined) return standard.encode(node, executor, inner);
      if (node.params.variant !== CUSTODIAN_VARIANT || node.adapterId !== standard.id ||
          node.amount <= 0n || node.children.length || inner.length ||
          typeof node.params.minimumOut !== "bigint" || Object.keys(node.params).length !== 2)
        throw new Error("Custodian quoted node shape");
      return runtimeProgramScript(custodianProgram({ vault: node.target,
        share: direction === "deposit" ? node.tokenOut : node.tokenIn, asset: direction === "deposit" ? node.tokenIn : node.tokenOut },
        executor, direction, node.params.minimumOut).bytes(), node.amount);
    },
  },
});
}
export const erc4626DepositFamilyOwnedAction = custodianAction(standardDeposit, "deposit");
export const erc4626RedeemFamilyOwnedAction = custodianAction(standardRedeem, "redeem");
