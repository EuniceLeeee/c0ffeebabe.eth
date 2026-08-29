import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import {
  SchedulerError,
  WorkScheduler,
  createQualifiedExecutorRegistry,
  decodeQualifiedExecutorRegistryEntryV1,
  hashQualifiedExecutorRegistryEntry,
  normalizeQualifiedExecutorRegistryEntryV1,
  validateSchedulerPerformanceRangeFactValue,
  validateSchedulerWorkCompletionFactValue,
  type SchedulerWorkCompletionFactV1,
} from "../src/index.ts";
import {
  RELEASE_AUTHORITY_DOMAINS,
  createRuntimeReleaseBindingV1,
  createRuntimeReleaseDiscoverySourceQualificationV1,
  decodeQualifiedExecutorRegistryEntryV1 as decodeReleaseQualifiedExecutorRegistryEntryV1,
  decodeRuntimeReleaseBindingV1,
  hashQualifiedExecutorRegistryEntry as hashReleaseQualifiedExecutorRegistryEntry,
  hashRuntimeReleaseDiscoveryEndpointLocatorV1,
  sealRuntimeReleaseNominationQualificationSetV1,
  type QualifiedExecutorRegistryEntryV1,
  type RuntimeReleaseBindingPayloadV1,
} from "../../../specs/release-authority/src/index.ts";
import { generatedEconomicValuationOwnerQualificationSetFixtureV1 } from "../../../specs/release-authority/test/generated-valuation-owner-qualification-fixture.ts";
import { generatedEconomicSafetyActionOwnerQualificationFixtureV1 } from "../../../specs/release-authority/test/generated-action-owner-qualification-fixture.ts";
import {
  createTestQualifiedExecutorAuthorityIssuer,
  ExecutorAuthorityError,
  testReleaseApprovalPort,
} from "./fixtures/qualified-release.ts";
import {
  acknowledgeQualifiedSchedulerPerformanceRange,
  issueQualifiedSharedSchedulerRuntimePort,
  issueQualifiedSharedSchedulerPerformanceReaderPort,
  openQualifiedSchedulerPerformanceCursor,
  readQualifiedSchedulerPerformanceRange,
  readQualifiedSchedulerWorkCompletionCapability,
  readQualifiedSchedulerWorkCompletionHandle,
  readQualifiedSharedSchedulerRuntimePort,
  sealQualifiedSchedulerPerformanceRange,
} from "../src/internal/shared-runtime-owner.ts";

const caller = { callerId: "test-caller", authorityToken: "test-authority" } as const;

const registryEntry = {
  executorKind: "revm",
  engineBuildFingerprint: "0x1111111111111111111111111111111111111111111111111111111111111111",
  executableFingerprint: "0x2222222222222222222222222222222222222222222222222222222222222222",
  closureFingerprint: "0x3333333333333333333333333333333333333333333333333333333333333333",
  protocolFingerprint: "0x4444444444444444444444444444444444444444444444444444444444444444",
  schemaFingerprint: "0x5555555555555555555555555555555555555555555555555555555555555555",
  releaseRoleManifestRoot: "0x6666666666666666666666666666666666666666666666666666666666666666",
  candidateCommit: "0123456789abcdef0123456789abcdef01234567",
} as const;

function workerBinding(workerEpoch: string) {
  return {
    workerEpoch,
    executorKind: registryEntry.executorKind,
    engineBuildFingerprint: registryEntry.engineBuildFingerprint,
    executableFingerprint: registryEntry.executableFingerprint,
    closureFingerprint: registryEntry.closureFingerprint,
    protocolFingerprint: registryEntry.protocolFingerprint,
    schemaFingerprint: registryEntry.schemaFingerprint,
    releaseRoleManifestRoot: registryEntry.releaseRoleManifestRoot,
    candidateCommit: registryEntry.candidateCommit,
  } as const;
}

function descriptor(id: string, owner: string, overrides: Record<string, unknown> = {}) {
  return {
    workId: id,
    phase: "opaque-phase",
    workClassRef: "opaque-work-class",
    ownerRef: owner,
    lane: "fast",
    resource: "rpc",
    ...overrides,
  } as const;
}

function assertFactualCompletionTiming(
  fact: SchedulerWorkCompletionFactV1,
  lowerBoundUs: bigint,
  upperBoundUs: bigint,
): void {
  const queuedAtUs = BigInt(fact.queuedAtMonotonicUs);
  const finishedAtUs = BigInt(fact.finishedAtMonotonicUs);
  assert.ok(queuedAtUs >= lowerBoundUs);
  assert.ok(finishedAtUs <= upperBoundUs);
  assert.ok(finishedAtUs >= queuedAtUs);
  if (fact.permitIssuedAtMonotonicUs === null) {
    assert.equal(fact.queueWaitUs, (finishedAtUs - queuedAtUs).toString());
    assert.equal(fact.serviceUs, null);
    return;
  }
  const issuedAtUs = BigInt(fact.permitIssuedAtMonotonicUs);
  assert.ok(issuedAtUs >= queuedAtUs);
  assert.ok(finishedAtUs >= issuedAtUs);
  assert.equal(fact.queueWaitUs, (issuedAtUs - queuedAtUs).toString());
  assert.equal(fact.serviceUs, (finishedAtUs - issuedAtUs).toString());
}

