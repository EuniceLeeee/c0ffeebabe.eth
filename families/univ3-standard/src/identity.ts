import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { verifyUniV3Identity } from "./kernel/identity.ts";
import { UNIV3_STANDARD_FAMILY_DEFINITION_HASH } from "./family-definition.ts";
import { assertCutoff, canonicalAddress, cutoffEqual, type UniV3CandidateV1, type UniV3IdentityReadFactsV1, type UniV3IdentityV1 } from "./types.ts";

export type UniV3IdentityOutcomeV1 =
  | { readonly status: "verified"; readonly identity: UniV3IdentityV1 }
  | { readonly status: "chain-proven-rejected"; readonly reasonCode: string };

export function verifyUniV3IdentityStage(input: { readonly candidate: UniV3CandidateV1; readonly reads: UniV3IdentityReadFactsV1 }): UniV3IdentityOutcomeV1 {
  const reads = Object.freeze({ ...input.reads, pool: canonicalAddress(input.reads.pool), factory: canonicalAddress(input.reads.factory), token0: canonicalAddress(input.reads.token0), token1: canonicalAddress(input.reads.token1), reversePool: canonicalAddress(input.reads.reversePool) });
  assertCutoff(reads.cutoff);
  if (!cutoffEqual(reads.cutoff, input.candidate.evidence.cutoff)) throw new TypeError("univ3 identity cutoff mismatch");
  if (!reads.pool || reads.pool !== canonicalAddress(input.candidate.target)) return Object.freeze({ status: "chain-proven-rejected", reasonCode: "candidate-pool-mismatch" });
  const verdict = verifyUniV3Identity({ ...reads, fee: BigInt(reads.fee) });
  if (verdict.status !== "verified") return Object.freeze({ status: "chain-proven-rejected", reasonCode: verdict.reasonCode });
  const facts = Object.freeze({ pool: verdict.facts.pool, factory: verdict.facts.factory, token0: verdict.facts.token0, token1: verdict.facts.token1, fee: verdict.facts.fee.toString(10), tickSpacing: verdict.facts.tickSpacing, reversePool: verdict.facts.reversePool });
  const factsHash: Hash = hashDomain("aloha/univ3-standard/identity-facts/v1", facts);
  if (factsHash !== verdict.factsHash) throw new TypeError("univ3 identity kernel hash mismatch");
  return Object.freeze({ status: "verified", identity: Object.freeze({ cutoff: reads.cutoff, candidateSnapshotHash: input.candidate.candidateSnapshotHash, facts, factsHash, instanceKey: verdict.instanceKey }) });
}

export function identityDescriptorHash(identity: UniV3IdentityV1): Hash {
  return hashDomain("aloha/univ3-standard/instance-descriptor/v1", { familyDefinitionHash: UNIV3_STANDARD_FAMILY_DEFINITION_HASH, factsHash: identity.factsHash, instanceKey: identity.instanceKey });
}
