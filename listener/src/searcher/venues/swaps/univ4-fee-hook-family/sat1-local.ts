import { ethers } from "ethers";
import { BLOCKSCAN_MULTICALL3 } from "../../../blockscan-multicall.js";
import type { ExactQuoteInput, ExactTrialStateRef, ExactRequestProgram } from "../../adapter-family-plugin.js";
import { hashCanonical } from "../../canonical-value.js";
import { nativeBalanceState, storageState, tokenBalanceState, tokenSupplyState } from "../../local-state-models/resources.js";
import { assertSameSource, requireSuccessfulResult, poolKeyFingerprint } from "../univ4-family/codec.js";
import { UNIV4_STATE_VIEW_INTERFACE } from "../univ4-abi.js";
import { hookDataFor, SAT1, SAT1_HOOK_CODE_HASH, SAT1_TOKEN_CODE_HASH } from "./sat1.js";
import { sat1QuoteAndApply, type Sat1LocalState } from "./sat1-math.js";
import type { FeeHookDescriptor, FeeHookRoute, FeeHookExactEvidence } from "./types.js";

type Input = ExactQuoteInput<FeeHookDescriptor, FeeHookRoute>;
interface PinnedState extends Sat1LocalState {
  readonly source: Input["source"];
  readonly initializedPools: readonly string[];
}
const BALANCE = new ethers.Interface(["function getEthBalance(address account) view returns (uint256)"]);
const lower = (a: string) => ethers.getAddress(a).toLowerCase();
const actor = (input: Input, buy: boolean) => lower(String(ethers.AbiCoder.defaultAbiCoder().decode(
  ["address"], hookDataFor(input.descriptor, input.executor, buy))[0]));