test("qualified executor leaf identity is one neutral contract across scheduler and release authority", () => {
  const originalHash = hashReleaseQualifiedExecutorRegistryEntry(registryEntry);
  assert.equal(hashQualifiedExecutorRegistryEntry(registryEntry), originalHash);
  assert.deepEqual(
    decodeQualifiedExecutorRegistryEntryV1(registryEntry),
    decodeReleaseQualifiedExecutorRegistryEntryV1(registryEntry),
  );
  assert.deepEqual(normalizeQualifiedExecutorRegistryEntryV1(registryEntry), decodeReleaseQualifiedExecutorRegistryEntryV1(registryEntry));
  assert.equal("executorLeaf" in RELEASE_AUTHORITY_DOMAINS, false);

  const replacements = {
    executorKind: "revm-v2",
    engineBuildFingerprint: "0x7777777777777777777777777777777777777777777777777777777777777777",
    executableFingerprint: "0x7777777777777777777777777777777777777777777777777777777777777777",
    closureFingerprint: "0x7777777777777777777777777777777777777777777777777777777777777777",
    protocolFingerprint: "0x7777777777777777777777777777777777777777777777777777777777777777",
    schemaFingerprint: "0x7777777777777777777777777777777777777777777777777777777777777777",
    releaseRoleManifestRoot: "0x7777777777777777777777777777777777777777777777777777777777777777",
    candidateCommit: "fedcba9876543210fedcba9876543210fedcba98",
  } as const;
  for (const field of Object.keys(replacements) as (keyof typeof replacements)[]) {
    const mutated = { ...registryEntry, [field]: replacements[field] } as QualifiedExecutorRegistryEntryV1;
    assert.equal(hashQualifiedExecutorRegistryEntry(mutated), hashReleaseQualifiedExecutorRegistryEntry(mutated));
    assert.notEqual(hashReleaseQualifiedExecutorRegistryEntry(mutated), originalHash, field);
    assert.deepEqual(
      decodeQualifiedExecutorRegistryEntryV1(mutated),
      decodeReleaseQualifiedExecutorRegistryEntryV1(mutated),
    );
  }

  const withExtraField = { ...registryEntry, unexpected: "rejected" };
  assert.throws(() => decodeQualifiedExecutorRegistryEntryV1(withExtraField), /unknown field/);
  assert.throws(() => decodeReleaseQualifiedExecutorRegistryEntryV1(withExtraField), /unknown field/);
  const malformed = { ...registryEntry, executableFingerprint: "not-a-hash" };
  assert.throws(() => decodeQualifiedExecutorRegistryEntryV1(malformed), /lowercase 32-byte 0x hash/);
  assert.throws(() => decodeReleaseQualifiedExecutorRegistryEntryV1(malformed), /lowercase 32-byte 0x hash/);
});

