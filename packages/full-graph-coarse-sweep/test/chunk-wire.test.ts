import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeCanonicalBytes,
  encodeCanonicalBytes,
  hashDomain,
  sha256Hex,
  type CanonicalJson,
  type Hash,
} from "../../canonical-codec/src/index.ts";
import { ARTIFACT_MIRROR_MAX_DECODED_BYTES } from "../../../specs/artifact-resolution/src/index.ts";
import {
  qualifiedCoarseProjectionReceiptRootV1,
  sealCoarseEdgeProjectionV1,
} from "../../coarse-economics/src/index.ts";
import {
  decodeFullGraphCoarseSweepV1,
  encodeFullGraphCoarseSweepV1,
  fullGraphTransitionSequenceRootV1,
  sealFullGraphCoarseSweepV1,
  type FullGraphCoarseSweepEntryV1,
  type FullGraphCoarseSweepEntryChunkRefV1,
  type FullGraphCoarseSweepV1,
} from "../src/index.ts";

const h = (value: string): Hash => hashDomain("test/full-graph-chunk-wire/v1", value);

function sweepFixture(count: number, label = "a", largeObservation = false): FullGraphCoarseSweepV1 {
  const source = Object.freeze({ chainId: "1", number: "50", hash: h(`${label}:head`), stateRoot: h(`${label}:state`) });
  const bindingBody = Object.freeze({
    runtimeBindingId: h(`${label}:binding`), releaseProvenanceHash: h(`${label}:release`),
    candidateReleaseCommit: "a".repeat(40), releaseMembershipRoot: h(`${label}:membership`),
    definitionCatalogRoot: h(`${label}:definitions`), familyCompositionRoot: h(`${label}:composition`),
    generationId: `generation:${label}`, readyRecordHash: h(`${label}:ready`), graphRoot: h(`${label}:graph`),
    readyCutoff: source, recentObservationRange: Object.freeze({ from: "1", to: "50", blockCount: "50" as const }),
    currentSourceSessionId: h(`${label}:source-session`), actualCurrentSource: source,
    amountSeedHash: h(`${label}:amount`), objectiveRef: h(`${label}:objective`),
  });
  const binding = Object.freeze({
    ...bindingBody,
    bindingRoot: hashDomain("aloha/full-graph-coarse-sweep-binding/v1", bindingBody),
  });
  const entries = Array.from({ length: count }, (_, index) => {
    const edgeId = h(`${label}:edge:${index.toString().padStart(8, "0")}`);
    const transitionRef = h(`${label}:transition:${index}`);
    const inputAssetRef = h(`${label}:input-asset:${index}`);
    const inputPortRef = h(`${label}:input-port:${index}`);
    const outputAssetRef = h(`${label}:output-asset:${index}`);
    const outputPortRef = h(`${label}:output-port:${index}`);
    const owningFamilyId = `family-${index % 3}`;
    const edge = Object.freeze({
      edgeId, opaqueTransitionRef: transitionRef, owningFamilyId,
      inputAssetPorts: Object.freeze([Object.freeze({ assetRef: inputAssetRef, portRef: inputPortRef })]),
      outputAssetPorts: Object.freeze([Object.freeze({ assetRef: outputAssetRef, portRef: outputPortRef })]),
    });
    const transitionId = hashDomain("aloha/full-graph-coarse-transition/v1", {
      edgeId, transitionRef, inputAssetRef, inputPortRef, outputAssetRef, outputPortRef, owningFamilyId,
    });
    const observed = largeObservation;
    const ownerDescriptor = Object.freeze({
      ownerRef: h(`${label}:owner:${index}`),
      capabilityId: "test/coarse-owner",
      capabilityVersion: "1",
      schemaRef: h(`${label}:owner-schema:${index}`),
      interpreterHash: h(`${label}:owner-interpreter:${index}`),
      implementationHash: h(`${label}:owner-implementation:${index}`),
      boundVerifierHash: h(`${label}:bound-verifier:${index}`),
    });
    const projection = sealCoarseEdgeProjectionV1({
      edgeId,
      transitionRef,
      routeBindingHash: h(`${label}:route-binding:${index}`),
      generationId: binding.generationId,
      graphRoot: binding.graphRoot,
      source,
      objectiveRef: binding.objectiveRef,
      ownerRef: ownerDescriptor.ownerRef,
      capabilityDigest: h(`${label}:capability:${index}`),
      dependencyRoot: h(`${label}:dependency:${index}`),
      stateFactsRoot: h(`${label}:state-facts:${index}`),
      sampleInput: Object.freeze({ assetRef: inputAssetRef, amount: "1" }),
      estimatedOutput: Object.freeze({ assetRef: outputAssetRef, amount: "2" }),
      conservativeOutputUpperBound: null,
      inputCapacityUpperBound: null,
      status: "rankable",
      reasonCode: null,
    });
    const receiptBody = Object.freeze({
      schemaVersion: 1 as const,
      kind: "aloha.qualified-coarse-projection-receipt-v1" as const,
      releaseProvenanceHash: binding.releaseProvenanceHash,
      releaseMembershipRoot: binding.releaseMembershipRoot,
      ownerQualificationLeafDigest: hashDomain("aloha/coarse-owner-qualification-leaf/v1", ownerDescriptor),
      ownerDescriptor,
      projection,
      boundVerification: null,
    });
    const receipt = Object.freeze({
      ...receiptBody,
      receiptRoot: qualifiedCoarseProjectionReceiptRootV1(receiptBody),
    });
    const entryBody = Object.freeze({
      bindingRoot: binding.bindingRoot,
      ordinal: String(index),
      transitionId,
      edge,
      inputAssetRef,
      inputPortRef,
      outputAssetRef,
      outputPortRef,
      status: observed ? "observed" as const : "missing" as const,
      missingReason: observed ? null : "coarse-owner-missing" as const,
      receipt: observed ? receipt : null,
      familyObservation: observed ? Object.freeze({
        a: "x".repeat(1_500), b: "x".repeat(1_500), c: "x".repeat(1_500), d: "x".repeat(1_500),
      }) : null,
    });
    return Object.freeze({
      ...entryBody,
      entryRoot: hashDomain("aloha/full-graph-coarse-sweep-entry/v1", entryBody as unknown as CanonicalJson),
    }) as unknown as FullGraphCoarseSweepEntryV1;
  }).sort((left, right) => {
    const leftKey = `${left.edge.edgeId}\u001f${left.edge.opaqueTransitionRef}\u001f${left.inputAssetRef}\u001f${left.inputPortRef}\u001f${left.outputAssetRef}\u001f${left.outputPortRef}`;
    const rightKey = `${right.edge.edgeId}\u001f${right.edge.opaqueTransitionRef}\u001f${right.inputAssetRef}\u001f${right.inputPortRef}\u001f${right.outputAssetRef}\u001f${right.outputPortRef}`;
    return leftKey.localeCompare(rightKey);
  }).map((entry, ordinal) => {
    const { entryRoot: _entryRoot, ...raw } = entry;
    const body = Object.freeze({ ...raw, ordinal: String(ordinal) });
    return Object.freeze({ ...body, entryRoot: hashDomain("aloha/full-graph-coarse-sweep-entry/v1", body as unknown as CanonicalJson) });
  }) as readonly FullGraphCoarseSweepEntryV1[];
  const expected = Object.freeze(entries.map(entry => entry.transitionId));
  const observed = Object.freeze(entries.filter(entry => entry.status === "observed").map(entry => entry.transitionId));
  const missing = Object.freeze(entries.filter(entry => entry.status === "missing").map(entry => entry.transitionId));
  const familyCounts = new Map<string, { expected: number; observed: number; missing: number }>();
  for (const entry of entries) {
    const value = familyCounts.get(entry.edge.owningFamilyId) ?? { expected: 0, observed: 0, missing: 0 };
    value.expected += 1;
    if (entry.status === "observed") value.observed += 1; else value.missing += 1;
    familyCounts.set(entry.edge.owningFamilyId, value);
  }
  return sealFullGraphCoarseSweepV1(Object.freeze({
    schemaVersion: 1, kind: "aloha.full-graph-coarse-sweep-v1", binding,
    expectedTransitionCount: String(expected.length), expectedTransitionIds: expected,
    expectedTransitionRoot: fullGraphTransitionSequenceRootV1("expected", expected),
    observedTransitionCount: String(observed.length), observedTransitionIds: observed,
    observedTransitionRoot: fullGraphTransitionSequenceRootV1("observed", observed),
    missingTransitionCount: String(missing.length), missingTransitionIds: missing,
    missingTransitionRoot: fullGraphTransitionSequenceRootV1("missing", missing),
    familyTransitionCounts: Object.freeze([...familyCounts.entries()].sort(([left], [right]) => left.localeCompare(right))
      .map(([familyId, value]) => Object.freeze({ familyId, expectedTransitionCount: String(value.expected), observedTransitionCount: String(value.observed), missingTransitionCount: String(value.missing) }))),
    entries: Object.freeze(entries),
  }));
}

