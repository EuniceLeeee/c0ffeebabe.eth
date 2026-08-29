import { hashDomain, type Hash } from "../../../../packages/canonical-codec/src/index.ts";
import type { CanonicalCutoffV1 } from "../../../../packages/discovery/src/index.ts";
import { decodeReserves, type UniV2Reserves } from "../kernel/codec.ts";
import { sealUniV2MaterializedState } from "../kernel/state.ts";
import { assertCutoffEqual, decodeReservesReadFacts, sealMaterializedState, UNIV2_GET_RESERVES_SELECTOR, type UniV2MaterializedStateV1, type UniV2ReservesReadFactsV1, type UniV2SourceRequestV1 } from "../schema/index.ts";
import type { UniV2IdentityVerifiedV1 } from "./identity.ts";

export interface UniV2MaterializationVerifiedV1 {
  readonly cutoff: CanonicalCutoffV1;
  readonly pool: string;
  readonly identityFactsHash: Hash;
  readonly state: UniV2MaterializedStateV1;
  readonly sourceRequest: UniV2SourceRequestV1;
}

export type UniV2MaterializationOutcomeV1 =
  | { readonly status: "verified"; readonly materialization: UniV2MaterializationVerifiedV1 }
  | { readonly status: "chain-proven-rejected"; readonly reasonCode: "zero-liquidity" };

function sourceRequest(pool: string, cutoff: CanonicalCutoffV1): UniV2SourceRequestV1 {
  return Object.freeze({
    requestId: hashDomain("aloha/univ2-standard/request-id/v1", {
      phase: "materialization",
      target: pool,
      data: UNIV2_GET_RESERVES_SELECTOR,
      cutoff,
    }),
    phase: "materialization",
    target: pool,
    data: UNIV2_GET_RESERVES_SELECTOR,
    cutoff,
    responseEncoding: "abi-reserves",
  });
}

function stateFromReserves(cutoff: CanonicalCutoffV1, pool: string, reserves: UniV2Reserves): UniV2MaterializedStateV1 {
  const kernelState = sealUniV2MaterializedState({
    cutoff,
    pool,
    reserve0: reserves.reserve0,
    reserve1: reserves.reserve1,
    blockTimestampLast: reserves.blockTimestampLast,
  });
  const state = sealMaterializedState({
    cutoff,
    pool: kernelState.pool,
    reserve0: kernelState.reserve0.toString(10),
    reserve1: kernelState.reserve1.toString(10),
    blockTimestampLast: kernelState.blockTimestampLast.toString(10),
  });
  if (state.stateHash !== kernelState.stateHash) throw new Error("univ2-state-hash-disagreement");
  return state;
}

/**
 * Materialization consumes a source-stamped getReserves result.  The Family
 * does not claim that a caller-supplied block number is a chain read; the
 * work-plane must provide the exact cutoff-bound response envelope.
 */
export function materializeUniV2(input: {
  readonly identity: UniV2IdentityVerifiedV1;
  readonly read: UniV2ReservesReadFactsV1;
}): UniV2MaterializationOutcomeV1 {
  const read = decodeReservesReadFacts(input.read);
  if (read.pool !== input.identity.facts.pool) throw new Error("univ2-materialization-pool-mismatch");
  assertCutoffEqual(read.cutoff, input.identity.cutoff);
  const expectedIdentityHash = hashDomain("aloha/univ2-standard/identity-facts/v1", input.identity.facts);
  if (expectedIdentityHash !== input.identity.factsHash) throw new Error("univ2-identity-facts-hash-mismatch");
  const reserves = decodeReserves(read.reservesReturnHex);
  if (reserves.reserve0 === 0n || reserves.reserve1 === 0n) {
    return Object.freeze({ status: "chain-proven-rejected", reasonCode: "zero-liquidity" });
  }
  return Object.freeze({
    status: "verified",
    materialization: Object.freeze({
      cutoff: read.cutoff,
      pool: read.pool,
      identityFactsHash: input.identity.factsHash,
      state: stateFromReserves(read.cutoff, read.pool, reserves),
      sourceRequest: sourceRequest(read.pool, read.cutoff),
    }),
  });
}