function runtimeReleasePayload(selectedExecutorLeafHash: Hash): RuntimeReleaseBindingPayloadV1 {
  const registry = createQualifiedExecutorRegistry(registryEntry);
  const valuationQualification = generatedEconomicValuationOwnerQualificationSetFixtureV1("scheduler");
  const actionOwnerQualification = generatedEconomicSafetyActionOwnerQualificationFixtureV1("scheduler");
  const nominationQualificationSet = sealRuntimeReleaseNominationQualificationSetV1([{
    proposalLeafDigest: hashDomain("test/nomination", "proposal"),
    criticalMutationCorpusRoot: hashDomain("test/nomination", "mutations"),
    independentOracleCaseRoot: hashDomain("test/nomination", "oracle"),
    qualificationSpecDigest: hashDomain("test/nomination", "spec"),
    verifierQualificationCertificateRoot: hashDomain("test/nomination", "certificate"),
  }]);
  return {
    schemaVersion: 1,
    kind: "aloha.runtime-release-binding",
    releaseAuthorityApprovalId: hashDomain("test/approval", "approval"),
    releaseAuthorityApprovalPayloadHash: hashDomain("test/approval", "payload"),
    releaseAcceptanceRequirementSetRoot: hashDomain("test/approval", "acceptance-requirements"),
    externalTrustAnchorRoot: hashDomain("test/approval", "trust-anchor"),
    externalIssuerKeySetRoot: hashDomain("test/approval", "issuer-key-set"),
    qualificationRegistryApprovalId: hashDomain("test/approval", "registry-approval"),
    qualificationRegistryRoot: hashDomain("test/approval", "registry"),
    qualificationEpoch: "1",
    qualificationAudienceHash: hashDomain("test/approval", "audience"),
    predicateCompositionRootDigest: hashDomain("test/approval", "predicate-composition"),
    gateCoreRuntimeClosureDigest: hashDomain("test/approval", "runtime-closure"),
    gateCoreImplementationClosureDigest: hashDomain("test/approval", "core-closure"),
    searcherRuntime: { runtimeArtifactRoot: hashDomain("test/approval", "searcher-artifact"), implementationClosureDigest: hashDomain("test/approval", "searcher-closure"), nodeExecutableSha256: hashDomain("test/approval", "searcher-node"), entrypointSha256: hashDomain("test/approval", "searcher-entrypoint"), bundleModulePath: "/etc/aloha/deployment-bundle.mjs", bundleModuleSha256: hashDomain("test/approval", "searcher-bundle") },
    discoverySourceQualification: createRuntimeReleaseDiscoverySourceQualificationV1({
      providerIdentity: "reth-mainnet",
      backendEpoch: "reth-backend-1",
      profile: "reth-json-rpc-v1",
      chainId: "1",
      endpointLocatorHash: hashRuntimeReleaseDiscoveryEndpointLocatorV1("http://127.0.0.1:8545"),
      qualificationRoot: hashDomain("test/approval", "discovery-source-qualification"),
    }),
    qualifiedExecutorRegistry: registry.entries,
    qualifiedExecutorRegistryRoot: registry.registryRoot,
    valuationOwnerRegistryRoot: valuationQualification.registry.valuationOwnerRegistryRoot,
    valuationOwnerQualificationCertificates: valuationQualification.certificates,
    qualifiedValuationOwnerSetRoot: valuationQualification.root,
    actionOwnerRegistryRoot: actionOwnerQualification.registry.actionOwnerRegistryRoot,
    actionOwnerQualificationCertificates: actionOwnerQualification.certificates,
    qualifiedActionOwnerSetRoot: actionOwnerQualification.root,
    safetyProfile: actionOwnerQualification.profile,
    safetyProfileRoot: actionOwnerQualification.profileRoot,
    qualifiedCapabilityRefsRoot: hashDomain("test/approval", "qualified-capability-refs"),
    nominationProgramSetRoot: nominationQualificationSet.programSetRoot,
    nominationQualificationSet,
    nominationQualificationSetRoot: nominationQualificationSet.root,
    selectedExecutorLeafHash,
    selectedExecutor: registryEntry,
    releaseRoleManifestRoot: registryEntry.releaseRoleManifestRoot,
    candidateReleaseCommit: registryEntry.candidateCommit,
    workerEpoch: "epoch-1",
    executorSessionHash: hashDomain("test/session", "session"),
    frameworkAuthorityRoot: hashDomain("test/framework", "framework"),
    executorAuthorityRoot: hashDomain("test/executor", "executor"),
    releaseAuthorityRoot: hashDomain("test/release", "release"),
    attestationProofIssuerKeyId: hashDomain("test/attestation-proof-issuer", "attestation-proof-issuer"),
    candidatePartitionProofIssuerKeyId: hashDomain("test/candidate-partition-proof-issuer", "candidate-partition-proof-issuer"),
  };
}

test("runtime release binding accepts the neutral registry leaf and rejects the retired runtime leaf", () => {
  const neutralLeaf = hashReleaseQualifiedExecutorRegistryEntry(registryEntry);
  const binding = createRuntimeReleaseBindingV1(
    runtimeReleasePayload(neutralLeaf),
    hashDomain("test/signer", "signer"),
    `0x${"11".repeat(64)}`,
  );
  assert.equal(binding.selectedExecutorLeafHash, neutralLeaf);
  assert.deepEqual(decodeRuntimeReleaseBindingV1(binding), binding);

  const retiredRuntimeLeaf = hashDomain("aloha/runtime-release-binding/executor-leaf/v1", registryEntry);
  assert.throws(
    () => createRuntimeReleaseBindingV1(
      runtimeReleasePayload(retiredRuntimeLeaf),
      hashDomain("test/signer", "signer"),
      `0x${"11".repeat(64)}`,
    ),
    /selected executor leaf mismatch/,
  );
});

test("qualified executor registry root binds every release field and rejects caller roots", () => {
  const registry = createQualifiedExecutorRegistry(registryEntry);
  assert.equal(registry.registryRoot !== hashQualifiedExecutorRegistryEntry(registry.entries[0]!), true);
  assert.throws(
    () => createQualifiedExecutorRegistry({ ...registryEntry, candidateCommit: "not-a-commit" }),
    /40-hex git SHA/,
  );
  assert.throws(
    () => createTestQualifiedExecutorAuthorityIssuer({ ...registry, registryRoot: "caller-root" } as never, {} as never),
    ExecutorAuthorityError,
  );
  assert.throws(
    () => createTestQualifiedExecutorAuthorityIssuer({ ...registry, entries: [{ ...registry.entries[0]!, schemaFingerprint: "0x7777777777777777777777777777777777777777777777777777777777777777" }] } as never, {} as never),
    /root does not bind/,
  );
  assert.throws(() => createTestQualifiedExecutorAuthorityIssuer(registry, {} as never), /approval port|approval|registryRoot/);
  assert.throws(
    () => createTestQualifiedExecutorAuthorityIssuer(
      registry,
      testReleaseApprovalPort(registry, registryEntry.releaseRoleManifestRoot, "ffffffffffffffffffffffffffffffffffffffff"),
    ),
    /does not bind|binding mismatch/,
  );
});

