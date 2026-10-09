import assert from "node:assert/strict";
import { ethers } from "ethers";
import {
  declareRequestProgram,
  type AdapterRequest,
  type AdapterRequestResult,
} from "../../../adapter-request-program.js";
import { plugin } from
  "../../../production-families/kyberswap-elastic.production.js";
import { KYSWAP_FACTORY_INTERFACE, KYSWAP_POOL_INTERFACE } from "../abi.js";
import type { KyberSwapCandidate, KyberSwapIdentity } from "../types.js";

/**
 * Pinned-block source used by every synthetic fixture answer. The block number
 * is the representative KyberSwap block; the hash is synthetic (`0x2b2b…`)
 * because only the block number was measured.
 */
export const SOURCE = {
  number: 25953136,
  hash: `0x${"2b".repeat(32)}`,
  generation: 1,
};

/** Measured anchors: representative pool, its declared factory, token pair. */
export const POOL = "0xf138462c76568cdfd77c6eb831e973d6963f2006";
export const FACTORY = "0xC7a590291e07B9fe9E64b86c58fD8fC764308C4A";
export const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
export const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
/** The measured KS-1 `swapCallback` target (the executor). */
export const EXECUTOR = "0xe08d97e151473a848c3d9ca3f323cb720472d015";
export const FOREIGN = "0x1000000000000000000000000000000000000009";

/**
 * `swapFeeUnits` is implied by the measured reverse binding
 * (`factory.getPool(WETH, USDT, 300)` returned exactly the representative pool).
 * The tick distance is synthetic: only the reverse-binding fee was measured.
 */
export const POOL_FEE_UNITS = 300n;
export const TICK_DISTANCE = 10;

/** Measured KS-1 `Swap` state: post-swap sqrt price, tick, base liquidity. */
export const SQRT_P = 3940346460226021811448424n;
export const CURRENT_TICK = -198187;
/** Measured pre-swap tick (the pool oracle write payload). */
export const NEAREST_CURRENT_TICK = -198261;
export const BASE_L = 9311516941196n;
/** Synthetic lower bound; only the pool's `baseL` was measured. */
export const REINVEST_L = 0n;
/** Synthetic initialized-tick neighbours (the boundary positions are state). */
export const PREVIOUS_TICK = -198261;
export const NEXT_TICK = -190000;

export const CANDIDATE: KyberSwapCandidate = {
  candidateKind: "kyberswap-elastic-pool",
  pool: POOL,
  sourceKind: "pool-swap-log",
  hintedFactory: null,
};

export function result(
  id: string,
  data: string,
  completion: "returned" | "reverted-as-declared" = "returned",
): AdapterRequestResult {
  return {
    id,
    data,
    source: SOURCE,
    ok: true,
    completion,
    provenance: {
      kind: "synthetic-kyberswap-elastic-pool",
      fingerprint: "fixture",
    },
  } as unknown as AdapterRequestResult;
}

export interface AnswerOptions {
  readonly factory?: string;
  readonly reversePool?: string;
  readonly reverseReverts?: boolean;
  readonly feeUnits?: bigint;
  readonly tickDistance?: number;
  readonly sqrtP?: bigint;
  readonly currentTick?: number;
  readonly nearestCurrentTick?: number;
  readonly baseL?: bigint;
  readonly reinvestL?: bigint;
  readonly locked?: boolean;
  readonly previousTick?: number;
  readonly nextTick?: number;
}

