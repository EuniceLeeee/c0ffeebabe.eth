import { hashDomain, type Hash } from "../../../../packages/canonical-codec/src/index.ts";
import type { CanonicalCutoffV1 } from "../../../../packages/discovery/src/index.ts";
import { verifyUniV2Identity, type UniV2IdentityFactsV1, type UniV2IdentityVerdictV1 } from "../kernel/identity.ts";
import { UNIV2_STANDARD_FAMILY_DEFINITION_HASH } from "../family-definition.ts";
import {
  assertCutoffEqual,
  decodeIdentityReadFacts,
  decodeIdentityReads,
  nominationKeyForPool,
  sourceRequestRoot,
  UNIV2_FACTORY_SELECTOR,
  UNIV2_GET_PAIR_SELECTOR,
  UNIV2_TOKEN0_SELECTOR,
  UNIV2_TOKEN1_SELECTOR,
  type UniV2IdentityReadFactsV1,
  type UniV2DecodedIdentityReadsV1,
  type UniV2NominationV1,
  type UniV2SourceRequestV1,
} from "../schema/index.ts";

export interface UniV2IdentityVerifiedV1 {
  readonly cutoff: CanonicalCutoffV1;
  readonly facts: UniV2IdentityFactsV1;
  readonly factsHash: Hash;
  readonly instanceKey: string;
  readonly familyDefinitionHash: Hash;
  readonly instanceNominationKey: string;
  readonly candidateSnapshotHash: Hash;
  readonly sourceRequestRoot: Hash;
}

/** Stable descriptor identity, independent of the release-bound fee policy. */
export function uniV2IdentityDescriptorHash(facts: UniV2IdentityFactsV1): Hash {
  return hashDomain("aloha/univ2-standard/instance-descriptor/v1", {
    pool: facts.pool,
    factory: facts.factory,
    token0: facts.token0,
    token1: facts.token1,
  });
}

export type UniV2IdentityStageOutcomeV1 =
  | { readonly status: "verified"; readonly identity: UniV2IdentityVerifiedV1 }
  | Extract<UniV2IdentityVerdictV1, { readonly status: "chain-proven-rejected" }>;

function request(
  phase: "identity",
  target: string,
  data: string,
  cutoff: CanonicalCutoffV1,
  responseEncoding: UniV2SourceRequestV1["responseEncoding"],
): UniV2SourceRequestV1 {
  return Object.freeze({
    requestId: hashDomain("aloha/univ2-standard/request-id/v1", { phase, target, data, cutoff }),
    phase,
    target,
    data,
    cutoff,
    responseEncoding,
  });
}

function addressArgument(address: string): string {
  return `${address.slice(2).padStart(64, "0")}`;
}

/** Base reads are source-bound to the pool and fixed cutoff. */
export function buildIdentityBaseReadRequests(
  pool: string,
  cutoff: CanonicalCutoffV1,
): readonly UniV2SourceRequestV1[] {
  const target = pool;
  return Object.freeze([
    request("identity", target, UNIV2_TOKEN0_SELECTOR, cutoff, "abi-address-word"),
    request("identity", target, UNIV2_TOKEN1_SELECTOR, cutoff, "abi-address-word"),
    request("identity", target, UNIV2_FACTORY_SELECTOR, cutoff, "abi-address-word"),
  ]);
}

/** Pair reads are emitted only after token0/token1 have been decoded. */
export function buildIdentityPairReadRequests(
  decoded: Pick<UniV2DecodedIdentityReadsV1, "factory" | "token0" | "token1" | "cutoff">,
): readonly UniV2SourceRequestV1[] {
  const forwardData = `${UNIV2_GET_PAIR_SELECTOR}${addressArgument(decoded.token0)}${addressArgument(decoded.token1)}`;
  const reverseData = `${UNIV2_GET_PAIR_SELECTOR}${addressArgument(decoded.token1)}${addressArgument(decoded.token0)}`;
  return Object.freeze([
    request("identity", decoded.factory, forwardData, decoded.cutoff, "abi-address-word"),
    request("identity", decoded.factory, reverseData, decoded.cutoff, "abi-address-word"),
  ]);
}

export function verifyUniV2IdentityStage(input: {
  readonly nomination: UniV2NominationV1;
  readonly reads: UniV2IdentityReadFactsV1;
}): UniV2IdentityStageOutcomeV1 {
  const reads = decodeIdentityReadFacts(input.reads);
  if (reads.pool !== input.nomination.pool) throw new Error("univ2-identity-pool-mismatch");
  if (input.nomination.instanceNominationKey !== nominationKeyForPool(reads.pool)) throw new Error("univ2-identity-nomination-key-mismatch");
  assertCutoffEqual(reads.cutoff, input.nomination.evidence.cutoff);
  const decoded = decodeIdentityReads(reads);
  const facts: UniV2IdentityFactsV1 = {
    pool: decoded.pool,
    factory: decoded.factory,
    token0: decoded.token0,
    token1: decoded.token1,
    forwardPair: decoded.forwardPair,
    reversePair: decoded.reversePair,
  };
  const verdict = verifyUniV2Identity(facts);
  if (verdict.status !== "verified") return verdict;
  const requests = [
    ...buildIdentityBaseReadRequests(reads.pool, reads.cutoff),
    ...buildIdentityPairReadRequests(decoded),
  ];
  return Object.freeze({
    status: "verified",
    identity: Object.freeze({
      cutoff: reads.cutoff,
      facts: verdict.facts,
      factsHash: verdict.factsHash,
      instanceKey: verdict.instanceKey,
      familyDefinitionHash: UNIV2_STANDARD_FAMILY_DEFINITION_HASH,
      instanceNominationKey: input.nomination.instanceNominationKey,
      candidateSnapshotHash: input.nomination.candidateSnapshotHash,
      sourceRequestRoot: sourceRequestRoot(requests),
    }),
  });
}
