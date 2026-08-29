import { UNIV3_STANDARD_SOURCE_WINDOW_BLOCKS } from "./manifest.ts";
import { candidateSnapshotHash, instanceNominationKey, type UniV3CandidateSeedV1 } from "./discovery.ts";
import { assertCutoff, assertDecimal, canonicalAddress, familyCandidateKey, type UniV3CandidateV1 } from "./types.ts";

export type UniV3NominationOutcomeV1 =
  | { readonly status: "nominated"; readonly candidate: UniV3CandidateV1 }
  | { readonly status: "chain-proven-rejected"; readonly reasonCode: "evidence-before-window" | "evidence-after-cutoff" | "evidence-topic-missing" };

export function nominateUniV3(input: UniV3CandidateSeedV1): UniV3NominationOutcomeV1 {
  const evidence = input.evidence;
  if (evidence.topic0 === undefined) return Object.freeze({ status: "chain-proven-rejected", reasonCode: "evidence-topic-missing" });
  const cutoff = assertCutoff(evidence.cutoff);
  const block = BigInt(assertDecimal(evidence.blockNumber, "evidence.blockNumber"));
  const cutoffNumber = BigInt(cutoff.number);
  if (block > cutoffNumber) return Object.freeze({ status: "chain-proven-rejected", reasonCode: "evidence-after-cutoff" });
  if (block < cutoffNumber - BigInt(UNIV3_STANDARD_SOURCE_WINDOW_BLOCKS - 1)) return Object.freeze({ status: "chain-proven-rejected", reasonCode: "evidence-before-window" });
  const target = canonicalAddress(input.target);
  const key = instanceNominationKey({ target, evidence });
  const candidate = Object.freeze({
    target,
    instanceNominationKey: key,
    candidateSnapshotHash: candidateSnapshotHash({ ...evidence, target }),
    evidence: Object.freeze({ ...evidence, target, cutoff, topic0: evidence.topic0 }),
  });
  return Object.freeze({ status: "nominated", candidate });
}

export function candidateFamilyKey(candidate: UniV3CandidateV1): `0x${string}` {
  if (candidate.instanceNominationKey !== canonicalAddress(candidate.target)) throw new TypeError("univ3 nomination key mismatch");
  if (candidate.evidence.kind !== "source-plan" && candidate.candidateSnapshotHash !== candidateSnapshotHash(candidate.evidence)) throw new TypeError("univ3 candidate snapshot mismatch");
  return familyCandidateKey(candidate.instanceNominationKey);
}
