import assert from "node:assert/strict";
import { ethers } from "ethers";
import {
  declareRequestProgram,
  type AdapterRequest,
  type AdapterRequestResult,
  type CanonicalSource,
} from "../../../adapter-request-program.js";
import { plugin } from
  "../../../production-families/algebra-integral.production.js";
import {
  ALGEBRA_FACTORY_INTERFACE,
  ALGEBRA_POOL_INTERFACE,
  ALGEBRA_POOL_SURFACE_PATTERN_ID,
} from "../abi.js";
import type {
  AlgebraIntegralCandidate,
  AlgebraIntegralIdentity,
} from "../types.js";

/**
 * Measured chain evidence (archive RPC). Every value in this file was read from
 * mainnet, not invented; the family contract test re-derives the family's
 * conclusions from it offline.
 */
export const SOURCE: CanonicalSource = Object.freeze({
  number: 26018534,
  hash: "0xba26a0e4891db23e721b7d434b592622fb7842dc35b2dffc20bc1f7936a65a8a",
  generation: 1,
});

export const FACTORY = "0xfb8Ed3485EfA29a0e4bed93351dD51B59fC4b0f0";
export const REP_POOL = "0x76a278bd71f566ee6ba2fe438f6099c8d8f98f43";
export const WBTC = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599";
export const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
export const REP_PLUGIN = "0xe5e0235245E3C05f66447a513c4e4e673805964b";
export const EXECUTOR = "0x1000000000000000000000000000000000000005";
export const FOREIGN_POOL = "0x1000000000000000000000000000000000000009";

/**
 * The six instances named for this family, all measured at block 26018534.
 * Every one sets DYNAMIC_FEE. Static-only evidence cannot admit them; the
 * code-bound Quoter branch has its own identity/amount tests.
 */
export interface MeasuredInstance {
  readonly pool: string;
  readonly token0: string;
  readonly token1: string;
  readonly tickSpacing: number;
  readonly plugin: string;
  readonly pluginConfig: number;
  readonly lastFee: bigint;
  readonly feeView: bigint;
  readonly sqrtPriceX96: bigint;
  readonly tick: number;
  readonly liquidity: bigint;
  readonly communityFee: number;
  readonly reversePool: string;
}

export const MEASURED_INSTANCES: readonly MeasuredInstance[] = Object.freeze([
  {
    pool: REP_POOL, token0: WBTC, token1: USDT, tickSpacing: 10,
    plugin: REP_PLUGIN, pluginConfig: 215, lastFee: 500n, feeView: 50n,
    sqrtPriceX96: 2247775880849969585675608322640n, tick: 66910,
    liquidity: 15375832266n, communityFee: 200, reversePool: REP_POOL,
  },
  {
    pool: "0x915fd34cadd63907b51eb64dddc2eadd114a0bed",
    token0: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", token1: USDT,
    tickSpacing: 10, plugin: "0xC9B5e4fDCEe51e2acAa54Dd2E147015aD7b9D428",
    pluginConfig: 215, lastFee: 500n, feeView: 148n,
    sqrtPriceX96: 4021897763278559036217398n, tick: -197777,
    liquidity: 7768591894454219n, communityFee: 200,
    reversePool: "0x915fD34CadD63907b51Eb64DDdC2eadd114A0bEd",
  },
  {
    pool: "0xc0cf00079741ab9db6aceb5f7fe2f69c243c1aae",
    token0: "0x514910771AF9Ca656af840dff83E8264EcF986CA",
    token1: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", tickSpacing: 10,
    plugin: "0x6850478aA438a25AadEe86d6d1df1FdC7bDec100", pluginConfig: 215,
    lastFee: 500n, feeView: 1133n, sqrtPriceX96: 5410764031934076848893806367n,
    tick: -53682, liquidity: 513948125238843713932n, communityFee: 200,
    reversePool: "0xC0cF00079741AB9Db6aCEB5F7Fe2F69C243C1AaE",
  },
  {
    pool: "0x65937a5421603612c243300b250f64e58afcdbc4",
    token0: "0x4d224452801ACEd8B2F0aebE155379bb5D594381",
    token1: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", tickSpacing: 60,
    plugin: "0x30004B64337B633CABd90F1de4F79920BCa6BB93", pluginConfig: 215,
    lastFee: 500n, feeView: 3000n, sqrtPriceX96: 573389876530633736608416247n,
    tick: -98576, liquidity: 434599818385017086568n, communityFee: 200,
    reversePool: "0x65937A5421603612c243300b250f64E58AfcDbC4",
  },
  {
    pool: "0x177f07c0843776b2a6342ed6c488af64e6f2fd65",
    token0: "0x808507121B80c02388fAd14726482e061B8da827",
    token1: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", tickSpacing: 60,
    plugin: "0x580E4Fe61c6551B3794C5d0DE94FBc0c699a6E6a", pluginConfig: 215,
    lastFee: 500n, feeView: 3000n, sqrtPriceX96: 2517067293498358935408277692n,
    tick: -68989, liquidity: 1514464039400306043902n, communityFee: 200,
    reversePool: "0x177F07C0843776b2A6342ed6C488af64e6F2fD65",
  },
  {
    pool: "0xf53dcd757f208fb4f3631d16d8c17ddb21a9d98d",
    token0: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    token1: "0xE0f63A424a4439cBE457D80E4f4b51aD25b2c56C", tickSpacing: 60,
    plugin: "0x4c643647AfbE131C1A2231A6d973257d1e4769c5", pluginConfig: 215,
    lastFee: 500n, feeView: 6000n, sqrtPriceX96: 60070157697945880188105943n,
    tick: -143699, liquidity: 1850990856900898n, communityFee: 200,
    reversePool: "0xF53dcD757f208fB4f3631d16D8c17Ddb21A9D98D",
  },
] as const satisfies readonly MeasuredInstance[]);

