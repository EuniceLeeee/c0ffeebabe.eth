import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain, type Hash } from "../../canonical-codec/src/index.ts";
import {
  RevmSimulationClient,
  createFailClosedRevmClient,
  decodeWorkerLine,
  encodeWorkerLine,
  hashEffectsWire,
  hashExecutionReceipt,
  hashFrozenProgram,
  type RevmWorkerResultV1,
} from "../../../runtime/revm-workers/src/index.ts";
import { RevmWorkerPool } from "../../../runtime/revm-workers/src/lifecycle.ts";
import { issueRevmWorkerAuthorityIssuer } from "../../../runtime/revm-workers/src/internal/authority.ts";
import { decodeRuntimeReleaseExecutorLeaseV1 } from "../../../specs/release-authority/src/index.ts";
import {
  routeBindingHash,
  runResolvedRoutePipeline,
  type FinalSimulationPortV1 as SearchPipelineFinalSimulationPortV1,
  type SearchPipelinePortsV1,
} from "../../search-pipeline/src/index.ts";
import { createProductionSixStepTailFixture } from "../../search-pipeline/test/production-six-step-fixture.ts";
import { WorkScheduler } from "../../scheduler/src/index.ts";
import {
  bindSchedulerPerformanceJournal,
  issueSchedulerPerformanceReaderPort,
  readSchedulerWorkCompletionCapability,
  readSchedulerWorkCompletionHandle,
} from "../../scheduler/src/internal/performance-state.ts";
import {
  createSignedReleaseRuntimeAuthorityDescriptorV1,
  projectRuntimeAuthorityDescriptorV1,
} from "../../runtime-authority/src/index.ts";
import { issueEconomicSafetyFinalizationServiceV1 } from "../../economics-safety/src/internal/owner.ts";
import { encodeExecutorExecuteCalldata, encodePackedCallProgram } from "../../execution-program/src/index.ts";
import { createTestRevmAuthorityIssuer } from "../../../runtime/revm-workers/test/qualified-authority.ts";
import { createQualifiedFinalSimulationExecutorStateSnapshotIssuer } from "../src/internal/state-snapshot.ts";
import {
  createSourceBoundExecutorProjection,
  createQualifiedFinalSimulationPort,
  type QualifiedFinalSimulationFactV1,
  type ExecutionProgramArtifactV1,
  type SourceViewV1,
} from "../src/index.ts";

const h = (value: string): Hash => hashDomain("test/final-sim", value);
const source: SourceViewV1 = Object.freeze({ chainId: "1", number: "100", hash: h("block"), stateRoot: h("state") });
const schemaHash = h("program-schema");

function program(): ExecutionProgramArtifactV1 {
  const body = {
    kind: "execution-program" as const,
    generationId: "generation-1",
    source,
    routeHash: h("route"),
    programBytes: "0xprogram-bytes",
    payloadHash: h("payload"),
    issuerRef: h("issuer"),
    obligationRoot: h("obligations"),
  };
  return Object.freeze({ ...body, programHash: hashDomain("aloha/execution-program-artifact/v1", body) });
}

function projection() {
  return {
    project: () => ({
      input: { kind: "qualified-final-simulation-input-v1", request: "test" },
      caller: { address: "0xcaller", mode: "top-level" as const, observedSender: "0xcaller", verifiedActors: {} },
      observeAccounts: [],
    }),
  };
}

function effectProgram(): ExecutionProgramArtifactV1 {
  const { programHash: _ignored, ...base } = program();
  const body = {
    ...base,
    effectTransport: {
      caller: { ref: { kind: "observed-sender" as const }, executionMode: "top-level" as const },
      preCalls: [],
      observeTokenBalances: [{ token: "0x1111111111111111111111111111111111111111" as const, account: { kind: "observed-sender" as const } }],
      observeLogs: true,
    },
  };
  return Object.freeze({ ...body, programHash: hashDomain("aloha/execution-program-artifact/v1", body) });
}

function effectProjection() {
  return {
    project: ({ program: artifact }: { readonly program: ExecutionProgramArtifactV1 }) => ({
      input: { kind: "qualified-final-simulation-input-v1", request: "effect" },
      caller: { address: "0xcaller", mode: "top-level" as const, observedSender: "0xcaller", verifiedActors: {} },
      observeAccounts: [],
      effectTransport: artifact.effectTransport,
    }),
  };
}

