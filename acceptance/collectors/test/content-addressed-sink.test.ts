import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  encodeCanonicalBytes,
  hashDomain,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import { ARTIFACT_MIRROR_MAX_DECODED_BYTES, createResolverPolicy } from "../../../specs/artifact-resolution/src/index.ts";
import { ContentAddressedObserverSinkV1 } from "../src/index.ts";

const h = (value: string): Hash => hashDomain("test/observer-sink/v1", value);

function sink(directory: string, maxByteLength = "10000", identity = "store"): ContentAddressedObserverSinkV1 {
  return new ContentAddressedObserverSinkV1({
    directory,
    storeIdentityHash: h(identity),
    resolverPolicy: createResolverPolicy({
      schemaVersion: 1,
      kind: "aloha.artifact-resolver-policy",
      allowedLocatorKind: "content-object",
      digestAlgorithm: "sha256",
      maxByteLength,
      requireExactLengthMediaAndSchema: true,
      minimumRemainingStoreEpochs: "0",
      failureOutcome: "invalid",
    }),
    lease: {
      validFromStoreEpoch: "4",
      validThroughStoreEpoch: "9",
      issuerId: "qualified-observer-store",
      issuerQualificationId: h("issuer-qualification"),
      qualificationRegistryRoot: h("qualification-registry"),
    },
  });
}

const schema = Object.freeze({ id: "test.observed-content", version: "1.0.0", schemaHash: h("schema") });

