import { ethers } from "ethers";
import type { ExactQuoteInput, ExactQuoteResult, ExactTrialStateRef } from "../../adapter-family-plugin.js";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import { hashCanonical } from "../../canonical-value.js";
import { nativeBalanceState, storageState, tokenBalanceState, tokenSupplyState } from "../../local-state-models/resources.js";
import { assertSource, callRequest, codeRequest, decodeAddress, decodeUint, MAX_UINT256, requireRuntimeCode, successfulResult } from "../standard-family/common.js";
import { calculateSelfBurnFee, decodeSelfBurnFees, selfBurnFeeRequests } from "./fee-quote.js";
import { SELF_BURN_IMPLEMENTATION_SLOT, verifySelfBurnImplementation, verifySelfBurnProxy } from "./local-model.js";
import { assertSelfBurnNativeInvocation, selfBurnNativeStaticProjection } from "./shared.js";
import type { SelfBurnNativeDescriptor, SelfBurnNativeExactEvidence, SelfBurnNativeFeeParameters, SelfBurnNativeRoute } from "./types.js";

type Input = ExactQuoteInput<SelfBurnNativeDescriptor, SelfBurnNativeRoute>;
const ABI = new ethers.Interface(["function totalSupply() view returns(uint256)", "function oracle() view returns(address)",
  "function getEthBalance(address) view returns(uint256)"]);
