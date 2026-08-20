import assert from "node:assert/strict";
import test from "node:test";
import { sha256Hex, type Hash } from "../../canonical-codec/src/index.ts";
import {
  createReadOnlyArtifactRef,
  type ReadOnlyArtifactRefV1,
} from "../../../specs/core-envelope/src/index.ts";
import {
  createResolverPolicy,
  createRetentionLeaseReceipt,
  type ResolverPolicyV1,
} from "../../../specs/artifact-resolution/src/index.ts";
import {
  resolveArtifactClaim,
  resolveArtifactClaims,
  type ArtifactResolverIO,
  type ImmutableMirrorRead,
} from "../src/index.ts";

const h = (digit: string): Hash => `0x${digit.repeat(64)}` as Hash;
const sourceBytes = new TextEncoder().encode("raw");
const contentSha256 = sha256Hex(sourceBytes);
const storeIdentityHash = h("1");
const schema = {
  id: "fact.schema",
  version: "1.0.0",
  schemaHash: h("2"),
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
  storeIdentityHash,
  objectKey: contentSha256,
  contentSha256,
  validFromStoreEpoch: "1",
  validThroughStoreEpoch: "20",
  issuerId: "issuer-1",
  issuerQualificationId: h("3"),
  qualificationRegistryRoot: h("4"),
});

function refFor(
  overrides: Partial<Parameters<typeof createReadOnlyArtifactRef>[0]> = {},
): ReadOnlyArtifactRefV1 {
  return createReadOnlyArtifactRef({
    locator: {
      kind: "content-object",
      storeIdentityHash,
      objectKey: h("5"),
    },
    immutableMirrorLocator: {
      kind: "content-object",
      storeIdentityHash,
      objectKey: contentSha256,
    },
    contentSha256,
    byteLength: String(sourceBytes.byteLength),
    mediaType: "application/octet-stream",
    schema,
    resolverPolicyHash: policy.policyHash,
    retentionLeaseReceiptId: lease.receiptId,
    ...overrides,
  });
}

function ioFor(
  read: ImmutableMirrorRead | null = {
    storeIdentityHash,
    objectKey: contentSha256,
    bytes: sourceBytes,
    mediaType: "application/octet-stream",
    schema,
  },
): ArtifactResolverIO {
  return {
    contentStore: {
      async readImmutableMirror() {
        return read;
      },
    },
  };
}

test("exact immutable content produces only an untrusted frozen claim", async () => {
  const mutableBytes = Uint8Array.from(sourceBytes);
  const claim = await resolveArtifactClaim(refFor(), policy, ioFor({
    storeIdentityHash,
    objectKey: contentSha256,
    bytes: mutableBytes,
    mediaType: "application/octet-stream",
    schema,
  }));
  mutableBytes[0] = 0;

  assert.equal(claim.outcome, "content-observed");
  assert.equal(claim.observedMirror?.bytes, "0x726177");
  assert.equal(claim.observedMirror?.contentSha256, contentSha256);
  assert.equal(Object.isFrozen(claim), true);
  assert.equal(Object.isFrozen(claim.observedMirror), true);
  assert.equal(typeof claim.observedMirror?.bytes, "string");
  assert.deepEqual(Object.keys(claim).sort(), [
    "artifactRefId",
    "claimId",
    "observedMirror",
    "outcome",
    "resolverPolicyHash",
  ]);
});

test("missing content remains an unqualified missing claim", async () => {
  const claim = await resolveArtifactClaim(refFor(), policy, ioFor(null));
  assert.equal(claim.outcome, "missing");
  assert.equal(claim.observedMirror, null);
});

test("policy and every observed mirror field participate in mismatch", async () => {
  let reads = 0;
  const otherPolicy = createResolverPolicy({
    ...policy,
    policyHash: undefined,
    maxByteLength: "2048",
  });
  const policyMismatch = await resolveArtifactClaim(refFor(), otherPolicy, {
    contentStore: {
      async readImmutableMirror() {
        reads += 1;
        return null;
      },
    },
  });
  assert.equal(policyMismatch.outcome, "content-mismatch");
  assert.equal(policyMismatch.observedMirror, null);
  assert.equal(reads, 0);

  const mismatches: ImmutableMirrorRead[] = [
    {
      storeIdentityHash: h("9"),
      objectKey: contentSha256,
      bytes: sourceBytes,
      mediaType: "application/octet-stream",
      schema,
    },
    {
      storeIdentityHash,
      objectKey: h("9"),
      bytes: sourceBytes,
      mediaType: "application/octet-stream",
      schema,
    },
    {
      storeIdentityHash,
      objectKey: contentSha256,
      bytes: new Uint8Array([1]),
      mediaType: "application/octet-stream",
      schema,
    },
    {
      storeIdentityHash,
      objectKey: contentSha256,
      bytes: sourceBytes,
      mediaType: "text/plain",
      schema,
    },
    {
      storeIdentityHash,
      objectKey: contentSha256,
      bytes: sourceBytes,
      mediaType: "application/octet-stream",
      schema: { ...schema, id: "other.schema" },
    },
  ];
  for (const mismatch of mismatches) {
    const claim = await resolveArtifactClaim(refFor(), policy, ioFor(mismatch));
    assert.equal(claim.outcome, "content-mismatch");
    assert.notEqual(claim.observedMirror, null);
  }

  const lengthMismatch = await resolveArtifactClaim(
    refFor({ byteLength: "4" }),
    policy,
    ioFor(),
  );
  assert.equal(lengthMismatch.outcome, "content-mismatch");
});