const executorAddress = "0x2222222222222222222222222222222222222222";
const executorCaller = "0x1111111111111111111111111111111111111111";
const executorCode = "0x600054600101600055600054602060005260206000f3";
const executorConfig = Object.freeze({ chainId: "1", gasLimit: "1000000", value: "0", block: { timestamp: "7", gasLimit: "30000000" } });
const executorStateInput = Object.freeze({});
const executorStateAccounts = Object.freeze({
  [executorCaller]: Object.freeze({ balance: "0", nonce: "0", code: "0x" }),
  [executorAddress]: Object.freeze({ balance: "0", nonce: "0", code: executorCode }),
});

function executorStateFact(authorityBinding: ReturnType<ReturnType<typeof createTestRevmAuthorityIssuer>["issue"]>) {
  return {
    kind: "aloha.qualified-final-simulation-executor-state-v1" as const,
    authorityBinding,
    generationId: "generation-1",
    cutoff: source,
    source,
    executorAddress,
    callerAddress: executorCaller,
    executorCode,
    executorCodeHash: hashDomain("aloha/qualified-final-simulation-executor-code/v1", executorCode),
    executorConfig,
    executorConfigHash: hashDomain("aloha/qualified-final-simulation-executor-config/v1", executorConfig),
    stateInput: executorStateInput,
    stateAccounts: executorStateAccounts,
  };
}

function executorProgram(bytes = encodeExecutorExecuteCalldata(encodePackedCallProgram([{
  target: "0x3333333333333333333333333333333333333333",
  value: "0",
  calldata: "0x",
}])), programSource: SourceViewV1 = source) : ExecutionProgramArtifactV1 {
  const body = {
    kind: "execution-program" as const,
    generationId: "generation-1",
    source: programSource,
    routeHash: h("executor-route"),
    programBytes: bytes,
    payloadHash: h("executor-payload"),
    issuerRef: h("issuer"),
    obligationRoot: h("obligations"),
  };
  return Object.freeze({ ...body, programHash: hashDomain("aloha/execution-program-artifact/v1", body) });
}

function qualifiedProjection() {
  const authority = createTestRevmAuthorityIssuer(["epoch-1"]);
  const authorityBinding = authority.issue();
  const fact = executorStateFact(authorityBinding);
  const snapshot = createQualifiedFinalSimulationExecutorStateSnapshotIssuer({ fact, authority }).issue();
  return { projection: createSourceBoundExecutorProjection({ snapshot, authority }), authority, fact, snapshot };
}

function sourceSession() {
  return { source, assertCurrent: () => undefined };
}

function input() {
  return {
    binding: { generationId: "generation-1", cutoff: source },
    program: program(),
    source: sourceSession(),
    callerId: "caller-1",
    correlationId: h("correlation"),
    deadlineAtMs: performance.now() + 1_000,
  };
}

test("source-bound executor projection binds exact execute calldata, target, caller, code/config hashes, and state", () => {
  const { projection } = qualifiedProjection();
  const artifact = executorProgram();
  const projected = projection.project({ program: artifact, callerId: executorCaller, generationId: "generation-1", cutoff: source });
  const inputValue = projected.input as Record<string, unknown>;
  assert.equal(inputValue.to, executorAddress);
  assert.equal(inputValue.target, executorAddress);
  assert.equal(inputValue.data, artifact.programBytes);
  assert.equal(inputValue.calldata, artifact.programBytes);
  assert.equal(inputValue.executorCodeHash, hashDomain("aloha/qualified-final-simulation-executor-code/v1", executorCode));
  assert.equal(inputValue.executorConfigHash, hashDomain("aloha/qualified-final-simulation-executor-config/v1", executorConfig));
  assert.deepEqual(projected.caller, { address: executorCaller, mode: "top-level", observedSender: executorCaller, verifiedActors: {} });
  assert.deepEqual(projected.observeAccounts, [executorAddress, executorCaller].sort());
});

