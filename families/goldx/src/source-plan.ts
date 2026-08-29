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

import { GOLDX_SOURCE_PLAN_ID, GOLDX_SOURCE_PLAN_SCHEMA_HASH } from "./manifest.ts";
import { GOLDX_FAMILY_AUTHORING_HASH } from "./family-definition.ts";

export const GOLDX_SOURCE_PLAN = defineFamilySourcePlan({
  sourcePlanId: GOLDX_SOURCE_PLAN_ID,
  completeness: "nomination-only",
  historyStartBlock: null,
  schemaHash: GOLDX_SOURCE_PLAN_SCHEMA_HASH,
});

function sameCutoff(left: { readonly chainId: string; readonly number: string; readonly hash: Hash; readonly stateRoot: Hash }, right: typeof left): boolean {
  return left.chainId === right.chainId && left.number === right.number && left.hash === right.hash && left.stateRoot === right.stateRoot;
}

function assertNominationBinding(input: FamilySourcePlanNominationInputV1): void {
  const expectedFrom = (BigInt(input.recent.cutoff.number) - 49n).toString();
  if (
    input.execution.plan.familyDefinitionHash !== GOLDX_FAMILY_AUTHORING_HASH
    || encodeCanonicalJson(input.execution.plan) !== encodeCanonicalJson(input.sourceEvidence.plan)
    || input.execution.sourceEvidenceRoot !== input.sourceEvidence.evidenceRoot
    || input.execution.outcome !== "positive-only"
    || input.execution.sourceEvidenceRefs.length !== 0
    || input.execution.rawLocatorHashes.length !== 0
    || input.sourceEvidence.refs.length !== 0
    || input.sourceEvidence.rawLocatorHashes.length !== 0
    || !sameCutoff(input.execution.cutoff, input.recent.cutoff)
    || !sameCutoff(input.sourceEvidence.cutoff, input.recent.cutoff)
    || input.execution.from !== expectedFrom
    || input.execution.through !== input.recent.cutoff.number
    || input.recent.range.from !== input.execution.from
    || input.recent.range.to !== input.execution.through
  ) throw new TypeError("goldx nomination binding mismatch");
}

function sealPositiveOnlySourceExecution(input: FamilySourcePlanExecutionInputV1) {
  const result = sealNominationOnlySourceExecution(input);
  const withoutRoot = { ...result.execution, outcome: "positive-only" as const };
  return Object.freeze({
    ...result,
    execution: Object.freeze({ ...withoutRoot, executionRoot: sourcePlanExecutionRoot(withoutRoot) }),
  });
}

export const GOLDX_SOURCE_PLAN_RUNTIME: FamilySourcePlanRuntimeV1 = Object.freeze({
  ...GOLDX_SOURCE_PLAN,
  async execute(input: FamilySourcePlanExecutionInputV1, _physical: FamilySourcePlanPhysicalPortV1, signal: AbortSignal) {
    if (signal.aborted) throw signal.reason;
    if (input.plan.familyDefinitionHash !== GOLDX_FAMILY_AUTHORING_HASH || input.plan.completeness !== "nomination-only" || input.plan.historyStartBlock !== null || input.previousAppliedThrough !== null) {
      throw new TypeError("goldx source plan binding mismatch");
    }
    return sealPositiveOnlySourceExecution(input);
  },
});

export const GOLDX_SOURCE_NOMINATION_PROGRAM: FamilySourcePlanNominationProgramV1 = Object.freeze({
  kind: "aloha.family-source-plan-nomination-program",
  version: 1,
  schemaHash: GOLDX_SOURCE_PLAN_SCHEMA_HASH,
  async evaluate(input: FamilySourcePlanNominationInputV1, signal: AbortSignal): Promise<readonly CandidateNominationV1[]> {
    if (signal.aborted) throw signal.reason;
    assertNominationBinding(input);
    // GOLDx is owned by observed mint calls/address surfaces.  The source-plan
    // transport only supplies recent logs, and no chain-owned GOLDx event ABI
    // exists in this release.  Never relabel a log as a call; remain empty
    // until a real call/evidence channel is added to the source contract.
    return Object.freeze([]);
  },
});
