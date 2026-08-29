import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { decodeCanonicalBytes, hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { createSqliteDurableStore } from "../../../packages/durable-store/src/index.ts";
import type { CanonicalHead, ProducerSessionV1, ProducerTerminalV1 } from "../../../packages/producer/src/index.ts";
import {
  issueProducerHeadFactsCapabilityV1,
  issueProducerHeadTerminalCapabilityV1,
} from "../../../packages/producer/src/internal/owners.ts";
import { issueStartupRuntime } from "../../../packages/startup-runtime/src/internal/runtime-owner.ts";
import type { RuntimeAnchorReceiptV1 } from "../src/deployment.ts";
import {
  assertIssuedSearcherProductionEvidenceOwnerV1,
  issueSearcherProductionEvidenceOwnerV1,
  missingExternalRuntimeAnchorEvidenceV1,
  readSearcherProductionEvidenceHighCardinalityV1,
  SEARCHER_PRODUCTION_EVIDENCE_NAMESPACES,
} from "../src/production-evidence.ts";

const h = (digit: string): Hash => `0x${digit.repeat(64)}` as Hash;
const release = Object.freeze({ bindingId: h("1"), releaseProvenanceHash: h("2"), candidateReleaseCommit: "a".repeat(40) });
const graphRoot = h("3");
const head: CanonicalHead = Object.freeze({ chainId: "1", number: "101", hash: h("4"), parentHash: h("5"), stateRoot: h("6") });
const sessionCapability = Object.freeze(Object.create(null)) as ProducerSessionV1;

function runtimeAnchor(invocationId = "invocation-1"): RuntimeAnchorReceiptV1 {
  return Object.freeze({
    kind: "aloha.searcher-runtime-anchor-v1",
    bindingId: release.bindingId,
    releaseProvenanceHash: release.releaseProvenanceHash,
    manifestHash: h("7"),
    manifestArtifactSha256: h("8"),
    runtimeArtifactRoot: h("9"),
    implementationClosureDigest: h("a"),
    candidateReleaseCommit: release.candidateReleaseCommit,
    entrypointSha256: h("b"),
    nodeExecutableSha256: h("c"),
    bundleModulePath: "/opt/aloha/release.mjs",
    bundleModuleSha256: h("d"),
    serviceName: "aloha-searcher",
    systemdUnit: "aloha-searcher.service",
    bootId: "boot-1",
    invocationId,
    logDevice: "8",
    logInode: "9",
    pid: invocationId === "invocation-1" ? "42" : "43",
    processStartTicks: invocationId === "invocation-1" ? "7" : "8",
    dryRun: true,
  });
}

function startup() {
  const ready = {
    releaseProvenanceHash: release.releaseProvenanceHash,
    readyRecordHash: h("e"),
    sourceCoverageRoot: h("f"),
    definitionCatalogRoot: h("d"),
  } as never;
  const serving = Object.freeze({
    ready,
    generationId: "generation-1",
    graphRoot,
    readyRecordHash: h("e"),
    sourceCoverageRoot: h("f"),
    definitionCatalogRoot: h("d"),
    releaseProvenanceHash: release.releaseProvenanceHash,
  });
  return issueStartupRuntime({
    ready,
    familyRuntimeComposition: {} as never,
    generationId: "generation-1",
    graphRoot,
    releaseBindingId: release.bindingId,
    candidateReleaseCommit: release.candidateReleaseCommit,
    canonicalSourceAuthority: {} as never,
    readActiveGeneration: () => serving,
    readServingGeneration: generationId => {
      if (generationId !== serving.generationId) throw new Error("unknown generation");
      return serving;
    },
    readProducerSessionGeneration: session => {
      if (session !== sessionCapability) throw new Error("unknown producer session");
      return serving;
    },
    async withProducerSession() { throw new Error("not used by production-evidence contract tests"); },
    async waitForGenerationIdle() {},
    async close() {},
  });
}

function terminal(input: {
  readonly ordinal: string;
  readonly facts: ReturnType<typeof issueProducerHeadFactsCapabilityV1> | null;
  readonly source?: CanonicalHead;
  readonly generationId?: string;
  readonly graphRoot?: Hash;
}) {
  const terminalWithoutId = Object.freeze({
    acceptedId: h(input.ordinal === "1" ? "a" : "b"),
    sequence: input.ordinal,
    ordinal: input.ordinal,
    status: "failed" as const,
    reason: "lane_failed" as const,
    head: input.source ?? head,
    revision: "0",
    generationId: input.generationId ?? "generation-1",
    graphRoot: input.graphRoot ?? graphRoot,
    laneOutcomes: Object.freeze([]),
  });
  const value: ProducerTerminalV1 = Object.freeze({
    kind: "aloha.producer-terminal-v1",
    terminalId: hashDomain("aloha/producer-terminal/v1", terminalWithoutId),
    ...terminalWithoutId,
  });
  return issueProducerHeadTerminalCapabilityV1({ terminal: value, facts: input.facts });
}

test("eligible admission freezes serving only from the owner-issued session opened after promotion", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aloha-production-evidence-promotion-race-"));
  const databasePath = join(directory, "evidence.sqlite");
  const session = Object.freeze(Object.create(null)) as ProducerSessionV1;
  const generationA = Object.freeze({
    ready: { releaseProvenanceHash: release.releaseProvenanceHash, readyRecordHash: h("a"), sourceCoverageRoot: h("b"), definitionCatalogRoot: h("c") } as never,
    generationId: "generation-a",
    graphRoot: h("d"),
    readyRecordHash: h("a"),
    sourceCoverageRoot: h("b"),
    definitionCatalogRoot: h("c"),
    releaseProvenanceHash: release.releaseProvenanceHash,
  });
  const generationB = Object.freeze({
    ready: { releaseProvenanceHash: release.releaseProvenanceHash, readyRecordHash: h("5"), sourceCoverageRoot: h("6"), definitionCatalogRoot: h("c") } as never,
    generationId: "generation-b",
    graphRoot: h("7"),
    readyRecordHash: h("5"),
    sourceCoverageRoot: h("6"),
    definitionCatalogRoot: h("c"),
    releaseProvenanceHash: release.releaseProvenanceHash,
  });
  const promotedStartup = issueStartupRuntime({
    ready: generationA.ready,
    familyRuntimeComposition: {} as never,
    generationId: generationA.generationId,
    graphRoot: generationA.graphRoot,
    releaseBindingId: release.bindingId,
    candidateReleaseCommit: release.candidateReleaseCommit,
    canonicalSourceAuthority: {} as never,
    readActiveGeneration: () => generationA,
    readServingGeneration: generationId => {
      if (generationId === generationA.generationId) return generationA;
      if (generationId === generationB.generationId) return generationB;
      throw new Error("unknown generation");
    },
    readProducerSessionGeneration: value => {
      if (value !== session) throw new Error("unknown producer session");
      return generationB;
    },
    async withProducerSession() { throw new Error("not used by promotion race fact test"); },
    async waitForGenerationIdle() {},
    async close() {},
  });
  const owner = issueSearcherProductionEvidenceOwnerV1({ databasePath, release, runtimeAnchor: runtimeAnchor() });
  const ports = owner.bindServing(promotedStartup);
  const eligible = await ports.performance.acceptEligibleHead({ head, revision: "0" });
  await ports.performance.bindEligibleHeadSession({ eligibleHead: eligible, session });
  const facts = issueProducerHeadFactsCapabilityV1({
    kind: "aloha.producer-head-facts-v1",
    headHash: head.hash,
    generationId: generationB.generationId,
    graphRoot: generationB.graphRoot,
    laneFacts: Object.freeze([]),
    laneFailureObservations: Object.freeze([]),
    candidateRefs: Object.freeze([]),
    currentSourcePhysical: null,
    sourceCoverageRoot: h("8"),
    complete: false,
  });
  await ports.performance.bindEligibleHeadFacts({ eligibleHead: eligible, facts });
  const terminalCapability = terminal({
    ordinal: "1",
    facts,
    generationId: generationB.generationId,
    graphRoot: generationB.graphRoot,
  });
  await ports.performance.sealHeadTerminal({ eligibleHead: eligible, terminal: terminalCapability });
  await ports.terminal.appendTerminal({ terminal: terminalCapability });
  owner.close();

  const durable = createSqliteDurableStore(databasePath);
  durable.bindStoreRole("searcher-production-evidence");
  const events = Object.values(SEARCHER_PRODUCTION_EVIDENCE_NAMESPACES).flatMap(namespace =>
    durable.readAppendLog(namespace).map(row => decodeCanonicalBytes(row.bytes) as Record<string, unknown>),
  );
  durable.close();
  const eligibleEvent = events.find(event => event.eventType === "eligible-head");
  assert.ok(eligibleEvent);
  assert.equal(eligibleEvent.serving, null, "durable admission must remain generation-neutral before session open");
  const served = events.filter(event => event.eventType !== "eligible-head");
  assert.ok(served.length > 0);
  for (const event of served) {
    assert.deepEqual(event.serving, {
      generationId: generationB.generationId,
      graphRoot: generationB.graphRoot,
      readyRecordHash: generationB.readyRecordHash,
      sourceCoverageRoot: generationB.sourceCoverageRoot,
    });
  }
  assert.equal(events.some(event => (event.serving as { generationId?: string } | null)?.generationId === generationA.generationId), false);
});

