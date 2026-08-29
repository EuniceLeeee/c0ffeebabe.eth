import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import type { PreReleaseControllerDirectorySnapshotV1 } from "../../pre-release-restart-controller/src/spec.ts";
import { assertPreReleaseBDirectorySnapshotEntrySetRootV1 } from "../src/internal/pre-release-b-terminal-snapshot-owner.ts";
import { registerPreReleaseBTerminalPhysicalObservationV1 } from "../src/internal/pre-release-b-terminal-physical-observation-state.ts";
import {
  readPreReleaseBTerminalPhysicalObservationV1,
  type PreReleaseBTerminalPhysicalObservationCapabilityV1,
  type PreReleaseBTerminalPhysicalObservationV1,
} from "../src/pre-release-b-terminal-physical-observation.ts";

const h = (value: string): Hash => hashDomain("test/pre-release-b-terminal-snapshot/v1", value);

function snapshot(): PreReleaseControllerDirectorySnapshotV1 {
  const entries = Object.freeze([Object.freeze({
    name: `${"1".repeat(64)}.json`,
    contentSha256: h("index-content"),
    byteLength: "42",
    device: "1",
    inode: "2",
    uid: "0" as const,
    gid: "0" as const,
    mode: "256" as const,
    fileFsynced: true as const,
  })]);
  const payload = {
    snapshotKind: "terminal-locator-index" as const,
    observerStoreIdentityHash: null,
    entries: entries.map(entry => ({
      name: entry.name,
      contentSha256: entry.contentSha256,
      byteLength: entry.byteLength,
    })),
  };
  return Object.freeze({
    snapshotKind: payload.snapshotKind,
    sourceDirectory: "/source/terminal-locators",
    snapshotDirectory: "/snapshot/terminal-locators",
    observerStoreIdentityHash: null,
    entries,
    entrySetRoot: hashDomain("aloha/pre-release-directory-snapshot-entry-set/v1", payload),
    directoryDevice: "1",
    directoryInode: "3",
    uid: "0",
    gid: "0",
    mode: "448",
    directoryFsynced: true,
  });
}

test("B snapshot owner independently recomputes the exact physical entry denominator root", () => {
  const valid = snapshot();
  assert.doesNotThrow(() => assertPreReleaseBDirectorySnapshotEntrySetRootV1(valid));
  assert.throws(
    () => assertPreReleaseBDirectorySnapshotEntrySetRootV1({ ...valid, entrySetRoot: h("spliced-root") }),
    /entry-set root mismatch/,
  );
  assert.throws(
    () => assertPreReleaseBDirectorySnapshotEntrySetRootV1({
      ...valid,
      entries: Object.freeze([Object.freeze({ ...valid.entries[0]!, contentSha256: h("spliced-entry") })]),
    }),
    /entry-set root mismatch/,
  );
});

test("B snapshot import selects the exact SQLite window and reopens discovery before publication", () => {
  const owner = readFileSync(new URL("../src/internal/pre-release-b-terminal-snapshot-owner.ts", import.meta.url), "utf8");
  assert.match(owner, /raw\.sixStepWindowSelection\.finalDurableWindowId/);
  assert.match(owner, /terminalEntries\.get\(indexFileName\)/);
  assert.doesNotMatch(owner, /Array\.from\(terminalEntries\.(?:keys|values)\(\)\)|\[\.\.\.terminalEntries\.(?:keys|values)\(\)\]/);
  assert.match(owner, /releaseIntentCanonicalBytes: qualification\.stagingArtifactBytes\["release-intent\.json"\]/);
  assert.match(owner, /familyCatalogSourceBytes: qualification\.stagingArtifactBytes\["family-catalog\.ts"\]/);
  assert.match(owner, /runtimeCompositionSourceBytes: qualification\.stagingArtifactBytes\["runtime-composition\.ts"\]/);
  assert.match(owner, /strategyCatalogSourceBytes: qualification\.stagingArtifactBytes\["strategy-catalog\.ts"\]/);

  const importer = readFileSync(new URL("../src/internal/pre-release-staging-owner.ts", import.meta.url), "utf8");
  const trust = importer.indexOf("issueFrozenPreReleaseBTerminalSnapshotTrustV1(capability)");
  const sink = importer.indexOf("issueReleaseOwnedObserverSnapshotSinkV1({", trust);
  const read = importer.indexOf("await snapshotIndex.readSnapshot(terminalSnapshotTrust)", sink);
  const publish = importer.indexOf("importedFrozenRuntimes.set(imported", read);
  assert.ok(trust >= 0 && sink > trust && read > sink && publish > read);
  assert.doesNotMatch(importer, /registerProductionTerminalPhaseSnapshotTrustCapabilityV1/);
});

