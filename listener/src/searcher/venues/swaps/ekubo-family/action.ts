import { ethers } from "ethers";
import { encodeCall, encodeCallValue, encodeWrapNativeDelta, concatBytes } from "../../../../encoder.js";
import { ADDR } from "../../../../shared/constants/addresses.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";
import { EKUBO_ROUTER, EKUBO_ROUTER_SWAP_SELECTOR, encodeEkuboSwap } from "../ekubo/abi.js";
import { createEkuboPoolKeyBinding, ekuboDirection, ekuboPoolId } from "../ekubo/pool-key.js";
import { same, supportedKey } from "./codec.js";
import { EKUBO_ACTION_ID } from "./manifest.js";
const WETH = new ethers.Interface(["function withdraw(uint256)"]);

export const ekuboAction = bindFamilyOwnedAction({
  action: {
    id: EKUBO_ACTION_ID, isWrapper: false, field2Offset: null,
    encode(node, executor, inner) {
      const p = node.params;
      if (node.adapterId !== EKUBO_ACTION_ID || !same(node.target, EKUBO_ROUTER) || node.children.length !== 0 || inner.length !== 0 ||
          typeof p.token0 !== "string" || typeof p.token1 !== "string" || typeof p.config !== "string" ||
          typeof p.poolId !== "string" || typeof p.bindingHash !== "string" || typeof p.isToken1 !== "boolean" ||
          typeof p.amountOutMin !== "bigint" || p.amountOutMin <= 0n || typeof p.receiver !== "string" ||
          !same(p.receiver, executor)) throw new Error("ekubo invalid action/receiver");
      const poolKey = supportedKey({ token0: p.token0, token1: p.token1, config: p.config });
      if (ekuboPoolId(poolKey) !== p.poolId.toLowerCase() || createEkuboPoolKeyBinding(poolKey).hash !== p.bindingHash.toLowerCase() ||
          ekuboDirection(node.tokenIn, node.tokenOut, poolKey) !== p.isToken1) throw new Error("ekubo action key/direction mismatch");
      const data = ethers.getBytes(encodeEkuboSwap(poolKey, p.isToken1, node.amount, p.amountOutMin, executor));
      if (poolKey.token0 === ethers.ZeroAddress) {
        if (p.isToken1) {
          // Router pays native ETH to the executor. Wrap the actual receipt,
          // not the quote/minimum, while preserving pre-existing inventory.
          return encodeWrapNativeDelta(encodeCall(EKUBO_ROUTER, data));
        }
        // Exact-input/full-fill Router: withdraw exactly the input WETH and
        // send exactly that value. No existing WETH/native balance sweep and
        // no output quantity is pre-wrapped from a quote.
        return concatBytes(encodeCall(ADDR.WETH, ethers.getBytes(WETH.encodeFunctionData("withdraw", [node.amount]))),
          encodeCallValue(EKUBO_ROUTER, node.amount, data));
      }
      return encodeCall(EKUBO_ROUTER, data);
    },
    matchTrace: (target, selector) => same(target, EKUBO_ROUTER) && selector.toLowerCase() === EKUBO_ROUTER_SWAP_SELECTOR,
  },
  descriptor: { adapterId: EKUBO_ACTION_ID, lineage: "custom-swap:ekubo", edgeKind: "swap", action: "swap",
    canSendValue: true, leavesStandingPositionDefault: false },
});
