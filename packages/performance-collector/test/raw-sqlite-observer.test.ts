import assert from "node:assert/strict";
import { once } from "node:events";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { decodeCanonicalBytes, encodeCanonicalBytes, hashDomain, sha256Hex, type Hash } from "../../canonical-codec/src/index.ts";
import { createSqliteDurableStore } from "../../durable-store/src/index.ts";
import { createTerminalPhaseInvalidFactV1 } from "../../final-durable-window/src/internal/owner.ts";
import {
  ProducerRuntimeV1,
  type CanonicalHead,
  type ProducerHeadFactsCapabilityV1,
  type ProducerSessionV1,
} from "../../producer/src/index.ts";
import {
  issueProducerCurrentSourceHeadPortV1,
  issueProducerIngressPortV1,
  issueProducerLanePortV1,
  issueProducerPerformancePortV1,
  issueProducerSessionOwnerV1,
  issueProducerTerminalPortV1,
  readIssuedProducerBackrunIntakeV1,
  readIssuedProducerHeadFactsCapabilityV1,
} from "../../producer/src/internal/owners.ts";
import { issueProducerIngressSourceForTestV1 } from "../../producer/test/fixtures/ingress-source.ts";
import { createSearchTerminalFixture } from "../../producer/test/fixtures/search-terminal.ts";
import { issueStartupRuntime } from "../../startup-runtime/src/internal/runtime-owner.ts";
import { createContractEconomicSafetyService } from "../../search-pipeline/test/economic-safety-fixture.ts";
import type { RuntimeAnchorReceiptV1 } from "../../../apps/searcher-runtime/src/deployment.ts";
import {
  issueSearcherProductionEvidenceOwnerV1,
} from "../../../apps/searcher-runtime/src/production-evidence.ts";
import {
  PRODUCTION_EVIDENCE_NAMESPACES,
  observeProductionPerformanceDatabaseV1,
} from "../src/index.ts";
import { decodeObservedSixStepFactsV1 } from "../src/raw-sqlite-observer.ts";

const h = (digit: string): Hash => `0x${digit.repeat(64)}` as Hash;
const release = Object.freeze({
  bindingId: h("1"),
  releaseProvenanceHash: h("2"),
  candidateReleaseCommit: "a".repeat(40),
});
const economicSafety = createContractEconomicSafetyService(release.releaseProvenanceHash, h);

interface MutableSqliteDatabase {
  exec(sql: string): void;
  close(): void;
}

function openMutableDatabase(path: string): MutableSqliteDatabase {
  const require = createRequire(import.meta.url);
  const loaded = require("node:sqlite") as {
    readonly DatabaseSync?: new (filename: string) => MutableSqliteDatabase;
  };
  if (typeof loaded.DatabaseSync !== "function") throw new TypeError("node:sqlite does not expose DatabaseSync");
  return new loaded.DatabaseSync(path);
}

function runtimeAnchor(): RuntimeAnchorReceiptV1 {
  return Object.freeze({
    kind: "aloha.searcher-runtime-anchor-v1",
    bindingId: release.bindingId,
    releaseProvenanceHash: release.releaseProvenanceHash,
    manifestHash: h("3"),
    manifestArtifactSha256: h("4"),
    runtimeArtifactRoot: h("5"),
    implementationClosureDigest: h("6"),
    candidateReleaseCommit: release.candidateReleaseCommit,
    entrypointSha256: h("7"),
    nodeExecutableSha256: h("8"),
    bundleModulePath: "/opt/aloha/release.mjs",
    bundleModuleSha256: h("9"),
    serviceName: "aloha-searcher",
    systemdUnit: "aloha-searcher.service",
    bootId: "boot-1",
    invocationId: "invocation-1",
    logDevice: "8",
    logInode: "9",
    pid: "42",
    processStartTicks: "7",
    dryRun: true,
  });
}

function startup() {
  const ready = {
    releaseProvenanceHash: release.releaseProvenanceHash,
    readyRecordHash: h("a"),
    sourceCoverageRoot: h("b"),
  } as never;
  const serving = Object.freeze({
    ready,
    generationId: "generation-1",
    graphRoot: h("c"),
    readyRecordHash: h("a"),
    sourceCoverageRoot: h("b"),
    definitionCatalogRoot: h("d"),
    releaseProvenanceHash: release.releaseProvenanceHash,
  });
  return issueStartupRuntime({
    ready,
    familyRuntimeComposition: {} as never,
    generationId: "generation-1",
    graphRoot: h("c"),
    releaseBindingId: release.bindingId,
    candidateReleaseCommit: release.candidateReleaseCommit,
    canonicalSourceAuthority: {} as never,
    readActiveGeneration: () => serving,
    readServingGeneration: (generationId: string) => {
      if (generationId !== serving.generationId) throw new TypeError("unknown test generation");
      return serving;
    },
    readProducerSessionGeneration: () => { throw new Error("not used by raw observer tests"); },
    async withProducerSession() { throw new Error("not used by raw observer tests"); },
    async waitForGenerationIdle() {},
    async close() {},
  });
}