test("qualified executor authority is opaque, session-bound, and rotates fail closed", () => {
  const registry = createQualifiedExecutorRegistry(registryEntry);
  const issuer = createTestQualifiedExecutorAuthorityIssuer(registry, testReleaseApprovalPort(registry, registryEntry.releaseRoleManifestRoot, registryEntry.candidateCommit));
  const first = issuer.open({ worker: workerBinding("epoch-1") });
  const sibling = issuer.open({ worker: workerBinding("epoch-1") });
  assert.throws(() => issuer.open({ worker: { ...workerBinding("wrong-kind"), executorKind: "other" } }), /does not match/);
  assert.throws(() => issuer.open({ worker: { ...workerBinding("wrong-fingerprint"), executableFingerprint: "0x7777777777777777777777777777777777777777777777777777777777777777" } }), /does not match/);
  assert.deepEqual(Reflect.ownKeys(first), []);
  assert.equal(Object.isFrozen(first), true);
  const provenance = issuer.provenance(first);
  assert.equal(provenance.authorityRoot, issuer.authorityRoot);
  assert.equal(provenance.workerEpoch, "epoch-1");
  assert.equal(provenance.executorSession.length > 2, true);
  assert.notEqual(provenance.executorSession, issuer.provenance(sibling).executorSession);
  assert.throws(() => issuer.provenance({ ...first }), /not issued/);
  const rotated = issuer.rotate({ worker: workerBinding("epoch-2") });
  assert.equal(issuer.provenance(rotated).workerEpoch, "epoch-2");
  assert.throws(() => issuer.provenance(first), (error: unknown) => error instanceof ExecutorAuthorityError && error.code === "stale");
  assert.throws(() => issuer.provenance(sibling), (error: unknown) => error instanceof ExecutorAuthorityError && error.code === "stale");
  issuer.revoke();
  assert.throws(() => issuer.provenance(rotated), (error: unknown) => error instanceof ExecutorAuthorityError && error.code === "revoked");
  assert.throws(() => issuer.open({ worker: workerBinding("epoch-3") }), /revoked/);
});

test("shared scheduler runtime is opaque, exact-capability-bound, and rotation-fenced", () => {
  const registry = createQualifiedExecutorRegistry(registryEntry);
  const issuer = createTestQualifiedExecutorAuthorityIssuer(
    registry,
    testReleaseApprovalPort(registry, registryEntry.releaseRoleManifestRoot, registryEntry.candidateCommit),
  );
  const capability = issuer.open({ worker: workerBinding("shared-epoch") });
  const sibling = issuer.open({ worker: workerBinding("shared-epoch") });
  const scheduler = new WorkScheduler({
    resources: { rpc: { capacity: 1 } },
    lanes: { fast: { queueCap: 1, concurrency: 1, resource: "rpc" } },
  });
  const port = issueQualifiedSharedSchedulerRuntimePort({ scheduler, issuer, capability });
  assert.deepEqual(Reflect.ownKeys(port), []);
  assert.equal(readQualifiedSharedSchedulerRuntimePort(port, issuer, capability), scheduler);
  assert.throws(
    () => readQualifiedSharedSchedulerRuntimePort({ ...port }, issuer, capability),
    /not owner-issued/,
  );
  assert.throws(
    () => readQualifiedSharedSchedulerRuntimePort(port, issuer, sibling),
    /not bound/,
  );
  assert.throws(
    () => issueQualifiedSharedSchedulerRuntimePort({ scheduler, issuer, capability }),
    /already release-bound/,
  );
  issuer.rotate({ worker: workerBinding("shared-next") });
  assert.throws(
    () => readQualifiedSharedSchedulerRuntimePort(port, issuer, capability),
    /stale|revoked/,
  );
});

test("a scheduler cannot hide pre-release work and bind later", async () => {
  const registry = createQualifiedExecutorRegistry(registryEntry);
  const issuer = createTestQualifiedExecutorAuthorityIssuer(
    registry,
    testReleaseApprovalPort(registry, registryEntry.releaseRoleManifestRoot, registryEntry.candidateCommit),
  );
  const capability = issuer.open({ worker: workerBinding("late-bind-epoch") });
  const scheduler = new WorkScheduler({
    resources: { rpc: { capacity: 1 } },
    lanes: { fast: { queueCap: 1, concurrency: 1, resource: "rpc" } },
  });
  await scheduler.run({
    work: descriptor("pre-release-work", "pre-release-owner"),
    caller,
    execute: async () => undefined,
  });
  assert.throws(
    () => issueQualifiedSharedSchedulerRuntimePort({ scheduler, issuer, capability }),
    /cannot bind after any work attempt/,
  );
});

