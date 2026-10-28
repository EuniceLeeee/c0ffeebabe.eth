import { ethers } from "ethers";
import type { IdentitySemantics } from "../../adapter-family-plugin.js";
import { RequiredAdapterRequestError } from "../../adapter-request-failure.js";
import type {
  AdapterRequest,
  AdapterRequestResult,
} from "../../adapter-request-program.js";
import { hashCanonical } from "../../canonical-value.js";
import {
  assertSameSource,
  callRequest,
  canonicalAddress,
  codeRequest,
  decodeAddress,
  decodeUint,
  lowerAddress,
  returnedResult,
  sameAddress,
} from "../../protocols/standard-family/common.js";
import {
  KYSWAP_FACTORY_INTERFACE,
  KYSWAP_FEE_UNITS,
  KYSWAP_POOL_INTERFACE,
} from "./abi.js";
import { isZeroAddress, lower } from "./codec.js";
import { KYSWAP_FAMILY_ID, KYSWAP_LINEAGE_ID } from "./manifest.js";
import {
  MAX_SQRT_RATIO,
  MAX_TICK,
  MIN_SQRT_RATIO,
  MIN_TICK,
} from "../../../solver/v3-math.js";
import type {
  KyberSwapCandidate,
  KyberSwapIdentity,
  KyberSwapIdentityEvidence,
  KyberSwapPoolStaticEvidence,
  KyberSwapReverseBindingEvidence,
} from "./types.js";

const STATIC_IDS = [
  "pool-code",
  "pool-factory",
  "pool-token0",
  "pool-token1",
  "pool-fee-units",
  "pool-tick-distance",
  "pool-state",
  "pool-liquidity-state",
] as const;
const REVERSE_IDS = ["factory-get-pool"] as const;

/**
 * KyberSwap Elastic identity — factory reverse binding, never an address
 * allowlist. The nine observed pools are EIP-1167 clones with no constructor
 * arguments in any verified metadata snapshot, so `factory()` is the only
 * anchor a clone offers:
 *
 *   1. `factory()` / `token0()` / `token1()` / `swapFeeUnits()` /
 *      `tickDistance()` / `getPoolState()` / `getLiquidityState()` are read at
 *      the pinned block;
 *   2. `factory.getPool(token0, token1, swapFeeUnits)` must return exactly this
 *      pool — the same reverse relation the pool's own factory maintains;
 *   3. pools whose fee/state surfaces do not satisfy the swap semantics this
 *      family routes (zero or >= FEE_UNITS fee, non-positive tick distance,
 *      out-of-range sqrt price, `nearestCurrentTick > currentTick`, a locked
 *      pool) are chain-proven rejected instead of admitted.
 *
 * The pinned-block reads prove registration existence at that block. They do
 * not claim creation lineage, and public metadata snapshots are never used as
 * identity evidence.
 */
export const kyberswapElasticIdentity: IdentitySemantics<
  KyberSwapCandidate,
  KyberSwapIdentity