/**
 * Four real `AlgebraPool.Swap` events of REP_POOL with the pool state read at
 * the immediately preceding block. `feeView` is what `fee()` returned at that
 * same block; `overrideFee` is what the pool actually charged. They disagree on
 * every sample, which is why the plugin-dynamic-fee variant is refused.
 */
export interface MeasuredSwap {
  readonly swapBlock: number;
  readonly preBlockNumber: number;
  readonly preBlockHash: string;
  readonly direction: "zero-for-one" | "one-for-zero";
  readonly sqrtPriceX96: bigint;
  readonly tick: number;
  readonly liquidity: bigint;
  readonly nextTickGlobal: number;
  readonly prevTickGlobal: number;
  readonly tickSpacing: number;
  readonly lastFee: bigint;
  readonly feeView: bigint;
  readonly overrideFee: bigint;
  readonly pluginFee: bigint;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly postSqrtPriceX96: bigint;
  readonly postTick: number;
}

export const MEASURED_SWAPS: readonly MeasuredSwap[] = Object.freeze([
  {
    swapBlock: 26143604, preBlockNumber: 26143603,
    preBlockHash: "0xca6f4a214ed1f1b9b838bcd94be3ee85243876799ed8baeab494a232d1acc1e5",
    direction: "zero-for-one", sqrtPriceX96: 2289849045464851449554243125694n,
    tick: 67281, liquidity: 27179990n, nextTickGlobal: 67650,
    prevTickGlobal: 63790, tickSpacing: 10, lastFee: 500n, feeView: 200n,
    overrideFee: 345n, pluginFee: 0n, amountIn: 1202n, amountOut: 1001943n,
    postSqrtPriceX96: 2286928435526579203707256276449n, postTick: 67256,
  },
  {
    swapBlock: 26144904, preBlockNumber: 26144903,
    preBlockHash: "0x7db9684eec334975f6fda5a507151a3afb5719a60fc718b8fb345929aecb9799",
    direction: "zero-for-one", sqrtPriceX96: 2286928435526579203707256276449n,
    tick: 67256, liquidity: 27179990n, nextTickGlobal: 67650,
    prevTickGlobal: 63790, tickSpacing: 10, lastFee: 500n, feeView: 200n,
    overrideFee: 346n, pluginFee: 0n, amountIn: 1379n, amountOut: 1146463n,
    postSqrtPriceX96: 2283586559045940109968869161008n, postTick: 67226,
  },
  {
    swapBlock: 26145474, preBlockNumber: 26145473,
    preBlockHash: "0xc95705a935287e701a1c66129fc9d8d9dbe264b6220377f8b78492a1afe6ef02",
    direction: "zero-for-one", sqrtPriceX96: 2283586559045940109968869161008n,
    tick: 67226, liquidity: 27179990n, nextTickGlobal: 67650,
    prevTickGlobal: 63790, tickSpacing: 10, lastFee: 500n, feeView: 199n,
    overrideFee: 345n, pluginFee: 0n, amountIn: 1204n, amountOut: 998131n,
    postSqrtPriceX96: 2280677061309628471721494590394n, postTick: 67201,
  },
  {
    swapBlock: 26146165, preBlockNumber: 26146164,
    preBlockHash: "0x2fa78707d527ffbcdd97ee75901f2e70b0f9faf6ddb33bc87939d50d2b6d8cf4",
    direction: "one-for-zero", sqrtPriceX96: 2280677061309628471721494590394n,
    tick: 67201, liquidity: 27179990n, nextTickGlobal: 67650,
    prevTickGlobal: 63790, tickSpacing: 10, lastFee: 500n, feeView: 197n,
    overrideFee: 51n, pluginFee: 0n, amountIn: 521284n, amountOut: 628n,
    postSqrtPriceX96: 2282196496537812804600976810178n, postTick: 67214,
  },
] as const satisfies readonly MeasuredSwap[]);