function materialize(encoded: ReturnType<typeof encodeFullGraphCoarseSweepV1>): FullGraphCoarseSweepV1 {
  const chunks = new Map(encoded.chunks.map(chunk => [chunk.ref.contentSha256, chunk.bytes]));
  return decodeFullGraphCoarseSweepV1(encoded.manifestBytes, ref => {
    const bytes = chunks.get(ref.contentSha256);
    if (bytes === undefined) throw new TypeError("chunk missing from fixture");
    return bytes;
  });
}

function rerootEntry(
  entry: FullGraphCoarseSweepEntryV1,
  change: Partial<Omit<FullGraphCoarseSweepEntryV1, "entryRoot">>,
): FullGraphCoarseSweepEntryV1 {
  const { entryRoot: _entryRoot, ...current } = entry;
  const body = Object.freeze({ ...current, ...change });
  return Object.freeze({
    ...body,
    entryRoot: hashDomain("aloha/full-graph-coarse-sweep-entry/v1", body as unknown as CanonicalJson),
  }) as FullGraphCoarseSweepEntryV1;
}

function singletonChunkClosureRoot(ref: FullGraphCoarseSweepEntryChunkRefV1): Hash {
  const domain = "aloha/full-graph-coarse-sweep-entry-chunk-closure/v1";
  const treeRoot = hashDomain(`${domain}/node/v1`, {
    level: "0",
    firstOrdinal: "0",
    values: [ref],
  });
  return hashDomain(domain, { algorithm: "bounded-ordered-tree-v1", count: "1", treeRoot });
}

