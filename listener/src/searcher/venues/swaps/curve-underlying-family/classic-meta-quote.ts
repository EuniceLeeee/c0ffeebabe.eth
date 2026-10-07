import { ethers } from "ethers";
import { bindRequestResultRound, collectRequestProgramResults } from "../../adapter-family-plugin.js";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import { classicBaseExchangeAmount, classicBaseMintAmount, type ClassicBasePoolState } from "./base-pool-math.js";
import { CURVE_UNDERLYING_POOL_INTERFACE, requireSuccessfulResult } from "./codec.js";
import type { CurveUnderlyingClassicMetaBinding, CurveUnderlyingDescriptor, CurveUnderlyingRoute } from "./types.js";

const STATE = new ethers.Interface([
  "function A() view returns (uint256)",
  "function A_precise() view returns (uint256)",
  "function future_A() view returns (uint256)",
  "function fee() view returns (uint256)",
  "function balances(uint256) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function get_dy(int128,int128,uint256) view returns (uint256)",
  "function calc_withdraw_one_coin(uint256,int128) view returns (uint256)",
  "function coins(uint256) view returns (address)",
  "function basisPointsRate() view returns (uint256)",
  "function maximumFee() view returns (uint256)",
  "function paused() view returns (bool)",
  "function deprecated() view returns (bool)",
]);
const QUOTE = "classic-meta-quote";
const WITHDRAWAL = "classic-base-withdrawal";
const UINT_MAX = (1n << 256n) - 1n;
type Input = {
  readonly descriptor: CurveUnderlyingDescriptor;
  readonly route: CurveUnderlyingRoute;
  readonly source: CanonicalSource;
  readonly amountIn: bigint;
};

function binding(input: Input): CurveUnderlyingClassicMetaBinding {
  const value = input.descriptor.quoteModel;
  if (!value || value.kind !== "classic-meta-base-3pool-v1") throw new Error("curve-underlying missing execution quote binding");
  if (value.baseCoins.length !== 3 || value.basePrecisions.length !== 3 ||
      input.descriptor.coins.length !== 4 || input.route.i < 0 || input.route.i > 3 ||
      input.route.j < 0 || input.route.j > 3 || input.route.i === input.route.j ||
      !Number.isInteger(input.route.i) || !Number.isInteger(input.route.j)) {
    throw new Error("curve-underlying invalid classic metapool direction/domain");
  }
  if (input.amountIn <= 0n || input.amountIn > UINT_MAX) throw new Error("curve-underlying invalid positive uint256 amount");
  return value;
}

function call(id: string, to: string, name: string, args: readonly unknown[] = []): AdapterRequest {
  return { id, kind: "eth-call", to, data: STATE.encodeFunctionData(name, args), completion: "return-data" };
}

/** All independent reads start in the same central request round. No private RPC/cache. */
export function classicUnderlyingQuoteRequests(input: Input): readonly AdapterRequest[] {
  const model = binding(input);
  const guards: AdapterRequest[] = [
    { id: "classic-pool-code", kind: "get-code", address: input.descriptor.pool },
    { id: "classic-implementation-code", kind: "get-code", address: model.implementation },
    { id: "classic-base-code", kind: "get-code", address: model.basePool },
    { id: "classic-meta-rate", kind: "get-storage", address: input.descriptor.pool, slot: ethers.toBeHex(16, 32) },
    call("classic-meta-coin", input.descriptor.pool, "coins", [0]),
    call("classic-meta-lp", input.descriptor.pool, "coins", [1]),
    call("classic-base-A", model.basePool, "A"),
    call("classic-base-future-A", model.basePool, "future_A"),
    call("classic-meta-A", input.descriptor.pool, "A_precise"),
    call("classic-meta-future-A", input.descriptor.pool, "future_A"),
    ...(input.route.i === 3 || input.route.j === 3
      ? ["basisPointsRate", "maximumFee", "paused", "deprecated"].map(name =>
        call("classic-usdt-" + name, model.baseCoins[2], name)) : []),
  ];
  if (needsComposedWithdrawal(input)) return [...guards,
    call(QUOTE, input.descriptor.pool, "get_dy", [0, 1, input.amountIn])];
  if (input.route.i === 0) return [...guards, {
    id: QUOTE, kind: "eth-call", to: input.descriptor.pool,
    data: CURVE_UNDERLYING_POOL_INTERFACE.encodeFunctionData("get_dy_underlying",
      [input.route.i, input.route.j, input.amountIn]), completion: "return-data",
  }];
  return [...guards,
    call("classic-base-fee", model.basePool, "fee"),
    call("classic-base-supply", model.baseLPToken, "totalSupply"),
    ...model.baseCoins.map((_coin, index) => call("classic-base-balance:" + index, model.basePool, "balances", [index])),
  ];
}

