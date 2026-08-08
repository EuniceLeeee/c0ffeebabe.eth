import { curveExchangeUnderlyingAdapter } from "../../../../adapters/curve.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";

export const curveUnderlyingFamilyOwnedAction = bindFamilyOwnedAction({
  action: curveExchangeUnderlyingAdapter,
  descriptor: {
    adapterId: "curve-exchange-underlying",
    lineage: "curve",
    edgeKind: "swap",
    action: "swap",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
});
