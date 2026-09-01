import { deepFreeze, hashDomain, type Hash } from "../../../canonical-codec/src/index.ts";
import { erc20AssetPortBindingV1 } from "../../../asset-ref/src/index.ts";
import type {
  GraphLeaseBindingV1,
  GraphRouteHandle,
  IssuedRouteHandle,
  RuntimeGraphEdgeV1,
} from "../../../graph/src/index.ts";
import {
  CurrentSourceRpcReadTransport,
  type CurrentSourceRpcLogicalScopeFactsV1,
  type CurrentSourceRpcPhysicalFactsV1,
} from "../../../current-source-rpc/src/index.ts";
import {
  routeBindingHash,
  runSearchPipeline,
  sealExecutionProgram,
  sealUnsignedDryRunReceipt,
  type CurrentSourceSessionV1,
  type FinalSimulationPortV1,
  type ExecutionProgramSixStepEvidenceV1,
  type FinalSimulationSixStepEvidenceV1,
  type RoutePipelineInputV1,
  type RoutePipelinePortsV1,
  type RoutePipelineOutcomeV1,
  type SourceViewV1,
} from "../../../search-pipeline/src/index.ts";
import { createContractEconomicSafetyService } from "../../../search-pipeline/test/economic-safety-fixture.ts";
import type { EconomicSafetyEvidenceAuthorityExpectationV1 } from "../../../economics-safety/src/index.ts";
import { createProductionSixStepTailFixture } from "../../../search-pipeline/test/production-six-step-fixture.ts";
import { issueRouteCyclePlanningProblem } from "../../../search-pipeline/test/issued-strategy.ts";
import {
  sealGeneratedStrategyRuntimeDescriptor,
  strategyPlanningTemplateHash,
  type GeneratedStrategyRuntimeEntryV1,
  type StrategyGraphEdgeV1,
  type StrategyPlanningProblemV1,
} from "../../../strategy-composition/src/index.ts";
import {
  createGeneratedStrategyRuntimeFactory,
  issueGeneratedStrategyRuntimeAuthorityCapability,
} from "../../../strategy-composition/src/internal/generated-runtime-composition.ts";
import { issueStrategyPlanningTriggerCapabilityV1 } from "../../../strategy-composition/src/internal/trigger-owner.ts";
import { compileStrategy, defineStrategy, type StrategyPlanningProblemIssuerV1 } from "../../../strategy-sdk/src/index.ts";
import {
  createSignedReleaseRuntimeAuthorityDescriptorV1,
  projectRuntimeAuthorityDescriptorV1,
  type SignedReleaseRuntimeAuthorityDescriptorV1,
} from "../../../runtime-authority/src/index.ts";
import { ROUTE_CYCLE_STRATEGY } from "../../../../strategies/route-cycle/src/index.ts";
import type {
  CanonicalHead,
  ProducerBoundTriggerV1,
  ProducerLaneRunDraftV1,
  ProducerLaneRunInputV1,
  ProducerSessionV1,
} from "../../src/index.ts";
import {
  issueProducerBoundTriggerV1,
  readIssuedProducerBackrunIntakeV1,
  readIssuedProducerBoundTriggerV1,
} from "../../src/internal/owners.ts";

