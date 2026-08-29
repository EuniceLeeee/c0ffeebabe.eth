import {
  assertDecimalString,
  assertExactKeys,
  assertHash,
  assertNonEmptyString,
  assertPlainObject,
  decodeCanonicalBytes,
  encodeCanonicalBytes,
  hashDomain,
  sha256Hex,
  type CanonicalJson,
  type Hash,
} from "../../canonical-codec/src/index.ts";
import {
  decodeQualifiedCoarseProjectionReceiptV1,
  type QualifiedCoarseProjectionReceiptV1,
} from "../../coarse-economics/src/index.ts";
import type { PersistedGraphEdgeV1 } from "../../graph/src/index.ts";
import type { CanonicalCutoffV1 } from "../../discovery/src/index.ts";
import { ARTIFACT_MIRROR_MAX_DECODED_BYTES } from "../../../specs/artifact-resolution/src/index.ts";

/** Process-local invocation issued from one real Startup/Reth producer
 * session. It contains no enumerable DTO fields and is consumed once. */
export type FullGraphCoarseSweepInvocationCapabilityV1 = object;

/** Release-owned result. Only the runtime-release consumer may decode it. */
export type FullGraphCoarseSweepCapabilityV1 = object;

/** Opaque current-source read authority issued by the candidate-owned Reth
 * source for this acceptance-only sweep. */
export type FullGraphCoarseSweepSourceReadCapabilityV1 = object;

export interface FullGraphCoarseSweepBindingV1 {
  readonly runtimeBindingId: Hash;
  readonly releaseProvenanceHash: Hash;
  readonly candidateReleaseCommit: string;
  readonly releaseMembershipRoot: Hash;
  readonly definitionCatalogRoot: Hash;
  readonly familyCompositionRoot: Hash;
  readonly generationId: string;
  readonly readyRecordHash: Hash;
  readonly graphRoot: Hash;
  readonly readyCutoff: CanonicalCutoffV1;
  readonly recentObservationRange: Readonly<{ readonly from: string; readonly to: string; readonly blockCount: "50" }>;
  readonly currentSourceSessionId: Hash;
  readonly actualCurrentSource: CanonicalCutoffV1;
  readonly amountSeedHash: Hash;
  readonly objectiveRef: Hash;
  readonly bindingRoot: Hash;
}

export interface FullGraphCoarseSweepEntryV1 {
  readonly bindingRoot: Hash;
  readonly ordinal: string;
  readonly transitionId: Hash;
  readonly edge: PersistedGraphEdgeV1;
  readonly inputAssetRef: Hash;
  readonly inputPortRef: Hash;
  readonly outputAssetRef: Hash;
  readonly outputPortRef: Hash;
  readonly status: "observed" | "missing";
  readonly missingReason: "coarse-owner-missing" | null;
  readonly receipt: QualifiedCoarseProjectionReceiptV1 | null;
  readonly familyObservation: CanonicalJson | null;
  readonly entryRoot: Hash;
}

export interface FullGraphCoarseSweepFamilyTransitionCountV1 {
  readonly familyId: string;
  readonly expectedTransitionCount: string;
  readonly observedTransitionCount: string;
  readonly missingTransitionCount: string;
}

export interface FullGraphCoarseSweepV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.full-graph-coarse-sweep-v1";
  readonly binding: FullGraphCoarseSweepBindingV1;
  readonly expectedTransitionCount: string;
  readonly expectedTransitionIds: readonly Hash[];
  readonly expectedTransitionRoot: Hash;
  readonly observedTransitionCount: string;
  readonly observedTransitionIds: readonly Hash[];
  readonly observedTransitionRoot: Hash;
  readonly missingTransitionCount: string;
  readonly missingTransitionIds: readonly Hash[];
  readonly missingTransitionRoot: Hash;
  readonly familyTransitionCounts: readonly FullGraphCoarseSweepFamilyTransitionCountV1[];
  readonly entries: readonly FullGraphCoarseSweepEntryV1[];
  readonly sweepRoot: Hash;
}

export interface FullGraphCoarseSweepEntryChunkV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.full-graph-coarse-sweep-entry-chunk-v1";
  readonly bindingRoot: Hash;
  readonly chunkOrdinal: string;
  readonly firstEntryOrdinal: string;
  readonly entries: readonly FullGraphCoarseSweepEntryV1[];
  readonly nextEntryChunkRef: FullGraphCoarseSweepEntryChunkRefV1 | null;
  readonly chunkRoot: Hash;
}

