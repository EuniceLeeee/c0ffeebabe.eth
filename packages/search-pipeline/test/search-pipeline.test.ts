import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain, type Hash } from "../../canonical-codec/src/index.ts";
import { erc20AssetPortBindingV1 } from "../../asset-ref/src/index.ts";
import type {
  GraphLeaseBindingV1,
  GraphRouteHandle,
  GraphViewLeaseV1,
  IssuedRouteHandle,
  RuntimeGraphEdgeV1,
} from "../../graph/src/index.ts";
import { enumerateClosedLoopPlanningProblem } from "../../planner/src/index.ts";
import { readIssuedCoarseRouteBindingV1 } from "../../coarse-economics/src/index.ts";
import {
  routeBindingHash,
  runSearchPipeline,
  sealExecutionProgram,
  sealUnsignedDryRunReceipt,
  type CurrentSourceSessionV1,
  type RoutePipelineInputV1,
  type RoutePipelinePortsV1,
  type RoutePipelineOutcomeV1,
  type SourceViewV1,
} from "../src/index.ts";
import { issueRouteCyclePlanningProblem } from "./issued-strategy.ts";
import { sealEmptyNominationClosureFixture } from "../../../specs/nomination-authority/test/fixture.ts";
import { createContractEconomicSafetyService } from "./economic-safety-fixture.ts";
import type {
  ExecutionProgramSixStepEvidenceV1,
  FinalSimulationSixStepEvidenceV1,
} from "../src/index.ts";
import { createProductionSixStepTailFixture } from "./production-six-step-fixture.ts";
import {
  createSignedReleaseRuntimeAuthorityDescriptorV1,
  projectRuntimeAuthorityDescriptorV1,
} from "../../runtime-authority/src/index.ts";

/**
 * These are contract fixtures only.  Every owner is an opaque port and no
 * fixture claims an EVM, RPC, or live-search result.
 */

const h = (value: string): Hash => hashDomain("test/search-pipeline", value);
const assetIn = erc20AssetPortBindingV1("1", `0x${h("asset-in").slice(-40)}`);
const assetMid = erc20AssetPortBindingV1("1", `0x${h("asset-mid").slice(-40)}`);
const noRejectionAuthority = Object.freeze({ read: () => { throw new TypeError("rejection-not-issued"); } });
const runtimeAuthorityDescriptor = createSignedReleaseRuntimeAuthorityDescriptorV1({
  authorityClass: "signed-release",
  runtimeBindingId: hashDomain("test/search-pipeline/runtime-binding/v1", 1),
  releaseProvenanceHash: h("release"),
  implementationCommit: "a".repeat(40),
});

const source: SourceViewV1 = Object.freeze({
  chainId: "1",
  number: "100",
  hash: h("block"),
  stateRoot: h("state"),
});
const nomination = sealEmptyNominationClosureFixture({
  cutoff: Object.freeze({ chainId: "1", number: "99", hash: h("cutoff"), stateRoot: h("cutoff-state") }),
  familyId: "search-pipeline-fixture-family",
  familyDefinitionHash: h("nomination-family-definition"),
  sourcePlanIdentity: h("nomination-source-plan-identity"),
  sourcePlanLeafDigest: h("nomination-source-plan-leaf"),
  nominationProgramRoot: h("nomination-program"),
  nominationProgramProposalLeafDigest: h("nomination-program-proposal"),
  qualificationRoot: h("nomination-qualification"),
  recentObservationRoot: h("nomination-recent-observation"),
  sourceExecutionSetRoot: h("nomination-source-execution-set"),
  sourceCoverageRoot: h("nomination-source-coverage"),
  persistedExecutionRoot: h("nomination-persisted-execution"),
  resultPartitionRoot: h("nomination-result-partition"),
});

const binding: GraphLeaseBindingV1 = Object.freeze({
  generationId: "generation-1",
  readyRecordHash: h("ready"),
  generationRefreshPolicyHash: h("policy"),
  cutoff: Object.freeze({
    chainId: "1",
    number: "99",
    hash: h("cutoff"),
    stateRoot: h("cutoff-state"),
  }),
  definitionCatalogRoot: h("definitions"),
  instanceCatalogRoot: h("instances"),
  graphRoot: h("graph"),
  runtimeAuthority: projectRuntimeAuthorityDescriptorV1(runtimeAuthorityDescriptor),
  releaseProvenanceHash: h("release"),
  candidatePartitionProofStorageHash: h("partition-proof"),
  nominationClosureRoot: nomination.closure.root,
  nominationClosureStorageHash: nomination.storageHash,
});

