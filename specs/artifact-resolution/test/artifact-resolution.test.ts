import assert from "node:assert/strict";
import test from "node:test";
import { createReadOnlyArtifactRef, type Hash } from "../../core-envelope/src/index.ts";
import {
  ARTIFACT_RESOLUTION_SCHEMA_MANIFESTS,
  createArtifactResolutionResult,
  createRetentionLeaseReceipt,
  createResolverPolicy,
  decodeArtifactResolutionResult,
  decodeRetentionLeaseReceipt,
  decodeResolverPolicy,
  encodeArtifactResolutionResult,
  encodeRetentionLeaseReceipt,
  encodeResolverPolicy,
  recomputeArtifactResolutionResultId,
  type ImmutableMirrorBlob,
  type IssuerQualificationRegistry,
  type LeaseStore,
  type ReadOnlyContentStore,
  type ResolverPolicyV1,
  type RetentionLeaseReceiptV1,
} from "../src/index.ts";
import { resolveArtifact, type ArtifactResolverDependencies } from "../../../packages/artifact-resolver/src/index.ts";
import { sha256Hex } from "../../../packages/canonical-codec/src/index.ts";

const h = (digit: string): Hash => `0x${digit.repeat(64)}` as Hash;
const storeHash = h("1");
const registryRoot = h("2");
const issuerQualificationId = h("3");
const resolverImplementationDigest = h("4");
const resolverQualificationId = h("5");
const bytes = new TextEncoder().encode("immutable-fact");
const contentHash = sha256Hex(bytes);

const policy = createResolverPolicy({
  schemaVersion: 1,
  kind: "aloha.artifact-resolver-policy",
  allowedLocatorKind: "content-object",
  digestAlgorithm: "sha256",
  maxByteLength: "1024",
  requireExactLengthMediaAndSchema: true,
  minimumRemainingStoreEpochs: "2",
  failureOutcome: "invalid",
});

function leaseFor(overrides: Partial<RetentionLeaseReceiptV1> = {}): RetentionLeaseReceiptV1 {
  return createRetentionLeaseReceipt({
    storeIdentityHash: storeHash,
    objectKey: contentHash,
    contentSha256: contentHash,
    validFromStoreEpoch: "1",
    validThroughStoreEpoch: "20",
    issuerId: "issuer-1",
    issuerQualificationId,
    qualificationRegistryRoot: registryRoot,
    ...overrides,
  });
}

function refFor(overrides: Partial<Parameters<typeof createReadOnlyArtifactRef>[0]> = {}) {
  return createReadOnlyArtifactRef({
    locator: { kind: "content-object", storeIdentityHash: storeHash, objectKey: h("6") },
    immutableMirrorLocator: { kind: "content-object", storeIdentityHash: storeHash, objectKey: contentHash },
    contentSha256: contentHash,
    byteLength: String(bytes.byteLength),
    mediaType: "application/octet-stream",
    schema: null,
    resolverPolicyHash: policy.policyHash,
    retentionLeaseReceiptId: leaseFor().receiptId,
    ...overrides,
  });
}

function makeDeps(options: {
  readonly blob?: ImmutableMirrorBlob | null;
  readonly lease?: unknown | null;
  readonly currentEpoch?: string;
  readonly issuerCurrent?: boolean;
} = {}): ArtifactResolverDependencies {
  const blob = options.blob === undefined
    ? { storeIdentityHash: storeHash, objectKey: contentHash, bytes, mediaType: "application/octet-stream", schema: null }
    : options.blob;
  const contentStore: ReadOnlyContentStore = {
    storeIdentityHash: storeHash,
    async readImmutableMirror() { return blob; },
  };
  const leaseStore: LeaseStore = {
    async getLease() { return options.lease === undefined ? leaseFor() : options.lease; },
    async currentEpoch() { return options.currentEpoch ?? "7"; },
  };
  const issuerRegistry: IssuerQualificationRegistry = {
    async currentIssuerQualification(id, root) {
      return {
        issuerId: "issuer-1",
        issuerQualificationId: id,
        qualificationRegistryRoot: root,
        current: options.issuerCurrent ?? true,
      };
    },
  };
  return {
    contentStore,
    leaseStore,
    issuerRegistry,
    resolverImplementationDigest,
    resolverQualificationId,
    qualificationRegistryRoot: registryRoot,
  };
}

test("executable schema hashes are stable-format golden values", () => {
  assert.equal(ARTIFACT_RESOLUTION_SCHEMA_MANIFESTS.resolverPolicy.schemaHash, "0x3958569997b18f4386125d3b2c67b5fe510cc98b7bdebd79a62234953318603f");
  assert.equal(ARTIFACT_RESOLUTION_SCHEMA_MANIFESTS.retentionLeaseReceipt.schemaHash, "0xfb788d685c306845a82c2fb8cc7975536e87c4f4aec3e891abd2a60dda922bd9");
  assert.equal(ARTIFACT_RESOLUTION_SCHEMA_MANIFESTS.artifactResolutionResult.schemaHash, "0xebf092ea915362021ddd9ea780aa936b6dcc8bc572379ccfce7e741da55e2231");
});