test("observer sink persists exact bytes and derives one self-consistent artifact closure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aloha-observer-sink-"));
  try {
    const bytes = encodeCanonicalBytes({ observed: "fact", sequence: "1" });
    const result = await sink(directory).write({ bytes, mediaType: "application/json", schema });
    assert.deepEqual(new Uint8Array(await readFile(join(directory, result.contentSha256.slice(2)))), bytes);
    assert.equal(result.ref.contentSha256, result.contentSha256);
    assert.equal(result.ref.immutableMirrorLocator.objectKey, result.contentSha256);
    assert.equal(result.ref.retentionLeaseReceiptId, result.lease.receiptId);
    assert.equal(result.claim.artifactRefId, result.ref.artifactRefId);
    assert.equal(result.claim.observedMirror?.contentSha256, result.contentSha256);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("observer sink deduplicates identical bytes without accepting a changed object", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aloha-observer-sink-"));
  try {
    const value = sink(directory);
    const bytes = encodeCanonicalBytes({ observed: "same" });
    const [left, right, ...rest] = await Promise.all(Array.from(
      { length: 16 },
      () => value.write({ bytes, mediaType: "application/json", schema }),
    ));
    assert.equal(left.contentSha256, right.contentSha256);
    assert.equal(left.ref.artifactRefId, right.ref.artifactRefId);
    assert.deepEqual(left.bytes, right.bytes);
    assert.ok(rest.every((artifact) => artifact.ref.artifactRefId === left.ref.artifactRefId));
    left.bytes[0] = left.bytes[0] === 0 ? 1 : 0;
    assert.deepEqual(await value.readContent(right.contentSha256), right.bytes);
    const distinct = await value.write({
      bytes: encodeCanonicalBytes({ observed: "distinct-after-directory-mutation" }),
      mediaType: "application/json",
      schema,
    });
    assert.notEqual(distinct.contentSha256, left.contentSha256);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("observer sink rejects non-concrete bytes and oversize artifacts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aloha-observer-sink-"));
  try {
    const value = sink(directory, "1");
    await assert.rejects(
      value.write({ bytes: encodeCanonicalBytes({ too: "large" }), mediaType: "application/json", schema }),
      /exceeds resolver policy/,
    );
    await assert.rejects(
      value.write({ bytes: new Proxy(new Uint8Array([1]), {}) as Uint8Array, mediaType: "application/json", schema }),
      /concrete Uint8Array/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("observer sink rejects executable or inexact write envelopes without consulting their fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aloha-observer-write-envelope-"));
  try {
    const value = sink(directory);
    let fieldAccesses = 0;
    const executable = {
      get bytes(): Uint8Array {
        fieldAccesses += 1;
        throw new TypeError("hostile bytes getter executed");
      },
      mediaType: "application/octet-stream",
      schema,
    };
    await assert.rejects(value.write(executable), /bytes must be an enumerable data property/);
    assert.equal(fieldAccesses, 0);

    const extra = { bytes: new Uint8Array([1]), mediaType: "application/octet-stream", schema, extra: true };
    await assert.rejects(value.write(extra), /must contain exactly/);

    const symbolic = { bytes: new Uint8Array([1]), mediaType: "application/octet-stream", schema };
    Object.defineProperty(symbolic, Symbol("extra"), { enumerable: true, value: true });
    await assert.rejects(value.write(symbolic), /must contain exactly/);

    let proxyAccesses = 0;
    const proxied = new Proxy(
      { bytes: new Uint8Array([1]), mediaType: "application/octet-stream", schema },
      {
        get() {
          proxyAccesses += 1;
          throw new TypeError("hostile envelope proxy executed");
        },
      },
    );
    await assert.rejects(value.write(proxied), /exact data-property object/);
    assert.equal(proxyAccesses, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("observer sink rejects an artifact above the inline mirror cap before consulting its iterator", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aloha-observer-inline-cap-"));
  try {
    const value = sink(directory, "600000");
    const bytes = new Uint8Array(ARTIFACT_MIRROR_MAX_DECODED_BYTES + 1);
    let iteratorAccesses = 0;
    Object.defineProperty(bytes, Symbol.iterator, {
      configurable: true,
      get() {
        iteratorAccesses += 1;
        throw new TypeError("hostile iterator getter executed");
      },
    });
    await assert.rejects(
      value.write({
        bytes,
        mediaType: "application/octet-stream",
        schema,
      }),
      /inline mirror byte limit/,
    );
    assert.equal(iteratorAccesses, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("observer sink copies concrete bytes without consulting an own iterator", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aloha-observer-hostile-iterator-"));
  try {
    const bytes = new Uint8Array([4, 8, 15, 16, 23, 42]);
    let iteratorAccesses = 0;
    Object.defineProperty(bytes, Symbol.iterator, {
      configurable: true,
      get() {
        iteratorAccesses += 1;
        throw new TypeError("hostile iterator getter executed");
      },
    });
    const artifact = await sink(directory).write({
      bytes,
      mediaType: "application/octet-stream",
      schema,
    });
    assert.equal(iteratorAccesses, 0);
    assert.deepEqual(artifact.bytes, new Uint8Array([4, 8, 15, 16, 23, 42]));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("observer sink ignores shadowed length accessors and uses the intrinsic byte length", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aloha-observer-shadowed-length-"));
  try {
    const bytes = new Uint8Array([7, 11, 13]);
    let lengthAccesses = 0;
    Object.defineProperties(bytes, {
      length: {
        configurable: true,
        get() {
          lengthAccesses += 1;
          throw new TypeError("shadowed length getter executed");
        },
      },
      byteLength: {
        configurable: true,
        get() {
          lengthAccesses += 1;
          throw new TypeError("shadowed byteLength getter executed");
        },
      },
    });
    const artifact = await sink(directory).write({
      bytes,
      mediaType: "application/octet-stream",
      schema,
    });
    assert.equal(lengthAccesses, 0);
    assert.deepEqual(artifact.bytes, new Uint8Array([7, 11, 13]));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("observer sink rejects replacement of its physical store directory", async () => {
  const parent = await mkdtemp(join(tmpdir(), "aloha-observer-directory-fence-"));
  const directory = join(parent, "objects");
  const displaced = join(parent, "objects-displaced");
  try {
    const value = sink(directory);
    const artifact = await value.write({
      bytes: encodeCanonicalBytes({ observed: "directory-fence" }),
      mediaType: "application/json",
      schema,
    });
    await rename(directory, displaced);
    await mkdir(directory);
    await assert.rejects(value.readContent(artifact.contentSha256), /directory identity changed/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("observer sink binds one physical directory to one durable store identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aloha-observer-store-identity-"));
  try {
    const bytes = encodeCanonicalBytes({ observed: "store-identity" });
    const original = sink(directory, "10000", "release-a");
    const artifact = await original.write({ bytes, mediaType: "application/json", schema });
    const sameRelease = sink(directory, "10000", "release-a");
    assert.deepEqual(await sameRelease.readContent(artifact.contentSha256), bytes);
    const foreignRelease = sink(directory, "10000", "release-b");
    await assert.rejects(
      foreignRelease.readContent(artifact.contentSha256),
      /physical store identity mismatch/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("read-only snapshot sink reopens exact bytes without mutating or extending the store", async () => {
  const root = await mkdtemp(join(tmpdir(), "aloha-observer-snapshot-"));
  try {
    const writable = sink(root);
    const input = {
      bytes: new TextEncoder().encode("frozen-snapshot"),
      mediaType: "application/octet-stream",
      schema,
    };
    const artifact = await writable.write(input);
    const before = await stat(root, { bigint: true });
    const reopened = new ContentAddressedObserverSinkV1({
      directory: root,
      storeIdentityHash: writable.storeIdentityHash,
      resolverPolicy: writable.resolverPolicy,
      readOnly: true,
      lease: {
        validFromStoreEpoch: "1",
        validThroughStoreEpoch: "2",
        issuerId: "observer-sink-test",
        issuerQualificationId: h("qualification"),
        qualificationRegistryRoot: h("registry"),
      },
    });
    assert.deepEqual(await reopened.readContent(artifact.contentSha256), input.bytes);
    await assert.rejects(reopened.write(input), /read-only/);
    const after = await stat(root, { bigint: true });
    assert.equal(after.dev, before.dev);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeNs, before.mtimeNs);
    assert.equal(after.ctimeNs, before.ctimeNs);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
