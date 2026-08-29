import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain, type Hash } from "../../canonical-codec/src/index.ts";
import type { PlannedRouteCandidateV1 } from "../../planner/src/index.ts";
import {
  RevmSimulationClient,
  decodeWorkerLine,
  encodeWorkerLine,
  hashEffectsWire,
  hashExecutionReceipt,
  type RevmWorkerResultV1,
} from "../../../runtime/revm-workers/src/index.ts";
import { RevmWorkerPool } from "../../../runtime/revm-workers/src/lifecycle.ts";
import { issueRevmWorkerAuthorityIssuer } from "../../../runtime/revm-workers/src/internal/authority.ts";
import { decodeRuntimeReleaseExecutorLeaseV1 } from "../../../specs/release-authority/src/index.ts";
import { WorkScheduler } from "../../scheduler/src/index.ts";
import { createQualifiedFinalSimulationPort } from "../../final-sim/src/index.ts";
import {
  ProducerRuntimeV1,
  type CanonicalHead,
  type ProducerHeadFactsCapabilityV1,
  type ProducerHeadFactsV1,
  type ProducerHeadTerminalCapabilityV1,
  type ProducerLaneRunInputV1,
  type ProducerSessionV1,
  type ProducerTerminalV1,
  readIssuedProducerLaneSearchTerminalCapabilityV1,
  readIssuedProducerFinalFullFamilyTerminalSetV1,
  producerHeadFactsRootV1,
  producerLaneTerminalSetRootV1,
  producerOrderedHashRootV1,
} from "../src/index.ts";
import {
  issueProducerBoundTriggerV1,
  issueProducerIngressPortV1,
  issueProducerCurrentSourceHeadPortV1,
  issueProducerLanePortV1,
  issueProducerHeadTerminalCapabilityV1,
  issueProducerPerformancePortV1,
  issueProducerSessionOwnerV1,
  issueProducerTerminalPortV1,
  readIssuedProducerBackrunIntakeV1,
  readIssuedProducerBoundTriggerV1,
  readIssuedProducerLaneFactsV1,
  readIssuedProducerLaneFailureObservationV1,
  readIssuedProducerLaneCandidateTerminalObservationsV1,
  readIssuedProducerLanePlannerEnumerationV1,
  readIssuedProducerLaneSixStepTraceV1,
  readIssuedProducerHeadFactsCapabilityV1,
  readIssuedProducerHeadSchedulerCompletionV1,
  readIssuedProducerHeadTerminalCapabilityV1,
} from "../src/internal/owners.ts";
import { issueProducerIngressSourceForTestV1 } from "./fixtures/ingress-source.ts";
import {
  cloneTerminalCapability,
  createSearchTerminalFixture,
  type SearchTerminalMode,
} from "./fixtures/search-terminal.ts";

const h = (domain: string, value: unknown): Hash => hashDomain(`test/producer/${domain}`, value);
const workerQualification = Object.freeze({ engineBuildFingerprint: h("worker-engine", 1), executableFingerprint: h("worker-executable", 1) });

function admittedHead(input: { readonly head: CanonicalHead; readonly revision: string }, ordinal = "1") {
  return Object.freeze({
    admissionId: h("performance-admission", { head: input.head, revision: input.revision, ordinal }),
    ordinal,
    headHash: input.head.hash,
    revision: input.revision,
  });
}

function readAdmittedHead(value: unknown) {
  if (value === null || typeof value !== "object" || !("admissionId" in value)) throw new TypeError("test eligible head is not admitted");
  return value as ReturnType<typeof admittedHead>;
}

function qualifiedWorkerAuthority() {
  const lease = decodeRuntimeReleaseExecutorLeaseV1({
    bindingId: h("worker-binding", 1), releaseProvenanceHash: h("worker-provenance", 1), executorAuthorityRoot: h("worker-authority", 1),
    qualifiedExecutorRegistryRoot: h("worker-registry", 1), selectedExecutorLeafHash: h("worker-leaf", 1), executorKind: "producer-test-revm",
    engineBuildFingerprint: workerQualification.engineBuildFingerprint, executableFingerprint: workerQualification.executableFingerprint,
    closureFingerprint: h("worker-closure", 1), protocolFingerprint: h("worker-protocol", 1), schemaFingerprint: h("worker-schema", 1),
    releaseRoleManifestRoot: h("worker-manifest", 1), candidateReleaseCommit: "0123456789abcdef0123456789abcdef01234567", qualificationEpoch: "1",
    predicateCompositionRootDigest: h("worker-predicate", 1), gateCoreRuntimeClosureDigest: h("worker-runtime", 1),
    gateCoreImplementationClosureDigest: h("worker-implementation", 1), frameworkAuthorityRoot: h("worker-framework", 1),
    releaseAuthorityRoot: h("worker-release", 1), workerEpoch: "producer-test-epoch", executorSessionHash: h("worker-session", 1),
  });
  const binding = Object.freeze({ release: lease, authorityRoot: lease.executorAuthorityRoot, workerEpoch: lease.workerEpoch, executorSessionHash: lease.executorSessionHash });
  return issueRevmWorkerAuthorityIssuer({ issue: () => binding, assertCurrent: current => {
    if (current.workerEpoch !== binding.workerEpoch || current.executorSessionHash !== binding.executorSessionHash) throw new Error("worker authority changed");
  } });
}

function revertedWorkerFactory() {
  return {
    spawn: async (epoch: string) => {
      const lines = new Set<(line: string) => void>();
      const exits = new Set<(code: number | null) => void>();
      const emit = (line: string) => { for (const listener of lines) listener(line); };
      setTimeout(() => emit(encodeWorkerLine({ wireVersion: 1, kind: "hello", op: "hello", workerEpoch: epoch, engine: "revm", ...workerQualification })), 0);
      return {
        send: async (line: string) => {
          const request = decodeWorkerLine(line);
          if (request.kind !== "request") throw new Error("qualified worker expected a request");
          const effects = { format: "revm-effects-v1" as const, bytes: "0xeffects", observedAccounts: request.observeAccounts,
            effectsHash: hashEffectsWire({ format: "revm-effects-v1", bytes: "0xeffects", observedAccounts: request.observeAccounts }) };
          const response: RevmWorkerResultV1 = {
            wireVersion: 1, kind: "response", op: "simulate", requestId: request.requestId, workerEpoch: request.workerEpoch,
            ownerRef: request.ownerRef, generationId: request.generationId, attemptId: request.attemptId, authority: request.authority,
            inputHash: request.inputHash, deadlineAtMs: request.deadlineAtMs, engine: "revm", engineBuildFingerprint: workerQualification.engineBuildFingerprint,
            source: request.source, caller: request.caller, observeAccounts: request.observeAccounts, programHash: request.program.programHash,
            status: "reverted", output: "0x", effects, executionReceiptHash: "placeholder",
          };
          emit(encodeWorkerLine({ ...response, executionReceiptHash: hashExecutionReceipt(response) }));
        },
        onLine: (listener: (line: string) => void) => { lines.add(listener); return () => lines.delete(listener); },
        onExit: (listener: (code: number | null) => void) => { exits.add(listener); return () => exits.delete(listener); },
        kill: async () => { for (const listener of exits) listener(0); },
        waitForExit: async () => true,
      };
    },
  };
}

function head(number: string, seed: string): CanonicalHead {
  return Object.freeze({ chainId: "1", number, hash: h("head", seed), parentHash: h("parent", seed), stateRoot: h("state", seed) });
}

