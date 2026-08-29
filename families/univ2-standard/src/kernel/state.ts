import { hashDomain, type Hash } from "../../../../packages/canonical-codec/src/index.ts";
import type { CanonicalCutoffV1 } from "../../../../packages/discovery/src/index.ts";
import { canonicalAddress } from "./codec.ts";

export interface UniV2MaterializedStateInputV1 {
  readonly cutoff: CanonicalCutoffV1;
  readonly pool: string;
  readonly reserve0: bigint;
  readonly reserve1: bigint;
  readonly blockTimestampLast: number;
}
export interface UniV2MaterializedStateV1 extends UniV2MaterializedStateInputV1 {
  readonly pool: string;
  readonly stateHash: Hash;
}

/**
 * State is only valid when it is read against the same canonical cutoff as
 * identity.  The hash uses decimal strings because bigint is not a wire type.
 */
export function sealUniV2MaterializedState(input: UniV2MaterializedStateInputV1): UniV2MaterializedStateV1 {
  const pool = canonicalAddress(input.pool);
  if (input.reserve0 < 0n || input.reserve0 >= 1n << 112n || input.reserve1 < 0n || input.reserve1 >= 1n << 112n) {
    throw new RangeError("reserve outside uint112");
  }
  if (!Number.isInteger(input.blockTimestampLast) || input.blockTimestampLast < 0 || input.blockTimestampLast >= 2 ** 32) {
    throw new RangeError("timestamp outside uint32");
  }
  const payload = {
    cutoff: input.cutoff,
    pool,
    reserve0: input.reserve0.toString(10),
    reserve1: input.reserve1.toString(10),
    blockTimestampLast: input.blockTimestampLast.toString(10),
  };
  return Object.freeze({
    ...input,
    pool,
    stateHash: hashDomain("aloha/univ2-standard/materialized-state/v1", payload),
  });
}
