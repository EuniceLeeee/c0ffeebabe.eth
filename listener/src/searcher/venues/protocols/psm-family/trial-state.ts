import { ethers } from "ethers";
import type { ExactQuoteInput, ExactQuoteResult, ExactTrialStateRef } from "../../adapter-family-plugin.js";
import type { AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import { hashCanonical } from "../../canonical-value.js";
import { storageState, tokenBalanceState } from "../../local-state-models/resources.js";
import { assertSource, callRequest, codeRequest, decodeAddress, decodeUint, MAX_UINT256, requireRuntimeCode, successfulResult } from "../standard-family/common.js";
import { psmStaticBindingProjection } from "./binding.js";
import { PSM_INTERFACE, psmBuyCost, psmBuyQuote, psmSellQuote } from "./codec.js";
import { verifyPsmTrialModel } from "./local-model.js";
import type { PsmDescriptor, PsmExactEvidence, PsmRoute } from "./types.js";

type Input = ExactQuoteInput<PsmDescriptor, PsmRoute>;
const ERC20 = new ethers.Interface(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"]);
interface PsmTrialState {
  readonly source: CanonicalSource;
  readonly pocket: string;
  readonly tin: bigint;
  readonly tout: bigint;
  readonly daiBalance: bigint;
  readonly gemBalance: bigint;
  // A conservative capacity, not a claim about MAX_UINT sentinel semantics in
  // every nominal ERC20. Always subtracting covers both decrementing and
  // non-decrementing unlimited approvals; it can only reject, never overquote.
  readonly pocketAllowanceFloor: bigint;
}
const allowanceState = (token: string, owner: string, spender: string) =>
  `token-allowance:${token.toLowerCase()}:${owner.toLowerCase()}:${spender.toLowerCase()}`;
function dependencies(i: Input, pocket: string): readonly string[] {
  const d = i.descriptor;
  return [storageState(d.target), tokenBalanceState(d.dai, d.target), tokenBalanceState(d.gem, pocket),
    allowanceState(d.gem, pocket, d.target)];
}
function ref(i: Input, pocket?: string): ExactTrialStateRef {
  return { key: `evm:${i.descriptor.target.toLowerCase()}:psm`, schema: "lite-psm-inventory:v1",
    binding: hashCanonical(psmStaticBindingProjection(i.descriptor)),
    ...(pocket === undefined ? {} : { dependencies: dependencies(i, pocket) }) };
}
function validateAccounts(i: Input, pocket: string): void {
  const actor = i.executor.toLowerCase();
  // The ordinary transfer model cannot conflate actor, inventory and token
  // accounts. No instance is admitted or rejected by a deployment address list.
  if ([i.descriptor.target, pocket, i.descriptor.gem, i.descriptor.dai].some(a => a.toLowerCase() === actor) ||
      pocket === ethers.ZeroAddress || pocket.toLowerCase() === i.descriptor.target.toLowerCase()) {
    throw new Error("PSM trial inventory account alias unsupported");
  }
}
export function psmTrialRequests(i: Input) {
  return [codeRequest("trial-code", i.descriptor.target),
    callRequest("trial-pocket", i.descriptor.target, PSM_INTERFACE.encodeFunctionData("pocket")),
    callRequest("trial-tin", i.descriptor.target, PSM_INTERFACE.encodeFunctionData("tin")),
    callRequest("trial-tout", i.descriptor.target, PSM_INTERFACE.encodeFunctionData("tout")),
    callRequest("trial-dai", i.descriptor.dai, ERC20.encodeFunctionData("balanceOf", [i.descriptor.target]))];
}
function pocketFromResults(i: Input, results: readonly AdapterRequestResult[]): string {
  for (const r of results) assertSource(successfulResult(results, r.id).source, i.source);
  const pocket = decodeAddress(PSM_INTERFACE, "pocket", results, "trial-pocket").toLowerCase();
  validateAccounts(i, pocket);
  if (!verifyPsmTrialModel(requireRuntimeCode(results, "trial-code"), { ...i.descriptor, pocket })) {
    throw new Error("PSM sequential local runtime model unproven");
  }
  // Detect an earlier unmodeled inventory change before accepting source reads.
  i.trialState?.get(ref(i, pocket));
  return pocket;
}
export function psmTrialDependentRequests(i: Input, initial: readonly AdapterRequestResult[]) {
  const pocket = pocketFromResults(i, initial);
  return [callRequest("trial-gem", i.descriptor.gem, ERC20.encodeFunctionData("balanceOf", [pocket])),
    callRequest("trial-allowance", i.descriptor.gem, ERC20.encodeFunctionData("allowance", [pocket, i.descriptor.target]))];
}
export function decodePsmTrial(i: Input, initial: readonly AdapterRequestResult[], all: readonly AdapterRequestResult[]): PsmTrialState {
  if (initial.length !== 5 || all.length !== 7) throw new Error("PSM trial results missing or ambiguous");
  const pocket = pocketFromResults(i, initial);
  for (const r of all) assertSource(successfulResult(all, r.id).source, i.source);
  return { source: i.source, pocket,
    tin: decodeUint(PSM_INTERFACE, "tin", all, "trial-tin"), tout: decodeUint(PSM_INTERFACE, "tout", all, "trial-tout"),
    daiBalance: decodeUint(ERC20, "balanceOf", all, "trial-dai"), gemBalance: decodeUint(ERC20, "balanceOf", all, "trial-gem"),
    pocketAllowanceFloor: decodeUint(ERC20, "allowance", all, "trial-allowance") };
}
export function quotePsmTrial(i: Input, initial?: PsmTrialState): ExactQuoteResult<PsmExactEvidence> | undefined {
  if (i.prefix?.length && !i.trialState) throw new Error("PSM prefix requires issued trial state");
  const state = i.trialState?.get(ref(i)) as PsmTrialState | undefined ?? initial;
  if (!state) return undefined;
  assertSource(state.source, i.source);
  validateAccounts(i, state.pocket);
  const fullRef = ref(i, state.pocket);
  i.trialState?.get(fullRef);
  const sell = i.route.direction === "sell-gem", fee = sell ? state.tin : state.tout;
  const amountOut = (sell ? psmSellQuote : psmBuyQuote)(i.amountIn, fee, i.descriptor.decimalScale);
  if (amountOut <= 0n) throw new Error("PSM exact quote returned no output");
  const spent = sell ? i.amountIn : psmBuyCost(amountOut, fee, i.descriptor.decimalScale);
  if (sell ? amountOut > state.daiBalance : amountOut > state.gemBalance || amountOut > state.pocketAllowanceFloor) {
    throw new Error("PSM trial inventory or allowance capacity exceeded");
  }
  const next: PsmTrialState = { ...state,
    daiBalance: state.daiBalance + (sell ? -amountOut : spent),
    gemBalance: state.gemBalance + (sell ? spent : -amountOut),
    pocketAllowanceFloor: state.pocketAllowanceFloor - (sell ? 0n : amountOut) };
  if (next.daiBalance > MAX_UINT256 || next.gemBalance > MAX_UINT256) throw new Error("PSM trial inventory overflow");
  return { amountOut, evidence: { kind: "psm-directional-fee", direction: i.route.direction, source: i.source,
    target: i.descriptor.target, amountIn: i.amountIn, amountOut, fee, bindingFingerprint: i.route.bindingRef.fingerprint },
    stateChanges: [{ ref: fullRef, value: next }],
    stateEffects: [tokenBalanceState(i.descriptor.dai, i.descriptor.target), tokenBalanceState(i.descriptor.gem, state.pocket),
      tokenBalanceState(i.descriptor.gem, i.executor), tokenBalanceState(i.descriptor.dai, i.executor),
      allowanceState(i.route.tokenIn, i.executor, i.descriptor.target),
      ...(!sell ? [allowanceState(i.descriptor.gem, state.pocket, i.descriptor.target)] : [])] };
}
