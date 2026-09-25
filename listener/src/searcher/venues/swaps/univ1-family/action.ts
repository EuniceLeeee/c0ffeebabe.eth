import { ethers } from "ethers";
import { concatBytes, encodeCall, encodeCallValue, encodeWrapNativeDelta } from "../../../../encoder.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";
import { ACTION } from "./manifest.js";
import { checked, lower, MAX_UINT, MAX_VALUE, POOL, WETH, WRAP } from "./codec.js";
export const action = bindFamilyOwnedAction({
  action: { id: ACTION, isWrapper: false, field2Offset: null,
    encode(node, executor, inner) {
      const p = node.params, pool = lower(node.target), actor = lower(executor);
      checked(node.amount);
      if (node.adapterId !== ACTION || node.amount <= 0n || inner.length || node.children.length ||
          typeof p.buy !== "boolean" || typeof p.amountOut !== "bigint" || p.amountOut <= 0n || p.amountOut > MAX_UINT ||
          typeof p.executor !== "string" || lower(p.executor) !== actor || pool === actor || pool === WETH ||
          lower(p.buy ? node.tokenIn : node.tokenOut) !== WETH || lower(p.buy ? node.tokenOut : node.tokenIn) === WETH ||
          lower(p.buy ? node.tokenOut : node.tokenIn) === ethers.ZeroAddress) throw new Error("univ1 invalid action");
      const data = (name: string, args: readonly unknown[]) => ethers.getBytes(POOL.encodeFunctionData(name, args));
      // Preserve the caller's execution minimum. Wrap the measured native
      // receipt so extra output cannot remain behind or sweep old inventory.
      if (p.buy) {
        if (node.amount > MAX_VALUE) throw new Error("univ1 value overflow");
        return concatBytes(encodeCall(WETH, ethers.getBytes(WRAP.encodeFunctionData("withdraw", [node.amount]))),
          encodeCallValue(pool, node.amount, data("ethToTokenSwapInput", [p.amountOut, MAX_UINT])));
      }
      return encodeWrapNativeDelta(encodeCall(pool, data("tokenToEthSwapInput", [node.amount, p.amountOut, MAX_UINT])));
    },
    matchTrace: (_target, selector) => ["ethToTokenSwapInput", "tokenToEthSwapInput"].some(n => POOL.getFunction(n)!.selector === selector.toLowerCase()),
  },
  descriptor: { adapterId: ACTION, lineage: "custom-swap:uniswap-v1", edgeKind: "swap", action: "swap", canSendValue: true, leavesStandingPositionDefault: false },
});