/** Reissues every local wire hash after an entry mutation. These fixtures
 * prove the public decoder checks entry semantics rather than trusting a
 * self-consistent chunk/manifest envelope. */
function decodeRerootedEntries(
  sweep: FullGraphCoarseSweepV1,
  entries: readonly FullGraphCoarseSweepEntryV1[],
): FullGraphCoarseSweepV1 {
  const encoded = encodeFullGraphCoarseSweepV1(sweep);
  assert.equal(encoded.chunks.length, 1);
  const chunkBody = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.full-graph-coarse-sweep-entry-chunk-v1" as const,
    bindingRoot: sweep.binding.bindingRoot,
    chunkOrdinal: "0",
    firstEntryOrdinal: "0",
    entries: Object.freeze([...entries]),
    nextEntryChunkRef: null,
  });
  const chunk = Object.freeze({
    ...chunkBody,
    chunkRoot: hashDomain("aloha/full-graph-coarse-sweep-entry-chunk/v1", chunkBody as unknown as CanonicalJson),
  });
  const bytes = encodeCanonicalBytes(chunk as unknown as CanonicalJson);
  const ref = Object.freeze({
    chunkOrdinal: "0",
    firstEntryOrdinal: "0",
    entryCount: String(entries.length),
    contentSha256: sha256Hex(bytes),
    byteLength: String(bytes.byteLength),
    chunkRoot: chunk.chunkRoot,
  });
  const expected = Object.freeze(entries.map(entry => entry.transitionId));
  const observed = Object.freeze(entries.filter(entry => entry.status === "observed").map(entry => entry.transitionId));
  const missing = Object.freeze(entries.filter(entry => entry.status === "missing").map(entry => entry.transitionId));
  const familyCounts = new Map<string, { expected: number; observed: number; missing: number }>();
  for (const entry of entries) {
    const counts = familyCounts.get(entry.edge.owningFamilyId) ?? { expected: 0, observed: 0, missing: 0 };
    counts.expected += 1;
    if (entry.status === "observed") counts.observed += 1;
    else counts.missing += 1;
    familyCounts.set(entry.edge.owningFamilyId, counts);
  }
  const manifestBody = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.full-graph-coarse-sweep-manifest-v1" as const,
    binding: sweep.binding,
    expectedTransitionCount: String(expected.length),
    expectedTransitionRoot: fullGraphTransitionSequenceRootV1("expected", expected),
    observedTransitionCount: String(observed.length),
    observedTransitionRoot: fullGraphTransitionSequenceRootV1("observed", observed),
    missingTransitionCount: String(missing.length),
    missingTransitionRoot: fullGraphTransitionSequenceRootV1("missing", missing),
    familyTransitionCounts: Object.freeze([...familyCounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([familyId, counts]) => Object.freeze({
        familyId,
        expectedTransitionCount: String(counts.expected),
        observedTransitionCount: String(counts.observed),
        missingTransitionCount: String(counts.missing),
      }))),
    entryChunkCount: "1",
    entryCount: String(entries.length),
    firstEntryChunkRef: ref,
    entryChunkClosureRoot: singletonChunkClosureRoot(ref),
  });
  const manifest = Object.freeze({
    ...manifestBody,
    sweepRoot: hashDomain("aloha/full-graph-coarse-sweep-manifest/v1", manifestBody as unknown as CanonicalJson),
  });
  return decodeFullGraphCoarseSweepV1(encodeCanonicalBytes(manifest as unknown as CanonicalJson), () => bytes);
}

