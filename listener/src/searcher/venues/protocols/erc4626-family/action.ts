import { bindProtocolLegAction } from "../standard-family/common.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";
import { runtimeProgramScript } from "../../../../adapters/runtime-amount-program.js";
import { INFINIFI_VARIANT, INFINIFI_GATEWAY, INFINIFI_ABI } from "./infinifi.js";
import { infinifiProgram } from "./infinifi-execution.js";
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

function erc4626Action(standard: typeof standardRedeem, direction: "deposit" | "redeem") {
return bindFamilyOwnedAction({
  descriptor: standard.descriptor,
  action: {
    id: standard.id, isWrapper: false, field2Offset: null, matchTrace: (target, selector) => standard.matchTrace(target, selector) ||
      target.toLowerCase() === INFINIFI_GATEWAY && selector.toLowerCase() === INFINIFI_ABI.getFunction(direction === "deposit" ? "stake" : "unstake")!.selector,
    encode(node, executor, inner) {
      if (node.params.variant === undefined) return standard.encode(node, executor, inner);
      if (node.params.variant === INFINIFI_VARIANT) {
        if (node.adapterId !== standard.id || node.amount <= 0n || node.children.length || inner.length ||
            typeof node.params.minimumOut !== "bigint" || typeof node.params.gateway !== "string" ||
            typeof node.params.core !== "string" || typeof node.params.yieldSharing !== "string" || Object.keys(node.params).length !== 5)
          throw new Error("InfiniFi quoted node shape");
        const vault = direction === "deposit" ? node.tokenOut : node.tokenIn;
        if (vault.toLowerCase() !== node.target.toLowerCase()) throw new Error("InfiniFi quoted share binding");
        return runtimeProgramScript(infinifiProgram({ vault, asset: direction === "deposit" ? node.tokenIn : node.tokenOut,
          gateway: node.params.gateway, core: node.params.core, yieldSharing: node.params.yieldSharing },
          executor, direction, node.params.minimumOut).bytes(), node.amount);
      }
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
export const erc4626DepositFamilyOwnedAction = erc4626Action(standardDeposit, "deposit");
export const erc4626RedeemFamilyOwnedAction = erc4626Action(standardRedeem, "redeem");
