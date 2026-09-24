import { ethers } from "ethers";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import { VAULT, VAULT_ABI, MAX_INPUT, MAX_UINT, assertSource, bool, decodeReturn, hooksConfig,
  resultSource, returned, same, uint } from "./codec.js";
import { assertRoute } from "./routes.js";
import { quoteBalancerExactInScaled18 } from "./local-math.js";
import type { BalancerLocalModel } from "./local-model.js";
import type { BalancerV3Descriptor, BalancerV3Route } from "./types.js";

// The immutable mainnet Vault's 20241204 deployment ABI/semantics. Unlike
// getPoolTokenInfo.lastBalancesLiveScaled18, getPoolData loads CURRENT rates
// and deducts accrued yield fees before rescaling the raw balances.
export const LOCAL_VAULT_ABI = new ethers.Interface([
  "function getPoolData(address pool) view returns (tuple(bytes32 poolConfigBits,address[] tokens,tuple(uint8 tokenType,address rateProvider,bool paysYieldFees)[] tokenInfo,uint256[] balancesRaw,uint256[] balancesLiveScaled18,uint256[] tokenRates,uint256[] decimalScalingFactors))",
  "function isPoolPaused(address pool) view returns (bool)",
  "function isVaultPaused() view returns (bool)",
  "function isQueryDisabled() view returns (bool)",
  "function getMinimumTradeAmount() view returns (uint256)",
]);
export const LOCAL_POOL_ABI = new ethers.Interface([
  "function getNormalizedWeights() view returns (uint256[])",
  "function getMinTokenBalances() view returns (uint256[])",
  "function getAmplificationParameter() view returns (uint256 value,bool isUpdating,uint256 precision)",
]);
const WAD = 10n ** 18n;
const MAX_BALANCE = (1n << 128n) - 1n;
export interface BalancerLocalState {
  readonly source: CanonicalSource;
  readonly model: BalancerLocalModel;
  readonly balancesRaw: readonly bigint[];
  readonly balances: readonly bigint[];
  readonly rates: readonly bigint[];
  readonly scalingFactors: readonly bigint[];
  readonly swapFee: bigint;
  readonly aggregateSwapFee: bigint;
  readonly minimumTradeAmount: bigint;
  readonly weights?: readonly bigint[];
  readonly minTokenBalances?: readonly bigint[];
  readonly amp?: bigint;
}

function read(id: string, to: string, data: string): AdapterRequest {
  return { id, kind: "eth-call", to, data, completion: "return-data" };
}
export function localStateRequests(descriptor: BalancerV3Descriptor): readonly AdapterRequest[] {
  const model = descriptor.binding.localModel;
  if (!model) throw new Error("balancer-v3 unproven local model");
  return [
    read("local-data", VAULT, LOCAL_VAULT_ABI.encodeFunctionData("getPoolData", [descriptor.pool])),
    read("local-hooks", VAULT, VAULT_ABI.encodeFunctionData("getHooksConfig", [descriptor.pool])),
    read("local-paused", VAULT, LOCAL_VAULT_ABI.encodeFunctionData("isPoolPaused", [descriptor.pool])),
    read("local-vault-paused", VAULT, LOCAL_VAULT_ABI.encodeFunctionData("isVaultPaused")),
    read("local-query-disabled", VAULT, LOCAL_VAULT_ABI.encodeFunctionData("isQueryDisabled")),
    read("local-minimum-trade", VAULT, LOCAL_VAULT_ABI.encodeFunctionData("getMinimumTradeAmount")),
    model.startsWith("weighted-")
      ? read("local-weights", descriptor.pool, LOCAL_POOL_ABI.encodeFunctionData("getNormalizedWeights"))
      : read("local-amp", descriptor.pool, LOCAL_POOL_ABI.encodeFunctionData("getAmplificationParameter")),
    ...(model === "weighted-v2" ? [read("local-min-balances", descriptor.pool,
      LOCAL_POOL_ABI.encodeFunctionData("getMinTokenBalances"))] : []),
  ];
}