async function productionDatabase(headCount: number): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), "aloha-raw-performance-observer-"));
  const databasePath = join(directory, "production-evidence.sqlite");
  const owner = issueSearcherProductionEvidenceOwnerV1({
    databasePath,
    release,
    runtimeAnchor: runtimeAnchor(),
    economicSafety,
  });
  const ports = owner.bindServing(startup());
  let parentHash = h("d");
  for (let index = 0; index < headCount; index += 1) {
    const head: CanonicalHead = Object.freeze({
      chainId: "1",
      number: (101 + index).toString(),
      hash: h(index === 0 ? "e" : "f"),
      parentHash,
      stateRoot: h("1"),
    });
    await ports.performance.acceptEligibleHead({ head, revision: "0" });
    parentHash = head.hash;
  }
  owner.close();
  return databasePath;
}

async function productionDatabaseWithRouteDenominator(twoDenominatorLanes = false): Promise<string> {
  const fixtureHead: CanonicalHead = Object.freeze({
    chainId: "1",
    number: "151",
    hash: hashDomain("test/raw-route-head/v1", "head"),
    parentHash: hashDomain("test/raw-route-head/v1", "parent"),
    stateRoot: hashDomain("test/raw-route-head/v1", "state"),
  });
  const fixture = createSearchTerminalFixture({
    head: fixtureHead,
    generationId: "generation-route-denominator",
    mode: "policy-rejected",
    releaseProvenanceHash: release.releaseProvenanceHash,
  });
  const pendingTxHash = hashDomain("test/raw-route-pending-transaction/v1", fixtureHead);
  const pendingTransaction = Object.freeze({ hash: pendingTxHash, from: hashDomain("test/raw-route-pending-sender/v1", fixtureHead) });
  const orderedTransactionHashes = twoDenominatorLanes ? Object.freeze([pendingTxHash]) : Object.freeze([]) as readonly Hash[];
  const pendingBody = Object.freeze({
    pendingNumber: "152",
    parentHash: fixtureHead.hash,
    orderedTransactionHashes,
    orderedTransactionHashesRoot: hashDomain("aloha/public-pending-transaction-set/v1", orderedTransactionHashes),
    transactionCount: orderedTransactionHashes.length.toString(),
  });
  const pending = Object.freeze({
    ...pendingBody,
    snapshotHash: hashDomain("aloha/public-pending-snapshot/v1", { head: fixtureHead, ...pendingBody }),
  });
  const ingressSource = issueProducerIngressSourceForTestV1({
    observe: async () => ({
      head: fixtureHead,
      blockscan: { input: Object.freeze({ kind: "blockscan" }) },
      backrun: twoDenominatorLanes
        ? {
            kind: "pending-transaction" as const,
            snapshot: pending,
            txHash: pendingTxHash,
            affectedEdgeIds: Object.freeze([]),
            pendingEvidenceHash: hashDomain("aloha/public-pending-transaction-evidence/v2", {
              head: fixtureHead,
              snapshotHash: pending.snapshotHash,
              transaction: pendingTransaction,
            }),
            input: Object.freeze({ pendingTransaction }),
          }
        : {
            kind: "observed-empty" as const,
            snapshot: pending,
            absenceEvidenceHash: hashDomain("aloha/public-pending-absence-evidence/v1", {
              head: fixtureHead,
              snapshotHash: pending.snapshotHash,
            }),
          },
    }),
  });
  const envelope = await issueProducerIngressPortV1(ingressSource).observe({
    head: fixtureHead,
    signal: new AbortController().signal,
  });
  assert.ok(envelope);
  let factsCapability: ProducerHeadFactsCapabilityV1 | null = null;
  const admitted = Object.freeze({
    admissionId: hashDomain("test/raw-route-admission/v1", fixtureHead),
    ordinal: "1",
    headHash: fixtureHead.hash,
    revision: "0",
  });
  const runtime = new ProducerRuntimeV1({
    sessionOwner: issueProducerSessionOwnerV1({ async withProducerSession(_head, run) { return run(fixture.session); } }),
    blockscan: issueProducerLanePortV1({ kind: "blockscan", run: async request => (await fixture.run(request)).draft }),
    backrun: issueProducerLanePortV1({
      kind: "backrun",
      async run(request) {
        const intake = readIssuedProducerBackrunIntakeV1(request.input);
        if (intake.kind === "pending-transaction") return (await fixture.run(request)).draft;
        if (intake.kind !== "observed-empty") throw new TypeError("route denominator fixture expected empty backrun");
        return {
          kind: "no-input" as const,
          absence: request.input as never,
          currentSource: fixture.logicalFacts("backrun", intake.correlationId),
        };
      },
    }),
    currentSource: issueProducerCurrentSourceHeadPortV1({ closeHead: () => fixture.closePhysicalFacts() }),
    performance: issueProducerPerformancePortV1<unknown>({
      acceptEligibleHead: () => admitted,
      readEligibleHeadBinding(value) {
        if (value !== admitted) throw new TypeError("route denominator fixture admission mismatch");
        return admitted;
      },
      bindEligibleHeadSession: ({ eligibleHead }) => eligibleHead,
      bindEligibleHeadFacts({ eligibleHead, facts }) { factsCapability = facts; return eligibleHead; },
      sealHeadTerminal() {},
    }),
    terminal: issueProducerTerminalPortV1({ appendTerminal() {} }),
  });
  await runtime.submit(envelope);
  await runtime.waitForIdle();
  assert.ok(factsCapability);
  const facts = readIssuedProducerHeadFactsCapabilityV1(factsCapability);
  assert.equal(facts.laneFacts.length, 2);
  assert.equal(facts.laneFacts.filter(lane => lane.accounting !== null).length, twoDenominatorLanes ? 2 : 1);
  if (facts.generationId === null || facts.graphRoot === null) {
    throw new TypeError("route denominator fixture expected a bound generation and graph");
  }

  const binding = fixture.session.lease.binding;
  const ready = {
    releaseProvenanceHash: release.releaseProvenanceHash,
    readyRecordHash: binding.readyRecordHash,
    sourceCoverageRoot: facts.sourceCoverageRoot,
    definitionCatalogRoot: binding.definitionCatalogRoot,
  } as never;
  const serving = Object.freeze({
    ready,
    generationId: facts.generationId,
    graphRoot: facts.graphRoot,
    readyRecordHash: binding.readyRecordHash,
    sourceCoverageRoot: facts.sourceCoverageRoot,
    definitionCatalogRoot: binding.definitionCatalogRoot,
    releaseProvenanceHash: release.releaseProvenanceHash,
  });
  const fixtureStartup = issueStartupRuntime({
    ready,
    familyRuntimeComposition: {} as never,
    generationId: serving.generationId,
    graphRoot: serving.graphRoot,
    releaseBindingId: release.bindingId,
    candidateReleaseCommit: release.candidateReleaseCommit,
    canonicalSourceAuthority: {} as never,
    readActiveGeneration: () => serving,
    readServingGeneration: generationId => {
      if (generationId !== serving.generationId) throw new TypeError("route denominator fixture generation mismatch");
      return serving;
    },
    readProducerSessionGeneration: session => {
      if (session !== fixture.session) throw new TypeError("route denominator fixture session mismatch");
      return serving;
    },
    async withProducerSession() { throw new TypeError("not used by route denominator observer fixture"); },
    async waitForGenerationIdle() {},
    async close() {},
  });
  const directory = mkdtempSync(join(tmpdir(), "aloha-route-denominator-observer-"));
  const databasePath = join(directory, "production-evidence.sqlite");
  const owner = issueSearcherProductionEvidenceOwnerV1({ databasePath, release, runtimeAnchor: runtimeAnchor(), economicSafety });
  const ports = owner.bindServing(fixtureStartup);
  const eligible = await ports.performance.acceptEligibleHead({ head: fixtureHead, revision: "0" });
  await ports.performance.bindEligibleHeadSession({ eligibleHead: eligible, session: fixture.session as ProducerSessionV1 });
  await ports.performance.bindEligibleHeadFacts({ eligibleHead: eligible, facts: factsCapability });
  owner.close();
  const restartedOwner = issueSearcherProductionEvidenceOwnerV1({ databasePath, release, runtimeAnchor: runtimeAnchor(), economicSafety });
  restartedOwner.bindServing(fixtureStartup);
  restartedOwner.close();
  return databasePath;
}