test("offline runtime composition reports incomplete facts until an external live anchor receipt exists", () => {
  const evidence = missingExternalRuntimeAnchorEvidenceV1();
  assert.deepEqual(evidence, {
    schemaVersion: 1,
    kind: "aloha.searcher-production-evidence-status",
    factStatus: "incomplete",
    reasonCode: "external-runtime-anchor-missing",
    runtimeAnchorReceipt: null,
  });
  assert.equal(Object.isFrozen(evidence), true);
  assert.equal("verdict" in evidence, false);
});

test("owner persists eligible, coverage, candidate, terminal and incomplete performance facts from opaque Producer capabilities", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aloha-production-evidence-"));
  const databasePath = join(directory, "evidence.sqlite");
  const owner = issueSearcherProductionEvidenceOwnerV1({ databasePath, release, runtimeAnchor: runtimeAnchor() });
  assertIssuedSearcherProductionEvidenceOwnerV1(owner);
  const ports = owner.bindServing(startup());
  const eligible = await ports.performance.acceptEligibleHead({ head, revision: "0" });
  await ports.performance.bindEligibleHeadSession({ eligibleHead: eligible, session: sessionCapability });
  const facts = issueProducerHeadFactsCapabilityV1({
    kind: "aloha.producer-head-facts-v1",
    headHash: head.hash,
    generationId: "generation-1",
    graphRoot,
    laneFacts: Object.freeze([]),
    laneFailureObservations: Object.freeze([]),
    candidateRefs: Object.freeze([]),
    currentSourcePhysical: null,
    sourceCoverageRoot: h("d"),
    complete: false,
  });
  assert.throws(
    () => ports.performance.bindEligibleHeadFacts({ eligibleHead: eligible, facts: structuredClone(facts) }),
    /not owner-issued/,
  );
  await ports.performance.bindEligibleHeadFacts({ eligibleHead: eligible, facts });
  const terminalCapability = terminal({ ordinal: "1", facts });
  await ports.performance.sealHeadTerminal({ eligibleHead: eligible, terminal: terminalCapability });
  assert.equal(ports.sixStep.readCompleteAppend(terminalCapability), null);
  assert.throws(() => ports.sixStep.readCompleteAppend({ ...terminalCapability } as never), /not owner-issued/);
  await ports.terminal.appendTerminal({ terminal: terminalCapability });

  const replay = owner.replay();
  assert.equal(replay.eventCount, "5");
  assert.equal(replay.eligibleHeadCount, "1");
  assert.equal(replay.headCoverageCount, "1");
  assert.equal(replay.candidateSetCount, "1");
  assert.equal(replay.performanceFactsCompleteCount, "0");
  assert.equal(replay.performanceFactsIncompleteCount, "1");
  assert.equal(replay.producerTerminalCount, "1");
  assert.deepEqual(replay.incompleteAdmissionIds, []);
  owner.close();

  const highCardinality = readSearcherProductionEvidenceHighCardinalityV1(databasePath);
  assert.equal(highCardinality.routeDenominators.length, 0);
  assert.equal(highCardinality.candidateSets.length, 1);
  assert.equal(highCardinality.candidateSets[0]!.payload.candidateTerminalObservations.length, 0);
  assert.equal(highCardinality.candidateSets[0]!.payload.candidateRefs.length, 0);

  const persisted = createSqliteDurableStore(databasePath);
  persisted.bindStoreRole("searcher-production-evidence");
  const rows = persisted.readAppendLog(SEARCHER_PRODUCTION_EVIDENCE_NAMESPACES.performance);
  assert.equal(rows.length, 1);
  const event = decodeCanonicalBytes(rows[0]!.bytes) as Record<string, unknown>;
  assert.equal(event.eventType, "performance-facts-incomplete");
  const payload = event.payload as Record<string, unknown>;
  assert.equal(payload.factStatus, "incomplete");
  assert.equal("verdict" in payload, false);
  persisted.close();
});

