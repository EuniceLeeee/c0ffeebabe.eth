import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PRODUCTION_PERFORMANCE_PROFILE,
  createCandidateTerminalReceipt,
  createPerformanceAdmissionOrphanReplacementLineage,
  createPerformanceWindowCommitment,
  createDeploymentPerformanceWindowBasisV1,
  hashPerformanceSixStepCompletionLineage,
  createPerformanceFactEnvelope,
  decodeDeploymentPerformanceWindowBasisV1,
  decodePerformanceFactEnvelope,
  decodePerformanceAdmissionOrphanReplacementLineage,
  decodeProductionPerformanceProfile,
  encodeDeploymentPerformanceWindowBasisV1,
  encodePerformanceFactEnvelope,
  encodePerformanceAdmissionOrphanReplacementLineage,
  encodeProductionPerformanceProfile,
  performanceLaneCandidateRefV1,
  decodePerformanceWindowCommitment,
} from "../src/index.ts";

const h = (digit: string) => `0x${digit.repeat(64)}` as `0x${string}`;

test("production profile freezes 100-head nearest-rank budgets and round-trips exact bytes", () => {
  const decoded = decodeProductionPerformanceProfile(encodeProductionPerformanceProfile(DEFAULT_PRODUCTION_PERFORMANCE_PROFILE));
  assert.equal(decoded.profileHash, DEFAULT_PRODUCTION_PERFORMANCE_PROFILE.profileHash);
  assert.equal(decoded.targetCount, "100");
  assert.equal(decoded.percentileAlgorithm, "nearest-rank-v1");
  assert.equal(decoded.budgets.headCompletionP99Us, "11000000");
});

test("profile decoder rejects caller target-count changes", () => {
  const mutated = { ...DEFAULT_PRODUCTION_PERFORMANCE_PROFILE, targetCount: "99" as "100" };
  assert.throws(() => decodeProductionPerformanceProfile(mutated));
});

test("window commitment binds release/runtime and never claims one serving generation", () => {
  const commitment = createPerformanceWindowCommitment({
    windowStartAnchor: { chainId: "1", number: "100", hash: h("1"), parentHash: h("2"), stateRoot: h("3") },
    eligibilityRuleHash: h("4"),
    performanceProfileHash: DEFAULT_PRODUCTION_PERFORMANCE_PROFILE.profileHash,
    targetCount: "100",
    processLogAnchor: { commitSha: "a".repeat(40), executableHash: h("5"), pid: "42", processStartTicks: "7", bootIdHash: h("6"), logSystemId: "system", logBootIdHash: h("6"), logDevice: "8", logInode: "9" },
    releaseBindingId: h("7"), releaseProvenanceHash: h("8"), runtimeAnchorHash: h("9"),
    providerRoot: h("a"), hardwareProfileRoot: h("b"), commitContextBindingId: h("c"), commitAppendRecordId: h("d"), committedMonotonicNs: "0",
  });
  assert.equal(commitment.releaseBindingId, h("7"));
  assert.equal("generationId" in commitment, false);
  assert.equal("graphRoot" in commitment, false);
  assert.equal("readyRecordHash" in commitment, false);
  assert.throws(() => decodePerformanceWindowCommitment({ ...commitment, generationId: "generation-1" }));
});

test("deployment performance basis binds release and frozen inputs without a live process/head/window", () => {
  const basis = createDeploymentPerformanceWindowBasisV1({
    bindingId: h("1"),
    releaseProvenanceHash: h("2"),
    candidateReleaseCommit: "a".repeat(40),
    performanceProfileHash: DEFAULT_PRODUCTION_PERFORMANCE_PROFILE.profileHash,
    eligibilityRuleHash: h("3"),
    targetCount: "100",
    providerRoot: h("4"),
    hardwareProfileRoot: h("5"),
    commitContextBindingId: h("6"),
    commitAppendRecordId: h("7"),
  });
  assert.deepEqual(
    decodeDeploymentPerformanceWindowBasisV1(encodeDeploymentPerformanceWindowBasisV1(basis)),
    basis,
  );
  assert.equal("windowId" in basis, false);
  assert.equal("processLogAnchor" in basis, false);
  assert.equal("windowStartAnchor" in basis, false);
  assert.equal("commitProductionReceiptId" in basis, false);
  assert.equal("commitArtifactRefId" in basis, false);
  assert.throws(() => decodeDeploymentPerformanceWindowBasisV1({ ...basis, providerRoot: h("8") }), /basis hash mismatch/);
  assert.throws(() => decodeDeploymentPerformanceWindowBasisV1({ ...basis, candidateReleaseCommit: "b".repeat(40), basisId: basis.basisId }), /basis hash mismatch/);
  assert.throws(() => decodeDeploymentPerformanceWindowBasisV1({ ...basis, windowId: h("9") }));
  assert.throws(() => decodeDeploymentPerformanceWindowBasisV1({
    ...basis,
    commitProductionReceiptId: basis.commitContextBindingId,
    commitArtifactRefId: basis.commitAppendRecordId,
  }));
});

test("fact envelope binds shard type, sequence, and content identity with an exact codec", () => {
  const envelope = createPerformanceFactEnvelope({
    factType: "event",
    sequence: "7",
    artifactRefId: h("1"),
    claimId: h("2"),
    observationId: h("3"),
    contentSha256: h("4"),
    byteLength: "12",
  });
  assert.deepEqual(decodePerformanceFactEnvelope(encodePerformanceFactEnvelope(envelope)), envelope);
  assert.throws(() => decodePerformanceFactEnvelope({ ...envelope, sequence: null }));
  assert.throws(() => decodePerformanceFactEnvelope({ ...envelope, producerVerdict: "pass" }));
});