function mutateAppendLog(databasePath: string, sql: string, restoreUpdateTrigger = true): void {
  const database = openMutableDatabase(databasePath);
  try {
    database.exec("DROP TRIGGER durable_append_log_no_update");
    database.exec(sql);
    if (restoreUpdateTrigger) {
      database.exec(`
        CREATE TRIGGER durable_append_log_no_update
        BEFORE UPDATE ON durable_append_log
        BEGIN
          SELECT RAISE(ABORT, 'durable append-log is append-only');
        END
      `);
    }
  } finally {
    database.close();
  }
}

function deleteRouteDenominatorRow(databasePath: string): void {
  const database = openMutableDatabase(databasePath);
  try {
    database.exec("DROP TRIGGER durable_append_log_no_delete");
    database.exec(`
      DELETE FROM durable_append_log
      WHERE namespace='${PRODUCTION_EVIDENCE_NAMESPACES.routeDenominators}' AND sequence='1'
    `);
    database.exec(`
      CREATE TRIGGER durable_append_log_no_delete
      BEFORE DELETE ON durable_append_log
      BEGIN
        SELECT RAISE(ABORT, 'durable append-log is append-only');
      END
    `);
  } finally {
    database.close();
  }
}

function appendTerminalInvalidEvent(databasePath: string) {
  const terminalFact = createTerminalPhaseInvalidFactV1({
    finalDurableWindowId: h("f"),
    reasonCode: "terminal-phase-process-anchor-changed",
    observed: null,
    recordedMonotonicNs: "900",
  });
  const eventWithoutId = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.searcher-production-evidence-event" as const,
    eventType: "terminal-phase-invalid" as const,
    sequence: "0",
    namespace: PRODUCTION_EVIDENCE_NAMESPACES.terminalPhase,
    release,
    runtimeAnchor: runtimeAnchor(),
    serving: Object.freeze({
      generationId: "generation-1",
      graphRoot: h("c"),
      readyRecordHash: h("a"),
      sourceCoverageRoot: h("b"),
    }),
    payload: terminalFact,
  });
  const eventId = hashDomain("aloha/searcher-production-evidence-event/v1", eventWithoutId);
  const bytes = encodeCanonicalBytes({ ...eventWithoutId, eventId });
  const store = createSqliteDurableStore(databasePath);
  try {
    store.bindStoreRole("searcher-production-evidence");
    store.appendFsyncMonotonic({
      namespace: PRODUCTION_EVIDENCE_NAMESPACES.terminalPhase,
      sequence: "0",
      eventId,
      contentSha256: sha256Hex(bytes),
      bytes,
    });
  } finally {
    store.close();
  }
  return Object.freeze({ terminalFact, eventWithoutId });
}