const objectivePayload = Object.freeze({
  numeraireAssetRef: assetIn.assetRef,
  minNetGain: "2",
  maxGas: "1000000",
  maxValueAtRisk: "1000000000000000000",
});
const objectiveRef = hashDomain("aloha/search-objective/v1", objectivePayload);
const graphHandles = [
  Object.freeze(Object.create(null)) as GraphRouteHandle,
  Object.freeze(Object.create(null)) as GraphRouteHandle,
];
const issuedHandles: IssuedRouteHandle[] = [
  Object.freeze({ opaque: Object.freeze(Object.create(null)) }),
  Object.freeze({ opaque: Object.freeze(Object.create(null)) }),
];

const edges: RuntimeGraphEdgeV1[] = [
  Object.freeze({
    edgeId: h("edge-a"),
    inputAssetPorts: Object.freeze([{ ...assetIn, portRef: h("port-a-in"), ordinal: "0" }]),
    outputAssetPorts: Object.freeze([{ ...assetMid, portRef: h("port-a-out"), ordinal: "0" }]),
    opaqueTransitionRef: h("transition-a"),
    constraintRefs: Object.freeze([h("constraint-a")]),
    owningFamilyId: "opaque-owner-a",
    owningFamilyDefinitionHash: h("owner-definition-a"),
    owningInstanceKey: "opaque-instance-a",
    instancePublicationHash: h("publication-a"),
    staticProjectionHash: h("static-projection-a"),
    projectionHash: h("projection-a"),
    rehydrationRef: Object.freeze({
      familyDefinitionHash: h("owner-definition-a"),
      instanceKey: "opaque-instance-a",
      instancePublicationHash: h("publication-a"),
      staticProjectionMemoHash: h("projection-memo-a"),
      requestedArtifactDependencyRoot: h("requested-dependencies-a"),
    }),
    routeHandle: graphHandles[0]!,
  }),
  Object.freeze({
    edgeId: h("edge-b"),
    inputAssetPorts: Object.freeze([{ ...assetMid, portRef: h("port-b-in"), ordinal: "0" }]),
    outputAssetPorts: Object.freeze([{ ...assetIn, portRef: h("port-b-out"), ordinal: "0" }]),
    opaqueTransitionRef: h("transition-b"),
    constraintRefs: Object.freeze([h("constraint-b")]),
    owningFamilyId: "opaque-owner-b",
    owningFamilyDefinitionHash: h("owner-definition-b"),
    owningInstanceKey: "opaque-instance-b",
    instancePublicationHash: h("publication-b"),
    staticProjectionHash: h("static-projection-b"),
    projectionHash: h("projection-b"),
    rehydrationRef: Object.freeze({
      familyDefinitionHash: h("owner-definition-b"),
      instanceKey: "opaque-instance-b",
      instancePublicationHash: h("publication-b"),
      staticProjectionMemoHash: h("projection-memo-b"),
      requestedArtifactDependencyRoot: h("requested-dependencies-b"),
    }),
    routeHandle: graphHandles[1]!,
  }),
];

const planningProblem = issueRouteCyclePlanningProblem({
  generationId: binding.generationId,
  definitionCatalogRoot: binding.definitionCatalogRoot,
  graphRoot: binding.graphRoot,
  edges,
  releaseProvenanceHash: binding.releaseProvenanceHash,
  readyRecordHash: binding.readyRecordHash,
  sourceHash: h("block"),
  correlationId: h("correlation"),
  objectiveRef,
  runtimeAuthority: runtimeAuthorityDescriptor,
});
const candidate = enumerateClosedLoopPlanningProblem({ problem: planningProblem }).candidates[0]!;

function routeLegsFor(edgeIds: readonly Hash[]) {
  return Object.freeze(edgeIds.map(edgeId => {
    const index = edges.findIndex(edge => edge.edgeId === edgeId);
    if (index < 0) throw new Error("test route edge missing");
    return { edgeId, ownerRef: h(`owner-${index}`), issuedHandle: issuedHandles[index]! };
  }));
}

