import { encodeRuntimeAmountNode } from "../../../../adapters/runtime-amount-program.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";
import { ALGEBRA_INTEGRAL_ADAPTER_ID, ALGEBRA_SWAP_SELECTOR } from "./abi.js";

/** Offset of the `bytes data` head word in `swap`'s calldata (4 + 4*32). */
const CALLBACK_FIELD2_OFFSET = 132;

/**
 * Family-owned action for the Algebra Integral pool swap. This family has NO
 * amount-bearing encode path: the only admissible node shape carries the
 * `runtimeAmountProgram` the family compiles in `execution.ts`, so a quoted or
 * otherwise off-chain amount can never be baked into calldata here.
 */
export const algebraIntegralSwapAction = bindFamilyOwnedAction({
  action: {
    id: ALGEBRA_INTEGRAL_ADAPTER_ID,
    isWrapper: true,
    field2Offset: CALLBACK_FIELD2_OFFSET,
    encode(node, _executor, innerScript) {
      if (node.adapterId !== ALGEBRA_INTEGRAL_ADAPTER_ID || node.amount <= 0n) {
        throw new Error("algebra-integral invalid action node");
      }
      const runtime = encodeRuntimeAmountNode(node, innerScript);
      if (runtime === null) {
        throw new Error(
          "algebra-integral swap nodes require the family runtime amount program",
        );
      }
      return runtime;
    },
    matchTrace: (_target, selector) =>
      selector.toLowerCase() === ALGEBRA_SWAP_SELECTOR,
  },
  descriptor: {
    adapterId: ALGEBRA_INTEGRAL_ADAPTER_ID,
    lineage: "custom-swap:algebra-integral",
    edgeKind: "swap",
    action: "swap",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
});