test("source-bound executor projection fails closed on malformed program, source, target/caller, and state mismatches", () => {
  const authority = createTestRevmAuthorityIssuer(["epoch-1"]);
  const binding = authority.issue();
  const fact = executorStateFact(binding);
  const issuer = createQualifiedFinalSimulationExecutorStateSnapshotIssuer({ fact, authority });
  const snapshot = issuer.issue();
  const projection = createSourceBoundExecutorProjection({ snapshot, authority });
  assert.throws(() => projection.project({ program: executorProgram("0x09c5eabe"), callerId: executorCaller, generationId: "generation-1", cutoff: source }), /execute calldata/);
  assert.throws(() => projection.project({ program: executorProgram(undefined, { ...source, number: "101" }), callerId: executorCaller, generationId: "generation-1", cutoff: source }), /source mismatch/);
  assert.throws(() => projection.project({ program: executorProgram(), callerId: "0x9999999999999999999999999999999999999999", generationId: "generation-1", cutoff: source }), /caller binding/);
  assert.throws(() => createSourceBoundExecutorProjection({ snapshot: { ...fact, executorCode: "0x6000", executorCodeHash: hashDomain("aloha/qualified-final-simulation-executor-code/v1", "0x6000"), stateAccounts: { [executorCaller]: { balance: "0", nonce: "0", code: "0x" } } } as never, authority }), /snapshot capability/);
  assert.throws(() => createSourceBoundExecutorProjection({ snapshot: { ...fact, executorConfigHash: h("wrong-config") } as never, authority }), /snapshot capability/);
  assert.throws(() => createSourceBoundExecutorProjection({ snapshot: { ...fact, stateAccounts: { [executorCaller]: { balance: "0", nonce: "0", code: "0x" } } } as never, authority }), /snapshot capability/);
  assert.throws(() => createSourceBoundExecutorProjection({ snapshot: { ...fact, authorityBinding: { ...binding, workerEpoch: "stale" } } as never, authority }), /snapshot capability/);
  assert.throws(() => createSourceBoundExecutorProjection({ snapshot: { ...snapshot } as never, authority }), /snapshot capability/);
  assert.throws(() => createSourceBoundExecutorProjection({ snapshot, authority: { assertCurrent: () => undefined } as never }), /not release-issued/);
});

function authority() {
  const lease = decodeRuntimeReleaseExecutorLeaseV1({
    bindingId: h("binding"),
    releaseProvenanceHash: h("provenance"),
    executorAuthorityRoot: h("executor-authority"),
    qualifiedExecutorRegistryRoot: h("registry"),
    selectedExecutorLeafHash: h("executor-leaf"),
    executorKind: "revm-test",
    engineBuildFingerprint: h("engine-build"),
    executableFingerprint: h("executable"),
    closureFingerprint: h("closure"),
    protocolFingerprint: h("protocol"),
    schemaFingerprint: h("schema"),
    releaseRoleManifestRoot: h("manifest"),
    candidateReleaseCommit: "0123456789abcdef0123456789abcdef01234567",
    qualificationEpoch: "1",
    predicateCompositionRootDigest: h("predicate"),
    gateCoreRuntimeClosureDigest: h("gate-runtime"),
    gateCoreImplementationClosureDigest: h("gate-implementation"),
    frameworkAuthorityRoot: h("framework"),
    releaseAuthorityRoot: h("release-authority"),
    workerEpoch: "epoch-1",
    executorSessionHash: h("executor-session"),
  });
  const binding = Object.freeze({
    release: lease,
    authorityRoot: lease.executorAuthorityRoot,
    workerEpoch: lease.workerEpoch,
    executorSessionHash: lease.executorSessionHash,
  });
  return issueRevmWorkerAuthorityIssuer({
    issue: () => binding,
    assertCurrent: (current) => {
      if (current.workerEpoch !== binding.workerEpoch || current.executorSessionHash !== binding.executorSessionHash) throw new Error("authority changed");
    },
  });
}

const workerQualification = Object.freeze({
  engineBuildFingerprint: h("engine-build"),
  executableFingerprint: h("executable"),
});
const qualification = Object.freeze({
  ...workerQualification,
  qualifiedExecutorRegistryRoot: h("executor-registry"),
  selectedExecutorLeafHash: h("executor-leaf"),
  releaseRoleManifestRoot: h("release-role-manifest"),
});