test("scheduler work completions are owner-issued, release-bound, process-monotonic facts", async () => {
  const registry = createQualifiedExecutorRegistry(registryEntry);
  const issuer = createTestQualifiedExecutorAuthorityIssuer(
    registry,
    testReleaseApprovalPort(registry, registryEntry.releaseRoleManifestRoot, registryEntry.candidateCommit),
  );
  const capability = issuer.open({ worker: workerBinding("performance-epoch") });
  let now = 100;
  const scheduler = new WorkScheduler({
    clock: () => now,
    resources: { rpc: { capacity: 1 } },
    lanes: { fast: { queueCap: 1, concurrency: 1, resource: "rpc" } },
    quotas: { rpc: { concurrency: 1 } },
  });
  const runtimePort = issueQualifiedSharedSchedulerRuntimePort({ scheduler, issuer, capability });
  const performancePort = issueQualifiedSharedSchedulerPerformanceReaderPort({ runtimePort, issuer, capability });
  const performanceCursor = openQualifiedSchedulerPerformanceCursor(performancePort, issuer, capability);
  let completionHandle: Parameters<typeof readQualifiedSchedulerWorkCompletionHandle>[1] | null = null;

  const lowerBoundUs = process.hrtime.bigint() / 1_000n;
  const result = await scheduler.run({
    work: descriptor("performance-success", "performance-owner"),
    caller,
    execute: async permit => {
      assert.equal(permit.queueWaitMs, 0);
      completionHandle = permit.completion;
      now = 1_000_000_100;
      return "ok";
    },
  });
  const upperBoundUs = process.hrtime.bigint() / 1_000n;
  assert.equal(result, "ok");

  const performanceRange = sealQualifiedSchedulerPerformanceRange(performancePort, performanceCursor, issuer, capability);
  const completions = readQualifiedSchedulerPerformanceRange(performancePort, performanceRange, issuer, capability).completions;
  assert.equal(completions.length, 1);
  assert.notEqual(completionHandle, null);
  assert.equal(
    readQualifiedSchedulerWorkCompletionHandle(performancePort, completionHandle!, issuer, capability),
    completions[0],
  );
  assert.throws(
    () => readQualifiedSchedulerWorkCompletionHandle(performancePort, { ...completionHandle! }, issuer, capability),
    /another scheduler|not owner-issued|belongs/,
  );
  const fact = readQualifiedSchedulerWorkCompletionCapability(performancePort, completions[0]!, issuer, capability);
  assert.deepEqual(fact.work, {
    workId: "performance-success",
    phase: "opaque-phase",
    workClassRef: "opaque-work-class",
    ownerRef: "performance-owner",
    lane: "fast",
    resource: "rpc",
    cost: "1",
    quotaKey: null,
  });
  assert.equal(fact.callerId, caller.callerId);
  assert.equal(fact.runtime.qualifiedExecutorRegistryRoot, issuer.registryRoot);
  assert.equal(fact.runtime.executorAuthorityRoot, issuer.authorityRoot);
  assert.equal(fact.runtime.workerEpoch, "performance-epoch");
  assert.match(fact.runtime.schedulerRuntimeId, /^0x[0-9a-f]{64}$/);
  assertFactualCompletionTiming(fact, lowerBoundUs, upperBoundUs);
  assert.equal(fact.permitsIssued, "1");
  assert.equal(fact.permitsReleased, "1");
  assert.equal(fact.outcome, "completed");
  assert.deepEqual(validateSchedulerWorkCompletionFactValue(structuredClone(fact)), fact);
  assert.throws(
    () => validateSchedulerWorkCompletionFactValue({ ...structuredClone(fact), permitsReleased: "0" }),
    /permit accounting mismatch|identity mismatch/,
  );
  assert.throws(
    () => validateSchedulerWorkCompletionFactValue({ ...structuredClone(fact), extra: true }),
    /unknown|exact|field/i,
  );
  const { completionId, ...body } = fact;
  assert.equal(completionId, hashDomain("aloha/scheduler-work-completion/v1", body));
  assert.throws(
    () => readQualifiedSchedulerWorkCompletionCapability(performancePort, { ...completions[0]! }, issuer, capability),
    /not owner-issued/,
  );

  const siblingScheduler = new WorkScheduler({
    resources: { rpc: { capacity: 1 } },
    lanes: { fast: { queueCap: 1, concurrency: 1, resource: "rpc" } },
    quotas: { rpc: { concurrency: 1 } },
  });
  const siblingRuntime = issueQualifiedSharedSchedulerRuntimePort({ scheduler: siblingScheduler, issuer, capability });
  const siblingPerformance = issueQualifiedSharedSchedulerPerformanceReaderPort({ runtimePort: siblingRuntime, issuer, capability });
  assert.throws(
    () => readQualifiedSchedulerWorkCompletionCapability(siblingPerformance, completions[0]!, issuer, capability),
    /another scheduler/,
  );

  issuer.rotate({ worker: workerBinding("performance-epoch-2") });
  assert.throws(
    () => readQualifiedSchedulerPerformanceRange(performancePort, performanceRange, issuer, capability),
    /stale|not issued|revoked/,
  );
});