const h = (domain: string, value: unknown): Hash => hashDomain(`test/producer/${domain}`, value);
const noRejectionAuthority = Object.freeze({ read: () => { throw new TypeError("rejection-not-issued"); } });
const TRUNCATED_STRATEGY = defineStrategy({
  ...ROUTE_CYCLE_STRATEGY,
  strategyId: "producer-truncated-route-cycle",
  pluginCodeHash: h("truncated-strategy", "plugin"),
  planningProblemIssuer: {
    ...ROUTE_CYCLE_STRATEGY.planningProblemIssuer,
    modulePath: "packages/producer/test/fixtures/search-terminal.ts",
    exportName: "TRUNCATED_PLANNING_PROBLEM_ISSUER",
    implementationHash: h("truncated-strategy", "issuer"),
  },
  planningTemplate: { ...ROUTE_CYCLE_STRATEGY.planningTemplate, candidateLimit: "4" },
  modulePath: "packages/producer/test/fixtures/search-terminal.ts",
  exportName: "TRUNCATED_STRATEGY",
});
const TRUNCATED_PLANNING_PROBLEM_ISSUER: StrategyPlanningProblemIssuerV1 = deepFreeze({
  strategyId: TRUNCATED_STRATEGY.strategyId,
  version: TRUNCATED_STRATEGY.version,
  planningTemplateHash: strategyPlanningTemplateHash(TRUNCATED_STRATEGY.planningTemplate),
  issue: ({ template, trigger }) => deepFreeze({
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
  }),
});

