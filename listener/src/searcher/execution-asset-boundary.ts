import { ethers } from "ethers";
import { ADDR } from "../shared/constants/addresses.js";
import { RuntimeAmountProgram, runtimeProgramScript, type RuntimeAmountLeg } from "../adapters/runtime-amount-program.js";
import { assertSubscriptCalldata, buildSubscriptCalldata } from "../shared/executor/botvm-program-entry.js";
import type { ActionAdapter } from "../types.js";
import type { PlanFragment } from "./venues/route-leg-adapter.js";
import type { FamilyRouteDescriptor } from "./venues/adapter-family-plugin.js";
import { runtimeExecutor, runtimeNativeBoundary, RUNTIME_ERC20 } from "./venues/runtime-execution.js";
import { planFragmentNodes } from "./solver/plan-fragment-requirements.js";
import { assertExecutionRounding } from "../shared/executor/amount-rounding.js";

type RouteAssets = Pick<FamilyRouteDescriptor, "tokenIn" | "tokenOut" | "executionAssets">;
const BOUNDARY_ACTION = "execution-asset-boundary";

/** Strict probes supply a raw executor program and the same settlement facts
 * as a production route. Central materialization applies the common boundary. */
export interface StrictExecutionAssetBoundary extends RouteAssets {
  readonly executionAssets: NonNullable<RouteAssets["executionAssets"]>;
  readonly amountIn: bigint;
  readonly minimum: bigint;
}

export function assertStrictExecutionAssetBoundary(value: StrictExecutionAssetBoundary): void {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).sort().join(",") !== "amountIn,executionAssets,minimum,tokenIn,tokenOut" ||
      Object.values(Object.getOwnPropertyDescriptors(value)).some(d => !("value" in d) || !d.enumerable) ||
      typeof value.amountIn !== "bigint" || value.amountIn <= 0n || value.amountIn > ethers.MaxUint256 ||
      typeof value.minimum !== "bigint" || value.minimum < 0n || value.minimum > ethers.MaxUint256 ||
      !executionNativeSides(value)) throw new Error("strict execution asset boundary declaration");
  if (ethers.getAddress(value.tokenIn) === ethers.ZeroAddress || ethers.getAddress(value.tokenOut) === ethers.ZeroAddress) {
    throw new Error("strict execution asset address");
  }
}

export function applyStrictAssetBoundary(input: {
  boundary: StrictExecutionAssetBoundary; executor: string; data: string;
}): string {
  assertStrictExecutionAssetBoundary(input.boundary);
  assertSubscriptCalldata(input.data);
  const [script] = ethers.AbiCoder.defaultAbiCoder().decode(["bytes"], `0x${input.data.slice(10)}`);
  const p = envelope({ route: input.boundary, executor: input.executor,
    script: ethers.getBytes(script), minimum: input.boundary.minimum });
  return buildSubscriptCalldata(runtimeProgramScript(p.bytes(), input.boundary.amountIn));
}

/** Native is declared protocol data, never guessed from Family names, raw
 * sentinel addresses or the fact that a graph edge happens to contain WETH. */
export function executionNativeSides(route: RouteAssets): { input: boolean; output: boolean } | null {
  const assets = route.executionAssets;
  if (assets === undefined) return null;
  if (!assets || typeof assets !== "object" || Array.isArray(assets) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(assets)) ||
      Reflect.ownKeys(assets).sort().join(",") !== "input,output" ||
      Object.values(Object.getOwnPropertyDescriptors(assets)).some(d => !("value" in d) || !d.enumerable) ||
      !["erc20", "native"].includes(assets.input) || !["erc20", "native"].includes(assets.output)) {
    throw new Error("execution asset declaration");
  }
  const input = assets.input === "native", output = assets.output === "native";
  if (!input && !output) return null;
  if (input && output || ethers.getAddress(route.tokenIn) === ethers.getAddress(route.tokenOut) ||
      ethers.getAddress(input ? route.tokenIn : route.tokenOut) !== ethers.getAddress(ADDR.WETH)) {
    throw new Error("execution native graph binding");
  }
  return { input, output };
}

/** A nested program keeps boundary registers private even for callback-heavy
 * operations. Only existing VM instructions are used; no protocol ABI enters
 * the central envelope. All safety checks execute inside the same transaction. */
