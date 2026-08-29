import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import {
  createProductionReleaseAcceptanceAdvisoryReportV1,
  observeProductionReleaseAcceptanceAdvisoryV1,
} from "../src/production-workflow.ts";

const h = (value: string): Hash => hashDomain("test/pre-release-advisory/v1", value);

function projection() {
  const processAnchor = Object.freeze({
    pid: "42",
    processStartTicks: "77",
    bootIdHash: h("boot"),
    executableHash: h("executable"),
  });
  return Object.freeze({
    authorizationClaim: Object.freeze({ ledgerPath: "/var/lib/aloha/pre-release/authorization-ledger/authorization-claims.sqlite" }),
    stagingArtifacts: Object.freeze([Object.freeze({
      name: "staging-manifest.json",
      installPath: "/var/lib/aloha/pre-release/artifacts/staging-manifest.json",
      contentSha256: h("manifest"),
      byteLength: "1",
    })]),
    processImportReceipt: Object.freeze({
      receiptId: h("process-import-receipt"),
      candidateReleaseCommit: "a".repeat(40),
      runtimeBindingId: h("binding"),
      releaseProvenanceHash: h("provenance"),
      processAnchor,
      processAnchorHash: hashDomain("aloha/process-anchor/v1", processAnchor),
      processEvidenceDatabasePath: "/var/lib/aloha/pre-release/runtime/process-evidence.sqlite",
      checkpointDatabasePath: "/var/lib/aloha/pre-release/runtime/checkpoint.sqlite",
      observerStoreDirectory: "/var/lib/aloha-acceptance/pre-release/observer-store/content",
      databaseDevice: "5",
      databaseInode: "6",
      databaseContentSha256: h("database"),
      logPath: "/var/log/aloha/pre-release.log",
      logDevice: "1",
      logInode: "2",
      logStartInclusive: "3",
      logEndExclusive: "4",
      logContentSha256: h("log"),
    }),
  }) as never;
}

function evaluation(
  predicateId: string,
  status: "evaluated" | "missing" | "invalid",
  verdict: "pass" | "fail" | "invalid" | null,
  unavailableCode: "owner-material-missing" | "owner-material-invalid" | null = null,
) {
  return Object.freeze({ predicateId, status, unavailableCode, verdict, certificateId: verdict === "pass" ? h(predicateId) : null });
}