function issueTruncatedPlanningProblem(input: {
  readonly generationId: string;
  readonly definitionCatalogRoot: Hash;
  readonly graphRoot: Hash;
  readonly edges: readonly StrategyGraphEdgeV1[];
  readonly releaseProvenanceHash: Hash;
  readonly readyRecordHash: Hash;
  readonly sourceHash: Hash;
  readonly correlationId: Hash;
  readonly objectiveRef: Hash;
  readonly entryAssetRef: Hash;
  readonly lane: "blockscan" | "backrun";
  readonly triggerRef: Hash;
  readonly affectedEdgeIds: readonly Hash[];
  readonly runtimeAuthority: SignedReleaseRuntimeAuthorityDescriptorV1;
}): StrategyPlanningProblemV1 {
  const entryAssetRef = input.entryAssetRef;
  const catalogEntry = compileStrategy(TRUNCATED_STRATEGY, []).entry;
  const issuerClosureRoot = h("truncated-strategy", "closure");
  const entryBase = {
    catalogEntry,
    issuerModulePath: TRUNCATED_STRATEGY.planningProblemIssuer.modulePath,
    issuerExportName: TRUNCATED_STRATEGY.planningProblemIssuer.exportName,
    issuerClosureRoot,
    planningTemplateHash: strategyPlanningTemplateHash(catalogEntry.planningTemplate),
  };
  const entry: GeneratedStrategyRuntimeEntryV1 = Object.freeze({
    ...entryBase,
    leafDigest: hashDomain("aloha/generated-strategy-runtime-leaf/v1", {
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
    releaseIntentRoot: h("truncated-strategy", "release"),
    definitionCatalogRoot: input.definitionCatalogRoot,
    proposedCapabilitySetRoot: h("truncated-strategy", "capabilities"),
    strategies: [entry],
  });
  const factory = createGeneratedStrategyRuntimeFactory({
    descriptor,
    issuers: [TRUNCATED_PLANNING_PROBLEM_ISSUER],
  });
  const capability = issueGeneratedStrategyRuntimeAuthorityCapability({
    factory,
    qualifiedCapabilityRefsRoot: descriptor.proposedCapabilitySetRoot,
    runtimeAuthority: input.runtimeAuthority,
    assertCurrent: () => {},
  });
  return factory(capability).issuePlanningProblems({
    binding: {
      generationId: input.generationId,
      definitionCatalogRoot: input.definitionCatalogRoot,
      graphRoot: input.graphRoot,
      readyRecordHash: input.readyRecordHash,
      releaseProvenanceHash: input.releaseProvenanceHash,
      runtimeAuthority: projectRuntimeAuthorityDescriptorV1(input.runtimeAuthority),
      sourceHash: input.sourceHash,
    },
    edges: input.edges,
    trigger: issueStrategyPlanningTriggerCapabilityV1({
      binding: {
        generationId: input.generationId,
        definitionCatalogRoot: input.definitionCatalogRoot,
        graphRoot: input.graphRoot,
        readyRecordHash: input.readyRecordHash,
        releaseProvenanceHash: input.releaseProvenanceHash,
        runtimeAuthority: projectRuntimeAuthorityDescriptorV1(input.runtimeAuthority),
        sourceHash: input.sourceHash,
      },
      lane: input.lane,
      triggerRef: input.triggerRef,
      objectiveRef: input.objectiveRef,
      entryAssetRef,
      returnAssetRef: entryAssetRef,
      affectedEdgeIds: input.affectedEdgeIds,
      correlationId: input.correlationId,
    }),
  })[0]!;
}

export type SearchTerminalMode =
  | "no-candidate"
  | "policy-rejected"
  | "selected-retryable"
  | "selected-invalid"
  | "selected-qualified-rejected"
  | "unsigned-passed"
  | "unsigned-with-earlier-retryable"
  | "truncated";

type TerminalFixture = Readonly<{
  session: ProducerSessionV1;
  logicalFacts: (lane: "blockscan" | "backrun", correlationId: Hash) => CurrentSourceRpcLogicalScopeFactsV1;
  closePhysicalFacts: () => Promise<CurrentSourceRpcPhysicalFactsV1>;
  run: (
    request: ProducerLaneRunInputV1<ProducerSessionV1>,
    finalSimulation?: FinalSimulationPortV1<unknown>,
  ) => Promise<Readonly<{
    readonly draft: Extract<ProducerLaneRunDraftV1, { readonly kind: "terminal" }>;
    readonly outcome: RoutePipelineOutcomeV1<unknown>;
  }>>;
}>;

function graphEdges(loopCount: number): RuntimeGraphEdgeV1[] {
  const values: RuntimeGraphEdgeV1[] = [];
  const commonEntryAsset = erc20AssetPortBindingV1("1", `0x${h("asset-a", "shared").slice(-40)}`);
  for (let index = 0; index < loopCount; index += 1) {
    const assetA = commonEntryAsset;
    const assetB = erc20AssetPortBindingV1("1", `0x${h("asset-b", index).slice(-40)}`);
    for (const [direction, inputAsset, outputAsset] of [
      ["forward", assetA, assetB],
      ["reverse", assetB, assetA],
    ] as const) {
      const edgeId = h("edge", { index, direction });
      values.push(Object.freeze({
        edgeId,
        inputAssetPorts: Object.freeze([{ ...inputAsset, portRef: h("input-port", edgeId), ordinal: "0" }]),
        outputAssetPorts: Object.freeze([{ ...outputAsset, portRef: h("output-port", edgeId), ordinal: "0" }]),
        opaqueTransitionRef: h("transition", edgeId),
        constraintRefs: Object.freeze([h("constraint", edgeId)]),
        owningFamilyId: "producer-terminal-fixture",
        owningFamilyDefinitionHash: h("family-definition", 1),
        owningInstanceKey: `fixture-${index}-${direction}`,
        instancePublicationHash: h("publication", edgeId),
        staticProjectionHash: h("static-projection", edgeId),
        projectionHash: h("projection", edgeId),
        rehydrationRef: Object.freeze({
          familyDefinitionHash: h("family-definition", 1),
          instanceKey: `fixture-${index}-${direction}`,
          instancePublicationHash: h("publication", edgeId),
          staticProjectionMemoHash: h("projection-memo", edgeId),
          requestedArtifactDependencyRoot: h("dependencies", edgeId),
        }),
        routeHandle: Object.freeze(Object.create(null)) as GraphRouteHandle,
      }));
    }
  }
  return values.sort((left, right) => left.edgeId.localeCompare(right.edgeId));
}

function strategyGraphEdges(values: readonly RuntimeGraphEdgeV1[]): readonly StrategyGraphEdgeV1[] {
  return Object.freeze(values.map(edge => Object.freeze({
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
  })));
}

function binding(head: CanonicalHead, generationId: string, graphRoot: Hash): GraphLeaseBindingV1 {
  const cutoff = Object.freeze({
    chainId: head.chainId,
    number: (BigInt(head.number) - 1n).toString(),
    hash: h("cutoff", head),
    stateRoot: h("cutoff-state", head),
  });
  const releaseProvenanceHash = h("release", generationId);
  const runtimeAuthority = projectRuntimeAuthorityDescriptorV1(
    createSignedReleaseRuntimeAuthorityDescriptorV1({
      authorityClass: "signed-release",
      runtimeBindingId: h("runtime-binding", generationId),
      releaseProvenanceHash,
      implementationCommit: "a".repeat(40),
    }),
  );
  return Object.freeze({
    generationId,
    readyRecordHash: h("ready", generationId),
    generationRefreshPolicyHash: h("refresh-policy", generationId),
    cutoff,
    definitionCatalogRoot: h("definitions", generationId),
    instanceCatalogRoot: h("instances", generationId),
    graphRoot,
    runtimeAuthority,
    releaseProvenanceHash,
    candidatePartitionProofStorageHash: h("partition-proof", generationId),
    nominationClosureRoot: h("nomination-closure", generationId),
    nominationClosureStorageHash: h("nomination-storage", generationId),
  });
}

export function createSearchTerminalFixture(input: {
  readonly head: CanonicalHead;
  readonly generationId: string;
  readonly mode: SearchTerminalMode;
  /** Test-only exact runtime-release join; defaults preserve existing fixtures. */
  readonly releaseProvenanceHash?: Hash;
  /** Test-only exact neutral authority join; production owners derive it. */
  readonly runtimeAuthority?: SignedReleaseRuntimeAuthorityDescriptorV1;
  /** Test-only generated composition join; defaults preserve existing fixtures. */
  readonly proposedCapabilitySetRoot?: Hash;
  /** Test-only release-owned binding for terminal authority joins. */
  readonly economicSafetyAuthority?: EconomicSafetyEvidenceAuthorityExpectationV1;
}): TerminalFixture {
  const loopCount = input.mode === "no-candidate" ? 0 : input.mode === "truncated" ? 5 : input.mode === "unsigned-with-earlier-retryable" ? 2 : 1;
  const edges = graphEdges(loopCount);
  const sharedLoopEntryAssetRef = erc20AssetPortBindingV1("1", `0x${h("asset-a", "shared").slice(-40)}`).assetRef;
  const graphRoot = h("graph", edges.map(edge => edge.edgeId));
  const leaseBinding = binding(input.head, input.generationId, graphRoot);
  const runtimeAuthority = input.runtimeAuthority ?? createSignedReleaseRuntimeAuthorityDescriptorV1({
    authorityClass: "signed-release",
    runtimeBindingId: h("runtime-binding", input.generationId),
    releaseProvenanceHash: input.releaseProvenanceHash ?? leaseBinding.releaseProvenanceHash!,
    implementationCommit: "a".repeat(40),
  });
  const releaseBoundLeaseBinding = input.releaseProvenanceHash === undefined
    ? leaseBinding
    : Object.freeze({
        ...leaseBinding,
        runtimeAuthority: projectRuntimeAuthorityDescriptorV1(runtimeAuthority),
        releaseProvenanceHash: input.releaseProvenanceHash,
      });
  const issuedHandles = new Map(edges.map(edge => [edge.edgeId, Object.freeze({ opaque: Object.freeze(Object.create(null)) }) as IssuedRouteHandle]));
  const lease = {
    binding: releaseBoundLeaseBinding,
    edges: Object.freeze(edges),
    assertActive: async () => {},
    resolveRouteHandle: async (edgeId: Hash, handle: GraphRouteHandle) => {
      const edge = edges.find(value => value.edgeId === edgeId);
      if (edge === undefined || edge.routeHandle !== handle) throw new TypeError("fixture Graph handle mismatch");
      return issuedHandles.get(edgeId)!;
    },
    release: () => {},
    leaseId: h("lease", input.generationId),
    released: false,
  };
  const session: ProducerSessionV1 = {
    sessionId: h("session", input.generationId),
    source: input.head,
    head: input.head,
    lease,
    graphView: lease,
    generation: releaseBoundLeaseBinding,
    generationId: input.generationId,
    closed: false,
    async assertCurrent() {},
    async close() {},
  } as unknown as ProducerSessionV1;
  const source = Object.freeze({
    chainId: input.head.chainId,
    number: input.head.number,
    hash: input.head.hash,
    stateRoot: input.head.stateRoot,
  });
  const currentSourceTransport = new CurrentSourceRpcReadTransport({
    endpoint: "http://127.0.0.1:1",
    currentSource: Object.freeze({ source, assertCurrent: () => {} }),
  });
  const logicalFacts = (lane: "blockscan" | "backrun", correlationId: Hash): CurrentSourceRpcLogicalScopeFactsV1 => {
    const scope = currentSourceTransport.issueLogicalReadScope({ lane, correlationId });
    return currentSourceTransport.closeLogicalReadScope(scope);
  };
  const executionEvidence = new WeakMap<object, ExecutionProgramSixStepEvidenceV1>();
  const finalEvidence = new WeakMap<object, FinalSimulationSixStepEvidenceV1>();
  const executionEvidenceAuthority = Object.freeze({
    read(capability: object) {
      const value = executionEvidence.get(capability);
      if (value === undefined) throw new TypeError("execution evidence was not issued");
      return value;
    },
  });
  const finalEvidenceAuthority = Object.freeze({
    read(capability: object) {
      const value = finalEvidence.get(capability);
      if (value === undefined) throw new TypeError("final-simulation evidence was not issued");
      return value;
    },
  });

  return Object.freeze({
    session,
    logicalFacts,
    closePhysicalFacts: () => currentSourceTransport.closePhysicalFacts(),
    async run(request, finalSimulation) {
      const intake = request.kind === "backrun" ? readIssuedProducerBackrunIntakeV1(request.input) : null;
      const ingress = request.kind === "blockscan"
        ? (request.input as { readonly trigger: unknown }).trigger
        : intake?.kind === "pending-transaction"
          ? intake.trigger
          : null;
      if (ingress === null) throw new TypeError("terminal fixture requires a transaction trigger");
      const trigger = issueProducerBoundTriggerV1({ ingress: ingress as never, laneInput: request });
      const triggerFacts = readIssuedProducerBoundTriggerV1(trigger);
      const sourceView: SourceViewV1 = source;
      const objectiveEntryAssetRef = edges.length === 0
        ? h("objective-numeraire", input.generationId)
        : sharedLoopEntryAssetRef;
      const objectivePayload = Object.freeze({
        numeraireAssetRef: objectiveEntryAssetRef,
        minNetGain: "1",
        maxGas: "1000000",
        maxValueAtRisk: "1000000000000000000",
      });
      const objectiveRef = hashDomain("aloha/search-objective/v1", objectivePayload);
      const planningProblem = (input.mode === "truncated" ? issueTruncatedPlanningProblem : issueRouteCyclePlanningProblem)({
        generationId: releaseBoundLeaseBinding.generationId,
        definitionCatalogRoot: releaseBoundLeaseBinding.definitionCatalogRoot,
        graphRoot: releaseBoundLeaseBinding.graphRoot,
        edges: strategyGraphEdges(edges),
        releaseProvenanceHash: releaseBoundLeaseBinding.releaseProvenanceHash!,
        readyRecordHash: releaseBoundLeaseBinding.readyRecordHash,
        sourceHash: input.head.hash,
        correlationId: triggerFacts.correlationId,
        objectiveRef,
        entryAssetRef: objectiveEntryAssetRef,
        proposedCapabilitySetRoot: input.proposedCapabilitySetRoot,
        lane: triggerFacts.lane,
        triggerRef: triggerFacts.triggerRef,
        affectedEdgeIds: triggerFacts.affectedEdgeIds,
        runtimeAuthority,
      });
      const currentSource: CurrentSourceSessionV1 = Object.freeze({
        sessionId: h("source-session", request.revision),
        source: sourceView,
        assertCurrent: () => {},
      });
      let selectedOrdinal = 0;
      const ports: RoutePipelinePortsV1<object, object, object, unknown> = {
        sixStepArtifacts: createProductionSixStepTailFixture([]),
        route: {
          resolve: ({ candidate }) => {
            const legs = Object.freeze(candidate.legs.map(leg => ({
              edgeId: leg.edgeId,
              ownerRef: h("owner", leg.edgeId),
              issuedHandle: issuedHandles.get(leg.edgeId)!,
            })));
            return Object.freeze({ routeHash: h("route", candidate.candidateId), legs, routeBindingHash: routeBindingHash(legs) });
          },
        },
        coarse: {
          assess: () => null,
        },
        planner: {
          rejectionAuthority: noRejectionAuthority,
          plan: ({ route }) => ({ kind: "planned", routeHash: route.routeHash, source, plan: Object.freeze({}), planHash: h("plan", route.routeHash) }),
        },
        exact: {
          rejectionAuthority: noRejectionAuthority,
          evaluate: ({ route }) => ({ kind: "verified", routeHash: route.routeHash, source, exact: Object.freeze({}), exactHash: h("exact", route.routeHash) }),
        },
        executionProgram: {
          rejectionAuthority: noRejectionAuthority,
          sixStepEvidenceAuthority: executionEvidenceAuthority,
          compile: ({ route, exactHash, correlationId }) => {
            const obligationRef = h("obligation", route.routeHash);
            const issuerRef = h("issuer", route.routeHash);
            const program = sealExecutionProgram({
              kind: "execution-program",
              generationId: releaseBoundLeaseBinding.generationId,
              source,
              routeHash: route.routeHash,
              programBytes: "0x0102",
              payloadHash: h("payload", route.routeHash),
              issuerRef,
              obligationRoot: hashDomain("aloha/search-runtime-obligation-root/v1", [obligationRef]),
            });
            const facts = Object.freeze({
              kind: "aloha.search-runtime.execution-program-owner-facts-v1",
              callerMode: "top-level",
              preCalls: Object.freeze([]),
              observationPairs: Object.freeze([]),
              observeLogs: false,
              callSequence: Object.freeze([]),
              actionOwners: Object.freeze([Object.freeze({
                familyDefinitionHash: h("action-family", route.routeHash),
                routeBindingHash: route.routeBindingHash,
                actionOwnerId: "producer-terminal-fixture-action-owner",
                actionOwnerRef: issuerRef,
                actionHash: h("action", route.routeHash),
                actionArtifactHash: h("action-artifact", route.routeHash),
                exactEvaluationHash: exactHash,
                payload: Object.freeze({ obligationRoot: obligationRef }),
                payloadHash: h("action-payload", route.routeHash),
                inputs: Object.freeze([]),
                outputs: Object.freeze([]),
                obligationRoot: obligationRef,
              })]),
              obligationRoot: program.obligationRoot,
              declaredObligations: Object.freeze([{ obligationRef, ownerRef: issuerRef, policy: "must-satisfy" as const }]),
            });
            const body = {
              schemaVersion: 1 as const,
              kind: "aloha.execution-program-six-step-evidence-v1" as const,
              correlationId,
              generationId: program.generationId,
              source,
              routeHash: route.routeHash,
              exactHash,
              programHash: program.programHash,
              facts,
            };
            const capability = Object.freeze(Object.create(null));
            executionEvidence.set(capability, Object.freeze({
              ...body,
              evidenceRoot: hashDomain("aloha/execution-program-six-step-evidence/v1", body),
            }));
            return { kind: "compiled" as const, program, sixStepEvidence: capability };
          },
        },
        finalSimulation: finalSimulation ?? {
          rejectionAuthority: noRejectionAuthority,
          sixStepEvidenceAuthority: finalEvidenceAuthority,
          simulate: ({ program, correlationId }) => {
            selectedOrdinal += 1;
            if (input.mode === "selected-retryable" || (input.mode === "unsigned-with-earlier-retryable" && selectedOrdinal === 1)) {
              return { kind: "retryable", stage: "final-sim", code: "fixture-resource" };
            }
            if (input.mode === "selected-invalid") {
              return { kind: "chainProvenRejected", stage: "final-sim", code: "fixture-structural-reject", evidenceHash: h("structural-reject", program.programHash) } as never;
            }
            const receiptHash = h("simulation", program.programHash);
            const facts = Object.freeze({
              kind: "producer-contract-final-owner",
              workerReceipt: Object.freeze({ executionReceiptHash: h("execution-receipt", program.programHash) }),
            });
            const body = {
              schemaVersion: 1 as const,
              kind: "aloha.final-simulation-six-step-evidence-v1" as const,
              correlationId,
              generationId: releaseBoundLeaseBinding.generationId,
              source,
              programHash: program.programHash,
              finalSimulationReceiptHash: receiptHash,
              facts,
            };
            const capability = Object.freeze(Object.create(null));
            finalEvidence.set(capability, Object.freeze({
              ...body,
              evidenceRoot: hashDomain("aloha/final-simulation-six-step-evidence/v1", body),
            }));
            return {
              kind: "passed",
              receipt: {
                kind: "final-simulation-passed",
                generationId: releaseBoundLeaseBinding.generationId,
                source,
                programHash: program.programHash,
                simulation: Object.freeze({}),
                effectsHash: h("effects", program.programHash),
                receiptHash,
              },
              sixStepEvidence: capability,
            };
          },
        },
        economicSafety: createContractEconomicSafetyService(
          releaseBoundLeaseBinding.releaseProvenanceHash,
          value => h("economic-safety", value),
          input.economicSafetyAuthority,
        ),
        dryRun: { issue: value => sealUnsignedDryRunReceipt(value) },
      };
      const pipelineInput: RoutePipelineInputV1 = {
        lease: lease as never,
        planningProblem,
        strategyCompositionRoot: planningProblem.strategyCompositionRoot,
        objective: { objectiveRef, payload: objectivePayload },
        currentSource,
        correlationId: triggerFacts.correlationId,
        deadlineAtMs: performance.now() + 10_000,
        callerId: "producer-terminal-fixture",
        admission: input.mode === "policy-rejected" || input.mode === "truncated"
          ? { topK: 0, boundedUnrankedBudget: 0 }
          : { topK: 0, boundedUnrankedBudget: input.mode === "unsigned-with-earlier-retryable" ? 2 : 1 },
        signal: request.signal,
      };
      const outcome = await runSearchPipeline(ports, pipelineInput);
      if (outcome.kind !== "route-set-terminal" && outcome.kind !== "dry-run") {
        throw new TypeError(`fixture pipeline did not issue terminal: ${outcome.kind}:${"code" in outcome ? outcome.code : "unknown"}`);
      }
      const draft: Extract<ProducerLaneRunDraftV1, { readonly kind: "terminal" }> = Object.freeze({
        kind: "terminal" as const,
        trigger,
        terminalCapability: outcome.terminalCapability,
        pendingSnapshotHash: request.kind === "backrun" ? readIssuedProducerBackrunIntakeV1(request.input).snapshot?.snapshotHash ?? null : null,
        currentSource: logicalFacts(request.kind, triggerFacts.correlationId),
      });
      return Object.freeze({ draft, outcome });
    },
  });
}

export function cloneTerminalCapability(value: ProducerBoundTriggerV1 | unknown): object {
  return { ...(value as object) };
}
