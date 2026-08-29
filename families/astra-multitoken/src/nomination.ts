import { ASTRA_SOURCE_WINDOW_BLOCKS } from "./manifest.ts";
import { instanceNominationKey, candidateFamilyKey } from "./discovery.ts";
import { decodeAstraCandidate } from "./discovery.ts";
import type { AstraCandidateV1, AstraObservationV1 } from "./types.ts";
import type { Hash } from "../../../packages/canonical-codec/src/index.ts";

export type AstraNominationOutcomeV1 =
  | { readonly status: "nominated"; readonly candidate: AstraCandidateV1 }
  | { readonly status: "chain-proven-rejected"; readonly reasonCode: "evidence-before-window" | "evidence-after-cutoff" | "malformed-evidence" };

export function nominateAstra(input: { readonly target: string; readonly evidence: AstraObservationV1 }): AstraNominationOutcomeV1 {
  const cutoff = input.evidence.source;
  const block = BigInt(input.evidence.blockNumber);
  const end = BigInt(cutoff.number);
  if (block > end) return Object.freeze({ status: "chain-proven-rejected", reasonCode: "evidence-after-cutoff" });
  if (block < end - BigInt(ASTRA_SOURCE_WINDOW_BLOCKS - 1)) return Object.freeze({ status: "chain-proven-rejected", reasonCode: "evidence-before-window" });
  const candidate = decodeAstraCandidate(input.evidence, input.evidence.kind === "call" ? "astra-change-call" : "astra-change-log");
  if (candidate === null) return Object.freeze({ status: "chain-proven-rejected", reasonCode: "malformed-evidence" });
  if (candidate.target !== instanceNominationKey({ target: input.target })) throw new TypeError("astra nomination target mismatch");
  return Object.freeze({ status: "nominated", candidate });
}

export function assertAstraNomination(candidate: AstraCandidateV1): void {
  if (instanceNominationKey(candidate) !== candidate.instanceNominationKey) throw new TypeError("astra nomination key mismatch");
}

export function astraCandidateFamilyKey(candidate: AstraCandidateV1): Hash {
  assertAstraNomination(candidate);
  return candidateFamilyKey(candidate);
}
