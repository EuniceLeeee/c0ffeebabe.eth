import assert from "node:assert/strict";
import test from "node:test";
import {
  ARTIFACT_RESOLUTION_SCHEMA_MANIFESTS,
  createArtifactResolutionClaim,
  createObservedImmutableMirror,
  createResolverPolicy,
  createRetentionLeaseReceipt,
  decodeArtifactResolutionClaim,
  decodeArtifactBytes,
  decodeObservedImmutableMirror,
  decodeResolverPolicy,
  decodeRetentionLeaseReceipt,
  encodeArtifactResolutionClaim,
  encodeArtifactBytes,
  encodeObservedImmutableMirror,
  encodeResolverPolicy,
  encodeRetentionLeaseReceipt,
  recomputeArtifactResolutionClaimId,
  type ArtifactResolutionClaimV1,
  type Hash,
} from "../src/index.ts";

const h = (digit: string): Hash => `0x${digit.repeat(64)}` as Hash;
const schema = {
  id: "fact.schema",
  version: "1.0.0",
  schemaHash: h("a"),
} as const;

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

const lease = createRetentionLeaseReceipt({
  storeIdentityHash: h("1"),
  objectKey: h("2"),
  contentSha256: h("3"),
  validFromStoreEpoch: "1",
  validThroughStoreEpoch: "20",
  issuerId: "lease-issuer",
  issuerQualificationId: h("4"),
  qualificationRegistryRoot: h("5"),
});

const mirror = createObservedImmutableMirror({
  storeIdentityHash: h("1"),
  objectKey: h("2"),
  bytes: "0x726177",
  mediaType: "application/json",
  schema,
});

function claim(
  overrides: Partial<Omit<ArtifactResolutionClaimV1, "claimId">> = {},
): ArtifactResolutionClaimV1 {
  return createArtifactResolutionClaim({
    artifactRefId: h("6"),
    resolverPolicyHash: policy.policyHash,
    observedMirror: mirror,
    outcome: "content-observed",
    ...overrides,
  });
}

test("executable schema hashes are stable golden values", () => {
  assert.equal(
    ARTIFACT_RESOLUTION_SCHEMA_MANIFESTS.resolverPolicy.schemaHash,
    "0x3958569997b18f4386125d3b2c67b5fe510cc98b7bdebd79a62234953318603f",
  );
  assert.equal(
    ARTIFACT_RESOLUTION_SCHEMA_MANIFESTS.retentionLeaseReceipt.schemaHash,
    "0xfb788d685c306845a82c2fb8cc7975536e87c4f4aec3e891abd2a60dda922bd9",
  );
  assert.equal(
    ARTIFACT_RESOLUTION_SCHEMA_MANIFESTS.observedImmutableMirror.schemaHash,
    "0x3db1eda63599e87992614c905bf325d6f4c7f3e75dfd655f5afb2012d11529c6",
  );
  assert.equal(
    ARTIFACT_RESOLUTION_SCHEMA_MANIFESTS.artifactResolutionClaim.schemaHash,
    "0xfa11b1c9f22d52de8563c64873e48ead198e03b07ddff72144fb6e94b25f10c2",
  );
});

test("policy and lease preserve exact wire contracts and derived identities", () => {
  assert.deepEqual(decodeResolverPolicy(encodeResolverPolicy(policy)), policy);
  assert.deepEqual(
    decodeRetentionLeaseReceipt(encodeRetentionLeaseReceipt(lease)),
    lease,
  );
  assert.throws(() => decodeResolverPolicy({ ...policy, maxByteLength: "2048" }));
  assert.throws(() => decodeRetentionLeaseReceipt({
    ...lease,
    validThroughStoreEpoch: "21",
  }));
  assert.throws(() => createRetentionLeaseReceipt({
    ...lease,
    validFromStoreEpoch: "21",
    validThroughStoreEpoch: "20",
  }));
});

test("binary codec accepts only exact native Uint8Array and never invokes hostile traps", () => {
  const encoded = encodeResolverPolicy(policy);
  assert.deepEqual(decodeResolverPolicy(encoded), policy);

  assert.throws(() => decodeResolverPolicy(Buffer.from(encoded)));
  class DerivedBytes extends Uint8Array {}
  assert.throws(() => decodeResolverPolicy(new DerivedBytes(encoded)));

  let proxyTrapHits = 0;
  const proxy = new Proxy(encoded, {
    get: () => {
      proxyTrapHits += 1;
      throw new Error("proxy trap must not run");
    },
    getOwnPropertyDescriptor: () => {
      proxyTrapHits += 1;
      throw new Error("proxy trap must not run");
    },
    getPrototypeOf: () => {
      proxyTrapHits += 1;
      throw new Error("proxy trap must not run");
    },
    ownKeys: () => {
      proxyTrapHits += 1;
      throw new Error("proxy trap must not run");
    },
  });
  assert.throws(() => decodeResolverPolicy(proxy));
  assert.equal(proxyTrapHits, 0);

  let lengthGetterHits = 0;
  const shadowedLength = encoded.slice();
  Object.defineProperty(shadowedLength, "length", {
    configurable: true,
    get: () => {
      lengthGetterHits += 1;
      return encoded.length;
    },
  });
  assert.throws(() => decodeResolverPolicy(shadowedLength));
  assert.equal(lengthGetterHits, 0);

  const artifactBytes = new Uint8Array([0x72, 0x61, 0x77]);
  assert.deepEqual(decodeArtifactBytes(encodeArtifactBytes(artifactBytes)), artifactBytes);
  assert.throws(() => encodeArtifactBytes(Buffer.from(artifactBytes)));
  assert.throws(() => encodeArtifactBytes(new DerivedBytes(artifactBytes)));
  assert.throws(() => encodeArtifactBytes(proxy as never));
  assert.equal(proxyTrapHits, 0);
  assert.throws(() => encodeArtifactBytes(shadowedLength));
  assert.equal(lengthGetterHits, 0);

  let iteratorGetterHits = 0;
  const iteratorShadow = artifactBytes.slice();
  Object.defineProperty(iteratorShadow, Symbol.iterator, {
    configurable: true,
    get: () => {
      iteratorGetterHits += 1;
      throw new Error("iterator getter must not run");
    },
  });
  assert.equal(encodeArtifactBytes(iteratorShadow), "0x726177");
  assert.equal(iteratorGetterHits, 0);
});