function pendingSnapshot(value: CanonicalHead, hashes: readonly Hash[]) {
  const body = {
    pendingNumber: (BigInt(value.number) + 1n).toString(),
    parentHash: value.hash,
    orderedTransactionHashes: Object.freeze([...hashes]),
    orderedTransactionHashesRoot: hashDomain("aloha/public-pending-transaction-set/v1", hashes),
    transactionCount: hashes.length.toString(),
  };
  return Object.freeze({ ...body, snapshotHash: hashDomain("aloha/public-pending-snapshot/v1", { head: value, ...body }) });
}

type BackrunObservation = "empty" | "pending" | "unavailable";

async function ingressEnvelope(value: CanonicalHead, backrun: BackrunObservation = "empty") {
  const source = issueProducerIngressSourceForTestV1({
    async observe({ head: observedHead }) {
      const txHash = h("pending-tx", observedHead);
      const transaction = Object.freeze({ hash: txHash, from: h("pending-sender", observedHead) });
      const snapshot = pendingSnapshot(observedHead, backrun === "pending" ? [txHash] : []);
      return {
        head: observedHead,
        blockscan: { input: Object.freeze({ kind: "blockscan" }) },
        backrun: backrun === "pending"
          ? {
            kind: "pending-transaction" as const,
            snapshot,
            txHash,
            affectedEdgeIds: Object.freeze([]),
            pendingEvidenceHash: hashDomain("aloha/public-pending-transaction-evidence/v2", { head: observedHead, snapshotHash: snapshot.snapshotHash, transaction }),
            input: Object.freeze({ pendingTransaction: transaction }),
          }
          : backrun === "empty"
            ? {
              kind: "observed-empty" as const,
              snapshot,
              absenceEvidenceHash: hashDomain("aloha/public-pending-absence-evidence/v1", { head: observedHead, snapshotHash: snapshot.snapshotHash }),
            }
            : {
              kind: "unavailable" as const,
              snapshot: null,
              reasonCode: "pending-observation-disabled" as const,
              evidenceHash: hashDomain("aloha/public-pending-unavailable-evidence/v1", { head: observedHead, reasonCode: "pending-observation-disabled", snapshotHash: null }),
            },
      };
    },
  });
  const envelope = await issueProducerIngressPortV1(source).observe({ head: value, signal: new AbortController().signal });
  assert.notEqual(envelope, null);
  return envelope!;
}

function requestFor(session: ProducerSessionV1, envelope: Awaited<ReturnType<typeof ingressEnvelope>>, lane: "blockscan" | "backrun"): ProducerLaneRunInputV1<ProducerSessionV1> {
  return {
    kind: lane,
    session,
    head: envelope.head,
    revision: "0",
    generationId: session.generationId,
    graphRoot: session.lease.binding.graphRoot,
    input: lane === "blockscan" ? envelope.blockscanInput : envelope.backrunInput,
    signal: new AbortController().signal,
  };
}

async function runHeadFacts(mode: SearchTerminalMode, backrun: BackrunObservation = "empty") {
  const currentHead = head("107", `${mode}-${backrun}`);
  const fixture = createSearchTerminalFixture({ head: currentHead, generationId: `generation-${mode}`, mode });
  const envelope = await ingressEnvelope(currentHead, backrun);
  let facts: ProducerHeadFactsV1 | undefined;
  let factsCapability: ProducerHeadFactsCapabilityV1 | undefined;
  let terminal: ReturnType<ProducerRuntimeV1["terminals"]>[number] | undefined;
  let performanceTerminal: ReturnType<ProducerRuntimeV1["terminals"]>[number] | undefined;
  const runtime = new ProducerRuntimeV1({
    sessionOwner: issueProducerSessionOwnerV1({ async withProducerSession(_head, run) { return run(fixture.session); } }),
    blockscan: issueProducerLanePortV1({ kind: "blockscan", run: async request => (await fixture.run(request)).draft }),
    backrun: issueProducerLanePortV1({
      kind: "backrun",
      run(request) {
        const intake = readIssuedProducerBackrunIntakeV1(request.input);
        return intake.kind === "observed-empty"
          ? { kind: "no-input", absence: request.input as never, currentSource: fixture.logicalFacts("backrun", intake.correlationId) }
          : { kind: "retryable", reasonCode: "pending-not-consumed-by-contract-fixture", currentSource: null };
      },
    }),
    currentSource: issueProducerCurrentSourceHeadPortV1({ closeHead: () => fixture.closePhysicalFacts() }),
    performance: issueProducerPerformancePortV1<unknown>({
      acceptEligibleHead(input) { return admittedHead(input); },
      readEligibleHeadBinding: readAdmittedHead,
      bindEligibleHeadSession({ eligibleHead }) { return eligibleHead; },
      bindEligibleHeadFacts({ eligibleHead, facts: value }) { factsCapability = value; facts = readIssuedProducerHeadFactsCapabilityV1(value); return eligibleHead; },
      sealHeadTerminal({ terminal: value }) { performanceTerminal = value; },
    }),
    terminal: issueProducerTerminalPortV1({ appendTerminal({ terminal: value }) { terminal = value; } }),
  });
  await runtime.submit(envelope);
  await runtime.waitForIdle();
  assert.ok(facts);
  assert.ok(terminal);
  assert.ok(performanceTerminal);
  return {
    facts,
    terminal: readIssuedProducerHeadTerminalCapabilityV1(terminal).terminal,
    performanceTerminal: readIssuedProducerHeadTerminalCapabilityV1(performanceTerminal).terminal,
    terminalCapability: terminal,
    performanceTerminalCapability: performanceTerminal,
    factsCapability: factsCapability!,
  };
}

test("planner-owned route denominator remains recoverable only from the retained terminal capability", async () => {
  const { facts } = await runHeadFacts("policy-rejected");
  const lane = facts.laneFacts[0];
  assert.ok(lane?.accounting !== null && lane?.accounting !== undefined);
  const enumeration = readIssuedProducerLanePlannerEnumerationV1(lane);
  assert.ok(enumeration !== null);
  assert.equal(enumeration.enumerationRoot, lane.accounting.enumerationRoot);
  assert.equal(enumeration.planningProblemHash, lane.accounting.planningProblemHash);
  assert.equal(enumeration.candidates.length, lane.accounting.entries.length);
  for (const entry of lane.accounting.entries) {
    const candidate: PlannedRouteCandidateV1 | undefined = enumeration.candidates.find(value => value.candidateId === entry.candidateId);
    assert.ok(candidate);
    assert.deepEqual(candidate.legs, entry.legs);
  }
  assert.throws(() => readIssuedProducerLanePlannerEnumerationV1(structuredClone(lane)), /not owner-issued/);
});

test("real no-candidate terminal plus observed-empty intake is the healthy denominator", async () => {
  const { facts, terminal, performanceTerminal, terminalCapability, performanceTerminalCapability } = await runHeadFacts("no-candidate");
  assert.equal(facts.complete, true);
  assert.deepEqual(facts.candidateRefs, []);
  assert.deepEqual(facts.laneFacts.map(value => [value.lane, value.terminalKind, value.complete]), [
    ["blockscan", "route-set-terminal", true],
    ["backrun", "no-input", true],
  ]);
  assert.equal(terminal.status, "completed");
  assert.equal(terminal.reason, "completed-with-no-backrun-input");
  assert.equal(terminal.graphRoot, facts.graphRoot);
  assert.equal(performanceTerminal.graphRoot, facts.graphRoot);
  assert.equal(terminal.terminalId, performanceTerminal.terminalId);
  assert.equal(terminalCapability, performanceTerminalCapability);
  assert.equal(readIssuedProducerHeadSchedulerCompletionV1(terminalCapability), null);
  const fullFamily = readIssuedProducerFinalFullFamilyTerminalSetV1(terminalCapability);
  assert.equal(fullFamily.producerHeadFactsRoot, producerHeadFactsRootV1(facts));
  assert.equal(fullFamily.laneTerminalSetRoot, producerLaneTerminalSetRootV1(facts));
  assert.ok(fullFamily.blockscanSearchTerminalCapability);
  assert.throws(() => readIssuedProducerFinalFullFamilyTerminalSetV1({ ...terminalCapability }), /not owner-issued/);
});