const routeLegs = routeLegsFor(candidate.legs.map(leg => leg.edgeId));
const routeHash = h("route");
const routeBinding = routeBindingHash(routeLegs);
const route = Object.freeze({ routeHash, legs: routeLegs, routeBindingHash: routeBinding });
const actionObligation = h("action-obligation");
const programObligationRoot = hashDomain("aloha/search-runtime-obligation-root/v1", [actionObligation]);
const executionEvidence = new WeakMap<object, ExecutionProgramSixStepEvidenceV1>();
const finalEvidence = new WeakMap<object, FinalSimulationSixStepEvidenceV1>();

function issueExecutionEvidence(programHash: Hash): object {
  const actionOwnerRef = h("program-issuer");
  const facts = Object.freeze({
    kind: "aloha.search-runtime.execution-program-owner-facts-v1",
    callerMode: "top-level",
    preCalls: Object.freeze([]),
    observationPairs: Object.freeze([]),
    observeLogs: false,
    callSequence: Object.freeze([]),
    actionOwners: Object.freeze([Object.freeze({
      familyDefinitionHash: h("action-family"),
      routeBindingHash: routeBinding,
      actionOwnerId: "search-pipeline-action-owner",
      actionOwnerRef,
      actionHash: h("action"),
      actionArtifactHash: h("action-artifact"),
      exactEvaluationHash: h("exact"),
      payload: Object.freeze({ obligationRoot: actionObligation }),
      payloadHash: h("action-payload"),
      inputs: Object.freeze([]),
      outputs: Object.freeze([]),
      obligationRoot: actionObligation,
    })]),
    obligationRoot: programObligationRoot,
    declaredObligations: Object.freeze([{ obligationRef: actionObligation, ownerRef: actionOwnerRef, policy: "must-satisfy" as const }]),
  });
  const body = { schemaVersion: 1 as const, kind: "aloha.execution-program-six-step-evidence-v1" as const, correlationId: h("correlation"), generationId: binding.generationId, source, routeHash, exactHash: h("exact"), programHash, facts };
  const capability = Object.freeze(Object.create(null));
  executionEvidence.set(capability, Object.freeze({ ...body, evidenceRoot: hashDomain("aloha/execution-program-six-step-evidence/v1", body) }));
  return capability;
}

function issueFinalEvidence(programHash: Hash, receiptHash: Hash): object {
  const facts = Object.freeze({ kind: "contract-final-owner", workerReceipt: Object.freeze({ executionReceiptHash: h("execution-receipt") }) });
  const body = { schemaVersion: 1 as const, kind: "aloha.final-simulation-six-step-evidence-v1" as const, correlationId: h("correlation"), generationId: binding.generationId, source, programHash, finalSimulationReceiptHash: receiptHash, facts };
  const capability = Object.freeze(Object.create(null));
  finalEvidence.set(capability, Object.freeze({ ...body, evidenceRoot: hashDomain("aloha/final-simulation-six-step-evidence/v1", body) }));
  return capability;
}

function makeLease(): GraphViewLeaseV1 {
  return {
    binding,
    edges: Object.freeze(edges),
    assertActive: async () => {},
    resolveRouteHandle: async (edgeId: Hash, handle: GraphRouteHandle) => {
      const index = edges.findIndex(edge => edge.edgeId === edgeId);
      if (index < 0 || handle !== graphHandles[index]) throw new Error("unexpected graph handle");
      return issuedHandles[index]!;
    },
    release: () => {},
    leaseId: h("lease"),
    released: false,
  } as unknown as GraphViewLeaseV1;
}

function makeSourceSession(): CurrentSourceSessionV1 {
  return Object.freeze({ sessionId: h("source-session"), source, assertCurrent: () => {} });
}

function makeInput(): RoutePipelineInputV1 {
  return {
    lease: makeLease(),
    planningProblem,
    strategyCompositionRoot: planningProblem.strategyCompositionRoot,
    objective: { objectiveRef, payload: objectivePayload },
    currentSource: makeSourceSession(),
    correlationId: h("correlation"),
    deadlineAtMs: Number.MAX_SAFE_INTEGER,
    callerId: "contract-test-caller",
    admission: { topK: 0, boundedUnrankedBudget: 1 },
  };
}