export interface FullGraphCoarseSweepEntryChunkRefV1 {
  readonly chunkOrdinal: string;
  readonly firstEntryOrdinal: string;
  readonly entryCount: string;
  readonly contentSha256: Hash;
  readonly byteLength: string;
  readonly chunkRoot: Hash;
}

/** Bounded wire manifest. The complete transition denominator is carried by
 * content-addressed chunks; no high-cardinality ID or entry array is embedded
 * in this object. */
export interface FullGraphCoarseSweepManifestV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.full-graph-coarse-sweep-manifest-v1";
  readonly binding: FullGraphCoarseSweepBindingV1;
  readonly expectedTransitionCount: string;
  readonly expectedTransitionRoot: Hash;
  readonly observedTransitionCount: string;
  readonly observedTransitionRoot: Hash;
  readonly missingTransitionCount: string;
  readonly missingTransitionRoot: Hash;
  readonly familyTransitionCounts: readonly FullGraphCoarseSweepFamilyTransitionCountV1[];
  readonly entryChunkCount: string;
  readonly entryCount: string;
  readonly firstEntryChunkRef: FullGraphCoarseSweepEntryChunkRefV1 | null;
  readonly entryChunkClosureRoot: Hash;
  readonly sweepRoot: Hash;
}

export interface EncodedFullGraphCoarseSweepV1 {
  readonly manifest: FullGraphCoarseSweepManifestV1;
  readonly manifestBytes: Uint8Array;
  readonly chunks: readonly Readonly<{
    readonly ref: FullGraphCoarseSweepEntryChunkRefV1;
    readonly chunk: FullGraphCoarseSweepEntryChunkV1;
    readonly bytes: Uint8Array;
  }>[];
}

const TRANSITION_ROOT_DOMAINS = Object.freeze({
  expected: "aloha/full-graph-coarse-sweep-expected-transitions/v1",
  observed: "aloha/full-graph-coarse-sweep-observed-transitions/v1",
  missing: "aloha/full-graph-coarse-sweep-missing-transitions/v1",
} as const);
const HASH_TREE_FANOUT = 128;
const ENTRY_CHUNK_MAX_ITEMS = 128;

function boundedSequenceRoot(domain: string, values: readonly CanonicalJson[]): Hash {
  let level = values.length === 0
    ? [hashDomain(`${domain}/node/v1`, { level: "0", firstOrdinal: "0", values: [] })]
    : Array.from({ length: Math.ceil(values.length / HASH_TREE_FANOUT) }, (_, index) => {
      const first = index * HASH_TREE_FANOUT;
      return hashDomain(`${domain}/node/v1`, {
        level: "0",
        firstOrdinal: String(first),
        values: values.slice(first, first + HASH_TREE_FANOUT),
      });
    });
  let depth = 1;
  while (level.length > 1) {
    const previous = level;
    level = Array.from({ length: Math.ceil(previous.length / HASH_TREE_FANOUT) }, (_, index) => {
      const first = index * HASH_TREE_FANOUT;
      return hashDomain(`${domain}/node/v1`, {
        level: String(depth),
        firstOrdinal: String(first),
        values: previous.slice(first, first + HASH_TREE_FANOUT),
      });
    });
    depth += 1;
  }
  return hashDomain(domain, {
    algorithm: "bounded-ordered-tree-v1",
    count: String(values.length),
    treeRoot: level[0]!,
  });
}

export function fullGraphTransitionSequenceRootV1(
  purpose: keyof typeof TRANSITION_ROOT_DOMAINS,
  transitionIds: readonly Hash[],
): Hash {
  for (const [index, id] of transitionIds.entries()) assertHash(id, `transitionIds[${index}]`);
  return boundedSequenceRoot(TRANSITION_ROOT_DOMAINS[purpose], transitionIds);
}

function entryChunkClosureRoot(refs: readonly FullGraphCoarseSweepEntryChunkRefV1[]): Hash {
  return boundedSequenceRoot(
    "aloha/full-graph-coarse-sweep-entry-chunk-closure/v1",
    refs as unknown as readonly CanonicalJson[],
  );
}