function replaceTerminalEvent(databasePath: string, eventWithoutId: Readonly<Record<string, unknown>>): void {
  const eventId = hashDomain("aloha/searcher-production-evidence-event/v1", eventWithoutId);
  const bytes = encodeCanonicalBytes({ ...eventWithoutId, eventId });
  mutateAppendLog(databasePath, `
    UPDATE durable_append_log
    SET event_id='${eventId}', content_sha256='${sha256Hex(bytes)}', bytes=X'${Buffer.from(bytes).toString("hex")}',
        byte_length='${bytes.byteLength}', offset_end='${bytes.byteLength}'
    WHERE namespace='${PRODUCTION_EVIDENCE_NAMESPACES.terminalPhase}' AND sequence='0'
  `);
}

function replaceEventBytes(
  databasePath: string,
  namespace: string,
  sequence: string,
  eventWithoutId: Readonly<Record<string, unknown>>,
): void {
  const eventId = hashDomain("aloha/searcher-production-evidence-event/v1", eventWithoutId);
  const bytes = encodeCanonicalBytes({ ...eventWithoutId, eventId });
  mutateAppendLog(databasePath, `
    UPDATE durable_append_log
    SET event_id='${eventId}', content_sha256='${sha256Hex(bytes)}', bytes=X'${Buffer.from(bytes).toString("hex")}'
    WHERE namespace='${namespace}' AND sequence='${sequence}'
  `);
}

test("raw observer reads a production-owned SQLite log without writing it and remains fail-closed before exact 100", async () => {
  const databasePath = await productionDatabase(1);
  const observation = observeProductionPerformanceDatabaseV1(databasePath);
  assert.equal(observation.status, "incomplete", JSON.stringify(observation.reasons));
  assert.equal(observation.databaseSha256After, observation.databaseSha256Before);
  assert.equal(observation.storageSetRootAfter, observation.storageSetRootBefore);
  assert.deepEqual(observation.events.map(event => event.eventType), ["eligible-head"]);
  assert.equal(observation.bundle, null);
  assert.ok(observation.reasons.includes("eligible-head-count-not-100"));
  assert.ok(observation.reasons.includes("performance-window-basis-cardinality"));
});

test("raw observer independently joins the physical route denominator before candidate-set judgment", async () => {
  const databasePath = await productionDatabaseWithRouteDenominator();
  const observation = observeProductionPerformanceDatabaseV1(databasePath);
  assert.equal(observation.status, "incomplete", JSON.stringify(observation.reasons));
  assert.equal(observation.databaseSha256After, observation.databaseSha256Before);
  assert.equal(observation.storageSetRootAfter, observation.storageSetRootBefore);
  const denominators = observation.events.filter(event => event.eventType === "route-denominator");
  assert.equal(denominators.length, 2);
  assert.deepEqual(denominators.map(event => ({
    lane: event.payload.lane,
    denominatorKind: event.payload.denominatorKind,
  })), [
    { lane: "blockscan", denominatorKind: "accounted" },
    { lane: "backrun", denominatorKind: "no-input" },
  ]);
  assert.ok(!observation.reasons.some(reason => reason.includes("route-denominator")), JSON.stringify(observation.reasons));
});