type Mode =
  | "success"
  | "planner-failure"
  | "planner-rejected"
  | "exact-failure"
  | "exact-rejected"
  | "program-failure"
  | "program-rejected"
  | "final-sim-failure"
  | "final-sim-rejected"
  | "source-mutation"
  | "simulation-source-mutation"
  | "generation-mutation"
  | "ordered-edge-mutation"
  | "route-binding-mutation"
  | "simulation-program-mutation";

function makePorts(
  mode: Mode,
  events: string[],
  afterFailure: (stage: "planner" | "exact" | "execution-program" | "final-sim") => void = () => {},
): RoutePipelinePortsV1<object, object, object, object> {
  return {
    route: {
      resolve: () => {
        events.push("route");
        if (mode === "ordered-edge-mutation") {
          const mutatedLegs = Object.freeze([routeLegs[1]!, routeLegs[0]!]);
          return { routeHash, legs: mutatedLegs, routeBindingHash: routeBindingHash(mutatedLegs) };
        }
        if (mode === "route-binding-mutation") return { ...route, routeBindingHash: h("mutated-route-binding") };
        return route;
      },
    },
    coarse: {
      assess: ({ binding: coarseBinding }) => {
        events.push("coarse");
        const bound = readIssuedCoarseRouteBindingV1(coarseBinding);
        assert.deepEqual(bound.legs.map(leg => leg.transitionRef), candidate.legs.map(leg => edges.find(edge => edge.edgeId === leg.edgeId)!.opaqueTransitionRef));
        return null;
      },
    },
    planner: {
      rejectionAuthority: noRejectionAuthority,
      plan: () => {
        events.push("planner");
        if (mode === "planner-failure") {
          afterFailure("planner");
          return { kind: "retryable", stage: "planner", code: "planner-failure" };
        }
        if (mode === "planner-rejected") return { kind: "chainProvenRejected", stage: "planner", code: "caller-rejected", evidenceHash: h("caller-evidence") } as never;
        return {
          kind: "planned",
          routeHash,
          source: mode === "source-mutation" ? { ...source, hash: h("mutated-source") } : source,
          plan: Object.freeze({ kind: "opaque-plan" }),
          planHash: h("plan"),
        };
      },
    },
    exact: {
      rejectionAuthority: noRejectionAuthority,
      evaluate: () => {
        events.push("exact");
        if (mode === "exact-failure") {
          afterFailure("exact");
          return { kind: "retryable", stage: "exact", code: "exact-failure" };
        }
        if (mode === "exact-rejected") return { kind: "chainProvenRejected", stage: "exact", code: "caller-rejected", evidenceHash: h("caller-evidence") } as never;
        return {
          kind: "verified",
          routeHash,
          source,
          exact: Object.freeze({ kind: "opaque-exact" }),
          exactHash: h("exact"),
        };
      },
    },
    executionProgram: {
      rejectionAuthority: noRejectionAuthority,
      sixStepEvidenceAuthority: { read: capability => {
        const value = executionEvidence.get(capability);
        if (value === undefined) throw new TypeError("execution evidence was not issued");
        return value;
      } },
      compile: () => {
        events.push("execution-program");
        if (mode === "program-failure") {
          afterFailure("execution-program");
          return { kind: "retryable", stage: "execution-program", code: "program-failure" };
        }
        if (mode === "program-rejected") return { kind: "chainProvenRejected", stage: "execution-program", code: "caller-rejected", evidenceHash: h("caller-evidence") } as never;
        const program = sealExecutionProgram({
          kind: "execution-program",
          generationId: mode === "generation-mutation" ? "mutated-generation" : binding.generationId,
          source,
          routeHash,
          programBytes: "0xopaque-program",
          payloadHash: h("program-payload"),
          issuerRef: h("program-issuer"),
            obligationRoot: programObligationRoot,
        });
        return {
          kind: "compiled",
          program,
          sixStepEvidence: issueExecutionEvidence(program.programHash),
        };
      },
    },
    finalSimulation: {
      rejectionAuthority: noRejectionAuthority,
      sixStepEvidenceAuthority: { read: capability => {
        const value = finalEvidence.get(capability);
        if (value === undefined) throw new TypeError("final evidence was not issued");
        return value;
      } },
      simulate: ({ program }) => {
        events.push("final-sim");
        if (mode === "final-sim-failure") {
          afterFailure("final-sim");
          return { kind: "retryable", stage: "final-sim", code: "final-sim-failure" };
        }
        if (mode === "final-sim-rejected") return { kind: "chainProvenRejected", stage: "final-sim", code: "reverted", evidenceHash: h("revert-evidence") } as never;
        const receiptHash = h("simulation-receipt");
        return {
          kind: "passed",
          receipt: {
            kind: "final-simulation-passed",
            generationId: binding.generationId,
            source: mode === "simulation-source-mutation" ? { ...source, stateRoot: h("mutated-state") } : source,
            simulation: Object.freeze({ kind: "opaque-simulation" }),
            programHash: mode === "simulation-program-mutation" ? h("different-program") : program.programHash,
            effectsHash: h("effects"),
            receiptHash,
          },
          sixStepEvidence: issueFinalEvidence(program.programHash, receiptHash),
        };
      },
    },
    economicSafety: createContractEconomicSafetyService(binding.releaseProvenanceHash, h),
    sixStepArtifacts: createProductionSixStepTailFixture(events),
    unsignedDryRun: {
      issue: input => {
        events.push("unsigned-dry-run");
        return sealUnsignedDryRunReceipt(input);
      },
    },
  };
}