> = {
  identityKey: (identity) => lower(identity.subject),
  variants: [{
    id: "factory-getpool-child",
    kind: "factory-child" as const,
    lineageId: KYSWAP_LINEAGE_ID,
    applies: (candidate) => candidate.candidateKind === "kyberswap-elastic-pool",
    requirements({ evidence }) {
      if (evidence === undefined) {
        return { transports: ["get-code" as const, "eth-call" as const] };
      }
      const proof = evidence as KyberSwapIdentityEvidence;
      if (proof.phase === "pool-static") {
        return proof.staticValid
          ? { transports: ["eth-call" as const] }
          : { transports: [] as const };
      }
      return { transports: [] as const };
    },
    buildRequests({ candidate, evidence }) {
      const pool = lower(candidate.pool);
      if (evidence === undefined) {
        return Object.freeze([
          codeRequest("pool-code", pool),
          ...staticRequests(pool),
        ]);
      }
      const proof = evidence as KyberSwapIdentityEvidence;
      if (proof.phase !== "pool-static" || !proof.staticValid) {
        return Object.freeze([]);
      }
      const [tokenA, tokenB] = sortTokenPair(proof.token0, proof.token1);
      return Object.freeze([{
        id: REVERSE_IDS[0],
        kind: "eth-call" as const,
        to: proof.factory,
        data: KYSWAP_FACTORY_INTERFACE.encodeFunctionData("getPool", [
          tokenA,
          tokenB,
          proof.feeUnits,
        ]),
        // A pinned getPool revert is a chain-proven failed reverse binding,
        // while a transport error stays an unresolved result.
        completion: "return-or-revert-data" as const,
      }]);
    },
    decode({ step, results }) {
      for (const result of results) {
        if (!result.ok && !(REVERSE_IDS as readonly string[]).includes(result.id)) {
          throw new RequiredAdapterRequestError(result);
        }
      }
      const successful = results.filter(
        (result): result is Extract<AdapterRequestResult, { readonly ok: true }> =>
          result.ok,
      );
      if (successful.length > 0) assertSameSource(successful);
      const pool = lower(step.candidate.pool);
      if (step.evidence === undefined) return decodeStatic(pool, results);
      const prior = step.evidence as KyberSwapPoolStaticEvidence;
      if (prior.phase !== "pool-static") {
        throw new Error("KyberSwap Elastic identity is already complete");
      }
      return decodeReverse(prior, results);
    },
    decide({ candidate, evidence }) {
      if (evidence === undefined) return { status: "continue" as const };
      const proof = evidence as KyberSwapIdentityEvidence;
      if (lower(proof.pool) !== lower(candidate.pool)) {
        return {
          status: "invalid-program" as const,
          reasonCode: "foreign-kyberswap-elastic-candidate",
        };
      }
      if (proof.phase === "pool-static") {
        return proof.staticValid
          ? { status: "continue" as const }
          : {
              status: "chain-proven-rejected" as const,
              reasonCode: "kyberswap_elastic_pool_surfaces_failed",
              evidenceRequestIds: [...proof.evidenceRequestIds],
            };
      }
      const reverse = proof as KyberSwapReverseBindingEvidence;
      if (
        candidate.hintedFactory !== null &&
        !sameAddress(candidate.hintedFactory, reverse.factory)
      ) {
        return {
          status: "chain-proven-rejected" as const,
          reasonCode: "kyberswap_elastic_factory_hint_mismatch",
          evidenceRequestIds: [...REVERSE_IDS],
        };
      }
      if (!sameAddress(reverse.reversePool, reverse.pool)) {
        return {
          status: "chain-proven-rejected" as const,
          reasonCode: "kyberswap_elastic_factory_reverse_binding_failed",
          evidenceRequestIds: [...REVERSE_IDS],
        };
      }
      const pool = canonicalAddress(reverse.pool);
      const factory = canonicalAddress(reverse.factory);
      return {
        status: "verified" as const,
        identity: {
          familyId: KYSWAP_FAMILY_ID,
          lineageId: KYSWAP_LINEAGE_ID,
          subject: pool,
          facts: Object.freeze({
            pool,
            token0: canonicalAddress(reverse.token0),
            token1: canonicalAddress(reverse.token1),
            feeUnits: reverse.feeUnits,
            tickDistance: reverse.tickDistance,
            factoryBinding: Object.freeze({
              factory,
              reversePool: canonicalAddress(reverse.reversePool),
            }),
          }),
          provenance: [Object.freeze({
            kind: "factory-reverse-binding",
            subject: factory,
            evidenceHash: hashCanonical({
              pool,
              factory,
              token0: canonicalAddress(reverse.token0),
              token1: canonicalAddress(reverse.token1),
              feeUnits: reverse.feeUnits.toString(),
              tickDistance: reverse.tickDistance,
              reversePool: canonicalAddress(reverse.reversePool),
              poolCodeHash: reverse.poolCodeHash,
            }),
          })],
        },
      };
    },
  }],
};

function staticRequests(pool: string): readonly AdapterRequest[] {
  return Object.freeze([
    poolCall("pool-factory", pool, "factory"),
    poolCall("pool-token0", pool, "token0"),
    poolCall("pool-token1", pool, "token1"),
    poolCall("pool-fee-units", pool, "swapFeeUnits"),
    poolCall("pool-tick-distance", pool, "tickDistance"),
    poolCall("pool-state", pool, "getPoolState"),
    poolCall("pool-liquidity-state", pool, "getLiquidityState"),
  ]);
}

function poolCall(
  id: string,
  pool: string,
  functionName:
    | "factory"
    | "token0"
    | "token1"
    | "swapFeeUnits"
    | "tickDistance"
    | "getPoolState"
    | "getLiquidityState",
): AdapterRequest {
  return Object.freeze({
    id,
    kind: "eth-call" as const,
    to: canonicalAddress(pool),
    data: KYSWAP_POOL_INTERFACE.encodeFunctionData(functionName),
    completion: "return-data" as const,
  });
}