function buildChunk(
  bindingRoot: Hash,
  chunkOrdinal: number,
  firstEntryOrdinal: number,
  entries: readonly FullGraphCoarseSweepEntryV1[],
  nextEntryChunkRef: FullGraphCoarseSweepEntryChunkRefV1 | null,
): Readonly<{ chunk: FullGraphCoarseSweepEntryChunkV1; bytes: Uint8Array; ref: FullGraphCoarseSweepEntryChunkRefV1 }> {
  const body = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.full-graph-coarse-sweep-entry-chunk-v1" as const,
    bindingRoot,
    chunkOrdinal: String(chunkOrdinal),
    firstEntryOrdinal: String(firstEntryOrdinal),
    entries: Object.freeze([...entries]),
    nextEntryChunkRef,
  });
  const chunk = Object.freeze({
    ...body,
    chunkRoot: hashDomain("aloha/full-graph-coarse-sweep-entry-chunk/v1", body as unknown as CanonicalJson),
  });
  const bytes = encodeCanonicalBytes(chunk as unknown as CanonicalJson);
  if (bytes.byteLength > ARTIFACT_MIRROR_MAX_DECODED_BYTES) {
    throw new TypeError("full-Graph sweep entry chunk exceeds observer artifact byte cap");
  }
  return Object.freeze({
    chunk,
    bytes,
    ref: Object.freeze({
      chunkOrdinal: String(chunkOrdinal),
      firstEntryOrdinal: String(firstEntryOrdinal),
      entryCount: String(entries.length),
      contentSha256: sha256Hex(bytes),
      byteLength: String(bytes.byteLength),
      chunkRoot: chunk.chunkRoot,
    }),
  });
}

function encodeChunks(
  bindingRoot: Hash,
  entries: readonly FullGraphCoarseSweepEntryV1[],
): EncodedFullGraphCoarseSweepV1["chunks"] {
  const groups: Array<readonly FullGraphCoarseSweepEntryV1[]> = Array.from(
    { length: Math.ceil(entries.length / ENTRY_CHUNK_MAX_ITEMS) },
    (_, index) => entries.slice(index * ENTRY_CHUNK_MAX_ITEMS, (index + 1) * ENTRY_CHUNK_MAX_ITEMS),
  );
  for (;;) {
    const output: Array<EncodedFullGraphCoarseSweepV1["chunks"][number]> = new Array(groups.length);
    let nextRef: FullGraphCoarseSweepEntryChunkRefV1 | null = null;
    let failedIndex = -1;
    for (let index = groups.length - 1; index >= 0; index -= 1) {
      const group = groups[index]!;
      const firstEntryOrdinal = groups.slice(0, index).reduce((sum, value) => sum + value.length, 0);
      try {
        const encoded = buildChunk(bindingRoot, index, firstEntryOrdinal, group, nextRef);
        output[index] = encoded;
        nextRef = encoded.ref;
      } catch {
        failedIndex = index;
        break;
      }
    }
    if (failedIndex === -1) return Object.freeze(output);
    const failed = groups[failedIndex]!;
    if (failed.length <= 1) {
      // Re-run once to preserve the canonical codec's exact failure.
      buildChunk(bindingRoot, failedIndex, 0, failed, null);
      throw new TypeError("unreachable full-Graph chunk encoding failure");
    }
    const middle = Math.ceil(failed.length / 2);
    groups.splice(failedIndex, 1, failed.slice(0, middle), failed.slice(middle));
  }
}

