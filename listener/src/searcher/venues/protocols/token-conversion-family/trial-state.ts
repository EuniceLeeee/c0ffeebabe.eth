import type { ExactQuoteInput, ExactQuoteResult, ExactTrialStateRef } from "../../adapter-family-plugin.js";
import { hashCanonical } from "../../canonical-value.js";
import { storageState, tokenBalanceState, tokenSupplyState } from "../../local-state-models/resources.js";
import { readV3TrialState, v3TrialStateRef, v3TrialStateEffects, type V3TrialBinding } from "../../local-state-models/v3-state.js";
import { staticProjection } from "./binding.js";
import { quoteBear, type BearState } from "./bear-local.js";
import { quoteXwinTransition, type XwinLocalFundState } from "./xwin-transition.js";
import type { ConversionDescriptor, ConversionExactEvidence, ConversionRoute } from "./types.js";

type Input = ExactQuoteInput<ConversionDescriptor, ConversionRoute>;
export interface XwinTrialFund {
  readonly state: XwinLocalFundState;
  readonly resources: { readonly dependencies: readonly string[]; readonly effects: readonly string[] };
}
function conversionRef(input: Input, dependencies?: readonly string[]): ExactTrialStateRef {
  const d = input.descriptor;
  return { key: `evm:${d.target.toLowerCase()}:conversion`, schema: `${d.variant}:trial-v1`,
    binding: hashCanonical({ descriptor: staticProjection(d), executor: input.executor.toLowerCase() }),
    // The full xWin dependencies become known after source-pinned preparation.
    ...(dependencies === undefined ? {} : { dependencies }) };
}
function evidence(input: Input, amountOut: bigint): ConversionExactEvidence {
  return { kind: "token-conversion-balance-quote", source: input.source, executor: input.executor,
    direction: input.route.direction, amountIn: input.amountIn, amountOut, bindingFingerprint: input.route.bindingRef.fingerprint };
}
function bearResources(input: Input) {
  const d = input.descriptor;
  return [storageState(d.target), tokenSupplyState(d.target), tokenBalanceState(d.asset, d.target)];
}
export function quoteBearTrial(input: Input, initial?: BearState): ExactQuoteResult<ConversionExactEvidence> | undefined {
  if (input.prefix?.length && !input.trialState) throw new Error("conversion prefix requires issued trial state");
  const dependencies = bearResources(input), ref = conversionRef(input, dependencies);
  const state = (input.trialState?.get(ref) as BearState | undefined) ?? initial;
  if (state === undefined) return undefined;
  const amountOut = quoteBear(state, input.route.direction, input.amountIn);
  const delta = input.route.direction === "mint" ? input.amountIn : -input.amountIn;
  return { amountOut, evidence: evidence(input, amountOut), ...(input.trialState ? {
    stateChanges: [{ ref, value: { ...state, supply: state.supply + delta, backing: state.backing + delta } }],
    stateEffects: [...dependencies, tokenBalanceState(input.descriptor.target, input.executor),
      tokenBalanceState(input.descriptor.asset, input.executor)],
  } : {}) };
}

function poolBinding(state: XwinLocalFundState, key: string): V3TrialBinding {
  const pool = state.pools.get(key), routes = state.swaps.filter(route => route.poolKey === key);
  if (!pool || routes.length === 0) throw new Error("xWin shared pool has no verified route");
  const tokens = [...new Set(routes.flatMap(route => [route.tokenIn.toLowerCase(), route.tokenOut.toLowerCase()]))].sort();
  if (tokens.length !== 2) throw new Error("xWin shared pool token binding changed");
  return { pool: key, token0: tokens[0], token1: tokens[1], fee: pool.fee, tickSpacing: pool.tickSpacing };
}
export function quoteXwinTrial(input: Input, initial?: XwinTrialFund): ExactQuoteResult<ConversionExactEvidence> | undefined {
  if (input.prefix?.length && !input.trialState) throw new Error("conversion prefix requires issued trial state");
  const stored = input.trialState?.get(conversionRef(input)) as XwinTrialFund | undefined;
  const fund = stored ?? initial;
  if (fund === undefined) return undefined;
  // A dynamic ref is looked up again with its actual dependency closure, so an
  // unmodelled intervening effect cannot be hidden by a restored baseline.
  const ref = conversionRef(input, fund.resources.dependencies);
  if (input.trialState) input.trialState.get(ref);
  const pools = new Map(fund.state.pools);
  const bindings = new Map([...pools.keys()].map(key => [key, poolBinding(fund.state, key)]));
  for (const [key, binding] of bindings) {
    const current = readV3TrialState(input.trialState, binding);
    if (current !== undefined) pools.set(key, current);
  }
  const result = quoteXwinTransition({ ...fund.state, pools }, input.route.direction === "mint" ? "deposit" : "withdraw", input.amountIn);
  const touchedPools = [...new Set(result.swaps.map(swap => swap.poolKey))];
  return { amountOut: result.amountOut, evidence: evidence(input, result.amountOut), ...(input.trialState ? {
    stateChanges: [{ ref, value: { state: result.state, resources: fund.resources } },
      ...touchedPools.map(key => ({ ref: v3TrialStateRef(bindings.get(key)!), value: result.state.pools.get(key)! }))],
    stateEffects: [...new Set([...fund.resources.effects, ...touchedPools.flatMap(key => v3TrialStateEffects(bindings.get(key)!))])],
  } : {}) };
}