function decodeStatic(
  pool: string,
  results: readonly AdapterRequestResult[],
): KyberSwapPoolStaticEvidence {
  const code = returnedResult(results, "pool-code").data;
  const factory = decodeAddress(
    KYSWAP_POOL_INTERFACE,
    "factory",
    results,
    "pool-factory",
  );
  const token0 = decodeAddress(
    KYSWAP_POOL_INTERFACE,
    "token0",
    results,
    "pool-token0",
  );
  const token1 = decodeAddress(
    KYSWAP_POOL_INTERFACE,
    "token1",
    results,
    "pool-token1",
  );
  const feeUnits = decodeUint(
    KYSWAP_POOL_INTERFACE,
    "swapFeeUnits",
    results,
    "pool-fee-units",
  );
  const tickDistance = Number(decodeUint(
    KYSWAP_POOL_INTERFACE,
    "tickDistance",
    results,
    "pool-tick-distance",
  ));
  const poolState = KYSWAP_POOL_INTERFACE.decodeFunctionResult(
    "getPoolState",
    returnedResult(results, "pool-state").data,
  );
  const liquidityState = KYSWAP_POOL_INTERFACE.decodeFunctionResult(
    "getLiquidityState",
    returnedResult(results, "pool-liquidity-state").data,
  );
  const sqrtP = BigInt(poolState[0] as bigint);
  const currentTick = Number(poolState[1]);
  const nearestCurrentTick = Number(poolState[2]);
  const locked = Boolean(poolState[3]);
  const baseL = BigInt(liquidityState[0] as bigint);
  const reinvestL = BigInt(liquidityState[1] as bigint);
  const rejected: string[] = [];
  if (code === "0x") rejected.push("pool-code");
  if (isZeroAddress(factory) || sameAddress(factory, pool)) {
    rejected.push("pool-factory");
  }
  if (
    isZeroAddress(token0) ||
    isZeroAddress(token1) ||
    sameAddress(token0, token1) ||
    sameAddress(token0, pool) ||
    sameAddress(token1, pool)
  ) {
    rejected.push("pool-token0");
    rejected.push("pool-token1");
  }
  if (feeUnits <= 0n || feeUnits >= KYSWAP_FEE_UNITS) {
    rejected.push("pool-fee-units");
  }
  if (!Number.isSafeInteger(tickDistance) || tickDistance <= 0 ||
      tickDistance > MAX_TICK) {
    rejected.push("pool-tick-distance");
  }
  if (
    sqrtP < MIN_SQRT_RATIO ||
    sqrtP >= MAX_SQRT_RATIO ||
    !Number.isSafeInteger(currentTick) ||
    currentTick < MIN_TICK ||
    currentTick > MAX_TICK ||
    !Number.isSafeInteger(nearestCurrentTick) ||
    nearestCurrentTick < MIN_TICK ||
    nearestCurrentTick > currentTick ||
    locked
  ) {
    rejected.push("pool-state");
  }
  // Active liquidity is a state, not a semantic proof: a pool with no active
  // liquidity right now (observed pools trade through reinvestment liquidity
  // with baseL == 0) must not be rejected as an instance, so its absence is
  // handled fail-closed by the quote instead of by identity.
  return Object.freeze({
    phase: "pool-static" as const,
    pool,
    poolCodeHash: ethers.keccak256(code),
    factory: canonicalAddress(factory),
    token0: canonicalAddress(token0),
    token1: canonicalAddress(token1),
    feeUnits,
    tickDistance,
    sqrtP,
    currentTick,
    nearestCurrentTick,
    locked,
    baseL,
    reinvestL,
    staticValid: rejected.length === 0,
    evidenceRequestIds: rejected.length === 0 ? [] : [...new Set(rejected)],
  });
}

function decodeReverse(
  prior: KyberSwapPoolStaticEvidence,
  results: readonly AdapterRequestResult[],
): KyberSwapReverseBindingEvidence {
  const result = results.find((candidate) =>
    candidate.id === REVERSE_IDS[0]);
  let reversePool = ethers.ZeroAddress;
  if (result !== undefined && result.ok) {
    if (result.completion === "reverted-as-declared") {
      reversePool = ethers.ZeroAddress;
    } else {
      reversePool = canonicalAddress(String(
        KYSWAP_FACTORY_INTERFACE.decodeFunctionResult(
          "getPool",
          result.data,
        )[0],
      ));
    }
  }
  return Object.freeze({
    ...prior,
    phase: "reverse-binding" as const,
    reversePool,
    bindingValid: sameAddress(reversePool, prior.pool),
  });
}

function sortTokenPair(
  token0: string,
  token1: string,
): readonly [string, string] {
  return BigInt(token0) < BigInt(token1)
    ? [canonicalAddress(token0), canonicalAddress(token1)]
    : [canonicalAddress(token1), canonicalAddress(token0)];
}

void lowerAddress;