test("max byte policy rejects before content I/O", async () => {
  const smallPolicy = createResolverPolicy({
    ...policy,
    policyHash: undefined,
    maxByteLength: "2",
  });
  let reads = 0;
  const claim = await resolveArtifactClaim(
    refFor({ resolverPolicyHash: smallPolicy.policyHash }),
    smallPolicy,
    {
      contentStore: {
        async readImmutableMirror() {
          reads += 1;
          return null;
        },
      },
    },
  );
  assert.equal(claim.outcome, "content-mismatch");
  assert.equal(reads, 0);
});

test("actual mirror bytes are bounded before copy and encoding", async () => {
  const exactPolicy = createResolverPolicy({
    ...policy,
    policyHash: undefined,
    maxByteLength: String(sourceBytes.length),
  });
  const claim = await resolveArtifactClaim(
    refFor({ resolverPolicyHash: exactPolicy.policyHash }),
    exactPolicy,
    ioFor({
      storeIdentityHash,
      objectKey: contentSha256,
      bytes: new Uint8Array(sourceBytes.length + 1),
      mediaType: "application/octet-stream",
      schema,
    }),
  );
  assert.equal(claim.outcome, "content-mismatch");
  assert.equal(claim.observedMirror, null);
});

test("malformed, accessor and proxy store values fail without invoking traps", async () => {
  let getterReads = 0;
  const accessorBlob = {
    storeIdentityHash,
    objectKey: contentSha256,
    mediaType: "application/octet-stream",
    schema,
  } as Record<string, unknown>;
  Object.defineProperty(accessorBlob, "bytes", {
    enumerable: true,
    get() {
      getterReads += 1;
      return sourceBytes;
    },
  });
  await assert.rejects(() => resolveArtifactClaim(
    refFor(),
    policy,
    ioFor(accessorBlob as never),
  ));
  assert.equal(getterReads, 0);

  let proxyTraps = 0;
  const proxyBlob = new Proxy(
    {
      storeIdentityHash,
      objectKey: contentSha256,
      bytes: sourceBytes,
      mediaType: "application/octet-stream",
      schema,
    },
    {
      ownKeys(target) {
        proxyTraps += 1;
        return Reflect.ownKeys(target);
      },
    },
  );
  await assert.rejects(() => resolveArtifactClaim(
    refFor(),
    policy,
    ioFor(proxyBlob),
  ));
  assert.equal(proxyTraps, 0);

  await assert.rejects(() => resolveArtifactClaim(
    refFor(),
    policy,
    ioFor({
      storeIdentityHash,
      objectKey: contentSha256,
      bytes: sourceBytes,
      mediaType: "application/octet-stream",
      schema,
      unexpected: true,
    } as never),
  ));
});

test("mirror bytes accept only exact native Uint8Array and never invoke hostile traps", async () => {
  const readWith = (bytes: unknown): ImmutableMirrorRead => ({
    storeIdentityHash,
    objectKey: contentSha256,
    bytes: bytes as Uint8Array,
    mediaType: "application/octet-stream",
    schema,
  });

  const accepted = await resolveArtifactClaim(refFor(), policy, ioFor(readWith(sourceBytes)));
  assert.equal(accepted.outcome, "content-observed");

  await assert.rejects(() => resolveArtifactClaim(refFor(), policy, ioFor(readWith(Buffer.from(sourceBytes)))));
  class DerivedBytes extends Uint8Array {}
  await assert.rejects(() => resolveArtifactClaim(refFor(), policy, ioFor(readWith(new DerivedBytes(sourceBytes)))));

  let proxyTrapHits = 0;
  const proxy = new Proxy(sourceBytes, {
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
  await assert.rejects(() => resolveArtifactClaim(refFor(), policy, ioFor(readWith(proxy))));
  assert.equal(proxyTrapHits, 0);

  let lengthGetterHits = 0;
  const shadowedLength = sourceBytes.slice();
  Object.defineProperty(shadowedLength, "length", {
    configurable: true,
    get: () => {
      lengthGetterHits += 1;
      return sourceBytes.length;
    },
  });
  await assert.rejects(() => resolveArtifactClaim(refFor(), policy, ioFor(readWith(shadowedLength))));
  assert.equal(lengthGetterHits, 0);

  let iteratorGetterHits = 0;
  const iteratorShadow = sourceBytes.slice();
  Object.defineProperty(iteratorShadow, Symbol.iterator, {
    configurable: true,
    get: () => {
      iteratorGetterHits += 1;
      throw new Error("iterator getter must not run");
    },
  });
  const iteratorSafe = await resolveArtifactClaim(
    refFor(),
    policy,
    ioFor(readWith(iteratorShadow)),
  );
  assert.equal(iteratorSafe.outcome, "content-observed");
  assert.equal(iteratorGetterHits, 0);
});

test("I/O errors propagate and batch output is immutable", async () => {
  await assert.rejects(
    () => resolveArtifactClaim(refFor(), policy, {
      contentStore: {
        async readImmutableMirror() {
          throw new Error("content store unavailable");
        },
      },
    }),
    /content store unavailable/,
  );

  const claims = await resolveArtifactClaims(
    [refFor(), refFor()],
    policy,
    ioFor(),
  );
  assert.equal(claims.length, 2);
  assert.equal(Object.isFrozen(claims), true);
});
