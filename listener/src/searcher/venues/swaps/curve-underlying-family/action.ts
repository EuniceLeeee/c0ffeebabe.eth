import { curveExchangeUnderlyingAdapter } from "../../../../adapters/curve.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";
import { ethers } from "ethers";
import { runtimeProgramScript } from "../../../../adapters/runtime-amount-program.js";
import { CURVE_UNDERLYING_NATIVE_ACTION, underlyingNativeAliasProgram } from "./native.js";
import { CURVE_UNDERLYING_LENDING_ACTION, underlyingLendingProgram } from "./lending-execution.js";
import { LENDING_ABI } from "./lending.js";
import { CURVE_UNDERLYING_UINT_INTERFACE } from "./codec.js";

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

export const curveUnderlyingNativeFamilyOwnedAction = bindFamilyOwnedAction({
  action: {
    id: CURVE_UNDERLYING_NATIVE_ACTION, isWrapper: false, field2Offset: null,
    encode(node, executor, inner) {
      if (typeof node.params.i !== "bigint" || typeof node.params.j !== "bigint" ||
          typeof node.params.nativeIn !== "boolean" || typeof node.params.nativeOut !== "boolean" ||
          typeof node.params.inputToleranceRawUnits !== "bigint" ||
          typeof node.params.minDy !== "bigint" || node.amount <= 0n || node.amount > ethers.MaxUint256 ||
          inner.length || node.children.length) throw new Error("curve-underlying invalid native action");
      return runtimeProgramScript(underlyingNativeAliasProgram(node.target, node.tokenIn, node.tokenOut,
        Number(node.params.i), Number(node.params.j), executor, node.params.nativeIn, node.params.nativeOut,
        node.params.minDy, node.params.inputToleranceRawUnits).bytes(), node.amount);
    },
    matchTrace: (_target, selector) => selector === CURVE_UNDERLYING_UINT_INTERFACE.getFunction("exchange_underlying")!.selector,
  },
  descriptor: { adapterId: CURVE_UNDERLYING_NATIVE_ACTION, lineage: "curve", edgeKind: "swap", action: "swap",
    canSendValue: true, leavesStandingPositionDefault: false },
});

export const curveUnderlyingLendingFamilyOwnedAction = bindFamilyOwnedAction({
  action: {
    id: CURVE_UNDERLYING_LENDING_ACTION, isWrapper: false, field2Offset: null,
    encode(node, executor, inner) {
      if (typeof node.params.i !== "bigint" || typeof node.params.j !== "bigint" ||
          typeof node.params.minDy !== "bigint" || node.amount <= 0n || node.amount > ethers.MaxUint256 ||
          inner.length || node.children.length) throw new Error("curve-underlying invalid lending action");
      return runtimeProgramScript(underlyingLendingProgram(node.target, node.tokenIn, node.tokenOut,
        Number(node.params.i), Number(node.params.j), executor, node.params.minDy).bytes(), node.amount);
    },
    matchTrace: (_target, selector) => selector === LENDING_ABI.getFunction("exchange_underlying")!.selector,
  },
  descriptor: { adapterId: CURVE_UNDERLYING_LENDING_ACTION, lineage: "curve", edgeKind: "swap", action: "swap",
    canSendValue: false, leavesStandingPositionDefault: false },
});