function read(input: Input, results: readonly AdapterRequestResult[], id: string): string {
  const result = requireSuccessfulResult(results, id);
  if (result.source.number !== input.source.number || result.source.generation !== input.source.generation ||
      result.source.hash.toLowerCase() !== input.source.hash.toLowerCase()) {
    throw new Error("curve-underlying execution quote source mismatch");
  }
  return result.data;
}
function uint(data: string): bigint {
  if (!/^0x[0-9a-fA-F]{64}$/.test(data)) throw new Error("curve-underlying malformed uint256 return");
  return BigInt(data);
}
function guards(input: Input, results: readonly AdapterRequestResult[]): CurveUnderlyingClassicMetaBinding {
  const model = binding(input);
  for (const [id, expected] of [
    ["classic-pool-code", model.poolCodeHash],
    ["classic-implementation-code", model.implementationCodeHash],
    ["classic-base-code", model.baseCodeHash],
  ]) {
    if (ethers.keccak256(read(input, results, id)).toLowerCase() !== expected.toLowerCase()) {
      throw new Error("curve-underlying execution quote implementation changed: " + id);
    }
  }
  const boundAddress = (id: string, expected: string) => {
    const data = read(input, results, id);
    if (!/^0x0{24}[0-9a-fA-F]{40}$/.test(data) || "0x" + data.slice(-40).toLowerCase() !== expected.toLowerCase()) {
      throw new Error("curve-underlying current quote topology changed: " + id);
    }
  };
  boundAddress("classic-meta-coin", input.descriptor.coins[0]);
  boundAddress("classic-meta-lp", model.baseLPToken);
  if (uint(read(input, results, "classic-meta-rate")) !== model.metaRateMultiplier) {
    throw new Error("curve-underlying current meta rate binding changed");
  }
  // This model retains on-touch pricing. Current/final equality is exact for
  // the bound base A precision=1 and meta A_precise precision=100. A new ramp
  // emits a pool event and must fail closed, never silently retain stale quotes.
  if (uint(read(input, results, "classic-base-A")) !== uint(read(input, results, "classic-base-future-A")) ||
      uint(read(input, results, "classic-meta-A")) !== uint(read(input, results, "classic-meta-future-A"))) {
    throw new Error("curve-underlying active A ramp requires per-block pricing");
  }
  if (input.route.i === 3 || input.route.j === 3) {
    const fee = uint(read(input, results, "classic-usdt-basisPointsRate"));
    const cap = uint(read(input, results, "classic-usdt-maximumFee"));
    if ((fee !== 0n && cap !== 0n) || uint(read(input, results, "classic-usdt-paused")) !== 0n ||
        uint(read(input, results, "classic-usdt-deprecated")) !== 0n) {
      throw new Error("curve-underlying USDT transfer mode is outside the bound zero-fee execution model");
    }
  }
  return model;
}
function needsComposedWithdrawal(input: Input): boolean {
  return input.route.i === 0 && binding(input).metaRateMultiplier % (10n ** 18n) !== 0n;
}
function baseState(input: Input, results: readonly AdapterRequestResult[]): ClassicBasePoolState {
  const model = guards(input, results);
  return {
    balances: model.baseCoins.map((_coin, index) => uint(read(input, results, "classic-base-balance:" + index))),
    precisions: model.basePrecisions,
    amplification: uint(read(input, results, "classic-base-A")),
    fee: uint(read(input, results, "classic-base-fee")),
    lpTotalSupply: uint(read(input, results, "classic-base-supply")),
  };
}

/** Deposit amounts are execution-exact. Fractional meta scales use the same
 * direct LP quote + withdrawal order as exchange, not the rounded view helper. */
export function classicUnderlyingQuoteNextRound(input: Input, completedRound: number,
  initialResults: readonly AdapterRequestResult[]) {
  binding(input);
  if (completedRound !== 0) return null;
  if (needsComposedWithdrawal(input)) {
    const model = guards(input, initialResults);
    const lp = uint(read(input, initialResults, QUOTE));
    if (lp <= 0n) throw new Error("curve-underlying meta swap produces no LP");
    return bindRequestResultRound({ transports: ["eth-call"] },
      [call(WITHDRAWAL, model.basePool, "calc_withdraw_one_coin", [lp, input.route.j - 1])]);
  }
  if (input.route.i === 0 || input.route.j !== 0) return null;
  const amountLP = classicBaseMintAmount(baseState(input, initialResults), input.route.i - 1, input.amountIn);
  if (amountLP <= 0n) throw new Error("curve-underlying base deposit produces no LP");
  return bindRequestResultRound({ transports: ["eth-call"] },
    [call(QUOTE, input.descriptor.pool, "get_dy", [1, 0, amountLP])]);
}

export function decodeClassicUnderlyingQuote(input: Input, initialResults: readonly AdapterRequestResult[],
  dependentEvidence: readonly unknown[]): bigint {
  guards(input, initialResults);
  const results = collectRequestProgramResults(initialResults, dependentEvidence);
  if (needsComposedWithdrawal(input)) {
    if (uint(read(input, initialResults, QUOTE)) <= 0n || dependentEvidence.length !== 1) {
      throw new Error("curve-underlying missing direct LP withdrawal round");
    }
    return uint(read(input, results, WITHDRAWAL));
  }
  if (input.route.i > 0 && input.route.j > 0) {
    if (dependentEvidence.length !== 0) throw new Error("curve-underlying unexpected base exchange round");
    return classicBaseExchangeAmount(baseState(input, initialResults), input.route.i - 1, input.route.j - 1, input.amountIn);
  }
  if (input.route.i > 0) {
    // Revalidate amount/state even when consuming already completed dependent evidence.
    const minted = classicBaseMintAmount(baseState(input, initialResults), input.route.i - 1, input.amountIn);
    if (minted <= 0n || dependentEvidence.length !== 1) throw new Error("curve-underlying missing actual-mint quote round");
  } else if (dependentEvidence.length !== 0) throw new Error("curve-underlying unexpected meta withdrawal round");
  return uint(read(input, results, QUOTE));
}