test("candidate terminal schema binds head and correlation and forbids false six-step claims", () => {
  const sixStepLineage = {
    windowId: h("1"),
    headRecordId: h("2"),
    candidateId: h("3"),
    correlationRoot: h("4"),
    mode: "unsigned-dry-run" as const,
    evidenceRoot: h("7"),
  };
  const completed = createCandidateTerminalReceipt({
    windowId: sixStepLineage.windowId,
    headRecordId: sixStepLineage.headRecordId,
    candidateId: sixStepLineage.candidateId,
    correlationRoot: sixStepLineage.correlationRoot,
    ordinal: "1",
    outcome: "verified",
    sixStepCompleted: true,
    sixStepMode: sixStepLineage.mode,
    sixStepEvidenceRoot: sixStepLineage.evidenceRoot,
    sixStepCompletionRoot: hashPerformanceSixStepCompletionLineage(sixStepLineage),
    timingUs: "5",
    evidenceRoot: h("6"),
  });
  assert.equal(completed.sixStepCompleted, true);
  assert.throws(() => createCandidateTerminalReceipt({
    ...completed,
    correlationRoot: h("8"),
  } as never), /lineage root mismatch/);

  const notRun = createCandidateTerminalReceipt({
    windowId: h("1"),
    ordinal: "1",
    headRecordId: h("2"),
    candidateId: h("3"),
    outcome: "retryable",
    correlationRoot: h("4"),
    sixStepCompleted: false,
    sixStepMode: null,
    sixStepEvidenceRoot: null,
    sixStepCompletionRoot: null,
    timingUs: "5",
    evidenceRoot: h("6"),
  });
  assert.equal(notRun.sixStepCompleted, false);
  assert.throws(() => createCandidateTerminalReceipt({
    ...notRun,
    outcome: "policy-rejected",
    sixStepCompleted: true,
    sixStepMode: "unsigned-dry-run",
    sixStepEvidenceRoot: h("7"),
    sixStepCompletionRoot: h("7"),
  } as never), /only verified candidates/);
  assert.throws(() => createCandidateTerminalReceipt({
    ...notRun,
    sixStepMode: "unsigned-dry-run",
    sixStepEvidenceRoot: h("7"),
    sixStepCompletionRoot: h("7"),
  } as never));
});

test("lane-qualified candidate refs preserve equal semantic candidates across independent lanes", () => {
  const semanticCandidateId = h("3");
  const blockscan = performanceLaneCandidateRefV1("blockscan", semanticCandidateId);
  const backrun = performanceLaneCandidateRefV1("backrun", semanticCandidateId);
  assert.notEqual(blockscan, backrun);
  assert.equal(blockscan, performanceLaneCandidateRefV1("blockscan", semanticCandidateId));
  assert.throws(() => performanceLaneCandidateRefV1("other" as never, semanticCandidateId), /lane is invalid/);
  assert.throws(() => performanceLaneCandidateRefV1("blockscan", h("0")), /zero hash/);
});

test("admission replacement binds one ordinal, exact revision advance, and the durable orphan terminal", () => {
  const orphanCanonicalHead = Object.freeze({
    chainId: "1",
    number: "101",
    hash: h("1"),
    parentHash: h("2"),
    stateRoot: h("3"),
  });
  const replacementCanonicalHead = Object.freeze({
    ...orphanCanonicalHead,
    hash: h("4"),
    stateRoot: h("5"),
  });
  const draft = Object.freeze({
    windowId: h("6"),
    ordinal: "1",
    orphanAdmissionId: h("7"),
    orphanEligibleEventId: h("8"),
    orphanProducerTerminalId: h("9"),
    orphanProducerTerminalEventId: h("a"),
    orphanCanonicalHead,
    orphanRevision: "0",
    orphanAcceptedMonotonicNs: "100",
    orphanTerminalMonotonicNs: "150",
    replacementAdmissionId: h("b"),
    replacementCanonicalHead,
    replacementRevision: "1",
    replacementAcceptedMonotonicNs: "151",
  });
  const lineage = createPerformanceAdmissionOrphanReplacementLineage(draft);
  assert.deepEqual(
    decodePerformanceAdmissionOrphanReplacementLineage(encodePerformanceAdmissionOrphanReplacementLineage(lineage)),
    lineage,
  );
  assert.throws(
    () => createPerformanceAdmissionOrphanReplacementLineage({ ...draft, ordinal: "0" }),
    /outside 1..100/,
  );
  assert.throws(
    () => createPerformanceAdmissionOrphanReplacementLineage({ ...draft, replacementRevision: "2" }),
    /advance exactly once/,
  );
  assert.throws(
    () => createPerformanceAdmissionOrphanReplacementLineage({ ...draft, replacementCanonicalHead: orphanCanonicalHead }),
    /change the canonical hash/,
  );
  assert.throws(
    () => createPerformanceAdmissionOrphanReplacementLineage({ ...draft, replacementAcceptedMonotonicNs: "150" }),
    /follow the durable orphan terminal/,
  );
  assert.throws(
    () => decodePerformanceAdmissionOrphanReplacementLineage({ ...lineage, orphanProducerTerminalEventId: h("c") }),
    /identity mismatch/,
  );
});