test("scheduler records queued wait and refuses fulfilled work after abort", async () => {
  const registry = createQualifiedExecutorRegistry(registryEntry);
  const issuer = createTestQualifiedExecutorAuthorityIssuer(
    registry,
    testReleaseApprovalPort(registry, registryEntry.releaseRoleManifestRoot, registryEntry.candidateCommit),
  );
  const capability = issuer.open({ worker: workerBinding("completion-failure-epoch") });
  let now = 100;
  const scheduler = new WorkScheduler({
    clock: () => now,
    resources: { rpc: { capacity: 1 } },
    lanes: { fast: { queueCap: 2, concurrency: 1, resource: "rpc" } },
    quotas: { rpc: { concurrency: 1 } },
  });
  const runtimePort = issueQualifiedSharedSchedulerRuntimePort({ scheduler, issuer, capability });
  const performancePort = issueQualifiedSharedSchedulerPerformanceReaderPort({ runtimePort, issuer, capability });
  const performanceCursor = openQualifiedSchedulerPerformanceCursor(performancePort, issuer, capability);
  let release!: () => void;
  const lowerBoundUs = process.hrtime.bigint() / 1_000n;
  const held = scheduler.run({
    work: descriptor("completion-held", "owner-a"),
    caller,
    execute: async () => new Promise<void>((resolve) => { release = resolve; }),
  });
  const queuedAbort = new AbortController();
  const queued = scheduler.run({
    work: descriptor("completion-queued", "owner-b", { signal: queuedAbort.signal }),
    caller,
    execute: async () => undefined,
  });
  await Promise.resolve();
  now = 1_000_000_100;
  queuedAbort.abort();
  await assert.rejects(queued, (error: unknown) => error instanceof SchedulerError && error.code === "aborted");
  release();
  await held;

  const fulfilledAbort = new AbortController();
  now = 2_000_000_100;
  await assert.rejects(
    scheduler.run({
      work: descriptor("completion-fulfilled-after-abort", "owner-c", { signal: fulfilledAbort.signal }),
      caller,
      execute: async () => {
        fulfilledAbort.abort();
        now = 3_000_000_100;
        return "must-not-complete";
      },
    }),
    (error: unknown) => error instanceof SchedulerError && error.code === "aborted",
  );
  const upperBoundUs = process.hrtime.bigint() / 1_000n;

  const performanceRange = sealQualifiedSchedulerPerformanceRange(performancePort, performanceCursor, issuer, capability);
  const completions = readQualifiedSchedulerPerformanceRange(performancePort, performanceRange, issuer, capability).completions;
  const facts = completions.map(completion => readQualifiedSchedulerWorkCompletionCapability(performancePort, completion, issuer, capability));
  const queuedFact = facts.find(value => value.work.workId === "completion-queued");
  const fulfilledFact = facts.find(value => value.work.workId === "completion-fulfilled-after-abort");
  assert.notEqual(queuedFact, undefined);
  assertFactualCompletionTiming(queuedFact!, lowerBoundUs, upperBoundUs);
  assert.equal(queuedFact?.permitId, null);
  assert.equal(queuedFact?.outcome, "aborted");
  assert.notEqual(fulfilledFact, undefined);
  assertFactualCompletionTiming(fulfilledFact!, lowerBoundUs, upperBoundUs);
  assert.equal(fulfilledFact?.outcome, "aborted");
  assert.equal(scheduler.snapshot().accounting.completed, 1);
  assert.equal(scheduler.snapshot().accounting.failed, 1);
});