function physicalObservation(root = true): PreReleaseBTerminalPhysicalObservationV1 {
  const sourceLedger = Object.freeze({
    sourceDevice: "1", sourceInode: "2", snapshotPath: "/snapshot/six-step.jsonl",
    snapshotDevice: "3", snapshotInode: "4", contentSha256: h("six-step-ledger"),
    byteLength: "10", fsynced: true as const,
  });
  const terminalPhase = Object.freeze({
    finalDurableWindowId: h("window"), terminalLocatorDirectory: "/snapshot/terminal-locators",
    observerContentStore: Object.freeze({ directory: "/snapshot/content", device: "1", inode: "2", storeIdentityHash: h("store") }),
    index: Object.freeze({ path: "/snapshot/terminal-locators/index.json", device: "1", inode: "2", contentSha256: h("index"), byteLength: "10", indexRoot: h("index-root") }),
    locator: Object.freeze({ locatorRoot: h("locator"), artifactRefId: h("locator-ref"), contentSha256: h("locator-content") }),
    manifest: Object.freeze({ manifestRoot: h("manifest"), artifactRefId: h("manifest-ref"), contentSha256: h("manifest-content") }),
    fullFamilyTerminalBinding: Object.freeze({ artifactRefId: h("binding-ref"), contentSha256: h("binding-content") }),
    fullGraphCoarseSweep: Object.freeze({ artifactRefId: h("sweep-ref"), contentSha256: h("sweep-content"), sweepRoot: h("sweep"), expectedTransitionCount: "1", expectedTransitionRoot: h("expected"), observedTransitionCount: "1", observedTransitionRoot: h("observed"), missingTransitionCount: "0", missingTransitionRoot: h("missing"), familyTransitionCounts: Object.freeze([]) }),
    sixStepPhysicalStatus: "observed" as const, sixStepPhysicalReason: null,
  });
  const body = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.pre-release-b-terminal-physical-observation-v1" as const,
    release: Object.freeze({ candidateReleaseCommit: "a".repeat(40), runtimeBindingId: h("binding"), releaseProvenanceHash: h("release"), authorizationId: h("authorization") }),
    process: Object.freeze({ processImportReceiptId: h("process-receipt"), processAnchorHash: h("process-anchor"), pid: "1", processStartTicks: "2", bootIdHash: h("boot"), executableHash: h("executable") }),
    logWindow: Object.freeze({ path: "/var/log/aloha/pre-release.log", device: "1", inode: "2", startInclusive: "0", endExclusive: "10", contentSha256: h("log") }),
    processEvidence: Object.freeze({
      publication: Object.freeze({ sourcePath: "/runtime/process.sqlite", snapshotPath: "/snapshot/process.sqlite", contentSha256: h("database"), byteLength: "10", device: "1", inode: "2", uid: "0" as const, gid: "0" as const, mode: "384" as const, fileFsynced: true as const, directoryFsynced: true as const }),
      databaseSha256Before: h("database"), databaseSha256After: h("database"), storageSetRootBefore: h("storage"), storageSetRootAfter: h("storage"), rawRowRoot: h("rows"), eventRoot: h("events"),
    }),
    terminal: Object.freeze({
      snapshotRoot: h("snapshot"), snapshotTrustRoot: h("trust"), finalDurableWindowId: h("window"),
      sixStepWindowSelection: Object.freeze({ finalDurableWindowId: h("window"), selectionPolicyDigest: h("policy"), eligibleSuccessCount: "0", eligibleSuccessRoot: h("successes"), selectedIndex: null, selectedProducerTerminalId: null, selectedPerformanceEventId: null, selectedProducerTerminalEventId: null, selectionRoot: h("selection") }),
      sixStepSourceLedger: sourceLedger, sixStepBoundaryEntrySetRoot: h("boundary-set"),
      sixStepBoundaryFiles: Object.freeze([Object.freeze({ name: "boundary.json", contentSha256: h("boundary"), byteLength: "10", device: "1", inode: "2", fsynced: true as const })]),
      factIndex: Object.freeze({ terminalPhase, processEvidenceQuery: Object.freeze({}) }) as never,
    }),
  });
  return Object.freeze({
    ...body,
    observationRoot: root
      ? hashDomain("aloha/pre-release-b-terminal-physical-observation/v1", body as never)
      : h("wrong-observation-root"),
  });
}

test("terminal physical observation is opaque, exact-rooted, and clone resistant", () => {
  const issued = Object.freeze(Object.create(null)) as PreReleaseBTerminalPhysicalObservationCapabilityV1;
  const observation = physicalObservation();
  registerPreReleaseBTerminalPhysicalObservationV1(issued, observation);
  assert.equal(readPreReleaseBTerminalPhysicalObservationV1(issued).observationRoot, observation.observationRoot);
  assert.throws(
    () => readPreReleaseBTerminalPhysicalObservationV1(Object.freeze(Object.create(null))),
    /not owner-issued/,
  );
  assert.throws(
    () => readPreReleaseBTerminalPhysicalObservationV1(Object.freeze({ ...observation })),
    /capability is invalid/,
  );
  const invalid = Object.freeze(Object.create(null)) as PreReleaseBTerminalPhysicalObservationCapabilityV1;
  registerPreReleaseBTerminalPhysicalObservationV1(invalid, physicalObservation(false));
  assert.throws(() => readPreReleaseBTerminalPhysicalObservationV1(invalid), /observation root mismatch/);
  const nonFsyncedBody = physicalObservation();
  const nonFsyncedTerminal = Object.freeze({
    ...nonFsyncedBody.terminal,
    sixStepSourceLedger: Object.freeze({ ...nonFsyncedBody.terminal.sixStepSourceLedger, fsynced: false }),
  });
  const { observationRoot: _root, ...base } = nonFsyncedBody;
  const nonFsyncedPayload = Object.freeze({ ...base, terminal: nonFsyncedTerminal });
  const nonFsynced = Object.freeze({
    ...nonFsyncedPayload,
    observationRoot: hashDomain("aloha/pre-release-b-terminal-physical-observation/v1", nonFsyncedPayload as never),
  });
  const nonFsyncedCapability = Object.freeze(Object.create(null)) as PreReleaseBTerminalPhysicalObservationCapabilityV1;
  registerPreReleaseBTerminalPhysicalObservationV1(nonFsyncedCapability, nonFsynced as never);
  assert.throws(() => readPreReleaseBTerminalPhysicalObservationV1(nonFsyncedCapability), /source ledger is not fsynced/);
});
