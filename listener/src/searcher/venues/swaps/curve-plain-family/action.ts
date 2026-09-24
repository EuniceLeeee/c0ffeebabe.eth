import { curveExchangeAdapter, curveExchangeNoReceiverAdapter, curvePlainExchangeAdapter, curveExchangeReceivedUintAdapter } from "../../../../adapters/curve.js";
import type { ActionAdapter } from "../../../../types.js";
import { ethers } from "ethers";
import { encodeCall } from "../../../../encoder.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";
import { MAX_UINT, executionData, selector, same, validIndex } from "./codec.js";

function owned(action: ActionAdapter) {
  return bindFamilyOwnedAction({ action: { ...action, encode(node, executor, inner) {
    if (!validIndex(Number(node.params.i)) || !validIndex(Number(node.params.j)) || node.params.i === node.params.j ||
      typeof node.params.i !== "bigint" || typeof node.params.j !== "bigint" ||
      node.amount <= 0n || node.amount > MAX_UINT || typeof node.params.minDy !== "bigint" ||
      node.params.minDy < 0n || node.params.minDy > MAX_UINT || inner.length !== 0 || node.children.length !== 0 ||
      (["curve-exchange", "curve-exchange-received-uint"].includes(action.id) && (typeof node.params.receiver !== "string" || !same(node.params.receiver, executor)))) {
      throw new Error("curve-plain invalid action or foreign receiver");
    }
    return action.encode(node, executor, inner);
  } }, descriptor: { adapterId: action.id, lineage: "curve", edgeKind: "swap", action: "swap",
    canSendValue: false, leavesStandingPositionDefault: false } });
}
export const curvePlainReceivedAction = owned(curveExchangeAdapter);
export const curvePlainNoReceiverAction = owned(curveExchangeNoReceiverAdapter);
export const curvePlainRegularAction = owned(curvePlainExchangeAdapter);
export const curvePlainUintReceivedAction = owned(curveExchangeReceivedUintAdapter);
// Uint-index transferFrom exchanges (e.g. Tricrypto), proved independently of
// exchange_received. Keep the new action wholly owned by this Family.
export const curvePlainUintExchangeAction = owned({
  id: "curve-exchange-uint", isWrapper: false, field2Offset: null,
  encode(node, executor) {
    return encodeCall(node.target, ethers.getBytes(executionData("exchange-uint",
      Number(node.params.i), Number(node.params.j), node.amount,
      node.params.minDy as bigint, executor)));
  },
  matchTrace: (_target, observedSelector) => observedSelector === selector("exchange-uint"),
});