test("bounded linked chunks round-trip a high-cardinality denominator without one unbounded manifest array", () => {
  const sweep = sweepFixture(30_000);
  const encoded = encodeFullGraphCoarseSweepV1(sweep);
  assert.ok(encoded.chunks.length > 1);
  assert.equal("entryChunks" in encoded.manifest, false);
  assert.equal(encoded.manifest.entryCount, "30000");
  assert.ok(encoded.manifestBytes.byteLength <= ARTIFACT_MIRROR_MAX_DECODED_BYTES);
  assert.ok(encoded.chunks.every(chunk => chunk.bytes.byteLength <= ARTIFACT_MIRROR_MAX_DECODED_BYTES));
  assert.deepEqual(materialize(encoded), sweep);
});

test("chunk partition is byte bounded in addition to entry-count bounded", () => {
  const encoded = encodeFullGraphCoarseSweepV1(sweepFixture(100, "byte-bounded", true));
  assert.ok(encoded.chunks.length > 1);
  assert.ok(encoded.chunks.every(chunk => chunk.bytes.byteLength <= ARTIFACT_MIRROR_MAX_DECODED_BYTES));
});

test("missing, reordered, duplicated, or cross-snapshot chunk bytes fail closed", () => {
  const left = encodeFullGraphCoarseSweepV1(sweepFixture(300, "left"));
  const right = encodeFullGraphCoarseSweepV1(sweepFixture(300, "right"));
  const byHash = new Map(left.chunks.map(chunk => [chunk.ref.contentSha256, chunk.bytes]));
  const first = left.manifest.firstEntryChunkRef!;
  assert.throws(() => decodeFullGraphCoarseSweepV1(left.manifestBytes, ref => {
    if (ref.contentSha256 === first.contentSha256) throw new TypeError("missing");
    return byHash.get(ref.contentSha256)!;
  }), /missing/);
  assert.throws(() => decodeFullGraphCoarseSweepV1(left.manifestBytes, ref => (
    ref.contentSha256 === first.contentSha256 ? left.chunks[1]!.bytes : byHash.get(ref.contentSha256)!
  )), /content mismatch/);
  assert.throws(() => decodeFullGraphCoarseSweepV1(left.manifestBytes, ref => (
    ref.contentSha256 === first.contentSha256 ? right.chunks[0]!.bytes : byHash.get(ref.contentSha256)!
  )), /content mismatch/);
});

test("self-consistent manifest first-ref splice cannot cross a snapshot binding", () => {
  const left = encodeFullGraphCoarseSweepV1(sweepFixture(300, "splice-left"));
  const right = encodeFullGraphCoarseSweepV1(sweepFixture(300, "splice-right"));
  const raw = decodeCanonicalBytes(left.manifestBytes) as Readonly<Record<string, CanonicalJson>>;
  const { sweepRoot: _sweepRoot, ...body } = raw;
  const changedBody = Object.freeze({ ...body, firstEntryChunkRef: right.manifest.firstEntryChunkRef as unknown as CanonicalJson });
  const changed = Object.freeze({
    ...changedBody,
    sweepRoot: hashDomain("aloha/full-graph-coarse-sweep-manifest/v1", changedBody),
  });
  const rightChunks = new Map(right.chunks.map(chunk => [chunk.ref.contentSha256, chunk.bytes]));
  assert.throws(() => decodeFullGraphCoarseSweepV1(encodeCanonicalBytes(changed), ref => rightChunks.get(ref.contentSha256)!), /binding mismatch|closure mismatch/);
});