function fakeFactory(status: "returned" | "reverted" = "returned") {
  return {
    spawn: async (epoch: string) => {
      const lineListeners = new Set<(line: string) => void>();
      const exitListeners = new Set<(code: number | null) => void>();
      const emit = (line: string): void => { for (const listener of lineListeners) listener(line); };
      setTimeout(() => emit(encodeWorkerLine({ wireVersion: 1, kind: "hello", op: "hello", workerEpoch: epoch, engine: "revm", ...workerQualification })), 0);
      return {
        send: async (line: string) => {
          const request = decodeWorkerLine(line);
          if (request.kind !== "request") throw new Error("fake worker expected a request");
          const effects = {
            format: "revm-effects-v1" as const,
            bytes: "0xeffects",
            observedAccounts: request.observeAccounts,
            effectsHash: hashEffectsWire({ format: "revm-effects-v1", bytes: "0xeffects", observedAccounts: request.observeAccounts }),
          };
          const response: RevmWorkerResultV1 = {
            wireVersion: 1,
            kind: "response",
            op: "simulate",
            requestId: request.requestId,
            workerEpoch: request.workerEpoch,
            ownerRef: request.ownerRef,
            generationId: request.generationId,
            attemptId: request.attemptId,
            authority: request.authority,
            inputHash: request.inputHash,
            deadlineAtMs: request.deadlineAtMs,
            engine: "revm",
            engineBuildFingerprint: qualification.engineBuildFingerprint,
            source: request.source,
            caller: request.caller,
            observeAccounts: request.observeAccounts,
            programHash: request.program.programHash,
            status,
            output: "0xoutput",
            effects,
            ...(request.program.effectTransport === undefined ? {} : { effectTransport: request.program.effectTransport }),
            executionReceiptHash: "placeholder",
          };
          emit(encodeWorkerLine({ ...response, executionReceiptHash: hashExecutionReceipt(response) }));
        },
        onLine: (listener: (line: string) => void) => { lineListeners.add(listener); return () => lineListeners.delete(listener); },
        onExit: (listener: (code: number | null) => void) => { exitListeners.add(listener); return () => exitListeners.delete(listener); },
        kill: async () => { for (const listener of exitListeners) listener(0); },
        waitForExit: async () => true,
      };
    },
  };
}

test("final simulation fails closed when no qualified worker pool is present", async () => {
  const scheduler = new WorkScheduler();
  const port = createQualifiedFinalSimulationPort({ scheduler, client: createFailClosedRevmClient(), qualification, schemaHash, projection: projection() });
  const searchPipelinePort: SearchPipelineFinalSimulationPortV1<QualifiedFinalSimulationFactV1> = port;
  void searchPipelinePort;
  const result = await port.simulate(input());
  assert.deepEqual(result, { kind: "retryable", stage: "final-sim", code: "revm-worker-unavailable" });
  scheduler.assertPermitConservation();
  assert.equal(scheduler.snapshot().accounting.permitsIssued, 1);
  assert.equal(scheduler.snapshot().accounting.permitsReleased, 1);
});

test("generation cutoff remains distinct from the later current execution source", async () => {
  const scheduler = new WorkScheduler();
  const port = createQualifiedFinalSimulationPort({ scheduler, client: createFailClosedRevmClient(), qualification, schemaHash, projection: projection() });
  const value = input();
  assert.deepEqual(
    await port.simulate({
      ...value,
      binding: {
        ...value.binding,
        cutoff: { ...source, number: "99", hash: h("generation-cutoff"), stateRoot: h("generation-cutoff-state") },
      },
    }),
    { kind: "retryable", stage: "final-sim", code: "revm-worker-unavailable" },
  );
  assert.equal(scheduler.snapshot().accounting.permitsIssued, 1);
});