test("terminal cannot replace the exact head-facts capability with an equivalent reissue", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aloha-production-evidence-facts-identity-"));
  const owner = issueSearcherProductionEvidenceOwnerV1({ databasePath: join(directory, "evidence.sqlite"), release, runtimeAnchor: runtimeAnchor() });
  const ports = owner.bindServing(startup());
  const eligible = await ports.performance.acceptEligibleHead({ head, revision: "0" });
  await ports.performance.bindEligibleHeadSession({ eligibleHead: eligible, session: sessionCapability });
  const factsValue = Object.freeze({
    kind: "aloha.producer-head-facts-v1" as const,
    headHash: head.hash,
    generationId: "generation-1",
    graphRoot,
    laneFacts: Object.freeze([]),
    laneFailureObservations: Object.freeze([]),
    candidateRefs: Object.freeze([]),
    currentSourcePhysical: null,
    sourceCoverageRoot: h("d"),
    complete: false,
  });
  const boundFacts = issueProducerHeadFactsCapabilityV1(factsValue);
  const equivalentReissue = issueProducerHeadFactsCapabilityV1(factsValue);
  await ports.performance.bindEligibleHeadFacts({ eligibleHead: eligible, facts: boundFacts });

  await assert.rejects(
    async () => { await ports.performance.sealHeadTerminal({ eligibleHead: eligible, terminal: terminal({ ordinal: "1", facts: equivalentReissue }) }); },
    /replaced the bound head facts capability/,
  );
  const exactTerminal = terminal({ ordinal: "1", facts: boundFacts });
  await ports.performance.sealHeadTerminal({ eligibleHead: eligible, terminal: exactTerminal });
  await ports.terminal.appendTerminal({ terminal: exactTerminal });
  assert.equal(owner.replay().performanceFactsIncompleteCount, "1");
  owner.close();
});