async function run(mode: Mode): Promise<{ result: RoutePipelineOutcomeV1<object>; events: string[] }> {
  const events: string[] = [];
  const result = await runSearchPipeline(makePorts(mode, events), makeInput());
  return { result, events };
}

function terminalEntry(result: RoutePipelineOutcomeV1<object>) {
  assert.equal(result.kind, "route-set-terminal");
  const entry = result.receipt.accounting.entries[0];
  assert.ok(entry);
  return entry;
}

test("runSearchPipeline completes the opaque contract chain to an unsigned dry-run", async () => {
  const { result, events } = await run("success");
  assert.equal(result.kind, "unsigned-dry-run", `${JSON.stringify(result)} events=${events.join("|")}`);
  assert.deepEqual(events, ["route", "coarse", "planner", "six-step-3", "exact", "six-step-4", "execution-program", "six-step-5", "final-sim", "six-step-6", "unsigned-dry-run"]);
  assert.equal(result.receipt.kind, "aloha.unsigned-dry-run-v1");
  assert.equal(result.receipt.signer, null);
  assert.equal(result.receipt.transactionHash, null);
  assert.equal(result.schedulerResourceJoin, null);
  assert.deepEqual(result.receipt.orderedEdgeIds, candidate.legs.map(leg => leg.edgeId));
  assert.deepEqual(result.accounting.entries[0]!.legs, candidate.legs);
  assert.equal(result.accounting.total, 1);
  assert.equal(result.accounting.selected, 1);
  assert.equal(result.accounting.pruned, 0);
  assert.equal(result.accounting.notProbed, 0);
  assert.equal(result.accounting.failed, 0);
});

test("planner, exact, program, and final-sim failures stop only downstream stages", async () => {
  const cases: readonly [Mode, readonly string[], string][] = [
    ["planner-failure", ["route", "coarse", "planner"], "planner:planner-failure"],
    ["exact-failure", ["route", "coarse", "planner", "six-step-3", "exact"], "exact:exact-failure"],
    ["program-failure", ["route", "coarse", "planner", "six-step-3", "exact", "six-step-4", "execution-program"], "execution-program:program-failure"],
    ["final-sim-failure", ["route", "coarse", "planner", "six-step-3", "exact", "six-step-4", "execution-program", "six-step-5", "final-sim"], "final-sim:final-sim-failure"],
  ];
  for (const [mode, expectedEvents, reasonCode] of cases) {
    const { result, events } = await run(mode);
    assert.deepEqual(events, expectedEvents, mode);
    assert.equal(result.kind, "route-set-terminal", mode);
    assert.equal(result.receipt.outcome, "retryable", mode);
    assert.equal(terminalEntry(result).disposition, "selected", mode);
    assert.equal(terminalEntry(result).terminalKind, "retryable", mode);
    assert.equal(terminalEntry(result).reasonCode, reasonCode, mode);
  }
});