const MULTICALL = "0xcA11bde05977b3631167028862bE2a173976CA11";
export interface SelfBurnTrialState {
  readonly source: CanonicalSource;
  readonly implementation: string;
  readonly oracle: string;
  readonly fees: SelfBurnNativeFeeParameters;
  readonly supply: bigint;
  readonly nativeBalance: bigint;
}
function ref(i: Input, state?: Pick<SelfBurnTrialState, "implementation" | "oracle">): ExactTrialStateRef {
  const token = i.descriptor.token;
  return { key: `evm:${token.toLowerCase()}:native-self-burn`, schema: "cashiva-native-burn:v1",
    binding: hashCanonical(selfBurnNativeStaticProjection(i.descriptor)),
    ...(state ? { dependencies: [storageState(token), storageState(state.implementation), storageState(state.oracle),
      tokenSupplyState(token), nativeBalanceState(token)] } : {}) };
}
function validate(i: Input): void {
  assertSelfBurnNativeInvocation(i.descriptor, i.route);
  if (typeof i.amountIn !== "bigint" || i.amountIn <= 0n || i.amountIn > MAX_UINT256) throw new Error("self-burn trial requires positive uint256 input");
  if ([i.descriptor.token, i.descriptor.nativeAnchor, ethers.ZeroAddress].some(a => a.toLowerCase() === i.executor.toLowerCase()) ||
      i.descriptor.token.toLowerCase() === i.descriptor.nativeAnchor.toLowerCase()) throw new Error("self-burn trial account alias unsupported");
  if (!i.trialState) throw new Error("self-burn sequential quote requires issued trial state");
}
function implementation(i: Input, results: readonly AdapterRequestResult[]): string {
  for (const r of results) assertSource(successfulResult(results, r.id).source, i.source);
  if (!verifySelfBurnProxy(requireRuntimeCode(results, "trial-proxy-code"))) throw new Error("self-burn local proxy runtime model unproven");
  const word = successfulResult(results, "trial-implementation").data;
  if (!/^0x0{24}[0-9a-fA-F]{40}$/.test(word) || BigInt(word) === 0n) throw new Error("self-burn invalid implementation address");
  return ethers.getAddress(`0x${word.slice(-40)}`);
}
export function selfBurnTrialRequests(i: Input): readonly AdapterRequest[] {
  validate(i);
  // Check an existing cell before any baseline preparation, including its full
  // dynamic dependency closure. An invalidated source cannot be restored.
  i.trialState!.get(ref(i));
  return [...selfBurnFeeRequests(i.descriptor.token, "exact"),
    codeRequest("trial-proxy-code", i.descriptor.token),
    { id: "trial-implementation", kind: "get-storage", address: i.descriptor.token, slot: SELF_BURN_IMPLEMENTATION_SLOT },
    callRequest("trial-supply", i.descriptor.token, ABI.encodeFunctionData("totalSupply")),
    callRequest("trial-oracle", i.descriptor.token, ABI.encodeFunctionData("oracle")),
    callRequest("trial-native", MULTICALL, ABI.encodeFunctionData("getEthBalance", [i.descriptor.token]))];
}
export function selfBurnTrialDependentRequests(i: Input, results: readonly AdapterRequestResult[]): readonly AdapterRequest[] {
  validate(i);
  const impl = implementation(i, results), oracle = decodeAddress(ABI, "oracle", results, "trial-oracle");
  i.trialState!.get(ref(i, { implementation: impl, oracle }));
  return [codeRequest("trial-implementation-code", impl)];
}
export function decodeSelfBurnTrial(i: Input, initial: readonly AdapterRequestResult[], all: readonly AdapterRequestResult[]): SelfBurnTrialState {
  validate(i);
  if (initial.length !== 9 || all.length !== 10) throw new Error("self-burn trial state results missing or ambiguous");
  const impl = implementation(i, initial);
  for (const r of all) assertSource(successfulResult(all, r.id).source, i.source);
  if (!verifySelfBurnImplementation(requireRuntimeCode(all, "trial-implementation-code"), impl)) throw new Error("self-burn local implementation model unproven");
  const fees = decodeSelfBurnFees(initial.filter(r => r.id.startsWith("exact-")), "exact").fees;
  const state = { source: i.source, implementation: impl, oracle: decodeAddress(ABI, "oracle", initial, "trial-oracle"), fees,
    supply: decodeUint(ABI, "totalSupply", initial, "trial-supply"), nativeBalance: decodeUint(ABI, "getEthBalance", initial, "trial-native") };
  i.trialState!.get(ref(i, state));
  return state;
}
export function quoteSelfBurnTrial(i: Input, initial?: SelfBurnTrialState): ExactQuoteResult<SelfBurnNativeExactEvidence> | undefined {
  validate(i);
  const state = i.trialState!.get(ref(i)) as SelfBurnTrialState | undefined ?? initial;
  if (!state) return undefined;
  assertSource(state.source, i.source);
  const fullRef = ref(i, state);
  i.trialState!.get(fullRef);
  const fee = calculateSelfBurnFee(i.amountIn, state.fees), amountOut = i.amountIn - fee;
  if (amountOut <= 0n || i.amountIn > state.supply || amountOut > state.nativeBalance) throw new Error("self-burn trial supply or native capacity exceeded");
  // NativeWrappable transfers to itself then burns the same input; its own token
  // balance is unchanged. Fee/config and STATICCALL oracle state are unchanged.
  // Caller funds, oracle eligibility and native receive still require final sim.
  return { amountOut, evidence: { kind: "self-burn-native-fee-quote", source: i.source, token: ethers.getAddress(i.descriptor.token),
    amountIn: i.amountIn, amountOut, executor: ethers.getAddress(i.executor), bindingFingerprint: i.route.bindingRef.fingerprint, fee, fees: state.fees },
    stateChanges: [{ ref: fullRef, value: { ...state, supply: state.supply - i.amountIn, nativeBalance: state.nativeBalance - amountOut } }],
    stateEffects: [storageState(i.descriptor.token), tokenSupplyState(i.descriptor.token), tokenBalanceState(i.descriptor.token, i.executor),
      nativeBalanceState(i.descriptor.token), nativeBalanceState(i.executor), nativeBalanceState(i.descriptor.nativeAnchor), storageState(i.descriptor.nativeAnchor),
      tokenBalanceState(i.descriptor.nativeAnchor, i.executor), tokenSupplyState(i.descriptor.nativeAnchor)] };
}