test("duplicate and reordered transition denominators are rejected before publication", () => {
  const sweep = sweepFixture(3);
  const { sweepRoot: _root, ...body } = sweep;
  assert.throws(() => sealFullGraphCoarseSweepV1({ ...body, entries: Object.freeze([sweep.entries[0]!, sweep.entries[0]!, sweep.entries[2]!]) }), /identity\/status closure|entry root|count\/root/);
  assert.throws(() => sealFullGraphCoarseSweepV1({ ...body, entries: Object.freeze([...sweep.entries].reverse()) }), /identity\/status closure|entry root/);
});

test("decoder rejects missing, duplicated, and reordered transitions after every wire root is reissued", () => {
  const sweep = sweepFixture(3, "semantic-transition-mutations");
  assert.throws(
    () => decodeRerootedEntries(sweep, Object.freeze([sweep.entries[0]!, sweep.entries[2]!])),
    /entry identity\/status closure mismatch/,
  );
  assert.throws(
    () => decodeRerootedEntries(sweep, Object.freeze([
      sweep.entries[0]!,
      rerootEntry(sweep.entries[0]!, { ordinal: "1" }),
      sweep.entries[2]!,
    ])),
    /entry identity\/status closure mismatch/,
  );
  assert.throws(
    () => decodeRerootedEntries(sweep, Object.freeze([...sweep.entries].reverse()
      .map((entry, ordinal) => rerootEntry(entry, { ordinal: String(ordinal) })))),
    /entry identity\/status closure mismatch/,
  );
});

test("decoder rejects direction, ordinal, and sidecar mutations with self-consistent entry and wire roots", () => {
  const sweep = sweepFixture(1, "semantic-entry-mutations");
  const entry = sweep.entries[0]!;
  const reversedTransition = Object.freeze({
    edgeId: entry.edge.edgeId,
    transitionRef: entry.edge.opaqueTransitionRef,
    inputAssetRef: entry.outputAssetRef,
    inputPortRef: entry.outputPortRef,
    outputAssetRef: entry.inputAssetRef,
    outputPortRef: entry.inputPortRef,
    owningFamilyId: entry.edge.owningFamilyId,
  });
  assert.throws(
    () => decodeRerootedEntries(sweep, Object.freeze([rerootEntry(entry, {
      transitionId: hashDomain("aloha/full-graph-coarse-transition/v1", reversedTransition),
      inputAssetRef: entry.outputAssetRef,
      inputPortRef: entry.outputPortRef,
      outputAssetRef: entry.inputAssetRef,
      outputPortRef: entry.inputPortRef,
    })])),
    /entry identity\/status closure mismatch/,
  );
  assert.throws(
    () => decodeRerootedEntries(sweep, Object.freeze([rerootEntry(entry, { ordinal: "1" })])),
    /entry identity\/status closure mismatch/,
  );
  assert.throws(
    () => decodeRerootedEntries(sweep, Object.freeze([rerootEntry(entry, {
      status: "observed",
      missingReason: "coarse-owner-missing",
    })])),
    /entry identity\/status closure mismatch/,
  );
});

test("one over-cap entry fails closed instead of creating an oversized observer artifact", () => {
  const sweep = sweepFixture(1, "oversized", true);
  const entry = sweep.entries[0]!;
  const { entryRoot: _entryRoot, ...raw } = entry;
  const body = Object.freeze({
    ...raw,
    familyObservation: Object.freeze({
      a: "x".repeat(120_000), b: "x".repeat(120_000), c: "x".repeat(120_000),
      d: "x".repeat(120_000), e: "x".repeat(120_000),
    }),
  });
  const oversized = Object.freeze({
    ...body,
    entryRoot: hashDomain("aloha/full-graph-coarse-sweep-entry/v1", body as unknown as CanonicalJson),
  }) as unknown as FullGraphCoarseSweepEntryV1;
  const { sweepRoot: _root, ...sweepBody } = sweep;
  assert.throws(() => sealFullGraphCoarseSweepV1({ ...sweepBody, entries: Object.freeze([oversized]) }), /observer artifact byte cap/);
});
