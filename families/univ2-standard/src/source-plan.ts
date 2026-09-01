import { asSchemaRef } from "../../../packages/capability-contracts/src/index.ts";
import { hashDomain } from "../../../packages/canonical-codec/src/index.ts";
import { defineFamilySourcePlan } from "../../../packages/discovery/src/index.ts";

export const UNIV2_STANDARD_SOURCE_PLAN_ID =
  "univ2-standard.fixed-cutoff-50-block" as const;

export const UNIV2_STANDARD_SOURCE_PLAN_SCHEMA_HASH = asSchemaRef(hashDomain(
  "aloha/univ2-standard/source-plan-schema/v1",
  UNIV2_STANDARD_SOURCE_PLAN_ID,
));
export const UNIV2_STANDARD_HISTORY_SOURCE_PLAN_ID = "univ2-standard.pair-created-rolling-observation" as const;
export const UNIV2_STANDARD_HISTORY_SOURCE_PLAN_SCHEMA_HASH = asSchemaRef(hashDomain("aloha/univ2-standard/history-source-plan-schema/v1", UNIV2_STANDARD_HISTORY_SOURCE_PLAN_ID));
export const UNIV2_PAIR_CREATED_TOPIC0 = "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9" as const;

/**
 * Nomination-only recent evidence is not universe completeness.  The
 * generated catalog binds this exact declaration and its compiler closure.
 */
export const UNIV2_STANDARD_SOURCE_PLAN_DEFINITION = defineFamilySourcePlan({
  sourcePlanId: UNIV2_STANDARD_SOURCE_PLAN_ID,
  completeness: "nomination-only",
  historyStartBlock: null,
  schemaHash: UNIV2_STANDARD_SOURCE_PLAN_SCHEMA_HASH,
});
export const UNIV2_STANDARD_HISTORY_SOURCE_PLAN_DEFINITION = defineFamilySourcePlan({ sourcePlanId: UNIV2_STANDARD_HISTORY_SOURCE_PLAN_ID, completeness: "rolling-observation", historyStartBlock: null, schemaHash: UNIV2_STANDARD_HISTORY_SOURCE_PLAN_SCHEMA_HASH });
