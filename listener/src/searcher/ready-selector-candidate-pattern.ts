import { isDeepStrictEqual } from "node:util";
import type { UnifiedObservation } from "./venues/adapter-family-plugin.js";
import type { FamilyId } from "./venues/adapter-family-identifiers.js";
import type { FamilyCapabilityCatalog } from "./venues/family-capability-catalog.js";

/** A selector may own several parameter recipes. A durable candidate owns one
 * complete decoded nomination, so replay exactly that catalog pattern instead
 * of choosing the first ABI match or requiring the entire Family to be unique. */
export function readySelectorCandidatePattern(input: {
  readonly catalog: FamilyCapabilityCatalog;
  readonly familyId: FamilyId;
  readonly observation: UnifiedObservation;
  readonly candidate: Readonly<Record<string, unknown>>;
}): string {
  const family = input.catalog.forStrictFamily(input.familyId);
  if (!("discovery" in family.plugin)) throw new Error("Ready candidate Family has no discovery contract");
  const discovery = family.plugin.discovery, expectedKey = discovery.candidateKey(input.candidate as never);
  const matches = input.catalog.matches(input.observation).filter(match => match.familyId === input.familyId).filter(match => {
    const decoded = discovery.decodeCandidate({ observation: input.observation, matchedPatternId: match.patternId });
    return decoded !== null && typeof decoded === "object" &&
      discovery.candidateKey(decoded as never) === expectedKey &&
      Object.entries(decoded).every(([key, value]) => isDeepStrictEqual(value, input.candidate[key]));
  });
  if (matches.length !== 1) throw new Error("Ready call nomination does not uniquely bind its complete candidate program");
  return matches[0]!.patternId;
}
