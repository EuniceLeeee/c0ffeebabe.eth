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
} from "../src/index.ts";
import {
  RELEASE_AUTHORITY_DOMAINS,
  createRuntimeReleaseBindingV1,
  decodeQualifiedExecutorRegistryEntryV1 as decodeReleaseQualifiedExecutorRegistryEntryV1,
  decodeRuntimeReleaseBindingV1,
  hashQualifiedExecutorRegistryEntry as hashReleaseQualifiedExecutorRegistryEntry,
  type QualifiedExecutorRegistryEntryV1,
  type RuntimeReleaseBindingPayloadV1,
} from "../../../specs/release-authority/src/index.ts";
import {
  createTestQualifiedExecutorAuthorityIssuer,
  ExecutorAuthorityError,
  testReleaseApprovalPort,
} from "./fixtures/qualified-release.ts";

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
  return {
    schemaVersion: 1,
    kind: "aloha.runtime-release-binding",
    acceptanceCertificate: {
      certificateId: hashDomain("test/certificate", "certificate"),
      payloadHash: hashDomain("test/certificate-payload", "certificate-payload"),
      verdict: "pass",
    },
    releaseAuthorityApprovalId: hashDomain("test/approval", "approval"),
    releaseAuthorityApprovalPayloadHash: hashDomain("test/approval", "payload"),
    authorityPinDigest: hashDomain("test/pin", "pin"),
    externalTrustAnchorRoot: hashDomain("test/approval", "trust-anchor"),
    externalIssuerKeySetRoot: hashDomain("test/approval", "issuer-key-set"),
    qualificationRegistryApprovalId: hashDomain("test/approval", "registry-approval"),
    qualificationRegistryRoot: hashDomain("test/approval", "registry"),
    qualificationEpoch: "1",
    qualificationAudienceHash: hashDomain("test/approval", "audience"),
    predicateCompositionRootDigest: hashDomain("test/approval", "predicate-composition"),
    gateCoreRuntimeClosureDigest: hashDomain("test/approval", "runtime-closure"),
    gateCoreImplementationClosureDigest: hashDomain("test/approval", "core-closure"),
    qualifiedExecutorRegistryRoot: registry.registryRoot,
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
