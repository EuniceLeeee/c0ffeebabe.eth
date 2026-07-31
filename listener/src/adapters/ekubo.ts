import { ethers } from "ethers";
import {
  encodeCall,
  encodeCallValue,
} from "../encoder.js";
import type { ActionAdapter, ResolvedPlanNode } from "../types.js";
import {
  EKUBO_ROUTER,
  EKUBO_ROUTER_SWAP_SELECTOR,
  encodeEkuboSwap,
} from "../searcher/venues/swaps/ekubo/abi.js";
import { EKUBO_EDGE_ADAPTER_ID } from "../searcher/venues/swaps/ekubo/ids.js";
import {
  createEkuboPoolKeyBinding,
  ekuboDirection,
  ekuboPoolId,
  normalizeEkuboPoolKey,
} from "../searcher/venues/swaps/ekubo/pool-key.js";

export const ekuboRouterSwapAdapter = Object.freeze({
  id: EKUBO_EDGE_ADAPTER_ID,
  isWrapper: false,
  field2Offset: null,
  descriptor: Object.freeze({
    adapterId: EKUBO_EDGE_ADAPTER_ID,
    lineage: "custom-swap:ekubo",
    edgeKind: "swap",
    action: "swap",
    canSendValue: true,
    leavesStandingPositionDefault: false,
  }),

  encode(node: ResolvedPlanNode, executor: string) {
    if (
      ethers.getAddress(node.target).toLowerCase() !== EKUBO_ROUTER.toLowerCase()
    ) {
      throw new Error(`Ekubo action has foreign router ${node.target}`);
    }
    const poolKey = normalizeEkuboPoolKey({
      token0: stringParam(node, "token0"),
      token1: stringParam(node, "token1"),
      config: stringParam(node, "config"),
    });
    const poolId = ekuboPoolId(poolKey);
    const bindingHash = createEkuboPoolKeyBinding(poolKey).hash;
    if (
      stringParam(node, "poolId").toLowerCase() !== poolId ||
      stringParam(node, "bindingHash").toLowerCase() !== bindingHash
    ) {
      throw new Error(
        "Ekubo action PoolKey does not match its declared execution identity",
      );
    }
    const isToken1 = booleanParam(node, "isToken1");
    if (ekuboDirection(node.tokenIn, node.tokenOut, poolKey) !== isToken1) {
      throw new Error("Ekubo action direction does not match its PoolKey");
    }
    const nativeValue = bigintParam(node, "nativeValue");
    const rawInput = isToken1 ? poolKey.token1 : poolKey.token0;
    const expectedNativeValue =
      rawInput === ethers.ZeroAddress ? node.amount : 0n;
    const amountOutMin = bigintParam(node, "amountOutMin");
    if (
      node.amount <= 0n ||
      nativeValue !== expectedNativeValue ||
      amountOutMin <= 0n
    ) {
      throw new Error(
        "Ekubo action amount or native settlement is inconsistent",
      );
    }
    const calldata = encodeEkuboSwap(
      poolKey,
      isToken1,
      node.amount,
      amountOutMin,
      executor,
    );
    return nativeValue > 0n
      ? encodeCallValue(node.target, nativeValue, ethers.getBytes(calldata))
      : encodeCall(node.target, ethers.getBytes(calldata));
  },

  matchTrace(target: string, selector: string) {
    return target.toLowerCase() === EKUBO_ROUTER.toLowerCase() &&
      selector.toLowerCase() === EKUBO_ROUTER_SWAP_SELECTOR;
  },
} satisfies ActionAdapter);

function stringParam(node: ResolvedPlanNode, key: string): string {
  const value = node.params[key];
  if (typeof value !== "string") {
    throw new Error(`Ekubo action ${key} must be a string`);
  }
  return value;
}

function bigintParam(node: ResolvedPlanNode, key: string): bigint {
  const value = node.params[key];
  if (typeof value !== "bigint") {
    throw new Error(`Ekubo action ${key} must be an integer`);
  }
  return value;
}

function booleanParam(node: ResolvedPlanNode, key: string): boolean {
  const value = node.params[key];
  if (typeof value !== "boolean") {
    throw new Error(`Ekubo action ${key} must be a boolean`);
  }
  return value;
}