test("qualified worker receipt is converted to a search-pipeline-compatible final fact", async () => {
  const pool = new RevmWorkerPool({ factory: fakeFactory(), authority: authority(), qualification: workerQualification, maxWorkers: 1, timeoutMs: 100 });
  const scheduler = new WorkScheduler();
  bindSchedulerPerformanceJournal(scheduler, {
    qualifiedExecutorRegistryRoot: h("scheduler-registry"),
    executorAuthorityRoot: h("scheduler-authority"),
    workerEpoch: "scheduler-worker-epoch",
    executorSession: h("scheduler-executor-session"),
    authorityVersion: "1",
  });
  const performanceReader = issueSchedulerPerformanceReaderPort(scheduler);
  const client = new RevmSimulationClient({ pool });
  const port = createQualifiedFinalSimulationPort({ scheduler, client, qualification, schemaHash, projection: projection() });
  const result = await port.simulate(input());
  assert.equal(result.kind, "passed");
  if (result.kind === "passed") {
    assert.equal(result.receipt.kind, "final-simulation-passed");
    assert.equal(result.receipt.generationId, "generation-1");
    assert.equal(result.receipt.programHash, program().programHash);
    assert.equal(result.receipt.simulation.artifactProgramHash, program().programHash);
    assert.equal(result.receipt.simulation.wireProgramHash, hashFrozenProgram({ format: "frozen-program-v1", schemaHash, bytes: "0xprogram-bytes", programHash: "placeholder" }));
    assert.equal(result.receipt.simulation.status, "returned");
    assert.equal(result.receipt.simulation.engineBuildFingerprint, qualification.engineBuildFingerprint);
    assert.equal(result.receipt.simulation.executableFingerprint, qualification.executableFingerprint);
    assert.ok(result.schedulerJoinSeed);
    assert.ok(result.sixStepEvidence);
    const sixStep = port.sixStepEvidenceAuthority!.read(result.sixStepEvidence);
    assert.equal(sixStep.correlationId, h("correlation"));
    assert.equal(sixStep.programHash, result.receipt.programHash);
    assert.equal(sixStep.finalSimulationReceiptHash, result.receipt.receiptHash);
    const facts = sixStep.facts as Record<string, unknown>;
    assert.equal(facts.kind, "aloha.qualified-final-simulation-owner-facts-v1");
    assert.deepEqual(facts.executorQualification, qualification);
    assert.throws(() => port.sixStepEvidenceAuthority!.read({ ...result.sixStepEvidence! }), /was not issued/);
    const join = port.schedulerJoinAuthority!.read(result.schedulerJoinSeed);
    assert.equal(join.correlationId, h("correlation"));
    assert.equal(join.generationId, "generation-1");
    assert.deepEqual(join.source, source);
    assert.equal(join.programHash, program().programHash);
    assert.equal(join.finalSimulationReceiptHash, result.receipt.receiptHash);
    assert.equal(typeof join.schedulerCompletion, "object");
    const schedulerCompletion = readSchedulerWorkCompletionCapability(
      performanceReader,
      readSchedulerWorkCompletionHandle(performanceReader, join.schedulerCompletion),
    );
    assert.equal(schedulerCompletion.outcome, "completed");
    assert.deepEqual(schedulerCompletion.work, {
      workId: hashDomain("aloha/qualified-revm-final-simulation-request/v1", {
        correlationId: h("correlation"),
        generationId: program().generationId,
        routeHash: program().routeHash,
        artifactProgramHash: program().programHash,
      }),
      phase: "final-sim",
      workClassRef: "qualified-revm-final-simulation-v1",
      ownerRef: program().issuerRef,
      lane: "final-sim",
      resource: "final-sim",
      cost: "1",
      quotaKey: "final-sim",
    });
    assert.equal(Object.prototype.hasOwnProperty.call(result.receipt, "schedulerCompletion"), false);
    assert.equal(JSON.stringify(result.receipt).includes("schedulerCompletion"), false);
    assert.throws(() => port.schedulerJoinAuthority!.read({ ...result.schedulerJoinSeed! }), /was not issued/);
    assert.throws(() => port.schedulerJoinAuthority!.read(Object.freeze({})), /was not issued/);
    const otherPort = createQualifiedFinalSimulationPort({ scheduler, client, qualification, schemaHash, projection: projection() });
    assert.throws(() => otherPort.schedulerJoinAuthority!.read(result.schedulerJoinSeed!), /this owner/);
  }
  scheduler.assertPermitConservation();
  await pool.retireAll();
});

test("qualified reverted worker receipt issues an exact non-cloneable stage rejection capability", async () => {
  const pool = new RevmWorkerPool({ factory: fakeFactory("reverted"), authority: authority(), qualification: workerQualification, maxWorkers: 1, timeoutMs: 100 });
  const scheduler = new WorkScheduler();
  const client = new RevmSimulationClient({ pool });
  const port = createQualifiedFinalSimulationPort({ scheduler, client, qualification, schemaHash, projection: projection() });
  const result = await port.simulate(input());
  assert.equal(result.kind, "chainProvenRejected");
  assert.equal(Object.prototype.hasOwnProperty.call(result, "schedulerJoinSeed"), false);
  if (result.kind === "chainProvenRejected") {
    const receipt = port.rejectionAuthority.read(result.capability);
    assert.equal(receipt.stage, "final-sim");
    assert.equal(receipt.routeHash, program().routeHash);
    assert.equal(receipt.source.hash, source.hash);
    assert.equal(receipt.correlationId, h("correlation"));
    assert.equal(receipt.inputArtifactHash, program().programHash);
    assert.equal(receipt.programHash, program().programHash);
    assert.equal(receipt.code, "simulation-reverted");
    assert.equal(receipt.evidenceHash, result.evidenceHash);
    assert.throws(() => port.rejectionAuthority.read({ ...result.capability }), /was not issued/);
  }
  scheduler.assertPermitConservation();
  await pool.retireAll();
});

