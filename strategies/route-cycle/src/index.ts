import { asOwnerRef, asSchemaRef } from "../../../packages/capability-contracts/src/index.ts";
import { deepFreeze, hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import {
  defineStrategy,
  strategyPlanningTemplateHash,
  type StrategyPlanningProblemIssuerV1,
  type StrategyAuthoringDefinitionV1,
} from "../../../packages/strategy-sdk/src/index.ts";

const hash = (domain: string, payload: unknown): Hash => hashDomain(domain, payload);
const schema = (id: string): Hash => hash("aloha/strategy-route-cycle/schema/v1", { id });

export const ROUTE_CYCLE_STRATEGY: StrategyAuthoringDefinitionV1 = defineStrategy({
  strategyId: "route-cycle",
  version: "1.0.0",
  pluginCodeHash: hash("aloha/strategy-route-cycle/plugin/v1", { version: "1.0.0" }),
  requiredCapabilityPredicates: [],
  planningProblemIssuer: {
    modulePath: "strategies/route-cycle/src/index.ts",
    exportName: "ROUTE_CYCLE_PLANNING_PROBLEM_ISSUER",
    ownerRef: asOwnerRef(hash("aloha/strategy-route-cycle/planning-owner/v1", { version: "1.0.0" })),
    implementationHash: hash("aloha/strategy-route-cycle/planning-implementation/v1", { version: "1.0.0" }),
  },
  constraintSchemaRefs: [asSchemaRef(schema("closed-loop"))],
  factContractRefs: [asSchemaRef(schema("route-facts"))],
  planningTemplate: {
    kind: "closed-loop-template",
    entryAssetPolicy: "any-graph-asset",
    minLegs: "2",
    maxLegs: "4",
    candidateLimit: "4096",
    edgeReuse: "forbid",
    constraintSchemaRefs: [asSchemaRef(schema("closed-loop"))],
  },
  modulePath: "strategies/route-cycle/src/index.ts",
  exportName: "ROUTE_CYCLE_STRATEGY",
});

/**
 * Runtime Strategy semantics.  It receives only the generated template,
 * generic Graph edges and an opaque trigger scope; asset identities are never
 * copied from a fixture or deployment parameter.
 */
export const ROUTE_CYCLE_PLANNING_PROBLEM_ISSUER: StrategyPlanningProblemIssuerV1 = deepFreeze({
  strategyId: ROUTE_CYCLE_STRATEGY.strategyId,
  version: ROUTE_CYCLE_STRATEGY.version,
  planningTemplateHash: strategyPlanningTemplateHash(ROUTE_CYCLE_STRATEGY.planningTemplate),
  issue({ template, trigger }) {
    return deepFreeze({
      kind: "closed-loop" as const,
      objectiveRef: trigger.objectiveRef,
      entryAssetRef: trigger.entryAssetRef,
      returnAssetRef: trigger.returnAssetRef,
      minLegs: template.minLegs,
      maxLegs: template.maxLegs,
      candidateLimit: template.candidateLimit,
      edgeReuse: template.edgeReuse,
      requiredAnchorEdgeIds: trigger.affectedEdgeIds,
      constraintSchemaRefs: template.constraintSchemaRefs,
    });
  },
});
