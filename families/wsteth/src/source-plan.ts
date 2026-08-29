import { encodeCanonicalJson, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import {
  defineFamilySourcePlan,
  sealNominationOnlySourceExecution,
  sourcePlanExecutionRoot,
  type CandidateNominationV1,
} from "../../../packages/discovery/src/index.ts";
import type {
  FamilySourcePlanExecutionInputV1,
  FamilySourcePlanNominationInputV1,
  FamilySourcePlanNominationProgramV1,
  FamilySourcePlanPhysicalPortV1,
  FamilySourcePlanRuntimeV1,
} from "../../../packages/family-sdk/runtime/index.ts";

import { WSTETH_FAMILY_ID, WSTETH_SOURCE_PLAN_ID, WSTETH_SOURCE_PLAN_SCHEMA_HASH } from "./manifest.ts";
import { WSTETH_FAMILY_AUTHORING_HASH } from "./family-definition.ts";

export const WSTETH_SOURCE_PLAN = defineFamilySourcePlan({
  sourcePlanId: WSTETH_SOURCE_PLAN_ID,
  completeness: "nomination-only",
  historyStartBlock: null,
  schemaHash: WSTETH_SOURCE_PLAN_SCHEMA_HASH,
});

function sameCutoff(left: { readonly chainId: string; readonly number: string; readonly hash: Hash; readonly stateRoot: Hash }, right: typeof left): boolean {
  return left.chainId === right.chainId && left.number === right.number && left.hash === right.hash && left.stateRoot === right.stateRoot;
}

function assertNominationBinding(input: FamilySourcePlanNominationInputV1): void {
  if (
    input.execution.plan.familyDefinitionHash !== WSTETH_FAMILY_AUTHORING_HASH
    || encodeCanonicalJson(input.execution.plan) !== encodeCanonicalJson(input.sourceEvidence.plan)
    || input.execution.sourceEvidenceRoot !== input.sourceEvidence.evidenceRoot
    || input.execution.outcome !== "positive-only"
    || input.execution.sourceEvidenceRefs.length !== 0
    || input.execution.rawLocatorHashes.length !== 0
    || input.sourceEvidence.refs.length !== 0
    || input.sourceEvidence.rawLocatorHashes.length !== 0
    || !sameCutoff(input.execution.cutoff, input.recent.cutoff)
    || !sameCutoff(input.sourceEvidence.cutoff, input.recent.cutoff)
  ) throw new TypeError("wsteth nomination binding mismatch");
}

function sealPositiveOnlySourceExecution(input: FamilySourcePlanExecutionInputV1) {
  const result = sealNominationOnlySourceExecution(input);
  const withoutRoot = { ...result.execution, outcome: "positive-only" as const };
  return Object.freeze({
    ...result,
    execution: Object.freeze({ ...withoutRoot, executionRoot: sourcePlanExecutionRoot(withoutRoot) }),
  });
}

export const WSTETH_SOURCE_PLAN_RUNTIME: FamilySourcePlanRuntimeV1 = Object.freeze({
  ...WSTETH_SOURCE_PLAN,
  async execute(input: FamilySourcePlanExecutionInputV1, _physical: FamilySourcePlanPhysicalPortV1, signal: AbortSignal) {
    if (signal.aborted) throw signal.reason;
    if (input.plan.familyDefinitionHash !== WSTETH_FAMILY_AUTHORING_HASH || input.plan.completeness !== "nomination-only" || input.plan.historyStartBlock !== null || input.previousAppliedThrough !== null) {
      throw new TypeError("wsteth source plan binding mismatch");
    }
    return sealPositiveOnlySourceExecution(input);
  },
});

export const WSTETH_SOURCE_NOMINATION_PROGRAM: FamilySourcePlanNominationProgramV1 = Object.freeze({
  kind: "aloha.family-source-plan-nomination-program",
  version: 1,
  schemaHash: WSTETH_SOURCE_PLAN_SCHEMA_HASH,
  async evaluate(input: FamilySourcePlanNominationInputV1, signal: AbortSignal): Promise<readonly CandidateNominationV1[]> {
    if (signal.aborted) throw signal.reason;
    assertNominationBinding(input);
    // No recent-log topic/address/call-pattern can prove this Family yet.
    // Returning an explicit empty set is safer than reading caller-selected bytes.
    return Object.freeze([]);
  },
});