test("Producer bounded ordered identity commits all 30k values without a canonical high-cardinality array", () => {
  const values = Object.freeze(Array.from({ length: 30_000 }, (_, index) => h("bounded-value", index)));
  const root = producerOrderedHashRootV1("aloha/test/producer-bounded-30k/v1", values);
  assert.equal(root, producerOrderedHashRootV1("aloha/test/producer-bounded-30k/v1", [...values]));
  assert.notEqual(root, producerOrderedHashRootV1("aloha/test/producer-bounded-30k/v1", values.slice(0, -1)));
  assert.notEqual(root, producerOrderedHashRootV1("aloha/test/producer-bounded-30k/v1", [values[1]!, values[0]!, ...values.slice(2)]));
  assert.notEqual(root, producerOrderedHashRootV1("aloha/test/producer-bounded-30k/v1", [values[0]!, values[0]!, ...values.slice(2)]));
});

test("a reorg after both lanes and physical close cannot produce a complete head fact", async () => {
  const currentHead = head("107", "final-canonical-fence");
  const fixture = createSearchTerminalFixture({ head: currentHead, generationId: "generation-final-canonical-fence", mode: "no-candidate" });
  const envelope = await ingressEnvelope(currentHead, "empty");
  let laneCompletions = 0;
  let physicalClosed = false;
  let facts: ProducerHeadFactsV1 | undefined;
  let terminal: ProducerHeadTerminalCapabilityV1 | undefined;
  const session = {
    ...fixture.session,
    async assertCurrent() {
      assert.equal(laneCompletions, 2);
      assert.equal(physicalClosed, true);
      throw new TypeError("canonical head changed after lane completion");
    },
  } as ProducerSessionV1;
  const runtime = new ProducerRuntimeV1({
    sessionOwner: issueProducerSessionOwnerV1({ async withProducerSession(_head, run) { return run(session); } }),
    blockscan: issueProducerLanePortV1({
      kind: "blockscan",
      async run(request) {
        const draft = (await fixture.run(request)).draft;
        laneCompletions += 1;
        return draft;
      },
    }),
    backrun: issueProducerLanePortV1({
      kind: "backrun",
      run(request) {
        const intake = readIssuedProducerBackrunIntakeV1(request.input);
        const result = { kind: "no-input" as const, absence: request.input as never, currentSource: fixture.logicalFacts("backrun", intake.correlationId) };
        laneCompletions += 1;
        return result;
      },
    }),
    currentSource: issueProducerCurrentSourceHeadPortV1({
      closeHead() {
        physicalClosed = true;
        return fixture.closePhysicalFacts();
      },
    }),
    performance: issueProducerPerformancePortV1<unknown>({
      acceptEligibleHead(input) { return admittedHead(input); },
      readEligibleHeadBinding: readAdmittedHead,
      bindEligibleHeadSession({ eligibleHead }) { return eligibleHead; },
      bindEligibleHeadFacts({ eligibleHead, facts: capability }) {
        facts = readIssuedProducerHeadFactsCapabilityV1(capability);
        return eligibleHead;
      },
      sealHeadTerminal() {},
    }),
    terminal: issueProducerTerminalPortV1({ appendTerminal({ terminal: capability }) { terminal = capability; } }),
  });
  await runtime.submit(envelope);
  await runtime.waitForIdle();
  assert.equal(laneCompletions, 2);
  assert.equal(physicalClosed, true);
  assert.equal(facts?.complete, false);
  assert.equal(facts?.laneFacts.length, 0);
  const final = readIssuedProducerHeadTerminalCapabilityV1(terminal!).terminal;
  assert.equal(final.status, "failed");
  assert.equal(final.reason, "startup_session_failed");
});

test("head evidence capabilities reject clones, substitutions, and cross-head splices", async () => {
  const first = await runHeadFacts("no-candidate");
  const second = await runHeadFacts("policy-rejected");
  assert.throws(() => readIssuedProducerHeadFactsCapabilityV1({ ...first.factsCapability }), /not owner-issued/);
  assert.throws(() => readIssuedProducerHeadFactsCapabilityV1({ ...first.facts }), /not owner-issued/);
  assert.throws(() => readIssuedProducerHeadTerminalCapabilityV1({ ...first.terminalCapability }), /not owner-issued/);
  assert.throws(() => issueProducerHeadTerminalCapabilityV1({ terminal: first.terminal, facts: second.factsCapability }), /binding mismatch/);
  const separatelyIssued = issueProducerHeadTerminalCapabilityV1({ terminal: first.terminal, facts: first.factsCapability });
  assert.notEqual(separatelyIssued, first.terminalCapability);
  assert.equal(Object.isFrozen(readIssuedProducerHeadFactsCapabilityV1(first.factsCapability)), true);
});

test("six-step traces remain bound to exact successful lane capabilities", async () => {
  const first = await runHeadFacts("unsigned-passed");
  const second = await runHeadFacts("unsigned-passed");
  const firstLane = first.facts.laneFacts.find(value => value.lane === "blockscan")!;
  const secondLane = second.facts.laneFacts.find(value => value.lane === "blockscan")!;
  const firstTrace = readIssuedProducerLaneSixStepTraceV1(firstLane);
  const secondTrace = readIssuedProducerLaneSixStepTraceV1(secondLane);
  const firstObservations = readIssuedProducerLaneCandidateTerminalObservationsV1(firstLane);
  assert.ok(firstTrace);
  assert.ok(secondTrace);
  assert.equal(firstTrace.resolved.correlationId, firstLane.correlationId);
  assert.equal(firstTrace.resolved.routeCandidateId, firstLane.candidateIds[0]);
  assert.equal(firstTrace.resolved.source.hash, firstLane.currentSource.source.hash);
  assert.notEqual(firstTrace.traceRoot, secondTrace.traceRoot);
  assert.equal(firstObservations.length, firstLane.accounting?.total);
  assert.equal(firstObservations.find(value => value.performanceOutcome === "verified")?.terminalLineageHash, firstLane.terminalLineageHash);
  assert.equal(firstObservations.find(value => value.performanceOutcome === "verified")?.sixStepEvidenceRoot, firstTrace.traceRoot);
  const retainedTerminal = readIssuedProducerLaneSearchTerminalCapabilityV1(firstLane);
  assert.ok(retainedTerminal);
  assert.deepEqual(Reflect.ownKeys(retainedTerminal), []);
  assert.throws(() => readIssuedProducerLaneSixStepTraceV1({ ...firstLane }), /not owner-issued/);
  assert.throws(() => readIssuedProducerLaneSearchTerminalCapabilityV1({ ...firstLane }), /not owner-issued/);

  const noCandidate = await runHeadFacts("no-candidate");
  const noCandidateLane = noCandidate.facts.laneFacts.find(value => value.lane === "blockscan")!;
  assert.equal(readIssuedProducerLaneSixStepTraceV1(noCandidateLane), null);
  assert.ok(readIssuedProducerLaneSearchTerminalCapabilityV1(noCandidateLane));
});