test("every stage failure is fenced against a source change before a terminal can be issued", async () => {
  for (const mode of ["planner-failure", "exact-failure", "program-failure", "final-sim-failure"] as const) {
    let stale = false;
    const events: string[] = [];
    const currentSource = Object.freeze({
      sessionId: h(`source-session:${mode}`),
      source,
      assertCurrent: () => {
        if (stale) throw new TypeError(`current-source-stale:${mode}`);
      },
    });
    const result = await runSearchPipeline(
      makePorts(mode, events, () => { stale = true; }),
      { ...makeInput(), currentSource },
    );
    assert.deepEqual(result, { kind: "retryable", stage: "route", code: "search-context-unavailable" }, mode);
  }
});

test("a plain structural chain rejection is invalid and cannot complete the candidate set", async () => {
  const { result, events } = await run("final-sim-rejected");
  assert.deepEqual(events, ["route", "coarse", "planner", "six-step-3", "exact", "six-step-4", "execution-program", "six-step-5", "final-sim"]);
  assert.equal(result.kind, "route-set-terminal");
  assert.equal(result.schedulerResourceJoin, null);
  assert.equal(result.receipt.outcome, "invalidProgram");
  assert.equal(result.receipt.accounting.selected, 1);
  assert.equal(terminalEntry(result).terminalKind, "invalidProgram");
  assert.equal(terminalEntry(result).reasonCode, "final-sim:stage-terminal-authority-invalid");
  assert.equal(terminalEntry(result).evidenceHash, null);
});

test("plain planner, exact, and execution rejections cannot become healthy terminals", async () => {
  for (const mode of ["planner-rejected", "exact-rejected", "program-rejected"] as const) {
    const { result } = await run(mode);
    assert.equal(result.kind, "route-set-terminal", mode);
    assert.equal(result.receipt.outcome, "invalidProgram", mode);
    assert.equal(terminalEntry(result).terminalKind, "invalidProgram", mode);
    assert.equal(terminalEntry(result).reasonCode?.endsWith("stage-terminal-authority-invalid"), true, mode);
  }
});

test("retryable and invalidProgram stage terminals require exact keys and the owning stage", async () => {
  for (const terminal of [
    { kind: "retryable", stage: "planner", code: "temporary", extra: true },
    { kind: "invalidProgram", stage: "exact", code: "wrong-owner" },
  ] as const) {
    const events: string[] = [];
    const base = makePorts("success", events);
    const result = await runSearchPipeline({
      ...base,
      planner: { rejectionAuthority: noRejectionAuthority, plan: () => terminal as never },
    }, makeInput());
    assert.equal(result.kind, "route-set-terminal");
    assert.equal(result.receipt.outcome, "invalidProgram");
    assert.equal(terminalEntry(result).reasonCode, "planner:stage-terminal-authority-invalid");
  }
});

test("final simulation cannot substitute a missing or differently-bound execution program", async () => {
  const missingProgram = await run("program-failure");
  assert.equal(missingProgram.events.includes("final-sim"), false);

  const mutatedProgram = await run("simulation-program-mutation");
  assert.deepEqual(mutatedProgram.events, ["route", "coarse", "planner", "six-step-3", "exact", "six-step-4", "execution-program", "six-step-5", "final-sim"]);
  assert.equal(terminalEntry(mutatedProgram.result).reasonCode, "final-sim:simulation-binding-mismatch");
});

test("source and generation mutations are fail-closed before unsigned issuance", async () => {
  const sourceResult = await run("source-mutation");
  assert.equal(terminalEntry(sourceResult.result).reasonCode, "planner:plan-binding-mismatch");
  assert.equal(sourceResult.events.includes("exact"), false);

  const simulationSourceResult = await run("simulation-source-mutation");
  assert.equal(terminalEntry(simulationSourceResult.result).reasonCode, "final-sim:simulation-binding-mismatch");
  assert.equal(simulationSourceResult.events.includes("unsigned-dry-run"), false);

  const generationResult = await run("generation-mutation");
  assert.equal(terminalEntry(generationResult.result).reasonCode, "execution-program:program-binding-mismatch");
  assert.equal(generationResult.events.includes("final-sim"), false);
});

test("ordered-edge and route-binding mutations cannot reach planner", async () => {
  for (const mode of ["ordered-edge-mutation", "route-binding-mutation"] as const) {
    const { result, events } = await run(mode);
    assert.deepEqual(events, ["route"], mode);
    assert.equal(result.kind, "invalidProgram", mode);
    if (result.kind !== "invalidProgram") throw new Error("route mutation was not rejected");
    assert.equal(result.stage, "route", mode);
  }
});