test("an owner-issued Producer terminal cannot enter as an orphan before this owner seals its performance binding", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aloha-production-evidence-orphan-terminal-"));
  const owner = issueSearcherProductionEvidenceOwnerV1({ databasePath: join(directory, "evidence.sqlite"), release, runtimeAnchor: runtimeAnchor() });
  const ports = owner.bindServing(startup());
  const orphan = terminal({ ordinal: "1", facts: null });
  await assert.rejects(
    async () => { await ports.terminal.appendTerminal({ terminal: orphan }); },
    /not bound to a persisted performance terminal/,
  );
  assert.equal(owner.replay().producerTerminalCount, "0");
  owner.close();
});

test("restart retains history but reports each exact runtime-anchor partition independently", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aloha-production-evidence-restart-"));
  const databasePath = join(directory, "evidence.sqlite");
  const first = issueSearcherProductionEvidenceOwnerV1({ databasePath, release, runtimeAnchor: runtimeAnchor() });
  const firstPorts = first.bindServing(startup());
  const firstEligible = await firstPorts.performance.acceptEligibleHead({ head, revision: "0" });
  await firstPorts.performance.bindEligibleHeadSession({ eligibleHead: firstEligible, session: sessionCapability });
  const firstTerminal = terminal({ ordinal: "1", facts: null });
  await firstPorts.performance.sealHeadTerminal({ eligibleHead: firstEligible, terminal: firstTerminal });
  await firstPorts.terminal.appendTerminal({ terminal: firstTerminal });
  const firstReplay = first.replay();
  assert.equal(firstReplay.eventCount, "3");
  assert.equal(firstReplay.partitionCount, "1");
  first.close();

  const second = issueSearcherProductionEvidenceOwnerV1({ databasePath, release, runtimeAnchor: runtimeAnchor("invocation-2") });
  assert.equal(second.replay().eventCount, "0");
  assert.equal(second.replay().eligibleHeadCount, "0");
  assert.equal(second.replay().partitionCount, "1");
  const secondPorts = second.bindServing(startup());
  assert.equal(secondPorts.sixStep.readCompleteAppend(firstTerminal), null);
  const nextHead: CanonicalHead = Object.freeze({ ...head, number: "102", hash: h("b"), parentHash: head.hash });
  const secondEligible = await secondPorts.performance.acceptEligibleHead({ head: nextHead, revision: "0" });
  await secondPorts.performance.bindEligibleHeadSession({ eligibleHead: secondEligible, session: sessionCapability });
  const secondTerminal = terminal({ ordinal: "1", facts: null, source: nextHead });
  await secondPorts.performance.sealHeadTerminal({ eligibleHead: secondEligible, terminal: secondTerminal });
  await secondPorts.terminal.appendTerminal({ terminal: secondTerminal });
  const secondReplay = second.replay();
  assert.equal(secondReplay.eventCount, "3");
  assert.equal(secondReplay.eligibleHeadCount, "1");
  assert.equal(secondReplay.performanceFactsCompleteCount, "0");
  assert.equal(secondReplay.performanceFactsIncompleteCount, "1");
  assert.equal(secondReplay.producerTerminalCount, "1");
  assert.equal(secondReplay.partitionCount, "2");
  assert.notEqual(secondReplay.eventRoot, firstReplay.eventRoot);
  second.close();

  const historical = issueSearcherProductionEvidenceOwnerV1({ databasePath, release, runtimeAnchor: runtimeAnchor() });
  const historicalReplay = historical.replay();
  assert.equal(historicalReplay.eventRoot, firstReplay.eventRoot);
  assert.equal(historicalReplay.currentPartitionId, firstReplay.currentPartitionId);
  assert.deepEqual(
    historicalReplay.partitions.find(partition => partition.partitionId === firstReplay.currentPartitionId),
    firstReplay.partitions[0],
  );
  historical.close();
});