test("caller terminalFacts are rejected and pre-session terminals carry explicit missing facts", async () => {
  const value = lifecycleRuntime();
  const envelope = await ingressEnvelope(head("199", "caller-terminal-facts"), "unavailable");
  await assert.rejects(value.runtime.submit({ ...envelope, terminalFacts: Object.freeze({ forged: true }) } as never), /unknown field terminalFacts/);
  await value.runtime.shutdown();
  const rejected = await value.runtime.submit(envelope);
  assert.ok(rejected.terminal);
  const evidence = readIssuedProducerHeadTerminalCapabilityV1(rejected.terminal);
  assert.equal(evidence.terminal.status, "rejected");
  assert.equal(evidence.facts, null);
});

test("package root exposes evidence readers but no producer callback or evidence issuers", async () => {
  const root = await import("../src/index.ts");
  assert.equal("readIssuedProducerHeadFactsCapabilityV1" in root, true);
  assert.equal("readIssuedProducerHeadSchedulerCompletionV1" in root, true);
  assert.equal("readIssuedProducerHeadTerminalCapabilityV1" in root, true);
  assert.equal("readIssuedProducerLaneCandidateTerminalObservationsV1" in root, true);
  assert.equal("issueProducerHeadFactsCapabilityV1" in root, false);
  assert.equal("issueProducerHeadTerminalCapabilityV1" in root, false);
  assert.equal("issueProducerPerformancePortV1" in root, false);
  assert.equal("issueProducerTerminalPortV1" in root, false);
});

test("policy-rejected candidates remain retryable and cannot claim complete coverage", async () => {
  const { facts, terminal } = await runHeadFacts("policy-rejected");
  const blockscan = facts.laneFacts.find(value => value.lane === "blockscan")!;
  assert.equal(facts.complete, false);
  assert.equal(blockscan.outcome, "retryable");
  assert.equal(terminal.reason, "lane_retryable");
  assert.equal(blockscan.accounting?.entries.length, 1);
  assert.equal(blockscan.accounting?.entries[0]?.terminalKind, "policyRejected");
  assert.equal(blockscan.accounting?.entries[0]?.policyTerminal?.kind, "aloha.route-policy-rejection-v1");
  const observations = readIssuedProducerLaneCandidateTerminalObservationsV1(blockscan);
  assert.equal(facts.candidateRefs.length, 1);
  assert.equal(observations.length, blockscan.accounting?.total);
  assert.equal(observations[0]?.candidateId, blockscan.accounting?.entries[0]?.candidateId);
  assert.equal(observations[0]?.lane, "blockscan");
  assert.equal(observations[0]?.terminalKind, "policyRejected");
  assert.equal(observations[0]?.policyTerminal?.receiptHash, blockscan.accounting?.entries[0]?.policyTerminal?.receiptHash);
  assert.ok(BigInt(observations[0]!.finishedMonotonicNs) >= BigInt(observations[0]!.startedMonotonicNs));
  assert.equal(BigInt(observations[0]!.timingUs), (BigInt(observations[0]!.finishedMonotonicNs) - BigInt(observations[0]!.startedMonotonicNs)) / 1_000n);
  assert.throws(() => readIssuedProducerLaneCandidateTerminalObservationsV1({ ...blockscan }), /not owner-issued/);
});

test("selected retryable and invalid candidates remain in the unhealthy denominator", async () => {
  for (const [mode, expectedKind, expectedReason] of [
    ["selected-retryable", "retryable", "lane_retryable"],
    ["selected-invalid", "invalidProgram", "lane_failed"],
  ] as const) {
    const { facts, terminal } = await runHeadFacts(mode);
    const blockscan = facts.laneFacts[0]!;
    assert.equal(facts.complete, false, mode);
    assert.equal(facts.candidateRefs.length, 1, mode);
    assert.equal(blockscan.accounting?.entries[0]?.disposition, "selected", mode);
    assert.equal(blockscan.accounting?.entries[0]?.terminalKind, expectedKind, mode);
    assert.equal(terminal.reason, expectedReason, mode);
  }
});

test("a qualified REVM rejection remains selected and is a healthy complete terminal", async () => {
  const currentHead = head("107", "qualified-rejection");
  const fixture = createSearchTerminalFixture({ head: currentHead, generationId: "generation-qualified-rejection", mode: "selected-qualified-rejected" });
  const request = requestFor(fixture.session, await ingressEnvelope(currentHead), "blockscan");
  const pool = new RevmWorkerPool({ factory: revertedWorkerFactory(), authority: qualifiedWorkerAuthority(), qualification: workerQualification, maxWorkers: 1, timeoutMs: 100 });
  const scheduler = new WorkScheduler();
  const finalSimulation = createQualifiedFinalSimulationPort({
    scheduler,
    client: new RevmSimulationClient({ pool }),
    qualification: Object.freeze({
      ...workerQualification,
      qualifiedExecutorRegistryRoot: h("worker-registry", 1),
      selectedExecutorLeafHash: h("worker-leaf", 1),
      releaseRoleManifestRoot: h("worker-manifest", 1),
    }),
    schemaHash: h("worker-schema", 1),
    projection: { project: () => ({ input: { kind: "producer-qualified-rejection" }, caller: { address: "0x1111111111111111111111111111111111111111", mode: "top-level", observedSender: "0x1111111111111111111111111111111111111111", verifiedActors: {} }, observeAccounts: [] }) },
  });
  try {
    const lane = issueProducerLanePortV1({ kind: "blockscan", run: async value => (await fixture.run(value, finalSimulation)).draft });
    const outcome = await lane.run(request);
    const facts = readIssuedProducerLaneFactsV1(outcome.facts);
    assert.equal(outcome.kind, "completed");
    assert.equal(facts.complete, true);
    assert.equal(facts.candidateIds.length, 1);
    assert.equal(facts.accounting?.entries[0]?.disposition, "selected");
    assert.equal(facts.accounting?.entries[0]?.terminalKind, "chainProvenRejected");
    const observations = readIssuedProducerLaneCandidateTerminalObservationsV1(facts);
    assert.equal(observations[0]?.performanceOutcome, "simulation-reverted");
    assert.equal(observations[0]?.reasonCode, "final-sim:simulation-reverted");
  } finally {
    scheduler.assertPermitConservation();
    await pool.retireAll();
  }
});

test("an unsigned success cannot erase an earlier admitted retryable candidate", async () => {
  const { facts, terminal } = await runHeadFacts("unsigned-with-earlier-retryable");
  const blockscan = facts.laneFacts[0]!;
  assert.equal(blockscan.terminalKind, "unsigned-dry-run");
  assert.equal(blockscan.outcome, "retryable");
  assert.equal(blockscan.complete, false);
  assert.equal(blockscan.accounting?.entries.some(entry => entry.terminalKind === "retryable"), true);
  assert.equal(blockscan.accounting?.entries.some(entry => entry.terminalKind === "passed"), true);
  assert.equal(facts.candidateRefs.length, 2);
  const observations = readIssuedProducerLaneCandidateTerminalObservationsV1(blockscan);
  assert.equal(observations.length, 2);
  assert.deepEqual(observations.map(value => value.performanceOutcome).sort(), ["retryable", "verified"]);
  assert.deepEqual(observations.map(value => value.performanceCandidateRef).sort(), facts.candidateRefs);
  assert.equal(terminal.reason, "lane_retryable");
});

