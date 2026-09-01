import { hashDomain, type Hash } from "../../canonical-codec/src/index.ts";
import {
  sealGeneratedStrategyRuntimeDescriptor,
  strategyPlanningTemplateHash,
  type GeneratedStrategyRuntimeEntryV1,
  type IssuedStrategyPlanningProblemV1,
  type StrategyGraphEdgeV1,
} from "../../strategy-composition/src/index.ts";
import {
  createGeneratedStrategyRuntimeFactory,
  issueGeneratedUnsignedDryRunStrategyRuntimeAuthorityCapability,
} from "../../strategy-composition/src/internal/generated-runtime-composition.ts";
import { issueStrategyPlanningTriggerCapabilityV1 } from "../../strategy-composition/src/internal/trigger-owner.ts";
import { compileStrategy } from "../../strategy-sdk/src/index.ts";
import {
  createUnsignedDryRunRuntimeAuthorityDescriptorV1,
  projectRuntimeAuthorityDescriptorV1,
  type UnsignedDryRunRuntimeAuthorityDescriptorV1,
} from "../../runtime-authority/src/index.ts";
import {
  ROUTE_CYCLE_PLANNING_PROBLEM_ISSUER,
  ROUTE_CYCLE_STRATEGY,
} from "../../../strategies/route-cycle/src/index.ts";

const h = (domain: string, value: unknown): Hash => hashDomain(domain, value);

export function issueRouteCyclePlanningProblem(input: {
  readonly generationId: string;
  readonly definitionCatalogRoot: Hash;
  readonly graphRoot: Hash;
  readonly edges: readonly StrategyGraphEdgeV1[];
  readonly readyRecordHash?: Hash;
  readonly sourceHash?: Hash;
  readonly correlationId?: Hash;
  readonly objectiveRef?: Hash;
  readonly entryAssetRef?: Hash;
  readonly proposedCapabilitySetRoot?: Hash;
  readonly runtimeAuthority?: UnsignedDryRunRuntimeAuthorityDescriptorV1;
  readonly lane?: "blockscan" | "backrun";
  readonly triggerRef?: Hash;
  readonly affectedEdgeIds?: readonly Hash[];
}): IssuedStrategyPlanningProblemV1 {
  const catalogEntry = compileStrategy(ROUTE_CYCLE_STRATEGY, []).entry;
  const issuerClosureRoot = h("test/search-pipeline/issuer-closure/v1", "route-cycle");
  const entryBase = {
    catalogEntry,
    issuerModulePath: ROUTE_CYCLE_STRATEGY.planningProblemIssuer.modulePath,
    issuerExportName: ROUTE_CYCLE_STRATEGY.planningProblemIssuer.exportName,
    issuerClosureRoot,
    planningTemplateHash: strategyPlanningTemplateHash(catalogEntry.planningTemplate),
  };
  const entry: GeneratedStrategyRuntimeEntryV1 = Object.freeze({
    ...entryBase,
    leafDigest: h("aloha/generated-strategy-runtime-leaf/v1", {
      strategyId: catalogEntry.strategyId,
      strategyDefinitionHash: catalogEntry.strategyDefinitionHash,
      definitionCatalogLeafDigest: catalogEntry.definitionCatalogLeafDigest,
      issuerModulePath: entryBase.issuerModulePath,
      issuerExportName: entryBase.issuerExportName,
      issuerClosureRoot,
      planningTemplateHash: entryBase.planningTemplateHash,
    }),
  });
  const descriptor = sealGeneratedStrategyRuntimeDescriptor({
    schemaVersion: 1,
    releaseIntentRoot: h("test/search-pipeline/release/v1", 1),
    definitionCatalogRoot: input.definitionCatalogRoot,
    proposedCapabilitySetRoot: input.proposedCapabilitySetRoot ?? h("test/search-pipeline/capabilities/v1", []),
    strategies: [entry],
  });
  const readyRecordHash = input.readyRecordHash ?? h("test/search-pipeline/ready", 1);
  const sourceHash = input.sourceHash ?? h("test/search-pipeline/block", 1);
  const correlationId = input.correlationId ?? h("test/search-pipeline/correlation", 1);
  const entryAssetRef = input.entryAssetRef ?? input.edges[0]?.inputAssetPorts[0]?.assetRef ?? h("test/search-pipeline/asset", "empty");
  const runtimeAuthorityDescriptor = input.runtimeAuthority ?? createUnsignedDryRunRuntimeAuthorityDescriptorV1({
    authorityClass: "dry-run",
    runtimeBindingId: h("test/search-pipeline/runtime-binding/v1", 1),
    implementationCommit: "a".repeat(40),
  });
  const runtimeAuthority = projectRuntimeAuthorityDescriptorV1(runtimeAuthorityDescriptor);
  const factory = createGeneratedStrategyRuntimeFactory({
    descriptor,
    issuers: [ROUTE_CYCLE_PLANNING_PROBLEM_ISSUER],
  });
  const composition = factory(issueGeneratedUnsignedDryRunStrategyRuntimeAuthorityCapability({
    factory,
    declaredCapabilitySetRoot: descriptor.proposedCapabilitySetRoot,
    runtimeAuthority: runtimeAuthorityDescriptor,
    assertCurrent: () => {},
  }));
  return composition.issuePlanningProblems({
    binding: {
      generationId: input.generationId,
      definitionCatalogRoot: input.definitionCatalogRoot,
      graphRoot: input.graphRoot,
      readyRecordHash,
      runtimeAuthority,
      runtimeMembershipHash: composition.runtimeMembershipHash,
      sourceHash,
    },
    edges: Object.freeze(input.edges.map(edge => Object.freeze({
      edgeId: edge.edgeId,
      opaqueTransitionRef: edge.opaqueTransitionRef,
      inputAssetPorts: Object.freeze(edge.inputAssetPorts.map(port => Object.freeze({
        assetRef: port.assetRef,
        portRef: port.portRef,
        ordinal: port.ordinal,
      }))),
      outputAssetPorts: Object.freeze(edge.outputAssetPorts.map(port => Object.freeze({
        assetRef: port.assetRef,
        portRef: port.portRef,
        ordinal: port.ordinal,
      }))),
    }))),
    trigger: issueStrategyPlanningTriggerCapabilityV1({
      binding: {
        generationId: input.generationId,
        definitionCatalogRoot: input.definitionCatalogRoot,
        graphRoot: input.graphRoot,
        readyRecordHash,
        runtimeAuthority,
        runtimeMembershipHash: composition.runtimeMembershipHash,
        sourceHash,
      },
      lane: input.lane ?? "blockscan",
      triggerRef: input.triggerRef ?? h("test/search-pipeline/trigger/v1", input.graphRoot),
      objectiveRef: input.objectiveRef ?? h("test/search-pipeline/objective/v1", "default"),
      entryAssetRef,
      returnAssetRef: entryAssetRef,
      affectedEdgeIds: input.affectedEdgeIds ?? [],
      correlationId,
    }),
  })[0]!;
}
