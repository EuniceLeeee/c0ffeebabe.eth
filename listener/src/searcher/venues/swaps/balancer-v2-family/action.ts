import { runtimeProgramScript } from "../../../../adapters/runtime-amount-program.js";
import { swapProgram } from "./runtime.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";
import { VAULT, VAULT_ABI, MAX_INPUT, MAX_UINT, poolIdentity, nonzero, same } from "./codec.js";
export const VAULT_ACTION = "balancer-v2-vault-swap";
export const action = bindFamilyOwnedAction({
  action: {
    id: VAULT_ACTION, isWrapper: false, field2Offset: null,
    encode(node, executor, inner) {
      nonzero(executor); nonzero(node.tokenIn); nonzero(node.tokenOut);
      if (node.adapterId !== VAULT_ACTION || !same(node.target, VAULT) || same(executor, VAULT) ||
          same(node.tokenIn, node.tokenOut) || typeof node.amount !== "bigint" || node.amount <= 0n || node.amount > MAX_INPUT ||
          inner.length || node.children.length || typeof node.params.poolId !== "string" ||
          typeof node.params.minAmountOut !== "bigint" || node.params.minAmountOut < 0n || node.params.minAmountOut > MAX_UINT) {
        throw new Error("balancer-v2 invalid swap action");
      }
      const id = poolIdentity(node.params.poolId);
      if (same(executor, id.pool)) throw new Error("balancer-v2 pool cannot be executor");
      return runtimeProgramScript(swapProgram(id.poolId, node.tokenIn, node.tokenOut, executor, node.params.minAmountOut).bytes(), node.amount);
    },
    matchTrace: (target, selector) => same(target, VAULT) && selector === VAULT_ABI.getFunction("swap")!.selector,
  },
  descriptor: { adapterId: VAULT_ACTION, lineage: "custom-swap:balancer-v2", edgeKind: "swap", action: "swap",
    canSendValue: false, leavesStandingPositionDefault: false },
});