function assertSweepBodyClosure(body: Omit<FullGraphCoarseSweepV1, "sweepRoot">): void {
  exactBinding(body.binding);
  if (body.schemaVersion !== 1 || body.kind !== "aloha.full-graph-coarse-sweep-v1"
    || !Array.isArray(body.entries) || !Array.isArray(body.expectedTransitionIds)
    || !Array.isArray(body.observedTransitionIds) || !Array.isArray(body.missingTransitionIds)
    || !Array.isArray(body.familyTransitionCounts)) {
    throw new TypeError("full-Graph sweep materialized body shape is invalid");
  }
  const seen = new Set<Hash>();
  let previousTransitionKey: string | null = null;
  for (const [index, entry] of body.entries.entries()) {
    assertExactKeys(entry, [
      "bindingRoot", "ordinal", "transitionId", "edge", "inputAssetRef", "inputPortRef",
      "outputAssetRef", "outputPortRef", "status", "missingReason", "receipt", "familyObservation", "entryRoot",
    ], `fullGraphSweep.entries[${index}]`);
    const decodedEntry = entry as unknown as FullGraphCoarseSweepEntryV1;
    for (const key of ["bindingRoot", "transitionId", "inputAssetRef", "inputPortRef", "outputAssetRef", "outputPortRef", "entryRoot"] as const) {
      assertHash(entry[key], `fullGraphSweep.entries[${index}].${key}`);
    }
    const transitionId = assertHash(entry.transitionId, `fullGraphSweep.entries[${index}].transitionId`);
    const transitionPayload = Object.freeze({
      edgeId: decodedEntry.edge.edgeId,
      transitionRef: decodedEntry.edge.opaqueTransitionRef,
      inputAssetRef: entry.inputAssetRef,
      inputPortRef: entry.inputPortRef,
      outputAssetRef: entry.outputAssetRef,
      outputPortRef: entry.outputPortRef,
      owningFamilyId: decodedEntry.edge.owningFamilyId,
    });
    const transitionKey = `${decodedEntry.edge.edgeId}\u001f${decodedEntry.edge.opaqueTransitionRef}\u001f${entry.inputAssetRef}\u001f${entry.inputPortRef}\u001f${entry.outputAssetRef}\u001f${entry.outputPortRef}`;
    if (entry.bindingRoot !== body.binding.bindingRoot || entry.ordinal !== String(index)
      || transitionId !== hashDomain("aloha/full-graph-coarse-transition/v1", transitionPayload)
      || !decodedEntry.edge.inputAssetPorts.some(port => port.assetRef === entry.inputAssetRef && port.portRef === entry.inputPortRef)
      || !decodedEntry.edge.outputAssetPorts.some(port => port.assetRef === entry.outputAssetRef && port.portRef === entry.outputPortRef)
      || seen.has(transitionId) || (previousTransitionKey !== null && previousTransitionKey >= transitionKey)
      || (entry.status !== "observed" && entry.status !== "missing")
      || (entry.status === "observed" && (entry.missingReason !== null || entry.receipt === null || entry.familyObservation === null))
      || (entry.status === "missing" && (entry.missingReason !== "coarse-owner-missing" || entry.receipt !== null || entry.familyObservation !== null))) {
      throw new TypeError("full-Graph sweep entry identity/status closure mismatch");
    }
    if (entry.status === "observed") {
      const receipt = decodeQualifiedCoarseProjectionReceiptV1(
        entry.receipt,
        `fullGraphSweep.entries[${index}].receipt`,
      );
      const projection = receipt.projection;
      const source = body.binding.actualCurrentSource;
      if (receipt.releaseProvenanceHash !== body.binding.releaseProvenanceHash
        || receipt.releaseMembershipRoot !== body.binding.releaseMembershipRoot
        || projection.edgeId !== decodedEntry.edge.edgeId
        || projection.transitionRef !== decodedEntry.edge.opaqueTransitionRef
        || projection.generationId !== body.binding.generationId
        || projection.graphRoot !== body.binding.graphRoot
        || projection.source.chainId !== source.chainId
        || projection.source.number !== source.number
        || projection.source.hash !== source.hash
        || projection.source.stateRoot !== source.stateRoot
        || projection.objectiveRef !== body.binding.objectiveRef
        || projection.sampleInput.assetRef !== entry.inputAssetRef
        || (projection.status === "rankable"
          && (projection.estimatedOutput === null || projection.estimatedOutput.assetRef !== entry.outputAssetRef))
        || (projection.status === "unavailable" && projection.estimatedOutput !== null)) {
        throw new TypeError("full-Graph sweep qualified receipt/transition splice");
      }
    }
    seen.add(transitionId);
    previousTransitionKey = transitionKey;
    const { entryRoot, ...entryBody } = entry;
    if (entryRoot !== hashDomain("aloha/full-graph-coarse-sweep-entry/v1", entryBody as unknown as CanonicalJson)) {
      throw new TypeError("full-Graph sweep entry root mismatch");
    }
  }
  const expectedIds = body.entries.map(entry => entry.transitionId);
  const observedIds = body.entries.filter(entry => entry.status === "observed").map(entry => entry.transitionId);
  const missingIds = body.entries.filter(entry => entry.status === "missing").map(entry => entry.transitionId);
  const sameIds = (left: readonly Hash[], right: readonly Hash[]) => left.length === right.length
    && left.every((value, index) => value === right[index]);
  if (body.expectedTransitionCount !== String(expectedIds.length)
    || body.observedTransitionCount !== String(observedIds.length)
    || body.missingTransitionCount !== String(missingIds.length)
    || !sameIds(body.expectedTransitionIds, expectedIds)
    || !sameIds(body.observedTransitionIds, observedIds)
    || !sameIds(body.missingTransitionIds, missingIds)
    || body.expectedTransitionRoot !== fullGraphTransitionSequenceRootV1("expected", expectedIds)
    || body.observedTransitionRoot !== fullGraphTransitionSequenceRootV1("observed", observedIds)
    || body.missingTransitionRoot !== fullGraphTransitionSequenceRootV1("missing", missingIds)) {
    throw new TypeError("full-Graph sweep transition count/root closure mismatch");
  }
  const familyCounts = new Map<string, { expected: number; observed: number; missing: number }>();
  for (const entry of body.entries) {
    const current = familyCounts.get(entry.edge.owningFamilyId) ?? { expected: 0, observed: 0, missing: 0 };
    current.expected += 1;
    if (entry.status === "observed") current.observed += 1;
    else current.missing += 1;
    familyCounts.set(entry.edge.owningFamilyId, current);
  }
  const expectedFamilyCounts = [...familyCounts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([familyId, counts]) => Object.freeze({
      familyId,
      expectedTransitionCount: String(counts.expected),
      observedTransitionCount: String(counts.observed),
      missingTransitionCount: String(counts.missing),
    }));
  if (body.familyTransitionCounts.length !== expectedFamilyCounts.length
    || body.familyTransitionCounts.some((value, index) => {
      const expected = expectedFamilyCounts[index];
      return expected === undefined || value.familyId !== expected.familyId
        || value.expectedTransitionCount !== expected.expectedTransitionCount
        || value.observedTransitionCount !== expected.observedTransitionCount
        || value.missingTransitionCount !== expected.missingTransitionCount;
    })) {
    throw new TypeError("full-Graph sweep Family count closure mismatch");
  }
}