test("search pipeline accepts only the exact qualified final-sim rejection capability", async () => {
  const pool = new RevmWorkerPool({ factory: fakeFactory("reverted"), authority: authority(), qualification: workerQualification, maxWorkers: 1, timeoutMs: 100 });
  const scheduler = new WorkScheduler();
  const client = new RevmSimulationClient({ pool });
  const finalSimulation = createQualifiedFinalSimulationPort({ scheduler, client, qualification, schemaHash, projection: projection() });
  const artifact = program();
  const edgeId = h("pipeline-edge");
  const issuedHandle = Object.freeze({ opaque: Object.freeze(Object.create(null)) });
  const legs = Object.freeze([{ edgeId, ownerRef: h("pipeline-owner"), issuedHandle }]);
  const route = Object.freeze({ routeHash: artifact.routeHash, legs, routeBindingHash: routeBindingHash(legs) });
  const objectivePayload = Object.freeze({ kind: "qualified-final-sim-rejection-test" });
  const objectiveRef = hashDomain("aloha/search-objective/v1", objectivePayload);
  const binding = Object.freeze({
    generationId: artifact.generationId,
    readyRecordHash: h("pipeline-ready"),
    generationRefreshPolicyHash: h("pipeline-ready-policy"),
    cutoff: source,
    definitionCatalogRoot: h("pipeline-definitions"),
    instanceCatalogRoot: h("pipeline-instances"),
    graphRoot: h("pipeline-graph"),
    runtimeAuthority: projectRuntimeAuthorityDescriptorV1(createSignedReleaseRuntimeAuthorityDescriptorV1({
      authorityClass: "signed-release",
      runtimeBindingId: h("pipeline-runtime-binding"),
      releaseProvenanceHash: h("pipeline-release"),
      implementationCommit: "a".repeat(40),
    })),
    releaseProvenanceHash: h("pipeline-release"),
    candidatePartitionProofStorageHash: h("pipeline-partition-proof"),
    nominationClosureRoot: h("pipeline-nomination-closure"),
    nominationClosureStorageHash: h("pipeline-nomination-closure-storage"),
  });
  const lease = Object.freeze({
    binding,
    edges: Object.freeze([]),
    assertActive: () => undefined,
    resolveRouteHandle: () => { throw new Error("not reached"); },
  });
  const currentSource = Object.freeze({ sessionId: h("pipeline-source-session"), source, assertCurrent: () => undefined });
  const noRejection = Object.freeze({ read: () => { throw new TypeError("not issued"); } });
  const economicSafety = issueEconomicSafetyFinalizationServiceV1({
    authorityRoot: h("pipeline-economic-safety-authority"),
    implementationHash: h("pipeline-economic-safety-implementation"),
    releaseProvenanceHash: h("pipeline-release"),
    evaluator: Object.freeze({ evaluate: () => { throw new Error("rejected final simulation must not reach economic finalization"); } }),
  });
  const executionEvidence = new WeakMap<object, Readonly<Record<string, unknown>>>();
  const issueExecutionEvidence = () => {
    const body = Object.freeze({
      schemaVersion: 1 as const,
      kind: "aloha.execution-program-six-step-evidence-v1" as const,
      correlationId: h("correlation"),
      generationId: artifact.generationId,
      source,
      routeHash: artifact.routeHash,
      exactHash: h("pipeline-exact"),
      programHash: artifact.programHash,
      facts: Object.freeze({
        kind: "final-sim-test-execution-owner",
        callerMode: "top-level",
        preCalls: Object.freeze([]),
        observationPairs: Object.freeze([]),
        observeLogs: false,
        callSequence: Object.freeze([]),
        actionOwners: Object.freeze([Object.freeze({
          actionOwnerRef: artifact.issuerRef,
          obligationRoot: h("pipeline-obligation"),
        })]),
        obligationRoot: artifact.obligationRoot,
        declaredObligations: Object.freeze([Object.freeze({
          obligationRef: h("pipeline-obligation"),
          ownerRef: artifact.issuerRef,
          policy: "must-satisfy",
        })]),
      }),
    });
    const capability = Object.freeze(Object.create(null));
    executionEvidence.set(capability, Object.freeze({
      ...body,
      evidenceRoot: hashDomain("aloha/execution-program-six-step-evidence/v1", body),
    }));
    return capability;
  };
  const basePorts: SearchPipelinePortsV1<object, object, object, QualifiedFinalSimulationFactV1> = {
    planner: {
      rejectionAuthority: noRejection,
      plan: () => ({ kind: "planned", routeHash: route.routeHash, source, plan: Object.freeze({}), planHash: h("pipeline-plan") }),
    },
    exact: {
      rejectionAuthority: noRejection,
      evaluate: () => ({ kind: "verified", routeHash: route.routeHash, source, exact: Object.freeze({}), exactHash: h("pipeline-exact") }),
    },
    executionProgram: {
      rejectionAuthority: noRejection,
      sixStepEvidenceAuthority: {
        read: capability => {
          const evidence = executionEvidence.get(capability);
          if (evidence === undefined) throw new TypeError("execution evidence was not issued");
          return evidence as never;
        },
      },
      compile: () => ({ kind: "compiled", program: artifact as never, sixStepEvidence: issueExecutionEvidence() }),
    },
    finalSimulation,
    economicSafety,
    sixStepArtifacts: createProductionSixStepTailFixture([]),
    unsignedDryRun: { issue: () => { throw new Error("qualified rejection must not issue dry-run"); } },
  };
  const resolvedInput = {
    lease: lease as never,
    routeCandidateId: h("pipeline-candidate"),
    orderedEdgeIds: [edgeId],
    strategy: Object.freeze({}) as never,
    objective: { objectiveRef, payload: objectivePayload },
    currentSource,
    correlationId: h("correlation"),
    deadlineAtMs: performance.now() + 1_000,
    callerId: "caller-1",
  };
  const coarse = {
    kind: "bounded-unranked" as const,
    routeHash: route.routeHash,
    source,
    reasonCode: "coarse-not-under-test",
    evidenceHash: h("pipeline-bounded-unranked"),
  };
  const accepted = await runResolvedRoutePipeline(basePorts, resolvedInput, route, coarse);
  assert.equal(accepted.kind, "chainProvenRejected", JSON.stringify(accepted));
  if (accepted.kind !== "chainProvenRejected") throw new Error("qualified rejection was not returned");

  const cloned = await runResolvedRoutePipeline({
    ...basePorts,
    sixStepArtifacts: createProductionSixStepTailFixture([]),
    finalSimulation: {
      rejectionAuthority: finalSimulation.rejectionAuthority,
      simulate: () => ({ ...accepted, capability: { ...accepted.capability } }),
    },
  }, resolvedInput, route, coarse);
  assert.deepEqual(cloned, { kind: "invalidProgram", stage: "final-sim", code: "stage-terminal-authority-invalid" });
  scheduler.assertPermitConservation();
  await pool.retireAll();
});

