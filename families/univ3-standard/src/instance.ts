import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { UNIV3_STANDARD_FAMILY_DEFINITION_HASH } from "./family-definition.ts";
import { assertCutoff, canonicalAddress, cutoffEqual, type UniV3IdentityV1, type UniV3MaterializedStateV1, type UniV3StateReadFactsV1 } from "./types.ts";

export type UniV3MaterializationOutcomeV1 =
  | { readonly status: "verified"; readonly state: UniV3MaterializedStateV1 }
  | { readonly status: "chain-proven-rejected"; readonly reasonCode: "zero-liquidity" };

function stateFactsHash(read: UniV3StateReadFactsV1): Hash {
  return hashDomain("aloha/univ3-standard/state-facts/v1", { ...read, sqrtPriceX96: read.sqrtPriceX96, liquidity: read.liquidity, tickBitmap: read.tickBitmap, ticks: read.ticks });
}

export function materializeUniV3(input: { readonly identity: UniV3IdentityV1; readonly read: UniV3StateReadFactsV1 }): UniV3MaterializationOutcomeV1 {
  const read = Object.freeze({ ...input.read, pool: canonicalAddress(input.read.pool) });
  assertCutoff(read.cutoff);
  if (!cutoffEqual(read.cutoff, input.identity.cutoff)) throw new TypeError("univ3 state cutoff mismatch");
  if (read.pool !== input.identity.instanceKey) throw new TypeError("univ3 state pool mismatch");
  if (BigInt(read.sqrtPriceX96) <= 0n || BigInt(read.liquidity) < 0n) throw new TypeError("univ3 state numeric bounds");
  if (read.liquidity === "0") return Object.freeze({ status: "chain-proven-rejected", reasonCode: "zero-liquidity" });
  if (read.tickBitmap.some(word => word.bits.startsWith("-")) || read.ticks.some(tick => !Number.isInteger(tick.tick))) throw new TypeError("univ3 state tick facts malformed");
  const factsHash = stateFactsHash(read);
  const stateHash = hashDomain("aloha/univ3-standard/materialized-state/v1", { familyDefinitionHash: UNIV3_STANDARD_FAMILY_DEFINITION_HASH, identityFactsHash: input.identity.factsHash, factsHash });
  return Object.freeze({ status: "verified", state: Object.freeze({ ...read, identityFactsHash: input.identity.factsHash, stateHash }) });
}

export function resealUniV3State(state: UniV3MaterializedStateV1): Hash {
  const facts = { cutoff: state.cutoff, pool: state.pool, sqrtPriceX96: state.sqrtPriceX96, tick: state.tick, liquidity: state.liquidity, fee: state.fee, tickSpacing: state.tickSpacing, tickBitmap: state.tickBitmap, ticks: state.ticks, ...(state.exactAmountOut === undefined ? {} : { exactAmountOut: state.exactAmountOut }) };
  return hashDomain("aloha/univ3-standard/materialized-state/v1", { familyDefinitionHash: UNIV3_STANDARD_FAMILY_DEFINITION_HASH, identityFactsHash: state.identityFactsHash, factsHash: stateFactsHash(facts) });
}
