import assert from "node:assert/strict";
import test from "node:test";
import {
  ARTIFACT_BYTES_CHUNK_BYTE_LENGTH,
  ARTIFACT_MIRROR_MAX_DECODED_BYTES,
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
  preflightArtifactBytesByteLength,
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
  bytes: encodeArtifactBytes(new Uint8Array([0x72, 0x61, 0x77])),
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
    "0x504148fa0fb188a605b77c2848f72e829582db8538e473a6959d5a5a67b6d300",
  );
  assert.equal(
    ARTIFACT_RESOLUTION_SCHEMA_MANIFESTS.artifactResolutionClaim.schemaHash,
    "0x3e97521df798eac7398229ce619febd8afa0c0e0c4531a2e8388b3e0712319ea",
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
  assert.deepEqual(encodeArtifactBytes(iteratorShadow), {
    schemaVersion: 1,
    kind: "aloha.canonical-artifact-bytes",
    byteLength: "3",
    contentSha256: "0xd7439bee24773bcbfa2d0a97947ee36227b10d1022b1a55847e928965bb6bfde",
    chunks: [{ index: "0", bytes: "0x726177" }],
  });
  assert.equal(iteratorGetterHits, 0);
});

test("observed mirror derives and validates exact bytes, hash and length", () => {
  assert.deepEqual(mirror.bytes, {
    schemaVersion: 1,
    kind: "aloha.canonical-artifact-bytes",
    byteLength: "3",
    contentSha256: "0xd7439bee24773bcbfa2d0a97947ee36227b10d1022b1a55847e928965bb6bfde",
    chunks: [{ index: "0", bytes: "0x726177" }],
  });
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
    bytes: encodeArtifactBytes(new Uint8Array([0x72, 0x61])),
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
    bytes: {
      ...mirror.bytes,
      chunks: [{ index: "0", bytes: "0xABCDEF" }],
    },
    mediaType: "application/json",
    schema,
  }));
  assert.throws(() => createObservedImmutableMirror({
    storeIdentityHash: h("1"),
    objectKey: h("2"),
    bytes: {
      ...mirror.bytes,
      chunks: [{ index: "0", bytes: "0x0" }],
    },
    mediaType: "application/json",
    schema,
  }));
});

test("artifact bytes have one exact chunked wire shape across empty and size boundaries", () => {
  const empty = encodeArtifactBytes(new Uint8Array());
  assert.deepEqual(empty, {
    schemaVersion: 1,
    kind: "aloha.canonical-artifact-bytes",
    byteLength: "0",
    contentSha256: "0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    chunks: [],
  });
  assert.deepEqual(decodeArtifactBytes(empty), new Uint8Array());
  assert.throws(() => decodeArtifactBytes("0x"));

  const exact = new Uint8Array(ARTIFACT_BYTES_CHUNK_BYTE_LENGTH).fill(0x5a);
  const exactEncoded = encodeArtifactBytes(exact);
  assert.equal(exactEncoded.chunks.length, 1);
  assert.equal(exactEncoded.chunks[0]!.bytes.length, 2 + ARTIFACT_BYTES_CHUNK_BYTE_LENGTH * 2);
  assert.ok(exactEncoded.chunks[0]!.bytes.length < 131_072);
  assert.deepEqual(decodeArtifactBytes(exactEncoded), exact);

  const split = new Uint8Array(ARTIFACT_BYTES_CHUNK_BYTE_LENGTH + 1).fill(0x6b);
  const splitEncoded = encodeArtifactBytes(split);
  assert.deepEqual(splitEncoded.chunks.map((chunk) => [chunk.index, chunk.bytes.length]), [
    ["0", 2 + ARTIFACT_BYTES_CHUNK_BYTE_LENGTH * 2],
    ["1", 4],
  ]);
  assert.deepEqual(decodeArtifactBytes(splitEncoded), split);
});