export function decodeLocalState(descriptor: BalancerV3Descriptor, results: readonly AdapterRequestResult[]): BalancerLocalState {
  const ids = localStateRequests(descriptor).map(request => request.id);
  if (results.length !== ids.length || results.some(result => !ids.includes(result.id))) {
    throw new Error("balancer-v3 invalid local state result set");
  }
  const source = resultSource(results);
  const data = (id: string) => returned(results, id).data;
  if (bool(data("local-paused")) || bool(data("local-vault-paused")) || bool(data("local-query-disabled"))) {
    throw new Error("balancer-v3 pool/vault paused or query disabled");
  }
  const decoded = decodeReturn(LOCAL_VAULT_ABI, "getPoolData", data("local-data"))[0] as ethers.Result;
  const bits = BigInt(decoded[0]);
  // PoolConfigConst: registered/initialized bits 0/1; static swap fee starts
  // at bit 18, 24-bit encoded fee * 1e11. Recovery mode does not forbid swaps.
  const swapFee = ((bits >> 18n) & ((1n << 24n) - 1n)) * 100_000_000_000n;
  const aggregateSwapFee = (bits & 8n) !== 0n ? 0n : ((bits >> 42n) & ((1n << 24n) - 1n)) * 100_000_000_000n;
  if ((bits & 3n) !== 3n || swapFee >= WAD || aggregateSwapFee > WAD) throw new Error("balancer-v3 invalid local pool config");
  const tokens = Array.from(decoded[1] as readonly string[]);
  const tokenInfo = Array.from(decoded[2] as readonly ethers.Result[]);
  const arrays = [3, 4, 5, 6].map(index => Object.freeze(Array.from(decoded[index] as readonly bigint[], BigInt)));
  const [balancesRaw, balances, rates, scalingFactors] = arrays;
  const binding = descriptor.binding;
  if (tokens.length !== binding.tokens.length || tokenInfo.length !== tokens.length ||
      arrays.some(values => values.length !== tokens.length) ||
      tokens.some((token, i) => !same(token, binding.tokens[i]) ||
        Number(tokenInfo[i][0]) !== binding.tokenInfo[i].tokenType ||
        !same(String(tokenInfo[i][1]), binding.tokenInfo[i].rateProvider) ||
        Boolean(tokenInfo[i][2]) !== binding.tokenInfo[i].paysYieldFees)) {
    throw new Error("balancer-v3 local token binding changed");
  }
  const hooks = hooksConfig(data("local-hooks"));
  if (!same(hooks.address, binding.hooks.address) || hooks.flags.some((flag, i) => flag !== binding.hooks.flags[i])) {
    throw new Error("balancer-v3 local hook binding changed");
  }
  for (let i = 0; i < tokens.length; i++) {
    const decimals = binding.decimals[i];
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18 || rates[i] <= 0n ||
        scalingFactors[i] !== 10n ** BigInt(18 - decimals) ||
        (binding.tokenInfo[i].tokenType === 0 && rates[i] !== WAD) ||
        balancesRaw[i] > MAX_BALANCE || balances[i] > MAX_BALANCE ||
        checkedMul(checkedMul(balancesRaw[i], scalingFactors[i]), rates[i]) / WAD !== balances[i]) {
      throw new Error("balancer-v3 invalid local scaling/rate/balance");
    }
  }
  const model = binding.localModel!;
  const state = { source, model, balancesRaw, balances, rates, scalingFactors, swapFee, aggregateSwapFee,
    minimumTradeAmount: uint(data("local-minimum-trade")) };
  if (state.minimumTradeAmount === 0n) throw new Error("balancer-v3 invalid minimum trade");
  if (model.startsWith("weighted-")) {
    const weights = Object.freeze(Array.from(decodeReturn(LOCAL_POOL_ABI, "getNormalizedWeights", data("local-weights"))[0] as readonly bigint[], BigInt));
    const minTokenBalances = model === "weighted-v2" ? Object.freeze(Array.from(
      decodeReturn(LOCAL_POOL_ABI, "getMinTokenBalances", data("local-min-balances"))[0] as readonly bigint[], BigInt)) : undefined;
    if (weights.length !== tokens.length || weights.some(weight => weight < WAD / 100n) ||
        weights.reduce((sum, weight) => sum + weight, 0n) !== WAD ||
        (minTokenBalances && minTokenBalances.length !== tokens.length)) throw new Error("balancer-v3 invalid local weights");
    return Object.freeze({ ...state, weights, ...(minTokenBalances ? { minTokenBalances } : {}) });
  }
  const amplification = decodeReturn(LOCAL_POOL_ABI, "getAmplificationParameter", data("local-amp"));
  if (BigInt(amplification[2]) !== 1000n || BigInt(amplification[0]) < 1000n || BigInt(amplification[0]) > 50_000_000n) {
    throw new Error("balancer-v3 invalid local amplification");
  }
  return Object.freeze({ ...state, amp: BigInt(amplification[0]) });
}