export function sourceAt(number: number, hash: string): CanonicalSource {
  return Object.freeze({ number, hash, generation: 1 });
}

/**
 * SYNTHETIC pool of the SUPPORTED variant: same 40-function surface, but its
 * plugin config clears the dynamic-fee bit, so `fee()` returns
 * `globalState.lastFee` verbatim and `_beforeSwap` can only return (0, 0).
 * No measured instance of this variant exists among the six named instances.
 */
export const STATIC_FEE_POOL = "0x9111111111111111111111111111111111111111";
export const STATIC_FEE_PLUGIN = "0x9222222222222222222222222222222222222222";
export const STATIC_FEE_CONFIG = 0b0101_0111; // 87: no DYNAMIC_FEE bit

export interface PoolFixture {
  readonly pool: string;
  readonly factory: string;
  readonly token0: string;
  readonly token1: string;
  readonly tickSpacing: number;
  readonly plugin: string;
  readonly pluginConfig: number;
  readonly lastFee: bigint;
  readonly feeView: bigint;
  readonly sqrtPriceX96: bigint;
  readonly tick: number;
  readonly liquidity: bigint;
  readonly communityFee: number;
  readonly unlocked: boolean;
  readonly nextTickGlobal: number;
  readonly prevTickGlobal: number;
  readonly reversePool: string;
}

export const STATIC_FEE_FACTS: PoolFixture = Object.freeze({
  pool: STATIC_FEE_POOL,
  factory: FACTORY,
  token0: WBTC,
  token1: USDT,
  tickSpacing: 10,
  plugin: STATIC_FEE_PLUGIN,
  pluginConfig: STATIC_FEE_CONFIG,
  lastFee: 500n,
  feeView: 500n,
  // Real price/liquidity/initialized-tick bounds measured on REP_POOL at block
  // 26143603, reused so the supported variant is quoted against real geometry.
  sqrtPriceX96: 2289849045464851449554243125694n,
  tick: 67281,
  liquidity: 27179990n,
  communityFee: 200,
  unlocked: true,
  nextTickGlobal: 67650,
  prevTickGlobal: 63790,
  reversePool: STATIC_FEE_POOL,
});

export const CANDIDATE: AlgebraIntegralCandidate = Object.freeze({
  candidateKind: "algebra-integral-pool",
  pool: STATIC_FEE_POOL,
  sourceKind: "factory-pool-log",
  hintedFactory: null,
  hintedToken0: null,
  hintedToken1: null,
});

export function result(
  id: string,
  data: string,
  source: CanonicalSource = SOURCE,
): AdapterRequestResult {
  return {
    id,
    data,
    source,
    ok: true,
    completion: "returned",
    provenance: { kind: "synthetic-algebra-contract", fingerprint: "fixture" },
  };
}

export interface AnswerOptions {
  readonly facts?: PoolFixture;
  readonly source?: CanonicalSource;
  readonly reverseReverts?: boolean;
  readonly foreignReverse?: string;
  readonly unresolvedId?: string;
}