test("truncated enumeration is retryable and cannot claim a complete universe", async () => {
  const { facts } = await runHeadFacts("truncated");
  const blockscan = facts.laneFacts[0]!;
  assert.equal(blockscan.accounting?.enumerationTruncated, true);
  assert.equal(BigInt(blockscan.accounting!.observedUniqueCountLowerBound) > BigInt(blockscan.accounting!.total), true);
  assert.equal(blockscan.outcome, "retryable");
  assert.equal(facts.complete, false);
});

test("capability clones and self-consistent DTO substitutions are rejected", async () => {
  const currentHead = head("108", "terminal-clone");
  const fixture = createSearchTerminalFixture({ head: currentHead, generationId: "generation-clone", mode: "selected-retryable" });
  const envelope = await ingressEnvelope(currentHead);
  const request = requestFor(fixture.session, envelope, "blockscan");
  const issued = await fixture.run(request);
  const { draft } = issued;
  const cloneLane = issueProducerLanePortV1({ kind: "blockscan", run: () => ({ ...draft, terminalCapability: cloneTerminalCapability(draft.terminalCapability) }) });
  await assert.rejects(async () => cloneLane.run(request), /search terminal capability.*not issued|unknown field/);

  assert.equal(issued.outcome.kind, "route-set-terminal");
  if (issued.outcome.kind !== "route-set-terminal") return;
  const accounting = issued.outcome.receipt.accounting;
  const deleted = { ...accounting, entries: [], total: 0, selected: 0, root: h("forged-accounting", 1) };
  const substituted = { kind: "route-set-terminal", receipt: { ...issued.outcome.receipt, accounting: deleted, accountingRoot: deleted.root, lineageHash: h("forged-lineage", deleted) } };
  const dtoLane = issueProducerLanePortV1({ kind: "blockscan", run: () => ({ ...draft, terminalCapability: substituted }) });
  await assert.rejects(async () => dtoLane.run(request), /search terminal capability.*not issued|unknown field/);

  const swapped = { ...substituted, receipt: { ...substituted.receipt, accounting: { ...deleted, enumerationRoot: h("foreign-enumeration", 1) }, accountingRoot: h("forged-accounting", 2), lineageHash: h("forged-lineage", 2) } };
  const enumerationLane = issueProducerLanePortV1({ kind: "blockscan", run: () => ({ ...draft, terminalCapability: swapped }) });
  await assert.rejects(async () => enumerationLane.run(request), /search terminal capability.*not issued|unknown field/);
});

test("terminal, trigger, pending evidence, and snapshot cannot be spliced across runs", async () => {
  const firstHead = head("109", "splice-a");
  const secondHead = head("109", "splice-b");
  const first = createSearchTerminalFixture({ head: firstHead, generationId: "generation-splice", mode: "policy-rejected" });
  const second = createSearchTerminalFixture({ head: secondHead, generationId: "generation-splice", mode: "policy-rejected" });
  const firstRequest = requestFor(first.session, await ingressEnvelope(firstHead, "pending"), "backrun");
  const secondRequest = requestFor(second.session, await ingressEnvelope(secondHead, "pending"), "backrun");
  const firstDraft = (await first.run(firstRequest)).draft;
  const secondDraft = (await second.run(secondRequest)).draft;
  const triggerLane = issueProducerLanePortV1({ kind: "backrun", run: () => ({ ...firstDraft, trigger: secondDraft.trigger }) });
  await assert.rejects(async () => triggerLane.run(firstRequest), /trigger.*(?:head|request)|binding mismatch/);
  const terminalLane = issueProducerLanePortV1({ kind: "backrun", run: () => ({ ...firstDraft, terminalCapability: secondDraft.terminalCapability }) });
  await assert.rejects(async () => terminalLane.run(firstRequest), /terminal.*binding mismatch|source does not match/);
  const snapshotLane = issueProducerLanePortV1({ kind: "backrun", run: () => ({ ...firstDraft, pendingSnapshotHash: secondDraft.pendingSnapshotHash }) });
  await assert.rejects(async () => snapshotLane.run(firstRequest), /exact pending intake/);
});

test("only owner-issued observed-empty intake can produce no-input facts", async () => {
  const currentHead = head("110", "no-input-authority");
  const fixture = createSearchTerminalFixture({ head: currentHead, generationId: "generation-no-input", mode: "no-candidate" });
  const empty = await ingressEnvelope(currentHead, "empty");
  const lane = issueProducerLanePortV1({
    kind: "backrun",
    run: request => {
      const intake = readIssuedProducerBackrunIntakeV1(request.input);
      return { kind: "no-input", absence: request.input as never, currentSource: fixture.logicalFacts("backrun", intake.correlationId) };
    },
  });
  const emptyOutcome = await lane.run(requestFor(fixture.session, empty, "backrun"));
  assert.equal(emptyOutcome.kind, "no-input");
  assert.equal(readIssuedProducerLaneFactsV1(emptyOutcome.facts).complete, true);
  for (const observation of ["pending", "unavailable"] as const) {
    const rejectedFixture = createSearchTerminalFixture({ head: currentHead, generationId: `generation-no-input-${observation}`, mode: "no-candidate" });
    const rejectedEnvelope = await ingressEnvelope(currentHead, observation);
    const rejectedLane = issueProducerLanePortV1({
      kind: "backrun",
      run(request) {
        const intake = readIssuedProducerBackrunIntakeV1(request.input);
        return { kind: "no-input", absence: request.input as never, currentSource: rejectedFixture.logicalFacts("backrun", intake.correlationId) };
      },
    });
    await assert.rejects(async () => rejectedLane.run(requestFor(rejectedFixture.session, rejectedEnvelope, "backrun")), /observed absence/);
  }
  const forgedFixture = createSearchTerminalFixture({ head: currentHead, generationId: "generation-forged-no-input", mode: "no-candidate" });
  const forged = issueProducerLanePortV1({ kind: "backrun", run: request => ({
    kind: "no-input",
    absence: Object.freeze(Object.create(null)) as never,
    currentSource: forgedFixture.logicalFacts("backrun", readIssuedProducerBackrunIntakeV1(request.input).correlationId),
  }) });
  await assert.rejects(async () => forged.run(requestFor(forgedFixture.session, empty, "backrun")), /not bound|not owner-issued/);
});