function checkedMul(a: bigint, b: bigint): bigint {
  const product = a * b;
  if (a < 0n || b < 0n || product > MAX_UINT) throw new Error("balancer-v3 uint256 overflow");
  return product;
}

/** Exact-in Vault scaling and fees, then model math; never a linear mid multiple. */
export function quoteLocal(descriptor: BalancerV3Descriptor, route: BalancerV3Route,
  state: BalancerLocalState, amountIn: bigint, source: CanonicalSource): bigint {
  assertRoute(descriptor, route);
  assertSource(state.source, source);
  if (state.model !== descriptor.binding.localModel || amountIn < 0n || amountIn > MAX_INPUT) {
    throw new Error("balancer-v3 invalid local quote binding/amount");
  }
  if (amountIn === 0n) return 0n;
  const scaled = checkedMul(checkedMul(amountIn, state.scalingFactors[route.i]), state.rates[route.i]) / WAD;
  const feeProduct = checkedMul(scaled, state.swapFee);
  const feeScaled = feeProduct === 0n ? 0n : (feeProduct - 1n) / WAD + 1n;
  const afterFee = scaled - feeScaled;
  if (afterFee < state.minimumTradeAmount) throw new Error("balancer-v3 trade amount too small");
  const out = quoteBalancerExactInScaled18({ model: state.model, balances: state.balances,
    indexIn: route.i, indexOut: route.j, amountIn: afterFee, weights: state.weights,
    amp: state.amp, minTokenBalances: state.minTokenBalances });
  if (out < state.minimumTradeAmount) throw new Error("balancer-v3 trade amount too small");
  const rate = state.rates[route.j];
  // ScalingHelpers.computeRateRoundUp: integral rates stay unchanged.
  const rateUp = rate % WAD === 0n ? rate : rate + 1n;
  const raw = checkedMul(out, WAD) / checkedMul(state.scalingFactors[route.j], rateUp);
  if (raw <= 0n || raw > state.balancesRaw[route.j]) throw new Error("balancer-v3 local output outside balance");
  // The Vault credits input after deducting aggregate (not LP) swap fees,
  // then packs raw/live balances into uint128 fields. Pool math alone does
  // not enforce this storage-capacity boundary.
  const feeRaw = checkedMul(feeScaled, WAD) / checkedMul(state.scalingFactors[route.i], state.rates[route.i]);
  const aggregateFeeRaw = checkedMul(feeRaw, state.aggregateSwapFee) / WAD;
  const nextRaw = state.balancesRaw[route.i] + amountIn - aggregateFeeRaw;
  const nextLive = checkedMul(checkedMul(nextRaw, state.scalingFactors[route.i]), state.rates[route.i]) / WAD;
  if (nextRaw > MAX_BALANCE || nextLive > MAX_BALANCE) throw new Error("balancer-v3 local balance overflow");
  return raw;
}
