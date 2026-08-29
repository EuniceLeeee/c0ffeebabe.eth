import { hashDomain, type Hash } from "../../../../packages/canonical-codec/src/index.ts";
import { canonicalAddress, sameAddress } from "./codec.ts";

export interface UniV2IdentityFactsV1 {
  readonly pool: string;
  readonly factory: string;
  readonly token0: string;
  readonly token1: string;
  /** Both factory.getPair(token0, token1) and getPair(token1, token0). */
  readonly forwardPair: string;
  readonly reversePair: string;
}

export type UniV2IdentityVerdictV1 =
  | { readonly status: "verified"; readonly instanceKey: string; readonly factsHash: Hash; readonly facts: UniV2IdentityFactsV1 }
  | {
    readonly status: "chain-proven-rejected";
    readonly reasonCode:
      | "identical-assets"
      | "zero-address-fact"
      | "noncanonical-token-order"
      | "factory-forward-binding-failed"
      | "factory-reverse-binding-failed";
  };

/** Pure interpretation of already source-bound chain facts; it performs no reads. */
export function verifyUniV2Identity(input: UniV2IdentityFactsV1): UniV2IdentityVerdictV1 {
  const facts = Object.freeze({
    pool: canonicalAddress(input.pool),
    factory: canonicalAddress(input.factory),
    token0: canonicalAddress(input.token0),
    token1: canonicalAddress(input.token1),
    forwardPair: canonicalAddress(input.forwardPair),
    reversePair: canonicalAddress(input.reversePair),
  });
  const zero = "0x0000000000000000000000000000000000000000";
  if ([facts.pool, facts.factory, facts.token0, facts.token1, facts.forwardPair, facts.reversePair].some(value => value === zero)) {
    return Object.freeze({ status: "chain-proven-rejected", reasonCode: "zero-address-fact" });
  }
  if (sameAddress(facts.token0, facts.token1)) return Object.freeze({ status: "chain-proven-rejected", reasonCode: "identical-assets" });
  if (BigInt(facts.token0) >= BigInt(facts.token1)) return Object.freeze({ status: "chain-proven-rejected", reasonCode: "noncanonical-token-order" });
  if (!sameAddress(facts.pool, facts.forwardPair)) return Object.freeze({ status: "chain-proven-rejected", reasonCode: "factory-forward-binding-failed" });
  if (!sameAddress(facts.pool, facts.reversePair)) return Object.freeze({ status: "chain-proven-rejected", reasonCode: "factory-reverse-binding-failed" });
  return Object.freeze({
    status: "verified",
    instanceKey: facts.pool,
    factsHash: hashDomain("aloha/univ2-standard/identity-facts/v1", facts),
    facts,
  });
}
