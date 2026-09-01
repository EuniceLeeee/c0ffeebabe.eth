import type {
  CanonicalHead,
} from "../../../../packages/canonical-source/src/index.ts";
import {
  assertExactKeys,
  assertHash,
  gitSha40Schema,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";
import {
  type ProducerHeadTerminalCapabilityV1,
  type ProducerRuntimeTelemetryV1,
  type ProducerSubmissionResultV1,
  type ProducerHeadInputV1,
} from "../../../../packages/producer/src/index.ts";
import {
  assertIssuedQualifiedFinalSimulationPortFactory,
  type QualifiedFinalSimulationPortFactoryV1,
} from "../../../../packages/final-sim/src/index.ts";
import type { SearchRuntimeCoreInputV1 } from "../../../../packages/search-runtime-core/src/index.ts";
import {
  assertIssuedRuntimeReleasePerformanceRuntimeService,
  type RuntimeReleasePerformanceRuntimeServiceV1,
} from "../../../../packages/runtime-release-authority/src/performance-runtime-consumer.ts";
import {
  assertIssuedSearcherStrategyRuntimeServiceV1,
  type SearcherStrategyRuntimeServiceV1,
} from "../../../../packages/runtime-release-authority/src/strategy-runtime-consumer.ts";
import {
  assertIssuedRuntimeReleaseFullGraphCoarseSweepServiceV1,
  type FullGraphCoarseSweepCapabilityV1,
  type RuntimeReleaseFullGraphCoarseSweepServiceV1,
} from "../../../../packages/runtime-release-authority/src/full-graph-coarse-sweep-consumer.ts";
import {
  assertIssuedRuntimeReleaseFullFamilyTerminalBindingServiceV1,
  type RuntimeReleaseFullFamilyTerminalBindingServiceV1,
} from "../../../../packages/runtime-release-authority/src/full-family-terminal-consumer.ts";
import {
  assertIssuedRuntimeReleaseSixStepTerminalBindingServiceV1,
  type RuntimeReleaseSixStepTerminalBindingServiceV1,
} from "../../../../packages/runtime-release-authority/src/six-step-terminal-consumer.ts";
import { issueFullGraphCoarseSweepInvocationCapabilityV1 } from "../../../../packages/full-graph-coarse-sweep/src/internal/invocation-owner.ts";
import {
  assertIssuedStartupRuntime,
  readStartupFullFamilyEvidenceBinding,
  type StartupRuntimeV1,
} from "../../../../packages/startup-runtime/src/index.ts";
import {
  assertIssuedProductionFullFamilyObservationPortV1,
  type ProductionFullFamilyObservationPortV1,
  type ProductionFullFamilyObservationResultCapabilityV1,
} from "../../../../packages/full-family-observation-port/src/index.ts";
import {
  assertIssuedProductionSixStepObservationPortV1,
  type ProductionSixStepObservationPortV1,
  type ProductionSixStepObservationResultCapabilityV1,
} from "../../../../packages/six-step-observation-port/src/index.ts";
import {
  assertIssuedProductionTerminalPhaseObservationPortV1,
  type ProductionTerminalPhaseObservationPortV1,
  type ProductionTerminalPhaseObservationResultCapabilityV1,
} from "../../../../packages/terminal-phase-observation-port/src/index.ts";
import {
  readSearcherProductionSixStepCompleteAppendSearchTerminalV1,
  readSearcherProductionSixStepWindowSelectionV1,
} from "../../../../packages/six-step-process-evidence/src/index.ts";
import { issueSearcherProductionSixStepProcessEvidenceV1 } from "../../../../packages/six-step-process-evidence/src/internal/owner.ts";
import {
  assertIssuedRethSearcherRuntimeSourceV1,
  type RethSearcherRuntimeSourceV1,
} from "./reth-source.ts";
import {
  createReleaseSearcherProducer,
} from "../index.ts";
import {
  assertIssuedSearcherProductionEvidenceOwnerV1,
  type SearcherProductionEvidencePortsV1,
  type SearcherProductionEvidenceOwnerV1,
  type TerminalPhaseInvalidFactV1,
} from "../production-evidence.ts";
import {
  assertIssuedEconomicSafetyFinalizationServiceV1,
  type EconomicSafetyFinalizationServiceV1,
} from "../../../../packages/economics-safety/src/index.ts";
import { PERFORMANCE_TARGET_COUNT } from "../../../../specs/performance/src/index.ts";
import {
  decodeRuntimeAuthorityProjectionV1,
  type RuntimeAuthorityProjectionV1,
} from "../../../../packages/runtime-authority/src/index.ts";
import {
  assertIssuedUnsignedDryRunObservationOwnerV1,
  type UnsignedDryRunObservationOwnerV1,
} from "../unsigned-dry-run-observation.ts";

const FULL_GRAPH_COARSE_SWEEP_HARD_DEADLINE_MS = 300_000;

export interface SearcherHeadSourceV1 {
  readonly next: (signal: AbortSignal) => Promise<CanonicalHead | null>;
}

export interface SearcherRuntimeApplicationCompositionInputV1<Simulation> {
  readonly strategyRuntime: SearcherStrategyRuntimeServiceV1;
  readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
  readonly economicSafety: EconomicSafetyFinalizationServiceV1;
  /** Signed-only acceptance observers. They observe the same Producer run and
   * are absent from unsigned dry-run; none owns normal application progress. */
  readonly acceptance?: SearcherRuntimeSignedAcceptanceV1;
  /** Candidate-owned canonical/Reth source bundle; deployment cannot replace its parts. */
  readonly source: RethSearcherRuntimeSourceV1;
  readonly coreInput: Omit<SearchRuntimeCoreInputV1, "familyRuntime" | "sourceRead">;
  readonly finalSimulationFactory: QualifiedFinalSimulationPortFactoryV1<Simulation>;
  /** Owner-issued observation of exact Producer facts. */
  readonly evidence: SearcherProductionEvidenceOwnerV1 | UnsignedDryRunObservationOwnerV1;
}

export interface SearcherRuntimeSignedAcceptanceV1 {
  readonly performanceRuntime: RuntimeReleasePerformanceRuntimeServiceV1;
  readonly fullGraphCoarseSweep: RuntimeReleaseFullGraphCoarseSweepServiceV1;
  readonly fullFamilyTerminalBinding: RuntimeReleaseFullFamilyTerminalBindingServiceV1;
  readonly sixStepTerminalBinding: RuntimeReleaseSixStepTerminalBindingServiceV1;
  readonly fullFamilyObservation: ProductionFullFamilyObservationPortV1;
  readonly sixStepObservation: ProductionSixStepObservationPortV1;
  readonly terminalPhaseObservation: ProductionTerminalPhaseObservationPortV1;
  readonly release: Readonly<{
    readonly bindingId: Hash;
    readonly releaseProvenanceHash: Hash;
    readonly candidateReleaseCommit: `${string}`;
  }>;
}

export interface SearcherRuntimeApplicationV1 {
  readonly run: (signal?: AbortSignal) => Promise<void>;
  readonly submitHead: (head: CanonicalHead, signal?: AbortSignal) => Promise<ProducerSubmissionResultV1 | null>;
  /** Read the sweep produced by the terminal application phase. Callers
   * cannot trigger a second sweep or run one before the exact window seals. */
  readonly readFullGraphCoarseSweep: () => FullGraphCoarseSweepCapabilityV1;
  readonly readFullFamilyObservation: () => ProductionFullFamilyObservationResultCapabilityV1;
  readonly readSixStepObservation: () => ProductionSixStepObservationResultCapabilityV1;
  readonly readTerminalPhaseObservation: () => ProductionTerminalPhaseObservationResultCapabilityV1;
  readonly readTerminalPhaseInvalid: () => TerminalPhaseInvalidFactV1 | null;
  readonly readFinalDurableProducerTerminal: () => ProducerHeadTerminalCapabilityV1;
  readonly waitForIdle: () => Promise<void>;
  readonly telemetry: () => ProducerRuntimeTelemetryV1;
  readonly stop: () => Promise<void>;
  readonly done: Promise<void>;
}

const issuedApplications = new WeakSet<object>();
const issuedOwners = new WeakSet<object>();
const claimedStartups = new WeakSet<object>();

function sameHead(left: CanonicalHead, right: CanonicalHead): boolean {
  return left.chainId === right.chainId
    && left.number === right.number
    && left.hash === right.hash
    && left.parentHash === right.parentHash
    && left.stateRoot === right.stateRoot;
}

function sameTelemetryFacts(
  left: ProducerRuntimeTelemetryV1,
  right: ProducerRuntimeTelemetryV1,
): boolean {
  return left.submitted === right.submitted
    && left.accepted === right.accepted
    && left.started === right.started
    && left.completed === right.completed
    && left.dropped === right.dropped
    && left.failed === right.failed
    && left.cancelled === right.cancelled
    && left.terminalCount === right.terminalCount
    && left.active === right.active
    && left.pending === right.pending
    && left.fatal === right.fatal;
}

/**
 * Assemble the one static application owner.  The deployment bundle carries
 * this owner, never a runner callback or a raw ingress token.  `open()` is
 * the only place that invokes createReleaseSearcherProducer and binds it to
 * the exact StartupRuntime returned by release bootstrap.
 */
export function issueSearcherRuntimeApplicationOwnerV1<Simulation>(
  input: SearcherRuntimeApplicationCompositionInputV1<Simulation>,
): SearcherRuntimeApplicationOwnerV1 {
  if (input === null || typeof input !== "object") throw new TypeError("searcher application composition is required");
  const inputKeys = [
    "strategyRuntime", "runtimeAuthority", "economicSafety", "coreInput",
    "finalSimulationFactory", "evidence", "source",
  ];
  if (Object.prototype.hasOwnProperty.call(input, "acceptance")) inputKeys.push("acceptance");
  assertExactKeys(input, inputKeys, "searcherApplication");
  assertIssuedSearcherStrategyRuntimeServiceV1(input.strategyRuntime);
  const expectedRuntimeAuthority = decodeRuntimeAuthorityProjectionV1(input.runtimeAuthority);
  assertIssuedEconomicSafetyFinalizationServiceV1(input.economicSafety);
  const economicSafetyBinding = input.economicSafety.binding();
  if (economicSafetyBinding.runtimeAuthority.authorityClass !== expectedRuntimeAuthority.authorityClass
    || economicSafetyBinding.runtimeAuthority.authorityBindingHash !== expectedRuntimeAuthority.authorityBindingHash
    || economicSafetyBinding.runtimeAuthority.implementationCommit !== expectedRuntimeAuthority.implementationCommit) {
    throw new TypeError("searcher application economic-safety runtime authority mismatch");
  }
  let acceptance: SearcherRuntimeSignedAcceptanceV1 | null = null;
  if (input.acceptance !== undefined) {
    if (input.acceptance === null || typeof input.acceptance !== "object") throw new TypeError("searcher application acceptance is invalid");
    assertExactKeys(input.acceptance, [
      "performanceRuntime", "fullGraphCoarseSweep", "fullFamilyTerminalBinding", "sixStepTerminalBinding",
      "fullFamilyObservation", "sixStepObservation", "terminalPhaseObservation", "release",
    ], "searcherApplication.acceptance");
    assertIssuedRuntimeReleasePerformanceRuntimeService(input.acceptance.performanceRuntime);
    assertIssuedRuntimeReleaseFullGraphCoarseSweepServiceV1(input.acceptance.fullGraphCoarseSweep);
    assertIssuedRuntimeReleaseFullFamilyTerminalBindingServiceV1(input.acceptance.fullFamilyTerminalBinding);
    assertIssuedRuntimeReleaseSixStepTerminalBindingServiceV1(input.acceptance.sixStepTerminalBinding);
    assertIssuedProductionFullFamilyObservationPortV1(input.acceptance.fullFamilyObservation);
    assertIssuedProductionSixStepObservationPortV1(input.acceptance.sixStepObservation);
    assertIssuedProductionTerminalPhaseObservationPortV1(input.acceptance.terminalPhaseObservation);
    assertExactKeys(input.acceptance.release, ["bindingId", "releaseProvenanceHash", "candidateReleaseCommit"], "searcherApplication.acceptance.release");
    acceptance = Object.freeze({
      ...input.acceptance,
      release: Object.freeze({
        bindingId: assertHash(input.acceptance.release.bindingId, "searcherApplication.acceptance.release.bindingId"),
        releaseProvenanceHash: assertHash(input.acceptance.release.releaseProvenanceHash, "searcherApplication.acceptance.release.releaseProvenanceHash"),
        candidateReleaseCommit: gitSha40Schema.decode(input.acceptance.release.candidateReleaseCommit, "searcherApplication.acceptance.release.candidateReleaseCommit"),
      }),
    });
  }
  if ((expectedRuntimeAuthority.authorityClass === "signed-release") !== (acceptance !== null)
    || (expectedRuntimeAuthority.authorityClass === "signed-release"
      && (economicSafetyBinding.releaseProvenanceHash !== acceptance!.release.releaseProvenanceHash
        || expectedRuntimeAuthority.implementationCommit !== acceptance!.release.candidateReleaseCommit))) {
    throw new TypeError("searcher application authority class/acceptance mismatch");
  }
  const strategyIdentity = input.strategyRuntime.readMetadata();
  if ((expectedRuntimeAuthority.authorityClass === "signed-release") !== ("releaseProvenanceHash" in strategyIdentity)
    || ("releaseProvenanceHash" in strategyIdentity
      && strategyIdentity.releaseProvenanceHash !== acceptance!.release.releaseProvenanceHash)) {
    throw new TypeError("searcher application strategy runtime authority mismatch");
  }
  assertIssuedQualifiedFinalSimulationPortFactory(input.finalSimulationFactory);
  let evidenceClass: "signed-release" | "unsigned-dry-run";
  try {
    assertIssuedSearcherProductionEvidenceOwnerV1(input.evidence);
    evidenceClass = "signed-release";
  } catch {
    assertIssuedUnsignedDryRunObservationOwnerV1(input.evidence);
    evidenceClass = "unsigned-dry-run";
  }
  if (evidenceClass !== expectedRuntimeAuthority.authorityClass) {
    throw new TypeError("searcher application observation authority class mismatch");
  }
  assertIssuedRethSearcherRuntimeSourceV1(input.source);
  if (input.coreInput === null || typeof input.coreInput !== "object") throw new TypeError("searcher core input is required");
  if (typeof input.coreInput.amountSeed !== "object" || input.coreInput.amountSeed === null) {
    throw new TypeError("searcher core amount seed is required");
  }
  if (typeof input.coreInput.execution !== "object" || input.coreInput.execution === null) {
    throw new TypeError("searcher core execution context is required");
  }
  const owner: SearcherRuntimeApplicationOwnerV1 = Object.freeze({
    open(startup: StartupRuntimeV1): SearcherRuntimeApplicationV1 {
      assertIssuedStartupRuntime(startup);
      if (claimedStartups.has(startup)) throw new TypeError("searcher startup is already bound to an application");
      const startupGeneration = startup.readActiveGeneration();
      if (startup.runtimeAuthority.authorityClass !== expectedRuntimeAuthority.authorityClass
        || startup.runtimeAuthority.authorityBindingHash !== expectedRuntimeAuthority.authorityBindingHash
        || startup.runtimeAuthority.implementationCommit !== expectedRuntimeAuthority.implementationCommit
        || startupGeneration.releaseProvenanceHash !== (acceptance?.release.releaseProvenanceHash ?? null)
        || startup.canonicalSourceAuthority !== input.source.canonicalAuthority) {
        throw new TypeError("searcher application startup release identity mismatch");
      }
      claimedStartups.add(startup);
      const evidence = evidenceClass === "signed-release"
        ? (input.evidence as SearcherProductionEvidenceOwnerV1).bindServing(startup, acceptance!.performanceRuntime)
        : (input.evidence as UnsignedDryRunObservationOwnerV1).bindServing(startup);
      const acceptanceEvidence: SearcherProductionEvidencePortsV1 | null = evidenceClass === "signed-release"
        ? evidence as SearcherProductionEvidencePortsV1
        : null;
      const producer = createReleaseSearcherProducer({
        startup,
        strategyRuntime: input.strategyRuntime,
        source: input.source,
        coreInput: input.coreInput,
        finalSimulationFactory: input.finalSimulationFactory,
        economicSafety: input.economicSafety,
        evidence,
      });
      let runPromise: Promise<void> | null = null;
      let fullGraphSweepPromise: Promise<FullGraphCoarseSweepCapabilityV1> | null = null;
      let fullGraphSweepCapability: FullGraphCoarseSweepCapabilityV1 | null = null;
      let fullFamilyObservationCapability: ProductionFullFamilyObservationResultCapabilityV1 | null = null;
      let sixStepObservationCapability: ProductionSixStepObservationResultCapabilityV1 | null = null;
      let terminalPhaseObservationCapability: ProductionTerminalPhaseObservationResultCapabilityV1 | null = null;
      let stopPromise: Promise<void> | null = null;
      let latestSubmitted: Readonly<{ readonly head: CanonicalHead; readonly revision: string }> | null = null;
      let phase: "ready" | "producing" | "window-sealed" | "sweeping" | "finished" | "stopping" | "stopped" = "ready";

      const closeApplication = async (): Promise<void> => {
        if (stopPromise !== null) return stopPromise;
        phase = "stopping";
        stopPromise = (async () => {
          await producer.shutdown();
          await startup.close();
          input.source.close();
          input.evidence.close();
          phase = "stopped";
        })();
        return stopPromise;
      };

      const sealWindowAndSweep = async (signal: AbortSignal): Promise<FullGraphCoarseSweepCapabilityV1> => {
        if (acceptance === null || acceptanceEvidence === null) {
          throw new TypeError("signed acceptance is not configured for unsigned dry-run");
        }
        if (fullGraphSweepPromise !== null) return fullGraphSweepPromise;
        if (!acceptanceEvidence.window.isComplete()) {
          throw new TypeError("full-Graph coarse sweep requires the exact completed performance window");
        }
        await producer.waitForIdle();
        const finalCapability = acceptanceEvidence.window.readFinalDurableWindow();
        if (finalCapability === null) {
          throw new TypeError("full-Graph coarse sweep requires the durable final Producer terminal");
        }
        const finalWindow = acceptanceEvidence.window.readFinalDurableWindowBinding(finalCapability);
        const finalServing = startup.readServingGeneration(finalWindow.serving.generationId);
        if (finalWindow.ordinal !== PERFORMANCE_TARGET_COUNT
          || finalWindow.targetCount !== PERFORMANCE_TARGET_COUNT
          || finalWindow.serving.generationId !== finalServing.generationId
          || finalWindow.serving.graphRoot !== finalServing.graphRoot
          || finalWindow.serving.readyRecordHash !== finalServing.readyRecordHash) {
          throw new TypeError("full-Graph coarse sweep final Producer terminal binding mismatch");
        }
        phase = "window-sealed";
        await producer.shutdown();
        const telemetryBeforeSweep = producer.telemetry();
        fullGraphSweepPromise = (async () => {
          phase = "sweeping";
          const priorInvalid = acceptanceEvidence.window.readInvalid();
          if (priorInvalid !== null) {
            await closeApplication();
            throw new TypeError(priorInvalid.reasonCode);
          }
          if (!acceptanceEvidence.window.isCurrentProcessWindow(finalCapability)) {
            await acceptanceEvidence.window.appendInvalid({
              completedWindow: finalCapability,
              reasonCode: "terminal-phase-process-anchor-changed",
              observed: null,
            });
            await closeApplication();
            throw new TypeError("terminal-phase-process-anchor-changed");
          }
          // Acceptance observes through the same candidate-owned Reth
          // canonical authority without consuming the producer head-source
          // de-duplication cursor or either normal F5 lane scope.
          const observation = await input.source.canonical.observeCurrentHead(signal);
          const observed = input.source.canonical.headObservationReader.read(observation);
          const observedHead = observed.head;
          if (!sameHead(finalWindow.head, observedHead)) {
            await acceptanceEvidence.window.appendInvalid({
              completedWindow: finalCapability,
              reasonCode: "terminal-phase-current-source-moved",
              observed,
            });
            await closeApplication();
            throw new TypeError("full-Graph coarse sweep current source moved after the final Producer terminal");
          }
          const capability = await startup.withProducerSession(observation, async session => {
            const sourceRead = input.source.issueFullGraphCoarseSweepSourceRead(session.currentSourceCapability);
            const invocation = issueFullGraphCoarseSweepInvocationCapabilityV1({
              session,
              sourceRead,
              amountSeed: input.coreInput.amountSeed,
              execution: input.coreInput.execution,
            });
            return acceptance.fullGraphCoarseSweep.run(invocation, {
              signal,
              deadlineAtMs: performance.now() + FULL_GRAPH_COARSE_SWEEP_HARD_DEADLINE_MS,
            });
          }, signal);
          const telemetryAfterSweep = producer.telemetry();
          if (!sameTelemetryFacts(telemetryBeforeSweep, telemetryAfterSweep)) {
            throw new TypeError("full-Graph coarse sweep changed Producer/F5 accounting");
          }
          fullGraphSweepCapability = capability;
          const finalHeadTerminal = acceptanceEvidence.window.readCurrentProcessHeadTerminal(finalCapability);
          if (finalHeadTerminal === null) {
            throw new TypeError("acceptance terminal requires the current-process final Producer terminal");
          }
          const fullFamilyTerminalBinding = acceptance.fullFamilyTerminalBinding.bindFinalHead({
            headTerminal: finalHeadTerminal,
            finalDurableWindow: finalCapability,
            startup,
          });
          const fullFamilyEvidence = readStartupFullFamilyEvidenceBinding(
            startup,
            finalWindow.serving.generationId,
          );
          fullFamilyObservationCapability = await acceptance.fullFamilyObservation.observe({
            checkpointReader: fullFamilyEvidence.checkpointReader,
            stage12Capability: fullFamilyEvidence.stage12Capability,
            runtimeReleaseTerminalBindingCapability: fullFamilyTerminalBinding,
            fullGraphCoarseSweepCapability: capability,
          });
          const windowSelectionCapability = acceptanceEvidence.sixStep.readWindowSelection(finalCapability);
          const windowSelection = readSearcherProductionSixStepWindowSelectionV1(windowSelectionCapability);
          const sixStepTerminalBinding = windowSelection.status === "selected"
            ? acceptance.sixStepTerminalBinding.bindSuccessfulTerminal(
                readSearcherProductionSixStepCompleteAppendSearchTerminalV1(windowSelection.completeAppend),
              )
            : null;
          const joinedProcessCapability = sixStepTerminalBinding === null || windowSelection.status !== "selected"
            ? null
            : issueSearcherProductionSixStepProcessEvidenceV1({
                terminalBinding: sixStepTerminalBinding,
                completeAppend: windowSelection.completeAppend,
              });
          sixStepObservationCapability = await acceptance.sixStepObservation.observe({
            windowSelectionCapability,
            terminalBindingCapability: sixStepTerminalBinding,
            joinedProcessCapability,
          });
          terminalPhaseObservationCapability = await acceptance.terminalPhaseObservation.seal({
            finalDurableWindowCapability: finalCapability,
            fullGraphCoarseSweepCapability: capability,
            runtimeReleaseTerminalBindingCapability: fullFamilyTerminalBinding,
            fullFamilyObservationResultCapability: fullFamilyObservationCapability,
            sixStepObservationResultCapability: sixStepObservationCapability,
          });
          if (!sameTelemetryFacts(telemetryBeforeSweep, producer.telemetry())) {
            throw new TypeError("acceptance terminal collectors changed Producer/F5 accounting");
          }
          phase = "finished";
          return capability;
        })();
        return fullGraphSweepPromise;
      };

      const application: SearcherRuntimeApplicationV1 = {
        waitForIdle: () => producer.waitForIdle(),
        telemetry: () => producer.telemetry(),
        readFinalDurableProducerTerminal() {
          if (acceptanceEvidence === null) {
            const terminal = producer.terminals().at(-1);
            if (terminal === undefined) throw new TypeError("Producer has no durable terminal");
            return terminal;
          }
          const finalWindow = acceptanceEvidence.window.readFinalDurableWindow();
          if (finalWindow === null) throw new TypeError("final durable Producer window is not complete");
          const terminal = acceptanceEvidence.window.readCurrentProcessHeadTerminal(finalWindow);
          if (terminal === null) throw new TypeError("final durable Producer terminal belongs to another process");
          return terminal;
        },
        async submitHead(head: CanonicalHead, signal = new AbortController().signal) {
          if (phase !== "ready" && phase !== "producing") {
            throw new TypeError("normal producer admission is closed before the full-Graph coarse sweep");
          }
          if (acceptanceEvidence?.window.isComplete()) {
            throw new TypeError("normal producer admission is closed after the exact performance window");
          }
          const sameHeightReplacement = latestSubmitted !== null
            && latestSubmitted.head.chainId === head.chainId
            && latestSubmitted.head.number === head.number
            && !sameHead(latestSubmitted.head, head);
          if (sameHeightReplacement) {
            await producer.invalidateHead(latestSubmitted!.head, "same_height_reorg");
            await producer.waitForIdle();
          }
          const revision = sameHeightReplacement ? (BigInt(latestSubmitted!.revision) + 1n).toString() : "0";
          const envelope = await input.source.ingress.observe({ head, signal });
          if (envelope === null) return null;
          if (!sameHead(envelope.head, head)) throw new TypeError("searcher ingress head changed during observation");
          const result = await producer.submit({ ...(envelope as ProducerHeadInputV1), revision });
          if (result.accepted) latestSubmitted = Object.freeze({ head, revision });
          return result;
        },
        readFullGraphCoarseSweep() {
          if (acceptance === null) throw new TypeError("full-Graph acceptance is not configured for unsigned dry-run");
          if (phase !== "finished" || fullGraphSweepCapability === null) {
            throw new TypeError("full-Graph coarse sweep is not complete");
          }
          return fullGraphSweepCapability;
        },
        readFullFamilyObservation() {
          if (acceptance === null) throw new TypeError("full-family acceptance is not configured for unsigned dry-run");
          if (phase !== "finished" || fullFamilyObservationCapability === null) {
            throw new TypeError("full-family terminal observation is not complete");
          }
          return fullFamilyObservationCapability;
        },
        readSixStepObservation() {
          if (acceptance === null) throw new TypeError("Six-Step acceptance is not configured for unsigned dry-run");
          if (phase !== "finished" || sixStepObservationCapability === null) {
            throw new TypeError("Six-Step terminal observation is not complete");
          }
          return sixStepObservationCapability;
        },
        readTerminalPhaseObservation() {
          if (acceptance === null) throw new TypeError("terminal-phase acceptance is not configured for unsigned dry-run");
          if (phase !== "finished" || terminalPhaseObservationCapability === null) {
            throw new TypeError("terminal-phase observation is not complete");
          }
          return terminalPhaseObservationCapability;
        },
        readTerminalPhaseInvalid() {
          return acceptanceEvidence?.window.readInvalid() ?? null;
        },
        async run(signal = new AbortController().signal) {
          if (runPromise !== null) return runPromise;
          runPromise = (async () => {
            phase = "producing";
            while (!signal.aborted) {
              if (acceptanceEvidence?.window.isComplete()) {
                await sealWindowAndSweep(signal);
                break;
              }
              const head = await input.source.headSource.next(signal);
              if (head === null) break;
              await application.submitHead(head, signal);
              await producer.waitForIdle();
              if (acceptanceEvidence?.window.isComplete()) {
                await sealWindowAndSweep(signal);
                break;
              }
            }
            if (!acceptanceEvidence?.window.isComplete()) await producer.waitForIdle();
          })();
          return runPromise;
        },
        async stop() {
          return closeApplication();
        },
        get done() {
          if (runPromise === null) {
            void application.run();
          }
          return runPromise!;
        },
      };
      issuedApplications.add(application);
      return application;
    },
  });
  issuedOwners.add(owner);
  return owner;
}

export interface SearcherRuntimeApplicationOwnerV1 {
  readonly open: (startup: StartupRuntimeV1) => SearcherRuntimeApplicationV1;
}

export function assertIssuedSearcherRuntimeApplicationV1(
  value: unknown,
): asserts value is SearcherRuntimeApplicationV1 {
  if (value === null || typeof value !== "object" || !issuedApplications.has(value)) {
    throw new TypeError("searcher runtime application is not owner-issued");
  }
}

export function assertIssuedSearcherRuntimeApplicationOwnerV1(
  value: unknown,
): asserts value is SearcherRuntimeApplicationOwnerV1 {
  if (value === null || typeof value !== "object" || !issuedOwners.has(value)) {
    throw new TypeError("searcher runtime application owner is not owner-issued");
  }
}