export function answerFor(
  options: AnswerOptions = {},
): (request: AdapterRequest) => AdapterRequestResult {
  const answered = {
    factory: FACTORY,
    reversePool: POOL,
    reverseReverts: false,
    feeUnits: POOL_FEE_UNITS,
    tickDistance: TICK_DISTANCE,
    sqrtP: SQRT_P,
    currentTick: CURRENT_TICK,
    nearestCurrentTick: NEAREST_CURRENT_TICK,
    baseL: BASE_L,
    reinvestL: REINVEST_L,
    locked: false,
    previousTick: PREVIOUS_TICK,
    nextTick: NEXT_TICK,
    ...options,
  };
  const poolState = KYSWAP_POOL_INTERFACE.encodeFunctionResult("getPoolState", [
    answered.sqrtP,
    answered.currentTick,
    answered.nearestCurrentTick,
    answered.locked,
  ]);
  const liquidityState = KYSWAP_POOL_INTERFACE.encodeFunctionResult(
    "getLiquidityState",
    [answered.baseL, answered.reinvestL, answered.reinvestL],
  );
  const feeUnits = KYSWAP_POOL_INTERFACE.encodeFunctionResult(
    "swapFeeUnits",
    [answered.feeUnits],
  );
  const values: Record<string, string> = {
    "pool-code": "0x60016000f3",
    "pool-factory": KYSWAP_POOL_INTERFACE.encodeFunctionResult("factory", [
      answered.factory,
    ]),
    "pool-token0": KYSWAP_POOL_INTERFACE.encodeFunctionResult("token0", [WETH]),
    "pool-token1": KYSWAP_POOL_INTERFACE.encodeFunctionResult("token1", [USDT]),
    "pool-fee-units": feeUnits,
    "pool-tick-distance": KYSWAP_POOL_INTERFACE.encodeFunctionResult(
      "tickDistance",
      [answered.tickDistance],
    ),
    "pool-state": poolState,
    "pool-liquidity-state": liquidityState,
    "kyswap-pool-state": poolState,
    "kyswap-liquidity-state": liquidityState,
    "kyswap-swap-fee-units": feeUnits,
    "kyswap-initialized-ticks": KYSWAP_POOL_INTERFACE.encodeFunctionResult(
      "initializedTicks",
      [answered.previousTick, answered.nextTick],
    ),
  };
  return (request: AdapterRequest): AdapterRequestResult => {
    if (request.id === "factory-get-pool") {
      return answered.reverseReverts
        ? result("factory-get-pool", "0x", "reverted-as-declared")
        : result(
          "factory-get-pool",
          KYSWAP_FACTORY_INTERFACE.encodeFunctionResult("getPool", [
            answered.reversePool,
          ]),
        );
    }
    assert(
      request.id in values,
      `unexpected fixture request ${request.id}`,
    );
    return result(request.id, values[request.id]!);
  };
}

/** Walks the identity variant to a verified identity using fixture answers. */
export function identityWith(
  reply: (request: AdapterRequest) => AdapterRequestResult = answerFor(),
  candidate: KyberSwapCandidate = CANDIDATE,
): KyberSwapIdentity {
  const variant = plugin.identity.variants[0]!;
  let evidence: unknown;
  for (let step = 0; step < 6; step++) {
    const input = { candidate, evidence, step };
    const decision = variant.decide(input as never);
    if (decision.status === "verified") {
      return decision.identity as KyberSwapIdentity;
    }
    assert.equal(
      decision.status,
      "continue",
      `identity stopped early: ${JSON.stringify(decision)}`,
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
  throw new Error("KyberSwap Elastic identity did not converge");
}

export function decisionWith(
  reply: (request: AdapterRequest) => AdapterRequestResult,
) {
  const variant = plugin.identity.variants[0]!;
  let evidence: unknown;
  for (let step = 0; step < 6; step++) {
    const input = { candidate: CANDIDATE, evidence, step };
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
  throw new Error("KyberSwap Elastic identity did not converge");
}

export function descriptor(
  reply: (request: AdapterRequest) => AdapterRequestResult = answerFor(),
) {
  const identity = identityWith(reply);
  return plugin.instance.finalizeDescriptor({
    identity,
    draft: plugin.instance.compileDraft(identity),
    sharedBindings: [],
  } as never);
}

/**
 * The measured KS-1 `Swap` log, re-encoded from its decoded values: the
 * decoder test therefore asserts the same numbers that were read off chain.
 */
export function swapLogEvent(overrides: {
  readonly amount0?: bigint;
  readonly amount1?: bigint;
  readonly sqrtP?: bigint;
  readonly liquidity?: bigint;
  readonly tick?: number;
  readonly sender?: string;
  readonly recipient?: string;
} = {}) {
  const encoded = KYSWAP_POOL_INTERFACE.encodeEventLog("Swap", [
    overrides.sender ?? EXECUTOR,
    overrides.recipient ?? EXECUTOR,
    overrides.amount0 ?? -743921665931488n,
    overrides.amount1 ?? 1838763n,
    overrides.sqrtP ?? SQRT_P,
    overrides.liquidity ?? BASE_L,
    overrides.tick ?? CURRENT_TICK,
  ]);
  return {
    address: ethers.getAddress(POOL),
    topics: encoded.topics,
    data: encoded.data,
  };
}