function envelope(input: {
  route: RouteAssets; executor: string; script: Uint8Array;
  amountPatch?: number; minimum: bigint;
  inputToleranceRawUnits?: bigint;
}): RuntimeAmountProgram {
  const sides = executionNativeSides(input.route);
  if (!sides || input.minimum < 0n || input.minimum > ethers.MaxUint256) throw new Error("execution asset envelope");
  if (input.inputToleranceRawUnits !== undefined) assertExecutionRounding(input.inputToleranceRawUnits);
  const actor = runtimeExecutor(input.executor, input.route.tokenIn, input.route.tokenOut);
  const balance = RUNTIME_ERC20.encodeFunctionData("balanceOf", [actor]);
  const p = new RuntimeAmountProgram();
  const native = runtimeNativeBoundary(p, ADDR.WETH);
  p.call(input.route.tokenIn, balance, { static: true }).load(1, 0).math("sub", 2, 1, 0)
    .call(input.route.tokenOut, balance, { static: true }).load(3, 0);
  if (sides.input) native.unwrapInput();
  p.call(actor, buildSubscriptCalldata(input.script), input.amountPatch === undefined ? {} : {
    patches: [{ offset: 68 + input.amountPatch, reg: 0 }],
  });
  // Native input may be partially spent. Only its unspent amount is rewrapped;
  // native output is independently measured, never a quoted transfer quantity.
  native.wrapOutput();
  native.assertRestored();
  // An individual operation may spend less, but never subsidize itself from
  // old inventory. The enclosing flow retains its exact intermediate-token and
  // final repayment/conservation checks.
  p.call(input.route.tokenIn, balance, { static: true }).load(4, 0).math("sub", 4, 4, 2);
  if (input.inputToleranceRawUnits !== undefined) {
    // Residual is nonnegative above, so old inventory cannot be used. Quoted
    // live legs also enforce the 0/1 policy and require a positive debit.
    p.constant(5, input.inputToleranceRawUnits).math("sub", 5, 5, 4)
      .math("sub", 5, 0, 4).constant(6, 1n).math("sub", 5, 5, 6);
  }
  p.call(input.route.tokenOut, balance, { static: true }).load(4, 0).math("sub", 4, 4, 3)
    .constant(5, input.minimum).math("sub", 4, 4, 5);
  return p;
}

/** Called unconditionally by the production execution issuer for every Family. */
export function applyRuntimeAssetBoundary(input: {
  route: RouteAssets; executor: string; leg: RuntimeAmountLeg;
}): RuntimeAmountLeg {
  if (!executionNativeSides(input.route)) return input.leg;
  const program = envelope({ ...input, script: runtimeProgramScript(ethers.getBytes(input.leg.program)),
    amountPatch: 1, minimum: 1n });
  return Object.freeze({ actionAdapterId: input.leg.actionAdapterId, program: ethers.hexlify(program.bytes()) });
}

/** Ownership of the raw fragment is checked before the issuer adds its own
 * infrastructure envelope. No Family registration or opt-in switch is needed. */
export function applyQuotedAssetBoundary(input: {
  route: RouteAssets; executor: string; amountIn: bigint; minimum: bigint; fragment: PlanFragment;
  inputToleranceRawUnits?: bigint;
}): PlanFragment {
  const sides = executionNativeSides(input.route);
  if (!sides) return input.fragment;
  if (input.inputToleranceRawUnits !== undefined) assertExecutionRounding(input.inputToleranceRawUnits);
  return { requirements: [], nodes: [{ adapterId: BOUNDARY_ACTION, target: input.executor,
    tokenIn: input.route.tokenIn, tokenOut: input.route.tokenOut, amount: input.amountIn,
    params: { nativeInput: sides.input, nativeOutput: sides.output, minAmountOut: input.minimum,
      ...(input.inputToleranceRawUnits === undefined ? {} : { inputToleranceRawUnits: input.inputToleranceRawUnits }) },
    // Transfers as well as approvals belong inside the measured boundary.
    children: planFragmentNodes(input.fragment, input.route.tokenIn, input.amountIn) }] };
}

export const executionAssetBoundaryAdapter: ActionAdapter = {
  id: BOUNDARY_ACTION, isWrapper: true, field2Offset: null,
  descriptor: { adapterId: BOUNDARY_ACTION, lineage: "erc20-infra", edgeKind: null,
    action: "guard", canSendValue: true, leavesStandingPositionDefault: false },
  matchTrace: () => false,
  encode(node, executor, inner) {
    if (ethers.getAddress(node.target) !== ethers.getAddress(executor) || !node.children.length || !inner.length ||
        node.amount <= 0n || node.amount > ethers.MaxUint256 || typeof node.params.minAmountOut !== "bigint" ||
        typeof node.params.nativeInput !== "boolean" || typeof node.params.nativeOutput !== "boolean") {
      throw new Error("execution asset envelope node");
    }
    const route: RouteAssets = { tokenIn: node.tokenIn, tokenOut: node.tokenOut, executionAssets: {
      input: node.params.nativeInput ? "native" : "erc20", output: node.params.nativeOutput ? "native" : "erc20" } };
    const tolerance = node.params.inputToleranceRawUnits;
    if (tolerance !== undefined && typeof tolerance !== "bigint") throw new Error("execution input tolerance type");
    return runtimeProgramScript(envelope({ route, executor, script: inner, minimum: node.params.minAmountOut,
      inputToleranceRawUnits: tolerance }).bytes(), node.amount);
  },
};