test("resolver requires exact mirror bytes, lease and current issuer", async () => {
  const resolved = await resolveArtifact(refFor(), policy, makeDeps());
  assert.equal(resolved.result.outcome, "resolved");
  assert.equal(resolved.result.bytes, `0x${Buffer.from(bytes).toString("hex")}`);
  assert.deepEqual(resolved.bytes, bytes);
});

test("missing mirror is explicit", async () => {
  const result = await resolveArtifact(refFor(), policy, makeDeps({ blob: null }));
  assert.equal(result.result.outcome, "missing");
  assert.equal(result.bytes, undefined);
});

test("store/object/hash/length/media/schema/policy mismatches are invalid outcomes", async () => {
  const crossStore = await resolveArtifact(refFor(), policy, {
    ...makeDeps(),
    contentStore: { ...makeDeps().contentStore, storeIdentityHash: h("9") },
  });
  assert.equal(crossStore.result.outcome, "mismatch");
  const objectMismatch = await resolveArtifact(refFor(), policy, makeDeps({
    blob: { storeIdentityHash: storeHash, objectKey: h("8"), bytes, mediaType: "application/octet-stream", schema: null },
  }));
  assert.equal(objectMismatch.result.outcome, "mismatch");
  const hashMismatch = await resolveArtifact(refFor(), policy, makeDeps({
    blob: { storeIdentityHash: storeHash, objectKey: contentHash, bytes: new Uint8Array([1]), mediaType: "application/octet-stream", schema: null },
  }));
  assert.equal(hashMismatch.result.outcome, "mismatch");
  const lengthMismatch = await resolveArtifact(refFor({ byteLength: "999" }), policy, makeDeps());
  assert.equal(lengthMismatch.result.outcome, "mismatch");
  const mediaMismatch = await resolveArtifact(refFor(), policy, makeDeps({
    blob: { storeIdentityHash: storeHash, objectKey: contentHash, bytes, mediaType: "text/plain", schema: null },
  }));
  assert.equal(mediaMismatch.result.outcome, "mismatch");
  const schemaHash = h("a");
  const schemaMismatch = await resolveArtifact(refFor({ schema: { id: "fact", version: "1.0.0", schemaHash } }), policy, makeDeps());
  assert.equal(schemaMismatch.result.outcome, "mismatch");
  const schemaShapeMismatch = await resolveArtifact(
    refFor({ schema: { id: "fact", version: "1.0.0", schemaHash } }),
    policy,
    makeDeps({
      blob: {
        storeIdentityHash: storeHash,
        objectKey: contentHash,
        bytes,
        mediaType: "application/octet-stream",
        schema: { id: "other-fact", version: "1.0.0", schemaHash },
      },
    }),
  );
  assert.equal(schemaShapeMismatch.result.outcome, "mismatch");
  const { policyHash: _policyHash, ...policyDraft } = policy;
  const otherPolicy = createResolverPolicy({ ...policyDraft, maxByteLength: "2048" });
  const policyMismatch = await resolveArtifact(refFor(), otherPolicy, makeDeps());
  assert.equal(policyMismatch.result.outcome, "mismatch");
});

test("lease interval, remaining epochs and issuer currentness are fail-closed", async () => {
  const missing = await resolveArtifact(refFor(), policy, makeDeps({ lease: null }));
  assert.equal(missing.result.outcome, "lease-invalid");
  const forgedReceipt = { ...leaseFor(), receiptId: h("0") };
  const forged = await resolveArtifact(refFor(), policy, makeDeps({ lease: forgedReceipt }));
  assert.equal(forged.result.outcome, "lease-invalid");
  const wrongSubject = await resolveArtifact(refFor(), policy, makeDeps({ lease: leaseFor({ objectKey: h("9") }) }));
  assert.equal(wrongSubject.result.outcome, "lease-invalid");
  const expired = await resolveArtifact(refFor(), policy, makeDeps({ lease: leaseFor({ validThroughStoreEpoch: "7" }) }));
  assert.equal(expired.result.outcome, "lease-invalid");
  const staleIssuer = await resolveArtifact(refFor(), policy, makeDeps({ issuerCurrent: false }));
  assert.equal(staleIssuer.result.outcome, "lease-invalid");
});

test("resolution ID binds the complete canonical result", () => {
  const result = createArtifactResolutionResult({
    artifactRefId: h("a"),
    resolverPolicyHash: policy.policyHash,
    resolverImplementationDigest,
    resolverQualificationId,
    qualificationRegistryRoot: registryRoot,
    resolvedAtStoreEpoch: "7",
    bytes: null,
    observedContentSha256: null,
    observedByteLength: null,
    outcome: "missing",
  });
  assert.throws(() => decodeArtifactResolutionResult({ ...result, outcome: "resolved" }));
});