test("artifact bytes reject missing, reordered, duplicate and non-canonical chunks", () => {
  const source = new Uint8Array(ARTIFACT_BYTES_CHUNK_BYTE_LENGTH + 2).fill(0x31);
  const encoded = encodeArtifactBytes(source);
  const first = encoded.chunks[0]!;
  const second = encoded.chunks[1]!;

  assert.throws(() => decodeArtifactBytes({ ...encoded, chunks: [first] }));
  assert.throws(() => decodeArtifactBytes({ ...encoded, chunks: [second, first] }));
  assert.throws(() => decodeArtifactBytes({ ...encoded, chunks: [first, { ...second, index: "0" }] }));
  assert.throws(() => decodeArtifactBytes({
    ...encoded,
    chunks: [
      { ...first, bytes: first.bytes.slice(0, -2) },
      { ...second, bytes: `0x31${second.bytes.slice(2)}` },
    ],
  }));
  assert.throws(() => decodeArtifactBytes({
    ...encoded,
    chunks: [{ ...first, bytes: `${first.bytes}00` }, second],
  }));
  assert.throws(() => decodeArtifactBytes({
    ...encoded,
    chunks: [{ ...first, bytes: `0xAB${first.bytes.slice(4)}` }, second],
  }));
  assert.throws(() => decodeArtifactBytes({ ...encoded, byteLength: String(source.length - 1) }));
  assert.throws(() => decodeArtifactBytes({ ...encoded, contentSha256: h("f") }));
});

test("artifact byte preflight rejects hostile cardinality, sparse, accessor and proxy arrays before item reads", () => {
  let itemReads = 0;
  const oversizedCardinality = new Array(16_384);
  Object.defineProperty(oversizedCardinality, "0", {
    configurable: true,
    enumerable: true,
    get: () => {
      itemReads += 1;
      throw new Error("cardinality rejection must precede item reads");
    },
  });
  assert.throws(() => preflightArtifactBytesByteLength({
    ...mirror.bytes,
    byteLength: "1",
    chunks: oversizedCardinality,
  }));
  assert.equal(itemReads, 0);

  const sparse = new Array(1);
  assert.throws(() => preflightArtifactBytesByteLength({ ...mirror.bytes, byteLength: "1", chunks: sparse }));

  const accessor = new Array(1);
  Object.defineProperty(accessor, "0", {
    configurable: true,
    enumerable: true,
    get: () => {
      itemReads += 1;
      throw new Error("accessor must not run");
    },
  });
  assert.throws(() => preflightArtifactBytesByteLength({ ...mirror.bytes, byteLength: "1", chunks: accessor }));
  assert.equal(itemReads, 0);

  let proxyReads = 0;
  const proxy = new Proxy([{ index: "0", bytes: "0x00" }], {
    get: () => {
      proxyReads += 1;
      throw new Error("proxy trap must not run");
    },
    getOwnPropertyDescriptor: () => {
      proxyReads += 1;
      throw new Error("proxy trap must not run");
    },
    ownKeys: () => {
      proxyReads += 1;
      throw new Error("proxy trap must not run");
    },
  });
  assert.throws(() => preflightArtifactBytesByteLength({ ...mirror.bytes, byteLength: "1", chunks: proxy }));
  assert.equal(proxyReads, 0);
});

test("inline mirror cap is exactly realizable by one canonical claim envelope", () => {
  const maximumBytes = new Uint8Array(ARTIFACT_MIRROR_MAX_DECODED_BYTES).fill(0x7a);
  const maximumMirror = createObservedImmutableMirror({
    storeIdentityHash: h("1"),
    objectKey: h("2"),
    bytes: encodeArtifactBytes(maximumBytes),
    mediaType: "application/octet-stream",
    schema: null,
  });
  const maximumClaim = createArtifactResolutionClaim({
    artifactRefId: h("6"),
    resolverPolicyHash: policy.policyHash,
    observedMirror: maximumMirror,
    outcome: "content-observed",
  });
  assert.ok(encodeArtifactResolutionClaim(maximumClaim).byteLength <= 1_048_576);
  assert.deepEqual(decodeArtifactBytes(maximumMirror.bytes), maximumBytes);
  assert.throws(() => encodeArtifactBytes(new Uint8Array(ARTIFACT_MIRROR_MAX_DECODED_BYTES + 1)));
  assert.throws(() => encodeArtifactBytes(new Uint8Array(600_000)));
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