function encodeBody(
  body: Omit<FullGraphCoarseSweepV1, "sweepRoot">,
): EncodedFullGraphCoarseSweepV1 {
  assertSweepBodyClosure(body);
  const chunks = encodeChunks(body.binding.bindingRoot, body.entries);
  const refs = Object.freeze(chunks.map(value => value.ref));
  const manifestBody = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.full-graph-coarse-sweep-manifest-v1" as const,
    binding: body.binding,
    expectedTransitionCount: body.expectedTransitionCount,
    expectedTransitionRoot: body.expectedTransitionRoot,
    observedTransitionCount: body.observedTransitionCount,
    observedTransitionRoot: body.observedTransitionRoot,
    missingTransitionCount: body.missingTransitionCount,
    missingTransitionRoot: body.missingTransitionRoot,
    familyTransitionCounts: body.familyTransitionCounts,
    entryChunkCount: String(refs.length),
    entryCount: String(body.entries.length),
    firstEntryChunkRef: refs[0] ?? null,
    entryChunkClosureRoot: entryChunkClosureRoot(refs),
  });
  const manifest = Object.freeze({
    ...manifestBody,
    sweepRoot: hashDomain("aloha/full-graph-coarse-sweep-manifest/v1", manifestBody as unknown as CanonicalJson),
  });
  const manifestBytes = encodeCanonicalBytes(manifest as unknown as CanonicalJson);
  if (manifestBytes.byteLength > ARTIFACT_MIRROR_MAX_DECODED_BYTES) {
    throw new TypeError("full-Graph sweep manifest exceeds observer artifact byte cap");
  }
  return Object.freeze({
    manifest,
    manifestBytes,
    chunks,
  });
}

export function sealFullGraphCoarseSweepV1(
  body: Omit<FullGraphCoarseSweepV1, "sweepRoot">,
): FullGraphCoarseSweepV1 {
  const encoded = encodeBody(body);
  return Object.freeze({ ...body, sweepRoot: encoded.manifest.sweepRoot });
}

export function encodeFullGraphCoarseSweepV1(sweep: FullGraphCoarseSweepV1): EncodedFullGraphCoarseSweepV1 {
  const { sweepRoot, ...body } = sweep;
  const encoded = encodeBody(body);
  if (encoded.manifest.sweepRoot !== sweepRoot) throw new TypeError("full-Graph sweep manifest root mismatch");
  return encoded;
}

function exactChunkRef(value: FullGraphCoarseSweepEntryChunkRefV1, path: string): void {
  assertExactKeys(value, ["chunkOrdinal", "firstEntryOrdinal", "entryCount", "contentSha256", "byteLength", "chunkRoot"], path);
  assertDecimalString(value.chunkOrdinal, `${path}.chunkOrdinal`);
  assertDecimalString(value.firstEntryOrdinal, `${path}.firstEntryOrdinal`);
  assertDecimalString(value.entryCount, `${path}.entryCount`);
  assertDecimalString(value.byteLength, `${path}.byteLength`);
  assertHash(value.contentSha256, `${path}.contentSha256`);
  assertHash(value.chunkRoot, `${path}.chunkRoot`);
  if (BigInt(value.byteLength) > BigInt(ARTIFACT_MIRROR_MAX_DECODED_BYTES)) {
    throw new TypeError(`${path}.byteLength exceeds observer artifact cap`);
  }
}