/** Encodes a pool's declared read surface as if the node answered it. */
export function answerFor(
  options: AnswerOptions = {},
): (request: AdapterRequest) => AdapterRequestResult {
  const facts = options.facts ?? STATIC_FEE_FACTS;
  const source = options.source ?? SOURCE;
  const zero = ethers.zeroPadValue("0x", 32);
  const values: Record<string, string> = {
    // Old fixtures have NO Quoter/code proof. Missing support is retryable,
    // never manufactured admission of the historical dynamic instances.
    "quoter-code": "0x", "plugin-code": "0x",
    "quoter-factory": zero, "quoter-pool-deployer": zero,
    "factory-pool-deployer": zero,
    "pool-factory": ALGEBRA_POOL_INTERFACE.encodeFunctionResult("factory", [facts.factory]),
    "pool-token0": ALGEBRA_POOL_INTERFACE.encodeFunctionResult("token0", [facts.token0]),
    "pool-token1": ALGEBRA_POOL_INTERFACE.encodeFunctionResult("token1", [facts.token1]),
    "pool-tick-spacing": ALGEBRA_POOL_INTERFACE.encodeFunctionResult("tickSpacing", [facts.tickSpacing]),
    "pool-plugin": ALGEBRA_POOL_INTERFACE.encodeFunctionResult("plugin", [facts.plugin]),
    "pool-global-state": ALGEBRA_POOL_INTERFACE.encodeFunctionResult("globalState", [
      facts.sqrtPriceX96,
      facts.tick,
      facts.lastFee,
      facts.pluginConfig,
      facts.communityFee,
      facts.unlocked,
    ]),
    "pool-fee": ALGEBRA_POOL_INTERFACE.encodeFunctionResult("fee", [facts.feeView]),
    "pool-liquidity": ALGEBRA_POOL_INTERFACE.encodeFunctionResult("liquidity", [facts.liquidity]),
    "pool-next-tick-global": ALGEBRA_POOL_INTERFACE.encodeFunctionResult(
      "nextTickGlobal",
      [facts.nextTickGlobal],
    ),
    "pool-prev-tick-global": ALGEBRA_POOL_INTERFACE.encodeFunctionResult(
      "prevTickGlobal",
      [facts.prevTickGlobal],
    ),
    "factory-pool-by-pair": options.reverseReverts === true
      ? zero
      : ALGEBRA_FACTORY_INTERFACE.encodeFunctionResult("poolByPair", [
        options.foreignReverse ?? facts.reversePool,
      ]),
  };
  return (request: AdapterRequest): AdapterRequestResult => {
    if (request.id === options.unresolvedId) {
      return {
        id: request.id,
        ok: false,
        failure: "rpc",
        source,
      } as unknown as AdapterRequestResult;
    }
    assert(request.id in values, `unexpected algebra fixture request ${request.id}`);
    if (request.id === "factory-pool-by-pair" && options.reverseReverts === true) {
      return {
        id: request.id,
        data: "0x",
        source,
        ok: true,
        completion: "reverted-as-declared",
        provenance: { kind: "synthetic-algebra-contract", fingerprint: "fixture" },
      };
    }
    return result(request.id, values[request.id]!, source);
  };
}

/** Walks the identity variant to a verified identity using fixture answers. */
export function identityWith(
  reply: (request: AdapterRequest) => AdapterRequestResult = answerFor(),
  candidate: AlgebraIntegralCandidate = CANDIDATE,
): AlgebraIntegralIdentity {
  const variant = plugin.identity.variants[0]!;
  let evidence: unknown;
  for (let step = 0; step < 6; step++) {
    const input = { candidate, evidence, step };
    const decision = variant.decide(input as never);
    if (decision.status === "verified") {
      return decision.identity as AlgebraIntegralIdentity;
    }
    assert.equal(
      decision.status,
      "continue",
      `algebra-integral identity stopped early: ${JSON.stringify(decision)}`,
    );
    const declared = declareRequestProgram({
      requirements: variant.requirements,
      buildRequests: variant.buildRequests,
      decode: () => undefined,
    }, input as never);
    evidence = variant.decode({
      step: input as never,
      results: declared.requests.map(reply),
    } as never);
  }
  throw new Error("algebra-integral identity did not converge");
}

export function decisionWith(
  reply: (request: AdapterRequest) => AdapterRequestResult,
  candidate: AlgebraIntegralCandidate = CANDIDATE,
) {
  const variant = plugin.identity.variants[0]!;
  let evidence: unknown;
  for (let step = 0; step < 6; step++) {
    const input = { candidate, evidence, step };
    const decision = variant.decide(input as never);
    if (decision.status !== "continue") return decision;
    const declared = declareRequestProgram({
      requirements: variant.requirements,
      buildRequests: variant.buildRequests,
      decode: () => undefined,
    }, input as never);
    evidence = variant.decode({
      step: input as never,
      results: declared.requests.map(reply),
    } as never);
  }
  throw new Error("algebra-integral identity did not converge");
}

export function descriptor(
  reply: (request: AdapterRequest) => AdapterRequestResult = answerFor(),
) {
  const identity = identityWith(reply);
  return plugin.instance.finalizeDescriptor({
    identity,
    draft: plugin.instance.compileDraft(identity),
    sharedBindings: [],
  });
}

export function candidateFor(facts: PoolFixture): AlgebraIntegralCandidate {
  return Object.freeze({
    candidateKind: "algebra-integral-pool" as const,
    pool: facts.pool,
    sourceKind: "pool-surface" as const,
    hintedFactory: facts.factory,
    hintedToken0: facts.token0,
    hintedToken1: facts.token1,
  });
}

export { ALGEBRA_POOL_SURFACE_PATTERN_ID };