function ref(input: Input): ExactTrialStateRef {
  const d = input.descriptor;
  return { key: `hook:${lower(d.hook)}`, schema: "sat1-post-entropy-state-v1",
    binding: hashCanonical({ hook: lower(d.hook), token: lower(d.poolKey.currency1), manager: lower(d.managerBinding.manager),
      hookCodeHash: SAT1_HOOK_CODE_HASH, tokenCodeHash: SAT1_TOKEN_CODE_HASH }),
    dependencies: [storageState(d.hook), nativeBalanceState(d.hook), storageState(d.poolKey.currency1), tokenSupplyState(d.poolKey.currency1),
      nativeBalanceState(d.managerBinding.manager), tokenBalanceState(d.poolKey.currency1, d.managerBinding.manager)] };
}
function trialState(input: Input): PinnedState | undefined {
  const value = input.trialState?.get(ref(input));
  if (value === undefined) return undefined;
  const state = value as PinnedState;
  if (!state || !state.source || !state.lastBuyBlocks || typeof state.initialized !== "boolean" ||
      typeof state.deprecated !== "boolean" ||
      !Array.isArray(state.initializedPools) || [state.ethCum, state.actualSupply, state.nativeBalance, state.managerNativeBalance,
        state.managerTokenBalance, state.genesisBlock].some(v => typeof v !== "bigint")) {
    throw new Error("sat1 invalid trial state");
  }
  assertSameSource(state.source, input.source);
  return state;
}
function evidence(input: Input, amountOut: bigint): FeeHookExactEvidence {
  const buy = input.route.direction === "zero-for-one";
  const d = input.descriptor;
  return { kind: "sat1-local-exact-in", source: input.source,
    poolId: d.poolId, poolKeyFingerprint: poolKeyFingerprint(d.poolKey), quoter: d.managerBinding.quoter,
    tokenIn: input.route.tokenIn, tokenOut: input.route.tokenOut, amountIn: input.amountIn,
    amountOut, gasEstimate: 0n, hookData: hookDataFor(d, input.executor, buy) };
}
function quote(input: Input, state: PinnedState) {
  const buy = input.route.direction === "zero-for-one";
  const result = sat1QuoteAndApply(state, input.amountIn, buy, actor(input, buy), BigInt(input.source.number));
  const d = input.descriptor;
  return { amountOut: result.amountOut, evidence: evidence(input, result.amountOut),
    ...(input.trialState ? {
      stateChanges: [{ ref: ref(input), value: Object.freeze({ ...result.nextState, source: state.source }) }],
      // The curve does not use PoolManager AMM reserves. Only resources with
      // lasting changes are published, not manager transient unlock accounting.
      stateEffects: [storageState(d.hook), nativeBalanceState(d.hook), storageState(d.poolKey.currency1),
        tokenSupplyState(d.poolKey.currency1), tokenBalanceState(d.poolKey.currency1, input.executor),
        tokenBalanceState(d.graphToken0, input.executor), tokenSupplyState(d.graphToken0),
        nativeBalanceState(d.graphToken0)],
    } : {}),
  };
}
function requests(input: Input) {
  const d = input.descriptor;
  const fields = ["ethCum", "selfDeprecated", "poolInitialized", "GENESIS_BLOCK", "totalSupply"] as const;
  return [
    ...fields.map(fn => ({ id: `sat1-local:${fn}`, kind: "eth-call" as const,
      to: fn === "totalSupply" ? d.poolKey.currency1 : d.hook,
      data: SAT1.encodeFunctionData(fn), completion: "return-data" as const })),
    { id: "sat1-local:nativeBalance", kind: "eth-call" as const, to: BLOCKSCAN_MULTICALL3,
      data: BALANCE.encodeFunctionData("getEthBalance", [d.hook]), completion: "return-data" as const },
    { id: "sat1-local:managerNativeBalance", kind: "eth-call" as const, to: BLOCKSCAN_MULTICALL3,
      data: BALANCE.encodeFunctionData("getEthBalance", [d.managerBinding.manager]), completion: "return-data" as const },
    { id: "sat1-local:managerTokenBalance", kind: "eth-call" as const, to: d.poolKey.currency1,
      data: SAT1.encodeFunctionData("balanceOf", [d.managerBinding.manager]), completion: "return-data" as const },
    { id: "sat1-local:slot0", kind: "eth-call" as const, to: d.managerBinding.stateView,
      data: UNIV4_STATE_VIEW_INTERFACE.encodeFunctionData("getSlot0", [d.poolId]), completion: "return-data" as const },
    ...[true, false].map(buy => ({ id: `sat1-local:cooldown:${buy ? "buy" : "sell"}`, kind: "eth-call" as const,
      to: d.hook, data: SAT1.encodeFunctionData("lastBuyBlock", [actor(input, buy)]), completion: "return-data" as const })),
  ];
}
function decode(input: Input, results: Parameters<ExactRequestProgram<FeeHookDescriptor, FeeHookRoute, FeeHookExactEvidence>["decode"]>[0]["initialResults"]): PinnedState {
  if (results.length !== 11) throw new Error("sat1 invalid local state result count");
  const get = (id: string, fn: string, iface = SAT1) => {
    const result = requireSuccessfulResult(results, `sat1-local:${id}`);
    assertSameSource(result.source, input.source);
    return iface.decodeFunctionResult(fn, result.data)[0];
  };
  if (BigInt(get("slot0", "getSlot0", UNIV4_STATE_VIEW_INTERFACE)) <= 0n) throw new Error("sat1 source pool is not initialized");
  return Object.freeze({ source: Object.freeze({ ...input.source }), initializedPools: Object.freeze([input.descriptor.poolId.toLowerCase()]),
    ethCum: BigInt(get("ethCum", "ethCum")),
    actualSupply: BigInt(get("totalSupply", "totalSupply")), nativeBalance: BigInt(get("nativeBalance", "getEthBalance", BALANCE)),
    managerNativeBalance: BigInt(get("managerNativeBalance", "getEthBalance", BALANCE)),
    managerTokenBalance: BigInt(get("managerTokenBalance", "balanceOf")),
    genesisBlock: BigInt(get("GENESIS_BLOCK", "GENESIS_BLOCK")), initialized: Boolean(get("poolInitialized", "poolInitialized")),
    deprecated: Boolean(get("selfDeprecated", "selfDeprecated")), lastBuyBlocks: Object.freeze({
      [actor(input, true)]: BigInt(get("cooldown:buy", "lastBuyBlock")),
      [actor(input, false)]: BigInt(get("cooldown:sell", "lastBuyBlock")),
    }) });
}
/** One block-bound state load; later route legs use the public trial state.
 * No stateOnlyReads declaration: block height is part of cooldown/entropy. */
export function sat1LocalExactMethod(validate: (input: Input) => void) {
  const program: ExactRequestProgram<FeeHookDescriptor, FeeHookRoute, FeeHookExactEvidence> = {
    requirements: () => ({ transports: ["eth-call"] }),
    buildRequests(input) { validate(input); return input.amountIn === 0n ? [] : requests(input); },
    decode({ programInput: input, initialResults, dependentEvidence }) {
      validate(input);
      if (dependentEvidence.length !== 0) throw new Error("sat1 unexpected dependent state read");
      if (input.amountIn === 0n) {
        if (initialResults.length !== 0) throw new Error("sat1 unexpected zero state results");
        return { amountOut: 0n, evidence: evidence(input, 0n) };
      }
      // Even if source reads were memoized, a loaded trial must win over them.
      const sourceState = decode(input, initialResults);
      const current = trialState(input);
      // Multiple V4 PoolIds can bind the same hook. Preserve the shared curve,
      // while proving each newly encountered PoolId exists at this source.
      return quote(input, current ? { ...current,
        initializedPools: Object.freeze([...new Set([...current.initializedPools, ...sourceState.initializedPools])]) } : sourceState);
    },
  };
  return { id: "sat1-local-exact-in", kind: "request-program" as const,
    trialState: { quote(input: Input) {
      validate(input);
      const state = trialState(input);
      return state === undefined || !state.initializedPools.includes(input.descriptor.poolId.toLowerCase())
        ? { status: "not-applicable" as const, reason: "sat1 trial state or source pool proof not loaded" }
        : { status: "quoted" as const, result: quote(input, state) };
    } }, program };
}