function exactCutoff(value: unknown, path: string): void {
  assertPlainObject(value, path);
  assertExactKeys(value, ["chainId", "number", "hash", "stateRoot"], path);
  const cutoff = value as unknown as FullGraphCoarseSweepBindingV1["readyCutoff"];
  assertNonEmptyString(cutoff.chainId, `${path}.chainId`);
  assertDecimalString(cutoff.number, `${path}.number`);
  assertHash(cutoff.hash, `${path}.hash`);
  assertHash(cutoff.stateRoot, `${path}.stateRoot`);
}

function exactBinding(value: FullGraphCoarseSweepBindingV1): void {
  assertPlainObject(value, "fullGraphSweepManifest.binding");
  assertExactKeys(value, [
    "runtimeBindingId", "releaseProvenanceHash", "candidateReleaseCommit", "releaseMembershipRoot",
    "definitionCatalogRoot", "familyCompositionRoot", "generationId", "readyRecordHash", "graphRoot",
    "readyCutoff", "recentObservationRange", "currentSourceSessionId", "actualCurrentSource",
    "amountSeedHash", "objectiveRef", "bindingRoot",
  ], "fullGraphSweepManifest.binding");
  for (const key of [
    "runtimeBindingId", "releaseProvenanceHash", "releaseMembershipRoot", "definitionCatalogRoot",
    "familyCompositionRoot", "readyRecordHash", "graphRoot", "currentSourceSessionId", "amountSeedHash",
    "objectiveRef", "bindingRoot",
  ] as const) assertHash(value[key], `fullGraphSweepManifest.binding.${key}`);
  if (!/^[0-9a-f]{40}$/.test(value.candidateReleaseCommit)) throw new TypeError("fullGraphSweepManifest binding candidate commit is invalid");
  assertNonEmptyString(value.generationId, "fullGraphSweepManifest.binding.generationId");
  exactCutoff(value.readyCutoff, "fullGraphSweepManifest.binding.readyCutoff");
  exactCutoff(value.actualCurrentSource, "fullGraphSweepManifest.binding.actualCurrentSource");
  assertPlainObject(value.recentObservationRange, "fullGraphSweepManifest.binding.recentObservationRange");
  assertExactKeys(value.recentObservationRange, ["from", "to", "blockCount"], "fullGraphSweepManifest.binding.recentObservationRange");
  assertDecimalString(value.recentObservationRange.from, "fullGraphSweepManifest.binding.recentObservationRange.from");
  assertDecimalString(value.recentObservationRange.to, "fullGraphSweepManifest.binding.recentObservationRange.to");
  if (value.recentObservationRange.blockCount !== "50"
    || BigInt(value.recentObservationRange.to) < BigInt(value.recentObservationRange.from)
    || BigInt(value.recentObservationRange.to) - BigInt(value.recentObservationRange.from) + 1n !== 50n) {
    throw new TypeError("fullGraphSweepManifest binding range is not an exact 50-block window");
  }
  const { bindingRoot, ...body } = value;
  if (bindingRoot !== hashDomain("aloha/full-graph-coarse-sweep-binding/v1", body as unknown as CanonicalJson)) {
    throw new TypeError("fullGraphSweepManifest binding root mismatch");
  }
}

