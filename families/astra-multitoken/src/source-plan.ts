import { asSchemaRef } from "../../../packages/capability-contracts/src/index.ts";
import { hashDomain } from "../../../packages/canonical-codec/src/index.ts";
import { defineFamilySourcePlan } from "../../../packages/discovery/src/index.ts";
import {
  ASTRA_HISTORY_SOURCE_PLAN_ID,
  ASTRA_HISTORY_SOURCE_PLAN_SCHEMA_HASH,
  ASTRA_SOURCE_PLAN_ID,
} from "./manifest.ts";

export const ASTRA_SOURCE_PLAN_SCHEMA_HASH = asSchemaRef(hashDomain(
  "aloha/astra-multitoken/source-plan-schema/v1",
  ASTRA_SOURCE_PLAN_ID,
));

/** Static source authority: the 50-block plan only nominates recent evidence. */
export const ASTRA_SOURCE_PLAN = defineFamilySourcePlan({
  sourcePlanId: ASTRA_SOURCE_PLAN_ID,
  completeness: "nomination-only",
  historyStartBlock: null,
  schemaHash: ASTRA_SOURCE_PLAN_SCHEMA_HASH,
});

/** Complete event denominator: every Astra Change log through the cutoff. */
export const ASTRA_HISTORY_SOURCE_PLAN = defineFamilySourcePlan({
  sourcePlanId: ASTRA_HISTORY_SOURCE_PLAN_ID,
  completeness: "contiguous-history",
  historyStartBlock: "0",
  schemaHash: asSchemaRef(ASTRA_HISTORY_SOURCE_PLAN_SCHEMA_HASH),
});