test("scheduler performance ranges are continuous, non-cloneable, and acknowledged once", async () => {
  const registry = createQualifiedExecutorRegistry(registryEntry);
  const issuer = createTestQualifiedExecutorAuthorityIssuer(
    registry,
    testReleaseApprovalPort(registry, registryEntry.releaseRoleManifestRoot, registryEntry.candidateCommit),
  );
  const capability = issuer.open({ worker: workerBinding("range-epoch") });
  const scheduler = new WorkScheduler({
    resources: { rpc: { capacity: 1 } },
    lanes: { fast: { queueCap: 2, concurrency: 1, resource: "rpc" } },
    quotas: { rpc: { concurrency: 1 } },
  });
  const runtimePort = issueQualifiedSharedSchedulerRuntimePort({ scheduler, issuer, capability });
  const performancePort = issueQualifiedSharedSchedulerPerformanceReaderPort({ runtimePort, issuer, capability });
  // A cursor opened after a completion still begins at the exact retained
  // base; otherwise acknowledging it could silently discard that completion.
  await scheduler.run({ work: descriptor("range-before-cursor", "owner-pre"), caller, execute: async () => undefined });
  const cursor = openQualifiedSchedulerPerformanceCursor(performancePort, issuer, capability);
  await scheduler.run({ work: descriptor("range-0", "owner-a"), caller, execute: async () => undefined });
  await scheduler.run({ work: descriptor("range-1", "owner-b"), caller, execute: async () => undefined });
  assert.throws(
    () => sealQualifiedSchedulerPerformanceRange(performancePort, { ...cursor }, issuer, capability),
    /active owner-issued cursor/,
  );
  const range = sealQualifiedSchedulerPerformanceRange(performancePort, cursor, issuer, capability);
  const observed = readQualifiedSchedulerPerformanceRange(performancePort, range, issuer, capability);
  assert.equal(observed.fact.startSequence, "0");
  assert.equal(observed.fact.endSequence, "3");
  assert.equal(observed.fact.completionCount, "3");
  assert.equal(BigInt(observed.fact.attemptedWorkEnd) - BigInt(observed.fact.attemptedWorkStart), 3n);
  assert.deepEqual(observed.fact.queueTelemetry.map(({ oldestAgeUs: _oldestAgeUs, ...entry }) => entry), [{
    lane: "fast", resource: "rpc", current: "0", max: "0",
    accepted: "3", rejected: "0", cancelled: "0",
  }]);
  assert.ok(BigInt(observed.fact.queueTelemetry[0]!.oldestAgeUs) >= 0n);
  assert.deepEqual(observed.fact.permitAccounting, [
    { ownerRef: "owner-a", lane: "fast", resource: "rpc", issued: "1", released: "1", active: "0" },
    { ownerRef: "owner-b", lane: "fast", resource: "rpc", issued: "1", released: "1", active: "0" },
    { ownerRef: "owner-pre", lane: "fast", resource: "rpc", issued: "1", released: "1", active: "0" },
  ]);
  assert.deepEqual(
    observed.fact.resourceSamples.find(sample => sample.resource === "rpc"),
    { resource: "rpc", current: "0", capacity: "1", max: "1" },
  );
  assert.deepEqual(
    observed.fact.resourceSamples.map(sample => sample.resource),
    ["final-sim", "revm-heavy", "rpc"],
  );
  assert.deepEqual(validateSchedulerPerformanceRangeFactValue(structuredClone(observed.fact)), observed.fact);
  assert.throws(
    () => validateSchedulerPerformanceRangeFactValue({ ...structuredClone(observed.fact), completionCount: "2" }),
    /sequence\/count mismatch|identity mismatch/,
  );
  assert.throws(
    () => validateSchedulerPerformanceRangeFactValue({
      ...structuredClone(observed.fact),
      permitAccounting: observed.fact.permitAccounting.map((entry, index) => index === 0
        ? { ...entry, released: "0", active: "1" }
        : entry),
    }),
    /permit accounting totals mismatch|permit active count mismatch|identity mismatch/,
  );
  assert.deepEqual(
    observed.completions.map(completion => readQualifiedSchedulerWorkCompletionCapability(performancePort, completion, issuer, capability).work.workId),
    ["range-before-cursor", "range-0", "range-1"],
  );
  assert.throws(
    () => openQualifiedSchedulerPerformanceCursor(performancePort, issuer, capability),
    /unacknowledged/,
  );
  acknowledgeQualifiedSchedulerPerformanceRange(performancePort, range, issuer, capability);
  assert.throws(
    () => readQualifiedSchedulerPerformanceRange(performancePort, range, issuer, capability),
    /already acknowledged/,
  );
  assert.throws(
    () => acknowledgeQualifiedSchedulerPerformanceRange(performancePort, range, issuer, capability),
    /not the active unacknowledged range/,
  );

  const nextCursor = openQualifiedSchedulerPerformanceCursor(performancePort, issuer, capability);
  await scheduler.run({ work: descriptor("range-2", "owner-c"), caller, execute: async () => undefined });
  const nextRange = sealQualifiedSchedulerPerformanceRange(performancePort, nextCursor, issuer, capability);
  const nextObserved = readQualifiedSchedulerPerformanceRange(performancePort, nextRange, issuer, capability);
  assert.equal(nextObserved.fact.startSequence, "3");
  assert.equal(nextObserved.fact.endSequence, "4");
  assert.equal(nextObserved.fact.completionCount, "1");
});

test("authority issuers reject restart/open without release registry", () => {
  assert.throws(() => createTestQualifiedExecutorAuthorityIssuer(undefined as never, undefined as never), ExecutorAuthorityError);
  assert.throws(() => createTestQualifiedExecutorAuthorityIssuer({} as never, undefined as never), ExecutorAuthorityError);
});

