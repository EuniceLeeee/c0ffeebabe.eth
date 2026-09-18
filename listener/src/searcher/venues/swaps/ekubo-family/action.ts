import { ethers } from "ethers";
import { encodeCall } from "../../../../encoder.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";
import { EKUBO_ROUTER, EKUBO_ROUTER_SWAP_SELECTOR, encodeEkuboSwap } from "../ekubo/abi.js";
import { createEkuboPoolKeyBinding, ekuboDirection, ekuboPoolId } from "../ekubo/pool-key.js";
import { same, vanillaKey } from "./codec.js";
import { EKUBO_ACTION_ID } from "./manifest.js";

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
      const poolKey = vanillaKey({ token0: p.token0, token1: p.token1, config: p.config });
      if (ekuboPoolId(poolKey) !== p.poolId.toLowerCase() || createEkuboPoolKeyBinding(poolKey).hash !== p.bindingHash.toLowerCase() ||
          ekuboDirection(node.tokenIn, node.tokenOut, poolKey) !== p.isToken1) throw new Error("ekubo action key/direction mismatch");
      return encodeCall(EKUBO_ROUTER, ethers.getBytes(encodeEkuboSwap(poolKey, p.isToken1, node.amount, p.amountOutMin, executor)));
    },
    matchTrace: (target, selector) => same(target, EKUBO_ROUTER) && selector.toLowerCase() === EKUBO_ROUTER_SWAP_SELECTOR,
  },
  descriptor: { adapterId: EKUBO_ACTION_ID, lineage: "custom-swap:ekubo", edgeKind: "swap", action: "swap",
    canSendValue: false, leavesStandingPositionDefault: false },
});