test("restart preserves an admitted partial head instead of deleting it from the denominator", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aloha-production-evidence-partial-"));
  const databasePath = join(directory, "evidence.sqlite");
  const first = issueSearcherProductionEvidenceOwnerV1({ databasePath, release, runtimeAnchor: runtimeAnchor() });
  const ports = first.bindServing(startup());
  const eligible = await ports.performance.acceptEligibleHead({ head, revision: "0" });
  await ports.performance.bindEligibleHeadSession({ eligibleHead: eligible, session: sessionCapability });
  const facts = issueProducerHeadFactsCapabilityV1({
    kind: "aloha.producer-head-facts-v1",
    headHash: head.hash,
    generationId: "generation-1",
    graphRoot,
    laneFacts: Object.freeze([]),
    laneFailureObservations: Object.freeze([]),
    candidateRefs: Object.freeze([]),
    currentSourcePhysical: null,
    sourceCoverageRoot: h("d"),
    complete: false,
  });
  await ports.performance.bindEligibleHeadFacts({ eligibleHead: eligible, facts });
  const before = first.replay();
  assert.equal(before.eventCount, "3");
  assert.equal(before.incompleteAdmissionIds.length, 1);
  first.close();

  const second = issueSearcherProductionEvidenceOwnerV1({ databasePath, release, runtimeAnchor: runtimeAnchor("invocation-2") });
  const afterRestart = second.replay();
  assert.equal(afterRestart.eventCount, "0");
  assert.equal(afterRestart.partitionCount, "1");
  assert.deepEqual(afterRestart.partitions[0], before.partitions[0]);
  assert.equal(afterRestart.partitions[0]?.headCoverageCount, "1");
  assert.equal(afterRestart.partitions[0]?.candidateSetCount, "1");
  assert.equal(afterRestart.partitions[0]?.performanceFactsIncompleteCount, "0");
  second.close();
});