function exactManifest(bytes: Uint8Array): FullGraphCoarseSweepManifestV1 {
  const value = decodeCanonicalBytes(bytes) as unknown as FullGraphCoarseSweepManifestV1;
  assertExactKeys(value, [
    "schemaVersion", "kind", "binding", "expectedTransitionCount", "expectedTransitionRoot",
    "observedTransitionCount", "observedTransitionRoot", "missingTransitionCount", "missingTransitionRoot",
    "familyTransitionCounts", "entryChunkCount", "entryCount", "firstEntryChunkRef", "entryChunkClosureRoot", "sweepRoot",
  ], "fullGraphSweepManifest");
  if (value.schemaVersion !== 1 || value.kind !== "aloha.full-graph-coarse-sweep-manifest-v1") {
    throw new TypeError("full-Graph sweep manifest kind/version mismatch");
  }
  exactBinding(value.binding);
  assertDecimalString(value.expectedTransitionCount, "fullGraphSweepManifest.expectedTransitionCount");
  assertDecimalString(value.observedTransitionCount, "fullGraphSweepManifest.observedTransitionCount");
  assertDecimalString(value.missingTransitionCount, "fullGraphSweepManifest.missingTransitionCount");
  assertDecimalString(value.entryChunkCount, "fullGraphSweepManifest.entryChunkCount");
  assertDecimalString(value.entryCount, "fullGraphSweepManifest.entryCount");
  for (const [label, count] of [["entryChunkCount", value.entryChunkCount], ["entryCount", value.entryCount]] as const) {
    if (BigInt(count) > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError(`fullGraphSweepManifest.${label} exceeds safe indexing`);
  }
  for (const key of ["expectedTransitionRoot", "observedTransitionRoot", "missingTransitionRoot", "entryChunkClosureRoot", "sweepRoot"] as const) {
    assertHash(value[key], `fullGraphSweepManifest.${key}`);
  }
  if ((value.entryChunkCount === "0") !== (value.firstEntryChunkRef === null)) {
    throw new TypeError("full-Graph sweep manifest first chunk/count mismatch");
  }
  if (value.firstEntryChunkRef !== null) {
    exactChunkRef(value.firstEntryChunkRef, "fullGraphSweepManifest.firstEntryChunkRef");
    if (value.firstEntryChunkRef.chunkOrdinal !== "0" || value.firstEntryChunkRef.firstEntryOrdinal !== "0") {
      throw new TypeError("full-Graph sweep manifest first chunk does not start at zero");
    }
  }
  if (!Array.isArray(value.familyTransitionCounts)) throw new TypeError("fullGraphSweepManifest family counts are missing");
  let priorFamilyId: string | null = null;
  let expectedTotal = 0n;
  let observedTotal = 0n;
  let missingTotal = 0n;
  for (const [index, family] of value.familyTransitionCounts.entries()) {
    assertExactKeys(family, ["familyId", "expectedTransitionCount", "observedTransitionCount", "missingTransitionCount"], `fullGraphSweepManifest.familyTransitionCounts[${index}]`);
    const decodedFamily = family as unknown as FullGraphCoarseSweepFamilyTransitionCountV1;
    assertNonEmptyString(decodedFamily.familyId, `fullGraphSweepManifest.familyTransitionCounts[${index}].familyId`);
    if (priorFamilyId !== null && priorFamilyId >= decodedFamily.familyId) throw new TypeError("fullGraphSweepManifest family counts are not unique/ordered");
    priorFamilyId = decodedFamily.familyId;
    for (const key of ["expectedTransitionCount", "observedTransitionCount", "missingTransitionCount"] as const) {
      assertDecimalString(decodedFamily[key], `fullGraphSweepManifest.familyTransitionCounts[${index}].${key}`);
    }
    expectedTotal += BigInt(decodedFamily.expectedTransitionCount);
    observedTotal += BigInt(decodedFamily.observedTransitionCount);
    missingTotal += BigInt(decodedFamily.missingTransitionCount);
  }
  if (expectedTotal !== BigInt(value.expectedTransitionCount)
    || observedTotal !== BigInt(value.observedTransitionCount)
    || missingTotal !== BigInt(value.missingTransitionCount)
    || expectedTotal !== observedTotal + missingTotal
    || value.entryCount !== value.expectedTransitionCount) {
    throw new TypeError("fullGraphSweepManifest count partition mismatch");
  }
  const { sweepRoot, ...body } = value;
  if (sweepRoot !== hashDomain("aloha/full-graph-coarse-sweep-manifest/v1", body as unknown as CanonicalJson)) {
    throw new TypeError("full-Graph sweep manifest closure mismatch");
  }
  return Object.freeze(value);
}

export function decodeFullGraphCoarseSweepV1(
  manifestBytes: Uint8Array,
  readChunk: (ref: FullGraphCoarseSweepEntryChunkRefV1) => Uint8Array,
): FullGraphCoarseSweepV1 {
  const manifest = exactManifest(manifestBytes);
  const entries: FullGraphCoarseSweepEntryV1[] = [];
  const refs: FullGraphCoarseSweepEntryChunkRefV1[] = [];
  let ref = manifest.firstEntryChunkRef;
  while (ref !== null) {
    if (refs.length >= Number(manifest.entryChunkCount)) throw new TypeError("full-Graph sweep chunk chain exceeds manifest count");
    if (ref.chunkOrdinal !== String(refs.length)) throw new TypeError("full-Graph sweep chunk chain ordinal mismatch");
    if (ref.firstEntryOrdinal !== String(entries.length)) throw new TypeError("full-Graph sweep chunk range gap/overlap");
    const bytes = readChunk(ref);
    if (bytes.byteLength !== Number(ref.byteLength) || sha256Hex(bytes) !== ref.contentSha256) {
      throw new TypeError("full-Graph sweep chunk content mismatch");
    }
    const chunk = decodeCanonicalBytes(bytes) as unknown as FullGraphCoarseSweepEntryChunkV1;
    assertExactKeys(chunk, ["schemaVersion", "kind", "bindingRoot", "chunkOrdinal", "firstEntryOrdinal", "entries", "nextEntryChunkRef", "chunkRoot"], `fullGraphSweepChunk[${ref.chunkOrdinal}]`);
    if (chunk.schemaVersion !== 1 || chunk.kind !== "aloha.full-graph-coarse-sweep-entry-chunk-v1"
      || chunk.bindingRoot !== manifest.binding.bindingRoot || chunk.chunkOrdinal !== ref.chunkOrdinal
      || chunk.firstEntryOrdinal !== ref.firstEntryOrdinal || !Array.isArray(chunk.entries)
      || String(chunk.entries.length) !== ref.entryCount || chunk.chunkRoot !== ref.chunkRoot) {
      throw new TypeError("full-Graph sweep chunk manifest binding mismatch");
    }
    const { chunkRoot, ...chunkBody } = chunk;
    if (chunkRoot !== hashDomain("aloha/full-graph-coarse-sweep-entry-chunk/v1", chunkBody as unknown as CanonicalJson)) {
      throw new TypeError("full-Graph sweep chunk root mismatch");
    }
    if (chunk.nextEntryChunkRef !== null) exactChunkRef(chunk.nextEntryChunkRef, `fullGraphSweepChunk[${ref.chunkOrdinal}].nextEntryChunkRef`);
    refs.push(ref);
    entries.push(...chunk.entries);
    ref = chunk.nextEntryChunkRef;
  }
  if (manifest.entryChunkCount !== String(refs.length)
    || manifest.entryCount !== String(entries.length)
    || manifest.entryChunkClosureRoot !== entryChunkClosureRoot(refs)) {
    throw new TypeError("full-Graph sweep entry/chunk denominator incomplete");
  }
  const expectedTransitionIds = Object.freeze(entries.map(entry => entry.transitionId));
  const observedTransitionIds = Object.freeze(entries.filter(entry => entry.status === "observed").map(entry => entry.transitionId));
  const missingTransitionIds = Object.freeze(entries.filter(entry => entry.status === "missing").map(entry => entry.transitionId));
  if (manifest.expectedTransitionCount !== String(expectedTransitionIds.length)
    || manifest.observedTransitionCount !== String(observedTransitionIds.length)
    || manifest.missingTransitionCount !== String(missingTransitionIds.length)
    || manifest.expectedTransitionRoot !== fullGraphTransitionSequenceRootV1("expected", expectedTransitionIds)
    || manifest.observedTransitionRoot !== fullGraphTransitionSequenceRootV1("observed", observedTransitionIds)
    || manifest.missingTransitionRoot !== fullGraphTransitionSequenceRootV1("missing", missingTransitionIds)) {
    throw new TypeError("full-Graph sweep manifest transition closure mismatch");
  }
  const materializedBody = Object.freeze({
    schemaVersion: 1,
    kind: "aloha.full-graph-coarse-sweep-v1",
    binding: manifest.binding,
    expectedTransitionCount: manifest.expectedTransitionCount,
    expectedTransitionIds,
    expectedTransitionRoot: manifest.expectedTransitionRoot,
    observedTransitionCount: manifest.observedTransitionCount,
    observedTransitionIds,
    observedTransitionRoot: manifest.observedTransitionRoot,
    missingTransitionCount: manifest.missingTransitionCount,
    missingTransitionIds,
    missingTransitionRoot: manifest.missingTransitionRoot,
    familyTransitionCounts: manifest.familyTransitionCounts,
    entries: Object.freeze(entries),
  });
  assertSweepBodyClosure(materializedBody);
  return Object.freeze({ ...materializedBody, sweepRoot: manifest.sweepRoot });
}

export function decodeFullGraphCoarseSweepManifestV1(bytes: Uint8Array): FullGraphCoarseSweepManifestV1 {
  return exactManifest(bytes);
}
