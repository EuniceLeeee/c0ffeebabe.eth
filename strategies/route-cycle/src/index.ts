import {
  asCapabilityId,
  asCapabilityVersion,
  asOwnerRef,
  asSchemaRef,
} from "../../../packages/capability-contracts/src/index.ts";
import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import {
  defineStrategy,
  type StrategyAuthoringDefinitionV1,
} from "../../../packages/strategy-sdk/src/index.ts";

const hash = (domain: string, payload: unknown): Hash => hashDomain(domain, payload);
const schema = (id: string): Hash => hash("aloha/strategy-route-cycle/schema/v1", { id });

const baseAssetRef = hash("aloha/strategy-route-cycle/asset/v1", { role: "entry" });
const quoteAssetRef = hash("aloha/strategy-route-cycle/asset/v1", { role: "intermediate" });
const edgeSelectionA = hash("aloha/strategy-route-cycle/selection/v1", { ordinal: "0" });
const edgeSelectionB = hash("aloha/strategy-route-cycle/selection/v1", { ordinal: "1" });
const graphTransitionRef = asCapabilityId("graph-transition");
const sourceValuationRef = asCapabilityId("source-valuation");

const predicate = (capabilityId: typeof graphTransitionRef | typeof sourceValuationRef) => ({
  capabilityId,
  minimumVersion: asCapabilityVersion("1.0.0"),
  schemaRefs: [asSchemaRef(schema(capabilityId))],
});

export const ROUTE_CYCLE_STRATEGY: StrategyAuthoringDefinitionV1 = defineStrategy({
  strategyId: "route-cycle",
  version: "1.0.0",
  pluginCodeHash: hash("aloha/strategy-route-cycle/plugin/v1", { version: "1.0.0" }),
  requiredCapabilityPredicates: [predicate(graphTransitionRef), predicate(sourceValuationRef)],
  planningProblemIssuer: {
    modulePath: "strategies/route-cycle/src/index.ts",
    exportName: "ROUTE_CYCLE_STRATEGY",
    ownerRef: asOwnerRef(hash("aloha/strategy-route-cycle/planning-owner/v1", { version: "1.0.0" })),
    implementationHash: hash("aloha/strategy-route-cycle/planning-implementation/v1", { version: "1.0.0" }),
  },
  constraintSchemaRefs: [asSchemaRef(schema("closed-loop"))],
  factContractRefs: [asSchemaRef(schema("route-facts"))],
  loopIntent: {
    kind: "closed-loop",
    entryAssetRef: baseAssetRef,
    returnAssetRef: baseAssetRef,
    objectiveRef: hash("aloha/strategy-route-cycle/objective/v1", { kind: "conservative-surplus" }),
    constraintSchemaRefs: [asSchemaRef(schema("closed-loop"))],
    legs: [
      {
        fromAssetRef: baseAssetRef,
        toAssetRef: quoteAssetRef,
        selectionRef: edgeSelectionA,
        requiredCapabilityPredicates: [predicate(graphTransitionRef)],
      },
      {
        fromAssetRef: quoteAssetRef,
        toAssetRef: baseAssetRef,
        selectionRef: edgeSelectionB,
        requiredCapabilityPredicates: [predicate(graphTransitionRef)],
      },
    ],
  },
  modulePath: "strategies/route-cycle/src/index.ts",
  exportName: "ROUTE_CYCLE_STRATEGY",
});

/** Build-time definition only; qualified refs enter through catalog generation. */
