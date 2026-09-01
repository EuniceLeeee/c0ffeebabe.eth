import { constants } from "node:fs";
import { openSync, closeSync, fstatSync, readSync, readdirSync, statSync, type BigIntStats } from "node:fs";
import { link, lstat, mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { deserialize } from "node:v8";
import { types as nodeTypes } from "node:util";
import {
  CANONICAL_LIMITS,
  assertDecimalString,
  assertExactKeys,
  assertHash,
  decodeCanonicalBytes,
  encodeCanonicalBytes,
  hashCanonicalPartition,
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
  createArtifactResolutionClaim,
  decodeArtifactBytes,
  decodeArtifactResolutionClaim,
  decodeRetentionLeaseReceipt,
  type ArtifactResolutionClaimV1,
  type RetentionLeaseReceiptV1,
} from "../../../specs/artifact-resolution/src/index.ts";
import type { ReadOnlyArtifactRefV1, SchemaRef } from "../../../specs/core-envelope/src/index.ts";
import {
  EVIDENCE_SCHEMA_MANIFESTS,
  assertEvidenceEventMatchesReceipt,
  decodeEvidenceEvent,
  type EvidenceEventV1,
} from "../../../specs/evidence/src/index.ts";
import {
  decodeProductionSixStepArtifactMaterialV1,
  type ProductionSixStepArtifactMaterialV1,
} from "../../../packages/evidence-emitter/src/index.ts";
import {
  decodeRuntimeAuthorityProjectionV1,
  type RuntimeAuthorityProjectionV1,
} from "../../../packages/runtime-authority/src/index.ts";
import {
  decodeSixStepNativeBoundaryRecord,
  decodeSixStepStageInput,
  decodeSixStepStageFacts,
  decodeSixStepWitnessContent,
  hashOrderedInstanceBindingsRoot,
  hashSixStepWitnessContentRoot,
  SIX_STEP_BOUNDARY_SNAPSHOT_LIMITS_V1,
  SIX_STEP_SCHEMA_MANIFESTS,
  type SixStepEventFactV1,
  type SixStepNativeBoundaryRecordV1,
  type SixStepStageFactsV1,
  type SixStepWitnessContentV1,
} from "../../../specs/evidence/src/six-step.ts";
import {
  decodeFullFamilyFactLocator,
  decodeFullFamilyArtifactRefIndexV1,
  decodeFullFamilyArtifactRefPageV1,
  decodeFullFamilyFactBundleStorageV1,
  decodeFullFamilyStoredItemV1,
  decodeFullFamilySourceCoverageArtifact,
  materializeFullFamilyFactBundleStorageV1,
  decodeFullFamilyPersistedGraphEdge,
  referencedFullFamilyArtifactDigests,
  validateFullFamilyFacts,
  FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS,
  FULL_FAMILY_FACT_STORAGE_SCHEMA_REF,
  type FullFamilyPartitionRoleV1,
  type FullFamilyFactBundleV1,
  type FullFamilyGeneratedRuntimeMetadataV1,
} from "../../../specs/full-family-facts/src/index.ts";
import { ContentAddressedObserverSinkV1, type ObservedContentArtifactV1 } from "./content-addressed-sink.ts";
import { decodeNativeFullFamilyAuditManifestV1 } from "../../../packages/search-pipeline/src/index.ts";
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
  type ProductionActiveReadyGraphSnapshotV1,
  type ProductionTerminalPhaseSnapshotTrustCapabilityV1,
  type ProductionTerminalPhaseSnapshotTrustStateV1,
} from "./internal/terminal-phase-snapshot-trust-state.ts";
import { productionSixStepNonObservedRootV1 } from "./internal/six-step-observation-root.ts";

export const PRODUCTION_TERMINAL_PHASE_SIX_STEP_POINTER_MAX_BYTES = 524_288;
export const PRODUCTION_TERMINAL_PHASE_SIX_STEP_POINTER_MAX_COUNT = 319;

export interface ProductionTerminalPhaseSixStepArtifactPointerV1 {
  readonly contentSha256: Hash;
  readonly ref: ReadOnlyArtifactRefV1;
  readonly claimId: Hash;
  readonly leaseReceiptId: Hash;
}

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
  readonly fullFamilyBundleArtifact: ProductionTerminalPhaseLocatorIndexRecordV1["selectedProcessArtifact"];
  readonly fullFamilyLocatorArtifact: ProductionTerminalPhaseLocatorIndexRecordV1["selectedProcessArtifact"];
  readonly sixStepTerminalBindingArtifact: ProductionTerminalPhaseLocatorIndexRecordV1["selectedProcessArtifact"];
  readonly sixStepPredicateArtifacts: readonly ProductionTerminalPhaseSixStepArtifactPointerV1[];
  readonly sixStepPredicateArtifactPointerRoot: Hash;
  readonly sixStepBoundaryKeys: readonly Hash[];
  readonly sixStepBoundaryKeyRoot: Hash;
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