function factIndex() {
  return Object.freeze({
    terminalPhase: Object.freeze({
      finalDurableWindowId: h("window"),
      terminalLocatorDirectory: "/var/lib/aloha-acceptance/pre-release/observer-store/terminal-locators",
      observerContentStore: Object.freeze({ directory: "/var/lib/aloha-acceptance/pre-release/observer-store/content", device: "7", inode: "8", storeIdentityHash: h("observer-store") }),
      index: Object.freeze({ path: `/var/lib/aloha-acceptance/pre-release/observer-store/terminal-locators/${h("window").slice(2)}.json`, device: "8", inode: "9", contentSha256: h("index-content"), byteLength: "10", indexRoot: h("index") }),
      locator: Object.freeze({ locatorRoot: h("locator"), artifactRefId: h("locator-ref"), contentSha256: h("locator-content") }),
      manifest: Object.freeze({ manifestRoot: h("terminal-manifest"), artifactRefId: h("manifest-ref"), contentSha256: h("manifest-content") }),
      fullFamilyTerminalBinding: Object.freeze({ artifactRefId: h("full-family-terminal-ref"), contentSha256: h("full-family-terminal-content") }),
      fullGraphCoarseSweep: Object.freeze({
        artifactRefId: h("sweep-ref"),
        contentSha256: h("sweep-content"),
        sweepRoot: h("sweep"),
        expectedTransitionCount: "30000",
        expectedTransitionRoot: h("expected-transitions"),
        observedTransitionCount: "29990",
        observedTransitionRoot: h("observed-transitions"),
        missingTransitionCount: "10",
        missingTransitionRoot: h("missing-transitions"),
        familyTransitionCounts: Object.freeze([]),
      }),
      sixStepPhysicalStatus: "observed" as const,
      sixStepPhysicalReason: null,
    }),
    processEvidenceQuery: Object.freeze({
      databasePath: "/var/lib/aloha/pre-release/runtime/process-evidence.sqlite",
      routeDenominator: Object.freeze({
        namespace: "searcher-production-evidence/route-denominators/v1" as const,
        eventType: "route-denominator" as const,
        accountingEntriesPath: "payload.accounting.entries" as const,
      }),
      candidateSet: Object.freeze({
        namespace: "searcher-production-evidence/candidate-sets/v1" as const,
        eventType: "candidate-set" as const,
        laneDenominatorsPath: "payload.laneDenominators" as const,
        terminalObservationsPath: "payload.candidateTerminalObservations" as const,
      }),
      joins: Object.freeze({
        head: Object.freeze([
          Object.freeze({ routePath: "payload.admissionId", candidateSetPath: "payload.admissionId" }),
          Object.freeze({ routePath: "payload.headFactsRoot", candidateSetPath: "payload.headFactsRoot" }),
          Object.freeze({ routePath: "payload.headHash", candidateSetPath: "payload.headHash" }),
        ]),
        lane: Object.freeze([
          Object.freeze({ routePath: "payload.lane", candidateLanePath: "lane" }),
          Object.freeze({ routePath: "payload.correlationId", candidateLanePath: "correlationId" }),
          Object.freeze({ routePath: "payload.coverageRoot", candidateLanePath: "coverageRoot" }),
          Object.freeze({ routePath: "payload.accounting.root", candidateLanePath: "accountingRoot" }),
        ]),
        candidate: Object.freeze({
          routeEntriesPath: "payload.accounting.entries" as const,
          terminalObservationsPath: "payload.candidateTerminalObservations" as const,
          routeLanePath: "payload.lane" as const,
          terminalLanePath: "lane" as const,
          identity: Object.freeze({ routePath: "candidateId" as const, terminalPath: "candidateId" as const }),
          matching: "filter-terminal-by-route-lane-then-exact-order-and-cardinality" as const,
          equalFields: Object.freeze([
            "disposition", "terminalKind", "routeHash", "reasonCode", "evidenceHash", "policyTerminal",
          ] as const),
        }),
      }),
      exactAdmission: Object.freeze({
        sourcePath: "payload.accounting.entries[].disposition" as const,
        disposition: "selected" as const,
      }),
    }),
  });
}

function checkpointPublication() {
  return Object.freeze({
    sourcePath: "/var/lib/aloha/pre-release/runtime/checkpoint.sqlite",
    snapshotPath: "/var/lib/aloha/pre-release/controller/b-checkpoint.sqlite",
    contentSha256: h("checkpoint-snapshot"),
    byteLength: "42",
    device: "7",
    inode: "8",
    uid: "0" as const,
    gid: "0" as const,
    mode: "384" as const,
    fileFsynced: true as const,
    directoryFsynced: true as const,
  });
}