test("resolved bytes are independently decoded and hashed; non-resolved bytes are forbidden", () => {
  const resolved = createArtifactResolutionResult({
    artifactRefId: h("a"),
    resolverPolicyHash: policy.policyHash,
    resolverImplementationDigest,
    resolverQualificationId,
    qualificationRegistryRoot: registryRoot,
    resolvedAtStoreEpoch: "7",
    bytes: "0x726177",
    observedContentSha256: sha256Hex(new TextEncoder().encode("raw")),
    observedByteLength: "3",
    outcome: "resolved",
  });
  const fakeHash = {
    ...resolved,
    observedContentSha256: h("f"),
    resultId: h("0"),
  };
  assert.throws(() => decodeArtifactResolutionResult({
    ...fakeHash,
    resultId: recomputeArtifactResolutionResultId(fakeHash),
  }));
  const fakeBytes = { ...resolved, bytes: "raw", resultId: h("0") };
  assert.throws(() => decodeArtifactResolutionResult({
    ...fakeBytes,
    resultId: recomputeArtifactResolutionResultId(fakeBytes),
  }));
  const invalidMissing = {
    ...resolved,
    outcome: "missing" as const,
    bytes: null,
    observedContentSha256: null,
    observedByteLength: "1",
    resultId: h("0"),
  };
  assert.throws(() => decodeArtifactResolutionResult({
    ...invalidMissing,
    resultId: recomputeArtifactResolutionResultId(invalidMissing),
  }));
});

test("content-store I/O failures propagate instead of becoming missing", async () => {
  const deps = makeDeps();
  const failingStore: ReadOnlyContentStore = {
    ...deps.contentStore,
    async readImmutableMirror() {
      throw new Error("content store unavailable");
    },
  };
  await assert.rejects(
    () => resolveArtifact(refFor(), policy, { ...deps, contentStore: failingStore }),
    /content store unavailable/,
  );
});

test("create functions inspect only data properties and reject unknown fields", () => {
  let getterReads = 0;
  const getterDraft = {
    schemaVersion: 1,
    kind: "aloha.artifact-resolver-policy",
    allowedLocatorKind: "content-object",
    digestAlgorithm: "sha256",
    requireExactLengthMediaAndSchema: true,
    minimumRemainingStoreEpochs: "2",
    failureOutcome: "invalid",
  } as Record<string, unknown>;
  Object.defineProperty(getterDraft, "maxByteLength", {
    enumerable: true,
    get() {
      getterReads += 1;
      return "1024";
    },
  });
  assert.throws(() => createResolverPolicy(getterDraft as never), /data property/);
  assert.equal(getterReads, 0);

  assert.throws(() => createResolverPolicy({
    schemaVersion: 1,
    kind: "aloha.artifact-resolver-policy",
    allowedLocatorKind: "content-object",
    digestAlgorithm: "sha256",
    maxByteLength: "1024",
    requireExactLengthMediaAndSchema: true,
    minimumRemainingStoreEpochs: "2",
    failureOutcome: "invalid",
    unexpected: true,
  } as never), /unknown draft field/);

  assert.throws(() => createRetentionLeaseReceipt({
    storeIdentityHash: storeHash,
    objectKey: contentHash,
    contentSha256: contentHash,
    validFromStoreEpoch: "1",
    validThroughStoreEpoch: "20",
    issuerId: "issuer-1",
    issuerQualificationId,
    qualificationRegistryRoot: registryRoot,
    unexpected: true,
  } as never), /unknown draft field/);
  assert.throws(() => createArtifactResolutionResult({
    artifactRefId: h("a"),
    resolverPolicyHash: policy.policyHash,
    resolverImplementationDigest,
    resolverQualificationId,
    qualificationRegistryRoot: registryRoot,
    resolvedAtStoreEpoch: "7",
    bytes: null,
    observedContentSha256: null,
    observedByteLength: null,
    outcome: "missing",
    unexpected: true,
  } as never), /unknown draft field/);
  const { policyHash: _policyHash, ...policyDraft } = policy;
  assert.throws(() => createResolverPolicy({ ...policyDraft, policyHash: h("0") } as never), /unknown draft field/);
  const lease = leaseFor();
  const { receiptId: _receiptId, ...leaseDraft } = lease;
  assert.throws(() => createRetentionLeaseReceipt({ ...leaseDraft, receiptId: h("0") } as never), /unknown draft field/);
});

test("created artifacts round-trip through canonical bytes exactly", () => {
  const lease = leaseFor();
  const result = createArtifactResolutionResult({
    artifactRefId: h("a"),
    resolverPolicyHash: policy.policyHash,
    resolverImplementationDigest,
    resolverQualificationId,
    qualificationRegistryRoot: registryRoot,
    resolvedAtStoreEpoch: "7",
    bytes: "0x726177",
    observedContentSha256: sha256Hex(new TextEncoder().encode("raw")),
    observedByteLength: "3",
    outcome: "resolved",
  });
  assert.deepEqual(decodeResolverPolicy(encodeResolverPolicy(policy)), policy);
  assert.deepEqual(decodeRetentionLeaseReceipt(encodeRetentionLeaseReceipt(lease)), lease);
  assert.deepEqual(decodeArtifactResolutionResult(encodeArtifactResolutionResult(result)), result);
});