test("runtime rejects bare-null, structural, unavailable, and non-empty no-input claims", async () => {
  const currentHead = head("111", "runtime-no-input");
  async function execute(backrunInput: unknown | null, noInput: boolean) {
    const fixture = createSearchTerminalFixture({ head: currentHead, generationId: `generation-runtime-no-input-${noInput ? "empty" : "retryable"}-${String(backrunInput === null)}`, mode: "no-candidate" });
    let facts: ProducerHeadFactsV1 | undefined;
    let terminal: ReturnType<ProducerRuntimeV1["terminals"]>[number] | undefined;
    const runtime = new ProducerRuntimeV1({
      sessionOwner: issueProducerSessionOwnerV1({ async withProducerSession(_head, run) { return run(fixture.session); } }),
      blockscan: issueProducerLanePortV1({ kind: "blockscan", run: async request => (await fixture.run(request)).draft }),
      backrun: issueProducerLanePortV1({ kind: "backrun", run: request => {
        if (!noInput) {
          const intake = readIssuedProducerBackrunIntakeV1(request.input);
          const currentSource = fixture.logicalFacts("backrun", intake.correlationId);
          return { kind: "retryable", reasonCode: "unavailable", currentSource };
        }
        let currentSource;
        try {
          const intake = readIssuedProducerBackrunIntakeV1(request.input);
          currentSource = fixture.logicalFacts("backrun", intake.correlationId);
        } catch {
          return { kind: "failed", reasonCode: "backrun-intake-not-owner-issued", currentSource: null };
        }
        return { kind: "no-input", absence: request.input as never, currentSource };
      } }),
      currentSource: issueProducerCurrentSourceHeadPortV1({ closeHead: () => fixture.closePhysicalFacts() }),
      performance: issueProducerPerformancePortV1<unknown>({ acceptEligibleHead(input) { return admittedHead(input); }, readEligibleHeadBinding: readAdmittedHead, bindEligibleHeadSession({ eligibleHead }) { return eligibleHead; }, bindEligibleHeadFacts({ eligibleHead, facts: value }) { facts = readIssuedProducerHeadFactsCapabilityV1(value); return eligibleHead; }, sealHeadTerminal() {} }),
      terminal: issueProducerTerminalPortV1({ appendTerminal({ terminal: value }) { terminal = value; } }),
    });
    const blockscanInput = (await ingressEnvelope(currentHead)).blockscanInput;
    await runtime.submit({ head: currentHead, blockscanInput, backrunInput });
    await runtime.waitForIdle();
    return { facts: facts!, terminal: readIssuedProducerHeadTerminalCapabilityV1(terminal!).terminal };
  }
  for (const input of [null, Object.freeze(Object.create(null))]) {
    const result = await execute(input, true);
    assert.equal(result.facts.complete, false);
    assert.equal(result.facts.laneFailureObservations.length, 0);
    assert.equal(result.terminal.reason, "lane_failed");
  }
  const pending = await execute((await ingressEnvelope(currentHead, "pending")).backrunInput, true);
  assert.equal(pending.facts.laneFailureObservations.length, 0);
  assert.equal(pending.terminal.reason, "lane_failed");
  const unavailable = await execute((await ingressEnvelope(currentHead, "unavailable")).backrunInput, false);
  assert.equal(unavailable.terminal.reason, "lane_retryable");
  assert.equal(unavailable.facts.laneFailureObservations.length, 1);
  const failure = readIssuedProducerLaneFailureObservationV1(unavailable.facts.laneFailureObservations[0]);
  assert.deepEqual(
    [failure.lane, failure.outcome, failure.reasonCode, failure.complete],
    ["backrun", "retryable", "unavailable", false],
  );
  assert.equal(failure.currentSource.lane, "backrun");
  for (const forbidden of ["triggerRef", "accounting", "candidateIds", "coverageRoot", "terminalLineageHash"]) {
    assert.equal(forbidden in failure, false, `failure observation leaked ${forbidden}`);
  }
  assert.throws(
    () => readIssuedProducerLaneFailureObservationV1({ ...failure }),
    /not owner-issued/,
  );
});

test("trigger owner binds exact lane, head, generation, Graph, and affected edges", async () => {
  const currentHead = head("112", "trigger");
  const fixture = createSearchTerminalFixture({ head: currentHead, generationId: "generation-trigger", mode: "policy-rejected" });
  const request = requestFor(fixture.session, await ingressEnvelope(currentHead, "pending"), "backrun");
  const intake = readIssuedProducerBackrunIntakeV1(request.input);
  assert.equal(intake.kind, "pending-transaction");
  if (intake.kind !== "pending-transaction") return;
  const bound = issueProducerBoundTriggerV1({ ingress: intake.trigger, laneInput: request });
  const facts = readIssuedProducerBoundTriggerV1(bound);
  assert.equal(facts.headHash, currentHead.hash);
  assert.equal(facts.generationId, fixture.session.generationId);
  assert.equal(facts.graphRoot, fixture.session.lease.binding.graphRoot);
  assert.equal(facts.txHash, intake.txHash);
  assert.equal(facts.pendingEvidenceHash, intake.pendingEvidenceHash);
  assert.equal(facts.affectedEdgeIds.length, fixture.session.lease.edges?.length ?? 0);
  assert.throws(() => readIssuedProducerBoundTriggerV1({ ...facts } as never), /not owner-issued/);
});