test("advisory judgment classifies pass, fail, invalid, and incomplete without authority", () => {
  const cases = [
    ["pass", [evaluation("p", "evaluated", "pass")]],
    ["fail", [evaluation("p", "evaluated", "fail")]],
    ["invalid", [evaluation("p", "invalid", "invalid", "owner-material-invalid")]],
    ["incomplete", [evaluation("p", "missing", null, "owner-material-missing")]],
  ] as const;
  for (const [expected, evaluations] of cases) {
    const report = createProductionReleaseAcceptanceAdvisoryReportV1(projection(), evaluations, "123", h("terminal-snapshot-trust"), factIndex(), checkpointPublication());
    assert.equal(report.status, expected);
    assert.equal(report.authority.advisoryOnly, true);
    assert.equal(report.authority.candidateGeneratedAuthority, null);
    assert.equal(report.authority.runtimeReleaseBinding, null);
    assert.equal(report.authority.releaseAuthority, null);
    assert.equal(report.authority.submissionAuthority, null);
    assert.equal(report.authority.sign, false);
    assert.equal(report.authority.broadcast, false);
    assert.equal(report.authority.promote, false);
    assert.deepEqual(report.nominationQualificationReuse, {
      status: "unavailable",
      code: "verified-release-authority-composition-unavailable",
      advisoryOnly: true,
    });
    assert.equal(report.physicalProcess.pid, "42");
    assert.equal(report.physicalProcess.processStartTicks, "77");
    assert.equal(report.physicalProcess.dryRun, true);
    assert.equal(report.factBinding.processImportReceiptId, h("process-import-receipt"));
    assert.equal(report.factBinding.databaseContentSha256, h("database"));
    assert.equal(report.factBinding.terminalSnapshotTrustRoot, h("terminal-snapshot-trust"));
    assert.equal(report.factLocators.processEvidenceDatabasePath, "/var/lib/aloha/pre-release/runtime/process-evidence.sqlite");
    assert.deepEqual(report.factLocators.processEvidenceDatabase, {
      path: "/var/lib/aloha/pre-release/runtime/process-evidence.sqlite",
      device: "5",
      inode: "6",
      contentSha256: h("database"),
    });
    assert.equal(report.artifactLocators[0]?.contentSha256, h("manifest"));
    assert.equal(report.factIndex.terminalPhase.fullGraphCoarseSweep.expectedTransitionCount, "30000");
    assert.equal(report.factIndex.terminalPhase.fullGraphCoarseSweep.missingTransitionCount, "10");
    assert.equal(report.factIndex.terminalPhase.observerContentStore.storeIdentityHash, h("observer-store"));
    assert.equal(report.factIndex.processEvidenceQuery.routeDenominator.namespace, "searcher-production-evidence/route-denominators/v1");
    assert.equal(report.factIndex.processEvidenceQuery.candidateSet.namespace, "searcher-production-evidence/candidate-sets/v1");
    assert.equal(report.factIndex.processEvidenceQuery.candidateSet.terminalObservationsPath, "payload.candidateTerminalObservations");
    assert.equal(report.factIndex.processEvidenceQuery.joins.lane[3]?.routePath, "payload.accounting.root");
    assert.equal(report.factIndex.processEvidenceQuery.joins.candidate.identity.routePath, "candidateId");
    assert.equal(report.factIndex.processEvidenceQuery.joins.candidate.routeLanePath, "payload.lane");
    assert.equal(report.factIndex.processEvidenceQuery.joins.candidate.matching, "filter-terminal-by-route-lane-then-exact-order-and-cardinality");
    assert.equal(report.factIndex.processEvidenceQuery.exactAdmission.disposition, "selected");
    assert.match(report.judgmentRoot, /^0x[0-9a-f]{64}$/);
    assert.equal(report.reasons.length, expected === "pass" ? 0 : 1);
  }
  const first = createProductionReleaseAcceptanceAdvisoryReportV1(projection(), cases[0][1], "123", h("terminal-snapshot-trust"), factIndex(), checkpointPublication());
  const changed = createProductionReleaseAcceptanceAdvisoryReportV1(projection(), cases[0][1], "123", h("changed-terminal-snapshot-trust"), factIndex(), checkpointPublication());
  assert.notEqual(first.judgmentRoot, changed.judgmentRoot);

  const missingTrustRoot = createProductionReleaseAcceptanceAdvisoryReportV1(projection(), cases[0][1], "123", null, factIndex(), checkpointPublication());
  assert.equal(missingTrustRoot.status, "incomplete");
  assert.equal(missingTrustRoot.factBinding.terminalSnapshotTrustRoot, null);
  assert.deepEqual(missingTrustRoot.reasons, [{
    predicateId: "aloha.pre-release-terminal-snapshot-trust.v1",
    code: "terminal-snapshot-trust-root-missing",
  }]);
  assert.notEqual(first.judgmentRoot, missingTrustRoot.judgmentRoot);

  for (const evaluations of [cases[1][1], cases[2][1]]) {
    const missingTrustDenominator = createProductionReleaseAcceptanceAdvisoryReportV1(projection(), evaluations, "123", null, factIndex(), checkpointPublication());
    assert.equal(missingTrustDenominator.status, "incomplete");
    assert.equal(missingTrustDenominator.reasons.at(-1)?.code, "terminal-snapshot-trust-root-missing");
  }
});

