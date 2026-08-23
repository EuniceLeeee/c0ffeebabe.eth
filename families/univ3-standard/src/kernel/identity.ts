import { hashDomain, type Hash } from "../../../../packages/canonical-codec/src/index.ts";
import { canonicalAddress, sameAddress } from "./codec.ts";

export interface UniV3IdentityFactsV1 {
  readonly pool: string;
  readonly factory: string;
  readonly token0: string;
  readonly token1: string;
  readonly fee: bigint;
  readonly tickSpacing: number;
  readonly reversePool: string;
}

export type UniV3IdentityVerdictV1 =
  | { readonly status: "verified"; readonly instanceKey: string; readonly factsHash: Hash; readonly facts: UniV3IdentityFactsV1 }
  | { readonly status: "chain-proven-rejected"; readonly reasonCode: "identical-assets" | "invalid-fee" | "invalid-tick-spacing" | "noncanonical-token-order" | "factory-reverse-binding-failed" };

export function verifyUniV3Identity(input: UniV3IdentityFactsV1): UniV3IdentityVerdictV1 {
  const facts = Object.freeze({
    pool: canonicalAddress(input.pool),
    factory: canonicalAddress(input.factory),
    token0: canonicalAddress(input.token0),
    token1: canonicalAddress(input.token1),
    fee: input.fee,
    tickSpacing: input.tickSpacing,
    reversePool: canonicalAddress(input.reversePool),
  });
  if (sameAddress(facts.token0, facts.token1)) return Object.freeze({ status: "chain-proven-rejected", reasonCode: "identical-assets" });
  if (facts.fee < 0n || facts.fee > 0xff_ffffn) return Object.freeze({ status: "chain-proven-rejected", reasonCode: "invalid-fee" });
  if (!Number.isInteger(facts.tickSpacing) || facts.tickSpacing <= 0 || facts.tickSpacing > 0x7f_ffff) return Object.freeze({ status: "chain-proven-rejected", reasonCode: "invalid-tick-spacing" });
  if (BigInt(facts.token0) >= BigInt(facts.token1)) return Object.freeze({ status: "chain-proven-rejected", reasonCode: "noncanonical-token-order" });
  if (!sameAddress(facts.pool, facts.reversePool)) return Object.freeze({ status: "chain-proven-rejected", reasonCode: "factory-reverse-binding-failed" });
  const hashable = { ...facts, fee: facts.fee.toString(10) };
  return Object.freeze({
    status: "verified",
    instanceKey: facts.pool,
    factsHash: hashDomain("aloha/univ3-standard/identity-facts/v1", hashable),
    facts,
  });
}