test("observed mirror derives and validates exact bytes, hash and length", () => {
  assert.equal(mirror.bytes, "0x726177");
  assert.equal(mirror.byteLength, "3");
  assert.equal(
    mirror.contentSha256,
    "0xd7439bee24773bcbfa2d0a97947ee36227b10d1022b1a55847e928965bb6bfde",
  );
  assert.equal(Object.isFrozen(mirror), true);
  assert.equal(Object.isFrozen(mirror.schema), true);
  assert.deepEqual(
    decodeObservedImmutableMirror(encodeObservedImmutableMirror(mirror)),
    mirror,
  );

  assert.throws(() => decodeObservedImmutableMirror({
    ...mirror,
    bytes: "0x7261",
  }));
  assert.throws(() => decodeObservedImmutableMirror({
    ...mirror,
    contentSha256: h("f"),
  }));
  assert.throws(() => decodeObservedImmutableMirror({
    ...mirror,
    byteLength: "4",
  }));
  assert.throws(() => createObservedImmutableMirror({
    storeIdentityHash: h("1"),
    objectKey: h("2"),
    bytes: "0xABCDEF",
    mediaType: "application/json",
    schema,
  }));
  assert.throws(() => createObservedImmutableMirror({
    storeIdentityHash: h("1"),
    objectKey: h("2"),
    bytes: "0x0",
    mediaType: "application/json",
    schema,
  }));
});

test("claim outcome/mirror relation and claim ID are fail-closed", () => {
  const observed = claim();
  assert.equal(observed.outcome, "content-observed");
  assert.equal(Object.isFrozen(observed), true);
  assert.throws(() => createArtifactResolutionClaim({
    artifactRefId: h("6"),
    resolverPolicyHash: policy.policyHash,
    observedMirror: null,
    outcome: "content-observed",
  }));
  assert.throws(() => createArtifactResolutionClaim({
    artifactRefId: h("6"),
    resolverPolicyHash: policy.policyHash,
    observedMirror: mirror,
    outcome: "missing",
  }));

  const tampered = {
    ...observed,
    outcome: "content-mismatch" as const,
  };
  assert.throws(() => decodeArtifactResolutionClaim(tampered));
  const reidentified = {
    ...tampered,
    claimId: recomputeArtifactResolutionClaimId({
      ...tampered,
      claimId: h("0"),
    }),
  };
  assert.equal(
    decodeArtifactResolutionClaim(reidentified).outcome,
    "content-mismatch",
  );
});

test("claim round-trips exact canonical bytes and carries no authority fields", () => {
  const value = claim();
  assert.deepEqual(
    decodeArtifactResolutionClaim(encodeArtifactResolutionClaim(value)),
    value,
  );
  assert.equal("resolverImplementationDigest" in value, false);
  assert.equal("resolverQualificationId" in value, false);
  assert.equal("qualificationRegistryRoot" in value, false);
});

test("creators reject getters, proxies and unknown fields without invoking traps", () => {
  let getterReads = 0;
  const accessorDraft = {
    storeIdentityHash: h("1"),
    objectKey: h("2"),
    mediaType: "application/json",
    schema,
  } as Record<string, unknown>;
  Object.defineProperty(accessorDraft, "bytes", {
    enumerable: true,
    get() {
      getterReads += 1;
      return "0x726177";
    },
  });
  assert.throws(
    () => createObservedImmutableMirror(accessorDraft as never),
    /data property/,
  );
  assert.equal(getterReads, 0);

  let proxyTraps = 0;
  const proxied = new Proxy(
    {
      artifactRefId: h("6"),
      resolverPolicyHash: policy.policyHash,
      observedMirror: mirror,
      outcome: "content-observed" as const,
    },
    {
      ownKeys(target) {
        proxyTraps += 1;
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor(target, property) {
        proxyTraps += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    },
  );
  assert.throws(() => createArtifactResolutionClaim(proxied));
  assert.equal(proxyTraps, 0);

  assert.throws(() => createArtifactResolutionClaim({
    artifactRefId: h("6"),
    resolverPolicyHash: policy.policyHash,
    observedMirror: mirror,
    outcome: "content-observed",
    unexpected: true,
  } as never), /unknown draft field/);
});