test("raw observer preserves the fixed blockscan-before-backrun denominator order", async () => {
  const databasePath = await productionDatabaseWithRouteDenominator(true);
  const observation = observeProductionPerformanceDatabaseV1(databasePath);
  assert.equal(observation.status, "incomplete", JSON.stringify(observation.reasons));
  const denominators = observation.events.filter(event => event.eventType === "route-denominator");
  assert.equal(denominators.length, 2);
  assert.deepEqual(denominators.map(event => (event.payload as { readonly lane: string }).lane), ["blockscan", "backrun"]);
  assert.ok(!observation.reasons.some(reason => reason.includes("route-denominator")), JSON.stringify(observation.reasons));
});

test("per-head raw receipt root and log range consume the denominator-expanded relevant event set", () => {
  const source = readFileSync(new URL("../src/raw-sqlite-observer.ts", import.meta.url), "utf8");
  const projection = source.slice(source.indexOf("function projectPerformanceBundle("), source.indexOf("const RAW_SIX_STEP_SELECTION_POLICY_DIGEST"));
  const relevant = projection.slice(projection.indexOf("const relevantEvents = ["), projection.indexOf("const headDurationUs"));
  assert.ok(relevant.indexOf("joined.coverage") < relevant.indexOf("...orderedRouteDenominators"));
  assert.ok(relevant.indexOf("...orderedRouteDenominators") < relevant.indexOf("joined.candidates"));
  assert.match(relevant, /rawReceiptSetRoot = hashDomain\([\s\S]*relevantEvents\.map/);
  assert.match(relevant, /relevantRows = relevantEvents\.map/);
  const legacyRoot = hashDomain("aloha/raw-production-performance-head-receipt-set/v1", [h("1"), h("2"), h("5")]);
  const denominatorExpandedRoot = hashDomain("aloha/raw-production-performance-head-receipt-set/v1", [h("1"), h("2"), h("3"), h("4"), h("5")]);
  assert.notEqual(denominatorExpandedRoot, legacyRoot);
});

test("raw Six-Step facts retain only bounded Ready roots and selected Stage1/2 parents", () => {
  const legs = Object.freeze(["a", "b"].map((digit, index) => Object.freeze({
    edgeId: h(digit),
    owningFamilyId: `family-${index}`,
    owningFamilyDefinitionHash: h(index === 0 ? "c" : "d"),
    owningInstanceKey: `instance-${index}`,
    instancePublicationHash: h(index === 0 ? "e" : "f"),
    staticProjectionHash: h(index === 0 ? "1" : "2"),
    projectionHash: h(index === 0 ? "3" : "4"),
  })));
  const stage3ArtifactSetRoot = h("5");
  const stage12 = Object.freeze({
    binding: Object.freeze({
      readyRecordHash: h("6"),
      generationId: "generation-30k",
      cutoff: Object.freeze({ chainId: "1", number: "100", hash: h("7"), stateRoot: h("8") }),
      definitionCatalogRoot: h("9"),
      sourceCoverageRoot: h("a"),
      candidatePartitionRoot: h("b"),
      exactOutcomePartitionRoot: h("c"),
      verifiedMemoSetRoot: h("d"),
      instanceCatalogRoot: h("e"),
      graphRoot: h("f"),
      releaseProvenanceHash: h("1"),
      promotionRevision: "12",
    }),
    selectedParents: Object.freeze(legs.map((leg, index) => Object.freeze({
      edgeId: leg.edgeId,
      selectedLegRoot: hashDomain("aloha/searcher-production-evidence-selected-graph-leg/v1", leg),
      stage1EventId: h(index === 0 ? "2" : "3"),
      stage1ArtifactSetRoot: h(index === 0 ? "4" : "5"),
      stage2EventId: h(index === 0 ? "6" : "7"),
      stage2ArtifactSetRoot: h(index === 0 ? "8" : "9"),
      instancePublicationRoot: h(index === 0 ? "a" : "b"),
      edgeContentRoot: h(index === 0 ? "c" : "d"),
    }))),
    stage3EventId: h("e"),
    stage3ArtifactSetRoot,
  });
  const stage36Body = Object.freeze({
    selectedGraphLegs: legs,
    resolved: Object.freeze({
      productionArtifactSetRoots: Object.freeze([stage3ArtifactSetRoot, h("6"), h("7"), h("8")]),
      timings: Object.freeze({
        planner: Object.freeze({ startedMonotonicNs: "1000", finishedMonotonicNs: "2000", durationUs: "1" }),
        exact: Object.freeze({ startedMonotonicNs: "2000", finishedMonotonicNs: "3000", durationUs: "1" }),
        executionProgram: Object.freeze({ startedMonotonicNs: "3000", finishedMonotonicNs: "4000", durationUs: "1" }),
        finalSimulation: Object.freeze({ startedMonotonicNs: "4000", finishedMonotonicNs: "5000", durationUs: "1" }),
      }),
    }),
  });
  const stage36 = Object.freeze({
    ...stage36Body,
    traceRoot: hashDomain("aloha/search-terminal-six-step-trace/v1", stage36Body),
  });
  const stage12Root = hashDomain("aloha/searcher-production-evidence-stage12/v1", stage12);
  const joined = Object.freeze({
    stage12,
    stage36,
    stage12Root,
    stage36Root: stage36.traceRoot,
    lineageRoot: hashDomain("aloha/searcher-production-evidence-six-step-lineage/v1", { stage12Root, stage36Root: stage36.traceRoot }),
  });
  const observed = decodeObservedSixStepFactsV1(joined);
  assert.equal(observed.stage12Root, stage12Root);
  assert.ok(encodeCanonicalBytes(stage12).byteLength < 16_000);
  for (const forbidden of ["candidates", "outcomes", "verifiedInstances", "instanceCatalog", "graph"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(stage12, forbidden), false);
  }
  assert.throws(() => decodeObservedSixStepFactsV1({
    ...joined,
    stage12: { ...stage12, candidates: [] },
  }), /unknown field/);
  assert.throws(() => decodeObservedSixStepFactsV1({
    ...joined,
    stage12: { ...stage12, selectedParents: [stage12.selectedParents[1], stage12.selectedParents[0]] },
  }), /selected parent leg mismatch/);
  assert.throws(() => decodeObservedSixStepFactsV1({
    ...joined,
    stage12: { ...stage12, selectedParents: [stage12.selectedParents[0], stage12.selectedParents[0]] },
  }), /duplicate edges/);
});

test("raw observer rejects self-consistent candidate/coarse shrink when the backrun coverage denominator row is missing", async () => {
  const databasePath = await productionDatabaseWithRouteDenominator();
  deleteRouteDenominatorRow(databasePath);
  const observation = observeProductionPerformanceDatabaseV1(databasePath);
  assert.equal(observation.status, "invalid", JSON.stringify(observation.reasons));
  assert.match(observation.reasons.join("\n"), /route-denominator lane set mismatch/);
});

test("raw observer rejects no-input snapshot, absence, lineage, and current-source splices", async t => {
  const mutations = [
    ["pending snapshot body", (payload: Record<string, unknown>) => ({
      ...payload,
      pendingSnapshot: { ...(payload.pendingSnapshot as Record<string, unknown>), pendingNumber: "153" },
    })],
    ["absence evidence", (payload: Record<string, unknown>) => ({ ...payload, absenceEvidenceHash: h("7") })],
    ["terminal lineage", (payload: Record<string, unknown>) => ({ ...payload, terminalLineageHash: h("8") })],
    ["current-source identity", (payload: Record<string, unknown>) => ({
      ...payload,
      currentSource: {
        ...(payload.currentSource as Record<string, unknown>),
        source: { ...((payload.currentSource as Record<string, unknown>).source as Record<string, unknown>), stateRoot: h("9") },
      },
    })],
  ] as const;
  for (const [name, mutate] of mutations) {
    await t.test(name, async () => {
      const databasePath = await productionDatabaseWithRouteDenominator();
      const before = observeProductionPerformanceDatabaseV1(databasePath);
      const denominator = before.events.find(event => event.eventType === "route-denominator"
        && event.payload.denominatorKind === "no-input");
      assert.ok(denominator);
      const { eventId: _eventId, ...eventWithoutId } = denominator;
      replaceEventBytes(databasePath, denominator.namespace, denominator.sequence, {
        ...eventWithoutId,
        payload: mutate(denominator.payload as Record<string, unknown>),
      });
      const observation = observeProductionPerformanceDatabaseV1(databasePath);
      assert.equal(observation.status, "invalid", JSON.stringify(observation.reasons));
      assert.match(observation.reasons.join("\n"), /no-input route-denominator splice/);
    });
  }
});

test("raw observer exact-decodes but excludes the independent terminal-phase namespace", async () => {
  const databasePath = await productionDatabase(1);
  const beforeTerminal = observeProductionPerformanceDatabaseV1(databasePath);
  const { terminalFact, eventWithoutId } = appendTerminalInvalidEvent(databasePath);
  const observation = observeProductionPerformanceDatabaseV1(databasePath);
  assert.equal(observation.status, "incomplete", JSON.stringify(observation.reasons));
  assert.deepEqual(observation.events.map(event => event.eventType), ["eligible-head"]);
  assert.equal(observation.rawRowRoot, beforeTerminal.rawRowRoot);
  assert.equal(observation.eventRoot, beforeTerminal.eventRoot);
  assert.equal(observation.terminalPhaseRowCount, "1");
  assert.notEqual(observation.terminalPhaseRowRoot, h("0"));
  const restartedObserver = observeProductionPerformanceDatabaseV1(databasePath);
  assert.equal(restartedObserver.terminalPhaseRowCount, "1");
  assert.equal(restartedObserver.terminalPhaseRowRoot, observation.terminalPhaseRowRoot);
  assert.equal(restartedObserver.rawRowRoot, observation.rawRowRoot);
  assert.equal(restartedObserver.eventRoot, observation.eventRoot);

  const forgedWithoutId = {
    ...eventWithoutId,
    payload: { ...terminalFact, factId: h("9") },
  };
  replaceTerminalEvent(databasePath, forgedWithoutId);
  const forged = observeProductionPerformanceDatabaseV1(databasePath);
  assert.equal(forged.status, "invalid");
  assert.match(forged.reasons.join("\n"), /factId mismatch/);
  assert.equal(forged.terminalPhaseRowCount, "0");
});

test("raw observer ignores an independently owned runtime-acceptance namespace", async () => {
  const databasePath = await productionDatabase(1);
  const before = observeProductionPerformanceDatabaseV1(databasePath);
  const durable = createSqliteDurableStore(databasePath);
  try {
    durable.bindStoreRole("searcher-production-evidence");
    const bytes = encodeCanonicalBytes({ kind: "independent-runtime-acceptance-fixture" });
    durable.appendFsyncMonotonicCapability({
      namespace: `runtime-acceptance-process-v1:${release.releaseProvenanceHash.slice(2)}`,
      sequence: "0",
      eventId: h("f"),
      contentSha256: sha256Hex(bytes),
      bytes,
    });
  } finally {
    durable.close();
  }
  const observation = observeProductionPerformanceDatabaseV1(databasePath);
  assert.equal(observation.status, before.status);
  assert.deepEqual(observation.reasons, before.reasons);
  assert.equal(observation.rawRowRoot, before.rawRowRoot);
  assert.equal(observation.eventRoot, before.eventRoot);
  assert.equal(observation.terminalPhaseRowCount, before.terminalPhaseRowCount);
  assert.equal(observation.databaseSha256After, observation.databaseSha256Before);
  assert.equal(observation.storageSetRootAfter, observation.storageSetRootBefore);
});

test("raw observer rejects a self-consistent terminal row with an unknown event type", async () => {
  const databasePath = await productionDatabase(1);
  const { eventWithoutId } = appendTerminalInvalidEvent(databasePath);
  replaceTerminalEvent(databasePath, { ...eventWithoutId, eventType: "terminal-phase-future" });
  const observation = observeProductionPerformanceDatabaseV1(databasePath);
  assert.equal(observation.status, "invalid", JSON.stringify(observation.reasons));
  assert.match(observation.reasons.join("\n"), /event schema\/kind\/type mismatch/);
  assert.equal(observation.terminalPhaseRowCount, "0");
});

test("raw observer still rejects a self-consistent release/runtime splice", async () => {
  const databasePath = await productionDatabase(2);
  const before = observeProductionPerformanceDatabaseV1(databasePath);
  const eligible = before.events.filter(event => event.eventType === "eligible-head")[1];
  assert.ok(eligible !== undefined);
  const releaseSplice = { ...eligible.release, bindingId: h("e"), releaseProvenanceHash: h("f") };
  const runtimeSplice = { ...eligible.runtimeAnchor, bindingId: releaseSplice.bindingId, releaseProvenanceHash: releaseSplice.releaseProvenanceHash };
  const payloadWithoutAdmissionId = { ...eligible.payload } as Record<string, unknown>;
  delete payloadWithoutAdmissionId.admissionId;
  const payload = {
    ...eligible.payload,
    admissionId: hashDomain("aloha/searcher-production-evidence-admission/v1", {
      release: releaseSplice,
      runtimeAnchor: runtimeSplice,
      ...payloadWithoutAdmissionId,
    }),
  };
  replaceEventBytes(databasePath, eligible.namespace, eligible.sequence, {
    schemaVersion: eligible.schemaVersion,
    kind: eligible.kind,
    eventType: eligible.eventType,
    sequence: eligible.sequence,
    namespace: eligible.namespace,
    release: releaseSplice,
    runtimeAnchor: runtimeSplice,
    serving: eligible.serving,
    payload,
  });
  const observation = observeProductionPerformanceDatabaseV1(databasePath);
  assert.equal(observation.status, "invalid", JSON.stringify(observation.reasons));
  assert.match(observation.reasons.join("\n"), /multiple release\/runtime partitions/);
});

test("raw observer rejects a self-consistent terminal row with a malformed envelope", async () => {
  const databasePath = await productionDatabase(1);
  const { eventWithoutId } = appendTerminalInvalidEvent(databasePath);
  const malformed = { ...eventWithoutId } as Record<string, unknown>;
  delete malformed.payload;
  replaceTerminalEvent(databasePath, malformed);
  const observation = observeProductionPerformanceDatabaseV1(databasePath);
  assert.equal(observation.status, "invalid");
  assert.match(observation.reasons.join("\n"), /missing field "payload"/);
  assert.equal(observation.terminalPhaseRowCount, "0");
});

test("raw observer rejects a content-hash splice even when the append-only trigger is restored", async () => {
  const databasePath = await productionDatabase(1);
  mutateAppendLog(databasePath, `
    UPDATE durable_append_log
    SET content_sha256='${h("f")}'
    WHERE namespace='${PRODUCTION_EVIDENCE_NAMESPACES.eligibleHeads}' AND sequence='0'
  `);
  const observation = observeProductionPerformanceDatabaseV1(databasePath);
  assert.equal(observation.status, "invalid");
  assert.equal(observation.databaseSha256After, observation.databaseSha256Before);
  assert.equal(observation.storageSetRootAfter, observation.storageSetRootBefore);
  assert.match(observation.reasons[0] ?? "", /content identity mismatch/);
});

test("raw observer rejects a per-namespace sequence gap and offset lineage splice", async () => {
  const databasePath = await productionDatabase(2);
  mutateAppendLog(databasePath, `
    UPDATE durable_append_log
    SET sequence='2', offset_start='0'
    WHERE namespace='${PRODUCTION_EVIDENCE_NAMESPACES.eligibleHeads}' AND sequence='1'
  `);
  const observation = observeProductionPerformanceDatabaseV1(databasePath);
  assert.equal(observation.status, "invalid");
  assert.match(observation.reasons[0] ?? "", /sequence\/offset mismatch/);
});

test("raw observer rejects a row event identity splice after append-only restoration", async () => {
  const databasePath = await productionDatabase(1);
  mutateAppendLog(databasePath, `
    UPDATE durable_append_log
    SET event_id='${h("3")}'
    WHERE namespace='${PRODUCTION_EVIDENCE_NAMESPACES.eligibleHeads}' AND sequence='0'
  `);
  const observation = observeProductionPerformanceDatabaseV1(databasePath);
  assert.equal(observation.status, "invalid");
  assert.match(observation.reasons[0] ?? "", /row\/event identity mismatch/);
});

test("raw observer rejects a self-declared append schema digest", async () => {
  const databasePath = await productionDatabase(1);
  const database = openMutableDatabase(databasePath);
  try {
    database.exec(`UPDATE durable_append_log_schema_contract SET schema_digest='${h("4")}' WHERE contract_id=1`);
  } finally {
    database.close();
  }
  const observation = observeProductionPerformanceDatabaseV1(databasePath);
  assert.equal(observation.status, "invalid");
  assert.match(observation.reasons[0] ?? "", /schema digest mismatch/);
});

test("raw observer rejects a missing append-only schema boundary", async () => {
  const databasePath = await productionDatabase(1);
  mutateAppendLog(databasePath, "SELECT 1", false);
  const observation = observeProductionPerformanceDatabaseV1(databasePath);
  assert.equal(observation.status, "invalid");
  assert.match(observation.reasons[0] ?? "", /SQLite object set mismatch/);
});

test("raw observer invalidates a snapshot when the durable WAL changes concurrently", async () => {
  const databasePath = await productionDatabase(1);
  const stop = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const worker = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    const { DatabaseSync } = require("node:sqlite");
    const database = new DatabaseSync(workerData.databasePath);
    const insert = database.prepare("INSERT INTO durable_content(hash, payload_hash, kind, bytes, byte_length, references_json, created_at_ms) VALUES (?, ?, 'concurrent-observation', X'00', 1, '[]', ?)");
    const stop = new Int32Array(workerData.stop);
    const write = (index) => {
      const hash = "0x" + index.toString(16).padStart(64, "0");
      insert.run(hash, hash, index);
    };
    write(1);
    parentPort.postMessage("started");
    for (let index = 2; Atomics.load(stop, 0) === 0; index += 1) write(index);
    database.close();
  `, { eval: true, workerData: { databasePath, stop } });
  await once(worker, "message");
  const observation = observeProductionPerformanceDatabaseV1(databasePath);
  Atomics.store(new Int32Array(stop), 0, 1);
  await once(worker, "exit");
  assert.equal(observation.status, "invalid");
  assert.notEqual(observation.storageSetRootAfter, observation.storageSetRootBefore);
});