test("final simulation carries an optional effect transport declaration through wire, fact, and receipt", async () => {
  const pool = new RevmWorkerPool({ factory: fakeFactory(), authority: authority(), qualification: workerQualification, maxWorkers: 1, timeoutMs: 100 });
  const scheduler = new WorkScheduler();
  const client = new RevmSimulationClient({ pool });
  const port = createQualifiedFinalSimulationPort({ scheduler, client, qualification, schemaHash, projection: effectProjection() });
  const result = await port.simulate({ ...input(), program: effectProgram() });
  assert.equal(result.kind, "passed");
  if (result.kind === "passed") {
    assert.deepEqual(result.receipt.effectTransport?.observeTokenBalances, effectProgram().effectTransport?.observeTokenBalances);
    assert.deepEqual(result.receipt.simulation.effectTransport, effectProgram().effectTransport);
  }
  await pool.retireAll();
});

test("bridge rejects a caller-injected structural client or scheduler", () => {
  assert.throws(
    () => createQualifiedFinalSimulationPort({ scheduler: { run: async () => undefined } as never, client: createFailClosedRevmClient(), qualification, schemaHash, projection: projection() }),
    /WorkScheduler/,
  );
  assert.throws(
    () => createQualifiedFinalSimulationPort({ scheduler: new WorkScheduler(), client: { simulate: async () => ({}) } as never, qualification, schemaHash, projection: projection() }),
    /RevmSimulationClient/,
  );
});
