import { constants } from "node:fs";
import { openSync, closeSync, fstatSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { link, lstat, mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { deserialize } from "node:v8";
import {
  assertDecimalString,
  assertExactKeys,
  assertHash,
  decodeCanonicalBytes,
  encodeCanonicalBytes,
  hashDomain,
  sha256Hex,
  type CanonicalJson,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  CORE_SCHEMA_MANIFESTS,
  decodeProductionReceipt,
  decodeReadOnlyArtifactRef,
  decodeSemanticArtifact,
} from "../../../specs/core-envelope/src/index.ts";
import {
  decodeArtifactBytes,
  decodeArtifactResolutionClaim,
  decodeRetentionLeaseReceipt,
  type ArtifactResolutionClaimV1,
  type RetentionLeaseReceiptV1,
} from "../../../specs/artifact-resolution/src/index.ts";
import type { ReadOnlyArtifactRefV1 } from "../../../specs/core-envelope/src/index.ts";
import {
  EVIDENCE_SCHEMA_MANIFESTS,
  assertEvidenceEventMatchesReceipt,
  decodeEvidenceEvent,
} from "../../../specs/evidence/src/index.ts";
import {
  decodeProductionSixStepArtifactMaterialV1,
  type ProductionSixStepArtifactMaterialV1,
} from "../../../packages/evidence-emitter/src/index.ts";
import {
  type SixStepEventFactV1,
} from "../../../specs/evidence/src/six-step.ts";
import {
  decodeFullFamilyFactLocator,
  decodeFullFamilyFacts,
  decodeFullFamilyPersistedGraphEdge,
  referencedFullFamilyArtifactDigests,
  validateFullFamilyFacts,
  type FullFamilyFactBundleV1,
  type FullFamilyGeneratedRuntimeMetadataV1,
} from "../../../specs/full-family-facts/src/index.ts";
import { ContentAddressedObserverSinkV1, type ObservedContentArtifactV1 } from "./content-addressed-sink.ts";
import {
  validateNativeFullFamilyAuditWireV1,
} from "./full-family-observer.ts";
import {
  decodeFullGraphCoarseSweepManifestV1,
  fullGraphTransitionSequenceRootV1,
} from "../../../packages/full-graph-coarse-sweep/src/index.ts";
import type {
  ProductionTerminalPhaseLocatorV1,
  ProductionTerminalPhaseManifestV1,
} from "./production-terminal-phase-port.ts";
import {
  decodeProductionTerminalPhaseFullFamilyProjectionV1,
  type ProductionTerminalPhaseFullFamilyProjectionV1,
} from "./terminal-phase-full-family-projection.ts";
import {
  assertActiveReadyGraphCoarseSweepDenominatorV1,
  derivePlannerCompatibleReadyGraphTransitionsV1,
  readProductionTerminalPhaseSnapshotTrustCapabilityV1,
  type ProductionTerminalPhaseSnapshotTrustCapabilityV1,
  type ProductionTerminalPhaseSnapshotTrustStateV1,
} from "./internal/terminal-phase-snapshot-trust-state.ts";

export interface ProductionTerminalPhaseLocatorIndexRecordV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.production-terminal-phase-locator-index-v1";
  readonly finalDurableWindowId: Hash;
  readonly locatorRoot: Hash;
  readonly locatorContentSha256: Hash;
  readonly locatorArtifactRefId: Hash;
  readonly locatorArtifact: NonNullable<ProductionTerminalPhaseLocatorIndexRecordV1["selectedProcessArtifact"]>;
  readonly manifestRoot: Hash;
  readonly manifestContentSha256: Hash;
  readonly manifestArtifact: Readonly<{
    readonly contentSha256: Hash;
    readonly ref: ReadOnlyArtifactRefV1;
    readonly claim: ArtifactResolutionClaimV1;
    readonly lease: RetentionLeaseReceiptV1;
  }>;
  readonly fullFamilyProjectionArtifact: NonNullable<ProductionTerminalPhaseLocatorIndexRecordV1["selectedProcessArtifact"]>;
  readonly fullFamilyTerminalBindingArtifact: NonNullable<ProductionTerminalPhaseLocatorIndexRecordV1["selectedProcessArtifact"]>;
  readonly fullGraphCoarseSweepArtifact: NonNullable<ProductionTerminalPhaseLocatorIndexRecordV1["selectedProcessArtifact"]>;
  readonly fullFamilyPredicateArtifacts: readonly NonNullable<ProductionTerminalPhaseLocatorIndexRecordV1["selectedProcessArtifact"]>[];
  readonly fullFamilyBundleArtifact: ProductionTerminalPhaseLocatorIndexRecordV1["selectedProcessArtifact"];
  readonly fullFamilyLocatorArtifact: ProductionTerminalPhaseLocatorIndexRecordV1["selectedProcessArtifact"];
  readonly sixStepTerminalBindingArtifact: ProductionTerminalPhaseLocatorIndexRecordV1["selectedProcessArtifact"];
  readonly sixStepPredicateArtifacts: readonly NonNullable<ProductionTerminalPhaseLocatorIndexRecordV1["selectedProcessArtifact"]>[];
  readonly selectedProcessArtifact: Readonly<{
    readonly contentSha256: Hash;
    readonly ref: ReadOnlyArtifactRefV1;
    readonly claim: ArtifactResolutionClaimV1;
    readonly lease: RetentionLeaseReceiptV1;
  }> | null;
  readonly indexRoot: Hash;
}

export interface ProductionTerminalPhaseDurableDiscoveryV1 {
  readonly indexDirectory: string;
  readonly indexPath: string;
  readonly indexDevice: string;
  readonly indexInode: string;
  readonly indexContentSha256: Hash;
  readonly indexByteLength: string;
  readonly observerContentDirectory: string;
  readonly observerContentDirectoryDevice: string;
  readonly observerContentDirectoryInode: string;
  readonly observerStoreIdentityHash: Hash;
  readonly index: ProductionTerminalPhaseLocatorIndexRecordV1;
  readonly locator: ProductionTerminalPhaseLocatorV1;
  readonly locatorBytes: Uint8Array;
  readonly locatorArtifact: ObservedContentArtifactV1;
  readonly manifest: ProductionTerminalPhaseManifestV1;
  readonly manifestBytes: Uint8Array;
  readonly manifestArtifact: ObservedContentArtifactV1;
  readonly fullFamilyProjection: ProductionTerminalPhaseFullFamilyProjectionV1;
  readonly fullFamilyProjectionArtifact: ObservedContentArtifactV1;
  readonly fullFamilyTerminalBindingArtifact: ObservedContentArtifactV1;
  readonly fullGraphCoarseSweepArtifact: ObservedContentArtifactV1;
  readonly fullFamilyPredicateArtifacts: readonly ObservedContentArtifactV1[];
  readonly fullFamilyBundleArtifact: ObservedContentArtifactV1 | null;
  readonly fullFamilyLocatorArtifact: ObservedContentArtifactV1 | null;
  readonly sixStepTerminalBindingArtifact: ObservedContentArtifactV1 | null;
  readonly sixStepPredicateArtifacts: readonly ObservedContentArtifactV1[];
  readonly sixStepEventFacts: readonly SixStepEventFactV1[];
  readonly sixStepArtifactMaterials: readonly ProductionSixStepArtifactMaterialV1[];
  readonly sixStepPhysicalStatus: "observed" | "invalid";
  readonly sixStepPhysicalReason: string | null;
  readonly selectedProcessArtifact: ObservedContentArtifactV1 | null;
  readonly snapshotTrustRoot: Hash | null;
}

const ISSUED_DURABLE_DISCOVERIES = new WeakSet<object>();

export function assertProductionTerminalPhaseDurableDiscoveryV1(
  value: unknown,
): asserts value is ProductionTerminalPhaseDurableDiscoveryV1 {
  if (value === null || typeof value !== "object" || !ISSUED_DURABLE_DISCOVERIES.has(value)) {
    throw new TypeError("terminal-phase durable discovery was not issued by the locator index");
  }
}

let temporarySequence = 0;

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactNullableHash(value: unknown, path: string): Hash | null {
  return value === null ? null : assertHash(value, path);
}

function decodeIndexedArtifact(
  value: unknown,
  path: string,
): NonNullable<ProductionTerminalPhaseLocatorIndexRecordV1["selectedProcessArtifact"]> {
  const artifact = record(value, path);
  assertExactKeys(artifact, ["contentSha256", "ref", "claim", "lease"], path);
  const contentSha256 = assertHash(artifact.contentSha256, `${path}.contentSha256`);
  const ref = decodeReadOnlyArtifactRef(artifact.ref as object);
  const claim = decodeArtifactResolutionClaim(artifact.claim as object);
  const lease = decodeRetentionLeaseReceipt(artifact.lease as object);
  if (ref.contentSha256 !== contentSha256
    || claim.artifactRefId !== ref.artifactRefId
    || claim.resolverPolicyHash !== ref.resolverPolicyHash
    || claim.outcome !== "content-observed"
    || claim.observedMirror === null
    || claim.observedMirror.contentSha256 !== contentSha256
    || claim.observedMirror.objectKey !== ref.immutableMirrorLocator.objectKey
    || claim.observedMirror.storeIdentityHash !== ref.immutableMirrorLocator.storeIdentityHash
    || lease.receiptId !== ref.retentionLeaseReceiptId
    || lease.contentSha256 !== contentSha256
    || lease.objectKey !== ref.immutableMirrorLocator.objectKey
    || lease.storeIdentityHash !== ref.immutableMirrorLocator.storeIdentityHash) {
    throw new TypeError(`terminal-phase indexed artifact authority mismatch at ${path}`);
  }
  return Object.freeze({ contentSha256, ref, claim, lease });
}

function decodeIndexedProcessArtifact(value: unknown): ProductionTerminalPhaseLocatorIndexRecordV1["selectedProcessArtifact"] {
  return value === null ? null : decodeIndexedArtifact(value, "terminalPhaseLocatorIndex.selectedProcessArtifact");
}

function decodeNullableIndexedArtifact(
  value: unknown,
  path: string,
): ProductionTerminalPhaseLocatorIndexRecordV1["selectedProcessArtifact"] {
  return value === null ? null : decodeIndexedArtifact(value, path);
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return sameBytes(encodeCanonicalBytes(left as CanonicalJson), encodeCanonicalBytes(right as CanonicalJson));
}

async function exactIndexedArtifactBytes(
  sink: ContentAddressedObserverSinkV1,
  artifact: NonNullable<ProductionTerminalPhaseLocatorIndexRecordV1["selectedProcessArtifact"]>,
  supplied: ObservedContentArtifactV1 | null,
  label: string,
): Promise<Uint8Array> {
  const bytes = await sink.readContent(artifact.contentSha256);
  const mirror = artifact.claim.observedMirror;
  if (mirror === null) throw new TypeError(`${label} has no observed mirror`);
  const mirrorBytes = decodeArtifactBytes(mirror.bytes);
  const locator = artifact.ref.locator;
  const immutable = artifact.ref.immutableMirrorLocator;
  if (locator.kind !== "content-object"
    || immutable.kind !== "content-object"
    || locator.objectKey !== artifact.contentSha256
    || immutable.objectKey !== artifact.contentSha256
    || locator.storeIdentityHash !== immutable.storeIdentityHash
    || locator.storeIdentityHash !== sink.storeIdentityHash
    || artifact.ref.resolverPolicyHash !== sink.resolverPolicy.policyHash
    || artifact.claim.resolverPolicyHash !== sink.resolverPolicy.policyHash
    || artifact.ref.contentSha256 !== artifact.contentSha256
    || artifact.ref.byteLength !== bytes.byteLength.toString()
    || artifact.ref.mediaType !== mirror.mediaType
    || !sameCanonical(artifact.ref.schema, mirror.schema)
    || mirror.byteLength !== bytes.byteLength.toString()
    || mirror.contentSha256 !== artifact.contentSha256
    || mirror.objectKey !== artifact.contentSha256
    || mirror.storeIdentityHash !== immutable.storeIdentityHash
    || artifact.claim.artifactRefId !== artifact.ref.artifactRefId
    || artifact.claim.resolverPolicyHash !== artifact.ref.resolverPolicyHash
    || artifact.lease.receiptId !== artifact.ref.retentionLeaseReceiptId
    || artifact.lease.contentSha256 !== artifact.contentSha256
    || artifact.lease.objectKey !== artifact.contentSha256
    || artifact.lease.storeIdentityHash !== immutable.storeIdentityHash
    || sha256Hex(bytes) !== artifact.contentSha256
    || !sameBytes(mirrorBytes, bytes)
    || (supplied !== null && (
      supplied.contentSha256 !== artifact.contentSha256
      || !sameBytes(supplied.bytes, bytes)
      || !sameCanonical(supplied.ref, artifact.ref)
      || !sameCanonical(supplied.claim, artifact.claim)
      || !sameCanonical(supplied.lease, artifact.lease)
    ))) {
    throw new TypeError(`${label} bytes/ref/claim/lease/mirror mismatch`);
  }
  return bytes;
}

/** Six-Step producer artifacts keep their native primary locator (including
 * fsynced file ranges).  Their immutable mirror is nevertheless in the exact
 * release-owned content store and is the restart read surface. */
async function exactIndexedSixStepArtifactBytes(
  sink: ContentAddressedObserverSinkV1,
  artifact: NonNullable<ProductionTerminalPhaseLocatorIndexRecordV1["selectedProcessArtifact"]>,
  supplied: ObservedContentArtifactV1 | null,
  label: string,
  snapshotTrust: ProductionTerminalPhaseSnapshotTrustStateV1 | null = null,
): Promise<Uint8Array> {
  const mirrorBytesFromStore = await sink.readContent(artifact.contentSha256);
  const mirror = artifact.claim.observedMirror;
  if (mirror === null) throw new TypeError(`${label} has no observed mirror`);
  const mirrorBytes = decodeArtifactBytes(mirror.bytes);
  const immutable = artifact.ref.immutableMirrorLocator;
  const locator = artifact.ref.locator;
  const bytes = snapshotTrust !== null && locator.kind === "file-range"
    ? readSnapshotLedgerRange(snapshotTrust, locator, artifact.contentSha256, artifact.ref.byteLength)
    : mirrorBytesFromStore;
  const fileRangeLength = locator.kind === "file-range"
    ? BigInt(assertDecimalString(locator.endExclusive, `${label}.locator.endExclusive`))
      - BigInt(assertDecimalString(locator.startInclusive, `${label}.locator.startInclusive`))
    : null;
  if (immutable.kind !== "content-object"
    || immutable.objectKey !== artifact.contentSha256
    || immutable.storeIdentityHash !== sink.storeIdentityHash
    || artifact.ref.resolverPolicyHash !== sink.resolverPolicy.policyHash
    || artifact.claim.resolverPolicyHash !== sink.resolverPolicy.policyHash
    || artifact.ref.contentSha256 !== artifact.contentSha256
    || artifact.ref.byteLength !== bytes.byteLength.toString()
    || artifact.ref.mediaType !== mirror.mediaType
    || !sameCanonical(artifact.ref.schema, mirror.schema)
    || mirror.byteLength !== bytes.byteLength.toString()
    || mirror.contentSha256 !== artifact.contentSha256
    || mirror.objectKey !== artifact.contentSha256
    || mirror.storeIdentityHash !== immutable.storeIdentityHash
    || artifact.claim.artifactRefId !== artifact.ref.artifactRefId
    || artifact.claim.resolverPolicyHash !== artifact.ref.resolverPolicyHash
    || artifact.lease.receiptId !== artifact.ref.retentionLeaseReceiptId
    || artifact.lease.contentSha256 !== artifact.contentSha256
    || artifact.lease.objectKey !== artifact.contentSha256
    || artifact.lease.storeIdentityHash !== immutable.storeIdentityHash
    || sha256Hex(bytes) !== artifact.contentSha256
    || !sameBytes(mirrorBytesFromStore, bytes)
    || !sameBytes(mirrorBytes, bytes)
    || (fileRangeLength !== null && fileRangeLength !== BigInt(bytes.byteLength))
    || (supplied !== null && (
      supplied.contentSha256 !== artifact.contentSha256
      || !sameBytes(supplied.bytes, bytes)
      || !sameCanonical(supplied.ref, artifact.ref)
      || !sameCanonical(supplied.claim, artifact.claim)
      || !sameCanonical(supplied.lease, artifact.lease)
    ))) {
    throw new TypeError(`${label} bytes/ref/claim/lease/mirror mismatch`);
  }
  return bytes;
}

function sameSchema(
  ref: ReadOnlyArtifactRefV1,
  manifest: Readonly<{ readonly id: string; readonly version: string; readonly schemaHash: Hash }>,
): boolean {
  return ref.schema !== null
    && ref.schema.id === manifest.id
    && ref.schema.version === manifest.version
    && ref.schema.schemaHash === manifest.schemaHash;
}

function sixStepPredicateArtifactRoot(
  artifacts: readonly NonNullable<ProductionTerminalPhaseLocatorIndexRecordV1["selectedProcessArtifact"]>[],
): Hash {
  return hashDomain("aloha/production-six-step-predicate-artifact-closure/v1", artifacts.map(artifact => ({
    artifactRefId: artifact.ref.artifactRefId,
    contentSha256: artifact.contentSha256,
    claimId: artifact.claim.claimId,
    leaseReceiptId: artifact.lease.receiptId,
  })));
}

const TERMINAL_BINDING_KEYS = [
  "schemaVersion", "kind", "runtimeBindingId", "candidateReleaseCommit", "releaseProvenanceHash",
  "economicEvaluatorAuthorityRoot", "economicEvaluatorImplementationHash", "economicEvaluatorBindingObservation",
  "definitionCatalogRoot", "strategyCompositionRoot", "searchTerminalHash", "terminalLineageHash",
  "traceRoot", "correlationId", "generationId", "readyRecordHash", "graphRoot", "currentSource",
  "planningProblemHash", "routeCandidateId", "programHash", "finalSimulationReceiptHash", "trace",
  "bindingRoot",
] as const;

const PROCESS_EVIDENCE_KEYS = [
  "schemaVersion", "kind", "runtimeBindingId", "candidateReleaseCommit", "releaseProvenanceHash",
  "terminalBindingRoot", "traceRoot", "correlationId", "generationId", "readyRecordHash", "graphRoot",
  "currentSource", "programHash", "finalSimulationReceiptHash", "stage12", "stage12Root",
  "sixStepLineageRoot", "runtimeFacts", "runtimeFactsRoot", "producerSchedulerJoin",
  "producerSchedulerJoinRoot", "runtimeAnchor", "runtimeAnchorRoot", "serving", "canonicalHead",
  "admissionId", "producerTerminalId", "producerTerminalBindingRoot", "durableAppend",
  "durableAppendRecordId", "producerTerminalDurableAppend", "producerTerminalDurableAppendRecordId",
  "evidenceRoot",
] as const;

function exactNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${path} must be a non-empty string`);
  return value;
}

function appendRecordId(value: unknown, path: string): Hash {
  const append = record(value, path);
  assertExactKeys(append, [
    "namespace", "sequence", "eventId", "contentSha256", "byteLength", "offsetStart", "offsetEnd", "fsynced",
  ], path);
  if (append.fsynced !== true) throw new TypeError(`${path} is not fsynced`);
  const payload = Object.freeze({
    namespace: exactNonEmptyString(append.namespace, `${path}.namespace`),
    sequence: assertDecimalString(append.sequence, `${path}.sequence`),
    eventId: assertHash(append.eventId, `${path}.eventId`),
    contentSha256: assertHash(append.contentSha256, `${path}.contentSha256`),
    byteLength: assertDecimalString(append.byteLength, `${path}.byteLength`),
    offsetStart: assertDecimalString(append.offsetStart, `${path}.offsetStart`),
    offsetEnd: assertDecimalString(append.offsetEnd, `${path}.offsetEnd`),
    fsynced: true as const,
  });
  return hashDomain("aloha/searcher-production-six-step-durable-append/v1", payload);
}

function terminalBindingIdentity(bytes: Uint8Array) {
  const value = record(decodeCanonicalBytes(bytes), "terminalPhaseSixStepTerminalBinding");
  assertExactKeys(value, TERMINAL_BINDING_KEYS, "terminalPhaseSixStepTerminalBinding");
  if (value.schemaVersion !== 1 || value.kind !== "aloha.runtime-release-six-step-terminal-binding-v1") {
    throw new TypeError("terminal-phase Six-Step terminal binding kind/version mismatch");
  }
  const bindingRoot = assertHash(value.bindingRoot, "terminalPhaseSixStepTerminalBinding.bindingRoot");
  const { bindingRoot: _root, ...payload } = value;
  if (bindingRoot !== hashDomain("aloha/runtime-release-six-step-terminal-binding/v1", payload as CanonicalJson)) {
    throw new TypeError("terminal-phase Six-Step terminal binding root mismatch");
  }
  const trace = record(value.trace, "terminalPhaseSixStepTerminalBinding.trace");
  if (assertHash(trace.traceRoot, "terminalPhaseSixStepTerminalBinding.trace.traceRoot")
    !== assertHash(value.traceRoot, "terminalPhaseSixStepTerminalBinding.traceRoot")) {
    throw new TypeError("terminal-phase Six-Step terminal trace mismatch");
  }
  return Object.freeze({
    value,
    bindingRoot,
    runtimeBindingId: assertHash(value.runtimeBindingId, "terminalPhaseSixStepTerminalBinding.runtimeBindingId"),
    candidateReleaseCommit: exactNonEmptyString(value.candidateReleaseCommit, "terminalPhaseSixStepTerminalBinding.candidateReleaseCommit"),
    releaseProvenanceHash: assertHash(value.releaseProvenanceHash, "terminalPhaseSixStepTerminalBinding.releaseProvenanceHash"),
    traceRoot: assertHash(value.traceRoot, "terminalPhaseSixStepTerminalBinding.traceRoot"),
    correlationId: assertHash(value.correlationId, "terminalPhaseSixStepTerminalBinding.correlationId"),
    generationId: exactNonEmptyString(value.generationId, "terminalPhaseSixStepTerminalBinding.generationId"),
    readyRecordHash: assertHash(value.readyRecordHash, "terminalPhaseSixStepTerminalBinding.readyRecordHash"),
    graphRoot: assertHash(value.graphRoot, "terminalPhaseSixStepTerminalBinding.graphRoot"),
    currentSource: value.currentSource,
    programHash: assertHash(value.programHash, "terminalPhaseSixStepTerminalBinding.programHash"),
    finalSimulationReceiptHash: assertHash(value.finalSimulationReceiptHash, "terminalPhaseSixStepTerminalBinding.finalSimulationReceiptHash"),
  });
}

function processIdentity(bytes: Uint8Array): Readonly<{
  readonly value: Record<string, unknown>;
  readonly evidenceRoot: Hash;
  readonly runtimeBindingId: Hash;
  readonly candidateReleaseCommit: string;
  readonly releaseProvenanceHash: Hash;
  readonly terminalBindingRoot: Hash;
  readonly traceRoot: Hash;
  readonly correlationId: Hash;
  readonly generationId: string;
  readonly readyRecordHash: Hash;
  readonly graphRoot: Hash;
  readonly currentSource: unknown;
  readonly programHash: Hash;
  readonly finalSimulationReceiptHash: Hash;
  readonly stage12Root: Hash;
  readonly sixStepLineageRoot: Hash;
  readonly runtimeAnchorRoot: Hash;
  readonly runtimeFactsRoot: Hash;
  readonly producerTerminalId: Hash;
  readonly durableAppendRecordId: Hash;
  readonly producerTerminalDurableAppendRecordId: Hash;
}> {
  const value = record(decodeCanonicalBytes(bytes), "terminalPhaseSelectedProcess");
  assertExactKeys(value, PROCESS_EVIDENCE_KEYS, "terminalPhaseSelectedProcess");
  if (value.schemaVersion !== 1 || value.kind !== "aloha.searcher-production-six-step-process-evidence-v1") {
    throw new TypeError("terminal-phase selected process kind/version mismatch");
  }
  const evidenceRoot = assertHash(value.evidenceRoot, "terminalPhaseSelectedProcess.evidenceRoot");
  const { evidenceRoot: _root, ...payload } = value;
  if (evidenceRoot !== hashDomain("aloha/searcher-production-six-step-process-evidence/v1", payload as CanonicalJson)) {
    throw new TypeError("terminal-phase selected process evidence root mismatch");
  }
  const durableAppendRecordId = assertHash(value.durableAppendRecordId, "terminalPhaseSelectedProcess.durableAppendRecordId");
  const producerTerminalDurableAppendRecordId = assertHash(value.producerTerminalDurableAppendRecordId, "terminalPhaseSelectedProcess.producerTerminalDurableAppendRecordId");
  if (durableAppendRecordId !== appendRecordId(value.durableAppend, "terminalPhaseSelectedProcess.durableAppend")
    || producerTerminalDurableAppendRecordId !== appendRecordId(
      value.producerTerminalDurableAppend,
      "terminalPhaseSelectedProcess.producerTerminalDurableAppend",
    )) {
    throw new TypeError("terminal-phase selected process durable append identity mismatch");
  }
  return Object.freeze({
    value,
    evidenceRoot,
    runtimeBindingId: assertHash(value.runtimeBindingId, "terminalPhaseSelectedProcess.runtimeBindingId"),
    candidateReleaseCommit: exactNonEmptyString(value.candidateReleaseCommit, "terminalPhaseSelectedProcess.candidateReleaseCommit"),
    releaseProvenanceHash: assertHash(value.releaseProvenanceHash, "terminalPhaseSelectedProcess.releaseProvenanceHash"),
    terminalBindingRoot: assertHash(value.terminalBindingRoot, "terminalPhaseSelectedProcess.terminalBindingRoot"),
    traceRoot: assertHash(value.traceRoot, "terminalPhaseSelectedProcess.traceRoot"),
    correlationId: assertHash(value.correlationId, "terminalPhaseSelectedProcess.correlationId"),
    generationId: exactNonEmptyString(value.generationId, "terminalPhaseSelectedProcess.generationId"),
    readyRecordHash: assertHash(value.readyRecordHash, "terminalPhaseSelectedProcess.readyRecordHash"),
    graphRoot: assertHash(value.graphRoot, "terminalPhaseSelectedProcess.graphRoot"),
    currentSource: value.currentSource,
    programHash: assertHash(value.programHash, "terminalPhaseSelectedProcess.programHash"),
    finalSimulationReceiptHash: assertHash(value.finalSimulationReceiptHash, "terminalPhaseSelectedProcess.finalSimulationReceiptHash"),
    stage12Root: assertHash(value.stage12Root, "terminalPhaseSelectedProcess.stage12Root"),
    sixStepLineageRoot: assertHash(value.sixStepLineageRoot, "terminalPhaseSelectedProcess.sixStepLineageRoot"),
    runtimeAnchorRoot: assertHash(value.runtimeAnchorRoot, "terminalPhaseSelectedProcess.runtimeAnchorRoot"),
    runtimeFactsRoot: assertHash(value.runtimeFactsRoot, "terminalPhaseSelectedProcess.runtimeFactsRoot"),
    producerTerminalId: assertHash(value.producerTerminalId, "terminalPhaseSelectedProcess.producerTerminalId"),
    durableAppendRecordId,
    producerTerminalDurableAppendRecordId,
  });
}

const FULL_FAMILY_TERMINAL_BINDING_KEYS = [
  "schemaVersion", "kind", "runtimeBindingId", "candidateReleaseCommit", "releaseProvenanceHash",
  "finalDurableWindowId", "producerTerminalId", "producerHeadFactsRoot", "producerTerminalBindingRoot",
  "laneTerminalSetRoot", "searchTerminalHash", "terminalKind", "terminalLineageHash", "nativeAuditRoot",
  "readyRecordHash", "generationId", "graphRoot", "generatedRuntime", "readyCutoff", "actualCurrentSource", "audit", "bindingRoot",
] as const;

function fullFamilyTerminalIdentity(bytes: Uint8Array) {
  const value = record(decodeCanonicalBytes(bytes), "terminalPhaseFullFamilyTerminalBinding");
  assertExactKeys(value, FULL_FAMILY_TERMINAL_BINDING_KEYS, "terminalPhaseFullFamilyTerminalBinding");
  if (value.schemaVersion !== 1 || value.kind !== "aloha.runtime-release-full-family-terminal-binding-v1") {
    throw new TypeError("terminal-phase Full-Family terminal binding kind/version mismatch");
  }
  const bindingRoot = assertHash(value.bindingRoot, "terminalPhaseFullFamilyTerminalBinding.bindingRoot");
  const { bindingRoot: _bindingRoot, ...payload } = value;
  if (bindingRoot !== hashDomain(
    "aloha/runtime-release-full-family-terminal-binding/v1",
    payload as CanonicalJson,
  )) {
    throw new TypeError("terminal-phase Full-Family terminal binding root mismatch");
  }
  const audit = record(value.audit, "terminalPhaseFullFamilyTerminalBinding.audit");
  validateNativeFullFamilyAuditWireV1(audit as never);
  const auditRoot = assertHash(audit.auditRoot, "terminalPhaseFullFamilyTerminalBinding.audit.auditRoot");
  const { auditRoot: _auditRoot, ...auditPayload } = audit;
  if (auditRoot !== hashDomain("aloha/native-full-family-audit/v1", auditPayload as CanonicalJson)
    || auditRoot !== assertHash(value.nativeAuditRoot, "terminalPhaseFullFamilyTerminalBinding.nativeAuditRoot")) {
    throw new TypeError("terminal-phase Full-Family terminal native-audit root mismatch");
  }
  const auditBinding = record(audit.binding, "terminalPhaseFullFamilyTerminalBinding.audit.binding");
  if (auditBinding.readyRecordHash !== value.readyRecordHash
    || auditBinding.graphRoot !== value.graphRoot
    || auditBinding.releaseProvenanceHash !== value.releaseProvenanceHash
    || auditBinding.generationId !== value.generationId
    || !sameCanonical(auditBinding.readyCutoff, value.readyCutoff)
    || !sameCanonical(auditBinding.actualCurrentSource, value.actualCurrentSource)) {
    throw new TypeError("terminal-phase Full-Family terminal/native-audit binding splice");
  }
  const generatedRuntime = record(value.generatedRuntime, "terminalPhaseFullFamilyTerminalBinding.generatedRuntime");
  assertExactKeys(generatedRuntime, [
    "releaseIntentRoot", "definitionCatalogRoot", "runtimeDescriptorRoot", "families",
  ], "terminalPhaseFullFamilyTerminalBinding.generatedRuntime");
  if (!Array.isArray(generatedRuntime.families) || generatedRuntime.families.length === 0) {
    throw new TypeError("terminal-phase Full-Family generated runtime Family denominator is empty");
  }
  const generatedFamilies = Object.freeze(generatedRuntime.families.map((item, index) => {
    const family = record(item, `terminalPhaseFullFamilyTerminalBinding.generatedRuntime.families[${index}]`);
    assertExactKeys(family, [
      "familyId", "familyDefinitionHash", "sourcePlanRoot", "sourcePlanRefs",
    ], `terminalPhaseFullFamilyTerminalBinding.generatedRuntime.families[${index}]`);
    if (!Array.isArray(family.sourcePlanRefs)) {
      throw new TypeError(`terminal-phase Full-Family generated runtime source plans are invalid at ${index}`);
    }
    return Object.freeze({
      familyId: exactNonEmptyString(family.familyId, `terminalPhaseFullFamilyTerminalBinding.generatedRuntime.families[${index}].familyId`),
      familyDefinitionHash: assertHash(family.familyDefinitionHash, `terminalPhaseFullFamilyTerminalBinding.generatedRuntime.families[${index}].familyDefinitionHash`),
      sourcePlanRoot: assertHash(family.sourcePlanRoot, `terminalPhaseFullFamilyTerminalBinding.generatedRuntime.families[${index}].sourcePlanRoot`),
      sourcePlanRefs: Object.freeze([...family.sourcePlanRefs]),
    });
  }));
  return Object.freeze({
    finalDurableWindowId: assertHash(value.finalDurableWindowId, "terminalPhaseFullFamilyTerminalBinding.finalDurableWindowId"),
    readyRecordHash: assertHash(value.readyRecordHash, "terminalPhaseFullFamilyTerminalBinding.readyRecordHash"),
    auditRoot,
    producerTerminalBindingRoot: assertHash(
      value.producerTerminalBindingRoot,
      "terminalPhaseFullFamilyTerminalBinding.producerTerminalBindingRoot",
    ),
    laneTerminalSetRoot: assertHash(value.laneTerminalSetRoot, "terminalPhaseFullFamilyTerminalBinding.laneTerminalSetRoot"),
    runtimeBindingId: assertHash(value.runtimeBindingId, "terminalPhaseFullFamilyTerminalBinding.runtimeBindingId"),
    releaseProvenanceHash: assertHash(value.releaseProvenanceHash, "terminalPhaseFullFamilyTerminalBinding.releaseProvenanceHash"),
    candidateReleaseCommit: exactNonEmptyString(
      value.candidateReleaseCommit,
      "terminalPhaseFullFamilyTerminalBinding.candidateReleaseCommit",
    ),
    graphRoot: assertHash(value.graphRoot, "terminalPhaseFullFamilyTerminalBinding.graphRoot"),
    generationId: exactNonEmptyString(value.generationId, "terminalPhaseFullFamilyTerminalBinding.generationId"),
    generatedRuntime: Object.freeze({
      releaseIntentRoot: assertHash(generatedRuntime.releaseIntentRoot, "terminalPhaseFullFamilyTerminalBinding.generatedRuntime.releaseIntentRoot"),
      definitionCatalogRoot: assertHash(generatedRuntime.definitionCatalogRoot, "terminalPhaseFullFamilyTerminalBinding.generatedRuntime.definitionCatalogRoot"),
      runtimeDescriptorRoot: assertHash(generatedRuntime.runtimeDescriptorRoot, "terminalPhaseFullFamilyTerminalBinding.generatedRuntime.runtimeDescriptorRoot"),
      families: generatedFamilies,
    }),
    readyCutoff: value.readyCutoff,
    actualCurrentSource: value.actualCurrentSource,
  });
}

function fullGraphCoarseSweepIdentity(bytes: Uint8Array) {
  const value = decodeFullGraphCoarseSweepManifestV1(bytes);
  const binding = record(value.binding, "terminalPhaseFullGraphCoarseSweepManifest.binding");
  assertExactKeys(binding, [
    "runtimeBindingId", "releaseProvenanceHash", "candidateReleaseCommit", "releaseMembershipRoot",
    "definitionCatalogRoot", "familyCompositionRoot", "generationId", "readyRecordHash", "graphRoot",
    "readyCutoff", "recentObservationRange", "currentSourceSessionId", "actualCurrentSource",
    "amountSeedHash", "objectiveRef", "bindingRoot",
  ], "terminalPhaseFullGraphCoarseSweep.binding");
  const bindingRoot = assertHash(binding.bindingRoot, "terminalPhaseFullGraphCoarseSweep.binding.bindingRoot");
  const { bindingRoot: _bindingRoot, ...bindingPayload } = binding;
  if (bindingRoot !== hashDomain("aloha/full-graph-coarse-sweep-binding/v1", bindingPayload as CanonicalJson)) {
    throw new TypeError("terminal-phase full-Graph coarse sweep binding root mismatch");
  }
  const expectedTransitionCount = assertDecimalString(value.expectedTransitionCount, "terminalPhaseFullGraphCoarseSweepManifest.expectedTransitionCount");
  const observedTransitionCount = assertDecimalString(value.observedTransitionCount, "terminalPhaseFullGraphCoarseSweepManifest.observedTransitionCount");
  const missingTransitionCount = assertDecimalString(value.missingTransitionCount, "terminalPhaseFullGraphCoarseSweepManifest.missingTransitionCount");
  return Object.freeze({
    sweepRoot: value.sweepRoot,
    expectedTransitionCount,
    expectedTransitionRoot: assertHash(value.expectedTransitionRoot, "terminalPhaseFullGraphCoarseSweep.expectedTransitionRoot"),
    observedTransitionCount,
    observedTransitionRoot: assertHash(value.observedTransitionRoot, "terminalPhaseFullGraphCoarseSweep.observedTransitionRoot"),
    missingTransitionCount,
    missingTransitionRoot: assertHash(value.missingTransitionRoot, "terminalPhaseFullGraphCoarseSweep.missingTransitionRoot"),
    familyTransitionCounts: value.familyTransitionCounts,
    entryChunkCount: value.entryChunkCount,
    entryCount: value.entryCount,
    firstEntryChunkRef: value.firstEntryChunkRef,
    entryChunkClosureRoot: value.entryChunkClosureRoot,
    runtimeBindingId: assertHash(binding.runtimeBindingId, "terminalPhaseFullGraphCoarseSweep.binding.runtimeBindingId"),
    releaseProvenanceHash: assertHash(binding.releaseProvenanceHash, "terminalPhaseFullGraphCoarseSweep.binding.releaseProvenanceHash"),
    candidateReleaseCommit: exactNonEmptyString(
      binding.candidateReleaseCommit,
      "terminalPhaseFullGraphCoarseSweep.binding.candidateReleaseCommit",
    ),
    readyRecordHash: assertHash(binding.readyRecordHash, "terminalPhaseFullGraphCoarseSweep.binding.readyRecordHash"),
    graphRoot: assertHash(binding.graphRoot, "terminalPhaseFullGraphCoarseSweep.binding.graphRoot"),
    generationId: exactNonEmptyString(binding.generationId, "terminalPhaseFullGraphCoarseSweep.binding.generationId"),
    readyCutoff: binding.readyCutoff,
    actualCurrentSource: binding.actualCurrentSource,
  });
}

function assertObservedFullFamilyBundleSemantics(
  bundle: FullFamilyFactBundleV1,
  generatedRuntimeMetadata: FullFamilyGeneratedRuntimeMetadataV1,
  terminal: ReturnType<typeof fullFamilyTerminalIdentity>,
  sweep: ReturnType<typeof fullGraphCoarseSweepIdentity>,
  predicateArtifacts: readonly NonNullable<ProductionTerminalPhaseLocatorIndexRecordV1["selectedProcessArtifact"]>[],
  predicateArtifactBytes: readonly Uint8Array[],
): void {
  validateFullFamilyFacts(bundle, generatedRuntimeMetadata);
  if (bundle.runtime.releaseBindingId !== terminal.runtimeBindingId
    || bundle.runtime.releaseProvenanceHash !== terminal.releaseProvenanceHash
    || bundle.runtime.readyRecordHash !== terminal.readyRecordHash
    || bundle.runtime.graphRoot !== terminal.graphRoot
    || bundle.runtime.generationId !== terminal.generationId
    || !sameCanonical(bundle.runtime.readyCutoff, terminal.readyCutoff)
    || !sameCanonical(bundle.runtime.actualCurrentSource, terminal.actualCurrentSource)
    || bundle.runtime.releaseBindingId !== sweep.runtimeBindingId
    || bundle.runtime.releaseProvenanceHash !== sweep.releaseProvenanceHash
    || bundle.runtime.readyRecordHash !== sweep.readyRecordHash
    || bundle.runtime.graphRoot !== sweep.graphRoot
    || bundle.runtime.generationId !== sweep.generationId
    || !sameCanonical(bundle.runtime.readyCutoff, sweep.readyCutoff)
    || !sameCanonical(bundle.runtime.actualCurrentSource, sweep.actualCurrentSource)) {
    throw new TypeError("terminal-phase Full-Family bundle/terminal/sweep runtime splice");
  }
  const artifactBytesByRef = new Map<Hash, Uint8Array>();
  for (const [position, artifact] of predicateArtifacts.entries()) {
    const bytes = predicateArtifactBytes[position];
    if (bytes === undefined) throw new TypeError("terminal-phase Full-Family predicate artifact bytes are incomplete");
    artifactBytesByRef.set(artifact.ref.artifactRefId, bytes);
  }
  const projectedEdges = bundle.families.flatMap(family => family.projectedEdges.items.map(item => {
    const bytes = artifactBytesByRef.get(item.evidenceArtifactRefId);
    if (bytes === undefined || sha256Hex(bytes) !== item.evidenceContentSha256) {
      throw new TypeError("terminal-phase Full-Family projected-edge artifact is missing");
    }
    const edge = decodeFullFamilyPersistedGraphEdge(
      decodeCanonicalBytes(bytes),
      `terminalPhaseFullFamily.projectedEdges.${item.itemId}`,
    );
    if (edge.edgeId !== item.itemId) {
      throw new TypeError("terminal-phase Full-Family projected-edge item identity mismatch");
    }
    return edge;
  }));
  const orderedProjectedEdges = [...projectedEdges].sort((left, right) => left.edgeId.localeCompare(right.edgeId));
  if (new Set(orderedProjectedEdges.map(edge => edge.edgeId)).size !== orderedProjectedEdges.length) {
    throw new TypeError("terminal-phase Full-Family projected Graph edge denominator is duplicated");
  }
  const expectedTransitions = derivePlannerCompatibleReadyGraphTransitionsV1(orderedProjectedEdges);
  const expectedTransitionIds = expectedTransitions.map(transition => transition.transitionId);
  const graphRoot = hashDomain("aloha/persisted-graph/v1", {
    cutoff: sweep.readyCutoff,
    instanceCatalogRoot: bundle.runtime.instanceCatalogRoot,
    edges: orderedProjectedEdges,
  });
  if (bundle.runtime.edgeCount !== String(projectedEdges.length)
    || sweep.observedTransitionCount !== sweep.expectedTransitionCount
    || sweep.missingTransitionCount !== "0"
    || sweep.expectedTransitionCount !== String(expectedTransitions.length)
    || sweep.entryCount !== sweep.expectedTransitionCount
    || sweep.expectedTransitionRoot !== fullGraphTransitionSequenceRootV1("expected", expectedTransitionIds)
    || sweep.observedTransitionRoot !== fullGraphTransitionSequenceRootV1("observed", expectedTransitionIds)
    || sweep.missingTransitionRoot !== fullGraphTransitionSequenceRootV1("missing", [])
    || graphRoot !== bundle.runtime.graphRoot
    || graphRoot !== terminal.graphRoot
    || graphRoot !== sweep.graphRoot) {
    throw new TypeError("terminal-phase Full-Family graph edge denominator/root mismatch");
  }
}

function assertFullFamilyArtifactsManifestJoin(
  manifest: ProductionTerminalPhaseManifestV1,
  projectionArtifact: NonNullable<ProductionTerminalPhaseLocatorIndexRecordV1["selectedProcessArtifact"]>,
  projectionBytes: Uint8Array,
  bundleArtifact: ProductionTerminalPhaseLocatorIndexRecordV1["selectedProcessArtifact"],
  bundleBytes: Uint8Array | null,
  locatorArtifact: ProductionTerminalPhaseLocatorIndexRecordV1["selectedProcessArtifact"],
  locatorBytes: Uint8Array | null,
  terminalBindingArtifact: NonNullable<ProductionTerminalPhaseLocatorIndexRecordV1["selectedProcessArtifact"]>,
  terminalBindingBytes: Uint8Array,
  sweepArtifact: NonNullable<ProductionTerminalPhaseLocatorIndexRecordV1["selectedProcessArtifact"]>,
  sweepBytes: Uint8Array,
  predicateArtifacts: readonly NonNullable<ProductionTerminalPhaseLocatorIndexRecordV1["selectedProcessArtifact"]>[],
  predicateArtifactBytes: readonly Uint8Array[],
  generatedRuntimeMetadata: FullFamilyGeneratedRuntimeMetadataV1 | null,
): ProductionTerminalPhaseFullFamilyProjectionV1 {
  const projection = decodeProductionTerminalPhaseFullFamilyProjectionV1(decodeCanonicalBytes(projectionBytes));
  const terminal = fullFamilyTerminalIdentity(terminalBindingBytes);
  const sweep = fullGraphCoarseSweepIdentity(sweepBytes);
  const projectedCoarseMissing = projection.missing.filter(item => item.code === "coarse-family-artifact-unavailable");
  const expectedStatus = projection.missing.length === 0 ? "observed" as const : "missing" as const;
  if (terminalBindingArtifact.ref.artifactRefId === sweepArtifact.ref.artifactRefId
    || projectionArtifact.ref.artifactRefId === terminalBindingArtifact.ref.artifactRefId
    || projectionArtifact.ref.artifactRefId === sweepArtifact.ref.artifactRefId
    || projectionArtifact.ref.artifactRefId !== manifest.fullFamily.projectionArtifactRefId
    || projectionArtifact.contentSha256 !== manifest.fullFamily.projectionContentSha256
    || projection.finalDurableWindowId !== manifest.finalDurableWindowId
    || projection.finalDurableWindowId !== terminal.finalDurableWindowId
    || projection.readyRecordHash !== terminal.readyRecordHash
    || projection.auditRoot !== terminal.auditRoot
    || projection.producerTerminalBindingRoot !== terminal.producerTerminalBindingRoot
    || projection.laneTerminalSetRoot !== terminal.laneTerminalSetRoot
    || projection.fullGraphCoarseSweepRoot !== manifest.fullGraphCoarseSweepRoot
    || projection.fullGraphCoarseSweepRoot !== sweep.sweepRoot
    || terminal.runtimeBindingId !== sweep.runtimeBindingId
    || terminal.releaseProvenanceHash !== sweep.releaseProvenanceHash
    || terminal.candidateReleaseCommit !== sweep.candidateReleaseCommit
    || terminal.readyRecordHash !== sweep.readyRecordHash
    || terminal.graphRoot !== sweep.graphRoot
    || projection.status !== expectedStatus
    || projectedCoarseMissing.length > 1
    || (projectedCoarseMissing.length === 1 && projectedCoarseMissing[0]!.subjectRoot !== sweep.sweepRoot)) {
    throw new TypeError("terminal-phase Full-Family projection/manifest/window splice");
  }
  if (projection.status === "missing") {
    if (bundleArtifact !== null || bundleBytes !== null || locatorArtifact !== null || locatorBytes !== null
      || predicateArtifacts.length !== 0 || predicateArtifactBytes.length !== 0) {
      throw new TypeError("terminal-phase missing Full-Family retained an artifact");
    }
  } else {
    if (bundleArtifact === null || bundleBytes === null || locatorArtifact === null || locatorBytes === null
      || bundleArtifact.contentSha256 !== projection.bundleContentSha256
      || locatorArtifact.contentSha256 !== projection.locatorContentSha256) {
      throw new TypeError("terminal-phase observed Full-Family artifact denominator mismatch");
    }
    const bundle = decodeFullFamilyFacts(decodeCanonicalBytes(bundleBytes) as object);
    const locator = decodeFullFamilyFactLocator(decodeCanonicalBytes(locatorBytes) as object);
    if (locator.bundleArtifactRefId !== bundleArtifact.ref.artifactRefId
      || locator.bundleContentSha256 !== bundleArtifact.contentSha256
      || projection.readyRecordHash !== bundle.runtime.readyRecordHash) {
      throw new TypeError("terminal-phase Full-Family locator/bundle/projection splice");
    }
    const expected = [...referencedFullFamilyArtifactDigests(bundle)].sort(([left], [right]) => left.localeCompare(right));
    if (predicateArtifacts.length !== expected.length || predicateArtifactBytes.length !== expected.length) {
      throw new TypeError("terminal-phase Full-Family predicate artifact closure denominator mismatch");
    }
    for (const [position, [artifactRefId, contentSha256]] of expected.entries()) {
      const artifact = predicateArtifacts[position];
      const bytes = predicateArtifactBytes[position];
      if (artifact === undefined || bytes === undefined
        || artifact.ref.artifactRefId !== artifactRefId
        || artifact.contentSha256 !== contentSha256
        || sha256Hex(bytes) !== contentSha256) {
        throw new TypeError("terminal-phase Full-Family predicate artifact closure splice");
      }
    }
    if (generatedRuntimeMetadata === null) {
      throw new TypeError("terminal-phase observed Full-Family generated denominator is missing");
    }
    assertObservedFullFamilyBundleSemantics(
      bundle,
      generatedRuntimeMetadata,
      terminal,
      sweep,
      predicateArtifacts,
      predicateArtifactBytes,
    );
  }
  const invocationRoot = hashDomain("aloha/production-terminal-phase-invocation/v1", {
    finalDurableWindowId: manifest.finalDurableWindowId,
    fullGraphCoarseSweepRoot: manifest.fullGraphCoarseSweepRoot,
    fullFamilyObservationRoot: projection.observationRoot,
    sixStepObservationRoot: manifest.sixStep.observationRoot,
    releaseAnchorRoot: manifest.releaseAnchorRoot,
    runtimeAnchorRoot: manifest.runtimeAnchorRoot,
    runtimeArtifactRoot: manifest.runtimeArtifactRoot,
    processAnchorRoot: manifest.processAnchorRoot,
  });
  if (manifest.terminalPhaseInvocationRoot !== invocationRoot) {
    throw new TypeError("terminal-phase Full-Family projection invocation mismatch");
  }
  return projection;
}

function assertSixStepArtifactsManifestJoin(
  manifest: ProductionTerminalPhaseManifestV1,
  terminalBindingArtifact: ProductionTerminalPhaseLocatorIndexRecordV1["selectedProcessArtifact"],
  terminalBindingBytes: Uint8Array | null,
  selectedProcessArtifact: ProductionTerminalPhaseLocatorIndexRecordV1["selectedProcessArtifact"],
  processBytes: Uint8Array | null,
  predicateArtifacts: readonly NonNullable<ProductionTerminalPhaseLocatorIndexRecordV1["selectedProcessArtifact"]>[],
  predicateArtifactBytes: readonly Uint8Array[],
): readonly SixStepEventFactV1[] {
  if (manifest.sixStep.status !== "observed") {
    if (terminalBindingArtifact !== null || terminalBindingBytes !== null
      || selectedProcessArtifact !== null || processBytes !== null
      || predicateArtifacts.length !== 0 || predicateArtifactBytes.length !== 0
      || manifest.sixStep.predicateArtifactCount !== "0"
      || manifest.sixStep.eventArtifactRefIds.length !== 0) {
      throw new TypeError("terminal-phase non-observed selection retained a Six-Step artifact");
    }
    if (manifest.sixStep.predicateArtifactRoot !== sixStepPredicateArtifactRoot([])) {
      throw new TypeError("terminal-phase non-observed Six-Step closure root mismatch");
    }
    return Object.freeze([]);
  }
  if (terminalBindingArtifact === null || terminalBindingBytes === null
    || selectedProcessArtifact === null || processBytes === null) {
    throw new TypeError("terminal-phase observed selection is missing its exact two Six-Step artifacts");
  }
  if (predicateArtifacts.length !== predicateArtifactBytes.length
    || predicateArtifacts.length.toString() !== manifest.sixStep.predicateArtifactCount
    || sixStepPredicateArtifactRoot(predicateArtifacts) !== manifest.sixStep.predicateArtifactRoot) {
    throw new TypeError("terminal-phase Six-Step predicate artifact denominator mismatch");
  }
  const terminal = terminalBindingIdentity(terminalBindingBytes);
  const identity = processIdentity(processBytes);
  if (identity.runtimeBindingId !== terminal.runtimeBindingId
    || identity.candidateReleaseCommit !== terminal.candidateReleaseCommit
    || identity.releaseProvenanceHash !== terminal.releaseProvenanceHash
    || identity.terminalBindingRoot !== terminal.bindingRoot
    || identity.traceRoot !== terminal.traceRoot
    || identity.correlationId !== terminal.correlationId
    || identity.generationId !== terminal.generationId
    || identity.readyRecordHash !== terminal.readyRecordHash
    || identity.graphRoot !== terminal.graphRoot
    || !sameCanonical(identity.currentSource, terminal.currentSource)
    || identity.programHash !== terminal.programHash
    || identity.finalSimulationReceiptHash !== terminal.finalSimulationReceiptHash
    || identity.evidenceRoot !== manifest.sixStep.joinedProcessEvidenceRoot
    || identity.producerTerminalId !== manifest.sixStep.selectedProducerTerminalId
    || identity.durableAppendRecordId !== manifest.sixStep.performanceAppendRecordId
    || identity.producerTerminalDurableAppendRecordId !== manifest.sixStep.producerTerminalAppendRecordId) {
    throw new TypeError("terminal-phase Six-Step terminal/process/manifest splice");
  }
  const artifactsByRef = new Map(predicateArtifacts.map((artifact, position) => [
    artifact.ref.artifactRefId,
    Object.freeze({ artifact, bytes: predicateArtifactBytes[position]! }),
  ] as const));
  if (artifactsByRef.size !== predicateArtifacts.length) {
    throw new TypeError("terminal-phase Six-Step predicate artifact duplicate");
  }
  const runtimeAnchor = record(identity.value.runtimeAnchor, "terminalPhaseSelectedProcess.runtimeAnchor");
  const expectedBootIdHash = hashDomain(
    "aloha/searcher-runtime-boot-id/v1",
    exactNonEmptyString(runtimeAnchor.bootId, "terminalPhaseSelectedProcess.runtimeAnchor.bootId"),
  );
  const expectedSystemId = `${exactNonEmptyString(runtimeAnchor.serviceName, "terminalPhaseSelectedProcess.runtimeAnchor.serviceName")}/${exactNonEmptyString(runtimeAnchor.systemdUnit, "terminalPhaseSelectedProcess.runtimeAnchor.systemdUnit")}`;
  const expectedPid = assertDecimalString(runtimeAnchor.pid, "terminalPhaseSelectedProcess.runtimeAnchor.pid");
  const expectedProcessStartTicks = assertDecimalString(runtimeAnchor.processStartTicks, "terminalPhaseSelectedProcess.runtimeAnchor.processStartTicks");
  const eventFacts: SixStepEventFactV1[] = [];
  const stageArtifactSetRoots: Hash[] = [];
  const stageOrdinals: number[] = [];
  for (const [position, eventArtifactRefId] of manifest.sixStep.eventArtifactRefIds.entries()) {
    const observedEvent = artifactsByRef.get(eventArtifactRefId);
    if (observedEvent === undefined || !sameSchema(observedEvent.artifact.ref, EVIDENCE_SCHEMA_MANIFESTS.event)) {
      throw new TypeError(`terminal-phase Six-Step event artifact[${position}] is missing`);
    }
    const event = decodeEvidenceEvent(observedEvent.bytes);
    const eventLocator = observedEvent.artifact.ref.locator;
    const semanticEntry = [...artifactsByRef.values()].find(value => {
      if (!sameSchema(value.artifact.ref, CORE_SCHEMA_MANIFESTS.semanticArtifact)) return false;
      return decodeSemanticArtifact(value.bytes).artifactId === event.artifactLineage.outputArtifactId;
    });
    const receiptEntry = [...artifactsByRef.values()].find(value => {
      if (!sameSchema(value.artifact.ref, CORE_SCHEMA_MANIFESTS.productionReceipt)) return false;
      return decodeProductionReceipt(value.bytes).receiptId === event.artifactLineage.productionReceiptId;
    });
    if (semanticEntry === undefined || receiptEntry === undefined) {
      throw new TypeError(`terminal-phase Six-Step event artifact[${position}] has no exact semantic artifact/receipt`);
    }
    const semantic = decodeSemanticArtifact(semanticEntry.bytes);
    const receipt = decodeProductionReceipt(receiptEntry.bytes);
    assertEvidenceEventMatchesReceipt(event, receipt);
    const rawEntry = artifactsByRef.get(receipt.rawBoundaryArtifactRef.artifactRefId);
    const logEntry = artifactsByRef.get(receipt.logRangeArtifactRef.artifactRefId);
    const inputEntries = semantic.inputArtifactIds.map(id => artifactsByRef.get(id));
    if (rawEntry === undefined || logEntry === undefined || inputEntries.some(value => value === undefined)
      || !sameCanonical(rawEntry.artifact.ref, receipt.rawBoundaryArtifactRef)
      || !sameCanonical(logEntry.artifact.ref, receipt.logRangeArtifactRef)
      || !sameCanonical(event.source.rawBoundaryArtifactRef, receipt.rawBoundaryArtifactRef)) {
      throw new TypeError(`terminal-phase Six-Step event artifact[${position}] input closure is incomplete`);
    }
    const logLocator = logEntry.artifact.ref.locator;
    if (event.runtime.commitSha !== terminal.candidateReleaseCommit
      || event.runtime.pid !== expectedPid
      || event.runtime.processStartTicks !== expectedProcessStartTicks
      || event.runtime.bootIdHash !== expectedBootIdHash
      || event.source.systemId !== expectedSystemId
      || receipt.producer.commitSha !== event.runtime.commitSha
      || receipt.producer.pid !== event.runtime.pid
      || receipt.producer.processStartTicks !== event.runtime.processStartTicks
      || receipt.producer.bootIdHash !== event.runtime.bootIdHash
      || receipt.producer.systemId !== event.source.systemId
      || eventLocator.kind !== "file-range"
      || eventLocator.systemId !== expectedSystemId
      || eventLocator.bootIdHash !== expectedBootIdHash
      || logLocator.kind !== "file-range"
      || logLocator.systemId !== expectedSystemId
      || logLocator.bootIdHash !== expectedBootIdHash
      || eventLocator.device !== logLocator.device
      || eventLocator.inode !== logLocator.inode) {
      throw new TypeError(`terminal-phase Six-Step event artifact[${position}] crosses its producer process`);
    }
    const witnesses = inputEntries.slice(1).map(value => value!.artifact);
    const inputArtifacts = [rawEntry.artifact, logEntry.artifact, ...witnesses];
    const eventFact = Object.freeze({
      schemaVersion: 1 as const,
      kind: "aloha.six-step-event-fact" as const,
      eventArtifactRefId,
      semanticArtifactRefId: semanticEntry.artifact.ref.artifactRefId,
      productionReceiptArtifactRefId: receiptEntry.artifact.ref.artifactRefId,
    });
    eventFacts.push(eventFact);
    stageOrdinals.push(event.stage.ordinal);
    stageArtifactSetRoots.push(hashDomain("aloha/production-six-step-artifact-set/v1", {
      eventFact,
      inputArtifactRefIds: inputArtifacts.map(value => value.ref.artifactRefId),
      witnessArtifactRefIds: witnesses.map(value => value.ref.artifactRefId),
      resolutionClaimIds: [observedEvent.artifact, semanticEntry.artifact, receiptEntry.artifact, ...inputArtifacts].map(value => value.claim.claimId),
      leaseReceiptIds: [observedEvent.artifact, semanticEntry.artifact, receiptEntry.artifact, ...inputArtifacts].map(value => value.lease.receiptId),
    }));
  }
  const stage1Count = stageOrdinals.filter(ordinal => ordinal === 1).length;
  if (stage1Count === 0 || stage1Count !== stageOrdinals.filter(ordinal => ordinal === 2).length
    || [3, 4, 5, 6].some(ordinal => stageOrdinals.filter(value => value === ordinal).length !== 1)
    || stageOrdinals.some((ordinal, position) => position > 0 && ordinal < stageOrdinals[position - 1]!)) {
    throw new TypeError("terminal-phase Six-Step stage denominator/order mismatch");
  }
  const observationRoot = hashDomain("aloha/production-six-step-observation/v1", {
    kind: "aloha.production-six-step-observation-v1",
    status: "observed",
    runtimeBindingId: terminal.runtimeBindingId,
    candidateReleaseCommit: terminal.candidateReleaseCommit,
    releaseProvenanceHash: terminal.releaseProvenanceHash,
    finalDurableWindowId: manifest.finalDurableWindowId,
    windowSelectionRoot: manifest.sixStep.windowSelectionRoot!,
    selectionPolicyDigest: manifest.sixStep.selectionPolicyDigest!,
    eligibleSuccessCount: manifest.sixStep.eligibleSuccessCount!,
    eligibleSuccessRoot: manifest.sixStep.eligibleSuccessRoot!,
    selectedIndex: manifest.sixStep.selectedIndex!,
    selectedProducerTerminalId: manifest.sixStep.selectedProducerTerminalId!,
    terminalBindingRoot: terminal.bindingRoot,
    joinedProcessEvidenceRoot: identity.evidenceRoot,
    durableAppendRecordId: identity.durableAppendRecordId,
    producerTerminalDurableAppendRecordId: identity.producerTerminalDurableAppendRecordId,
    traceRoot: terminal.traceRoot,
    stage12Root: identity.stage12Root,
    sixStepLineageRoot: identity.sixStepLineageRoot,
    runtimeAnchorRoot: identity.runtimeAnchorRoot,
    runtimeFactsRoot: identity.runtimeFactsRoot,
    programHash: terminal.programHash,
    finalSimulationReceiptHash: terminal.finalSimulationReceiptHash,
    observedArtifacts: [
      {
        role: "runtime-release-terminal-binding",
        artifactRefId: terminalBindingArtifact.ref.artifactRefId,
        contentSha256: terminalBindingArtifact.contentSha256,
        claimId: terminalBindingArtifact.claim.claimId,
        leaseReceiptId: terminalBindingArtifact.lease.receiptId,
      },
      {
        role: "joined-process-evidence",
        artifactRefId: selectedProcessArtifact.ref.artifactRefId,
        contentSha256: selectedProcessArtifact.contentSha256,
        claimId: selectedProcessArtifact.claim.claimId,
        leaseReceiptId: selectedProcessArtifact.lease.receiptId,
      },
    ],
    stageArtifactSetRoots,
  });
  if (observationRoot !== manifest.sixStep.observationRoot) {
    throw new TypeError("terminal-phase Six-Step observation root mismatch");
  }
  return Object.freeze(eventFacts);
}

function exactSixStepArtifactMaterials(
  eventFacts: readonly SixStepEventFactV1[],
  indexedArtifacts: readonly NonNullable<ProductionTerminalPhaseLocatorIndexRecordV1["selectedProcessArtifact"]>[],
  indexedBytes: readonly Uint8Array[],
  candidates: readonly ProductionSixStepArtifactMaterialV1[],
): readonly ProductionSixStepArtifactMaterialV1[] {
  const indexed = new Map(indexedArtifacts.map((artifact, index) => [
    artifact.ref.artifactRefId,
    Object.freeze({ artifact, bytes: indexedBytes[index]! }),
  ] as const));
  const byEvent = new Map<Hash, ProductionSixStepArtifactMaterialV1>();
  for (const candidate of candidates) {
    const refId = candidate.eventArtifact.ref.artifactRefId;
    if (byEvent.has(refId)) throw new TypeError("terminal-phase Six-Step boundary material event is duplicated");
    byEvent.set(refId, candidate);
  }
  const usedRefs = new Set<Hash>();
  const selected = eventFacts.map((fact, index) => {
    const material = byEvent.get(fact.eventArtifactRefId);
    if (material === undefined || material.eventFact.semanticArtifactRefId !== fact.semanticArtifactRefId
      || material.eventFact.productionReceiptArtifactRefId !== fact.productionReceiptArtifactRefId) {
      throw new TypeError(`terminal-phase Six-Step boundary material[${index}] is missing`);
    }
    const closure = [
      material.eventArtifact,
      material.semanticArtifactRef,
      material.productionReceiptRef,
      ...material.inputArtifacts,
    ];
    for (const stored of closure) {
      const observed = indexed.get(stored.ref.artifactRefId);
      if (observed === undefined || observed.artifact.contentSha256 !== stored.ref.contentSha256
        || !sameCanonical(observed.artifact.ref, stored.ref)
        || !sameCanonical(observed.artifact.claim, stored.claim)
        || !sameCanonical(observed.artifact.lease, stored.lease)
        || !sameBytes(observed.bytes, stored.bytes)) {
        throw new TypeError(`terminal-phase Six-Step boundary material[${index}] closure splice`);
      }
      usedRefs.add(stored.ref.artifactRefId);
    }
    return material;
  });
  if (usedRefs.size !== indexed.size) {
    throw new TypeError("terminal-phase Six-Step boundary material closure denominator mismatch");
  }
  return Object.freeze(selected);
}

export function decodeProductionTerminalPhaseManifestV1(
  value: unknown,
): ProductionTerminalPhaseManifestV1 {
  const manifest = record(value, "terminalPhaseManifest");
  assertExactKeys(manifest, [
    "schemaVersion", "kind", "finalDurableWindowId", "windowId", "releaseAnchorRoot",
    "runtimeAnchorRoot", "runtimeArtifactRoot", "processAnchorRoot", "fullGraphCoarseSweepRoot",
    "terminalPhaseInvocationRoot", "fullFamily", "sixStep", "manifestRoot",
  ], "terminalPhaseManifest");
  if (manifest.schemaVersion !== 1 || manifest.kind !== "aloha.production-terminal-phase-manifest-v1") {
    throw new TypeError("terminalPhaseManifest kind/version mismatch");
  }
  const fullFamily = record(manifest.fullFamily, "terminalPhaseManifest.fullFamily");
  assertExactKeys(fullFamily, [
    "projectionArtifactRefId", "projectionContentSha256",
  ], "terminalPhaseManifest.fullFamily");
  const sixStep = record(manifest.sixStep, "terminalPhaseManifest.sixStep");
  assertExactKeys(sixStep, [
    "status", "observationRoot", "windowSelectionRoot", "selectionPolicyDigest", "eligibleSuccessCount",
    "eligibleSuccessRoot", "selectedIndex", "selectedProducerTerminalId", "reason",
    "joinedProcessEvidenceRoot", "performanceAppendRecordId", "producerTerminalAppendRecordId",
    "predicateArtifactCount", "predicateArtifactRoot", "eventArtifactRefIds",
  ], "terminalPhaseManifest.sixStep");
  if (sixStep.status !== "observed" && sixStep.status !== "missing" && sixStep.status !== "invalid") {
    throw new TypeError("terminalPhaseManifest.sixStep.status is invalid");
  }
  if (sixStep.reason !== null && typeof sixStep.reason !== "string") {
    throw new TypeError("terminalPhaseManifest.sixStep.reason is invalid");
  }
  if (sixStep.selectedIndex !== null && sixStep.selectedIndex !== "0") {
    throw new TypeError("terminalPhaseManifest.sixStep.selectedIndex is invalid");
  }
  const eligibleSuccessCount = sixStep.eligibleSuccessCount === null
    ? null
    : assertDecimalString(sixStep.eligibleSuccessCount, "terminalPhaseManifest.sixStep.eligibleSuccessCount");
  const predicateArtifactCount = assertDecimalString(
    sixStep.predicateArtifactCount,
    "terminalPhaseManifest.sixStep.predicateArtifactCount",
  );
  if (!Array.isArray(sixStep.eventArtifactRefIds)) {
    throw new TypeError("terminalPhaseManifest.sixStep.eventArtifactRefIds must be an array");
  }
  const eventArtifactRefIds = Object.freeze(sixStep.eventArtifactRefIds.map((value, position) =>
    assertHash(value, `terminalPhaseManifest.sixStep.eventArtifactRefIds[${position}]`)));
  const hasSelection = sixStep.windowSelectionRoot !== null;
  const hasSelectedTerminal = sixStep.selectedIndex === "0" && sixStep.selectedProducerTerminalId !== null;
  const hasJoinedProcessEvidence = sixStep.joinedProcessEvidenceRoot !== null
    && sixStep.performanceAppendRecordId !== null
    && sixStep.producerTerminalAppendRecordId !== null;
  const hasPartialJoinedProcessEvidence = sixStep.joinedProcessEvidenceRoot !== null
    || sixStep.performanceAppendRecordId !== null
    || sixStep.producerTerminalAppendRecordId !== null;
  const missingReasons = new Set(["no-successful-dry-run", "terminal-binding-missing", "joined-process-evidence-missing"]);
  const invalidReasons = new Set(["window-selection-capability-invalid", "terminal-capability-invalid", "terminal-artifact-capability-invalid", "process-capability-invalid", "terminal-process-binding-mismatch"]);
  if ((sixStep.windowSelectionRoot === null) !== (sixStep.selectionPolicyDigest === null)
    || (sixStep.windowSelectionRoot === null) !== (eligibleSuccessCount === null)
    || (sixStep.windowSelectionRoot === null) !== (sixStep.eligibleSuccessRoot === null)
    || (sixStep.selectedIndex === null) !== (sixStep.selectedProducerTerminalId === null)
    || (!hasSelection && hasSelectedTerminal)
    || (hasSelection && eligibleSuccessCount === "0" && hasSelectedTerminal)
    || (hasSelection && eligibleSuccessCount !== "0" && !hasSelectedTerminal)
    || (sixStep.status === "observed" && (!hasSelection || eligibleSuccessCount === "0" || !hasSelectedTerminal || sixStep.reason !== null))
    || (sixStep.status !== "observed" && (typeof sixStep.reason !== "string" || sixStep.reason.length === 0))
    || (sixStep.status === "observed" && !hasJoinedProcessEvidence)
    || (sixStep.status !== "observed" && hasPartialJoinedProcessEvidence)
    || (sixStep.status === "observed" && (predicateArtifactCount === "0" || eventArtifactRefIds.length === 0))
    || (sixStep.status !== "observed" && (predicateArtifactCount !== "0" || eventArtifactRefIds.length !== 0))
    || (sixStep.status === "missing" && !missingReasons.has(sixStep.reason as string))
    || (sixStep.status === "invalid" && !invalidReasons.has(sixStep.reason as string))
    || (sixStep.reason === "no-successful-dry-run"
      && (!hasSelection || eligibleSuccessCount !== "0" || hasSelectedTerminal))
    || (sixStep.reason === "window-selection-capability-invalid" && hasSelection)
    || (sixStep.reason !== "no-successful-dry-run"
      && sixStep.reason !== "window-selection-capability-invalid"
      && (!hasSelection || eligibleSuccessCount === "0" || !hasSelectedTerminal))) {
    throw new TypeError("terminalPhaseManifest Six-Step selection fields are inconsistent");
  }
  const normalized = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.production-terminal-phase-manifest-v1" as const,
    finalDurableWindowId: assertHash(manifest.finalDurableWindowId, "terminalPhaseManifest.finalDurableWindowId"),
    windowId: assertHash(manifest.windowId, "terminalPhaseManifest.windowId"),
    releaseAnchorRoot: assertHash(manifest.releaseAnchorRoot, "terminalPhaseManifest.releaseAnchorRoot"),
    runtimeAnchorRoot: assertHash(manifest.runtimeAnchorRoot, "terminalPhaseManifest.runtimeAnchorRoot"),
    runtimeArtifactRoot: assertHash(manifest.runtimeArtifactRoot, "terminalPhaseManifest.runtimeArtifactRoot"),
    processAnchorRoot: assertHash(manifest.processAnchorRoot, "terminalPhaseManifest.processAnchorRoot"),
    fullGraphCoarseSweepRoot: assertHash(manifest.fullGraphCoarseSweepRoot, "terminalPhaseManifest.fullGraphCoarseSweepRoot"),
    terminalPhaseInvocationRoot: assertHash(manifest.terminalPhaseInvocationRoot, "terminalPhaseManifest.terminalPhaseInvocationRoot"),
    fullFamily: Object.freeze({
      projectionArtifactRefId: assertHash(
        fullFamily.projectionArtifactRefId,
        "terminalPhaseManifest.fullFamily.projectionArtifactRefId",
      ),
      projectionContentSha256: assertHash(
        fullFamily.projectionContentSha256,
        "terminalPhaseManifest.fullFamily.projectionContentSha256",
      ),
    }),
    sixStep: Object.freeze({
      status: sixStep.status as ProductionTerminalPhaseManifestV1["sixStep"]["status"],
      observationRoot: assertHash(sixStep.observationRoot, "terminalPhaseManifest.sixStep.observationRoot"),
      windowSelectionRoot: exactNullableHash(sixStep.windowSelectionRoot, "terminalPhaseManifest.sixStep.windowSelectionRoot"),
      selectionPolicyDigest: exactNullableHash(sixStep.selectionPolicyDigest, "terminalPhaseManifest.sixStep.selectionPolicyDigest"),
      eligibleSuccessCount,
      eligibleSuccessRoot: exactNullableHash(sixStep.eligibleSuccessRoot, "terminalPhaseManifest.sixStep.eligibleSuccessRoot"),
      selectedIndex: sixStep.selectedIndex === null ? null : sixStep.selectedIndex as "0",
      selectedProducerTerminalId: exactNullableHash(sixStep.selectedProducerTerminalId, "terminalPhaseManifest.sixStep.selectedProducerTerminalId"),
      reason: sixStep.reason as string | null,
      joinedProcessEvidenceRoot: exactNullableHash(sixStep.joinedProcessEvidenceRoot, "terminalPhaseManifest.sixStep.joinedProcessEvidenceRoot"),
      performanceAppendRecordId: exactNullableHash(sixStep.performanceAppendRecordId, "terminalPhaseManifest.sixStep.performanceAppendRecordId"),
      producerTerminalAppendRecordId: exactNullableHash(sixStep.producerTerminalAppendRecordId, "terminalPhaseManifest.sixStep.producerTerminalAppendRecordId"),
      predicateArtifactCount,
      predicateArtifactRoot: assertHash(sixStep.predicateArtifactRoot, "terminalPhaseManifest.sixStep.predicateArtifactRoot"),
      eventArtifactRefIds,
    }),
  });
  const manifestRoot = assertHash(manifest.manifestRoot, "terminalPhaseManifest.manifestRoot");
  if (manifestRoot !== hashDomain("aloha/production-terminal-phase-manifest/v1", normalized as unknown as CanonicalJson)) {
    throw new TypeError("terminalPhaseManifest.manifestRoot mismatch");
  }
  return Object.freeze({ ...normalized, manifestRoot });
}

export function decodeProductionTerminalPhaseLocatorV1(
  value: unknown,
): ProductionTerminalPhaseLocatorV1 {
  const locator = record(value, "terminalPhaseLocator");
  assertExactKeys(locator, [
    "schemaVersion", "kind", "finalDurableWindowId", "terminalPhaseInvocationRoot", "manifestRoot",
    "manifestArtifactRefId", "manifestContentSha256", "locatorRoot",
  ], "terminalPhaseLocator");
  if (locator.schemaVersion !== 1 || locator.kind !== "aloha.production-terminal-phase-locator-v1") {
    throw new TypeError("terminalPhaseLocator kind/version mismatch");
  }
  const payload = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.production-terminal-phase-locator-v1" as const,
    finalDurableWindowId: assertHash(locator.finalDurableWindowId, "terminalPhaseLocator.finalDurableWindowId"),
    terminalPhaseInvocationRoot: assertHash(locator.terminalPhaseInvocationRoot, "terminalPhaseLocator.terminalPhaseInvocationRoot"),
    manifestRoot: assertHash(locator.manifestRoot, "terminalPhaseLocator.manifestRoot"),
    manifestArtifactRefId: assertHash(locator.manifestArtifactRefId, "terminalPhaseLocator.manifestArtifactRefId"),
    manifestContentSha256: assertHash(locator.manifestContentSha256, "terminalPhaseLocator.manifestContentSha256"),
  });
  const locatorRoot = assertHash(locator.locatorRoot, "terminalPhaseLocator.locatorRoot");
  if (locatorRoot !== hashDomain("aloha/production-terminal-phase-locator/v1", payload)) {
    throw new TypeError("terminalPhaseLocator.locatorRoot mismatch");
  }
  return Object.freeze({ ...payload, locatorRoot });
}

function decodeIndex(value: unknown): ProductionTerminalPhaseLocatorIndexRecordV1 {
  const index = record(value, "terminalPhaseLocatorIndex");
  assertExactKeys(index, [
    "schemaVersion", "kind", "finalDurableWindowId", "locatorRoot", "locatorContentSha256",
    "locatorArtifactRefId", "locatorArtifact", "manifestRoot", "manifestContentSha256", "manifestArtifact",
    "fullFamilyProjectionArtifact", "fullFamilyTerminalBindingArtifact", "fullGraphCoarseSweepArtifact",
    "fullFamilyPredicateArtifacts", "fullFamilyBundleArtifact", "fullFamilyLocatorArtifact", "sixStepTerminalBindingArtifact",
    "sixStepPredicateArtifacts", "selectedProcessArtifact", "indexRoot",
  ], "terminalPhaseLocatorIndex");
  if (index.schemaVersion !== 1 || index.kind !== "aloha.production-terminal-phase-locator-index-v1") {
    throw new TypeError("terminalPhaseLocatorIndex kind/version mismatch");
  }
  const payload = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.production-terminal-phase-locator-index-v1" as const,
    finalDurableWindowId: assertHash(index.finalDurableWindowId, "terminalPhaseLocatorIndex.finalDurableWindowId"),
    locatorRoot: assertHash(index.locatorRoot, "terminalPhaseLocatorIndex.locatorRoot"),
    locatorContentSha256: assertHash(index.locatorContentSha256, "terminalPhaseLocatorIndex.locatorContentSha256"),
    locatorArtifactRefId: assertHash(index.locatorArtifactRefId, "terminalPhaseLocatorIndex.locatorArtifactRefId"),
    locatorArtifact: decodeIndexedArtifact(index.locatorArtifact, "terminalPhaseLocatorIndex.locatorArtifact"),
    manifestRoot: assertHash(index.manifestRoot, "terminalPhaseLocatorIndex.manifestRoot"),
    manifestContentSha256: assertHash(index.manifestContentSha256, "terminalPhaseLocatorIndex.manifestContentSha256"),
    manifestArtifact: decodeIndexedArtifact(index.manifestArtifact, "terminalPhaseLocatorIndex.manifestArtifact"),
    fullFamilyProjectionArtifact: decodeIndexedArtifact(
      index.fullFamilyProjectionArtifact,
      "terminalPhaseLocatorIndex.fullFamilyProjectionArtifact",
    ),
    fullFamilyTerminalBindingArtifact: decodeIndexedArtifact(
      index.fullFamilyTerminalBindingArtifact,
      "terminalPhaseLocatorIndex.fullFamilyTerminalBindingArtifact",
    ),
    fullGraphCoarseSweepArtifact: decodeIndexedArtifact(
      index.fullGraphCoarseSweepArtifact,
      "terminalPhaseLocatorIndex.fullGraphCoarseSweepArtifact",
    ),
    fullFamilyPredicateArtifacts: (() => {
      if (!Array.isArray(index.fullFamilyPredicateArtifacts)) {
        throw new TypeError("terminalPhaseLocatorIndex.fullFamilyPredicateArtifacts must be an array");
      }
      let previous: Hash | null = null;
      return Object.freeze(index.fullFamilyPredicateArtifacts.map((value, position) => {
        const artifact = decodeIndexedArtifact(value, `terminalPhaseLocatorIndex.fullFamilyPredicateArtifacts[${position}]`);
        if (previous !== null && previous >= artifact.ref.artifactRefId) {
          throw new TypeError("terminalPhaseLocatorIndex Full-Family predicate artifacts are not exact-sorted");
        }
        previous = artifact.ref.artifactRefId;
        return artifact;
      }));
    })(),
    fullFamilyBundleArtifact: decodeNullableIndexedArtifact(
      index.fullFamilyBundleArtifact,
      "terminalPhaseLocatorIndex.fullFamilyBundleArtifact",
    ),
    fullFamilyLocatorArtifact: decodeNullableIndexedArtifact(
      index.fullFamilyLocatorArtifact,
      "terminalPhaseLocatorIndex.fullFamilyLocatorArtifact",
    ),
    sixStepTerminalBindingArtifact: decodeNullableIndexedArtifact(
      index.sixStepTerminalBindingArtifact,
      "terminalPhaseLocatorIndex.sixStepTerminalBindingArtifact",
    ),
    sixStepPredicateArtifacts: (() => {
      if (!Array.isArray(index.sixStepPredicateArtifacts)) {
        throw new TypeError("terminalPhaseLocatorIndex.sixStepPredicateArtifacts must be an array");
      }
      let previous: Hash | null = null;
      return Object.freeze(index.sixStepPredicateArtifacts.map((value, position) => {
        const artifact = decodeIndexedArtifact(value, `terminalPhaseLocatorIndex.sixStepPredicateArtifacts[${position}]`);
        if (previous !== null && previous >= artifact.ref.artifactRefId) {
          throw new TypeError("terminalPhaseLocatorIndex Six-Step predicate artifacts are not exact-sorted");
        }
        previous = artifact.ref.artifactRefId;
        return artifact;
      }));
    })(),
    selectedProcessArtifact: decodeIndexedProcessArtifact(index.selectedProcessArtifact),
  });
  if (payload.locatorArtifact.contentSha256 !== payload.locatorContentSha256
    || payload.locatorArtifact.ref.artifactRefId !== payload.locatorArtifactRefId
    || payload.manifestArtifact.contentSha256 !== payload.manifestContentSha256) {
    throw new TypeError("terminalPhaseLocatorIndex locator/manifest artifact identity mismatch");
  }
  const indexRoot = assertHash(index.indexRoot, "terminalPhaseLocatorIndex.indexRoot");
  if (indexRoot !== hashDomain("aloha/production-terminal-phase-locator-index/v1", payload)) {
    throw new TypeError("terminalPhaseLocatorIndex.indexRoot mismatch");
  }
  return Object.freeze({ ...payload, indexRoot });
}

async function unlinkIfPresent(path: string): Promise<void> {
  try { await unlink(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function readSnapshotLedgerRange(
  trust: ProductionTerminalPhaseSnapshotTrustStateV1,
  locator: Extract<ReadOnlyArtifactRefV1["locator"], { readonly kind: "file-range" }>,
  expectedContentSha256: Hash,
  expectedByteLength: string,
): Uint8Array {
  const ledger = trust.sixStepSourceLedger;
  if (locator.device !== ledger.sourceDevice || locator.inode !== ledger.sourceInode || ledger.fsynced !== true) {
    throw new TypeError("terminal-phase Six-Step source locator is outside the frozen ledger");
  }
  const start = BigInt(assertDecimalString(locator.startInclusive, "sixStepSnapshotLocator.startInclusive"));
  const end = BigInt(assertDecimalString(locator.endExclusive, "sixStepSnapshotLocator.endExclusive"));
  if (end < start || end - start !== BigInt(expectedByteLength) || end > BigInt(ledger.byteLength)
    || end > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TypeError("terminal-phase Six-Step source locator range is invalid");
  }
  const descriptor = openSync(ledger.snapshotPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.dev.toString() !== ledger.snapshotDevice
      || before.ino.toString() !== ledger.snapshotInode || before.size.toString() !== ledger.byteLength) {
      throw new TypeError("terminal-phase Six-Step source-ledger snapshot identity changed");
    }
    const bytes = Buffer.alloc(Number(end - start));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const read = readSync(descriptor, bytes, offset, bytes.byteLength - offset, Number(start) + offset);
      if (read === 0) throw new TypeError("terminal-phase Six-Step source-ledger snapshot was truncated");
      offset += read;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || sha256Hex(bytes) !== expectedContentSha256) {
      throw new TypeError("terminal-phase Six-Step source-ledger range content changed");
    }
    return new Uint8Array(bytes);
  } finally {
    closeSync(descriptor);
  }
}

function readSnapshotBoundaryMaterials(
  trust: ProductionTerminalPhaseSnapshotTrustStateV1,
): readonly ProductionSixStepArtifactMaterialV1[] {
  const names = readdirSync(trust.sixStepBoundaryDirectory).sort();
  if (names.length !== trust.sixStepBoundaryFiles.length
    || names.some((name, index) => name !== trust.sixStepBoundaryFiles[index]?.name)) {
    throw new TypeError("terminal-phase Six-Step boundary snapshot denominator changed");
  }
  const materials = trust.sixStepBoundaryFiles.map((entry, index) => {
    const path = join(trust.sixStepBoundaryDirectory, entry.name);
    const before = statSync(path, { bigint: true });
    const bytes = new Uint8Array(readFileSync(path));
    const after = statSync(path, { bigint: true });
    if (!before.isFile() || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || after.dev.toString() !== entry.device || after.ino.toString() !== entry.inode
      || bytes.byteLength.toString() !== entry.byteLength || sha256Hex(bytes) !== entry.contentSha256
      || entry.fsynced !== true) {
      throw new TypeError(`terminal-phase Six-Step boundary snapshot entry[${index}] changed`);
    }
    const material = decodeProductionSixStepArtifactMaterialV1(deserialize(bytes));
    if (`${material.boundaryKey.slice(2)}.v8` !== entry.name) {
      throw new TypeError("terminal-phase Six-Step boundary snapshot key/name mismatch");
    }
    return material;
  });
  const entrySetRoot = hashDomain("aloha/pre-release-directory-snapshot-entry-set/v1", {
    snapshotKind: "six-step-boundaries",
    observerStoreIdentityHash: null,
    entries: trust.sixStepBoundaryFiles.map(entry => ({
      name: entry.name,
      contentSha256: entry.contentSha256,
      byteLength: entry.byteLength,
    })),
  });
  if (entrySetRoot !== trust.sixStepBoundaryEntrySetRoot) {
    throw new TypeError("terminal-phase Six-Step boundary snapshot root mismatch");
  }
  return Object.freeze(materials);
}

export class ProductionTerminalPhaseLocatorIndexV1 {
  readonly #directory: string;
  readonly #sink: ContentAddressedObserverSinkV1;
  #physicalDirectory: string | null = null;
  readonly #published = new Map<Hash, Readonly<{
    readonly indexRoot: Hash;
    readonly indexContentSha256: Hash;
    readonly indexByteLength: string;
    readonly generatedRuntimeMetadata: FullFamilyGeneratedRuntimeMetadataV1 | null;
    readonly sixStepArtifactMaterials: readonly ProductionSixStepArtifactMaterialV1[] | null;
  }>>();

  constructor(input: Readonly<{ readonly directory: string; readonly sink: ContentAddressedObserverSinkV1 }>) {
    if (input === null || typeof input !== "object" || Reflect.ownKeys(input).length !== 2
      || !Object.prototype.hasOwnProperty.call(input, "directory")
      || !Object.prototype.hasOwnProperty.call(input, "sink")) {
      throw new TypeError("terminal-phase locator index options are non-exact");
    }
    if (typeof input.directory !== "string" || !resolve(input.directory).startsWith("/")) {
      throw new TypeError("terminal-phase locator index directory must be absolute");
    }
    if (!(input.sink instanceof ContentAddressedObserverSinkV1)) {
      throw new TypeError("terminal-phase locator index requires collector-owned sink");
    }
    this.#directory = resolve(input.directory);
    this.#sink = input.sink;
  }

  async #initialize(): Promise<string> {
    if (this.#physicalDirectory !== null) return this.#physicalDirectory;
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const physical = await realpath(this.#directory);
    const metadata = await lstat(physical);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new TypeError("terminal-phase locator index is not a physical directory");
    this.#physicalDirectory = physical;
    return physical;
  }

  async #path(finalDurableWindowId: Hash): Promise<string> {
    const id = assertHash(finalDurableWindowId, "terminalPhaseLocatorIndex.finalDurableWindowId");
    const directory = await this.#initialize();
    const name = `${id.slice(2)}.json`;
    const path = join(directory, name);
    if (dirname(path) !== directory || basename(path) !== name) throw new TypeError("terminal-phase locator index path escaped its directory");
    return path;
  }

  async publish(input: Readonly<{
    readonly manifest: ProductionTerminalPhaseManifestV1;
    readonly manifestArtifact: ObservedContentArtifactV1;
    readonly locator: ProductionTerminalPhaseLocatorV1;
    readonly locatorArtifact: ObservedContentArtifactV1;
    readonly fullFamilyProjectionArtifact: ObservedContentArtifactV1;
    readonly fullFamilyTerminalBindingArtifact: ObservedContentArtifactV1;
    readonly fullGraphCoarseSweepArtifact: ObservedContentArtifactV1;
    readonly fullFamilyPredicateArtifacts: readonly ObservedContentArtifactV1[];
    readonly selectedProcessArtifact: ObservedContentArtifactV1 | null;
    readonly fullFamilyBundleArtifact: ObservedContentArtifactV1 | null;
    readonly fullFamilyLocatorArtifact: ObservedContentArtifactV1 | null;
    readonly sixStepTerminalBindingArtifact: ObservedContentArtifactV1 | null;
    readonly sixStepPredicateArtifacts: readonly ObservedContentArtifactV1[];
    readonly sixStepArtifactMaterials: readonly ProductionSixStepArtifactMaterialV1[];
    readonly generatedRuntimeMetadata: FullFamilyGeneratedRuntimeMetadataV1 | null;
  }>): Promise<ProductionTerminalPhaseLocatorIndexRecordV1> {
    assertExactKeys(input, [
      "manifest", "manifestArtifact", "locator", "locatorArtifact", "selectedProcessArtifact",
      "fullFamilyProjectionArtifact", "fullFamilyTerminalBindingArtifact", "fullGraphCoarseSweepArtifact",
      "fullFamilyPredicateArtifacts", "fullFamilyBundleArtifact", "fullFamilyLocatorArtifact", "sixStepTerminalBindingArtifact",
      "sixStepPredicateArtifacts", "sixStepArtifactMaterials", "generatedRuntimeMetadata",
    ], "terminalPhaseLocatorIndex.publish");
    const manifest = decodeProductionTerminalPhaseManifestV1(input.manifest);
    const locator = decodeProductionTerminalPhaseLocatorV1(input.locator);
    const manifestBytes = encodeCanonicalBytes(manifest);
    const locatorBytes = encodeCanonicalBytes(locator);
    const manifestContentSha256 = assertHash(
      input.manifestArtifact.contentSha256,
      "terminalPhaseLocatorIndex.manifestArtifact.contentSha256",
    );
    const locatorContentSha256 = assertHash(
      input.locatorArtifact.contentSha256,
      "terminalPhaseLocatorIndex.locatorArtifact.contentSha256",
    );
    const manifestRef = decodeReadOnlyArtifactRef(input.manifestArtifact.ref);
    const locatorRef = decodeReadOnlyArtifactRef(input.locatorArtifact.ref);
    const indexedManifestArtifact = decodeIndexedArtifact({
      contentSha256: input.manifestArtifact.contentSha256,
      ref: input.manifestArtifact.ref,
      claim: input.manifestArtifact.claim,
      lease: input.manifestArtifact.lease,
    }, "terminalPhaseLocatorIndex.manifestArtifact");
    const indexedLocatorArtifact = decodeIndexedArtifact({
      contentSha256: input.locatorArtifact.contentSha256,
      ref: input.locatorArtifact.ref,
      claim: input.locatorArtifact.claim,
      lease: input.locatorArtifact.lease,
    }, "terminalPhaseLocatorIndex.locatorArtifact");
    const persistedManifestBytes = await exactIndexedArtifactBytes(
      this.#sink,
      indexedManifestArtifact,
      input.manifestArtifact,
      "terminal-phase locator index manifest artifact",
    );
    const persistedLocatorBytes = await exactIndexedArtifactBytes(
      this.#sink,
      indexedLocatorArtifact,
      input.locatorArtifact,
      "terminal-phase locator index locator artifact",
    );
    if (!sameBytes(input.manifestArtifact.bytes, manifestBytes)
      || !sameBytes(persistedManifestBytes, manifestBytes)
      || sha256Hex(manifestBytes) !== manifestContentSha256
      || manifestRef.contentSha256 !== manifestContentSha256
      || manifestRef.byteLength !== manifestBytes.byteLength.toString()) {
      throw new TypeError("terminal-phase locator index manifest bytes/ref mismatch");
    }
    if (!sameBytes(input.locatorArtifact.bytes, locatorBytes)
      || !sameBytes(persistedLocatorBytes, locatorBytes)
      || sha256Hex(locatorBytes) !== locatorContentSha256
      || locatorRef.contentSha256 !== locatorContentSha256
      || locatorRef.byteLength !== locatorBytes.byteLength.toString()) {
      throw new TypeError("terminal-phase locator index locator bytes/ref mismatch");
    }
    if (locator.finalDurableWindowId !== manifest.finalDurableWindowId
      || locator.manifestRoot !== manifest.manifestRoot
      || locator.manifestArtifactRefId !== manifestRef.artifactRefId
      || locator.manifestContentSha256 !== manifestContentSha256) {
      throw new TypeError("terminal-phase locator index artifact lineage mismatch");
    }
    const indexedOptional = (artifact: ObservedContentArtifactV1 | null, label: string) => artifact === null
      ? null
      : decodeIndexedArtifact({
          contentSha256: artifact.contentSha256,
          ref: artifact.ref,
          claim: artifact.claim,
          lease: artifact.lease,
        }, label);
    const fullFamilyProjectionArtifact = decodeIndexedArtifact({
      contentSha256: input.fullFamilyProjectionArtifact.contentSha256,
      ref: input.fullFamilyProjectionArtifact.ref,
      claim: input.fullFamilyProjectionArtifact.claim,
      lease: input.fullFamilyProjectionArtifact.lease,
    }, "terminalPhaseLocatorIndex.fullFamilyProjectionArtifact");
    const fullFamilyTerminalBindingArtifact = decodeIndexedArtifact({
      contentSha256: input.fullFamilyTerminalBindingArtifact.contentSha256,
      ref: input.fullFamilyTerminalBindingArtifact.ref,
      claim: input.fullFamilyTerminalBindingArtifact.claim,
      lease: input.fullFamilyTerminalBindingArtifact.lease,
    }, "terminalPhaseLocatorIndex.fullFamilyTerminalBindingArtifact");
    const fullGraphCoarseSweepArtifact = decodeIndexedArtifact({
      contentSha256: input.fullGraphCoarseSweepArtifact.contentSha256,
      ref: input.fullGraphCoarseSweepArtifact.ref,
      claim: input.fullGraphCoarseSweepArtifact.claim,
      lease: input.fullGraphCoarseSweepArtifact.lease,
    }, "terminalPhaseLocatorIndex.fullGraphCoarseSweepArtifact");
    const fullFamilyPredicateArtifacts = Object.freeze(input.fullFamilyPredicateArtifacts.map((artifact, position) =>
      decodeIndexedArtifact({
        contentSha256: artifact.contentSha256,
        ref: artifact.ref,
        claim: artifact.claim,
        lease: artifact.lease,
      }, `terminalPhaseLocatorIndex.fullFamilyPredicateArtifacts[${position}]`)));
    const fullFamilyBundleArtifact = indexedOptional(input.fullFamilyBundleArtifact, "terminalPhaseLocatorIndex.fullFamilyBundleArtifact");
    const fullFamilyLocatorArtifact = indexedOptional(input.fullFamilyLocatorArtifact, "terminalPhaseLocatorIndex.fullFamilyLocatorArtifact");
    const sixStepTerminalBindingArtifact = indexedOptional(input.sixStepTerminalBindingArtifact, "terminalPhaseLocatorIndex.sixStepTerminalBindingArtifact");
    const sixStepPredicateArtifacts = Object.freeze(input.sixStepPredicateArtifacts.map((artifact, position) =>
      decodeIndexedArtifact({
        contentSha256: artifact.contentSha256,
        ref: artifact.ref,
        claim: artifact.claim,
        lease: artifact.lease,
      }, `terminalPhaseLocatorIndex.sixStepPredicateArtifacts[${position}]`)));
    if (sixStepPredicateArtifacts.some((artifact, position) => position > 0
      && artifact.ref.artifactRefId <= sixStepPredicateArtifacts[position - 1]!.ref.artifactRefId)) {
      throw new TypeError("terminalPhaseLocatorIndex Six-Step predicate artifacts are not exact-sorted");
    }
    const selectedProcessArtifact = indexedOptional(input.selectedProcessArtifact, "terminalPhaseLocatorIndex.selectedProcessArtifact");
    const exactOptionalBytes = async (
      indexed: ProductionTerminalPhaseLocatorIndexRecordV1["selectedProcessArtifact"],
      supplied: ObservedContentArtifactV1 | null,
      label: string,
    ) => indexed === null ? null : exactIndexedArtifactBytes(this.#sink, indexed, supplied, label);
    const fullFamilyProjectionBytes = await exactIndexedArtifactBytes(
      this.#sink,
      fullFamilyProjectionArtifact,
      input.fullFamilyProjectionArtifact,
      "terminal-phase Full-Family projection artifact",
    );
    const fullFamilyTerminalBindingBytes = await exactIndexedArtifactBytes(
      this.#sink,
      fullFamilyTerminalBindingArtifact,
      input.fullFamilyTerminalBindingArtifact,
      "terminal-phase Full-Family terminal-binding artifact",
    );
    const fullGraphCoarseSweepBytes = await exactIndexedArtifactBytes(
      this.#sink,
      fullGraphCoarseSweepArtifact,
      input.fullGraphCoarseSweepArtifact,
      "terminal-phase full-Graph coarse-sweep artifact",
    );
    const fullFamilyPredicateArtifactBytes = await Promise.all(fullFamilyPredicateArtifacts.map((artifact, position) =>
      exactIndexedArtifactBytes(
        this.#sink,
        artifact,
        input.fullFamilyPredicateArtifacts[position] ?? null,
        `terminal-phase Full-Family predicate artifact[${position}]`,
      )));
    const fullFamilyBundleBytes = await exactOptionalBytes(
      fullFamilyBundleArtifact,
      input.fullFamilyBundleArtifact,
      "terminal-phase Full-Family bundle artifact",
    );
    const fullFamilyLocatorBytes = await exactOptionalBytes(
      fullFamilyLocatorArtifact,
      input.fullFamilyLocatorArtifact,
      "terminal-phase Full-Family locator artifact",
    );
    const sixStepTerminalBindingBytes = await exactOptionalBytes(
      sixStepTerminalBindingArtifact,
      input.sixStepTerminalBindingArtifact,
      "terminal-phase Six-Step terminal-binding artifact",
    );
    const selectedProcessBytes = await exactOptionalBytes(
      selectedProcessArtifact,
      input.selectedProcessArtifact,
      "terminal-phase selected process artifact",
    );
    const sixStepPredicateArtifactBytes = await Promise.all(sixStepPredicateArtifacts.map((artifact, position) =>
      exactIndexedSixStepArtifactBytes(
        this.#sink,
        artifact,
        input.sixStepPredicateArtifacts[position] ?? null,
        `terminal-phase Six-Step predicate artifact[${position}]`,
      )));
    assertFullFamilyArtifactsManifestJoin(
      manifest,
      fullFamilyProjectionArtifact,
      fullFamilyProjectionBytes,
      fullFamilyBundleArtifact,
      fullFamilyBundleBytes,
      fullFamilyLocatorArtifact,
      fullFamilyLocatorBytes,
      fullFamilyTerminalBindingArtifact,
      fullFamilyTerminalBindingBytes,
      fullGraphCoarseSweepArtifact,
      fullGraphCoarseSweepBytes,
      fullFamilyPredicateArtifacts,
      fullFamilyPredicateArtifactBytes,
      input.generatedRuntimeMetadata,
    );
    const sixStepEventFacts = assertSixStepArtifactsManifestJoin(
      manifest,
      sixStepTerminalBindingArtifact,
      sixStepTerminalBindingBytes,
      selectedProcessArtifact,
      selectedProcessBytes,
      sixStepPredicateArtifacts,
      sixStepPredicateArtifactBytes,
    );
    exactSixStepArtifactMaterials(
      sixStepEventFacts,
      sixStepPredicateArtifacts,
      sixStepPredicateArtifactBytes,
      input.sixStepArtifactMaterials,
    );
    const payload = Object.freeze({
      schemaVersion: 1 as const,
      kind: "aloha.production-terminal-phase-locator-index-v1" as const,
      finalDurableWindowId: manifest.finalDurableWindowId,
      locatorRoot: locator.locatorRoot,
      locatorContentSha256,
      locatorArtifactRefId: locatorRef.artifactRefId,
      locatorArtifact: indexedLocatorArtifact,
      manifestRoot: manifest.manifestRoot,
      manifestContentSha256,
      manifestArtifact: indexedManifestArtifact,
      fullFamilyProjectionArtifact,
      fullFamilyTerminalBindingArtifact,
      fullGraphCoarseSweepArtifact,
      fullFamilyPredicateArtifacts,
      fullFamilyBundleArtifact,
      fullFamilyLocatorArtifact,
      sixStepTerminalBindingArtifact,
      sixStepPredicateArtifacts,
      selectedProcessArtifact,
    });
    const index = Object.freeze({
      ...payload,
      indexRoot: hashDomain("aloha/production-terminal-phase-locator-index/v1", payload),
    });
    const bytes = encodeCanonicalBytes(index);
    const destination = await this.#path(index.finalDurableWindowId);
    const temporary = `${destination}.${process.pid}.${temporarySequence++}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = null;
      try { await link(temporary, destination); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      await unlinkIfPresent(temporary);
      const directoryHandle = await open(dirname(destination), constants.O_RDONLY);
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
      const persisted = new Uint8Array(await readFile(destination));
      if (!sameBytes(persisted, bytes)) throw new TypeError("terminal-phase locator index conflicts with its immutable window key");
      const decoded = decodeIndex(decodeCanonicalBytes(persisted));
      this.#published.set(decoded.finalDurableWindowId, Object.freeze({
        indexRoot: decoded.indexRoot,
        indexContentSha256: sha256Hex(persisted),
        indexByteLength: String(persisted.byteLength),
        generatedRuntimeMetadata: input.generatedRuntimeMetadata,
        sixStepArtifactMaterials: Object.freeze([...input.sixStepArtifactMaterials]),
      }));
      return decoded;
    } finally {
      if (handle !== null) await handle.close();
      await unlinkIfPresent(temporary);
    }
  }

  async read(finalDurableWindowId: Hash): Promise<ProductionTerminalPhaseDurableDiscoveryV1> {
    const expected = this.#published.get(assertHash(finalDurableWindowId, "terminalPhaseLocatorIndex.finalDurableWindowId"));
    if (expected === undefined) {
      throw new TypeError("terminal-phase locator read was not authorized by this process publication");
    }
    return this.#readAuthorized(finalDurableWindowId, expected, null);
  }

  async readSnapshot(
    capability: ProductionTerminalPhaseSnapshotTrustCapabilityV1,
  ): Promise<ProductionTerminalPhaseDurableDiscoveryV1> {
    const trust = readProductionTerminalPhaseSnapshotTrustCapabilityV1(capability);
    if (this.#directory !== trust.terminalLocatorDirectory
      || this.#sink.directory !== trust.observerContentDirectory
      || this.#sink.storeIdentityHash !== trust.observerStoreIdentityHash) {
      throw new TypeError("terminal-phase snapshot trust directories/store identity mismatch");
    }
    return this.#readAuthorized(trust.finalDurableWindowId, Object.freeze({
      indexRoot: trust.indexRoot,
      indexContentSha256: trust.indexContentSha256,
      indexByteLength: trust.indexByteLength,
      generatedRuntimeMetadata: trust.generatedRuntimeMetadata,
      sixStepArtifactMaterials: null,
    }), trust);
  }

  async #readAuthorized(
    finalDurableWindowId: Hash,
    expected: Readonly<{
      readonly indexRoot: Hash;
      readonly indexContentSha256: Hash;
      readonly indexByteLength: string;
      readonly generatedRuntimeMetadata: FullFamilyGeneratedRuntimeMetadataV1 | null;
      readonly sixStepArtifactMaterials: readonly ProductionSixStepArtifactMaterialV1[] | null;
    }>,
    snapshotTrust: ProductionTerminalPhaseSnapshotTrustStateV1 | null,
  ): Promise<ProductionTerminalPhaseDurableDiscoveryV1> {
    const path = await this.#path(finalDurableWindowId);
    const indexHandle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const { metadata, indexBytes } = await (async () => {
      try {
        const before = await indexHandle.stat({ bigint: true });
        if (!before.isFile() || before.isSymbolicLink()) {
          throw new TypeError("terminal-phase locator index entry is not a physical file");
        }
        const bytes = new Uint8Array(await indexHandle.readFile());
        const after = await indexHandle.stat({ bigint: true });
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
          || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
          || after.size !== BigInt(bytes.byteLength)) {
          throw new TypeError("terminal-phase locator index entry changed while being read");
        }
        return Object.freeze({ metadata: after, indexBytes: bytes });
      } finally {
        await indexHandle.close();
      }
    })();
    const index = decodeIndex(decodeCanonicalBytes(indexBytes));
    if (index.finalDurableWindowId !== finalDurableWindowId
      || index.indexRoot !== expected.indexRoot
      || sha256Hex(indexBytes) !== expected.indexContentSha256
      || String(indexBytes.byteLength) !== expected.indexByteLength) {
      throw new TypeError("terminal-phase locator index window/trust-root mismatch");
    }
    const locatorBytes = await exactIndexedArtifactBytes(
      this.#sink,
      index.locatorArtifact,
      null,
      "terminal-phase locator restart artifact",
    );
    const locator = decodeProductionTerminalPhaseLocatorV1(decodeCanonicalBytes(locatorBytes));
    if (locator.finalDurableWindowId !== index.finalDurableWindowId
      || locator.locatorRoot !== index.locatorRoot
      || locator.manifestRoot !== index.manifestRoot
      || locator.manifestContentSha256 !== index.manifestContentSha256
      || index.locatorArtifact.ref.artifactRefId !== index.locatorArtifactRefId) {
      throw new TypeError("terminal-phase locator index/locator splice");
    }
    const manifestBytes = await exactIndexedArtifactBytes(
      this.#sink,
      index.manifestArtifact,
      null,
      "terminal-phase manifest restart artifact",
    );
    const manifest = decodeProductionTerminalPhaseManifestV1(decodeCanonicalBytes(manifestBytes));
    if (manifest.finalDurableWindowId !== locator.finalDurableWindowId
      || manifest.manifestRoot !== locator.manifestRoot
      || manifest.terminalPhaseInvocationRoot !== locator.terminalPhaseInvocationRoot
      || index.manifestArtifact.contentSha256 !== locator.manifestContentSha256
      || index.manifestArtifact.ref.artifactRefId !== locator.manifestArtifactRefId) {
      throw new TypeError("terminal-phase locator/manifest splice");
    }
    const readOptional = async (
      artifact: ProductionTerminalPhaseLocatorIndexRecordV1["selectedProcessArtifact"],
      label: string,
    ) => artifact === null ? null : exactIndexedArtifactBytes(this.#sink, artifact, null, label);
    const fullFamilyProjectionBytes = await exactIndexedArtifactBytes(
      this.#sink,
      index.fullFamilyProjectionArtifact,
      null,
      "terminal-phase Full-Family projection restart artifact",
    );
    const fullFamilyTerminalBindingBytes = await exactIndexedArtifactBytes(
      this.#sink,
      index.fullFamilyTerminalBindingArtifact,
      null,
      "terminal-phase Full-Family terminal-binding restart artifact",
    );
    const fullGraphCoarseSweepBytes = await exactIndexedArtifactBytes(
      this.#sink,
      index.fullGraphCoarseSweepArtifact,
      null,
      "terminal-phase full-Graph coarse-sweep restart artifact",
    );
    const fullFamilyPredicateArtifactBytes = await Promise.all(index.fullFamilyPredicateArtifacts.map((artifact, position) =>
      exactIndexedArtifactBytes(
        this.#sink,
        artifact,
        null,
        `terminal-phase Full-Family predicate restart artifact[${position}]`,
      )));
    const fullFamilyBundleBytes = await readOptional(
      index.fullFamilyBundleArtifact,
      "terminal-phase Full-Family bundle restart artifact",
    );
    const fullFamilyLocatorBytes = await readOptional(
      index.fullFamilyLocatorArtifact,
      "terminal-phase Full-Family locator restart artifact",
    );
    const sixStepTerminalBindingBytes = await readOptional(
      index.sixStepTerminalBindingArtifact,
      "terminal-phase Six-Step terminal-binding restart artifact",
    );
    const selectedProcessBytes = await readOptional(
      index.selectedProcessArtifact,
      "terminal-phase selected process restart artifact",
    );
    let sixStepPredicateArtifactBytes: readonly Uint8Array[] = Object.freeze([]);
    let sixStepPhysicalReason: string | null = null;
    try {
      sixStepPredicateArtifactBytes = Object.freeze(await Promise.all(index.sixStepPredicateArtifacts.map((artifact, position) =>
        exactIndexedSixStepArtifactBytes(
          this.#sink,
          artifact,
          null,
          `terminal-phase Six-Step predicate restart artifact[${position}]`,
          snapshotTrust,
        ))));
    } catch (error) {
      if (snapshotTrust === null) throw error;
      sixStepPhysicalReason = error instanceof Error ? error.message : "six-step-source-ledger-invalid";
    }
    const fullFamilyProjection = assertFullFamilyArtifactsManifestJoin(
      manifest,
      index.fullFamilyProjectionArtifact,
      fullFamilyProjectionBytes,
      index.fullFamilyBundleArtifact,
      fullFamilyBundleBytes,
      index.fullFamilyLocatorArtifact,
      fullFamilyLocatorBytes,
      index.fullFamilyTerminalBindingArtifact,
      fullFamilyTerminalBindingBytes,
      index.fullGraphCoarseSweepArtifact,
      fullGraphCoarseSweepBytes,
      index.fullFamilyPredicateArtifacts,
      fullFamilyPredicateArtifactBytes,
      expected.generatedRuntimeMetadata,
    );
    if (snapshotTrust !== null) {
      const terminal = fullFamilyTerminalIdentity(fullFamilyTerminalBindingBytes);
      const sweep = fullGraphCoarseSweepIdentity(fullGraphCoarseSweepBytes);
      const activeGraph = snapshotTrust.activeReadyGraph;
      const sweepFamilyCounts = (sweep.familyTransitionCounts as readonly Readonly<{
        readonly familyId: string;
        readonly expectedTransitionCount: string;
      }>[]).map(({ familyId, expectedTransitionCount }) => Object.freeze({ familyId, expectedTransitionCount }));
      assertActiveReadyGraphCoarseSweepDenominatorV1(activeGraph, {
        readyRecordHash: sweep.readyRecordHash,
        generationId: sweep.generationId,
        graphRoot: sweep.graphRoot,
        readyCutoff: sweep.readyCutoff as never,
        expectedTransitionCount: sweep.expectedTransitionCount,
        expectedTransitionRoot: sweep.expectedTransitionRoot,
        familyTransitionCounts: sweepFamilyCounts,
      });
      if (terminal.runtimeBindingId !== snapshotTrust.runtimeBindingId
        || terminal.candidateReleaseCommit !== snapshotTrust.candidateReleaseCommit
        || terminal.releaseProvenanceHash !== snapshotTrust.releaseProvenanceHash
        || sweep.runtimeBindingId !== snapshotTrust.runtimeBindingId
        || sweep.candidateReleaseCommit !== snapshotTrust.candidateReleaseCommit
        || sweep.releaseProvenanceHash !== snapshotTrust.releaseProvenanceHash) {
        throw new TypeError("terminal-phase snapshot trust/release binding splice");
      }
    }
    let sixStepEventFacts: readonly SixStepEventFactV1[] = Object.freeze([]);
    let sixStepArtifactMaterials: readonly ProductionSixStepArtifactMaterialV1[] = Object.freeze([]);
    if (sixStepPhysicalReason === null) {
      try {
        sixStepEventFacts = assertSixStepArtifactsManifestJoin(
          manifest,
          index.sixStepTerminalBindingArtifact,
          sixStepTerminalBindingBytes,
          index.selectedProcessArtifact,
          selectedProcessBytes,
          index.sixStepPredicateArtifacts,
          sixStepPredicateArtifactBytes,
        );
        const physicalMaterials = expected.sixStepArtifactMaterials
          ?? (snapshotTrust === null ? Object.freeze([]) : readSnapshotBoundaryMaterials(snapshotTrust));
        sixStepArtifactMaterials = exactSixStepArtifactMaterials(
          sixStepEventFacts,
          index.sixStepPredicateArtifacts,
          sixStepPredicateArtifactBytes,
          physicalMaterials,
        );
      } catch (error) {
        if (snapshotTrust === null) throw error;
        sixStepPhysicalReason = error instanceof Error ? error.message : "six-step-boundary-material-invalid";
        sixStepEventFacts = Object.freeze([]);
        sixStepArtifactMaterials = Object.freeze([]);
      }
    }
    const selectedProcessArtifact = index.selectedProcessArtifact === null || selectedProcessBytes === null
      ? null
      : Object.freeze({
          contentSha256: index.selectedProcessArtifact.contentSha256,
          bytes: selectedProcessBytes,
          ref: index.selectedProcessArtifact.ref,
          claim: index.selectedProcessArtifact.claim,
          lease: index.selectedProcessArtifact.lease,
        });
    const manifestArtifact = Object.freeze({
      contentSha256: index.manifestArtifact.contentSha256,
      bytes: manifestBytes,
      ref: index.manifestArtifact.ref,
      claim: index.manifestArtifact.claim,
      lease: index.manifestArtifact.lease,
    });
    const locatorArtifact = Object.freeze({
      contentSha256: index.locatorArtifact.contentSha256,
      bytes: locatorBytes,
      ref: index.locatorArtifact.ref,
      claim: index.locatorArtifact.claim,
      lease: index.locatorArtifact.lease,
    });
    const observedOptional = (artifact: ProductionTerminalPhaseLocatorIndexRecordV1["selectedProcessArtifact"], bytes: Uint8Array | null) =>
      artifact === null || bytes === null ? null : Object.freeze({
        contentSha256: artifact.contentSha256,
        bytes,
        ref: artifact.ref,
        claim: artifact.claim,
        lease: artifact.lease,
      });
    const fullFamilyBundleArtifact = observedOptional(index.fullFamilyBundleArtifact, fullFamilyBundleBytes);
    const fullFamilyLocatorArtifact = observedOptional(index.fullFamilyLocatorArtifact, fullFamilyLocatorBytes);
    const sixStepTerminalBindingArtifact = observedOptional(index.sixStepTerminalBindingArtifact, sixStepTerminalBindingBytes);
    const sixStepPredicateArtifacts = sixStepPhysicalReason === null ? Object.freeze(index.sixStepPredicateArtifacts.map((artifact, position) => Object.freeze({
      contentSha256: artifact.contentSha256,
      bytes: sixStepPredicateArtifactBytes[position]!,
      ref: artifact.ref,
      claim: artifact.claim,
      lease: artifact.lease,
    }))) : Object.freeze([]);
    const fullFamilyProjectionArtifact = Object.freeze({
      contentSha256: index.fullFamilyProjectionArtifact.contentSha256,
      bytes: fullFamilyProjectionBytes,
      ref: index.fullFamilyProjectionArtifact.ref,
      claim: index.fullFamilyProjectionArtifact.claim,
      lease: index.fullFamilyProjectionArtifact.lease,
    });
    const fullFamilyTerminalBindingArtifact = Object.freeze({
      contentSha256: index.fullFamilyTerminalBindingArtifact.contentSha256,
      bytes: fullFamilyTerminalBindingBytes,
      ref: index.fullFamilyTerminalBindingArtifact.ref,
      claim: index.fullFamilyTerminalBindingArtifact.claim,
      lease: index.fullFamilyTerminalBindingArtifact.lease,
    });
    const fullGraphCoarseSweepArtifact = Object.freeze({
      contentSha256: index.fullGraphCoarseSweepArtifact.contentSha256,
      bytes: fullGraphCoarseSweepBytes,
      ref: index.fullGraphCoarseSweepArtifact.ref,
      claim: index.fullGraphCoarseSweepArtifact.claim,
      lease: index.fullGraphCoarseSweepArtifact.lease,
    });
    const fullFamilyPredicateArtifacts = Object.freeze(index.fullFamilyPredicateArtifacts.map((artifact, position) => Object.freeze({
      contentSha256: artifact.contentSha256,
      bytes: fullFamilyPredicateArtifactBytes[position]!,
      ref: artifact.ref,
      claim: artifact.claim,
      lease: artifact.lease,
    })));
    const observerContentDirectory = await realpath(this.#sink.directory);
    const observerContentDirectoryHandle = await open(
      observerContentDirectory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const observerContentDirectoryMetadata = await (async () => {
      try {
        const observed = await observerContentDirectoryHandle.stat({ bigint: true });
        if (!observed.isDirectory() || observed.isSymbolicLink()) {
          throw new TypeError("terminal-phase observer content store is not a physical directory");
        }
        return observed;
      } finally {
        await observerContentDirectoryHandle.close();
      }
    })();
    const discovery = Object.freeze({
      indexDirectory: dirname(path),
      indexPath: path,
      indexDevice: metadata.dev.toString(),
      indexInode: metadata.ino.toString(),
      indexContentSha256: sha256Hex(indexBytes),
      indexByteLength: String(indexBytes.byteLength),
      observerContentDirectory,
      observerContentDirectoryDevice: observerContentDirectoryMetadata.dev.toString(),
      observerContentDirectoryInode: observerContentDirectoryMetadata.ino.toString(),
      observerStoreIdentityHash: this.#sink.storeIdentityHash,
      index,
      locator,
      locatorBytes,
      locatorArtifact,
      manifest,
      manifestBytes,
      manifestArtifact,
      fullFamilyProjection,
      fullFamilyProjectionArtifact,
      fullFamilyTerminalBindingArtifact,
      fullGraphCoarseSweepArtifact,
      fullFamilyPredicateArtifacts,
      fullFamilyBundleArtifact,
      fullFamilyLocatorArtifact,
      sixStepTerminalBindingArtifact,
      sixStepPredicateArtifacts,
      sixStepEventFacts,
      sixStepArtifactMaterials,
      sixStepPhysicalStatus: sixStepPhysicalReason === null ? "observed" as const : "invalid" as const,
      sixStepPhysicalReason,
      selectedProcessArtifact,
      snapshotTrustRoot: snapshotTrust?.trustRoot ?? null,
    });
    ISSUED_DURABLE_DISCOVERIES.add(discovery);
    return discovery;
  }
}