test("same resource is bounded and permits are released only after callback settlement", async () => {
  const scheduler = new WorkScheduler({
    resources: { rpc: { capacity: 1 } },
    lanes: { fast: { queueCap: 4, concurrency: 1, resource: "rpc" } },
    quotas: { rpc: { concurrency: 1 } },
  });
  let release!: (value: number) => void;
  const first = scheduler.run({
    work: descriptor("first", "owner-a"),
    caller,
    execute: async () => new Promise<number>((resolve) => { release = resolve; }),
  });
  const second = scheduler.run({
    work: descriptor("second", "owner-b"),
    caller,
    execute: async () => 2,
  });
  await Promise.resolve();
  assert.equal(scheduler.snapshot().activeByResource.rpc, 1);
  assert.equal(scheduler.snapshot().queuedByLane.fast, 1);
  release(1);
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  scheduler.assertPermitConservation();
  assert.equal(scheduler.snapshot().accounting.permitsIssued, 2);
  assert.equal(scheduler.snapshot().accounting.permitsReleased, 2);
});
test("queue full and resource limit remain typed retryable classifications", async () => {
  const scheduler = new WorkScheduler({
    resources: { tiny: { capacity: 1 } },
    lanes: { lane: { queueCap: 1, concurrency: 1, resource: "tiny" } },
  });
  let release!: () => void;
  const active = scheduler.run({
    work: descriptor("active", "owner", { lane: "lane", resource: "tiny" }),
    caller,
    execute: async () => new Promise<void>((resolve) => { release = resolve; }),
  });
  const queued = scheduler.run({
    work: descriptor("queued", "owner-2", { lane: "lane", resource: "tiny" }),
    caller,
    execute: async () => undefined,
  });
  await assert.rejects(
    scheduler.run({
      work: descriptor("overflow", "owner-3", { lane: "lane", resource: "tiny" }),
      caller,
      execute: async () => undefined,
    }),
    (error: unknown) => error instanceof SchedulerError && error.code === "queue-full",
  );
  await assert.rejects(
    scheduler.run({
      work: descriptor("too-large", "owner-4", { lane: "lane", resource: "tiny", cost: 2 }),
      caller,
      execute: async () => undefined,
    }),
    (error: unknown) => error instanceof SchedulerError && error.code === "impossible-cost" && error.retryClass === "invalid-program",
  );
  release();
  await Promise.all([active, queued]);
  scheduler.assertPermitConservation();
});

test("critical reserve and independent resources avoid heavy-head-of-line blocking", async () => {
  const scheduler = new WorkScheduler({
    resources: { rpc: { capacity: 1 }, heavy: { capacity: 1 } },
    lanes: {
      critical: { queueCap: 2, concurrency: 1, resource: "rpc", reserved: 1 },
      heavy: { queueCap: 2, concurrency: 1, resource: "heavy" },
    },
  });
  let release!: () => void;
  const held = scheduler.run({
    work: descriptor("held", "owner", { lane: "heavy", resource: "heavy" }),
    caller,
    execute: async () => new Promise<void>((resolve) => { release = resolve; }),
  });
  const critical = await scheduler.run({
    work: descriptor("critical", "owner-2", { lane: "critical", resource: "rpc" }),
    caller,
    execute: async () => "critical",
  });
  assert.equal(critical, "critical");
  release();
  await held;
  scheduler.assertPermitConservation();
});

test("explicit quotaKey owns quota policy before resource quota", async () => {
  const scheduler = new WorkScheduler({
    resources: { rpc: { capacity: 2 } },
    lanes: { lane: { queueCap: 2, concurrency: 2, resource: "rpc" } },
    quotas: { rpc: { concurrency: 2 }, "family-a": { concurrency: 1 } },
  });
  let release!: () => void;
  const first = scheduler.run({
    work: descriptor("quota-first", "owner-a", { lane: "lane", quotaKey: "family-a" }),
    caller,
    execute: async () => new Promise<void>((resolve) => { release = resolve; }),
  });
  const second = scheduler.run({
    work: descriptor("quota-second", "owner-b", { lane: "lane", quotaKey: "family-a" }),
    caller,
    execute: async () => "second",
  });
  await Promise.resolve();
  assert.equal(scheduler.snapshot().queuedByLane.lane, 1);
  release();
  await Promise.all([first, second]);
});

test("resource quota aggregates owners when no explicit quotaKey is issued", async () => {
  const scheduler = new WorkScheduler({
    resources: { rpc: { capacity: 2 } },
    lanes: { lane: { queueCap: 2, concurrency: 2, resource: "rpc" } },
    quotas: { rpc: { concurrency: 1 } },
  });
  let release!: () => void;
  const first = scheduler.run({ work: descriptor("resource-first", "owner-a", { lane: "lane" }), caller, execute: async () => new Promise<void>((resolve) => { release = resolve; }) });
  const second = scheduler.run({ work: descriptor("resource-second", "owner-b", { lane: "lane" }), caller, execute: async () => "second" });
  await Promise.resolve();
  assert.equal(scheduler.snapshot().queuedByLane.lane, 1);
  release();
  await Promise.all([first, second]);
});

test("permit release is scheduler-internal and queued deadline is rechecked at drain", async () => {
  let clock = 0;
  const scheduler = new WorkScheduler({
    clock: () => clock,
    resources: { rpc: { capacity: 1 } },
    lanes: { lane: { queueCap: 2, concurrency: 1, resource: "rpc" } },
  });
  let release!: () => void;
  const active = scheduler.run({
    work: descriptor("held", "owner-a", { lane: "lane", deadlineAtMs: 100 }),
    caller,
    execute: async (permit) => {
      assert.equal("release" in permit, false);
      return new Promise<void>((resolve) => { release = resolve; });
    },
  });
  const queued = scheduler.run({
    work: descriptor("expired", "owner-b", { lane: "lane", deadlineAtMs: 10 }),
    caller,
    execute: async () => undefined,
  });
  await Promise.resolve();
  clock = 20;
  release();
  await assert.rejects(queued, (error: unknown) => error instanceof SchedulerError && error.code === "deadline");
  await active;
});
