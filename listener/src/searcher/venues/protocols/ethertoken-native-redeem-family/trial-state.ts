import { ethers } from "ethers";
import type { ExactQuoteInput, ExactQuoteResult, ExactTrialStateRef } from "../../adapter-family-plugin.js";
import type { AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import { hashCanonical } from "../../canonical-value.js";
import { nativeBalanceState, storageState, tokenBalanceState, tokenSupplyState } from "../../local-state-models/resources.js";
import { assertSource, callRequest, codeRequest, decodeUint, MAX_UINT256, requireRuntimeCode, successfulResult } from "../standard-family/common.js";
import { assertEtherTokenNativeInvocation, etherTokenNativeStaticProjection } from "./shared.js";
import type { EtherTokenNativeRedeemDescriptor, EtherTokenNativeRedeemExactEvidence, EtherTokenNativeRedeemRoute } from "./types.js";

type Input = ExactQuoteInput<EtherTokenNativeRedeemDescriptor, EtherTokenNativeRedeemRoute>;
const ABI = new ethers.Interface(["function totalSupply() view returns(uint256)", "function getEthBalance(address) view returns(uint256)"]);
const MULTICALL = "0xcA11bde05977b3631167028862bE2a173976CA11";
// EtherToken.sol verified runtime (solc 0.4.11); source SHA256
// 9aa7a623288fbbf76b6ad8bb0098fc8ac25218cb1bcc145e56ff6d57886ebfc6.
// A semantic model selector, not an allowlist of deployed token addresses.
const RUNTIME_HASH = "0xa97e7b5fafbaaae7f264dcaba4415e7374db347150d7ef446afadcdcc238d4d6";
export function verifyEtherTokenTrialRuntime(code: string): boolean {
  return /^0x(?:[0-9a-fA-F]{2})+$/.test(code) && ethers.keccak256(code) === RUNTIME_HASH;
}
export interface EtherTokenTrialState { readonly source: CanonicalSource; readonly supply: bigint; readonly nativeBalance: bigint }
function ref(i: Input): ExactTrialStateRef {
  const token = i.descriptor.token;
  return { key: `evm:${token.toLowerCase()}:ethertoken-native`, schema: "ethertoken-native-inventory:v1",
    binding: hashCanonical(etherTokenNativeStaticProjection(i.descriptor)),
    dependencies: [storageState(token), tokenSupplyState(token), nativeBalanceState(token)] };
}
function validate(i: Input): void {
  assertEtherTokenNativeInvocation(i.descriptor, i.route);
  if (!i.trialState) throw new Error("EtherToken sequential quote requires issued trial state");
  if (typeof i.amountIn !== "bigint" || i.amountIn <= 0n || i.amountIn > MAX_UINT256) throw new Error("EtherToken trial requires positive uint256 input");
  if ([i.descriptor.token, i.descriptor.nativeAnchor, ethers.ZeroAddress].some(a => a.toLowerCase() === i.executor.toLowerCase()) ||
      i.descriptor.token.toLowerCase() === i.descriptor.nativeAnchor.toLowerCase()) throw new Error("EtherToken trial account alias unsupported");
}
export function etherTokenTrialRequests(i: Input) {
  validate(i);
  i.trialState!.get(ref(i));
  return [codeRequest("trial-token-code", i.descriptor.token),
    callRequest("trial-supply", i.descriptor.token, ABI.encodeFunctionData("totalSupply")),
    callRequest("trial-native", MULTICALL, ABI.encodeFunctionData("getEthBalance", [i.descriptor.token]))];
}
export function decodeEtherTokenTrial(i: Input, results: readonly AdapterRequestResult[]): EtherTokenTrialState {
  validate(i);
  if (results.length !== 3) throw new Error("EtherToken trial state results missing or ambiguous");
  for (const r of results) assertSource(successfulResult(results, r.id).source, i.source);
  if (!verifyEtherTokenTrialRuntime(requireRuntimeCode(results, "trial-token-code"))) throw new Error("EtherToken local runtime model unproven");
  i.trialState!.get(ref(i));
  return { source: i.source, supply: decodeUint(ABI, "totalSupply", results, "trial-supply"),
    nativeBalance: decodeUint(ABI, "getEthBalance", results, "trial-native") };
}
export function quoteEtherTokenTrial(i: Input, initial?: EtherTokenTrialState): ExactQuoteResult<EtherTokenNativeRedeemExactEvidence> | undefined {
  validate(i);
  const fullRef = ref(i), state = i.trialState!.get(fullRef) as EtherTokenTrialState | undefined ?? initial;
  if (!state) return undefined;
  assertSource(state.source, i.source);
  if (i.amountIn > state.supply || i.amountIn > state.nativeBalance) throw new Error("EtherToken trial supply or native capacity exceeded");
  // withdrawTo uses safeSub for supply and caller balance, then native transfer.
  // Route-owned caller funds/native receiving remain checked by final simulation.
  return { amountOut: i.amountIn, evidence: { kind: "ethertoken-native-one-to-one", source: i.source,
    token: ethers.getAddress(i.descriptor.token), amountIn: i.amountIn, amountOut: i.amountIn,
    executor: ethers.getAddress(i.executor), bindingFingerprint: i.route.bindingRef.fingerprint },
    stateChanges: [{ ref: fullRef, value: { ...state, supply: state.supply - i.amountIn, nativeBalance: state.nativeBalance - i.amountIn } }],
    stateEffects: [storageState(i.descriptor.token), tokenSupplyState(i.descriptor.token), tokenBalanceState(i.descriptor.token, i.executor),
      nativeBalanceState(i.descriptor.token), nativeBalanceState(i.executor), nativeBalanceState(i.descriptor.nativeAnchor), storageState(i.descriptor.nativeAnchor),
      tokenBalanceState(i.descriptor.nativeAnchor, i.executor), tokenSupplyState(i.descriptor.nativeAnchor)] };
}
