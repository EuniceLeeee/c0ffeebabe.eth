import { encodeAssertBalanceGte } from "../encoder.js";
import type { ActionAdapter, ResolvedPlanNode } from "../types.js";

/** Opcode 0x08: ASSERT_BALANCE_GTE. Not a CALL — direct opcode. */
export const assertBalanceAdapter: ActionAdapter = {
  id: "assert-balance",
  isWrapper: false,
  field2Offset: null,
  descriptor: {
    adapterId: "assert-balance",
    lineage: "erc20-infra",
    edgeKind: null,
    action: "guard",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },

  encode(node: ResolvedPlanNode, _executor: string, _inner: Uint8Array) {
    const threshold = node.amount;
    return encodeAssertBalanceGte(node.target, threshold);
  },

  matchTrace() {
    return false; // not a trace-matchable call
  },
};