function lifecycleRuntime() {
  const fixtures = new Map<Hash, ReturnType<typeof createSearchTerminalFixture>>();
  const terminals: ProducerTerminalV1[] = [];
  const performanceTerminals: ProducerTerminalV1[] = [];
  const performanceFacts: ProducerHeadFactsV1[] = [];
  const acceptedPerformanceHeads: CanonicalHead[] = [];
  const ordinalByHeight = new Map<string, string>();
  const starts: string[] = [];
  let releaseFirst!: () => void;
  let announceFirst!: () => void;
  const firstStarted = new Promise<void>(resolve => { announceFirst = resolve; });
  const fixtureFor = (value: CanonicalHead) => {
    let fixture = fixtures.get(value.hash);
    if (fixture === undefined) {
      fixture = createSearchTerminalFixture({ head: value, generationId: `generation-${value.hash}`, mode: "no-candidate" });
      fixtures.set(value.hash, fixture);
    }
    return fixture;
  };
  const runtime = new ProducerRuntimeV1({
    sessionOwner: issueProducerSessionOwnerV1({ async withProducerSession(value, run) { return run(fixtureFor(value).session); } }),
    blockscan: issueProducerLanePortV1({
      kind: "blockscan",
      async run(request) {
        starts.push(`blockscan:${request.head.number}`);
        const trigger = (request.input as { readonly trigger: never }).trigger;
        const bound = issueProducerBoundTriggerV1({ ingress: trigger, laneInput: request });
        const correlationId = readIssuedProducerBoundTriggerV1(bound).correlationId;
        if (request.head.number === "200") {
          announceFirst();
          await new Promise<void>(resolve => {
            releaseFirst = resolve;
            request.signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        const currentSource = fixtureFor(request.head).logicalFacts("blockscan", correlationId);
        return { kind: request.signal.aborted ? "cancelled" : "retryable", reasonCode: request.signal.aborted ? "aborted" : "lifecycle-fixture", currentSource };
      },
    }),
    backrun: issueProducerLanePortV1({
      kind: "backrun",
      run(request) {
        starts.push(`backrun:${request.head.number}`);
        const intake = readIssuedProducerBackrunIntakeV1(request.input);
        const currentSource = fixtureFor(request.head).logicalFacts("backrun", intake.correlationId);
        return { kind: "retryable", reasonCode: "lifecycle-fixture", currentSource };
      },
    }),
    currentSource: issueProducerCurrentSourceHeadPortV1({ closeHead: session => fixtureFor(session.head).closePhysicalFacts() }),
    performance: issueProducerPerformancePortV1<unknown>({
      acceptEligibleHead(input) {
        acceptedPerformanceHeads.push(input.head);
        let ordinal = ordinalByHeight.get(input.head.number);
        if (ordinal === undefined) {
          ordinal = (ordinalByHeight.size + 1).toString();
          ordinalByHeight.set(input.head.number, ordinal);
        }
        return admittedHead(input, ordinal);
      },
      readEligibleHeadBinding: readAdmittedHead,
      bindEligibleHeadSession({ eligibleHead }) { return eligibleHead; },
      bindEligibleHeadFacts({ eligibleHead, facts }) {
        performanceFacts.push(readIssuedProducerHeadFactsCapabilityV1(facts));
        return eligibleHead;
      },
      sealHeadTerminal({ terminal }) {
        performanceTerminals.push(readIssuedProducerHeadTerminalCapabilityV1(terminal).terminal);
      },
    }),
    terminal: issueProducerTerminalPortV1({ appendTerminal({ terminal }) { terminals.push(readIssuedProducerHeadTerminalCapabilityV1(terminal).terminal); } }),
  });
  return {
    runtime,
    terminals,
    performanceTerminals,
    performanceFacts,
    acceptedPerformanceHeads,
    starts,
    firstStarted,
    releaseFirst: () => releaseFirst(),
  };
}

test("latest pending replacement keeps one terminal per head and runs only the newest pending head", async () => {
  const value = lifecycleRuntime();
  const first = await value.runtime.submit(await ingressEnvelope(head("200", "lifecycle-first"), "unavailable"));
  await value.firstStarted;
  await value.runtime.submit(await ingressEnvelope(head("201", "lifecycle-middle"), "unavailable"));
  await value.runtime.submit(await ingressEnvelope(head("202", "lifecycle-latest"), "unavailable"));
  assert.equal(value.terminals.filter(item => item.reason === "scheduler_coalesced").length, 1);
  value.releaseFirst();
  await value.runtime.waitForIdle();
  assert.deepEqual(value.starts, ["blockscan:200", "backrun:200", "blockscan:202", "backrun:202"]);
  assert.equal(value.terminals.filter(item => item.acceptedId === first.acceptedId).length, 1);
  assert.equal(new Set(value.terminals.map(item => item.terminalId)).size, value.terminals.length);
  assert.deepEqual(value.acceptedPerformanceHeads.map(item => item.number), ["200", "201", "202"]);
  assert.deepEqual(
    value.performanceTerminals.map(item => item.terminalId).sort(),
    value.terminals.map(item => item.terminalId).sort(),
  );
  const coalescedFacts = value.performanceFacts.find(item => item.headHash === head("201", "lifecycle-middle").hash);
  assert.equal(coalescedFacts?.generationId, null);
  assert.equal(coalescedFacts?.graphRoot, null);
  assert.equal(coalescedFacts?.complete, false);
});

test("same-height replacement keeps the owner-derived ordinal while submission sequence advances", async () => {
  const value = lifecycleRuntime();
  const orphanHead = head("204", "same-ordinal-orphan");
  const orphan = await value.runtime.submit(await ingressEnvelope(orphanHead, "unavailable"));
  assert.equal(orphan.accepted, true);
  await value.runtime.waitForIdle();
  const replacementHead = head("204", "same-ordinal-replacement");
  const replacementInput = await ingressEnvelope(replacementHead, "unavailable");
  const replacement = await value.runtime.submit({ ...replacementInput, revision: "1" });
  assert.equal(replacement.accepted, true);
  await value.runtime.waitForIdle();
  assert.deepEqual(value.terminals.map(item => [item.sequence, item.ordinal, item.revision]), [
    ["1", "1", "0"],
    ["2", "1", "1"],
  ]);
  assert.deepEqual(
    value.performanceTerminals.map(item => item.terminalId),
    value.terminals.map(item => item.terminalId),
  );
});

test("failed performance admission emits a non-denominator ordinal and cannot enter the performance sink", async () => {
  const currentHead = head("205", "performance-admission-failure");
  const fixture = createSearchTerminalFixture({ head: currentHead, generationId: "generation-admission-failure", mode: "no-candidate" });
  const performanceTerminals: ProducerHeadTerminalCapabilityV1[] = [];
  const journal: ProducerHeadTerminalCapabilityV1[] = [];
  const runtime = new ProducerRuntimeV1({
    sessionOwner: issueProducerSessionOwnerV1({ async withProducerSession(_head, run) { return run(fixture.session); } }),
    blockscan: issueProducerLanePortV1({ kind: "blockscan", run: async request => (await fixture.run(request)).draft }),
    backrun: issueProducerLanePortV1({ kind: "backrun", run: () => ({ kind: "failed", reasonCode: "must-not-run", currentSource: null }) }),
    currentSource: issueProducerCurrentSourceHeadPortV1({ closeHead: () => fixture.closePhysicalFacts() }),
    performance: issueProducerPerformancePortV1<unknown>({
      acceptEligibleHead() { throw new TypeError("performance admission unavailable"); },
      readEligibleHeadBinding() { throw new TypeError("must not read a failed admission"); },
      bindEligibleHeadSession({ eligibleHead }) { return eligibleHead; },
      bindEligibleHeadFacts({ eligibleHead }) { return eligibleHead; },
      sealHeadTerminal({ terminal }) { performanceTerminals.push(terminal); },
    }),
    terminal: issueProducerTerminalPortV1({ appendTerminal({ terminal }) { journal.push(terminal); } }),
  });
  const result = await runtime.submit(await ingressEnvelope(currentHead, "empty"));
  assert.equal(result.accepted, false);
  assert.equal(performanceTerminals.length, 0);
  assert.equal(journal.length, 1);
  const terminal = readIssuedProducerHeadTerminalCapabilityV1(journal[0]!).terminal;
  assert.equal(terminal.reason, "performance_append_failed");
  assert.equal(terminal.ordinal, "0");
});

test("a performance port cannot cross-bind an admitted handle to another head", async () => {
  const currentHead = head("206", "performance-binding-head");
  const fixture = createSearchTerminalFixture({ head: currentHead, generationId: "generation-binding-failure", mode: "no-candidate" });
  const performanceTerminals: ProducerHeadTerminalCapabilityV1[] = [];
  const journal: ProducerHeadTerminalCapabilityV1[] = [];
  const runtime = new ProducerRuntimeV1({
    sessionOwner: issueProducerSessionOwnerV1({ async withProducerSession(_head, run) { return run(fixture.session); } }),
    blockscan: issueProducerLanePortV1({ kind: "blockscan", run: async request => (await fixture.run(request)).draft }),
    backrun: issueProducerLanePortV1({ kind: "backrun", run: () => ({ kind: "failed", reasonCode: "must-not-run", currentSource: null }) }),
    currentSource: issueProducerCurrentSourceHeadPortV1({ closeHead: () => fixture.closePhysicalFacts() }),
    performance: issueProducerPerformancePortV1<unknown>({
      acceptEligibleHead(input) { return admittedHead(input); },
      readEligibleHeadBinding(eligibleHead) { return { ...readAdmittedHead(eligibleHead), headHash: h("foreign-head", 1) }; },
      bindEligibleHeadSession({ eligibleHead }) { return eligibleHead; },
      bindEligibleHeadFacts({ eligibleHead }) { return eligibleHead; },
      sealHeadTerminal({ terminal }) { performanceTerminals.push(terminal); },
    }),
    terminal: issueProducerTerminalPortV1({ appendTerminal({ terminal }) { journal.push(terminal); } }),
  });
  const result = await runtime.submit(await ingressEnvelope(currentHead, "empty"));
  assert.equal(result.accepted, false);
  assert.equal(performanceTerminals.length, 0);
  const terminal = readIssuedProducerHeadTerminalCapabilityV1(journal[0]!).terminal;
  assert.equal(terminal.reason, "performance_append_failed");
  assert.equal(terminal.ordinal, "0");
});

test("session admission failure remains in the performance denominator", async () => {
  const currentHead = head("203", "session-admission-failure");
  const envelope = await ingressEnvelope(currentHead, "unavailable");
  const boundFacts: ProducerHeadFactsV1[] = [];
  const performanceTerminals: ProducerHeadTerminalCapabilityV1[] = [];
  const journalTerminals: ProducerHeadTerminalCapabilityV1[] = [];
  const runtime = new ProducerRuntimeV1({
    sessionOwner: issueProducerSessionOwnerV1({
      async withProducerSession() {
        throw new Error("session admission unavailable");
      },
    }),
    blockscan: issueProducerLanePortV1({ kind: "blockscan", run: () => ({ kind: "failed", reasonCode: "must-not-run", currentSource: null }) }),
    backrun: issueProducerLanePortV1({ kind: "backrun", run: () => ({ kind: "failed", reasonCode: "must-not-run", currentSource: null }) }),
    currentSource: issueProducerCurrentSourceHeadPortV1({ closeHead() { throw new Error("must-not-close"); } }),
    performance: issueProducerPerformancePortV1<unknown>({
      acceptEligibleHead(input) { return admittedHead(input); },
      readEligibleHeadBinding: readAdmittedHead,
      bindEligibleHeadSession({ eligibleHead }) { return eligibleHead; },
      bindEligibleHeadFacts({ eligibleHead, facts }) {
        boundFacts.push(readIssuedProducerHeadFactsCapabilityV1(facts));
        return eligibleHead;
      },
      sealHeadTerminal({ terminal }) { performanceTerminals.push(terminal); },
    }),
    terminal: issueProducerTerminalPortV1({ appendTerminal({ terminal }) { journalTerminals.push(terminal); } }),
  });
  assert.equal((await runtime.submit(envelope)).accepted, true);
  await runtime.waitForIdle();
  assert.equal(boundFacts.length, 0);
  assert.equal(performanceTerminals[0], journalTerminals[0]);
  const terminalEvidence = readIssuedProducerHeadTerminalCapabilityV1(journalTerminals[0]!);
  assert.equal(terminalEvidence.terminal.reason, "startup_session_failed");
  assert.equal(terminalEvidence.terminal.generationId, null);
  assert.equal(terminalEvidence.terminal.graphRoot, null);
  assert.equal(terminalEvidence.facts, null);
});

test("same-height reorg and shutdown settle active and pending heads exactly once", async () => {
  const reorg = lifecycleRuntime();
  const admitted = await reorg.runtime.submit(await ingressEnvelope(head("200", "reorg-old"), "unavailable"));
  await reorg.firstStarted;
  await reorg.runtime.invalidateHead(head("200", "reorg-new"), "same_height_reorg");
  await reorg.runtime.waitForIdle();
  const reorgTerminal = reorg.terminals.find(item => item.acceptedId === admitted.acceptedId);
  assert.equal(reorgTerminal?.status, "cancelled");
  assert.equal(reorgTerminal?.reason, "same_height_reorg");

  const shutdown = lifecycleRuntime();
  await shutdown.runtime.submit(await ingressEnvelope(head("200", "shutdown-active"), "unavailable"));
  await shutdown.firstStarted;
  await shutdown.runtime.submit(await ingressEnvelope(head("201", "shutdown-pending"), "unavailable"));
  await shutdown.runtime.shutdown();
  assert.equal(shutdown.runtime.accepting, false);
  assert.equal(shutdown.terminals.filter(item => item.reason === "shutdown_pending_dropped").length, 1);
  assert.equal(shutdown.terminals.filter(item => item.reason === "shutdown_active_cancelled").length, 1);
});

test("forged ports and performance seal failures fail closed", async () => {
  const currentHead = head("113", "ports");
  const fixture = createSearchTerminalFixture({ head: currentHead, generationId: "generation-ports", mode: "no-candidate" });
  const owner = issueProducerSessionOwnerV1({ async withProducerSession(_head, run) { return run(fixture.session); } });
  const blockscan = issueProducerLanePortV1({ kind: "blockscan", run: () => ({ kind: "retryable", reasonCode: "test", currentSource: null }) });
  const performance = issueProducerPerformancePortV1<unknown>({ acceptEligibleHead(input) { return admittedHead(input); }, readEligibleHeadBinding: readAdmittedHead, bindEligibleHeadSession({ eligibleHead }) { return eligibleHead; }, bindEligibleHeadFacts({ eligibleHead }) { return eligibleHead; }, sealHeadTerminal() {} });
  const terminal = issueProducerTerminalPortV1({ appendTerminal() {} });
  const currentSource = issueProducerCurrentSourceHeadPortV1({ closeHead: () => fixture.closePhysicalFacts() });
  assert.throws(() => new ProducerRuntimeV1({ sessionOwner: {} as never, blockscan, backrun: blockscan as never, currentSource, performance, terminal }), /session owner.*not owner-issued/);
  assert.throws(() => new ProducerRuntimeV1({ sessionOwner: owner, blockscan, backrun: blockscan as never, currentSource, performance, terminal }), /both producer lanes/);
  const envelope = await ingressEnvelope(currentHead, "empty");
  const performanceTerminals: unknown[] = [];
  let journalTerminal: unknown;
  const runtime = new ProducerRuntimeV1({
    sessionOwner: owner,
    blockscan: issueProducerLanePortV1({ kind: "blockscan", run: async request => (await fixture.run(request)).draft }),
    backrun: issueProducerLanePortV1({ kind: "backrun", run: request => {
      const intake = readIssuedProducerBackrunIntakeV1(request.input);
      return { kind: "no-input", absence: request.input as never, currentSource: fixture.logicalFacts("backrun", intake.correlationId) };
    } }),
    currentSource,
    performance: issueProducerPerformancePortV1<unknown>({ acceptEligibleHead(input) { return admittedHead(input); }, readEligibleHeadBinding: readAdmittedHead, bindEligibleHeadSession({ eligibleHead }) { return eligibleHead; }, bindEligibleHeadFacts({ eligibleHead }) { return eligibleHead; }, sealHeadTerminal({ terminal: value }) { performanceTerminals.push(value); throw new Error("append failed"); } }),
    terminal: issueProducerTerminalPortV1({ appendTerminal({ terminal: value }) { journalTerminal = value; } }),
  });
  await runtime.submit(envelope);
  await runtime.waitForIdle();
  assert.equal(runtime.accepting, false);
  assert.equal(runtime.telemetry().fatal, true);
  assert.equal(performanceTerminals.length, 2);
  assert.equal(journalTerminal, performanceTerminals[1]);
  assert.notEqual(journalTerminal, performanceTerminals[0]);
  const preliminary = readIssuedProducerHeadTerminalCapabilityV1(performanceTerminals[0]);
  const durable = readIssuedProducerHeadTerminalCapabilityV1(journalTerminal);
  assert.equal(preliminary.terminal.status, "completed");
  assert.equal(durable.terminal.status, "failed");
  assert.equal(durable.terminal.reason, "performance_append_failed");
  assert.equal(durable.terminal.graphRoot, preliminary.terminal.graphRoot);
  assert.equal(durable.facts, preliminary.facts);
});

test("current-source logical facts remain owner-issued and reject caller verdict fields", async () => {
  const { facts } = await runHeadFacts("no-candidate");
  const blockscan = facts.laneFacts[0]!;
  assert.equal(blockscan.currentSource.kind, "aloha.current-source-rpc.logical-scope-facts-v1");
  assert.equal(blockscan.currentSource.lane, "blockscan");
  assert.equal(blockscan.currentSource.source.hash, blockscan.headHash);
  assert.throws(() => readIssuedProducerLaneFactsV1({ ...blockscan, callerVerdict: "pass" } as never), /not owner-issued/);
});
