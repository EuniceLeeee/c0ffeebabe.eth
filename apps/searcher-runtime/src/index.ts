import {
  type CanonicalHead,
  type ProducerSessionV1,
} from "../../../packages/canonical-source/src/index.ts";
import type {
  FinalSimulationPortV1,
  FinalSimulationPortV1 as QualifiedFinalSimulationPortV1,
  QualifiedFinalSimulationPortFactoryV1,
} from "../../../packages/final-sim/src/index.ts";
import { assertIssuedQualifiedFinalSimulationPortFactory } from "../../../packages/final-sim/src/index.ts";
import {
  createGeneratedSearchRuntimePorts,
  type SearchRuntimeCoreInputV1,
  type SearchRuntimeExactV1,
  type SearchRuntimePlanV1,
  type SearchRuntimeProjectionV1,
} from "../../../packages/search-runtime-core/src/index.ts";
import {
  runSearchPipeline,
  validateSearchObjective,
  type CurrentSourceSessionV1,
  type RouteAdmissionPolicyV1,
  type RoutePipelineOutcomeV1,
  type RoutePipelinePortsV1,
  type SearchObjectiveV1,
} from "../../../packages/search-pipeline/src/index.ts";
import {
  assertIssuedStrategyPlanningProblem,
  type StrategyGraphBindingV1,
  type StrategyGraphEdgeV1,
  type StrategyPlanningProblemV1,
} from "../../../packages/strategy-composition/src/index.ts";
import { assertExactKeys, assertHash, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import type {
  StartupProducerLeaseV1,
  StartupRuntimeV1,
} from "../../../packages/startup-runtime/src/index.ts";
import { assertIssuedStartupRuntime } from "../../../packages/startup-runtime/src/index.ts";
import {
  ProducerRuntimeV1,
  assertIssuedProducerIngressTriggerV1,
  issueProducerBoundTriggerV1,
  issueProducerLanePortV1,
  issueProducerSessionOwnerV1,
  readIssuedProducerBackrunIntakeV1,
  type ProducerBackrunIntakeV1,
  type ProducerBoundTriggerV1,
  type ProducerLaneRunDraftV1,
  type ProducerIngressTriggerV1,
  type ProducerLaneRunInputV1,
} from "../../../packages/producer/src/index.ts";
import {
  assertIssuedRuntimeReleaseStrategyRuntimeService,
  type RuntimeReleaseStrategyRuntimeServiceV1,
} from "../../../packages/runtime-release-authority/src/strategy-runtime-consumer.ts";
import { readRuntimeReleaseSixStepProductionTailV1 } from "../../../packages/runtime-release-authority/src/six-step-production-consumer.ts";
import {
  assertIssuedRuntimeReleaseSearcherStartupService,
  type RuntimeReleaseSearcherStartupServiceV1,
} from "../../../packages/runtime-release-authority/src/searcher-startup-consumer.ts";
import type { SearcherProducerSessionV1 } from "./internal/ports.ts";
import {
  assertIssuedRethSearcherRuntimeSourceV1,
  type RethSearcherRuntimeSourceV1,
} from "./internal/reth-source.ts";
import {
  assertIssuedSearcherProductionEvidencePortsV1,
  type SearcherProductionEvidencePortsV1,
} from "./production-evidence.ts";
import {
  assertIssuedEconomicSafetyFinalizationServiceV1,
  type EconomicSafetyFinalizationServiceV1,
} from "../../../packages/economics-safety/src/index.ts";

/**
 * The runtime seam is intentionally opaque to protocol code.  A generated
 * adapter supplies the route-stage ports and the qualified final-simulation
 * bridge supplies the only simulation port that can produce a passed fact.
 * No Family, pool, ABI, or production-submission type crosses this boundary.
 */
export type SearcherRuntimePortsV1<Projection, Plan, Exact, Simulation> =
  Omit<RoutePipelinePortsV1<Projection, Plan, Exact, Simulation>, "finalSimulation" | "economicSafety">
  & {
    readonly finalSimulation: QualifiedFinalSimulationPortV1<Simulation>;
    readonly economicSafety: EconomicSafetyFinalizationServiceV1;
  };

export interface SearcherRuntimeInputV1 {
  /** The observed canonical head; this is never taken from lease.binding.cutoff. */
  readonly head: CanonicalHead;
  readonly objective: SearchObjectiveV1;
  readonly correlationId: Hash;
  readonly deadlineAtMs: number;
  readonly callerId: string;
  readonly admission: RouteAdmissionPolicyV1;
  readonly signal?: AbortSignal;
}

/** Input owned by one of the two application lanes; the head and planning
 * problem are supplied by ProducerRuntime/Strategy composition. */
export type SearcherLaneInputV1 = Omit<SearcherRuntimeInputV1, "head" | "signal" | "planningProblem"> & {
  /** Producer-owner issued ingress token; never a trigger DTO. */
  readonly trigger: ProducerIngressTriggerV1;
};
type SearcherLaneSearchInputV1 = SearcherRuntimeInputV1 & { readonly trigger: ProducerIngressTriggerV1 };

/** Empty Ready Graphs have a mechanically empty route denominator. This port
 * cannot manufacture a result and exists only so the route-set owner can seal
 * its native no-candidate terminal without constructing a REVM simulation
 * session that can never be consumed. */
const EMPTY_GRAPH_FINAL_SIMULATION_PORT: FinalSimulationPortV1<never> = Object.freeze({
  rejectionAuthority: Object.freeze({
    read(): never {
      throw new TypeError("empty Graph cannot issue a final-simulation rejection");
    },
  }),
  async simulate(): Promise<never> {
    throw new TypeError("empty Graph cannot execute final simulation");
  },
});

/**
 * The public runtime result is exactly the search pipeline's terminal result
 * space.  In particular, it contains either route accounting or an unsigned
 * dry-run receipt; this entry has no credential, submission, or caller-provided
 * production-success input.
 */
export type SearcherRuntimeOutcomeV1<Simulation> = RoutePipelineOutcomeV1<Simulation>;

/**
 * Release bootstrap seam consumed by the application process. The bootstrap
 * owns discovery, canonical, attestation and the ReadyGeneration service;
 * the app receives only this startup operation and the already-issued
 * StartupRuntime. No ReadyGeneration constructor or promotion callback
 * is accepted here.
 */
export type ReleaseSearcherStartupOwnerV1 = RuntimeReleaseSearcherStartupServiceV1;

export async function startReleaseSearcherStartup(
  owner: ReleaseSearcherStartupOwnerV1,
  signal?: AbortSignal,
): Promise<StartupRuntimeV1> {
  assertIssuedRuntimeReleaseSearcherStartupService(owner);
  const startup = await owner.startStartup(signal);
  assertIssuedStartupRuntime(startup);
  if (startup.ready.releaseProvenanceHash !== owner.release.releaseProvenanceHash
    || startup.releaseBindingId !== owner.release.bindingId
    || startup.candidateReleaseCommit !== owner.release.candidateReleaseCommit) {
    throw new TypeError("startup runtime release identity mismatch");
  }
  return startup;
}

type RuntimePorts<Projection, Plan, Exact, Simulation> =
  RoutePipelinePortsV1<Projection, Plan, Exact, Simulation>;

function pipelinePorts<Projection, Plan, Exact, Simulation>(
  ports: SearcherRuntimePortsV1<Projection, Plan, Exact, Simulation>,
): RuntimePorts<Projection, Plan, Exact, Simulation> {
  /*
   * Keep this adapter explicit.  @aloha/final-sim deliberately exposes a
   * smaller structural binding/source view than search-pipeline; it is still
   * the same qualified port, and central code must not reinterpret its fact.
  */
  return {
    route: ports.route,
    coarse: ports.coarse,
    planner: ports.planner,
    exact: ports.exact,
    executionProgram: ports.executionProgram,
    finalSimulation: {
      rejectionAuthority: ports.finalSimulation.rejectionAuthority,
      ...(ports.finalSimulation.schedulerJoinAuthority === undefined
        ? {}
        : { schedulerJoinAuthority: ports.finalSimulation.schedulerJoinAuthority }),
      ...(ports.finalSimulation.sixStepEvidenceAuthority === undefined
        ? {}
        : { sixStepEvidenceAuthority: ports.finalSimulation.sixStepEvidenceAuthority }),
      simulate: input => ports.finalSimulation.simulate(input),
    },
    economicSafety: ports.economicSafety,
    unsignedDryRun: ports.unsignedDryRun,
    sixStepArtifacts: ports.sixStepArtifacts,
  };
}

function searchCurrentSource(
  session: ProducerSessionV1<StartupProducerLeaseV1>,
): CurrentSourceSessionV1 {
  return Object.freeze({
    sessionId: session.sessionId,
    source: Object.freeze({
      chainId: session.source.chainId,
      number: session.source.number,
      hash: session.source.hash,
      stateRoot: session.source.stateRoot,
    }),
    assertCurrent: () => session.assertCurrent(),
  });
}

async function runPipelineInSession<Projection, Plan, Exact, Simulation>(
  ports: SearcherRuntimePortsV1<Projection, Plan, Exact, Simulation>,
  input: SearcherRuntimeInputV1,
  planningProblem: StrategyPlanningProblemV1,
  strategyCompositionRoot: Hash,
  session: ProducerSessionV1<StartupProducerLeaseV1>,
): Promise<SearcherRuntimeOutcomeV1<Simulation>> {
  assertIssuedStrategyPlanningProblem(planningProblem);
  return runSearchPipeline(pipelinePorts(ports), {
    lease: session.lease,
    planningProblem,
    strategyCompositionRoot,
    objective: input.objective,
    currentSource: searchCurrentSource(session),
    correlationId: input.correlationId,
    deadlineAtMs: input.deadlineAtMs,
    callerId: input.callerId,
    admission: input.admission,
    signal: input.signal,
  });
}

export interface ReleaseSearcherProducerCompositionInputV1<Simulation> {
  readonly startup: StartupRuntimeV1;
  /** Runtime-release owner service; generic Strategy builders cannot enter. */
  readonly strategyRuntime: RuntimeReleaseStrategyRuntimeServiceV1;
  /** Candidate-owned Reth/current-source authority; raw read factories are forbidden. */
  readonly source: RethSearcherRuntimeSourceV1;
  readonly coreInput: Omit<SearchRuntimeCoreInputV1, "familyRuntime" | "sourceRead">;
  readonly finalSimulationFactory: QualifiedFinalSimulationPortFactoryV1<Simulation>;
  readonly economicSafety: EconomicSafetyFinalizationServiceV1;
  /** One release-owned durable evidence binding; individual sinks are not caller seams. */
  readonly evidence: SearcherProductionEvidencePortsV1;
}

function laneSearchInput(
  value: unknown,
  head: CanonicalHead,
  signal: AbortSignal,
): SearcherLaneSearchInputV1 {
  if (value === null || typeof value !== "object") throw new TypeError("searcher lane input is required");
  const input = value as SearcherLaneInputV1;
  assertIssuedProducerIngressTriggerV1(input.trigger);
  return Object.freeze({ ...input, objective: validateSearchObjective(input.objective), head, signal });
}

function strategyEdges(session: SearcherProducerSessionV1): readonly StrategyGraphEdgeV1[] {
  return Object.freeze(session.lease.edges.map(edge => Object.freeze({
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

function issueLanePlanningProblem(
  input: ProducerLaneRunInputV1<SearcherProducerSessionV1>,
  searchInput: SearcherLaneSearchInputV1,
  boundTrigger: ProducerBoundTriggerV1,
  strategyRuntime: RuntimeReleaseStrategyRuntimeServiceV1,
): { readonly planningProblem: StrategyPlanningProblemV1; readonly strategyCompositionRoot: Hash } {
  const objectivePayload = searchInput.objective.payload as Record<string, unknown>;
  assertExactKeys(objectivePayload, ["numeraireAssetRef", "minNetGain", "maxGas", "maxValueAtRisk"], "searchObjective.payload");
  const objectiveAssetRef = assertHash(objectivePayload.numeraireAssetRef, "searchObjective.payload.numeraireAssetRef");
  const binding: StrategyGraphBindingV1 = {
    generationId: input.session.generationId,
    definitionCatalogRoot: input.session.lease.binding.definitionCatalogRoot,
    graphRoot: input.session.lease.binding.graphRoot,
    readyRecordHash: input.session.lease.binding.readyRecordHash,
    runtimeAuthority: input.session.lease.binding.runtimeAuthority,
    releaseProvenanceHash: input.session.lease.binding.releaseProvenanceHash,
    sourceHash: input.head.hash,
  };
  const issued = strategyRuntime.issuePlanningProblem({
    trigger: boundTrigger,
    binding,
    edges: strategyEdges(input.session),
    expectedLane: input.kind,
    objectiveRef: searchInput.objective.objectiveRef,
    entryAssetRef: objectiveAssetRef,
    returnAssetRef: objectiveAssetRef,
    expectedCorrelationId: searchInput.correlationId,
    expectedHeadHash: input.head.hash,
  });
  const planningProblem = issued.planningProblem;
  assertIssuedStrategyPlanningProblem(planningProblem);
  if (planningProblem.strategyCompositionRoot !== issued.strategyCompositionRoot
    || planningProblem.readyRecordHash !== binding.readyRecordHash
    || planningProblem.releaseProvenanceHash !== binding.releaseProvenanceHash) {
    throw new TypeError("strategy planning problem release binding mismatch");
  }
  return issued;
}

async function runSearcherLane<Simulation>(
  input: ProducerLaneRunInputV1<SearcherProducerSessionV1>,
  startup: StartupRuntimeV1,
  strategyRuntime: RuntimeReleaseStrategyRuntimeServiceV1,
  source: RethSearcherRuntimeSourceV1,
  coreInput: ReleaseSearcherProducerCompositionInputV1<Simulation>["coreInput"],
  finalSimulationFactory: QualifiedFinalSimulationPortFactoryV1<Simulation>,
  economicSafety: EconomicSafetyFinalizationServiceV1,
): Promise<ProducerLaneRunDraftV1> {
  const backrunIntake = input.kind === "backrun"
    ? readIssuedProducerBackrunIntakeV1(input.input)
    : null;
  const searchInput = backrunIntake?.kind === "observed-empty" || backrunIntake?.kind === "unavailable"
    ? null
    : laneSearchInput(backrunIntake?.kind === "pending-transaction" ? backrunIntake.input : input.input, input.head, input.signal);
  const correlationId = backrunIntake?.correlationId ?? searchInput?.correlationId;
  if (correlationId === undefined) throw new TypeError("lane correlation is unavailable");
  const sourceScope = source.issueCurrentSourceReadScope(input.session.currentSourceCapability, { lane: input.kind, correlationId });
  let draft: Omit<Extract<ProducerLaneRunDraftV1, { readonly kind: "terminal" }>, "currentSource">
    | Omit<Extract<ProducerLaneRunDraftV1, { readonly kind: "no-input" }>, "currentSource">
    | Omit<Extract<ProducerLaneRunDraftV1, { readonly kind: "retryable" | "failed" | "cancelled" }>, "currentSource">;
  try {
    if (backrunIntake?.kind === "observed-empty") {
      draft = Object.freeze({ kind: "no-input", absence: input.input as ProducerBackrunIntakeV1 });
    } else if (backrunIntake?.kind === "unavailable") {
      draft = Object.freeze({ kind: "retryable", reasonCode: backrunIntake.reasonCode });
    } else {
      if (searchInput === null) throw new TypeError("lane search input is unavailable");
      if (searchInput.callerId !== coreInput.execution.transactionOrigin) {
        throw new TypeError("lane caller does not match the release execution origin");
      }
      const boundTrigger = issueProducerBoundTriggerV1({ ingress: searchInput.trigger, laneInput: input });
      const planning = issueLanePlanningProblem(input, searchInput, boundTrigger, strategyRuntime);
      const generated = createGeneratedSearchRuntimePorts({
        ...coreInput,
        familyRuntime: startup.familySearchRuntime,
        sourceRead: sourceScope,
      });
      const finalSimulation = input.session.lease.edges.length === 0
        ? EMPTY_GRAPH_FINAL_SIMULATION_PORT
        : await finalSimulationFactory.issue(input.session.currentSourceCapability);
      const ports: SearcherRuntimePortsV1<SearchRuntimeProjectionV1, SearchRuntimePlanV1, SearchRuntimeExactV1, Simulation> = {
        ...generated,
        finalSimulation,
        economicSafety,
        sixStepArtifacts: readRuntimeReleaseSixStepProductionTailV1(
          strategyRuntime,
          input.session.lease.sixStepRouteParents,
        ),
      };
      const outcome = await runPipelineInSession(ports, searchInput, planning.planningProblem, planning.strategyCompositionRoot, input.session);
      draft = outcome.kind !== "unsigned-dry-run" && outcome.kind !== "route-set-terminal"
        ? Object.freeze({ kind: outcome.kind === "retryable" ? "retryable" as const : "failed" as const, reasonCode: `${outcome.stage}:${outcome.code}` })
        : Object.freeze({
          kind: "terminal" as const,
          trigger: boundTrigger,
          terminalCapability: outcome.terminalCapability,
          pendingSnapshotHash: backrunIntake?.kind === "pending-transaction" ? backrunIntake.snapshot.snapshotHash : null,
        });
    }
  } catch (error) {
    let currentSource = null;
    try {
      currentSource = source.closeCurrentSourceReadScope(input.session.currentSourceCapability, sourceScope);
    } catch {
      // The lane failed before it could publish a closed logical scope.
    }
    return Object.freeze({
      kind: input.signal.aborted ? "cancelled" as const : "failed" as const,
      reasonCode: error instanceof Error ? error.message : "lane-failed",
      currentSource,
    });
  }
  const currentSource = source.closeCurrentSourceReadScope(input.session.currentSourceCapability, sourceScope);
  // The physical source receipt is necessary but not sufficient to publish a
  // lane result.  Re-fence both authorities after it is sealed so a reorg or
  // release rotation during planning/empty-input handling cannot escape as a
  // terminal, no-input, retryable, failed, or cancelled draft.
  await input.session.assertCurrent(input.signal);
  strategyRuntime.readMetadata();
  return draft.kind === "terminal" || draft.kind === "no-input"
    ? Object.freeze({ ...draft, currentSource }) as ProducerLaneRunDraftV1
    : Object.freeze({ ...draft, currentSource });
}

/**
 * App-owned producer loop. The deployment loader never receives this object
 * or an executable callback: release composition builds it after StartupRuntime
 * and the app owns ingress, coalescing, dual-lane execution and shutdown.
 */
export function createReleaseSearcherProducer<Simulation>(
  input: ReleaseSearcherProducerCompositionInputV1<Simulation>,
): ProducerRuntimeV1<SearcherProducerSessionV1> {
  assertIssuedStartupRuntime(input.startup);
  assertIssuedRuntimeReleaseStrategyRuntimeService(input.strategyRuntime);
  const strategyIdentity = input.strategyRuntime.readMetadata();
  const startupGeneration = input.startup.readActiveGeneration();
  if (strategyIdentity.definitionCatalogRoot !== startupGeneration.definitionCatalogRoot) {
    throw new TypeError("strategy composition definition catalog does not match startup");
  }
  if (strategyIdentity.releaseProvenanceHash !== startupGeneration.releaseProvenanceHash) {
    throw new TypeError("strategy composition release provenance does not match startup");
  }
  if (input.startup.canonicalSourceAuthority !== input.source.canonicalAuthority) {
    throw new TypeError("startup canonical source authority does not match Reth source");
  }
  assertIssuedQualifiedFinalSimulationPortFactory(input.finalSimulationFactory);
  assertIssuedEconomicSafetyFinalizationServiceV1(input.economicSafety);
  assertIssuedRethSearcherRuntimeSourceV1(input.source);
  assertIssuedSearcherProductionEvidencePortsV1(input.evidence);
  const sessionOwner = issueProducerSessionOwnerV1<SearcherProducerSessionV1>({
    withProducerSession(head, run, signal) {
      return input.startup.withProducerSession(input.source.consumeHeadObservation(head), async session => {
        const result = await run(session);
        input.strategyRuntime.readMetadata();
        await session.assertCurrent(signal);
        input.strategyRuntime.readMetadata();
        return result;
      }, signal);
    },
  });
  const blockscan = issueProducerLanePortV1<SearcherProducerSessionV1>({
    kind: "blockscan",
    run: request => runSearcherLane(request, input.startup, input.strategyRuntime, input.source, input.coreInput, input.finalSimulationFactory, input.economicSafety),
  });
  const backrun = issueProducerLanePortV1<SearcherProducerSessionV1>({
    kind: "backrun",
    run: request => runSearcherLane(request, input.startup, input.strategyRuntime, input.source, input.coreInput, input.finalSimulationFactory, input.economicSafety),
  });
  return new ProducerRuntimeV1({
    sessionOwner,
    blockscan,
    backrun,
    currentSource: input.source.currentSourceHead,
    performance: input.evidence.performance,
    terminal: input.evidence.terminal,
  });
}

export {
  assertDirectCliNonProductionV1,
  assertRuntimeAnchorsV1,
  assertDeploymentRuntimeBundleV1,
  assertDeploymentBundleIdentityV1,
  decodeDeploymentManifestV1,
  deploymentManifestHashV1,
  encodeDeploymentManifestV1,
  encodeRuntimeAnchorReceiptV1,
  runtimeAnchorReceiptV1,
  sha256FileV1,
  startDryRunServiceV1,
  systemRuntimeAnchorObserverV1,
} from "./deployment.ts";
export type {
  DeploymentBundleLoaderV1,
  DeploymentBundleReleaseIdentityV1,
  DeploymentManifestV1,
  DeploymentRuntimeBundleV1,
  DryRunServiceHandleV1,
  RuntimeAnchorObservationV1,
  RuntimeAnchorObserverV1,
  RuntimeAnchorReceiptV1,
} from "./deployment.ts";
export {
  assertIssuedSearcherProductionEvidenceOwnerV1,
  issueSearcherProductionEvidenceOwnerV1,
  missingExternalRuntimeAnchorEvidenceV1,
} from "./production-evidence.ts";
export type {
  MissingExternalRuntimeAnchorEvidenceV1,
  MissingPerformanceFactReasonV1,
  SearcherProductionEvidenceOwnerInputV1,
  SearcherProductionEvidenceOwnerV1,
  SearcherProductionEvidenceReplayV1,
  SearcherProductionEvidenceReleaseV1,
} from "./production-evidence.ts";