test("advisory accepts only owner-issued material and does not execute structural clone accessors", async () => {
  let reads = 0;
  const forged = Object.freeze(Object.defineProperty({}, "runner", {
    enumerable: true,
    get() { reads += 1; throw new Error("must not execute"); },
  }));
  await assert.rejects(observeProductionReleaseAcceptanceAdvisoryV1(forged), /advisory material capability was not staging-owner-issued/);
  assert.equal(reads, 0);
});

test("pre-release advisory workflow remains separate from the external release owner", () => {
  const source = readFileSync(new URL("../src/production-workflow.ts", import.meta.url), "utf8");
  const state = readFileSync(new URL("../src/internal/pre-release-runtime-receipt-state.ts", import.meta.url), "utf8");
  const stagingOwner = readFileSync(new URL("../src/internal/pre-release-staging-owner.ts", import.meta.url), "utf8");
  assert.match(source, /observeQualifiedReleaseAcceptanceAdvisoryV1/);
  assert.match(source, /observeProductionNominationQualificationReuseCompositionV1/);
  assert.match(source, /createNominationQualificationReuseConsumerV1/);
  const preSign = source.indexOf("const preSignReport = consumer.analyzePreSign()");
  const currentOwnerMaterial = source.indexOf("readProductionNominationQualificationReusePostSignInputV1", preSign);
  const postSign = source.indexOf("const postSignReport = consumer.verifyPostSign(postSignInput)", currentOwnerMaterial);
  assert.ok(preSign >= 0 && currentOwnerMaterial > preSign && postSign > currentOwnerMaterial);
  assert.match(source, /observeProductionNominationQualificationReuseCompositionV1\(capability\)/);
  const advisoryStart = source.indexOf("export async function observeProductionReleaseAcceptanceAdvisoryV1(");
  const externalStart = source.indexOf("export async function prepareProductionReleaseAcceptanceForExternalOwnerV1(");
  assert.ok(advisoryStart >= 0 && externalStart > advisoryStart);
  assert.doesNotMatch(source.slice(advisoryStart, externalStart), /preparedAcceptance|signingRequest|issueProductionReleaseWorkflowCapability|createRuntimeReleaseBinding/);
  assert.match(source.slice(externalStart), /prepareQualifiedReleaseAcceptanceForExternalOwnerV1/);
  assert.doesNotMatch(source.slice(externalStart), /advisoryJudgment|Fact Log/);
  assert.doesNotMatch(state, /RuntimeReleaseBinding|ReleaseAuthority|SubmissionAuthority/);
  assert.doesNotMatch(stagingOwner, /terminalDiscovery\.snapshotTrustRoot\s*===\s*null[\s\S]{0,160}throw/);
});

test("external release owner emits signing bytes but contains no signing key or Fact Log gate", () => {
  const packageSource = readFileSync(new URL("../src/deployment-package.ts", import.meta.url), "utf8");
  const ownerSource = readFileSync(new URL("../src/external-release-owner.ts", import.meta.url), "utf8");
  assert.match(ownerSource, /readAssembledReleaseAcceptanceResultsV1/);
  assert.match(ownerSource, /prepareReleaseAcceptanceV1/);
  assert.match(ownerSource, /prepareProductionReleasePackageV1/);
  assert.match(ownerSource, /materializeApprovedProductionReleasePackageV1/);
  assert.doesNotMatch(`${ownerSource}\n${packageSource}`, /privateKey|createSignedReleaseAcceptanceApprovalV1|createRuntimeReleasePackageApprovalV1|pre-release-fact-log|Fact Log/);
  assert.equal(existsSync(new URL("../src/internal/assembled-release-acceptance-owner.ts", import.meta.url)), false);
  assert.equal(existsSync(new URL("../src/internal/production-release-workflow-owner.ts", import.meta.url)), false);
});