function assertExactBoundedArray(
  value: unknown,
  path: string,
  maxLength: number,
): asserts value is readonly unknown[] {
  if (!Array.isArray(value) || nodeTypes.isProxy(value)) {
    throw new TypeError(`${path} must be a concrete array`);
  }
  const length = Object.getOwnPropertyDescriptor(value, "length");
  if (length === undefined || !("value" in length) || !Number.isSafeInteger(length.value)
    || length.value < 0 || length.value > maxLength) {
    throw new TypeError(`${path} count exceeds ${maxLength}`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length.value + 1) throw new TypeError(`${path} must be dense and exact`);
  for (let position = 0; position < length.value; position += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(position));
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${path}[${position}] must be an enumerable data item`);
    }
  }
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

function decodeSixStepArtifactPointer(
  value: unknown,
  path: string,
): ProductionTerminalPhaseSixStepArtifactPointerV1 {
  const pointer = record(value, path);
  assertExactKeys(pointer, ["contentSha256", "ref", "claimId", "leaseReceiptId"], path);
  const contentSha256 = assertHash(pointer.contentSha256, `${path}.contentSha256`);
  const ref = decodeReadOnlyArtifactRef(pointer.ref as object);
  const claimId = assertHash(pointer.claimId, `${path}.claimId`);
  const leaseReceiptId = assertHash(pointer.leaseReceiptId, `${path}.leaseReceiptId`);
  if (ref.contentSha256 !== contentSha256 || ref.retentionLeaseReceiptId !== leaseReceiptId) {
    throw new TypeError(`terminal-phase Six-Step pointer authority mismatch at ${path}`);
  }
  return Object.freeze({ contentSha256, ref, claimId, leaseReceiptId });
}

function sixStepArtifactPointer(
  artifact: NonNullable<ProductionTerminalPhaseLocatorIndexRecordV1["selectedProcessArtifact"]>,
): ProductionTerminalPhaseSixStepArtifactPointerV1 {
  return Object.freeze({
    contentSha256: artifact.contentSha256,
    ref: artifact.ref,
    claimId: artifact.claim.claimId,
    leaseReceiptId: artifact.lease.receiptId,
  });
}

function sixStepArtifactPointerRoot(
  pointers: readonly ProductionTerminalPhaseSixStepArtifactPointerV1[],
): Hash {
  return hashCanonicalPartition(
    "aloha/production-terminal-phase-six-step-artifact-pointer-sequence/v1",
    pointers,
    64,
  );
}

function sixStepBoundaryKeyRoot(keys: readonly Hash[]): Hash {
  return hashCanonicalPartition(
    "aloha/production-terminal-phase-six-step-boundary-key-sequence/v1",
    keys,
    16,
  );
}

function exactSixStepBoundaryKeys(value: unknown, path: string): readonly Hash[] {
  assertExactBoundedArray(value, path, SIX_STEP_BOUNDARY_SNAPSHOT_LIMITS_V1.maxEntries);
  let previous: Hash | null = null;
  const keys = Object.freeze(value.map((item, index) => {
    const key = assertHash(item, `${path}[${index}]`);
    if (previous !== null && previous >= key) {
      throw new TypeError(`${path} must be strictly sorted and unique`);
    }
    previous = key;
    return key;
  }));
  if (keys.length !== 0 && (
    keys.length < 8
    || (keys.length - 4) % 2 !== 0
    || (keys.length - 4) / 2 > SIX_STEP_BOUNDARY_SNAPSHOT_LIMITS_V1.maxRouteLegs
  )) {
    throw new TypeError(`${path} is not an exact 2L+4 selected closure`);
  }
  return keys;
}

function selectedSixStepBoundaryKeys(
  materials: readonly ProductionSixStepArtifactMaterialV1[],
): readonly Hash[] {
  return exactSixStepBoundaryKeys(
    [...materials].map(material => material.boundaryKey).sort(),
    "terminalPhaseLocatorIndex.sixStepBoundaryKeys",
  );
}

function assertSelectedSixStepBoundaryClosure(
  expectedKeys: readonly Hash[],
  materials: readonly ProductionSixStepArtifactMaterialV1[],
): void {
  const actualKeys = selectedSixStepBoundaryKeys(materials);
  if (actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new TypeError("terminal-phase Six-Step selected boundary key closure mismatch");
  }
}

function assertSixStepArtifactPointerBytes(
  pointers: readonly ProductionTerminalPhaseSixStepArtifactPointerV1[],
): void {
  if (encodeCanonicalBytes(pointers).byteLength > PRODUCTION_TERMINAL_PHASE_SIX_STEP_POINTER_MAX_BYTES) {
    throw new TypeError("terminal-phase Six-Step pointer section exceeds its compact byte limit");
  }
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

function fullFamilyItemSchema(role: FullFamilyPartitionRoleV1): SchemaRef {
  if (role === "source-plans" || role === "universe-candidates") return FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.evidence;
  if (role === "outcomes") return FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.outcome;
  if (role === "instance-publications") return FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.instancePublication;
  if (role === "projected-edges") return FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.graphEdge;
  if (role === "declared-coarse-capabilities" || role === "declared-exact-capabilities") {
    return FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.generatedCapabilityRef;
  }
  if (role === "owned-actions") return FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.generatedActionOwner;
  return FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.coarseObservation;
}

export async function readStoredFullFamilyPredicateArtifactsV1(
  sink: ContentAddressedObserverSinkV1,
  storageBytes: Uint8Array,
): Promise<readonly ObservedContentArtifactV1[]> {
  const storage = decodeFullFamilyFactBundleStorageV1(storageBytes);
  const artifacts = new Map<Hash, ObservedContentArtifactV1>();
  const add = async (artifactRefId: Hash, contentSha256: Hash, artifactSchema: SchemaRef) => {
    const observed = await sink.readArtifact({ contentSha256, mediaType: "application/json", schema: artifactSchema });
    if (observed.ref.artifactRefId !== artifactRefId) {
      throw new TypeError("stored Full-Family artifact ref/content/schema splice");
    }
    const prior = artifacts.get(artifactRefId);
    if (prior !== undefined && prior.contentSha256 !== contentSha256) {
      throw new TypeError("stored Full-Family artifact ref is bound to multiple contents");
    }
    artifacts.set(artifactRefId, observed);
    return observed;
  };
  await add(storage.releaseIntent.sourceArtifactRefId, storage.releaseIntent.sourceArtifactContentSha256, FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.releaseIntent);
  await add(storage.definitionCatalog.sourceArtifactRefId, storage.definitionCatalog.sourceArtifactContentSha256, FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.releaseProjection);
  await add(storage.runtimeComposition.sourceArtifactRefId, storage.runtimeComposition.sourceArtifactContentSha256, FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.releaseProjection);
  const sourceCoverage = await add(storage.sourceCoverage.artifactRefId, storage.sourceCoverage.contentSha256, FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.sourceCoverage);
  const coverage = decodeFullFamilySourceCoverageArtifact(sourceCoverage.bytes);
  for (const execution of coverage.executions) {
    await add(execution.executionArtifactRefId, execution.executionContentSha256, FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.sourceExecution);
    await add(execution.evidenceArtifactRefId, execution.evidenceContentSha256, FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.sourceEvidence);
    for (const physical of execution.physicalObservations) {
      await add(physical.artifactRefId, physical.contentSha256, FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.sourcePhysicalObservation);
    }
  }
  await add(storage.lineage.nominationClosure.artifactRefId, storage.lineage.nominationClosure.contentSha256, FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.nominationClosure);
  await add(storage.lineage.candidatePartitionProof.artifactRefId, storage.lineage.candidatePartitionProof.contentSha256, FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.candidatePartitionProof);
  await add(storage.lineage.candidateProofVerifierBinding.artifactRefId, storage.lineage.candidateProofVerifierBinding.contentSha256, FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.candidateProofVerifierBinding);
  await add(storage.runtime.readyRecordArtifactRefId, storage.runtime.readyRecordContentSha256, FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.readyRecord);
  const partitions = (family: typeof storage.families[number]) => [
    ["source-plans", family.sourcePlans],
    ["universe-candidates", family.universeCandidates],
    ["outcomes", family.outcomes],
    ["instance-publications", family.instancePublications],
    ["projected-edges", family.projectedEdges],
    ["declared-coarse-capabilities", family.declaredCoarseCapabilities],
    ["coarse-rankable", family.coarseRankable],
    ["coarse-unavailable", family.coarseUnavailable],
    ["unranked-admissions", family.unrankedAdmissions],
    ["declared-exact-capabilities", family.declaredExactCapabilities],
    ["owned-actions", family.ownedActions],
  ] as const;
  for (const family of storage.families) {
    for (const [role, partition] of partitions(family)) {
      const indexArtifact = await add(
        partition.indexArtifactRefId,
        partition.indexContentSha256,
        FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.artifactRefIndex,
      );
      const index = decodeFullFamilyArtifactRefIndexV1(indexArtifact.bytes);
      let next = index.firstPageRef;
      let pageCount = 0;
      while (next !== null) {
        if (pageCount >= Number(index.pageCount)) throw new TypeError("stored Full-Family ref-page cycle");
        const pageArtifact = await add(next.artifactRefId, next.contentSha256, FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS.artifactRefPage);
        const page = decodeFullFamilyArtifactRefPageV1(pageArtifact.bytes);
        const itemSchema = fullFamilyItemSchema(role);
        for (const ref of page.refs) {
          await add(ref.artifactRefId, ref.contentSha256, itemSchema);
        }
        next = page.nextPageRef;
        pageCount += 1;
      }
      if (String(pageCount) !== index.pageCount) throw new TypeError("stored Full-Family ref-page count mismatch");
    }
  }
  return Object.freeze([...artifacts.values()].sort((left, right) => left.ref.artifactRefId.localeCompare(right.ref.artifactRefId)));
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

async function reconstructIndexedSixStepArtifact(
  sink: ContentAddressedObserverSinkV1,
  pointer: ProductionTerminalPhaseSixStepArtifactPointerV1,
  label: string,
): Promise<NonNullable<ProductionTerminalPhaseLocatorIndexRecordV1["selectedProcessArtifact"]>> {
  const ref = pointer.ref;
  if (ref.schema === null) throw new TypeError(`${label} has no exact schema`);
  const rebuilt = await sink.readArtifact({
    contentSha256: pointer.contentSha256,
    mediaType: ref.mediaType,
    schema: ref.schema,
    expectedByteLength: ref.byteLength,
  });
  const mirror = rebuilt.claim.observedMirror;
  if (mirror === null) throw new TypeError(`${label} has no reconstructed mirror`);
  const claim = createArtifactResolutionClaim({
    artifactRefId: ref.artifactRefId,
    resolverPolicyHash: ref.resolverPolicyHash,
    observedMirror: mirror,
    outcome: "content-observed",
  });
  const immutable = ref.immutableMirrorLocator;
  if (immutable.kind !== "content-object"
    || immutable.objectKey !== pointer.contentSha256
    || immutable.storeIdentityHash !== sink.storeIdentityHash
    || ref.contentSha256 !== pointer.contentSha256
    || ref.byteLength !== rebuilt.bytes.byteLength.toString()
    || ref.resolverPolicyHash !== sink.resolverPolicy.policyHash
    || rebuilt.contentSha256 !== pointer.contentSha256
    || rebuilt.ref.contentSha256 !== pointer.contentSha256
    || rebuilt.ref.byteLength !== ref.byteLength
    || rebuilt.ref.mediaType !== ref.mediaType
    || !sameCanonical(rebuilt.ref.schema, ref.schema)
    || rebuilt.ref.immutableMirrorLocator.kind !== "content-object"
    || rebuilt.ref.immutableMirrorLocator.objectKey !== immutable.objectKey
    || rebuilt.ref.immutableMirrorLocator.storeIdentityHash !== immutable.storeIdentityHash
    || claim.claimId !== pointer.claimId
    || claim.artifactRefId !== ref.artifactRefId
    || rebuilt.lease.receiptId !== pointer.leaseReceiptId
    || rebuilt.lease.receiptId !== ref.retentionLeaseReceiptId) {
    throw new TypeError(`${label} pointer/ref/claim/lease reconstruction mismatch`);
  }
  return decodeIndexedArtifact({
    contentSha256: pointer.contentSha256,
    ref,
    claim,
    lease: rebuilt.lease,
  }, label);
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
    planningProblemHash: assertHash(value.planningProblemHash, "terminalPhaseSixStepTerminalBinding.planningProblemHash"),
    routeCandidateId: assertHash(value.routeCandidateId, "terminalPhaseSixStepTerminalBinding.routeCandidateId"),
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

function exactSelectedStage12Binding(value: unknown): Readonly<{
  readonly readyRecordHash: Hash;
  readonly generationId: string;
  readonly cutoff: Readonly<{ readonly chainId: string; readonly number: string; readonly hash: Hash; readonly stateRoot: Hash }>;
  readonly definitionCatalogRoot: Hash;
  readonly sourceCoverageRoot: Hash;
  readonly candidatePartitionRoot: Hash;
  readonly exactOutcomePartitionRoot: Hash;
  readonly verifiedMemoSetRoot: Hash;
  readonly instanceCatalogRoot: Hash;
  readonly graphRoot: Hash;
  readonly releaseProvenanceHash: Hash;
  readonly promotionRevision: string;
}> {
  const path = "terminalPhaseSelectedProcess.stage12.binding";
  const binding = record(value, path);
  assertExactKeys(binding, [
    "readyRecordHash", "generationId", "cutoff", "definitionCatalogRoot", "sourceCoverageRoot",
    "candidatePartitionRoot", "exactOutcomePartitionRoot", "verifiedMemoSetRoot", "instanceCatalogRoot",
    "graphRoot", "releaseProvenanceHash", "promotionRevision",
  ], path);
  const cutoff = record(binding.cutoff, `${path}.cutoff`);
  assertExactKeys(cutoff, ["chainId", "number", "hash", "stateRoot"], `${path}.cutoff`);
  return Object.freeze({
    readyRecordHash: assertHash(binding.readyRecordHash, `${path}.readyRecordHash`),
    generationId: exactNonEmptyString(binding.generationId, `${path}.generationId`),
    cutoff: Object.freeze({
      chainId: assertDecimalString(cutoff.chainId, `${path}.cutoff.chainId`),
      number: assertDecimalString(cutoff.number, `${path}.cutoff.number`),
      hash: assertHash(cutoff.hash, `${path}.cutoff.hash`),
      stateRoot: assertHash(cutoff.stateRoot, `${path}.cutoff.stateRoot`),
    }),
    definitionCatalogRoot: assertHash(binding.definitionCatalogRoot, `${path}.definitionCatalogRoot`),
    sourceCoverageRoot: assertHash(binding.sourceCoverageRoot, `${path}.sourceCoverageRoot`),
    candidatePartitionRoot: assertHash(binding.candidatePartitionRoot, `${path}.candidatePartitionRoot`),
    exactOutcomePartitionRoot: assertHash(binding.exactOutcomePartitionRoot, `${path}.exactOutcomePartitionRoot`),
    verifiedMemoSetRoot: assertHash(binding.verifiedMemoSetRoot, `${path}.verifiedMemoSetRoot`),
    instanceCatalogRoot: assertHash(binding.instanceCatalogRoot, `${path}.instanceCatalogRoot`),
    graphRoot: assertHash(binding.graphRoot, `${path}.graphRoot`),
    releaseProvenanceHash: assertHash(binding.releaseProvenanceHash, `${path}.releaseProvenanceHash`),
    promotionRevision: assertDecimalString(binding.promotionRevision, `${path}.promotionRevision`),
  });
}

function exactSelectedStage12(
  value: unknown,
  expectedRoot: Hash,
): Readonly<{
  readonly binding: ReturnType<typeof exactSelectedStage12Binding>;
  readonly selectedParents: readonly Readonly<{
    readonly edgeId: Hash;
    readonly selectedLegRoot: Hash;
    readonly stage1EventId: Hash;
    readonly stage1ArtifactSetRoot: Hash;
    readonly stage2EventId: Hash;
    readonly stage2ArtifactSetRoot: Hash;
    readonly instancePublicationRoot: Hash;
    readonly edgeContentRoot: Hash;
  }>[];
  readonly stage3EventId: Hash;
  readonly stage3ArtifactSetRoot: Hash;
}> {
  const stage12 = record(value, "terminalPhaseSelectedProcess.stage12");
  assertExactKeys(stage12, ["binding", "selectedParents", "stage3EventId", "stage3ArtifactSetRoot"], "terminalPhaseSelectedProcess.stage12");
  if (expectedRoot !== hashDomain("aloha/searcher-production-evidence-stage12/v1", stage12 as CanonicalJson)) {
    throw new TypeError("terminal-phase selected process Stage 1/2 root mismatch");
  }
  assertExactBoundedArray(stage12.selectedParents, "terminalPhaseSelectedProcess.stage12.selectedParents", 16);
  if (stage12.selectedParents.length < 2) {
    throw new TypeError("terminal-phase selected process Stage 1/2 route is shorter than two legs");
  }
  const binding = exactSelectedStage12Binding(stage12.binding);
  const selectedParents = Object.freeze(stage12.selectedParents.map((value, index) => {
    const parent = record(value, `terminalPhaseSelectedProcess.stage12.selectedParents[${index}]`);
    assertExactKeys(parent, [
      "edgeId", "selectedLegRoot", "stage1EventId", "stage1ArtifactSetRoot", "stage2EventId",
      "stage2ArtifactSetRoot", "instancePublicationRoot", "edgeContentRoot",
    ], `terminalPhaseSelectedProcess.stage12.selectedParents[${index}]`);
    return Object.freeze({
      edgeId: assertHash(parent.edgeId, `terminalPhaseSelectedProcess.stage12.selectedParents[${index}].edgeId`),
      selectedLegRoot: assertHash(parent.selectedLegRoot, `terminalPhaseSelectedProcess.stage12.selectedParents[${index}].selectedLegRoot`),
      stage1EventId: assertHash(parent.stage1EventId, `terminalPhaseSelectedProcess.stage12.selectedParents[${index}].stage1EventId`),
      stage1ArtifactSetRoot: assertHash(parent.stage1ArtifactSetRoot, `terminalPhaseSelectedProcess.stage12.selectedParents[${index}].stage1ArtifactSetRoot`),
      stage2EventId: assertHash(parent.stage2EventId, `terminalPhaseSelectedProcess.stage12.selectedParents[${index}].stage2EventId`),
      stage2ArtifactSetRoot: assertHash(parent.stage2ArtifactSetRoot, `terminalPhaseSelectedProcess.stage12.selectedParents[${index}].stage2ArtifactSetRoot`),
      instancePublicationRoot: assertHash(parent.instancePublicationRoot, `terminalPhaseSelectedProcess.stage12.selectedParents[${index}].instancePublicationRoot`),
      edgeContentRoot: assertHash(parent.edgeContentRoot, `terminalPhaseSelectedProcess.stage12.selectedParents[${index}].edgeContentRoot`),
    });
  }));
  if (new Set(selectedParents.map(parent => parent.edgeId)).size !== selectedParents.length) {
    throw new TypeError("terminal-phase selected process Stage 1/2 route contains duplicate edges");
  }
  return Object.freeze({
    binding,
    selectedParents,
    stage3EventId: assertHash(stage12.stage3EventId, "terminalPhaseSelectedProcess.stage12.stage3EventId"),
    stage3ArtifactSetRoot: assertHash(stage12.stage3ArtifactSetRoot, "terminalPhaseSelectedProcess.stage12.stage3ArtifactSetRoot"),
  });
}

function exactTerminalSelectedGraphLegs(
  terminal: ReturnType<typeof terminalBindingIdentity>,
): readonly Readonly<{
  readonly edgeId: Hash;
  readonly owningFamilyId: string;
  readonly owningFamilyDefinitionHash: Hash;
  readonly owningInstanceKey: string;
  readonly instancePublicationHash: Hash;
  readonly staticProjectionHash: Hash;
  readonly projectionHash: Hash;
}>[] {
  const trace = record(terminal.value.trace, "terminalPhaseSixStepTerminalBinding.trace");
  const traceRoot = assertHash(trace.traceRoot, "terminalPhaseSixStepTerminalBinding.trace.traceRoot");
  const { traceRoot: _traceRoot, ...tracePayload } = trace;
  if (traceRoot !== hashDomain("aloha/search-terminal-six-step-trace/v1", tracePayload as CanonicalJson)) {
    throw new TypeError("terminal-phase Six-Step terminal trace root mismatch");
  }
  assertExactBoundedArray(trace.selectedGraphLegs, "terminalPhaseSixStepTerminalBinding.trace.selectedGraphLegs", 16);
  if (trace.selectedGraphLegs.length < 2) {
    throw new TypeError("terminal-phase Six-Step selected Graph route is shorter than two legs");
  }
  return Object.freeze(trace.selectedGraphLegs.map((value, index) => {
    const path = `terminalPhaseSixStepTerminalBinding.trace.selectedGraphLegs[${index}]`;
    const leg = record(value, path);
    assertExactKeys(leg, [
      "edgeId", "owningFamilyId", "owningFamilyDefinitionHash", "owningInstanceKey",
      "instancePublicationHash", "staticProjectionHash", "projectionHash",
    ], path);
    return Object.freeze({
      edgeId: assertHash(leg.edgeId, `${path}.edgeId`),
      owningFamilyId: exactNonEmptyString(leg.owningFamilyId, `${path}.owningFamilyId`),
      owningFamilyDefinitionHash: assertHash(leg.owningFamilyDefinitionHash, `${path}.owningFamilyDefinitionHash`),
      owningInstanceKey: exactNonEmptyString(leg.owningInstanceKey, `${path}.owningInstanceKey`),
      instancePublicationHash: assertHash(leg.instancePublicationHash, `${path}.instancePublicationHash`),
      staticProjectionHash: assertHash(leg.staticProjectionHash, `${path}.staticProjectionHash`),
      projectionHash: assertHash(leg.projectionHash, `${path}.projectionHash`),
    });
  }));
}

function selectedGraphLegRoot(value: ReturnType<typeof exactTerminalSelectedGraphLegs>[number]): Hash {
  return hashDomain("aloha/searcher-production-evidence-selected-graph-leg/v1", value);
}

function acceptanceRouteOwnerRefV1(familyDefinitionHash: Hash, routeBindingHash: Hash): Hash {
  return hashDomain("aloha/search-runtime-route-owner/v1", { familyDefinitionHash, routeBindingHash });
}

function acceptanceRouteBindingHashV1(
  routeLegs: readonly Readonly<{ readonly edgeId: Hash; readonly ownerRef: Hash }>[],
): Hash {
  return hashDomain("aloha/route-binding/v1", {
    legs: routeLegs.map(({ edgeId, ownerRef }) => ({ edgeId, ownerRef })),
  });
}

const PRODUCTION_PLANNING_PROBLEM_KEYS = Object.freeze([
  "kind", "objectiveRef", "entryAssetRef", "returnAssetRef", "minLegs", "maxLegs", "candidateLimit", "edgeReuse",
  "requiredAnchorEdgeIds", "constraintSchemaRefs", "strategyId", "strategyDefinitionHash",
  "strategyCatalogLeafDigest", "definitionCatalogRoot", "generationId", "graphRoot",
  "triggerRef", "lane", "triggerCorrelationId", "triggerHeadHash",
  "requiredCapabilityPredicates", "strategyCompositionRoot", "strategyIssuerClosureRoot",
  "releaseProvenanceHash", "readyRecordHash", "problemHash",
]);

function exactTerminalPlanningProblem(value: unknown): Readonly<Record<string, unknown> & { readonly problemHash: Hash }> {
  const path = "terminalPhaseSixStepTerminalBinding.trace.planningProblem";
  const problem = record(value, path);
  assertExactKeys(problem, PRODUCTION_PLANNING_PROBLEM_KEYS, path);
  if (problem.kind !== "closed-loop" || problem.edgeReuse !== "forbid"
    || (problem.lane !== "blockscan" && problem.lane !== "backrun")) {
    throw new TypeError(`${path} kind/lane/edgeReuse mismatch`);
  }
  for (const field of [
    "objectiveRef", "entryAssetRef", "returnAssetRef", "strategyDefinitionHash", "strategyCatalogLeafDigest",
    "definitionCatalogRoot", "graphRoot", "triggerRef", "triggerCorrelationId", "triggerHeadHash",
    "strategyCompositionRoot", "strategyIssuerClosureRoot", "releaseProvenanceHash", "readyRecordHash", "problemHash",
  ] as const) assertHash(problem[field], `${path}.${field}`);
  exactNonEmptyString(problem.strategyId, `${path}.strategyId`);
  exactNonEmptyString(problem.generationId, `${path}.generationId`);
  const minLegs = BigInt(assertDecimalString(problem.minLegs, `${path}.minLegs`));
  const maxLegs = BigInt(assertDecimalString(problem.maxLegs, `${path}.maxLegs`));
  const candidateLimit = BigInt(assertDecimalString(problem.candidateLimit, `${path}.candidateLimit`));
  if (minLegs < 1n || maxLegs < minLegs || maxLegs > 16n || candidateLimit < 1n || candidateLimit > 100_000n
    || problem.entryAssetRef !== problem.returnAssetRef) {
    throw new TypeError(`${path} planning bounds/asset boundary mismatch`);
  }
  for (const field of ["requiredAnchorEdgeIds", "constraintSchemaRefs"] as const) {
    assertExactBoundedArray(problem[field], `${path}.${field}`, 16);
    const values = problem[field].map((value, index) => assertHash(value, `${path}.${field}[${index}]`));
    if (new Set(values).size !== values.length) throw new TypeError(`${path}.${field} contains duplicates`);
  }
  assertExactBoundedArray(problem.requiredCapabilityPredicates, `${path}.requiredCapabilityPredicates`, 64);
  for (const [index, value] of problem.requiredCapabilityPredicates.entries()) {
    const predicatePath = `${path}.requiredCapabilityPredicates[${index}]`;
    const predicate = record(value, predicatePath);
    assertExactKeys(predicate, ["capabilityId", "minimumVersion", "schemaRefs"], predicatePath);
    exactNonEmptyString(predicate.capabilityId, `${predicatePath}.capabilityId`);
    exactNonEmptyString(predicate.minimumVersion, `${predicatePath}.minimumVersion`);
    assertExactBoundedArray(predicate.schemaRefs, `${predicatePath}.schemaRefs`, 64);
    const refs = predicate.schemaRefs.map((ref, refIndex) => assertHash(ref, `${predicatePath}.schemaRefs[${refIndex}]`));
    if (new Set(refs).size !== refs.length) throw new TypeError(`${predicatePath}.schemaRefs contains duplicates`);
  }
  const problemHash = assertHash(problem.problemHash, `${path}.problemHash`);
  const { problemHash: _problemHash, ...payload } = problem;
  if (problemHash !== hashDomain("aloha/strategy-planning-problem/v1", payload as CanonicalJson)) {
    throw new TypeError(`${path}.problemHash mismatch`);
  }
  return problem as Readonly<Record<string, unknown> & { readonly problemHash: Hash }>;
}

function exactTerminalRouteCandidate(
  value: unknown,
  problem: ReturnType<typeof exactTerminalPlanningProblem>,
): Readonly<{
  readonly candidateId: Hash;
  readonly planningProblemHash: Hash;
  readonly orderKey: Hash;
  readonly legs: readonly Readonly<{
    readonly edgeId: Hash;
    readonly transitionRef: Hash;
    readonly inputAssetRef: Hash;
    readonly inputPortRef: Hash;
    readonly outputAssetRef: Hash;
    readonly outputPortRef: Hash;
  }>[];
}> {
  const path = "terminalPhaseSixStepTerminalBinding.trace.routeCandidate";
  const candidate = record(value, path);
  assertExactKeys(candidate, ["candidateId", "planningProblemHash", "legs", "loopIntent", "orderKey"], path);
  assertExactBoundedArray(candidate.legs, `${path}.legs`, 16);
  if (candidate.legs.length < 2) throw new TypeError(`${path}.legs are invalid`);
  const legs = Object.freeze(candidate.legs.map((value, index) => {
    const legPath = `${path}.legs[${index}]`;
    const leg = record(value, legPath);
    assertExactKeys(leg, ["edgeId", "transitionRef", "inputAssetRef", "inputPortRef", "outputAssetRef", "outputPortRef"], legPath);
    return Object.freeze({
      edgeId: assertHash(leg.edgeId, `${legPath}.edgeId`),
      transitionRef: assertHash(leg.transitionRef, `${legPath}.transitionRef`),
      inputAssetRef: assertHash(leg.inputAssetRef, `${legPath}.inputAssetRef`),
      inputPortRef: assertHash(leg.inputPortRef, `${legPath}.inputPortRef`),
      outputAssetRef: assertHash(leg.outputAssetRef, `${legPath}.outputAssetRef`),
      outputPortRef: assertHash(leg.outputPortRef, `${legPath}.outputPortRef`),
    });
  }));
  if (new Set(legs.map(leg => leg.edgeId)).size !== legs.length
    || legs.some((leg, index) => leg.outputAssetRef !== legs[(index + 1) % legs.length]!.inputAssetRef)) {
    throw new TypeError(`${path}.legs do not form a unique closed route`);
  }
  if (BigInt(legs.length) < BigInt(problem.minLegs as string)
    || BigInt(legs.length) > BigInt(problem.maxLegs as string)) {
    throw new TypeError(`${path}.legs are outside the planning bounds`);
  }
  const requiredAnchors = new Set(problem.requiredAnchorEdgeIds as readonly Hash[]);
  if (requiredAnchors.size !== 0 && !legs.some(leg => requiredAnchors.has(leg.edgeId))) {
    throw new TypeError(`${path}.legs do not include a required anchor`);
  }
  const intentPath = `${path}.loopIntent`;
  const intent = record(candidate.loopIntent, intentPath);
  assertExactKeys(intent, ["kind", "entryAssetRef", "returnAssetRef", "objectiveRef", "constraintSchemaRefs", "legs"], intentPath);
  assertExactBoundedArray(intent.constraintSchemaRefs, `${intentPath}.constraintSchemaRefs`, 64);
  assertExactBoundedArray(intent.legs, `${intentPath}.legs`, 16);
  if (intent.kind !== "closed-loop" || intent.entryAssetRef !== problem.entryAssetRef
    || intent.returnAssetRef !== problem.returnAssetRef || intent.objectiveRef !== problem.objectiveRef
    || intent.entryAssetRef !== legs[0]!.inputAssetRef || intent.legs.length !== legs.length
    || hashDomain("aloha/planner-constraint-set/v1", intent.constraintSchemaRefs as CanonicalJson)
      !== hashDomain("aloha/planner-constraint-set/v1", problem.constraintSchemaRefs as CanonicalJson)) {
    throw new TypeError(`${intentPath} mismatch`);
  }
  for (const [index, value] of intent.legs.entries()) {
    const legPath = `${intentPath}.legs[${index}]`;
    const leg = record(value, legPath);
    assertExactKeys(leg, ["fromAssetRef", "toAssetRef", "selectionRef", "requiredCapabilityPredicates"], legPath);
    assertExactBoundedArray(leg.requiredCapabilityPredicates, `${legPath}.requiredCapabilityPredicates`, 64);
    if (leg.fromAssetRef !== legs[index]!.inputAssetRef || leg.toAssetRef !== legs[index]!.outputAssetRef
      || leg.selectionRef !== hashDomain("aloha/planner-route-selection/v1", legs[index]!)
      || hashDomain("aloha/planner-capability-set/v1", leg.requiredCapabilityPredicates as CanonicalJson)
        !== hashDomain("aloha/planner-capability-set/v1", problem.requiredCapabilityPredicates as CanonicalJson)) {
      throw new TypeError(`${legPath} mismatch`);
    }
  }
  const candidatePayload = Object.freeze({
    planningProblemHash: problem.problemHash,
    objectiveRef: problem.objectiveRef,
    entryAssetRef: problem.entryAssetRef,
    returnAssetRef: problem.returnAssetRef,
    legs,
  });
  const candidateId = assertHash(candidate.candidateId, `${path}.candidateId`);
  const planningProblemHash = assertHash(candidate.planningProblemHash, `${path}.planningProblemHash`);
  const orderKey = assertHash(candidate.orderKey, `${path}.orderKey`);
  if (planningProblemHash !== problem.problemHash
    || candidateId !== hashDomain("aloha/planner-route-candidate/v1", candidatePayload)
    || orderKey !== hashDomain("aloha/planner-route-order/v1", candidatePayload)) {
    throw new TypeError(`${path} identity mismatch`);
  }
  return Object.freeze({ candidateId, planningProblemHash, orderKey, legs });
}

function assertExactTerminalPlannedRouteJoin(
  terminal: ReturnType<typeof terminalBindingIdentity>,
  resolved: ReturnType<typeof exactTerminalResolvedSixStep>,
  selectedGraphLegs: ReturnType<typeof exactTerminalSelectedGraphLegs>,
  rootOwnedSelectedEdges: ProductionActiveReadyGraphSnapshotV1["orderedEdges"] | null,
): void {
  const trace = record(terminal.value.trace, "terminalPhaseSixStepTerminalBinding.trace");
  assertExactKeys(trace, [
    "schemaVersion", "kind", "strategyCompositionRoot", "planningProblem", "planningProblemHash",
    "routeCandidate", "selectedGraphLegs", "admission", "resolved", "traceRoot",
  ], "terminalPhaseSixStepTerminalBinding.trace");
  if (trace.schemaVersion !== 1 || trace.kind !== "aloha.search-terminal-six-step-trace-v1") {
    throw new TypeError("terminal-phase Six-Step terminal trace kind/version mismatch");
  }
  const problem = exactTerminalPlanningProblem(trace.planningProblem);
  const candidate = exactTerminalRouteCandidate(trace.routeCandidate, problem);
  const actionOwners = record(
    resolved.executionProgramOwnerEvidence.facts,
    "terminalPhaseSixStepTerminalBinding.trace.resolved.executionProgramOwnerEvidence.facts",
  ).actionOwners;
  assertExactBoundedArray(actionOwners, "terminalPhaseSixStepTerminalBinding.trace.resolved.executionProgramOwnerEvidence.facts.actionOwners", 16);
  if (candidate.legs.length !== selectedGraphLegs.length || actionOwners.length !== candidate.legs.length
    || trace.planningProblemHash !== problem.problemHash || terminal.planningProblemHash !== problem.problemHash
    || terminal.routeCandidateId !== candidate.candidateId || resolved.routeCandidateId !== candidate.candidateId
    || problem.generationId !== resolved.binding.generationId || problem.graphRoot !== resolved.binding.graphRoot
    || problem.readyRecordHash !== resolved.binding.readyRecordHash
    || problem.releaseProvenanceHash !== resolved.binding.releaseProvenanceHash
    || problem.definitionCatalogRoot !== resolved.binding.definitionCatalogRoot
    || trace.strategyCompositionRoot !== terminal.value.strategyCompositionRoot) {
    throw new TypeError("terminal-phase Six-Step planning problem/candidate identity splice");
  }
  const routeLegs = candidate.legs.map((candidateLeg, index) => {
    const actionPath = `terminalPhaseSixStepTerminalBinding.trace.resolved.executionProgramOwnerEvidence.facts.actionOwners[${index}]`;
    const actionOwner = record(actionOwners[index], actionPath);
    const familyDefinitionHash = assertHash(actionOwner.familyDefinitionHash, `${actionPath}.familyDefinitionHash`);
    const familyRouteBindingHash = assertHash(actionOwner.routeBindingHash, `${actionPath}.routeBindingHash`);
    const bindingLeg = resolved.routeBinding.legs[index]!;
    if (candidateLeg.edgeId !== selectedGraphLegs[index]!.edgeId
      || candidateLeg.edgeId !== bindingLeg.edgeId
      || familyDefinitionHash !== selectedGraphLegs[index]!.owningFamilyDefinitionHash
      || bindingLeg.ownerRef !== acceptanceRouteOwnerRefV1(familyDefinitionHash, familyRouteBindingHash)) {
      throw new TypeError(`terminal-phase Six-Step planned route/action owner[${index}] splice`);
    }
    const rootOwnedEdge = rootOwnedSelectedEdges?.[index];
    if (rootOwnedEdge !== undefined && (
      candidateLeg.transitionRef !== rootOwnedEdge.opaqueTransitionRef
      || !rootOwnedEdge.inputAssetPorts.some(port => port.assetRef === candidateLeg.inputAssetRef
        && port.portRef === candidateLeg.inputPortRef)
      || !rootOwnedEdge.outputAssetPorts.some(port => port.assetRef === candidateLeg.outputAssetRef
        && port.portRef === candidateLeg.outputPortRef)
    )) {
      throw new TypeError(`terminal-phase Six-Step planned route/root-owned edge[${index}] splice`);
    }
    return Object.freeze({ ...candidateLeg, routeBindingHash: familyRouteBindingHash });
  });
  const expectedRouteHash = hashDomain("aloha/search-runtime-route/v1", {
    candidateId: candidate.candidateId,
    legs: routeLegs.map(leg => ({
      edgeId: leg.edgeId,
      inputAssetRef: leg.inputAssetRef,
      inputPortRef: leg.inputPortRef,
      outputAssetRef: leg.outputAssetRef,
      outputPortRef: leg.outputPortRef,
      transitionRef: leg.transitionRef,
      routeBindingHash: leg.routeBindingHash,
    })),
  });
  if (resolved.routeBinding.routeHash !== expectedRouteHash) {
    throw new TypeError("terminal-phase Six-Step planned route hash mismatch");
  }
}

/** @internal Exact restart join from selected Six-Step legs to the root-owned active Ready Graph. */
export function exactRootOwnedSelectedReadyEdges(
  activeGraph: ProductionActiveReadyGraphSnapshotV1,
  stage12Binding: ReturnType<typeof exactSelectedStage12Binding>,
  resolvedBinding: ReturnType<typeof exactProductionGraphLeaseBindingV1>,
  selectedGraphLegs: ReturnType<typeof exactTerminalSelectedGraphLegs>,
  definitionCatalogRoot: Hash,
): ProductionActiveReadyGraphSnapshotV1["orderedEdges"] {
  if (stage12Binding.readyRecordHash !== activeGraph.readyRecordHash
    || stage12Binding.generationId !== activeGraph.generationId
    || !sameCanonical(stage12Binding.cutoff, activeGraph.cutoff)
    || stage12Binding.definitionCatalogRoot !== activeGraph.definitionCatalogRoot
    || stage12Binding.definitionCatalogRoot !== definitionCatalogRoot
    || stage12Binding.sourceCoverageRoot !== activeGraph.sourceCoverageRoot
    || stage12Binding.candidatePartitionRoot !== activeGraph.candidatePartitionRoot
    || stage12Binding.exactOutcomePartitionRoot !== activeGraph.exactOutcomePartitionRoot
    || stage12Binding.verifiedMemoSetRoot !== activeGraph.verifiedMemoSetRoot
    || stage12Binding.promotionRevision !== activeGraph.promotionRevision
    || stage12Binding.instanceCatalogRoot !== activeGraph.instanceCatalogRoot
    || stage12Binding.graphRoot !== activeGraph.graphRoot
    || stage12Binding.releaseProvenanceHash !== activeGraph.releaseProvenanceHash
    || resolvedBinding.readyRecordHash !== activeGraph.readyRecordHash
    || resolvedBinding.generationId !== activeGraph.generationId
    || resolvedBinding.generationRefreshPolicyHash !== activeGraph.generationRefreshPolicyHash
    || !sameCanonical(resolvedBinding.cutoff, activeGraph.cutoff)
    || resolvedBinding.definitionCatalogRoot !== activeGraph.definitionCatalogRoot
    || resolvedBinding.instanceCatalogRoot !== activeGraph.instanceCatalogRoot
    || resolvedBinding.graphRoot !== activeGraph.graphRoot
    || resolvedBinding.releaseProvenanceHash !== activeGraph.releaseProvenanceHash
    || resolvedBinding.candidatePartitionProofStorageHash !== activeGraph.candidatePartitionProofStorageHash
    || resolvedBinding.nominationClosureRoot !== activeGraph.nominationClosureRoot
    || resolvedBinding.nominationClosureStorageHash !== activeGraph.nominationClosureStorageHash) {
    throw new TypeError("terminal-phase Six-Step Stage 1/2 root-owned Ready binding mismatch");
  }
  const byEdgeId = new Map(activeGraph.orderedEdges.map(edge => [edge.edgeId, edge] as const));
  const selected = selectedGraphLegs.map((leg, index) => {
    const edge = byEdgeId.get(leg.edgeId);
    if (edge === undefined
      || edge.owningFamilyId !== leg.owningFamilyId
      || edge.owningFamilyDefinitionHash !== leg.owningFamilyDefinitionHash
      || edge.owningInstanceKey !== leg.owningInstanceKey
      || edge.instancePublicationHash !== leg.instancePublicationHash
      || edge.staticProjectionHash !== leg.staticProjectionHash
      || edge.projectionHash !== leg.projectionHash) {
      throw new TypeError(`terminal-phase Six-Step selected leg[${index}] is not an exact active Ready Graph member`);
    }
    return edge;
  });
  return Object.freeze(selected);
}

/** @internal Exact Stage 2 edge judgment. Local publication proves witness/raw
 * identity; snapshot acceptance additionally proves root-owned membership. */
export function exactStage2PersistedGraphEdgeV1(
  witnessPayload: unknown,
  rawPayload: unknown,
  rootOwnedEdge: ProductionActiveReadyGraphSnapshotV1["orderedEdges"][number] | null,
  path = "terminalPhaseSixStep.stage2.edge",
): ProductionActiveReadyGraphSnapshotV1["orderedEdges"][number] {
  const witness = decodeFullFamilyPersistedGraphEdge(witnessPayload, `${path}.witness`);
  const raw = decodeFullFamilyPersistedGraphEdge(rawPayload, `${path}.raw`);
  if (!sameCanonical(witness, raw)) {
    throw new TypeError(`${path} witness/raw edge mismatch`);
  }
  if (rootOwnedEdge !== null && !sameCanonical(witness, rootOwnedEdge)) {
    throw new TypeError(`${path} is not the exact root-owned active Ready Graph edge`);
  }
  return witness;
}

interface ExactSixStepArtifactObservationV1 {
  readonly event: EvidenceEventV1;
  readonly facts: SixStepStageFactsV1;
  readonly rawBoundary: SixStepNativeBoundaryRecordV1;
  readonly witnesses: readonly SixStepWitnessContentV1[];
  readonly artifactSetRoot: Hash;
}

interface SixStepDagEventV1 {
  readonly eventId: Hash;
  readonly outputHash: Hash;
  readonly stage: Readonly<{ readonly ordinal: 1 | 2 | 3 | 4 | 5 | 6 }>;
  readonly parentEventIds: readonly Hash[];
  readonly parentOutputHashes: readonly Hash[];
  readonly outcome: EvidenceEventV1["outcome"];
}

/** @internal Acceptance-owned DAG oracle. Inputs reach this function only
 * after the event decoder has recomputed every event identity/output hash. */
export function assertProductionSixStepSelectedDagV1(input: Readonly<{
  readonly events: readonly SixStepDagEventV1[];
  readonly selectedParents: readonly Readonly<{
    readonly stage1EventId: Hash;
    readonly stage2EventId: Hash;
  }>[];
}>): void {
  assertExactBoundedArray(input.selectedParents, "productionSixStepDag.selectedParents", 16);
  assertExactBoundedArray(input.events, "productionSixStepDag.events", 36);
  const legCount = input.selectedParents.length;
  if (legCount < 2 || input.events.length !== legCount * 2 + 4) {
    throw new TypeError("production Six-Step DAG denominator mismatch");
  }
  const expectedOrdinals = [
    ...Array.from({ length: legCount }, () => 1),
    ...Array.from({ length: legCount }, () => 2),
    3, 4, 5, 6,
  ];
  if (input.events.some((event, index) => event.stage.ordinal !== expectedOrdinals[index]
    || (event.stage.ordinal === 1 ? event.outcome !== "verified" : event.outcome !== "success"))
    || new Set(input.events.map(event => event.eventId)).size !== input.events.length) {
    throw new TypeError("production Six-Step DAG stage/outcome/event identity mismatch");
  }
  const byId = new Map(input.events.map(event => [event.eventId, event] as const));
  const selectedStage1Ids = input.selectedParents.map(parent => parent.stage1EventId);
  const selectedStage2Ids = input.selectedParents.map(parent => parent.stage2EventId);
  const stage1Ids = input.events.slice(0, legCount).map(event => event.eventId).sort();
  const stage2Ids = input.events.slice(legCount, legCount * 2).map(event => event.eventId).sort();
  if (!sameSequence(stage1Ids, [...selectedStage1Ids].sort())
    || !sameSequence(stage2Ids, [...selectedStage2Ids].sort())) {
    throw new TypeError("production Six-Step DAG selected Stage 1/2 denominator mismatch");
  }
  for (const [index, selected] of input.selectedParents.entries()) {
    const stage1 = byId.get(selected.stage1EventId);
    const stage2 = byId.get(selected.stage2EventId);
    if (stage1?.stage.ordinal !== 1 || stage2?.stage.ordinal !== 2
      || !sameSequence(stage1.parentEventIds, []) || !sameSequence(stage1.parentOutputHashes, [])
      || !sameSequence(stage2.parentEventIds, [stage1.eventId])
      || !sameSequence(stage2.parentOutputHashes, [stage1.outputHash])) {
      throw new TypeError(`production Six-Step DAG Stage 2 parent[${index}] mismatch`);
    }
  }
  const stage3 = input.events[legCount * 2]!;
  if (!sameSequence(stage3.parentEventIds, selectedStage2Ids)
    || !sameSequence(stage3.parentOutputHashes, selectedStage2Ids.map(eventId => byId.get(eventId)!.outputHash))) {
    throw new TypeError("production Six-Step DAG Stage 3 ordered parents mismatch");
  }
  for (let index = legCount * 2 + 1; index < input.events.length; index += 1) {
    const event = input.events[index]!;
    const parent = input.events[index - 1]!;
    if (!sameSequence(event.parentEventIds, [parent.eventId])
      || !sameSequence(event.parentOutputHashes, [parent.outputHash])) {
      throw new TypeError(`production Six-Step DAG Stage ${event.stage.ordinal} parent mismatch`);
    }
  }
}

/** @internal Independent join for the Stage 1/2 root and terminal Stage 3-6 trace. */
export function assertProductionSixStepLineageRootV1(
  claimed: Hash,
  stage12Root: Hash,
  stage36Root: Hash,
): void {
  const expected = hashDomain("aloha/searcher-production-evidence-six-step-lineage/v1", {
    stage12Root: assertHash(stage12Root, "productionSixStepLineage.stage12Root"),
    stage36Root: assertHash(stage36Root, "productionSixStepLineage.stage36Root"),
  });
  if (assertHash(claimed, "productionSixStepLineage.claimed") !== expected) {
    throw new TypeError("terminal-phase Six-Step claimed lineage root mismatch");
  }
}

function sameSequence(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function exactStageWitnessDefinitions(
  facts: SixStepStageFactsV1,
): readonly Readonly<{
  readonly role: string;
  readonly artifactRefId: Hash;
  readonly contentRoot: Hash;
  readonly stageId: SixStepStageFactsV1["stageId"];
}>[] {
  const definitions = (() => {
    switch (facts.stageId) {
      case "universe_instance": return [
        ["candidate-partition", facts.candidatePartition, facts.stageId],
        ["instance-publication", facts.instancePublication, facts.stageId],
        ["identity-proof", facts.identityProof, facts.stageId],
        ["source-coverage", facts.sourceCoverage, facts.stageId],
      ] as const;
      case "edge_ready_generation": return [
        ["instance-publication", facts.instancePublication, "universe_instance"],
        ["edge", facts.edge, facts.stageId],
        ["coverage", facts.coverage, facts.stageId],
        ["memo-reuse-proof", facts.memoReuseProof, facts.stageId],
      ] as const;
      case "planner_consumption": return [
        ["route-set", facts.routeSet, facts.stageId],
        ["coarse-projection", facts.coarseProjection, facts.stageId],
        ["admission-receipt", facts.admissionReceipt, facts.stageId],
      ] as const;
      case "current_source_exact": return [["exact-output", facts.exactOutput, facts.stageId]] as const;
      case "execution_program": return [
        ["program", facts.program, facts.stageId],
        ["pre-calls", facts.preCalls, facts.stageId],
        ["observation-pairs", facts.observationPairs, facts.stageId],
        ["action-owner", facts.actionOwner, facts.stageId],
      ] as const;
      case "final_simulation": return [
        ["final-simulation-receipt", facts.finalSimulationReceipt, facts.stageId],
        ["economic-receipt", facts.economicReceipt, facts.stageId],
        ["safety-receipt", facts.safetyReceipt, facts.stageId],
      ] as const;
    }
  })();
  return Object.freeze(definitions.map(([role, witness, stageId]) => Object.freeze({
    role,
    artifactRefId: witness.artifactRefId,
    contentRoot: witness.contentRoot,
    stageId,
  })));
}

function selectedWitness(
  observation: ExactSixStepArtifactObservationV1,
  role: string,
  path: string,
): SixStepWitnessContentV1 {
  const matches = observation.witnesses.filter(value => value.role === role);
  if (matches.length !== 1) throw new TypeError(`${path} ${role} witness is not exact`);
  return matches[0]!;
}

function assertExactStage36TerminalTraceJoin(
  tail: readonly ExactSixStepArtifactObservationV1[],
  terminal: ReturnType<typeof terminalBindingIdentity>,
  resolved: ReturnType<typeof exactTerminalResolvedSixStep>,
): void {
  const stage3 = tail[0];
  const stage4 = tail[1];
  const stage5 = tail[2];
  const stage6 = tail[3];
  if (stage3?.facts.stageId !== "planner_consumption"
    || stage4?.facts.stageId !== "current_source_exact"
    || stage5?.facts.stageId !== "execution_program"
    || stage6?.facts.stageId !== "final_simulation") {
    throw new TypeError("terminal-phase Six-Step Stage 3-6 trace denominator mismatch");
  }
  const routeBinding = resolved.routeBinding;
  const coarse = record(resolved.coarse, "terminalPhaseSixStepTerminalBinding.trace.resolved.coarse");
  const executionOwnerFacts = record(
    resolved.executionProgramOwnerEvidence.facts,
    "terminalPhaseSixStepTerminalBinding.trace.resolved.executionProgramOwnerEvidence.facts",
  );
  const expectedAdmissionClass = coarse.kind === "rankable" ? "ranked" : "bounded-unranked";
  const expectedWitnessPayloads = Object.freeze([
    Object.freeze({
      observation: stage3,
      role: "route-set",
      payload: Object.freeze({
        routeCandidateId: resolved.routeCandidateId,
        orderedEdgeIds: resolved.orderedEdgeIds,
        routeHash: routeBinding.routeHash,
      }),
    }),
    Object.freeze({ observation: stage3, role: "coarse-projection", payload: Object.freeze({ coarse: resolved.coarse }) }),
    Object.freeze({
      observation: stage3,
      role: "admission-receipt",
      payload: Object.freeze({ planned: resolved.planner, admissionClass: expectedAdmissionClass }),
    }),
    Object.freeze({ observation: stage4, role: "exact-output", payload: Object.freeze({ exact: resolved.exact }) }),
    Object.freeze({ observation: stage5, role: "program", payload: Object.freeze({ program: resolved.executionProgram }) }),
    Object.freeze({ observation: stage5, role: "pre-calls", payload: Object.freeze({ preCalls: executionOwnerFacts.preCalls }) }),
    Object.freeze({ observation: stage5, role: "observation-pairs", payload: Object.freeze({ observationPairs: executionOwnerFacts.observationPairs }) }),
    Object.freeze({ observation: stage5, role: "action-owner", payload: Object.freeze({ actionOwners: executionOwnerFacts.actionOwners }) }),
    Object.freeze({
      observation: stage6,
      role: "final-simulation-receipt",
      payload: Object.freeze({
        simulation: resolved.finalSimulation,
        ownerEvidence: resolved.finalSimulationOwnerEvidence,
      }),
    }),
    Object.freeze({
      observation: stage6,
      role: "economic-receipt",
      payload: Object.freeze({ economic: resolved.economicSafety.economic }),
    }),
    Object.freeze({
      observation: stage6,
      role: "safety-receipt",
      payload: Object.freeze({ safety: resolved.economicSafety.safety }),
    }),
  ]);
  for (const [index, expected] of expectedWitnessPayloads.entries()) {
    const witness = selectedWitness(expected.observation, expected.role, `terminalPhaseSixStep.stage36[${index}]`);
    if (!sameCanonical(witness.payload, expected.payload)) {
      throw new TypeError(`terminal-phase Six-Step ${expected.role} witness/terminal trace mismatch`);
    }
  }
  const expectedStage3Raw = Object.freeze({
    routeCandidateId: resolved.routeCandidateId,
    orderedEdgeIds: resolved.orderedEdgeIds,
    routeHash: routeBinding.routeHash,
    routeBindingHash: routeBinding.routeBindingHash,
    coarse: resolved.coarse,
    planned: resolved.planner,
    admissionClass: expectedAdmissionClass,
    rolePayloads: expectedWitnessPayloads.slice(0, 3).map(value => value.payload),
  });
  if (!sameCanonical(stage3.rawBoundary.payload, expectedStage3Raw)) {
    throw new TypeError("terminal-phase Six-Step Stage 3 raw boundary/terminal trace mismatch");
  }
  const executionCallerMode = exactNonEmptyString(
    executionOwnerFacts.callerMode,
    "terminalPhaseSixStepTerminalBinding.trace.resolved.executionProgramOwnerEvidence.facts.callerMode",
  );
  const expectedStage4Raw = Object.freeze({
    exact: resolved.exact,
    rolePayloads: expectedWitnessPayloads.slice(3, 4).map(value => value.payload),
  });
  const expectedStage5Raw = Object.freeze({
    program: resolved.executionProgram,
    ownerEvidence: resolved.executionProgramOwnerEvidence,
    callerMode: executionCallerMode,
    rolePayloads: expectedWitnessPayloads.slice(4, 8).map(value => value.payload),
  });
  const expectedStage6Raw = Object.freeze({
    program: resolved.executionProgram,
    simulation: resolved.finalSimulation,
    ownerEvidence: resolved.finalSimulationOwnerEvidence,
    economicSafety: resolved.economicSafety,
    rolePayloads: expectedWitnessPayloads.slice(8).map(value => value.payload),
  });
  if (!sameCanonical(stage4.rawBoundary.payload, expectedStage4Raw)) {
    throw new TypeError("terminal-phase Six-Step Stage 4 raw boundary/terminal trace mismatch");
  }
  if (!sameCanonical(stage5.rawBoundary.payload, expectedStage5Raw)
    || stage5.facts.stageId !== "execution_program"
    || stage5.facts.callerMode !== executionCallerMode) {
    throw new TypeError("terminal-phase Six-Step Stage 5 raw boundary/terminal trace mismatch");
  }
  if (!sameCanonical(stage6.rawBoundary.payload, expectedStage6Raw)) {
    throw new TypeError("terminal-phase Six-Step Stage 6 raw boundary/terminal trace mismatch");
  }
  const executionProgramHash = assertHash(
    resolved.executionProgram.programHash,
    "terminalPhaseSixStepTerminalBinding.trace.resolved.executionProgram.programHash",
  );
  const executionOwnerProgramHash = assertHash(
    resolved.executionProgramOwnerEvidence.programHash,
    "terminalPhaseSixStepTerminalBinding.trace.resolved.executionProgramOwnerEvidence.programHash",
  );
  const finalSimulationProgramHash = assertHash(
    resolved.finalSimulation.programHash,
    "terminalPhaseSixStepTerminalBinding.trace.resolved.finalSimulation.programHash",
  );
  const finalOwnerProgramHash = assertHash(
    resolved.finalSimulationOwnerEvidence.programHash,
    "terminalPhaseSixStepTerminalBinding.trace.resolved.finalSimulationOwnerEvidence.programHash",
  );
  const receiptHash = assertHash(
    resolved.finalSimulation.receiptHash,
    "terminalPhaseSixStepTerminalBinding.trace.resolved.finalSimulation.receiptHash",
  );
  const ownerReceiptHash = assertHash(
    resolved.finalSimulationOwnerEvidence.finalSimulationReceiptHash,
    "terminalPhaseSixStepTerminalBinding.trace.resolved.finalSimulationOwnerEvidence.finalSimulationReceiptHash",
  );
  if (stage3.facts.admissionClass !== expectedAdmissionClass
    || executionProgramHash !== terminal.programHash
    || executionOwnerProgramHash !== terminal.programHash
    || finalSimulationProgramHash !== terminal.programHash
    || finalOwnerProgramHash !== terminal.programHash
    || receiptHash !== terminal.finalSimulationReceiptHash
    || ownerReceiptHash !== terminal.finalSimulationReceiptHash) {
    throw new TypeError("terminal-phase Six-Step Stage 3-6 terminal program/receipt mismatch");
  }
}

function exactStage2ReadyBinding(
  rawBoundary: SixStepNativeBoundaryRecordV1,
  path: string,
): ReturnType<typeof exactSelectedStage12Binding> {
  if (rawBoundary.stageId !== "edge_ready_generation" || rawBoundary.role !== "raw-boundary") {
    throw new TypeError(`${path} is not an exact Stage 2 raw boundary`);
  }
  const payload = record(rawBoundary.payload, `${path}.payload`);
  const ready = record(payload.ready, `${path}.payload.ready`);
  return exactSelectedStage12Binding(Object.freeze({
    readyRecordHash: ready.readyRecordHash,
    generationId: ready.generationId,
    cutoff: ready.cutoff,
    definitionCatalogRoot: ready.definitionCatalogRoot,
    sourceCoverageRoot: ready.sourceCoverageRoot,
    candidatePartitionRoot: ready.candidatePartitionRoot,
    exactOutcomePartitionRoot: ready.exactOutcomePartitionRoot,
    verifiedMemoSetRoot: ready.verifiedMemoSetRoot,
    instanceCatalogRoot: ready.instanceCatalogRoot,
    graphRoot: ready.graphRoot,
    releaseProvenanceHash: ready.releaseProvenanceHash,
    promotionRevision: ready.promotionRevision,
  }));
}

/** @internal Strict decoder for the producer's real GraphLeaseBindingV1 wire shape. */
export function exactProductionGraphLeaseBindingV1(value: unknown): Readonly<{
  readonly generationId: string;
  readonly readyRecordHash: Hash;
  readonly generationRefreshPolicyHash: Hash;
  readonly cutoff: ReturnType<typeof exactSelectedStage12Binding>["cutoff"];
  readonly definitionCatalogRoot: Hash;
  readonly instanceCatalogRoot: Hash;
  readonly graphRoot: Hash;
  readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
  readonly releaseProvenanceHash: Hash;
  readonly candidatePartitionProofStorageHash: Hash;
  readonly nominationClosureRoot: Hash;
  readonly nominationClosureStorageHash: Hash;
}> {
  const path = "terminalPhaseSixStepTerminalBinding.trace.resolved.binding";
  const binding = record(value, path);
  assertExactKeys(binding, [
    "generationId", "readyRecordHash", "generationRefreshPolicyHash", "cutoff",
    "definitionCatalogRoot", "instanceCatalogRoot", "graphRoot", "runtimeAuthority", "releaseProvenanceHash",
    "candidatePartitionProofStorageHash", "nominationClosureRoot", "nominationClosureStorageHash",
  ], path);
  const cutoff = record(binding.cutoff, `${path}.cutoff`);
  assertExactKeys(cutoff, ["chainId", "number", "hash", "stateRoot"], `${path}.cutoff`);
  const runtimeAuthority = decodeRuntimeAuthorityProjectionV1(binding.runtimeAuthority);
  if (runtimeAuthority.authorityClass !== "signed-release") {
    throw new TypeError(`${path}.runtimeAuthority must be signed-release`);
  }
  return Object.freeze({
    generationId: exactNonEmptyString(binding.generationId, `${path}.generationId`),
    readyRecordHash: assertHash(binding.readyRecordHash, `${path}.readyRecordHash`),
    generationRefreshPolicyHash: assertHash(binding.generationRefreshPolicyHash, `${path}.generationRefreshPolicyHash`),
    cutoff: Object.freeze({
      chainId: assertDecimalString(cutoff.chainId, `${path}.cutoff.chainId`),
      number: assertDecimalString(cutoff.number, `${path}.cutoff.number`),
      hash: assertHash(cutoff.hash, `${path}.cutoff.hash`),
      stateRoot: assertHash(cutoff.stateRoot, `${path}.cutoff.stateRoot`),
    }),
    definitionCatalogRoot: assertHash(binding.definitionCatalogRoot, `${path}.definitionCatalogRoot`),
    instanceCatalogRoot: assertHash(binding.instanceCatalogRoot, `${path}.instanceCatalogRoot`),
    graphRoot: assertHash(binding.graphRoot, `${path}.graphRoot`),
    runtimeAuthority,
    releaseProvenanceHash: assertHash(binding.releaseProvenanceHash, `${path}.releaseProvenanceHash`),
    candidatePartitionProofStorageHash: assertHash(binding.candidatePartitionProofStorageHash, `${path}.candidatePartitionProofStorageHash`),
    nominationClosureRoot: assertHash(binding.nominationClosureRoot, `${path}.nominationClosureRoot`),
    nominationClosureStorageHash: assertHash(binding.nominationClosureStorageHash, `${path}.nominationClosureStorageHash`),
  });
}

function exactTerminalResolvedSixStep(
  terminal: ReturnType<typeof terminalBindingIdentity>,
): Readonly<{
  readonly binding: ReturnType<typeof exactProductionGraphLeaseBindingV1>;
  readonly routeCandidateId: Hash;
  readonly orderedEdgeIds: readonly Hash[];
  readonly routeBinding: Readonly<{
    readonly routeHash: Hash;
    readonly routeBindingHash: Hash;
    readonly legs: readonly Readonly<{ readonly edgeId: Hash; readonly ownerRef: Hash }>[];
  }>;
  readonly coarse: unknown;
  readonly planner: unknown;
  readonly exact: unknown;
  readonly executionProgram: Record<string, unknown>;
  readonly executionProgramOwnerEvidence: Record<string, unknown>;
  readonly finalSimulation: Record<string, unknown>;
  readonly finalSimulationOwnerEvidence: Record<string, unknown>;
  readonly economicSafety: Record<string, unknown>;
  readonly productionArtifactSetRoots: readonly Hash[];
}> {
  const trace = record(terminal.value.trace, "terminalPhaseSixStepTerminalBinding.trace");
  const resolved = record(trace.resolved, "terminalPhaseSixStepTerminalBinding.trace.resolved");
  assertExactKeys(resolved, [
    "schemaVersion", "kind", "binding", "routeCandidateId", "orderedEdgeIds", "routeBinding",
    "strategy", "objective", "source", "correlationId", "coarse", "planner", "exact",
    "executionProgram", "executionProgramOwnerEvidence", "finalSimulation", "finalSimulationOwnerEvidence",
    "economicSafety", "unsignedDryRun", "timings", "productionArtifactSetRoots", "traceRoot",
  ], "terminalPhaseSixStepTerminalBinding.trace.resolved");
  if (resolved.schemaVersion !== 1 || resolved.kind !== "aloha.resolved-route-six-step-trace-v1") {
    throw new TypeError("terminal-phase Six-Step resolved trace kind/version mismatch");
  }
  const resolvedTraceRoot = assertHash(resolved.traceRoot, "terminalPhaseSixStepTerminalBinding.trace.resolved.traceRoot");
  const { traceRoot: _resolvedTraceRoot, ...resolvedPayload } = resolved;
  if (resolvedTraceRoot !== hashDomain("aloha/resolved-route-six-step-trace/v1", resolvedPayload as CanonicalJson)) {
    throw new TypeError("terminal-phase Six-Step resolved trace root mismatch");
  }
  const binding = exactProductionGraphLeaseBindingV1(resolved.binding);
  assertExactBoundedArray(
    resolved.productionArtifactSetRoots,
    "terminalPhaseSixStepTerminalBinding.trace.resolved.productionArtifactSetRoots",
    4,
  );
  if (resolved.productionArtifactSetRoots.length !== 4) {
    throw new TypeError("terminal-phase Six-Step terminal production artifact root denominator mismatch");
  }
  assertExactBoundedArray(resolved.orderedEdgeIds, "terminalPhaseSixStepTerminalBinding.trace.resolved.orderedEdgeIds", 16);
  const orderedEdgeIds = Object.freeze(resolved.orderedEdgeIds.map((value, index) =>
    assertHash(value, `terminalPhaseSixStepTerminalBinding.trace.resolved.orderedEdgeIds[${index}]`)));
  const rawRouteBinding = record(resolved.routeBinding, "terminalPhaseSixStepTerminalBinding.trace.resolved.routeBinding");
  assertExactKeys(rawRouteBinding, ["routeHash", "routeBindingHash", "legs"], "terminalPhaseSixStepTerminalBinding.trace.resolved.routeBinding");
  assertExactBoundedArray(rawRouteBinding.legs, "terminalPhaseSixStepTerminalBinding.trace.resolved.routeBinding.legs", 16);
  if (rawRouteBinding.legs.length < 2) throw new TypeError("terminal-phase Six-Step route binding has fewer than two legs");
  const routeLegs = Object.freeze(rawRouteBinding.legs.map((value, index) => {
    const path = `terminalPhaseSixStepTerminalBinding.trace.resolved.routeBinding.legs[${index}]`;
    const leg = record(value, path);
    assertExactKeys(leg, ["edgeId", "ownerRef"], path);
    return Object.freeze({
      edgeId: assertHash(leg.edgeId, `${path}.edgeId`),
      ownerRef: assertHash(leg.ownerRef, `${path}.ownerRef`),
    });
  }));
  const routeBinding = Object.freeze({
    routeHash: assertHash(rawRouteBinding.routeHash, "terminalPhaseSixStepTerminalBinding.trace.resolved.routeBinding.routeHash"),
    routeBindingHash: assertHash(rawRouteBinding.routeBindingHash, "terminalPhaseSixStepTerminalBinding.trace.resolved.routeBinding.routeBindingHash"),
    legs: routeLegs,
  });
  if (routeBinding.routeBindingHash !== acceptanceRouteBindingHashV1(routeLegs)) {
    throw new TypeError("terminal-phase Six-Step route binding hash mismatch");
  }
  return Object.freeze({
    binding,
    routeCandidateId: assertHash(resolved.routeCandidateId, "terminalPhaseSixStepTerminalBinding.trace.resolved.routeCandidateId"),
    orderedEdgeIds,
    routeBinding,
    coarse: resolved.coarse,
    planner: resolved.planner,
    exact: resolved.exact,
    executionProgram: record(resolved.executionProgram, "terminalPhaseSixStepTerminalBinding.trace.resolved.executionProgram"),
    executionProgramOwnerEvidence: record(resolved.executionProgramOwnerEvidence, "terminalPhaseSixStepTerminalBinding.trace.resolved.executionProgramOwnerEvidence"),
    finalSimulation: record(resolved.finalSimulation, "terminalPhaseSixStepTerminalBinding.trace.resolved.finalSimulation"),
    finalSimulationOwnerEvidence: record(resolved.finalSimulationOwnerEvidence, "terminalPhaseSixStepTerminalBinding.trace.resolved.finalSimulationOwnerEvidence"),
    economicSafety: record(resolved.economicSafety, "terminalPhaseSixStepTerminalBinding.trace.resolved.economicSafety"),
    productionArtifactSetRoots: Object.freeze(resolved.productionArtifactSetRoots.map((value, index) =>
      assertHash(value, `terminalPhaseSixStepTerminalBinding.trace.resolved.productionArtifactSetRoots[${index}]`))),
  });
}

function assertExactStage12BindingJoin(
  binding: ReturnType<typeof exactSelectedStage12Binding>,
  terminal: ReturnType<typeof terminalBindingIdentity>,
  identity: ReturnType<typeof processIdentity>,
  resolved: ReturnType<typeof exactTerminalResolvedSixStep>,
): void {
  const serving = record(identity.value.serving, "terminalPhaseSelectedProcess.serving");
  assertExactKeys(serving, ["generationId", "graphRoot", "readyRecordHash", "sourceCoverageRoot"], "terminalPhaseSelectedProcess.serving");
  const servingBinding = Object.freeze({
    generationId: exactNonEmptyString(serving.generationId, "terminalPhaseSelectedProcess.serving.generationId"),
    graphRoot: assertHash(serving.graphRoot, "terminalPhaseSelectedProcess.serving.graphRoot"),
    readyRecordHash: assertHash(serving.readyRecordHash, "terminalPhaseSelectedProcess.serving.readyRecordHash"),
    sourceCoverageRoot: assertHash(serving.sourceCoverageRoot, "terminalPhaseSelectedProcess.serving.sourceCoverageRoot"),
  });
  const terminalDefinitionCatalogRoot = assertHash(
    terminal.value.definitionCatalogRoot,
    "terminalPhaseSixStepTerminalBinding.definitionCatalogRoot",
  );
  if (binding.readyRecordHash !== terminal.readyRecordHash
    || binding.generationId !== terminal.generationId
    || binding.graphRoot !== terminal.graphRoot
    || binding.definitionCatalogRoot !== terminalDefinitionCatalogRoot
    || binding.releaseProvenanceHash !== terminal.releaseProvenanceHash
    || binding.readyRecordHash !== identity.readyRecordHash
    || binding.generationId !== identity.generationId
    || binding.graphRoot !== identity.graphRoot
    || binding.releaseProvenanceHash !== identity.releaseProvenanceHash
    || binding.readyRecordHash !== servingBinding.readyRecordHash
    || binding.generationId !== servingBinding.generationId
    || binding.graphRoot !== servingBinding.graphRoot
    || binding.sourceCoverageRoot !== servingBinding.sourceCoverageRoot
    || binding.readyRecordHash !== resolved.binding.readyRecordHash
    || binding.generationId !== resolved.binding.generationId
    || !sameCanonical(binding.cutoff, resolved.binding.cutoff)
    || binding.definitionCatalogRoot !== resolved.binding.definitionCatalogRoot
    || binding.instanceCatalogRoot !== resolved.binding.instanceCatalogRoot
    || binding.graphRoot !== resolved.binding.graphRoot
    || binding.releaseProvenanceHash !== resolved.binding.releaseProvenanceHash) {
    throw new TypeError("terminal-phase Six-Step Stage 1/2 binding/serving/terminal splice");
  }
}

const FULL_FAMILY_TERMINAL_BINDING_KEYS = [
  "schemaVersion", "kind", "runtimeBindingId", "candidateReleaseCommit", "releaseProvenanceHash",
  "finalDurableWindowId", "producerTerminalId", "producerHeadFactsRoot", "producerTerminalBindingRoot",
  "laneTerminalSetRoot", "searchTerminalHash", "terminalKind", "terminalLineageHash",
  "readyRecordHash", "generationId", "graphRoot", "generatedRuntime", "readyCutoff", "actualCurrentSource", "nativeAuditManifest", "bindingRoot",
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
  const auditManifest = decodeNativeFullFamilyAuditManifestV1(
    encodeCanonicalBytes(value.nativeAuditManifest as CanonicalJson),
  );
  const auditBinding = auditManifest.binding;
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
    auditRoot: auditManifest.auditRoot,
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
    "amountSeedHash", "executionContextHash", "objectiveRef", "bindingRoot",
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
  const graphRoot = hashDomain("aloha/persisted-graph/v2", {
    cutoff: sweep.readyCutoff,
    instanceCatalogRoot: bundle.runtime.instanceCatalogRoot,
    edgeCount: String(orderedProjectedEdges.length),
    edgeSequenceRoot: hashCanonicalPartition(
      "aloha/persisted-graph-edge-sequence/v1",
      orderedProjectedEdges.map(edge => edge.edgeId),
      128,
    ),
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
    const storage = decodeFullFamilyFactBundleStorageV1(bundleBytes);
    const artifactBytesByRef = new Map<Hash, Readonly<{ readonly contentSha256: Hash; readonly bytes: Uint8Array }>>();
    for (const [position, artifact] of predicateArtifacts.entries()) {
      const bytes = predicateArtifactBytes[position];
      if (bytes === undefined || sha256Hex(bytes) !== artifact.contentSha256) {
        throw new TypeError("terminal-phase Full-Family predicate artifact bytes are incomplete");
      }
      if (artifactBytesByRef.has(artifact.ref.artifactRefId)) {
        throw new TypeError("terminal-phase Full-Family predicate artifact is duplicated");
      }
      artifactBytesByRef.set(artifact.ref.artifactRefId, Object.freeze({ contentSha256: artifact.contentSha256, bytes }));
    }
    const usedRefs = new Set<Hash>();
    const bundle = materializeFullFamilyFactBundleStorageV1(storage, (artifactRefId, contentSha256) => {
      const artifact = artifactBytesByRef.get(artifactRefId);
      if (artifact === undefined || artifact.contentSha256 !== contentSha256) {
        throw new TypeError("terminal-phase Full-Family stored artifact is missing");
      }
      usedRefs.add(artifactRefId);
      return artifact.bytes;
    }, decodeFullFamilyStoredItemV1);
    const locator = decodeFullFamilyFactLocator(decodeCanonicalBytes(locatorBytes) as object);
    if (locator.bundleArtifactRefId !== bundleArtifact.ref.artifactRefId
      || locator.bundleContentSha256 !== bundleArtifact.contentSha256
      || projection.readyRecordHash !== bundle.runtime.readyRecordHash) {
      throw new TypeError("terminal-phase Full-Family locator/bundle/projection splice");
    }
    const expectedMap = new Map(referencedFullFamilyArtifactDigests(bundle));
    for (const artifactRefId of usedRefs) {
      const observed = artifactBytesByRef.get(artifactRefId)!;
      const prior = expectedMap.get(artifactRefId);
      if (prior !== undefined && prior !== observed.contentSha256) {
        throw new TypeError("terminal-phase Full-Family stored/semantic artifact digest splice");
      }
      expectedMap.set(artifactRefId, observed.contentSha256);
    }
    const expected = [...expectedMap].sort(([left], [right]) => left.localeCompare(right));
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
  rootOwnedReadyGraph: Readonly<{
    readonly activeGraph: ProductionActiveReadyGraphSnapshotV1;
    readonly definitionCatalogRoot: Hash;
  }> | null,
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
    const observationRoot = productionSixStepNonObservedRootV1(Object.freeze({
      kind: manifest.sixStep.status === "missing"
        ? "aloha.production-six-step-observation-missing-v1" as const
        : "aloha.production-six-step-observation-invalid-v1" as const,
      status: manifest.sixStep.status,
      reason: manifest.sixStep.reason!,
      finalDurableWindowId: manifest.sixStep.reason === "window-selection-capability-invalid"
        ? null
        : manifest.finalDurableWindowId,
      windowSelectionRoot: manifest.sixStep.windowSelectionRoot,
      selectionPolicyDigest: manifest.sixStep.selectionPolicyDigest,
      eligibleSuccessCount: manifest.sixStep.eligibleSuccessCount,
      eligibleSuccessRoot: manifest.sixStep.eligibleSuccessRoot,
      selectedIndex: manifest.sixStep.selectedIndex,
      selectedProducerTerminalId: manifest.sixStep.selectedProducerTerminalId,
      observedArtifacts: Object.freeze([]),
    }));
    if (manifest.sixStep.observationRoot !== observationRoot) {
      throw new TypeError("terminal-phase non-observed Six-Step observation root mismatch");
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
  const selectedGraphLegs = exactTerminalSelectedGraphLegs(terminal);
  const resolved = exactTerminalResolvedSixStep(terminal);
  const stage12 = exactSelectedStage12(identity.value.stage12, identity.stage12Root);
  const rootOwnedSelectedEdges = rootOwnedReadyGraph === null
    ? null
    : exactRootOwnedSelectedReadyEdges(
      rootOwnedReadyGraph.activeGraph,
      stage12.binding,
      resolved.binding,
      selectedGraphLegs,
      rootOwnedReadyGraph.definitionCatalogRoot,
    );
  const legCount = selectedGraphLegs.length;
  if (stage12.selectedParents.length !== legCount
    || resolved.orderedEdgeIds.length !== legCount
    || resolved.routeBinding.legs.length !== legCount
    || stage12.selectedParents.some((parent, index) => parent.edgeId !== selectedGraphLegs[index]!.edgeId
      || resolved.orderedEdgeIds[index] !== selectedGraphLegs[index]!.edgeId
      || resolved.routeBinding.legs[index]!.edgeId !== selectedGraphLegs[index]!.edgeId)) {
    throw new TypeError("terminal-phase Six-Step Stage 1/2 route denominator mismatch");
  }
  assertExactTerminalPlannedRouteJoin(terminal, resolved, selectedGraphLegs, rootOwnedSelectedEdges);
  assertExactStage12BindingJoin(stage12.binding, terminal, identity, resolved);
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
  const stageEventIds: Hash[] = [];
  const stageObservations: ExactSixStepArtifactObservationV1[] = [];
  const reachableRefs = new Set<Hash>();
  for (const [position, eventArtifactRefId] of manifest.sixStep.eventArtifactRefIds.entries()) {
    const observedEvent = artifactsByRef.get(eventArtifactRefId);
    if (observedEvent === undefined || !sameSchema(observedEvent.artifact.ref, EVIDENCE_SCHEMA_MANIFESTS.event)) {
      throw new TypeError(`terminal-phase Six-Step event artifact[${position}] is missing`);
    }
    const event = decodeEvidenceEvent(observedEvent.bytes);
    const facts = decodeSixStepStageFacts(event.facts);
    const stageInput = decodeSixStepStageInput(event.inputs);
    if (!sameCanonical(event.factSchema, {
      id: SIX_STEP_SCHEMA_MANIFESTS.stageFacts.id,
      version: SIX_STEP_SCHEMA_MANIFESTS.stageFacts.version,
      schemaHash: SIX_STEP_SCHEMA_MANIFESTS.stageFacts.schemaHash,
    }) || !sameCanonical(event.inputSchema, {
      id: SIX_STEP_SCHEMA_MANIFESTS.stageInput.id,
      version: SIX_STEP_SCHEMA_MANIFESTS.stageInput.version,
      schemaHash: SIX_STEP_SCHEMA_MANIFESTS.stageInput.schemaHash,
    }) || facts.stageId !== event.stage.id || stageInput.stageId !== event.stage.id) {
      throw new TypeError(`terminal-phase Six-Step event artifact[${position}] schema/stage mismatch`);
    }
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
      || !sameSchema(rawEntry.artifact.ref, SIX_STEP_SCHEMA_MANIFESTS.nativeBoundaryRecord)
      || !sameSchema(logEntry.artifact.ref, SIX_STEP_SCHEMA_MANIFESTS.nativeBoundaryRecord)
      || !sameCanonical(rawEntry.artifact.ref, receipt.rawBoundaryArtifactRef)
      || !sameCanonical(logEntry.artifact.ref, receipt.logRangeArtifactRef)
      || !sameCanonical(event.source.rawBoundaryArtifactRef, receipt.rawBoundaryArtifactRef)) {
      throw new TypeError(`terminal-phase Six-Step event artifact[${position}] input closure is incomplete`);
    }
    const rawBoundary = decodeSixStepNativeBoundaryRecord(rawEntry.bytes);
    const nativeLog = decodeSixStepNativeBoundaryRecord(logEntry.bytes);
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
    const witnessContents = witnesses.map((artifact, witnessIndex) => {
      if (!sameSchema(artifact.ref, SIX_STEP_SCHEMA_MANIFESTS.witnessContent)) {
        throw new TypeError(`terminal-phase Six-Step event artifact[${position}] witness[${witnessIndex}] schema mismatch`);
      }
      return decodeSixStepWitnessContent(inputEntries[witnessIndex + 1]!.bytes);
    });
    const inputArtifacts = [rawEntry.artifact, logEntry.artifact, ...witnesses];
    const expectedWitnesses = exactStageWitnessDefinitions(facts);
    if (rawBoundary.stageId !== event.stage.id || rawBoundary.role !== "raw-boundary"
      || nativeLog.stageId !== event.stage.id || nativeLog.role !== "native-log"
      || !sameSequence(stageInput.parentEventIds, event.parentEventIds)
      || stageInput.rawBoundaryArtifactRefId !== rawEntry.artifact.ref.artifactRefId
      || !sameSequence(stageInput.orderedWitnessArtifactRefIds, witnesses.map(value => value.ref.artifactRefId))
      || witnessContents.length !== expectedWitnesses.length
      || witnessContents.some((content, witnessIndex) => {
        const expected = expectedWitnesses[witnessIndex]!;
        return content.role !== expected.role || content.stageId !== expected.stageId
          || witnesses[witnessIndex]!.ref.artifactRefId !== expected.artifactRefId
          || hashSixStepWitnessContentRoot(content) !== expected.contentRoot;
      })) {
      throw new TypeError(`terminal-phase Six-Step event artifact[${position}] raw/input/witness closure mismatch`);
    }
    const eventFact = Object.freeze({
      schemaVersion: 1 as const,
      kind: "aloha.six-step-event-fact" as const,
      eventArtifactRefId,
      semanticArtifactRefId: semanticEntry.artifact.ref.artifactRefId,
      productionReceiptArtifactRefId: receiptEntry.artifact.ref.artifactRefId,
    });
    eventFacts.push(eventFact);
    stageOrdinals.push(event.stage.ordinal);
    stageEventIds.push(event.eventId);
    for (const artifact of [observedEvent.artifact, semanticEntry.artifact, receiptEntry.artifact, ...inputArtifacts]) {
      reachableRefs.add(artifact.ref.artifactRefId);
    }
    const artifactSetRoot = hashDomain("aloha/production-six-step-artifact-set/v1", {
      eventFact,
      inputArtifactRefIds: inputArtifacts.map(value => value.ref.artifactRefId),
      witnessArtifactRefIds: witnesses.map(value => value.ref.artifactRefId),
      resolutionClaimIds: [observedEvent.artifact, semanticEntry.artifact, receiptEntry.artifact, ...inputArtifacts].map(value => value.claim.claimId),
      leaseReceiptIds: [observedEvent.artifact, semanticEntry.artifact, receiptEntry.artifact, ...inputArtifacts].map(value => value.lease.receiptId),
    });
    stageArtifactSetRoots.push(artifactSetRoot);
    stageObservations.push(Object.freeze({
      event,
      facts,
      rawBoundary,
      witnesses: Object.freeze(witnessContents),
      artifactSetRoot,
    }));
  }
  const expectedStageOrdinals = Object.freeze([
    ...Array.from({ length: legCount }, () => 1),
    ...Array.from({ length: legCount }, () => 2),
    3, 4, 5, 6,
  ]);
  if (stageOrdinals.length !== expectedStageOrdinals.length
    || stageOrdinals.some((ordinal, position) => ordinal !== expectedStageOrdinals[position])) {
    throw new TypeError("terminal-phase Six-Step stage denominator/order mismatch");
  }
  assertProductionSixStepSelectedDagV1({
    events: stageObservations.map(observation => observation.event),
    selectedParents: stage12.selectedParents,
  });
  if (new Set(stageEventIds).size !== stageEventIds.length
    || stageObservations.some(observation => observation.event.stage.ordinal === 1
      ? observation.event.outcome !== "verified"
      : observation.event.outcome !== "success")) {
    throw new TypeError("terminal-phase Six-Step event identity/outcome denominator mismatch");
  }
  const byEventId = new Map(stageObservations.map(value => [value.event.eventId, value] as const));
  const selectedStage1Ids = stage12.selectedParents.map(parent => parent.stage1EventId);
  const selectedStage2Ids = stage12.selectedParents.map(parent => parent.stage2EventId);
  const stage1PrefixIds = stageEventIds.slice(0, legCount);
  const stage2PrefixIds = stageEventIds.slice(legCount, legCount * 2);
  if ([...stage1PrefixIds].sort().some((eventId, index) => eventId !== [...selectedStage1Ids].sort()[index])
    || [...stage2PrefixIds].sort().some((eventId, index) => eventId !== [...selectedStage2Ids].sort()[index])) {
    throw new TypeError("terminal-phase Six-Step Stage 1/2 selected event denominator mismatch");
  }
  const stage3 = stageObservations[legCount * 2];
  if (stage3 === undefined || stage3.event.eventId !== stage12.stage3EventId
    || stage3.artifactSetRoot !== stage12.stage3ArtifactSetRoot
    || stage3.facts.stageId !== "planner_consumption"
    || stage3.facts.orderedInstanceBindings.length !== legCount
    || stage3.facts.orderedInstanceBindingsRoot !== hashOrderedInstanceBindingsRoot(stage3.facts.orderedInstanceBindings)) {
    throw new TypeError("terminal-phase Six-Step Stage 1/2/3 selected-parent splice");
  }
  for (const [index, selectedParent] of stage12.selectedParents.entries()) {
    const leg = selectedGraphLegs[index]!;
    const stage1 = byEventId.get(selectedParent.stage1EventId);
    const stage2 = byEventId.get(selectedParent.stage2EventId);
    const routeBinding = stage3.facts.orderedInstanceBindings[index]!;
    if (stage1 === undefined || stage1.facts.stageId !== "universe_instance"
      || stage2 === undefined || stage2.facts.stageId !== "edge_ready_generation") {
      throw new TypeError(`terminal-phase Six-Step Stage 1/2 selected parent[${index}] is missing`);
    }
    const readyBinding = exactStage2ReadyBinding(
      stage2.rawBoundary,
      `terminalPhaseSixStep.stage2[${index}].rawBoundary`,
    );
    const stage2Raw = record(stage2.rawBoundary.payload, `terminalPhaseSixStep.stage2[${index}].rawBoundary.payload`);
    const stage1CandidatePartition = selectedWitness(
      stage1,
      "candidate-partition",
      `terminalPhaseSixStep.stage1[${index}]`,
    );
    const stage1Publication = selectedWitness(stage1, "instance-publication", `terminalPhaseSixStep.stage1[${index}]`);
    const stage2Publication = selectedWitness(stage2, "instance-publication", `terminalPhaseSixStep.stage2[${index}]`);
    const stage2Edge = selectedWitness(stage2, "edge", `terminalPhaseSixStep.stage2[${index}]`);
    const stage2Coverage = selectedWitness(stage2, "coverage", `terminalPhaseSixStep.stage2[${index}]`);
    const publication = record(stage2Publication.payload, `terminalPhaseSixStep.stage2[${index}].publication`);
    const edge = exactStage2PersistedGraphEdgeV1(
      stage2Edge.payload,
      stage2Raw.edge,
      rootOwnedSelectedEdges?.[index] ?? null,
      `terminalPhaseSixStep.stage2[${index}].edge`,
    );
    const coverage = record(stage2Coverage.payload, `terminalPhaseSixStep.stage2[${index}].coverage`);
    const candidatePartition = record(
      stage1CandidatePartition.payload,
      `terminalPhaseSixStep.stage1[${index}].candidatePartition`,
    );
    if (!sameCanonical(readyBinding, stage12.binding)
      || candidatePartition.candidatePartitionRoot !== stage12.binding.candidatePartitionRoot
      || stage2.facts.generationId !== stage12.binding.generationId
      || stage2.facts.promotionRevision !== stage12.binding.promotionRevision
      || stage2.event.scope.kind !== "ready-generation"
      || stage2.event.scope.generationId !== stage12.binding.generationId
      || stage1.event.definitionCatalogRoot !== stage12.binding.definitionCatalogRoot
      || stage2.event.definitionCatalogRoot !== stage12.binding.definitionCatalogRoot
      || stage2.event.instanceCatalogRoot !== stage12.binding.instanceCatalogRoot
      || stage2.event.graphRoot !== stage12.binding.graphRoot
      || stage1.event.cutoff.number !== stage12.binding.cutoff.number
      || stage1.event.cutoff.hash !== stage12.binding.cutoff.hash
      || stage1.event.cutoff.stateRoot !== stage12.binding.cutoff.stateRoot
      || stage2.event.cutoff.number !== stage12.binding.cutoff.number
      || stage2.event.cutoff.hash !== stage12.binding.cutoff.hash
      || stage2.event.cutoff.stateRoot !== stage12.binding.cutoff.stateRoot
      || stage1.event.familyId !== leg.owningFamilyId
      || stage2.event.familyId !== leg.owningFamilyId
      || stage1.event.familyDefinitionHash !== leg.owningFamilyDefinitionHash
      || stage2.event.familyDefinitionHash !== leg.owningFamilyDefinitionHash
      || stage1.event.instanceKey !== leg.owningInstanceKey
      || stage2.event.instanceKey !== leg.owningInstanceKey
      || !sameSequence(stage1.event.parentEventIds, [])
      || !sameSequence(stage1.event.parentOutputHashes, [])
      || !sameSequence(stage2.event.parentEventIds, [stage1.event.eventId])
      || !sameSequence(stage2.event.parentOutputHashes, [stage1.event.outputHash])
      || selectedParent.selectedLegRoot !== selectedGraphLegRoot(leg)
      || selectedParent.stage1ArtifactSetRoot !== stage1.artifactSetRoot
      || selectedParent.stage2ArtifactSetRoot !== stage2.artifactSetRoot
      || selectedParent.instancePublicationRoot !== stage2.facts.instancePublication.contentRoot
      || selectedParent.edgeContentRoot !== stage2.facts.edge.contentRoot
      || stage1.facts.instancePublication.contentRoot !== stage2.facts.instancePublication.contentRoot
      || !sameCanonical(stage1Publication.payload, stage2Publication.payload)
      || !sameCanonical(stage2Raw.publication, stage2Publication.payload)
      || !sameCanonical(stage2Raw.edge, stage2Edge.payload)
      || coverage.sourceCoverageRoot !== stage12.binding.sourceCoverageRoot
      || publication.instancePublicationHash !== leg.instancePublicationHash
      || publication.instanceKey !== leg.owningInstanceKey
      || publication.familyDefinitionHash !== leg.owningFamilyDefinitionHash
      || edge.edgeId !== leg.edgeId
      || edge.owningFamilyId !== leg.owningFamilyId
      || edge.owningFamilyDefinitionHash !== leg.owningFamilyDefinitionHash
      || edge.owningInstanceKey !== leg.owningInstanceKey
      || edge.instancePublicationHash !== leg.instancePublicationHash
      || edge.staticProjectionHash !== leg.staticProjectionHash
      || edge.projectionHash !== leg.projectionHash
      || routeBinding.edgeId !== leg.edgeId
      || routeBinding.instanceKey !== leg.owningInstanceKey
      || routeBinding.stage1EventId !== stage1.event.eventId
      || routeBinding.stage2EventId !== stage2.event.eventId
      || routeBinding.instancePublicationRoot !== stage2.facts.instancePublication.contentRoot) {
      throw new TypeError(`terminal-phase Six-Step Stage 1/2 selected parent[${index}] lineage mismatch`);
    }
  }
  if (!sameSequence(stage3.event.parentEventIds, selectedStage2Ids)
    || !sameSequence(stage3.event.parentOutputHashes, selectedStage2Ids.map(eventId => byEventId.get(eventId)!.event.outputHash))) {
    throw new TypeError("terminal-phase Six-Step Stage 3 ordered parent DAG mismatch");
  }
  const tail = stageObservations.slice(legCount * 2);
  for (const [index, observation] of tail.entries()) {
    if (index === 0) continue;
    const parent = tail[index - 1]!;
    if (!sameSequence(observation.event.parentEventIds, [parent.event.eventId])
      || !sameSequence(observation.event.parentOutputHashes, [parent.event.outputHash])) {
      throw new TypeError(`terminal-phase Six-Step Stage ${index + 3} parent DAG mismatch`);
    }
  }
  const tailContext = (event: EvidenceEventV1) => Object.freeze({
    runtime: Object.freeze({
      commitSha: event.runtime.commitSha,
      executableHash: event.runtime.executableHash,
      deploymentManifestHash: event.runtime.deploymentManifestHash,
      serviceIdentityHash: event.runtime.serviceIdentityHash,
      pid: event.runtime.pid,
      processStartTicks: event.runtime.processStartTicks,
      bootIdHash: event.runtime.bootIdHash,
    }),
    source: Object.freeze({
      systemId: event.source.systemId,
      emitterKind: event.source.emitterKind,
      emitterCodeHash: event.source.emitterCodeHash,
    }),
    scope: event.scope,
    correlationId: event.correlationId,
    cutoff: event.cutoff,
    definitionCatalogRoot: event.definitionCatalogRoot,
    strategyCatalogRoot: event.strategyCatalogRoot,
    instanceCatalogRoot: event.instanceCatalogRoot,
    graphRoot: event.graphRoot,
    familyId: event.familyId,
    candidateKey: event.candidateKey,
    familyDefinitionHash: event.familyDefinitionHash,
    capabilities: event.capabilities,
    capabilitySetHash: event.capabilitySetHash,
    instanceKey: event.instanceKey,
  });
  if (tail.slice(1).some(observation => !sameCanonical(tailContext(observation.event), tailContext(stage3.event)))
    || stage3.event.scope.kind !== "producer-session"
    || stage3.event.scope.generationId !== stage12.binding.generationId
    || stage3.event.correlationId !== terminal.correlationId
    || stage3.event.candidateKey !== terminal.value.routeCandidateId
    || stage3.event.definitionCatalogRoot !== stage12.binding.definitionCatalogRoot
    || stage3.event.instanceCatalogRoot !== stage12.binding.instanceCatalogRoot
    || stage3.event.graphRoot !== stage12.binding.graphRoot
    || stage3.event.cutoff.number !== stage12.binding.cutoff.number
    || stage3.event.cutoff.hash !== stage12.binding.cutoff.hash
    || stage3.event.cutoff.stateRoot !== stage12.binding.cutoff.stateRoot
    || stage3.event.instanceKey !== selectedGraphLegs[0]!.owningInstanceKey) {
    throw new TypeError("terminal-phase Six-Step Stage 3-6 producer-session splice");
  }
  const stage4Facts = tail[1]?.facts;
  const stage6Facts = tail[3]?.facts;
  if (stage4Facts?.stageId !== "current_source_exact"
    || stage6Facts?.stageId !== "final_simulation"
    || !sameCanonical(stage4Facts.currentSource, terminal.currentSource)
    || !sameCanonical(stage6Facts.simulationSourceAnchor, terminal.currentSource)
    || !sameSequence(tail.map(value => value.artifactSetRoot), resolved.productionArtifactSetRoots)) {
    throw new TypeError("terminal-phase Six-Step Stage 3-6 terminal trace/root splice");
  }
  assertExactStage36TerminalTraceJoin(tail, terminal, resolved);
  assertProductionSixStepLineageRootV1(
    identity.sixStepLineageRoot,
    identity.stage12Root,
    terminal.traceRoot,
  );
  if (predicateArtifacts.length > 18 * legCount + 31 || reachableRefs.size !== predicateArtifacts.length) {
    throw new TypeError("terminal-phase Six-Step pointer closure is unreachable or exceeds its route bound");
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

function assertTerminalRuntimeJoin(
  fullFamilyTerminalBytes: Uint8Array,
  sixStepTerminalBytes: Uint8Array | null,
): void {
  if (sixStepTerminalBytes === null) return;
  const fullFamily = fullFamilyTerminalIdentity(fullFamilyTerminalBytes);
  const sixStep = terminalBindingIdentity(sixStepTerminalBytes);
  if (fullFamily.runtimeBindingId !== sixStep.runtimeBindingId
    || fullFamily.releaseProvenanceHash !== sixStep.releaseProvenanceHash
    || fullFamily.candidateReleaseCommit !== sixStep.candidateReleaseCommit
    || fullFamily.generationId !== sixStep.generationId
    || fullFamily.readyRecordHash !== sixStep.readyRecordHash
    || fullFamily.graphRoot !== sixStep.graphRoot) {
    throw new TypeError("terminal-phase Full-Family/Six-Step terminal runtime splice");
  }
  // Full-Family is sealed from the ordinal-100 acceptance terminal while
  // Six-Step is selected from the candidate-bearing head inside that same
  // 100-head window. Their sources are independently exact-bound above, but
  // need not be the same canonical head.
}

function exactSixStepArtifactMaterials(
  eventFacts: readonly SixStepEventFactV1[],
  indexedArtifacts: readonly NonNullable<ProductionTerminalPhaseLocatorIndexRecordV1["selectedProcessArtifact"]>[],
  indexedBytes: readonly Uint8Array[],
  candidates: readonly ProductionSixStepArtifactMaterialV1[],
  snapshotTrust: ProductionTerminalPhaseSnapshotTrustStateV1 | null = null,
): readonly ProductionSixStepArtifactMaterialV1[] {
  assertExactBoundedArray(
    candidates,
    "terminalPhaseLocatorIndex.sixStepArtifactMaterials",
    PRODUCTION_TERMINAL_PHASE_SIX_STEP_POINTER_MAX_COUNT,
  );
  const decodedCandidates = Object.freeze(candidates.map((candidate, index) =>
    decodeProductionSixStepArtifactMaterialV1(candidate)));
  const indexed = new Map(indexedArtifacts.map((artifact, index) => [
    artifact.ref.artifactRefId,
    Object.freeze({ artifact, bytes: indexedBytes[index]! }),
  ] as const));
  const byEvent = new Map<Hash, ProductionSixStepArtifactMaterialV1>();
  for (const candidate of decodedCandidates) {
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
    const eventLocator = material.eventArtifact.ref.locator;
    if (eventLocator.kind !== "file-range"
      || material.append.eventId !== material.event.eventId
      || material.append.contentSha256 !== material.eventArtifact.ref.contentSha256
      || material.append.byteLength !== material.eventArtifact.ref.byteLength
      || material.append.byteLength !== material.eventArtifact.bytes.byteLength.toString()
      || material.append.offsetStart !== eventLocator.startInclusive
      || material.append.offsetEnd !== eventLocator.endExclusive
      || material.append.fsynced !== true) {
      throw new TypeError(`terminal-phase Six-Step boundary material[${index}] append/file-range splice`);
    }
    assertDecimalString(material.append.sequence, `sixStepBoundaryMaterial[${index}].append.sequence`);
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
  const ledgerOrdered = [...selected].sort((left, right) => {
    const leftLocator = left.eventArtifact.ref.locator;
    const rightLocator = right.eventArtifact.ref.locator;
    if (leftLocator.kind !== "file-range" || rightLocator.kind !== "file-range") return 0;
    const leftStart = BigInt(leftLocator.startInclusive);
    const rightStart = BigInt(rightLocator.startInclusive);
    return leftStart < rightStart ? -1 : leftStart > rightStart ? 1 : 0;
  });
  if (ledgerOrdered.some((material, index) => index > 0 && (
    BigInt(material.append.sequence) <= BigInt(ledgerOrdered[index - 1]!.append.sequence)
    || BigInt(material.append.offsetStart) < BigInt(ledgerOrdered[index - 1]!.append.offsetEnd)
  ))) {
    throw new TypeError("terminal-phase Six-Step boundary material append sequence contradicts frozen ledger order");
  }
  if (snapshotTrust !== null) assertProductionSixStepSnapshotAppendSequencesV1(
    snapshotTrust.sixStepSourceLedger,
    selected,
  );
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
    "fullFamilyBundleArtifact", "fullFamilyLocatorArtifact", "sixStepTerminalBindingArtifact",
    "sixStepPredicateArtifacts", "sixStepPredicateArtifactPointerRoot", "sixStepBoundaryKeys",
    "sixStepBoundaryKeyRoot", "selectedProcessArtifact", "indexRoot",
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
      assertExactBoundedArray(
        index.sixStepPredicateArtifacts,
        "terminalPhaseLocatorIndex.sixStepPredicateArtifacts",
        PRODUCTION_TERMINAL_PHASE_SIX_STEP_POINTER_MAX_COUNT,
      );
      let previous: Hash | null = null;
      return Object.freeze(index.sixStepPredicateArtifacts.map((value, position) => {
        const pointer = decodeSixStepArtifactPointer(value, `terminalPhaseLocatorIndex.sixStepPredicateArtifacts[${position}]`);
        if (previous !== null && previous >= pointer.ref.artifactRefId) {
          throw new TypeError("terminalPhaseLocatorIndex Six-Step predicate artifacts are not exact-sorted");
        }
        previous = pointer.ref.artifactRefId;
        return pointer;
      }));
    })(),
    sixStepPredicateArtifactPointerRoot: assertHash(
      index.sixStepPredicateArtifactPointerRoot,
      "terminalPhaseLocatorIndex.sixStepPredicateArtifactPointerRoot",
    ),
    sixStepBoundaryKeys: exactSixStepBoundaryKeys(
      index.sixStepBoundaryKeys,
      "terminalPhaseLocatorIndex.sixStepBoundaryKeys",
    ),
    sixStepBoundaryKeyRoot: assertHash(
      index.sixStepBoundaryKeyRoot,
      "terminalPhaseLocatorIndex.sixStepBoundaryKeyRoot",
    ),
    selectedProcessArtifact: decodeIndexedProcessArtifact(index.selectedProcessArtifact),
  });
  assertSixStepArtifactPointerBytes(payload.sixStepPredicateArtifacts);
  if (payload.locatorArtifact.contentSha256 !== payload.locatorContentSha256
    || payload.locatorArtifact.ref.artifactRefId !== payload.locatorArtifactRefId
    || payload.manifestArtifact.contentSha256 !== payload.manifestContentSha256) {
    throw new TypeError("terminalPhaseLocatorIndex locator/manifest artifact identity mismatch");
  }
  if (payload.sixStepPredicateArtifactPointerRoot !== sixStepArtifactPointerRoot(payload.sixStepPredicateArtifacts)) {
    throw new TypeError("terminalPhaseLocatorIndex Six-Step pointer root mismatch");
  }
  if (payload.sixStepBoundaryKeyRoot !== sixStepBoundaryKeyRoot(payload.sixStepBoundaryKeys)) {
    throw new TypeError("terminalPhaseLocatorIndex Six-Step boundary key root mismatch");
  }
  const indexRoot = assertHash(index.indexRoot, "terminalPhaseLocatorIndex.indexRoot");
  if (indexRoot !== hashDomain("aloha/production-terminal-phase-locator-index/v1", payload)) {
    throw new TypeError("terminalPhaseLocatorIndex.indexRoot mismatch");
  }
  return Object.freeze({ ...payload, indexRoot });
}

export function decodeProductionTerminalPhaseLocatorIndexV1(
  value: unknown,
): ProductionTerminalPhaseLocatorIndexRecordV1 {
  return decodeIndex(value);
}

async function unlinkIfPresent(path: string): Promise<void> {
  try { await unlink(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

/** @internal Production JSONL verifier shared with its focused contract test. */
export function assertProductionSixStepSnapshotAppendSequencesV1(
  ledger: ProductionTerminalPhaseSnapshotTrustStateV1["sixStepSourceLedger"],
  materials: readonly ProductionSixStepArtifactMaterialV1[],
): void {
  const expectedByteLength = BigInt(assertDecimalString(
    ledger.byteLength,
    "terminalPhaseSixStepSourceLedger.byteLength",
  ));
  if (expectedByteLength > BigInt(SIX_STEP_BOUNDARY_SNAPSHOT_LIMITS_V1.maxLedgerBytes)) {
    throw new TypeError("terminal-phase Six-Step source-ledger snapshot exceeds the byte limit");
  }
  const descriptor = openSync(ledger.snapshotPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.dev.toString() !== ledger.snapshotDevice
      || before.ino.toString() !== ledger.snapshotInode || before.size !== expectedByteLength
      || ledger.fsynced !== true) {
      throw new TypeError("terminal-phase Six-Step source-ledger snapshot identity changed");
    }
    const bytes = Buffer.alloc(Number(expectedByteLength));
    let readOffset = 0;
    while (readOffset < bytes.byteLength) {
      const read = readSync(descriptor, bytes, readOffset, bytes.byteLength - readOffset, readOffset);
      if (read === 0) throw new TypeError("terminal-phase Six-Step source-ledger snapshot was truncated");
      readOffset += read;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || sha256Hex(bytes) !== ledger.contentSha256) {
      throw new TypeError("terminal-phase Six-Step source-ledger snapshot content changed");
    }
    if (bytes.byteLength > 0 && bytes[bytes.byteLength - 1] !== 0x0a) {
      throw new TypeError("terminal-phase Six-Step source-ledger snapshot has an incomplete record");
    }
    const evidenceByRange = new Map<string, Readonly<{ readonly sequence: bigint; readonly bytes: Uint8Array }>>();
    let lineStart = 0;
    let evidenceSequence = 0n;
    for (let cursor = 0; cursor < bytes.byteLength; cursor += 1) {
      if (bytes[cursor] !== 0x0a) continue;
      const line = new Uint8Array(bytes.subarray(lineStart, cursor));
      const value = decodeCanonicalBytes(line);
      if (value !== null && typeof value === "object" && !Array.isArray(value)
        && (value as Record<string, unknown>).kind === "aloha.fact-evidence-event") {
        decodeEvidenceEvent(value);
        evidenceByRange.set(`${lineStart}:${cursor}`, Object.freeze({ sequence: evidenceSequence, bytes: line }));
        evidenceSequence += 1n;
      }
      lineStart = cursor + 1;
    }
    for (const [index, material] of materials.entries()) {
      const locator = material.eventArtifact.ref.locator;
      if (locator.kind !== "file-range") {
        throw new TypeError(`terminal-phase Six-Step boundary material[${index}] has no ledger range`);
      }
      const observed = evidenceByRange.get(
        `${locator.startInclusive}:${locator.endExclusive}`,
      );
      if (observed === undefined) {
        throw new TypeError(`terminal-phase Six-Step boundary material[${index}] range is not an evidence-event line`);
      }
      if (BigInt(material.append.sequence) !== observed.sequence) {
        throw new TypeError(`terminal-phase Six-Step boundary material[${index}] append sequence is not ledger-derived`);
      }
      if (!sameBytes(observed.bytes, material.eventArtifact.bytes)) {
        throw new TypeError(`terminal-phase Six-Step boundary material[${index}] event bytes do not match its ledger line`);
      }
    }
  } finally {
    closeSync(descriptor);
  }
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

/** @internal Physical selected-closure verifier shared with focused mutation tests. */
export function readProductionSixStepSnapshotBoundaryMaterialsV1(
  trust: ProductionTerminalPhaseSnapshotTrustStateV1,
  expectedKeys: readonly Hash[],
): readonly ProductionSixStepArtifactMaterialV1[] {
  const exactExpectedKeys = exactSixStepBoundaryKeys(
    expectedKeys,
    "terminalPhaseLocatorIndex.sixStepBoundaryKeys",
  );
  if (exactExpectedKeys.length === 0) return Object.freeze([]);
  const expectedNames = exactExpectedKeys.map(key => `${key.slice(2)}.v8`);
  const names = readdirSync(trust.sixStepBoundaryDirectory).sort();
  if (names.length !== trust.sixStepBoundaryFiles.length
    || names.length !== expectedNames.length
    || names.length > SIX_STEP_BOUNDARY_SNAPSHOT_LIMITS_V1.maxEntries
    || names.some((name, index) => name !== trust.sixStepBoundaryFiles[index]?.name
      || name !== expectedNames[index])) {
    throw new TypeError("terminal-phase Six-Step boundary snapshot denominator changed");
  }
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
  let totalBytes = 0n;
  const opened: Array<Readonly<{
    descriptor: number;
    before: BigIntStats;
    entry: ProductionTerminalPhaseSnapshotTrustStateV1["sixStepBoundaryFiles"][number];
  }>> = [];
  try {
    // Preflight the complete selected closure before allocating or reading any
    // V8 material. The same O_NOFOLLOW descriptors remain authoritative for
    // the subsequent reads and post-read identity fence.
    for (const [index, entry] of trust.sixStepBoundaryFiles.entries()) {
      const path = join(trust.sixStepBoundaryDirectory, entry.name);
      const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = fstatSync(descriptor, { bigint: true });
        const expectedByteLength = BigInt(assertDecimalString(
          entry.byteLength,
          `terminalPhaseSixStepBoundarySnapshot[${index}].byteLength`,
        ));
        totalBytes += expectedByteLength;
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
          || before.size !== expectedByteLength
          || expectedByteLength > BigInt(SIX_STEP_BOUNDARY_SNAPSHOT_LIMITS_V1.maxEntryBytes)
          || totalBytes > BigInt(SIX_STEP_BOUNDARY_SNAPSHOT_LIMITS_V1.maxTotalBytes)
          || before.dev.toString() !== entry.device || before.ino.toString() !== entry.inode
          || entry.fsynced !== true) {
          throw new TypeError(`terminal-phase Six-Step boundary snapshot entry[${index}] size is invalid`);
        }
        opened.push(Object.freeze({ descriptor, before, entry }));
      } catch (error) {
        closeSync(descriptor);
        throw error;
      }
    }
    const materials = opened.map(({ descriptor, before, entry }, index) => {
      const bytes = Buffer.alloc(Number(before.size));
      let offset = 0;
      while (offset < bytes.byteLength) {
        const count = readSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
        if (count === 0) throw new TypeError(`terminal-phase Six-Step boundary snapshot entry[${index}] was truncated`);
        offset += count;
      }
      const after = fstatSync(descriptor, { bigint: true });
      if (before.dev !== after.dev || before.ino !== after.ino
        || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
        || after.dev.toString() !== entry.device || after.ino.toString() !== entry.inode
        || bytes.byteLength.toString() !== entry.byteLength || sha256Hex(bytes) !== entry.contentSha256
        || entry.fsynced !== true) {
        throw new TypeError(`terminal-phase Six-Step boundary snapshot entry[${index}] changed`);
      }
      const material = decodeProductionSixStepArtifactMaterialV1(deserialize(bytes));
      if (material.boundaryKey !== exactExpectedKeys[index]
        || `${material.boundaryKey.slice(2)}.v8` !== entry.name) {
        throw new TypeError("terminal-phase Six-Step boundary snapshot key/name mismatch");
      }
      return material;
    });
    return Object.freeze(materials);
  } finally {
    for (const { descriptor } of opened) closeSync(descriptor);
  }
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
    assertExactBoundedArray(
      input.sixStepPredicateArtifacts,
      "terminalPhaseLocatorIndex.sixStepPredicateArtifacts",
      PRODUCTION_TERMINAL_PHASE_SIX_STEP_POINTER_MAX_COUNT,
    );
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
    assertTerminalRuntimeJoin(fullFamilyTerminalBindingBytes, sixStepTerminalBindingBytes);
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
      null,
    );
    const selectedSixStepArtifactMaterials = exactSixStepArtifactMaterials(
      sixStepEventFacts,
      sixStepPredicateArtifacts,
      sixStepPredicateArtifactBytes,
      input.sixStepArtifactMaterials,
    );
    const sixStepBoundaryKeys = selectedSixStepBoundaryKeys(selectedSixStepArtifactMaterials);
    if ((manifest.sixStep.status === "observed") !== (sixStepBoundaryKeys.length > 0)) {
      throw new TypeError("terminal-phase Six-Step selected boundary key denominator/status mismatch");
    }
    const sixStepPredicateArtifactPointers = Object.freeze(sixStepPredicateArtifacts.map(sixStepArtifactPointer));
    assertSixStepArtifactPointerBytes(sixStepPredicateArtifactPointers);
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
      fullFamilyBundleArtifact,
      fullFamilyLocatorArtifact,
      sixStepTerminalBindingArtifact,
      sixStepPredicateArtifacts: sixStepPredicateArtifactPointers,
      sixStepPredicateArtifactPointerRoot: sixStepArtifactPointerRoot(sixStepPredicateArtifactPointers),
      sixStepBoundaryKeys,
      sixStepBoundaryKeyRoot: sixStepBoundaryKeyRoot(sixStepBoundaryKeys),
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
      const persistedHandle = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
      const persisted = await (async () => {
        try {
          const before = await persistedHandle.stat({ bigint: true });
          if (!before.isFile() || before.size !== BigInt(bytes.byteLength)
            || before.size > BigInt(CANONICAL_LIMITS.maxBytes)) {
            throw new TypeError("terminal-phase persisted locator index size mismatch");
          }
          const value = new Uint8Array(await persistedHandle.readFile());
          const after = await persistedHandle.stat({ bigint: true });
          if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
            || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
            throw new TypeError("terminal-phase persisted locator index changed while being read");
          }
          return value;
        } finally {
          await persistedHandle.close();
        }
      })();
      if (!sameBytes(persisted, bytes)) throw new TypeError("terminal-phase locator index conflicts with its immutable window key");
      const decoded = decodeIndex(decodeCanonicalBytes(persisted));
      this.#published.set(decoded.finalDurableWindowId, Object.freeze({
        indexRoot: decoded.indexRoot,
        indexContentSha256: sha256Hex(persisted),
        indexByteLength: String(persisted.byteLength),
        generatedRuntimeMetadata: input.generatedRuntimeMetadata,
        sixStepArtifactMaterials: selectedSixStepArtifactMaterials,
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
        const trustedByteLength = BigInt(assertDecimalString(
          expected.indexByteLength,
          "terminalPhaseLocatorIndex.expectedByteLength",
        ));
        if (!before.isFile() || before.isSymbolicLink()
          || before.size !== trustedByteLength
          || trustedByteLength > BigInt(CANONICAL_LIMITS.maxBytes)) {
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
    if ((manifest.sixStep.status === "observed") !== (index.sixStepBoundaryKeys.length > 0)) {
      throw new TypeError("terminal-phase Six-Step selected boundary key denominator/status mismatch");
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
    const fullFamilyBundleBytes = await readOptional(
      index.fullFamilyBundleArtifact,
      "terminal-phase Full-Family bundle restart artifact",
    );
    const fullFamilyPredicateArtifacts = fullFamilyBundleBytes === null
      ? Object.freeze([])
      : await readStoredFullFamilyPredicateArtifactsV1(this.#sink, fullFamilyBundleBytes);
    const fullFamilyPredicateArtifactBytes = Object.freeze(fullFamilyPredicateArtifacts.map(artifact => artifact.bytes));
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
    assertTerminalRuntimeJoin(fullFamilyTerminalBindingBytes, sixStepTerminalBindingBytes);
    let sixStepPredicateArtifacts: readonly NonNullable<ProductionTerminalPhaseLocatorIndexRecordV1["selectedProcessArtifact"]>[] = Object.freeze([]);
    let sixStepPredicateArtifactBytes: readonly Uint8Array[] = Object.freeze([]);
    let sixStepPhysicalReason: string | null = null;
    try {
      const reconstructed: NonNullable<ProductionTerminalPhaseLocatorIndexRecordV1["selectedProcessArtifact"]>[] = [];
      const reconstructedBytes: Uint8Array[] = [];
      for (const [position, pointer] of index.sixStepPredicateArtifacts.entries()) {
        const artifact = await reconstructIndexedSixStepArtifact(
          this.#sink,
          pointer,
          `terminal-phase Six-Step predicate restart pointer[${position}]`,
        );
        reconstructed.push(artifact);
        reconstructedBytes.push(await exactIndexedSixStepArtifactBytes(
          this.#sink,
          artifact,
          null,
          `terminal-phase Six-Step predicate restart artifact[${position}]`,
          snapshotTrust,
        ));
      }
      sixStepPredicateArtifacts = Object.freeze(reconstructed);
      sixStepPredicateArtifactBytes = Object.freeze(reconstructedBytes);
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
      fullFamilyPredicateArtifacts,
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
          sixStepPredicateArtifacts,
          sixStepPredicateArtifactBytes,
          snapshotTrust === null ? null : Object.freeze({
            activeGraph: snapshotTrust.activeReadyGraph,
            definitionCatalogRoot: snapshotTrust.generatedRuntimeMetadata.definitionCatalogRoot,
          }),
        );
        const physicalMaterials = expected.sixStepArtifactMaterials
          ?? (snapshotTrust === null || index.sixStepBoundaryKeys.length === 0
            ? Object.freeze([])
            : readProductionSixStepSnapshotBoundaryMaterialsV1(snapshotTrust, index.sixStepBoundaryKeys));
        sixStepArtifactMaterials = exactSixStepArtifactMaterials(
          sixStepEventFacts,
          sixStepPredicateArtifacts,
          sixStepPredicateArtifactBytes,
          physicalMaterials,
          snapshotTrust,
        );
        assertSelectedSixStepBoundaryClosure(index.sixStepBoundaryKeys, sixStepArtifactMaterials);
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
    const observedSixStepPredicateArtifacts = sixStepPhysicalReason === null ? Object.freeze(sixStepPredicateArtifacts.map((artifact, position) => Object.freeze({
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
      sixStepPredicateArtifacts: observedSixStepPredicateArtifacts,
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
