import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { appendFileSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { encodeCanonicalBytes, encodeCanonicalJson, hashDomain, sha256Hex, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { createSqliteDurableStore } from "../../../packages/durable-store/src/index.ts";
import { hashProcessAnchor } from "../../../specs/core-envelope/src/index.ts";
import { observeRuntimeAcceptanceProcessDatabaseV1 } from "../src/raw-runtime-acceptance-observer.ts";

const h = (value: string): Hash => hashDomain("test/raw-runtime-acceptance-observer/v1", value);
const release = Object.freeze({
  bindingId: h("binding"),
  releaseProvenanceHash: h("release"),
  candidateReleaseCommit: "1".repeat(40),
});
const namespace = `runtime-acceptance-process-v1:${release.releaseProvenanceHash.slice(2)}`;
const processAnchor = Object.freeze({
  systemId: "test-system",
  commitSha: release.candidateReleaseCommit,
  executableHash: h("executable"),
  deploymentManifestHash: h("manifest"),
  serviceIdentityHash: h("service"),
  pid: "41",
  processStartTicks: "101",
  bootIdHash: h("boot"),
});
const processAnchorHash = hashProcessAnchor(processAnchor);

function event(payload: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const withoutId = Object.freeze({ schemaVersion: 1, release, processAnchorHash, ...payload });
  return Object.freeze({ ...withoutId, eventId: hashDomain("aloha/runtime-acceptance-process-event/v1", withoutId) });
}

function ready(
  sequence: string,
  logStart: Readonly<{ device: string; inode: string; startInclusive: string; path: string; systemId: string }>,
  pid: string = processAnchor.pid,
): Readonly<Record<string, unknown>> {
  const anchor = Object.freeze({ ...processAnchor, pid, processStartTicks: String(BigInt(pid) + 100n) });
  return event({
    kind: "aloha.runtime-process-ready",
    sequence,
    runtimeAnchor: Object.freeze({ invocationId: h(`invocation/${pid}`) }),
    staticArtifacts: Object.freeze({ observed: true }),
    strategy: Object.freeze({ observed: true }),
    checkpointRoot: Object.freeze({ revision: sequence }),
    checkpointStore: Object.freeze({ path: logStart.path, device: logStart.device, inode: logStart.inode }),
    stage12: Object.freeze({ binding: h(`stage12/${sequence}`) }),
    checkpointProbeEvidence: null,
    processAnchor: anchor,
    processAnchorHash: hashProcessAnchor(anchor),
    logStart,
  });
}

function marker(value: Readonly<Record<string, unknown>>): string {
  return `${encodeCanonicalJson({
    schemaVersion: 1,
    kind: "aloha.runtime-process-log-marker",
    eventKind: value.kind,
    eventId: value.eventId,
    processAnchorHash: value.processAnchorHash,
    releaseProvenanceHash: release.releaseProvenanceHash,
    sequence: value.sequence,
  })}\n`;
}

function observed(sequence: string, processReadyEventId: Hash, anchorHash: Hash): Readonly<Record<string, unknown>> {
  return event({
    kind: "aloha.runtime-sigterm-observed",
    sequence,
    processAnchorHash: anchorHash,
    processReadyEventId,
    checkpointRootBefore: Object.freeze({ revision: "1" }),
    checkpointRestartBefore: Object.freeze({ runId: "run-1" }),
    outcomePartitionRootBefore: h("before-partition"),
    outcomeHashesBefore: Object.freeze([h("before-outcome")]),
  });
}

function drained(
  sequence: string,
  sigtermObservedEventId: Hash,
  anchorHash: Hash,
  logWindow: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const after = h("after-outcome");
  return event({
    kind: "aloha.runtime-sigterm-drained",
    sequence,
    processAnchorHash: anchorHash,
    sigtermObservedEventId,
    checkpointRootAfter: Object.freeze({ revision: "2" }),
    checkpointRestartAfter: Object.freeze({ runId: "run-1" }),
    outcomePartitionRootAfter: h("after-partition"),
    outcomeHashesAfter: Object.freeze([after]),
    flushedOutcomeHashes: Object.freeze([after]),
    logWindow,
  });
}

function emptyLog(directory: string): Readonly<{
  readonly path: string;
  readonly device: string;
  readonly inode: string;
  readonly startInclusive: string;
  readonly systemId: string;
}> {
  const requested = join(directory, "searcher.log");
  writeFileSync(requested, "");
  const path = realpathSync(requested);
  const stat = statSync(path, { bigint: true });
  return Object.freeze({ path, device: String(stat.dev), inode: String(stat.ino), startInclusive: String(stat.size), systemId: processAnchor.systemId });
}

function append(databasePath: string, events: readonly Readonly<Record<string, unknown>>[]): void {
  const store = createSqliteDurableStore(databasePath);
  store.bindStoreRole("searcher-production-evidence");
  for (const [index, value] of events.entries()) {
    const bytes = encodeCanonicalBytes(value);
    store.appendFsyncMonotonic({
      namespace,
      sequence: String(index),
      eventId: value.eventId as Hash,
      contentSha256: sha256Hex(bytes),
      bytes,
    });
  }
  store.close();
}

test("independent reader reports an ordinary stop as typed incomplete", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aloha-raw-runtime-ordinary-"));
  try {
    const databasePath = join(directory, "evidence.sqlite");
    const logStart = emptyLog(directory);
    const processReady = ready("0", logStart);
    appendFileSync(logStart.path, marker(processReady));
    append(databasePath, [processReady]);
    const observed = observeRuntimeAcceptanceProcessDatabaseV1(databasePath);
    assert.equal(observed.status, "incomplete");
    assert.ok(observed.reasons.includes("runtime-sigterm-observation-missing"));
    assert.equal(observed.events.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("independent reader joins a complete raw SIGTERM and second-process lineage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aloha-raw-runtime-lineage-"));
  try {
    const databasePath = join(directory, "evidence.sqlite");
    const logStart = emptyLog(directory);
    const first = ready("0", logStart);
    const signal = observed("1", first.eventId as Hash, first.processAnchorHash as Hash);
    appendFileSync(logStart.path, `${marker(first)}${marker(signal)}`);
    const firstRange = new Uint8Array(readFileSync(logStart.path));
    const drain = drained("2", signal.eventId as Hash, first.processAnchorHash as Hash, Object.freeze({
      systemId: processAnchor.systemId,
      bootIdHash: processAnchor.bootIdHash,
      device: logStart.device,
      inode: logStart.inode,
      startInclusive: logStart.startInclusive,
      endExclusive: String(firstRange.byteLength),
      contentSha256: sha256Hex(firstRange),
    }));
    const secondStart = Object.freeze({ ...logStart, startInclusive: String(firstRange.byteLength) });
    const second = ready("3", secondStart, "42");
    appendFileSync(logStart.path, marker(second));
    append(databasePath, [first, signal, drain, second]);
    const result = observeRuntimeAcceptanceProcessDatabaseV1(databasePath);
    assert.equal(result.status, "raw-complete");
    assert.deepEqual(result.reasons, []);
    assert.equal(result.events.length, 4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a signal-shaped row and log text cannot replace the exact observed marker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aloha-raw-runtime-fake-signal-"));
  try {
    const databasePath = join(directory, "evidence.sqlite");
    const logStart = emptyLog(directory);
    const first = ready("0", logStart);
    const signal = observed("1", first.eventId as Hash, first.processAnchorHash as Hash);
    appendFileSync(logStart.path, `${marker(first)}fake SIGTERM observed\n`);
    const firstRange = new Uint8Array(readFileSync(logStart.path));
    const drain = drained("2", signal.eventId as Hash, first.processAnchorHash as Hash, Object.freeze({
      systemId: processAnchor.systemId,
      bootIdHash: processAnchor.bootIdHash,
      device: logStart.device,
      inode: logStart.inode,
      startInclusive: logStart.startInclusive,
      endExclusive: String(firstRange.byteLength),
      contentSha256: sha256Hex(firstRange),
    }));
    const secondStart = Object.freeze({ ...logStart, startInclusive: String(firstRange.byteLength) });
    const second = ready("3", secondStart, "42");
    appendFileSync(logStart.path, marker(second));
    append(databasePath, [first, signal, drain, second]);
    const result = observeRuntimeAcceptanceProcessDatabaseV1(databasePath);
    assert.equal(result.status, "invalid");
    assert.ok(result.reasons.some(reason => reason.includes("does not bind ready and observed events")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("independent reader rejects a truncated append range", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aloha-raw-runtime-truncated-"));
  try {
    const databasePath = join(directory, "evidence.sqlite");
    const logStart = emptyLog(directory);
    const processReady = ready("0", logStart);
    appendFileSync(logStart.path, marker(processReady));
    append(databasePath, [processReady]);
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => { exec(sql: string): void; close(): void } };
    const raw = new DatabaseSync(databasePath);
    raw.exec("DROP TRIGGER durable_append_log_no_update");
    raw.exec(`UPDATE durable_append_log SET offset_end='999' WHERE namespace='${namespace}' AND sequence='0'`);
    raw.close();
    const observed = observeRuntimeAcceptanceProcessDatabaseV1(databasePath);
    assert.equal(observed.status, "invalid");
    assert.ok(observed.reasons.some(reason => reason.includes("object set mismatch") || reason.includes("truncated")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
