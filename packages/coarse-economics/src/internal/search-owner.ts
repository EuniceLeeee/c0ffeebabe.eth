import {
  coarseEnumerationRootV1,
  decodeCoarseEnumerationBindingV1,
  decodeCoarseRouteBindingV1,
  type CoarseEnumerationIssueInputV1,
  type CoarseEnumerationBindingV1,
  type CoarseRouteBindingV1,
  type IssuedCoarseEnumerationBindingV1,
  type IssuedCoarseRouteBindingV1,
} from "../index.ts";
import { hashDomain } from "../../../canonical-codec/src/index.ts";
import { readIssuedPlanningEnumerationV1 } from "../../../planner/src/index.ts";
import {
  readCoarseRouteBindingV1,
  registerCoarseEnumerationBindingV1,
  registerCoarseRouteBindingV1,
} from "./state.ts";

/** Search-owner-only handoff after planner/Graph/lease validation. */
export function issueCoarseRouteBindingV1(value: CoarseRouteBindingV1): IssuedCoarseRouteBindingV1 {
  const binding = decodeCoarseRouteBindingV1(value);
  const capability = Object.freeze(Object.create(null)) as IssuedCoarseRouteBindingV1;
  registerCoarseRouteBindingV1(capability, binding);
  return capability;
}

/** One immutable denominator/policy envelope; callers cannot omit or regroup
 * individual routes after it has been issued. */
export function issueCoarseEnumerationBindingV1(
  input: CoarseEnumerationIssueInputV1,
): IssuedCoarseEnumerationBindingV1 {
  const planner = readIssuedPlanningEnumerationV1(input.plannerEnumeration);
  if (input.generationId !== planner.planningProblem.generationId
    || input.releaseProvenanceHash !== planner.planningProblem.releaseProvenanceHash
    || input.objective.objectiveRef !== planner.planningProblem.objectiveRef
    || input.source.hash !== planner.planningProblem.triggerHeadHash) {
    throw new TypeError("coarse enumeration does not bind the planner-issued planning problem");
  }
  if (!Array.isArray(input.candidates) || input.candidates.length !== planner.candidates.length) {
    throw new TypeError("coarse enumeration denominator does not match the planner-issued enumeration");
  }
  for (const [index, plannerCandidate] of planner.candidates.entries()) {
    const candidate = input.candidates[index]!;
    const binding = decodeCoarseRouteBindingV1(readCoarseRouteBindingForJoin(candidate.binding));
    if (binding.candidateId !== plannerCandidate.candidateId
      || binding.orderKey !== plannerCandidate.orderKey
      || binding.planningProblemHash !== planner.planningProblemHash
      || binding.graphRoot !== planner.graphRoot
      || binding.generationId !== planner.planningProblem.generationId
      || binding.releaseProvenanceHash !== planner.planningProblem.releaseProvenanceHash
      || binding.objectiveRef !== planner.planningProblem.objectiveRef
      || binding.legs.length !== plannerCandidate.legs.length) {
      throw new TypeError(`coarse enumeration candidate ${index} does not match the planner-issued identity`);
    }
    for (const [legIndex, plannerLeg] of plannerCandidate.legs.entries()) {
      const leg = binding.legs[legIndex]!;
      if (leg.edgeId !== plannerLeg.edgeId
        || leg.transitionRef !== plannerLeg.transitionRef
        || leg.inputAssetRef !== plannerLeg.inputAssetRef
        || leg.inputPortRef !== plannerLeg.inputPortRef
        || leg.outputAssetRef !== plannerLeg.outputAssetRef
        || leg.outputPortRef !== plannerLeg.outputPortRef) {
        throw new TypeError(`coarse enumeration candidate ${index} leg ${legIndex} does not match the planner-issued route`);
      }
    }
  }
  const fairnessSeed = hashDomain("aloha/coarse-fairness-seed/v1", {
    generationId: input.generationId,
    releaseProvenanceHash: input.releaseProvenanceHash,
    source: input.source,
    plannerEnumerationRoot: planner.enumerationRoot,
  });
  const body = {
    generationId: input.generationId,
    graphRoot: planner.graphRoot,
    source: input.source,
    releaseProvenanceHash: input.releaseProvenanceHash,
    objective: input.objective,
    policy: input.policy,
    fairnessSeed,
    planningProblemHash: planner.planningProblemHash,
    plannerEnumerationRoot: planner.enumerationRoot,
    enumerationTruncated: planner.truncated,
    observedUniqueCountLowerBound: planner.observedUniqueCountLowerBound,
    candidates: input.candidates,
  };
  const value: CoarseEnumerationBindingV1 = {
    ...body,
    coarseEnumerationRoot: coarseEnumerationRootV1(body),
  };
  const binding = decodeCoarseEnumerationBindingV1(value);
  const capability = Object.freeze(Object.create(null)) as IssuedCoarseEnumerationBindingV1;
  registerCoarseEnumerationBindingV1(capability, binding);
  return capability;
}

function readCoarseRouteBindingForJoin(value: unknown): CoarseRouteBindingV1 {
  if (value === null || typeof value !== "object") throw new TypeError("coarse route binding capability is invalid");
  const binding = readCoarseRouteBindingV1(value);
  if (binding === undefined) throw new TypeError("coarse route binding was not issued by the search owner");
  return binding as CoarseRouteBindingV1;
}
