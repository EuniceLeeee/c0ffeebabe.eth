import {
  assertDecimalString,
  assertExactKeys,
  assertHash,
  assertNonEmptyString,
  decodeCanonicalBytes,
  decodeCanonicalJson,
  encodeCanonicalBytes,
  encodeCanonicalJson,
  hashDomain,
  sha256Hex,
  type CanonicalJson,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  sourcePlanIdentity,
} from "../../../packages/discovery/src/index.ts";
import { decodeCoarseEdgeSweepBindingV1 } from "../../../packages/coarse-economics/src/index.ts";
import {
  readCheckpointReadyFullFamilyEvidence,
  type ReadyFullFamilyEvidenceReaderPortV1,
  type ReadyFullFamilyEvidenceSnapshotV1,
  type ReadyStage12EvidenceCapabilityV1,
} from "../../../packages/checkpoint/src/ready-full-family-evidence-consumer.ts";
import {
  nativeFullFamilyAuditSequenceRootV1,
  nativeFullFamilyCoarseRouteFactRootV1,
  type NativeFullFamilyAuditChunkV1,
  type NativeFullFamilyAuditManifestV1,
  type NativeFullFamilyAuditV1,
} from "../../../packages/search-pipeline/src/index.ts";
import {
  familySearchArtifactHash,
  familySearchPayloadHash,
  familySearchSource,
  type FamilySearchCoarseArtifactV1,
} from "../../../packages/family-sdk/search-runtime/index.ts";
import {
  readRuntimeReleaseFullFamilyTerminalBindingV1,
  readRuntimeReleaseNativeFullFamilyAuditChunkV1,
  readRuntimeReleaseNativeFullFamilyAuditV1,
  type RuntimeReleaseFullFamilyTerminalBindingCapabilityV1,
  type RuntimeReleaseFullFamilyTerminalBindingV1,
} from "../../../packages/runtime-release-authority/src/full-family-terminal-consumer.ts";
import {
  readRuntimeReleaseFullGraphCoarseSweepEntryChunkV1,
  readRuntimeReleaseFullGraphCoarseSweepManifestV1,
  type FullGraphCoarseSweepCapabilityV1,
} from "../../../packages/runtime-release-authority/src/full-graph-coarse-sweep-consumer.ts";
import {
  decodeFullGraphCoarseSweepV1,
  encodeFullGraphCoarseSweepV1,
  fullGraphTransitionSequenceRootV1,
  type FullGraphCoarseSweepV1,
} from "../../../packages/full-graph-coarse-sweep/src/index.ts";
import {
  encodeCandidatePartitionProofV1,
} from "../../../specs/candidate-partition-authority/src/index.ts";
import {
  validateCandidateFinalOutcomeV1,
  type CandidateFinalOutcomeWireV1,
} from "../../../specs/candidate-final-outcome/src/index.ts";
import { encodeNominationClosureV1 } from "../../../specs/nomination-authority/src/index.ts";
import type { SchemaRef } from "../../../specs/core-envelope/src/index.ts";
import {
  decodeFullFamilyCandidateProofVerifierBinding,
  decodeFullFamilyEvidenceArtifact,
  decodeFullFamilyOutcomeArtifact,
  decodeFullFamilyInstancePublication,
  decodeFullFamilyStageCapabilityRef,
  decodeFullFamilyActionOwnerArtifact,
  decodeFullFamilyPersistedGraphEdge,
  createFullFamilyFactLocator,
  deriveFullFamilyOutcomeSummary,
  encodeFullFamilyActionOwnerArtifact,
  encodeFullFamilyCandidateProofVerifierBinding,
  encodeFullFamilyEvidenceArtifact,
  encodeFullFamilyFactLocator,
  encodeFullFamilyFactBundleStorageV1,
  encodeFullFamilyArtifactRefIndexV1,
  encodeFullFamilyArtifactRefPageV1,
  encodeFullFamilyOutcomeArtifact,
  encodeFullFamilyReadyRecord,
  encodeFullFamilyReleaseProjectionArtifact,
  encodeFullFamilySourceCoverageArtifact,
  FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS,
  hashFamilyReleaseEntry,
  hashFamilyReleaseSet,
  hashFullFamilyActualCurrentSource,
  hashFullFamilyReadyCutoff,
  sealFullFamilyArtifactRefIndexV1,
  sealFullFamilyArtifactRefPageV1,
  sealFullFamilyFactBundleStorageV1,
  sealFamilyEvidencePartition,
  sealFamilyOutcomePartition,
  sealFullFamilyFacts,
  sealFullFamilyMatrixEntry,
  FULL_FAMILY_FACT_LOCATOR_SCHEMA_REF,
  FULL_FAMILY_FACT_STORAGE_SCHEMA_REF,
  type FamilyEvidenceItemV1,
  type FamilyOutcomeItemV1,
  type FullFamilyStoredItemDecoderV1,
  type FullFamilyFactBundleV1,
  type FullFamilyFactLocatorV1,
  type FullFamilyPartitionRoleV1,
  type FullFamilyStoredPartitionBindingInputV1,
  type FullFamilyCandidateProofVerifierBindingV1,
  type FullFamilyActionOwnerArtifactV1,
  type FullFamilyEvidenceArtifactV1,
  type FullFamilyOutcomeArtifactV1,
  type FullFamilyReadyRecordV1,
  type FullFamilyReleaseProjectionArtifactV1,
  type FullFamilySourceCoverageArtifactV1,
  type FullFamilySourcePlanExecutionBindingV1,
} from "../../../specs/full-family-facts/src/index.ts";
import {
  ContentAddressedObserverSinkV1,
  type ObservedContentArtifactV1,
} from "./content-addressed-sink.ts";
import {
  observeFullFamilyReleaseArtifacts,
  type FullFamilyReleaseArtifactObservationV1,
} from "./full-family-release-artifacts.ts";
import { observeGeneratedJsonConstant } from "./generated-json-constant.ts";
import { derivePlannerCompatibleReadyGraphTransitionsV1 } from "./internal/terminal-phase-snapshot-trust-state.ts";

type MissingCodeV1 =
  | "coarse-family-artifact-unavailable"
  | "graph-transition-audit-denominator-incomplete";

export interface FullFamilyObserverMissingV1 {
  readonly code: MissingCodeV1;
  readonly subjectRoot: Hash;
}

export interface FullFamilyObservedArtifactV1 {
  readonly role: string;
  readonly artifact: ObservedContentArtifactV1;
}

export interface FullFamilyObservedFamilyMaterialV1 {
  readonly familyId: string;
  readonly familyDefinitionHash: Hash;
  readonly sourcePlanRoot: Hash;
  readonly sourcePlans: readonly FamilyEvidenceItemV1[];
  readonly universeCandidates: readonly FamilyEvidenceItemV1[];
  readonly outcomes: readonly FamilyOutcomeItemV1[];
  readonly instancePublications: readonly FamilyEvidenceItemV1[];
  readonly projectedEdges: readonly FamilyEvidenceItemV1[];
  readonly declaredCoarseCapabilities: readonly FamilyEvidenceItemV1[];
  readonly coarseRankable: readonly FamilyEvidenceItemV1[];
  readonly coarseUnavailable: readonly FamilyEvidenceItemV1[];
  readonly unrankedAdmissions: readonly FamilyEvidenceItemV1[];
  readonly declaredExactCapabilities: readonly FamilyEvidenceItemV1[];
  readonly ownedActions: readonly FamilyEvidenceItemV1[];
}

/** Raw production observation only. Missing owner facts remain explicit and
 * no field in this result is a producer-supplied pass/fail verdict. */
export interface ProductionFullFamilyObserverResultV1 {
  readonly kind: "aloha.production-full-family-observation-v1" | "aloha.production-full-family-observation-missing-v1";
  readonly release: FullFamilyReleaseArtifactObservationV1;
  readonly candidateReleaseCommit: string;
  readonly finalDurableWindowId: Hash;
  readonly producerTerminalBindingRoot: Hash;
  readonly laneTerminalSetRoot: Hash;
  readonly readyRecordHash: Hash;
  readonly auditRoot: Hash;
  readonly fullGraphCoarseSweepRoot: Hash;
  readonly actualCurrentSource: RuntimeReleaseFullFamilyTerminalBindingV1["actualCurrentSource"];
  readonly actualCurrentSourceRoot: Hash;
  readonly missing: readonly FullFamilyObserverMissingV1[];
  readonly families: readonly FullFamilyObservedFamilyMaterialV1[];
  readonly observedArtifacts: readonly FullFamilyObservedArtifactV1[];
  readonly bundle: FullFamilyFactBundleV1 | null;
  readonly bundleArtifact: ObservedContentArtifactV1 | null;
  readonly locator: FullFamilyFactLocatorV1 | null;
  readonly locatorArtifact: ObservedContentArtifactV1 | null;
}

export interface ProductionFullFamilyObserverInputV1 {
  readonly checkpointReader: ReadyFullFamilyEvidenceReaderPortV1;
  readonly stage12Capability: ReadyStage12EvidenceCapabilityV1;
  /** Opaque runtime-release binding over the complete terminal and audit. */
  readonly runtimeReleaseTerminalBindingCapability: RuntimeReleaseFullFamilyTerminalBindingCapabilityV1;
  /** Opaque release-owned sweep over every directed edge in the Ready Graph. */
  readonly fullGraphCoarseSweepCapability: FullGraphCoarseSweepCapabilityV1;
  readonly releaseIntentCanonicalBytes: Uint8Array;
  readonly familyCatalogSourceBytes: Uint8Array;
  readonly runtimeCompositionSourceBytes: Uint8Array;
  readonly strategyCatalogSourceBytes: Uint8Array;
  readonly candidateProofVerifierBindingBytes: Uint8Array;
  readonly sink: ContentAddressedObserverSinkV1;
}

export function readProductionRuntimeReleaseFullFamilyTerminalBinding(
  value: RuntimeReleaseFullFamilyTerminalBindingCapabilityV1,
): RuntimeReleaseFullFamilyTerminalBindingV1 {
  return readRuntimeReleaseFullFamilyTerminalBindingV1(value);
}

interface GeneratedCapabilityRefWireV1 {
  readonly familyId: string;
  readonly familyDefinitionHash: Hash;
  readonly stage: "capability";
  readonly capabilityId: string;
  readonly version: string;
  readonly schemaHash: Hash;
  readonly interpreterHash: Hash;
  readonly ownerRef: Hash;
}

interface GeneratedFamilyCatalogWireV1 {
  readonly entries: readonly Readonly<{
    readonly familyId: string;
    readonly familyDefinitionHash: Hash;
    readonly extensionRefs: readonly GeneratedCapabilityRefWireV1[];
  }>[];
}

function localSchema(id: string, descriptor: unknown): SchemaRef {
  const version = "1.0.0";
  return Object.freeze({
    id,
    version,
    schemaHash: hashDomain("aloha/schema-definition/v1", { id, version, descriptor }),
  });
}

const RAW_FAMILY_CATALOG_SOURCE_SCHEMA = localSchema("aloha.observer.raw-family-catalog-source", {
  syntax: "typescript-object-freeze-json-literal",
  constant: "FAMILY_CATALOG",
});
const RAW_RUNTIME_COMPOSITION_SOURCE_SCHEMA = localSchema("aloha.observer.raw-family-runtime-source", {
  syntax: "typescript-object-freeze-json-literal",
  constant: "FAMILY_RUNTIME_DESCRIPTOR",
});
const RAW_STRATEGY_CATALOG_SOURCE_SCHEMA = localSchema("aloha.observer.raw-strategy-catalog-source", {
  syntax: "typescript-object-freeze-json-literal",
  constant: "STRATEGY_CATALOG",
});
const NATIVE_AUDIT_SCHEMA = localSchema("aloha.native-full-family-audit", {
  owner: "search-pipeline",
  exactKind: "aloha.native-full-family-audit-manifest-v1",
});
const NATIVE_AUDIT_CHUNK_SCHEMA = localSchema("aloha.native-full-family-audit-chunk", {
  owner: "search-pipeline",
  exactKind: "aloha.native-full-family-audit-chunk-v1",
  next: "content-addressed",
});
const FULL_GRAPH_COARSE_SWEEP_SCHEMA = localSchema("aloha.full-graph-coarse-sweep", {
  owner: "runtime-release-authority",
  exactKind: "aloha.full-graph-coarse-sweep-manifest-v1",
  exactFields: [
    "schemaVersion", "kind", "binding", "expectedTransitionCount", "expectedTransitionRoot",
    "observedTransitionCount", "observedTransitionRoot", "missingTransitionCount", "missingTransitionRoot",
    "familyTransitionCounts", "entryChunkCount", "entryCount", "firstEntryChunkRef",
    "entryChunkClosureRoot", "sweepRoot",
  ],
});
const FULL_GRAPH_COARSE_SWEEP_CHUNK_SCHEMA = localSchema("aloha.full-graph-coarse-sweep-entry-chunk", {
  owner: "runtime-release-authority",
  exactKind: "aloha.full-graph-coarse-sweep-entry-chunk-v1",
  maxEntries: 128,
  next: "content-addressed",
});
const FULL_FAMILY_TERMINAL_BINDING_SCHEMA = localSchema("aloha.runtime-release-full-family-terminal-binding", {
  owner: "runtime-release-authority",
  exactKind: "aloha.runtime-release-full-family-terminal-binding-v1",
});
const ACTUAL_CURRENT_SOURCE_SCHEMA = localSchema("aloha.full-family.actual-current-source", {
  exactFields: ["chainId", "number", "hash", "stateRoot"],
  rootDomain: "aloha/full-family/actual-current-source/v1",
});

function schema(key: keyof typeof FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS): SchemaRef {
  return FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS[key];
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return encodeCanonicalJson(left) === encodeCanonicalJson(right);
}

function sameOrderedHashes(left: readonly Hash[], right: readonly Hash[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function readFullGraphSweep(capability: FullGraphCoarseSweepCapabilityV1): FullGraphCoarseSweepV1 {
  const manifest = readRuntimeReleaseFullGraphCoarseSweepManifestV1(capability);
  const chunkBytes = new Map<Hash, Uint8Array>();
  for (let ordinal = 0; ordinal < Number(manifest.entryChunkCount); ordinal += 1) {
    const chunk = readRuntimeReleaseFullGraphCoarseSweepEntryChunkV1(capability, String(ordinal));
    const bytes = encodeCanonicalBytes(chunk as unknown as CanonicalJson);
    chunkBytes.set(sha256Hex(bytes), bytes);
  }
  return decodeFullGraphCoarseSweepV1(
    encodeCanonicalBytes(manifest as unknown as CanonicalJson),
    ref => {
      const bytes = chunkBytes.get(ref.contentSha256);
      if (bytes === undefined) throw new TypeError("runtime-release full-Graph sweep chunk is missing");
      return bytes;
    },
  );
}

function sameCutoff(
  left: Readonly<{ chainId: string; number: string; hash: string; stateRoot: string }>,
  right: Readonly<{ chainId: string; number: string; hash: string; stateRoot: string }>,
): boolean {
  return left.chainId === right.chainId
    && left.number === right.number
    && left.hash === right.hash
    && left.stateRoot === right.stateRoot;
}

function concreteBytes(value: unknown, path: string): Uint8Array {
  if (value === null || typeof value !== "object" || !ArrayBuffer.isView(value)
    || Object.getPrototypeOf(value) !== Uint8Array.prototype) {
    throw new TypeError(`${path} must be a concrete Uint8Array`);
  }
  return Uint8Array.from(value as Uint8Array);
}

function instanceIdentityRef(familyDefinitionHash: Hash, instanceKey: string): Hash {
  return hashDomain("aloha/full-family/instance-identity-ref/v1", { familyDefinitionHash, instanceKey });
}

function sourceBindingIdentity(value: Readonly<{ ownerRef: Hash; sourcePlanRef: Hash }>): Hash {
  return hashDomain("aloha/source-plan-identity/v1", {
    ownerRef: value.ownerRef,
    sourcePlanRef: value.sourcePlanRef,
  });
}

function evidenceArtifact(
  readyRecordHash: Hash,
  role: FullFamilyEvidenceArtifactV1["role"],
  familyId: string,
  itemId: Hash,
  subjectKey: Hash,
): FullFamilyEvidenceArtifactV1 {
  return Object.freeze({
    schemaVersion: 1,
    kind: "aloha.full-family-evidence-artifact",
    readyRecordHash,
    role,
    familyId,
    itemId,
    subjectKey,
  });
}

function missing(code: MissingCodeV1, value: unknown): FullFamilyObserverMissingV1 {
  return Object.freeze({ code, subjectRoot: hashDomain(`aloha/full-family-observer/missing/${code}/v1`, value) });
}

function exactFamilyCatalog(value: unknown): GeneratedFamilyCatalogWireV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Family catalog observation is not an object");
  const entries = (value as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) throw new TypeError("Family catalog entries are missing");
  return value as GeneratedFamilyCatalogWireV1;
}

function exactRecord(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  assertExactKeys(value, keys, path);
  return value as Record<string, unknown>;
}

function exactCoarseArtifact(
  value: unknown,
  sweep: FullGraphCoarseSweepV1,
  entry: FullGraphCoarseSweepV1["entries"][number],
  observation: Record<string, unknown>,
): FamilySearchCoarseArtifactV1 {
  const record = exactRecord(value, [
    "kind", "status", "source", "routeBindingHash", "objectiveRef", "amountHash",
    "payload", "payloadHash", "artifactHash", "projectionHash", "stateFactsRoot",
    "input", "output", "conservativeOutputUpperBound", "inputCapacityUpperBound",
    "rankKey", "reasonCode",
  ], "coarseOutcome.artifact");
  if (record.kind !== "coarse" || (record.status !== "rankable" && record.status !== "unavailable")) {
    throw new TypeError("coarse owner artifact kind/status is invalid");
  }
  const source = familySearchSource(record.source, "coarseOutcome.artifact.source");
  const payload = decodeCanonicalJson(encodeCanonicalJson(record.payload));
  const payloadHash = familySearchPayloadHash("coarse", payload);
  const projectionHash = assertHash(record.projectionHash, "coarseOutcome.artifact.projectionHash");
  const conservativeOutputUpperBound = record.conservativeOutputUpperBound === null
    ? null
    : assertDecimalString(record.conservativeOutputUpperBound, "coarseOutcome.artifact.conservativeOutputUpperBound");
  const inputCapacityUpperBound = record.inputCapacityUpperBound === null
    ? null
    : assertDecimalString(record.inputCapacityUpperBound, "coarseOutcome.artifact.inputCapacityUpperBound");
  const rankKey = record.rankKey === null
    ? null
    : assertHash(record.rankKey, "coarseOutcome.artifact.rankKey");
  const reasonCode = record.reasonCode === null
    ? null
    : assertNonEmptyString(record.reasonCode, "coarseOutcome.artifact.reasonCode");
  const artifact = Object.freeze({
    ...record,
    source,
    payload,
    payloadHash,
    projectionHash,
    conservativeOutputUpperBound,
    inputCapacityUpperBound,
    rankKey,
    reasonCode,
  }) as unknown as FamilySearchCoarseArtifactV1;
  if (record.payloadHash !== payloadHash
    || record.artifactHash !== familySearchArtifactHash({
      kind: "coarse",
      source,
      routeBindingHash: record.routeBindingHash as Hash,
      objectiveRef: record.objectiveRef as Hash,
      amountHash: record.amountHash as Hash,
      payloadHash,
    })
    || !sameCutoff(source, sweep.binding.actualCurrentSource)
    || artifact.routeBindingHash !== observation.routeHandleBindingHash
    || artifact.objectiveRef !== sweep.binding.objectiveRef
    || artifact.amountHash !== observation.amountHash
    || artifact.status !== entry.receipt?.projection.status
    || artifact.stateFactsRoot !== entry.receipt.projection.stateFactsRoot
    || !sameCanonical(artifact.input, entry.receipt.projection.sampleInput)
    || !sameCanonical(artifact.output, entry.receipt.projection.estimatedOutput)
    || artifact.reasonCode !== entry.receipt.projection.reasonCode) {
    throw new TypeError("coarse owner artifact/sweep receipt splice");
  }
  if (artifact.status === "rankable") {
    if (artifact.output === null || artifact.rankKey === null || artifact.reasonCode !== null) {
      throw new TypeError("coarse owner rankable artifact is incomplete");
    }
    if (artifact.conservativeOutputUpperBound !== null
      && BigInt(artifact.conservativeOutputUpperBound) < BigInt(artifact.output.amount)) {
      throw new TypeError("coarse owner conservative output is below the observed output");
    }
    if (artifact.inputCapacityUpperBound !== null
      && BigInt(artifact.inputCapacityUpperBound) < BigInt(artifact.input.amount)) {
      throw new TypeError("coarse owner input exceeds its raw capacity");
    }
  } else if (artifact.output !== null
    || artifact.conservativeOutputUpperBound !== null
    || artifact.inputCapacityUpperBound !== null
    || artifact.rankKey !== null
    || artifact.reasonCode === null) {
    throw new TypeError("coarse owner unavailable artifact carries usable output");
  }
  return Object.freeze(artifact);
}

function exactSweepFamilyObservation(
  sweep: FullGraphCoarseSweepV1,
  entry: FullGraphCoarseSweepV1["entries"][number],
): Readonly<{ readonly observationRoot: Hash; readonly coarse: FamilySearchCoarseArtifactV1 | null }> {
  const observation = exactRecord(entry.familyObservation, [
    "schemaVersion", "kind", "familyId", "familyDefinitionHash", "releaseMembershipRoot",
    "binding", "routeHandleBindingHash", "amountHash", "projectionId", "stateOutcome",
    "coarseOutcome", "observationRoot",
  ], "fullGraphSweep.familyObservation");
  const { observationRoot, ...body } = observation;
  if (observation.schemaVersion !== 1
    || observation.kind !== "aloha.family-runtime-coarse-edge-sweep-observation-v1"
    || observationRoot !== hashDomain("aloha/family-runtime-coarse-edge-sweep-observation/v1", body)
    || observation.familyId !== entry.edge.owningFamilyId
    || observation.familyDefinitionHash !== entry.edge.owningFamilyDefinitionHash
    || observation.releaseMembershipRoot !== sweep.binding.releaseMembershipRoot
    || observation.projectionId !== entry.receipt?.projection.projectionId) {
    throw new TypeError("full-Graph sweep Family observation identity mismatch");
  }
  const binding = decodeCoarseEdgeSweepBindingV1(
    observation.binding as never,
    "fullGraphSweep.familyObservation.binding",
  );
  const receipt = entry.receipt;
  if (receipt === null
    || binding.bindingRoot === undefined
    || binding.familyId !== entry.edge.owningFamilyId
    || binding.familyDefinitionHash !== entry.edge.owningFamilyDefinitionHash
    || binding.edgeId !== entry.edge.edgeId
    || binding.inputPortRef !== entry.inputPortRef
    || binding.outputPortRef !== entry.outputPortRef
    || binding.generationId !== sweep.binding.generationId
    || binding.readyRecordHash !== sweep.binding.readyRecordHash
    || binding.graphRoot !== sweep.binding.graphRoot
    || !sameCutoff(binding.readyCutoff as FullGraphCoarseSweepV1["binding"]["readyCutoff"], sweep.binding.readyCutoff)
    || !sameCutoff(binding.source as FullGraphCoarseSweepV1["binding"]["actualCurrentSource"], sweep.binding.actualCurrentSource)
    || binding.objectiveRef !== sweep.binding.objectiveRef
    || binding.releaseProvenanceHash !== sweep.binding.releaseProvenanceHash
    || receipt.releaseMembershipRoot !== sweep.binding.releaseMembershipRoot
    || receipt.releaseProvenanceHash !== sweep.binding.releaseProvenanceHash
    || receipt.projection.edgeId !== entry.edge.edgeId
    || receipt.projection.routeBindingHash !== observation.routeHandleBindingHash
    || receipt.projection.generationId !== sweep.binding.generationId
    || receipt.projection.graphRoot !== sweep.binding.graphRoot
    || !sameCutoff(receipt.projection.source, sweep.binding.actualCurrentSource)
    || receipt.projection.objectiveRef !== sweep.binding.objectiveRef) {
    throw new TypeError("full-Graph sweep Family observation/qualified receipt splice");
  }
  const stateKind = (observation.stateOutcome as { kind?: unknown }).kind;
  const stateOutcome = exactRecord(
    observation.stateOutcome,
    stateKind === "verified"
      ? ["kind", "artifact"]
      : stateKind === "unavailable"
        ? ["kind", "stage", "reasonCode"]
        : ["kind", "stage", "code"],
    "fullGraphSweep.stateOutcome",
  );
  if (stateOutcome.kind !== "verified" && stateOutcome.kind !== "unavailable") {
    throw new TypeError("full-Graph sweep state outcome is invalid");
  }
  if (observation.coarseOutcome === null) {
    if (stateOutcome.kind !== "unavailable" || entry.receipt?.projection.status !== "unavailable") {
      throw new TypeError("full-Graph sweep missing coarse outcome is not state-unavailable");
    }
    return Object.freeze({ observationRoot: observationRoot as Hash, coarse: null });
  }
  const coarseKind = (observation.coarseOutcome as { kind?: unknown }).kind;
  const coarseOutcome = exactRecord(
    observation.coarseOutcome,
    coarseKind === "verified"
      ? ["kind", "artifact"]
      : coarseKind === "unavailable"
        ? ["kind", "stage", "reasonCode"]
        : ["kind", "stage", "code"],
    "fullGraphSweep.coarseOutcome",
  );
  if (coarseOutcome.kind === "unavailable") {
    if (entry.receipt?.projection.status !== "unavailable") throw new TypeError("coarse unavailable/receipt status splice");
    return Object.freeze({ observationRoot: observationRoot as Hash, coarse: null });
  }
  if (coarseOutcome.kind !== "verified") throw new TypeError("full-Graph sweep coarse outcome is invalid");
  return Object.freeze({
    observationRoot: observationRoot as Hash,
    coarse: exactCoarseArtifact(coarseOutcome.artifact, sweep, entry, observation),
  });
}

export function validateNativeFullFamilyAuditWireV1(audit: NativeFullFamilyAuditV1): void {
  assertExactKeys(audit, [
    "schemaVersion", "kind", "binding", "expectedCandidateCount", "expectedLegCount", "observedReceiptCount",
    "missingLegKeys", "expectedProjectedEdgeCount", "observedProjectedEdgeCount", "missingProjectedEdgeIds",
    "expectedActionLineageCount", "observedActionLineageCount", "missingActionCandidateIds", "denominatorRoot",
    "observedReceiptRoot", "missingLegRoot", "projectedEdgeDenominatorRoot", "missingProjectedEdgeRoot",
    "actionDenominatorRoot", "actionObservedRoot", "coarseRoutes", "projectedEdges", "actionLineage", "auditRoot",
  ], "nativeFullFamilyAudit");
  if (audit.schemaVersion !== 1 || audit.kind !== "aloha.native-full-family-audit-v1") {
    throw new TypeError("native full-family audit kind/version mismatch");
  }
  assertExactKeys(audit.binding, [
    "correlationId", "sourceSessionId", "generationId", "readyRecordHash", "readyCutoff", "graphRoot",
    "releaseProvenanceHash", "actualCurrentSource", "planningProblemHash", "plannerEnumerationRoot", "bindingRoot",
  ], "nativeFullFamilyAudit.binding");
  for (const field of [
    "correlationId", "sourceSessionId", "readyRecordHash", "graphRoot", "releaseProvenanceHash",
    "planningProblemHash", "plannerEnumerationRoot", "bindingRoot",
  ] as const) assertHash(audit.binding[field], `nativeFullFamilyAudit.binding.${field}`);
  assertNonEmptyString(audit.binding.generationId, "nativeFullFamilyAudit.binding.generationId");
  familySearchSource(audit.binding.readyCutoff, "nativeFullFamilyAudit.binding.readyCutoff");
  familySearchSource(audit.binding.actualCurrentSource, "nativeFullFamilyAudit.binding.actualCurrentSource");
  const { bindingRoot, ...bindingPayload } = audit.binding;
  if (bindingRoot !== hashDomain("aloha/native-full-family-audit-binding/v1", bindingPayload)) {
    throw new TypeError("native full-family audit binding root mismatch");
  }
  for (const field of [
    "expectedCandidateCount", "expectedLegCount", "observedReceiptCount", "expectedProjectedEdgeCount",
    "observedProjectedEdgeCount", "expectedActionLineageCount", "observedActionLineageCount",
  ] as const) assertDecimalString(audit[field], `nativeFullFamilyAudit.${field}`);
  if (!Array.isArray(audit.missingLegKeys) || !Array.isArray(audit.missingProjectedEdgeIds)
    || !Array.isArray(audit.missingActionCandidateIds) || !Array.isArray(audit.coarseRoutes)
    || !Array.isArray(audit.projectedEdges) || !Array.isArray(audit.actionLineage)) {
    throw new TypeError("native full-family audit denominators must be arrays");
  }
  const denominatorKeys: Hash[] = [];
  const observedRoots: Hash[] = [];
  const derivedMissingLegKeys: Hash[] = [];
  const observedProjectedEdgeIds = new Set<Hash>();
  for (const [routeIndex, route] of audit.coarseRoutes.entries()) {
    assertExactKeys(route, [
      "searchAuditBindingRoot", "candidateId", "routeHash", "routeBindingHash", "assessment", "legs", "routeFactRoot",
    ], `nativeFullFamilyAudit.coarseRoutes[${routeIndex}]`);
    if (route.searchAuditBindingRoot !== bindingRoot || !Array.isArray(route.legs)) {
      throw new TypeError("native full-family coarse route binding/legs mismatch");
    }
    for (const [legIndex, leg] of route.legs.entries()) {
      assertExactKeys(leg, [
        "searchAuditBindingRoot", "candidateId", "routeHash", "routeBindingHash", "legIndex", "edgeId",
        "owningFamilyId", "owningFamilyDefinitionHash", "owningInstanceKey", "instancePublicationHash",
        "projectionHash", "receipt", "familyObservation", "factRoot",
      ], `nativeFullFamilyAudit.coarseRoutes[${routeIndex}].legs[${legIndex}]`);
      const denominatorKey = hashDomain("aloha/native-full-family-audit-leg-key/v1", {
        candidateId: route.candidateId,
        legIndex: String(legIndex),
        edgeId: leg.edgeId,
      });
      denominatorKeys.push(denominatorKey);
      if (leg.searchAuditBindingRoot !== bindingRoot || leg.candidateId !== route.candidateId
        || leg.routeHash !== route.routeHash || leg.routeBindingHash !== route.routeBindingHash
        || leg.legIndex !== String(legIndex)) {
        throw new TypeError("native full-family coarse leg route binding mismatch");
      }
      const { factRoot, ...legPayload } = leg;
      if (factRoot !== hashDomain("aloha/native-full-family-coarse-leg-fact/v1", legPayload as unknown as CanonicalJson)) {
        throw new TypeError("native full-family coarse leg fact root mismatch");
      }
      if (leg.receipt === null) {
        if (leg.familyObservation !== null) throw new TypeError("native full-family missing receipt retained an observation");
        derivedMissingLegKeys.push(denominatorKey);
      } else {
        if (leg.familyObservation === null) throw new TypeError("native full-family observed receipt lacks its observation");
        const receipt = leg.receipt as unknown as Record<string, unknown>;
        observedRoots.push(hashDomain("aloha/native-full-family-audit-observed-receipt/v1", {
          denominatorKey,
          receiptRoot: assertHash(receipt.receiptRoot, "nativeFullFamilyAudit.coarseRoute.leg.receiptRoot"),
          familyObservation: leg.familyObservation,
        }));
        observedProjectedEdgeIds.add(assertHash(leg.edgeId, "nativeFullFamilyAudit.coarseRoute.leg.edgeId"));
      }
    }
    const { routeFactRoot, ...routePayload } = route;
    if (routeFactRoot !== nativeFullFamilyCoarseRouteFactRootV1(
      routePayload as Omit<NativeFullFamilyAuditV1["coarseRoutes"][number], "routeFactRoot">,
    )) {
      throw new TypeError("native full-family coarse route fact root mismatch");
    }
  }
  for (const [index, edge] of audit.projectedEdges.entries()) {
    assertExactKeys(edge, [
      "searchAuditBindingRoot", "edge", "edgeId", "owningFamilyId", "owningFamilyDefinitionHash",
      "owningInstanceKey", "instancePublicationHash", "projectionHash", "factRoot",
    ], `nativeFullFamilyAudit.projectedEdges[${index}]`);
    const persisted = edge.edge as unknown as Record<string, unknown>;
    if (edge.searchAuditBindingRoot !== bindingRoot || persisted.edgeId !== edge.edgeId) {
      throw new TypeError("native full-family projected edge binding mismatch");
    }
    const { factRoot, ...edgePayload } = edge;
    if (factRoot !== hashDomain("aloha/native-full-family-projected-edge-fact/v1", edgePayload as unknown as CanonicalJson)) {
      throw new TypeError("native full-family projected edge fact root mismatch");
    }
  }
  for (const [index, action] of audit.actionLineage.entries()) {
    assertExactKeys(action, [
      "searchAuditBindingRoot", "candidateId", "routeHash", "orderedEdgeIds", "executionProgramOwnerEvidence", "factRoot",
    ], `nativeFullFamilyAudit.actionLineage[${index}]`);
    const { factRoot, ...actionPayload } = action;
    if (action.searchAuditBindingRoot !== bindingRoot
      || factRoot !== hashDomain("aloha/native-full-family-action-lineage-fact/v1", actionPayload as unknown as CanonicalJson)) {
      throw new TypeError("native full-family action lineage root mismatch");
    }
  }
  const missingProjectedEdgeIds = audit.projectedEdges.flatMap(edge => (
    observedProjectedEdgeIds.has(edge.edgeId) ? [] : [edge.edgeId]
  ));
  const actionIds = new Set([...audit.actionLineage.map(value => value.candidateId), ...audit.missingActionCandidateIds]);
  const orderedActionIds = audit.coarseRoutes.flatMap(route => actionIds.has(route.candidateId) ? [route.candidateId] : []);
  if (audit.expectedCandidateCount !== String(audit.coarseRoutes.length)
    || audit.expectedLegCount !== String(denominatorKeys.length)
    || audit.observedReceiptCount !== String(observedRoots.length)
    || !sameOrderedHashes(audit.missingLegKeys, derivedMissingLegKeys)
    || audit.expectedProjectedEdgeCount !== String(audit.projectedEdges.length)
    || audit.observedProjectedEdgeCount !== String(observedProjectedEdgeIds.size)
    || !sameOrderedHashes(audit.missingProjectedEdgeIds, missingProjectedEdgeIds)
    || audit.expectedActionLineageCount !== String(orderedActionIds.length)
    || audit.observedActionLineageCount !== String(audit.actionLineage.length)
    || audit.denominatorRoot !== nativeFullFamilyAuditSequenceRootV1("denominator", denominatorKeys)
    || audit.observedReceiptRoot !== nativeFullFamilyAuditSequenceRootV1("observed-receipts", observedRoots)
    || audit.missingLegRoot !== nativeFullFamilyAuditSequenceRootV1("missing-legs", derivedMissingLegKeys)
    || audit.projectedEdgeDenominatorRoot !== nativeFullFamilyAuditSequenceRootV1("projected-edge-denominator", audit.projectedEdges.map(edge => edge.factRoot))
    || audit.missingProjectedEdgeRoot !== nativeFullFamilyAuditSequenceRootV1("missing-projected-edges", missingProjectedEdgeIds)
    || audit.actionDenominatorRoot !== nativeFullFamilyAuditSequenceRootV1("action-denominator", orderedActionIds)
    || audit.actionObservedRoot !== nativeFullFamilyAuditSequenceRootV1("action-observed", audit.actionLineage.map(action => action.factRoot))) {
    throw new TypeError("native full-family audit semantic denominator/root mismatch");
  }
}

function assertNativeProjectedEdgeDenominatorV1(
  audit: NativeFullFamilyAuditV1,
  graphEdgeCount: string,
  orderedGraphEdgeIds: readonly Hash[],
): void {
  if (audit.expectedProjectedEdgeCount !== graphEdgeCount
    || audit.projectedEdges.length !== orderedGraphEdgeIds.length
    || audit.projectedEdges.some((edge, index) => edge.edgeId !== orderedGraphEdgeIds[index])) {
    throw new TypeError("native full-family projected-edge/active Ready Graph denominator mismatch");
  }
}

export function validateMaterializedFullGraphSweepV1(sweep: FullGraphCoarseSweepV1): void {
  assertExactKeys(sweep, [
    "schemaVersion", "kind", "binding", "expectedTransitionCount", "expectedTransitionIds",
    "expectedTransitionRoot", "observedTransitionCount", "observedTransitionIds", "observedTransitionRoot",
    "missingTransitionCount", "missingTransitionIds", "missingTransitionRoot", "familyTransitionCounts",
    "entries", "sweepRoot",
  ], "fullGraphSweep");
  assertExactKeys(sweep.binding, [
    "runtimeBindingId", "releaseProvenanceHash", "candidateReleaseCommit",
    "releaseMembershipRoot", "definitionCatalogRoot", "familyCompositionRoot",
    "generationId", "readyRecordHash", "graphRoot", "readyCutoff",
    "recentObservationRange", "currentSourceSessionId", "actualCurrentSource",
    "amountSeedHash", "executionContextHash", "objectiveRef", "bindingRoot",
  ], "fullGraphSweep.binding");
  for (const [key, value] of Object.entries({
    runtimeBindingId: sweep.binding.runtimeBindingId,
    releaseProvenanceHash: sweep.binding.releaseProvenanceHash,
    releaseMembershipRoot: sweep.binding.releaseMembershipRoot,
    definitionCatalogRoot: sweep.binding.definitionCatalogRoot,
    familyCompositionRoot: sweep.binding.familyCompositionRoot,
    readyRecordHash: sweep.binding.readyRecordHash,
    graphRoot: sweep.binding.graphRoot,
    currentSourceSessionId: sweep.binding.currentSourceSessionId,
    amountSeedHash: sweep.binding.amountSeedHash,
    executionContextHash: sweep.binding.executionContextHash,
    objectiveRef: sweep.binding.objectiveRef,
    bindingRoot: sweep.binding.bindingRoot,
  })) assertHash(value, `fullGraphSweep.binding.${key}`);
  if (!/^[0-9a-f]{40}$/.test(sweep.binding.candidateReleaseCommit)) {
    throw new TypeError("fullGraphSweep.binding.candidateReleaseCommit is invalid");
  }
  assertNonEmptyString(sweep.binding.generationId, "fullGraphSweep.binding.generationId");
  familySearchSource(sweep.binding.readyCutoff, "fullGraphSweep.binding.readyCutoff");
  familySearchSource(sweep.binding.actualCurrentSource, "fullGraphSweep.binding.actualCurrentSource");
  assertExactKeys(sweep.binding.recentObservationRange, ["from", "to", "blockCount"], "fullGraphSweep.binding.recentObservationRange");
  assertDecimalString(sweep.binding.recentObservationRange.from, "fullGraphSweep.binding.recentObservationRange.from");
  assertDecimalString(sweep.binding.recentObservationRange.to, "fullGraphSweep.binding.recentObservationRange.to");
  if (sweep.binding.recentObservationRange.blockCount !== "50") throw new TypeError("fullGraphSweep binding range is not 50 blocks");
  assertDecimalString(sweep.expectedTransitionCount, "fullGraphSweep.expectedTransitionCount");
  assertDecimalString(sweep.observedTransitionCount, "fullGraphSweep.observedTransitionCount");
  assertDecimalString(sweep.missingTransitionCount, "fullGraphSweep.missingTransitionCount");
  for (const key of ["expectedTransitionRoot", "observedTransitionRoot", "missingTransitionRoot", "sweepRoot"] as const) {
    assertHash(sweep[key], `fullGraphSweep.${key}`);
  }
  const { bindingRoot, ...bindingBody } = sweep.binding;
  if (bindingRoot !== hashDomain("aloha/full-graph-coarse-sweep-binding/v1", bindingBody)) {
    throw new TypeError("full-Graph sweep binding root mismatch");
  }
  if (!Array.isArray(sweep.entries)) throw new TypeError("fullGraphSweep.entries must be an array");
  if (!Array.isArray(sweep.expectedTransitionIds) || !Array.isArray(sweep.observedTransitionIds)
    || !Array.isArray(sweep.missingTransitionIds) || !Array.isArray(sweep.familyTransitionCounts)) {
    throw new TypeError("fullGraphSweep transition denominator arrays are missing");
  }
  const transitionIds = new Set<Hash>();
  let previousTransitionKey: string | null = null;
  for (const [index, entry] of sweep.entries.entries()) {
    assertExactKeys(entry, [
      "bindingRoot", "ordinal", "transitionId", "edge", "inputAssetRef", "inputPortRef",
      "outputAssetRef", "outputPortRef", "status",
      "missingReason", "receipt", "familyObservation", "entryRoot",
    ], `fullGraphSweep.entries[${index}]`);
    assertHash(entry.bindingRoot, `fullGraphSweep.entries[${index}].bindingRoot`);
    assertDecimalString(entry.ordinal, `fullGraphSweep.entries[${index}].ordinal`);
    const edge = decodeFullFamilyPersistedGraphEdge(entry.edge, `fullGraphSweep.entries[${index}].edge`);
    const transitionId = assertHash(entry.transitionId, `fullGraphSweep.entries[${index}].transitionId`);
    const inputAssetRef = assertHash(entry.inputAssetRef, `fullGraphSweep.entries[${index}].inputAssetRef`);
    const inputPortRef = assertHash(entry.inputPortRef, `fullGraphSweep.entries[${index}].inputPortRef`);
    const outputAssetRef = assertHash(entry.outputAssetRef, `fullGraphSweep.entries[${index}].outputAssetRef`);
    const outputPortRef = assertHash(entry.outputPortRef, `fullGraphSweep.entries[${index}].outputPortRef`);
    if (entry.bindingRoot !== bindingRoot || entry.ordinal !== String(index)) {
      throw new TypeError("fullGraphSweep entry binding/ordinal denominator mismatch");
    }
    const input = edge.inputAssetPorts.find(port => port.assetRef === inputAssetRef && port.portRef === inputPortRef);
    const output = edge.outputAssetPorts.find(port => port.assetRef === outputAssetRef && port.portRef === outputPortRef);
    const transitionPayload = Object.freeze({
      edgeId: edge.edgeId,
      transitionRef: edge.opaqueTransitionRef,
      inputAssetRef,
      inputPortRef,
      outputAssetRef,
      outputPortRef,
      owningFamilyId: edge.owningFamilyId,
    });
    const transitionKey = `${edge.edgeId}\u001f${edge.opaqueTransitionRef}\u001f${inputAssetRef}\u001f${inputPortRef}\u001f${outputAssetRef}\u001f${outputPortRef}`;
    if (input === undefined || output === undefined
      || transitionId !== hashDomain("aloha/full-graph-coarse-transition/v1", transitionPayload)
      || transitionIds.has(transitionId)
      || (previousTransitionKey !== null && previousTransitionKey >= transitionKey)) {
      throw new TypeError("fullGraphSweep transition denominator identity/order mismatch");
    }
    transitionIds.add(transitionId);
    previousTransitionKey = transitionKey;
    if (entry.status !== "observed" && entry.status !== "missing") throw new TypeError("fullGraphSweep entry status is invalid");
    if (entry.missingReason !== null && entry.missingReason !== "coarse-owner-missing") {
      throw new TypeError("fullGraphSweep entry missing reason is invalid");
    }
    if ((entry.status === "observed"
        && (entry.receipt === null || entry.familyObservation === null || entry.missingReason !== null))
      || (entry.status === "missing"
        && (entry.receipt !== null || entry.familyObservation !== null || entry.missingReason === null))) {
      throw new TypeError("fullGraphSweep entry observation pairing mismatch");
    }
    assertHash(entry.entryRoot, `fullGraphSweep.entries[${index}].entryRoot`);
    const { entryRoot, ...entryBody } = entry;
    if (entryRoot !== hashDomain("aloha/full-graph-coarse-sweep-entry/v1", entryBody)) {
      throw new TypeError("full-Graph sweep entry root mismatch");
    }
  }
  const observed = sweep.entries.filter(entry => entry.status === "observed");
  const missingEntries = sweep.entries.filter(entry => entry.status === "missing");
  const expectedTransitionIds = sweep.entries.map(entry => entry.transitionId);
  const observedTransitionIds = observed.map(entry => entry.transitionId);
  const missingTransitionIds = missingEntries.map(entry => entry.transitionId);
  const familyCounts = new Map<string, { expected: number; observed: number; missing: number }>();
  for (const entry of sweep.entries) {
    const counts = familyCounts.get(entry.edge.owningFamilyId) ?? { expected: 0, observed: 0, missing: 0 };
    counts.expected += 1;
    if (entry.status === "observed") counts.observed += 1;
    else counts.missing += 1;
    familyCounts.set(entry.edge.owningFamilyId, counts);
  }
  const familyTransitionCounts = [...familyCounts.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([familyId, counts]) => Object.freeze({
      familyId,
      expectedTransitionCount: String(counts.expected),
      observedTransitionCount: String(counts.observed),
      missingTransitionCount: String(counts.missing),
    }));
  if (sweep.schemaVersion !== 1
    || sweep.kind !== "aloha.full-graph-coarse-sweep-v1"
    || sweep.expectedTransitionCount !== String(sweep.entries.length)
    || sweep.observedTransitionCount !== String(observed.length)
    || sweep.missingTransitionCount !== String(missingEntries.length)
    || !sameOrderedHashes(sweep.expectedTransitionIds, expectedTransitionIds)
    || !sameOrderedHashes(sweep.observedTransitionIds, observedTransitionIds)
    || !sameOrderedHashes(sweep.missingTransitionIds, missingTransitionIds)
    || sweep.expectedTransitionRoot !== fullGraphTransitionSequenceRootV1("expected", expectedTransitionIds)
    || sweep.observedTransitionRoot !== fullGraphTransitionSequenceRootV1("observed", observedTransitionIds)
    || sweep.missingTransitionRoot !== fullGraphTransitionSequenceRootV1("missing", missingTransitionIds)
    || !sameCanonical(sweep.familyTransitionCounts, familyTransitionCounts)) {
    throw new TypeError("full-Graph sweep count/root mismatch");
  }
  const encoded = encodeFullGraphCoarseSweepV1(sweep);
  if (encoded.manifest.sweepRoot !== sweep.sweepRoot) {
    throw new TypeError("full-Graph sweep root mismatch");
  }
}

/**
 * Deterministic validation over already owner-authenticated facts.  It grants
 * no authority and cannot produce a fact locator; the exported production
 * entry below is the only path that calls it.
 */
export function validateProductionFullFamilyBindings(
  snapshot: ReadyFullFamilyEvidenceSnapshotV1,
  audit: NativeFullFamilyAuditV1,
  release: FullFamilyReleaseArtifactObservationV1,
  verifier: FullFamilyCandidateProofVerifierBindingV1,
  terminalBinding: RuntimeReleaseFullFamilyTerminalBindingV1,
  sweep: FullGraphCoarseSweepV1,
): readonly FullFamilyObserverMissingV1[] {
  const ready = snapshot.ready;
  if (!sameCanonical(snapshot.stage12.binding, {
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
  })) throw new TypeError("checkpoint Stage 1/2/ready splice");
  if (snapshot.stage12.candidates.length !== snapshot.stage12.outcomes.length
    || new Set(snapshot.stage12.candidates.map(candidate => candidate.familyCandidateKey)).size !== snapshot.stage12.candidates.length
    || new Set(snapshot.stage12.outcomes.map(outcome => outcome.familyCandidateKey)).size !== snapshot.stage12.outcomes.length
    || snapshot.stage12.candidates.some(candidate => !snapshot.stage12.outcomes.some(outcome => outcome.familyCandidateKey === candidate.familyCandidateKey))) {
    throw new TypeError("checkpoint candidate/outcome denominator splice");
  }
  if (snapshot.stage12.candidatePartitionProof.candidatePartitionRoot !== ready.candidatePartitionRoot
    || snapshot.stage12.candidatePartitionProof.nominationClosureRoot !== ready.nominationClosureRoot
    || snapshot.stage12.candidatePartitionProof.releaseProvenanceHash !== ready.releaseProvenanceHash
    || snapshot.nominationClosure.root !== ready.nominationClosureRoot
    || snapshot.nominationClosure.sourceCoverageRoot !== ready.sourceCoverageRoot
    || snapshot.nominationClosure.candidatePartitionRoot !== ready.candidatePartitionRoot) {
    throw new TypeError("checkpoint candidate/nomination/ready splice");
  }
  if (audit.binding.generationId !== ready.generationId
    || audit.binding.readyRecordHash !== ready.readyRecordHash
    || audit.binding.graphRoot !== ready.graphRoot
    || audit.binding.releaseProvenanceHash !== ready.releaseProvenanceHash
    || !sameCutoff(audit.binding.readyCutoff, ready.cutoff)) {
    throw new TypeError("native audit/ready splice");
  }
  if (terminalBinding.nativeAuditManifest.auditRoot !== audit.auditRoot
    || terminalBinding.nativeAuditManifest.binding.bindingRoot !== audit.binding.bindingRoot
    || terminalBinding.releaseProvenanceHash !== ready.releaseProvenanceHash
    || terminalBinding.readyRecordHash !== ready.readyRecordHash
    || terminalBinding.generationId !== ready.generationId
    || terminalBinding.graphRoot !== ready.graphRoot
    || !sameCutoff(terminalBinding.readyCutoff, ready.cutoff)
    || !sameCutoff(terminalBinding.actualCurrentSource, audit.binding.actualCurrentSource)) {
    throw new TypeError("runtime-release terminal/audit/ready splice");
  }
  if (release.globalDefinitionCatalogRoot.kind !== "complete") {
    throw new TypeError("Strategy catalog/global definition root is missing");
  }
  if (release.globalDefinitionCatalogRoot.definitionCatalogRoot !== ready.definitionCatalogRoot) {
    throw new TypeError("release/ready global definition root splice");
  }
  if (verifier.releaseProvenanceHash !== ready.releaseProvenanceHash
    || verifier.runtimeBindingId !== terminalBinding.runtimeBindingId
    || verifier.candidateReleaseCommit !== terminalBinding.candidateReleaseCommit
    || verifier.proofKeyId !== snapshot.stage12.candidatePartitionProof.issuerKeyId
    || verifier.proofKeyId !== snapshot.stage12.candidatePartitionProof.signerKeyId) {
    throw new TypeError("candidate proof verifier/ready splice");
  }
  validateNativeFullFamilyAuditWireV1(audit);
  assertNativeProjectedEdgeDenominatorV1(
    audit,
    snapshot.stage12.graph.edgeCount,
    snapshot.stage12.graph.edges.map(edge => edge.edgeId),
  );
  validateMaterializedFullGraphSweepV1(sweep);
  if (sweep.binding.runtimeBindingId !== terminalBinding.runtimeBindingId
    || sweep.binding.releaseProvenanceHash !== ready.releaseProvenanceHash
    || sweep.binding.candidateReleaseCommit !== terminalBinding.candidateReleaseCommit
    || sweep.binding.generationId !== ready.generationId
    || sweep.binding.readyRecordHash !== ready.readyRecordHash
    || sweep.binding.graphRoot !== ready.graphRoot
    || !sameCutoff(sweep.binding.readyCutoff, ready.cutoff)
    || !sameCutoff(sweep.binding.actualCurrentSource, terminalBinding.actualCurrentSource)
    || sweep.binding.recentObservationRange.from !== ready.recentObservationRange.from
    || sweep.binding.recentObservationRange.to !== ready.recentObservationRange.to
    || sweep.binding.recentObservationRange.blockCount !== "50") {
    throw new TypeError("full-Graph sweep/release/ready/source splice");
  }
  const start = BigInt(ready.recentObservationRange.from);
  const end = BigInt(ready.recentObservationRange.to);
  if (end !== BigInt(ready.cutoff.number) || end - start !== 49n) {
    throw new TypeError("ready recent observation range is not cutoff-49..cutoff");
  }
  const releaseFamilies = release.families.map(family => family.familyId);
  const nominationFamilies = snapshot.nominationClosure.families.map(family => family.familyId);
  if (!sameCanonical(releaseFamilies, nominationFamilies)) throw new TypeError("release/nomination Family denominator splice");

  const expectedTransitions = derivePlannerCompatibleReadyGraphTransitionsV1(snapshot.stage12.graph.edges);
  const expectedTransitionIds = expectedTransitions.map(transition => transition.transitionId);
  for (const [ordinal, entry] of sweep.entries.entries()) {
    const expected = expectedTransitions[ordinal];
    if (entry.bindingRoot !== sweep.binding.bindingRoot
      || entry.ordinal !== String(ordinal)
      || expected === undefined
      || entry.transitionId !== expected.transitionId
      || entry.edge.edgeId !== expected.edgeId
      || entry.edge.opaqueTransitionRef !== expected.transitionRef
      || entry.edge.owningFamilyId !== expected.owningFamilyId
      || entry.inputAssetRef !== expected.inputAssetRef
      || entry.inputPortRef !== expected.inputPortRef
      || entry.outputAssetRef !== expected.outputAssetRef
      || entry.outputPortRef !== expected.outputPortRef) {
      throw new TypeError("full-Graph sweep transition denominator/Graph splice");
    }
    if ((entry.status === "observed") !== (entry.receipt !== null && entry.familyObservation !== null)
      || (entry.status === "missing") !== (entry.receipt === null && entry.familyObservation === null)) {
      throw new TypeError("full-Graph sweep observation pairing mismatch");
    }
    if (entry.status === "observed") exactSweepFamilyObservation(sweep, entry);
  }
  const result: FullFamilyObserverMissingV1[] = [];
  const graphFamilyCounts = new Map<string, number>();
  for (const transition of expectedTransitions) {
    graphFamilyCounts.set(transition.owningFamilyId, (graphFamilyCounts.get(transition.owningFamilyId) ?? 0) + 1);
  }
  const expectedFamilyCounts = [...graphFamilyCounts.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([familyId, count]) => Object.freeze({ familyId, expectedTransitionCount: String(count) }));
  const sweptExpectedFamilyCounts = sweep.familyTransitionCounts.map(({ familyId, expectedTransitionCount }) =>
    Object.freeze({ familyId, expectedTransitionCount }));
  if (sweep.expectedTransitionCount !== String(expectedTransitions.length)
    || sweep.entries.length !== expectedTransitions.length
    || sweep.expectedTransitionRoot !== fullGraphTransitionSequenceRootV1("expected", expectedTransitionIds)
    || !sameOrderedHashes(sweep.expectedTransitionIds, expectedTransitionIds)
    || !sameCanonical(sweptExpectedFamilyCounts, expectedFamilyCounts)) {
    result.push(missing("graph-transition-audit-denominator-incomplete", {
      graphTransitionIds: expectedTransitionIds,
      expectedTransitionCount: sweep.expectedTransitionCount,
      sweptTransitionIds: sweep.expectedTransitionIds,
      graphFamilyTransitionCounts: expectedFamilyCounts,
      sweptFamilyTransitionCounts: sweptExpectedFamilyCounts,
    }));
  }
  if (sweep.entries.some(entry => (
    entry.status === "missing" || exactSweepFamilyObservation(sweep, entry).coarse === null
  ))) {
    result.push(missing("coarse-family-artifact-unavailable", sweep.sweepRoot));
  }
  return Object.freeze(result);
}

async function write(
  sink: ContentAddressedObserverSinkV1,
  output: FullFamilyObservedArtifactV1[],
  role: string,
  bytes: Uint8Array,
  artifactSchema: SchemaRef,
): Promise<ObservedContentArtifactV1> {
  const artifact = await sink.write({ bytes, mediaType: "application/json", schema: artifactSchema });
  output.push(Object.freeze({ role, artifact }));
  return artifact;
}

async function writeStoredPartitionIndex(
  sink: ContentAddressedObserverSinkV1,
  output: FullFamilyObservedArtifactV1[],
  familyId: string,
  role: FullFamilyPartitionRoleV1,
  partition: Readonly<{
    readonly count: string;
    readonly root: Hash;
    readonly items: readonly (FamilyEvidenceItemV1 | FamilyOutcomeItemV1)[];
  }>,
): Promise<FullFamilyStoredPartitionBindingInputV1> {
  const pageCount = Math.ceil(partition.items.length / 128);
  const forwardRefs: Array<Readonly<{ readonly artifactRefId: Hash; readonly contentSha256: Hash }>> = new Array(pageCount);
  let nextPageRef: Readonly<{ readonly artifactRefId: Hash; readonly contentSha256: Hash }> | null = null;
  for (let pageOrdinal = pageCount - 1; pageOrdinal >= 0; pageOrdinal -= 1) {
    const startIndex = pageOrdinal * 128;
    const page = sealFullFamilyArtifactRefPageV1({
      refs: partition.items.slice(startIndex, startIndex + 128).map(item => Object.freeze({
        artifactRefId: item.evidenceArtifactRefId,
        contentSha256: item.evidenceContentSha256,
      })),
      nextPageRef,
    });
    const artifact = await write(
      sink,
      output,
      `full-family-ref-page:${familyId}:${role}:${pageOrdinal}`,
      encodeFullFamilyArtifactRefPageV1(page),
      schema("artifactRefPage"),
    );
    nextPageRef = Object.freeze({
      artifactRefId: artifact.ref.artifactRefId,
      contentSha256: artifact.contentSha256,
    });
    forwardRefs[pageOrdinal] = nextPageRef;
  }
  const index = sealFullFamilyArtifactRefIndexV1({
    pageCount: String(pageCount),
    firstPageRef: forwardRefs[0] ?? null,
  });
  const indexArtifact = await write(
    sink,
    output,
    `full-family-ref-index:${familyId}:${role}`,
    encodeFullFamilyArtifactRefIndexV1(index),
    schema("artifactRefIndex"),
  );
  return Object.freeze({
    familyId,
    role,
    count: partition.count,
    root: partition.root,
    indexArtifactRefId: indexArtifact.ref.artifactRefId,
    indexContentSha256: indexArtifact.contentSha256,
  });
}

function familyMaterial(
  release: FullFamilyReleaseArtifactObservationV1,
): Map<string, {
  familyId: string;
  familyDefinitionHash: Hash;
  sourcePlanRoot: Hash;
  sourcePlans: FamilyEvidenceItemV1[];
  universeCandidates: FamilyEvidenceItemV1[];
  outcomes: FamilyOutcomeItemV1[];
  instancePublications: FamilyEvidenceItemV1[];
  projectedEdges: FamilyEvidenceItemV1[];
  declaredCoarseCapabilities: FamilyEvidenceItemV1[];
  coarseRankable: FamilyEvidenceItemV1[];
  coarseUnavailable: FamilyEvidenceItemV1[];
  unrankedAdmissions: FamilyEvidenceItemV1[];
  declaredExactCapabilities: FamilyEvidenceItemV1[];
  ownedActions: FamilyEvidenceItemV1[];
}> {
  return new Map(release.families.map(family => [family.familyId, {
    familyId: family.familyId,
    familyDefinitionHash: family.familyDefinitionHash,
    sourcePlanRoot: family.sourcePlanRoot,
    sourcePlans: [],
    universeCandidates: [],
    outcomes: [],
    instancePublications: [],
    projectedEdges: [],
    declaredCoarseCapabilities: [],
    coarseRankable: [],
    coarseUnavailable: [],
    unrankedAdmissions: [],
    declaredExactCapabilities: [],
    ownedActions: [],
  }]));
}

export async function observeProductionFullFamily(
  input: ProductionFullFamilyObserverInputV1,
): Promise<ProductionFullFamilyObserverResultV1> {
  if (!(input.sink instanceof ContentAddressedObserverSinkV1)) {
    throw new TypeError("production full-family observer requires collector-owned sink");
  }
  const terminalBinding = readProductionRuntimeReleaseFullFamilyTerminalBinding(
    input.runtimeReleaseTerminalBindingCapability,
  );
  const audit = readRuntimeReleaseNativeFullFamilyAuditV1(
    input.runtimeReleaseTerminalBindingCapability,
  );
  const nativeAuditManifest: NativeFullFamilyAuditManifestV1 = terminalBinding.nativeAuditManifest;
  const sweep = readFullGraphSweep(input.fullGraphCoarseSweepCapability);
  const snapshot = await readCheckpointReadyFullFamilyEvidence(
    input.checkpointReader,
    input.stage12Capability,
  );

  const release = observeFullFamilyReleaseArtifacts({
    releaseIntentCanonicalBytes: input.releaseIntentCanonicalBytes,
    familyCatalogSourceBytes: input.familyCatalogSourceBytes,
    runtimeCompositionSourceBytes: input.runtimeCompositionSourceBytes,
    strategyCatalogSourceBytes: input.strategyCatalogSourceBytes,
  });
  const verifierBytes = concreteBytes(input.candidateProofVerifierBindingBytes, "candidateProofVerifierBindingBytes");
  const verifier = decodeFullFamilyCandidateProofVerifierBinding(verifierBytes);
  const canonicalVerifierBytes = encodeFullFamilyCandidateProofVerifierBinding(verifier);
  if (sha256Hex(verifierBytes) !== sha256Hex(canonicalVerifierBytes)) {
    throw new TypeError("candidate proof verifier binding bytes are not canonical");
  }
  const missingFacts = validateProductionFullFamilyBindings(snapshot, audit, release, verifier, terminalBinding, sweep);
  const observedArtifacts: FullFamilyObservedArtifactV1[] = [];

  const releaseIntentObserved = await write(input.sink, observedArtifacts, "release-intent-source", input.releaseIntentCanonicalBytes, schema("releaseIntent"));
  await write(input.sink, observedArtifacts, "family-catalog-source", input.familyCatalogSourceBytes, RAW_FAMILY_CATALOG_SOURCE_SCHEMA);
  await write(input.sink, observedArtifacts, "runtime-composition-source", input.runtimeCompositionSourceBytes, RAW_RUNTIME_COMPOSITION_SOURCE_SCHEMA);
  await write(input.sink, observedArtifacts, "strategy-catalog-source", input.strategyCatalogSourceBytes, RAW_STRATEGY_CATALOG_SOURCE_SCHEMA);
  const verifierObserved = await write(input.sink, observedArtifacts, "candidate-proof-verifier-binding", canonicalVerifierBytes, schema("candidateProofVerifierBinding"));
  await write(
    input.sink,
    observedArtifacts,
    "runtime-release-full-family-terminal-binding",
    encodeCanonicalBytes(terminalBinding),
    FULL_FAMILY_TERMINAL_BINDING_SCHEMA,
  );
  for (const section of nativeAuditManifest.sections) {
    let ref = section.firstChunkRef;
    let chunkCount = 0;
    while (ref !== null) {
      const bytes = readRuntimeReleaseNativeFullFamilyAuditChunkV1(
        input.runtimeReleaseTerminalBindingCapability,
        ref,
      );
      await write(
        input.sink,
        observedArtifacts,
        `native-full-family-audit-chunk:${section.section}:${chunkCount}`,
        bytes,
        NATIVE_AUDIT_CHUNK_SCHEMA,
      );
      const chunk = decodeCanonicalBytes(bytes) as unknown as NativeFullFamilyAuditChunkV1;
      ref = chunk.nextChunkRef;
      chunkCount += 1;
    }
    if (String(chunkCount) !== section.chunkCount) {
      throw new TypeError("native full-family audit observer chunk count mismatch");
    }
  }
  await write(
    input.sink,
    observedArtifacts,
    "native-full-family-audit",
    encodeCanonicalBytes(nativeAuditManifest),
    NATIVE_AUDIT_SCHEMA,
  );
  const encodedSweep = encodeFullGraphCoarseSweepV1(sweep);
  for (const chunk of encodedSweep.chunks) {
    await write(
      input.sink,
      observedArtifacts,
      `full-graph-coarse-sweep-entry-chunk:${chunk.ref.chunkOrdinal}`,
      chunk.bytes,
      FULL_GRAPH_COARSE_SWEEP_CHUNK_SCHEMA,
    );
  }
  await write(
    input.sink,
    observedArtifacts,
    "full-graph-coarse-sweep",
    encodedSweep.manifestBytes,
    FULL_GRAPH_COARSE_SWEEP_SCHEMA,
  );
  await write(input.sink, observedArtifacts, "actual-current-source", encodeCanonicalBytes(sweep.binding.actualCurrentSource), ACTUAL_CURRENT_SOURCE_SCHEMA);

  if (release.globalDefinitionCatalogRoot.kind !== "complete") {
    throw new TypeError("Strategy catalog/global definition root is missing");
  }
  const releaseEntries = release.families.map(family => Object.freeze({
    familyId: family.familyId,
    familyDefinitionHash: family.familyDefinitionHash,
    entryHash: hashFamilyReleaseEntry(family.familyId, family.familyDefinitionHash),
  }));
  const entrySetRoot = hashFamilyReleaseSet(releaseEntries);
  const releaseProjections: readonly FullFamilyReleaseProjectionArtifactV1[] = Object.freeze([
    Object.freeze({
      schemaVersion: 1,
      kind: "aloha.full-family-release-projection-artifact",
      role: "definition-catalog",
      contractRoot: release.globalDefinitionCatalogRoot.definitionCatalogRoot,
      count: String(releaseEntries.length),
      entrySetRoot,
      entries: Object.freeze(releaseEntries),
    }),
    Object.freeze({
      schemaVersion: 1,
      kind: "aloha.full-family-release-projection-artifact",
      role: "runtime-composition",
      contractRoot: release.runtimeDescriptorRoot,
      count: String(releaseEntries.length),
      entrySetRoot,
      entries: Object.freeze(releaseEntries),
    }),
  ]);
  const releaseProjectionObserved = new Map<FullFamilyReleaseProjectionArtifactV1["role"], ObservedContentArtifactV1>();
  for (const projection of releaseProjections) {
    const observed = await write(
      input.sink,
      observedArtifacts,
      `release-projection:${projection.role}`,
      encodeFullFamilyReleaseProjectionArtifact(projection),
      schema("releaseProjection"),
    );
    releaseProjectionObserved.set(projection.role, observed);
  }

  const readyRecord: FullFamilyReadyRecordV1 = Object.freeze({
    ...snapshot.ready,
    generationId: snapshot.ready.generationId as Hash,
    parentGenerationId: snapshot.ready.parentGenerationId as Hash | null,
  });
  const readyObserved = await write(input.sink, observedArtifacts, "ready-record", encodeFullFamilyReadyRecord(readyRecord), schema("readyRecord"));
  const nominationObserved = await write(input.sink, observedArtifacts, "nomination-closure", encodeNominationClosureV1(snapshot.nominationClosure), schema("nominationClosure"));
  const candidateProofObserved = await write(input.sink, observedArtifacts, "candidate-partition-proof", encodeCandidatePartitionProofV1(snapshot.stage12.candidatePartitionProof), schema("candidatePartitionProof"));

  const rawByHash = new Map(snapshot.rawEvidenceLocatorContents.map(raw => [raw.rawLocatorHash, raw]));
  const evidenceByIdentity = new Map(snapshot.sourcePlanEvidenceReceipts.map(receipt => [sourcePlanIdentity(receipt.plan), receipt]));
  const sourceBindings: FullFamilySourcePlanExecutionBindingV1[] = [];
  for (const persisted of snapshot.sourceExecutionSet.executions) {
    const identity = sourcePlanIdentity(persisted.execution.plan);
    const evidence = evidenceByIdentity.get(identity);
    if (evidence === undefined || evidence.evidenceRoot !== persisted.execution.sourceEvidenceRoot) {
      throw new TypeError("checkpoint source execution/evidence splice");
    }
    const executionArtifact = await write(input.sink, observedArtifacts, `source-execution:${identity}`, encodeCanonicalBytes(persisted.execution), schema("sourceExecution"));
    const evidenceArtifact = await write(input.sink, observedArtifacts, `source-evidence:${identity}`, encodeCanonicalBytes(evidence), schema("sourceEvidence"));
    const physicalObservations = [];
    for (const rawLocatorHash of evidence.rawLocatorHashes) {
      const raw = rawByHash.get(rawLocatorHash);
      if (raw === undefined || sha256Hex(raw.bytes) !== rawLocatorHash) throw new TypeError("checkpoint raw source locator is missing");
      const artifact = await write(input.sink, observedArtifacts, `source-physical:${rawLocatorHash}`, raw.bytes, schema("sourcePhysicalObservation"));
      physicalObservations.push(Object.freeze({
        rawLocatorHash,
        artifactRefId: artifact.ref.artifactRefId,
        contentSha256: artifact.contentSha256,
      }));
    }
    sourceBindings.push(Object.freeze({
      ownerRef: persisted.execution.plan.ownerRef,
      sourcePlanRef: persisted.execution.plan.sourcePlanRef,
      familyDefinitionHash: persisted.execution.plan.familyDefinitionHash,
      executionRoot: persisted.execution.executionRoot,
      evidenceRoot: evidence.evidenceRoot,
      resultPartitionRoot: persisted.execution.resultPartitionRoot,
      executionArtifactRefId: executionArtifact.ref.artifactRefId,
      executionContentSha256: executionArtifact.contentSha256,
      evidenceArtifactRefId: evidenceArtifact.ref.artifactRefId,
      evidenceContentSha256: evidenceArtifact.contentSha256,
      physicalObservations: Object.freeze(physicalObservations),
    }));
  }
  sourceBindings.sort((left, right) => sourceBindingIdentity(left).localeCompare(sourceBindingIdentity(right)));
  const sourceCoverageArtifact: FullFamilySourceCoverageArtifactV1 = Object.freeze({
    schemaVersion: 1,
    kind: "aloha.full-family-source-coverage-artifact",
    readyRecordHash: snapshot.ready.readyRecordHash,
    cutoff: snapshot.ready.cutoff,
    executions: Object.freeze(sourceBindings),
    sourceCoverage: snapshot.stage12.sourceCoverage,
  });
  const sourceCoverageObserved = await write(input.sink, observedArtifacts, "source-coverage", encodeFullFamilySourceCoverageArtifact(sourceCoverageArtifact), schema("sourceCoverage"));

  const families = familyMaterial(release);
  for (const family of release.families) {
    const material = families.get(family.familyId)!;
    for (const plan of family.sourcePlanRefs) {
      const subjectKey = sourcePlanIdentity(plan);
      const artifactValue = evidenceArtifact(snapshot.ready.readyRecordHash, "source-plan", family.familyId, subjectKey, subjectKey);
      const artifact = await write(input.sink, observedArtifacts, `source-plan:${subjectKey}`, encodeFullFamilyEvidenceArtifact(artifactValue), schema("evidence"));
      material.sourcePlans.push(Object.freeze({ familyId: family.familyId, itemId: subjectKey, subjectKey, evidenceArtifactRefId: artifact.ref.artifactRefId, evidenceContentSha256: artifact.contentSha256 }));
    }
  }

  const outcomeByCandidate = new Map(snapshot.stage12.outcomes.map(outcome => [outcome.familyCandidateKey, outcome]));
  for (const candidate of snapshot.stage12.candidates) {
    const material = families.get(candidate.familyId);
    if (material === undefined || material.familyDefinitionHash !== candidate.familyDefinitionHash) throw new TypeError("candidate/release Family splice");
    const candidateKey = candidate.familyCandidateKey;
    const candidateEvidence = evidenceArtifact(snapshot.ready.readyRecordHash, "universe-candidate", candidate.familyId, candidateKey, candidateKey);
    const observedCandidate = await write(input.sink, observedArtifacts, `candidate:${candidateKey}`, encodeFullFamilyEvidenceArtifact(candidateEvidence), schema("evidence"));
    material.universeCandidates.push(Object.freeze({ familyId: candidate.familyId, itemId: candidateKey, subjectKey: candidateKey, evidenceArtifactRefId: observedCandidate.ref.artifactRefId, evidenceContentSha256: observedCandidate.contentSha256 }));
    const outcome = outcomeByCandidate.get(candidateKey);
    if (outcome === undefined) throw new TypeError("checkpoint candidate outcome is missing");
    const rawOutcome: CandidateFinalOutcomeWireV1 = validateCandidateFinalOutcomeV1({
      runId: snapshot.stage12.runId,
      cutoff: snapshot.ready.cutoff,
      candidatePartitionRoot: snapshot.ready.candidatePartitionRoot,
      candidate,
    }, outcome);
    const summary = deriveFullFamilyOutcomeSummary(candidate, rawOutcome);
    const itemId = hashDomain("aloha/full-family/outcome-artifact-item/v1", {
      readyRecordHash: snapshot.ready.readyRecordHash,
      candidateKey,
      rawOutcome,
    });
    const outcomeArtifact: FullFamilyOutcomeArtifactV1 = Object.freeze({
      schemaVersion: 2,
      kind: "aloha.full-family-outcome-artifact",
      readyRecordHash: snapshot.ready.readyRecordHash,
      familyId: candidate.familyId,
      itemId,
      runId: snapshot.stage12.runId,
      cutoff: snapshot.ready.cutoff,
      candidatePartitionRoot: snapshot.ready.candidatePartitionRoot,
      exactOutcomePartitionRoot: snapshot.ready.exactOutcomePartitionRoot,
      candidate,
      rawOutcome,
      ...summary,
    });
    const observedOutcome = await write(input.sink, observedArtifacts, `outcome:${candidateKey}`, encodeFullFamilyOutcomeArtifact(outcomeArtifact), schema("outcome"));
    material.outcomes.push(Object.freeze({ familyId: candidate.familyId, itemId, candidateKey, instanceKey: summary.instanceKey, outcome: summary.outcome, evidenceArtifactRefId: observedOutcome.ref.artifactRefId, evidenceContentSha256: observedOutcome.contentSha256 }));
  }

  for (const publication of snapshot.stage12.instanceCatalog.publications) {
    const material = families.get(publication.familyId);
    if (material === undefined || material.familyDefinitionHash !== publication.familyDefinitionHash) throw new TypeError("publication/release Family splice");
    const subjectKey = instanceIdentityRef(publication.familyDefinitionHash, publication.instanceKey);
    const artifact = await write(input.sink, observedArtifacts, `publication:${publication.instancePublicationHash}`, encodeCanonicalBytes(publication), schema("instancePublication"));
    material.instancePublications.push(Object.freeze({ familyId: publication.familyId, itemId: publication.instancePublicationHash, subjectKey, evidenceArtifactRefId: artifact.ref.artifactRefId, evidenceContentSha256: artifact.contentSha256 }));
  }
  for (const edge of snapshot.stage12.graph.edges) {
    const material = families.get(edge.owningFamilyId);
    if (material === undefined || material.familyDefinitionHash !== edge.owningFamilyDefinitionHash) throw new TypeError("Graph/release Family splice");
    const subjectKey = instanceIdentityRef(edge.owningFamilyDefinitionHash, edge.owningInstanceKey);
    const artifact = await write(input.sink, observedArtifacts, `edge:${edge.edgeId}`, encodeCanonicalBytes(edge), schema("graphEdge"));
    material.projectedEdges.push(Object.freeze({ familyId: edge.owningFamilyId, itemId: edge.edgeId, subjectKey, evidenceArtifactRefId: artifact.ref.artifactRefId, evidenceContentSha256: artifact.contentSha256 }));
  }

  for (const entry of sweep.entries) {
    if (entry.status !== "observed") continue;
    const observed = exactSweepFamilyObservation(sweep, entry);
    const material = families.get(entry.edge.owningFamilyId);
    if (material === undefined || material.familyDefinitionHash !== entry.edge.owningFamilyDefinitionHash) {
      throw new TypeError("full-Graph sweep/release Family splice");
    }
    const ownerObservationArtifact = await write(
      input.sink,
      observedArtifacts,
      `coarse-owner-observation:${entry.edge.edgeId}`,
      encodeCanonicalBytes(entry.familyObservation),
      schema("coarseObservation"),
    );
    if (observed.coarse === null) continue;
    const item = Object.freeze({
      familyId: entry.edge.owningFamilyId,
      itemId: observed.coarse.artifactHash,
      subjectKey: entry.edge.edgeId,
      evidenceArtifactRefId: ownerObservationArtifact.ref.artifactRefId,
      evidenceContentSha256: ownerObservationArtifact.contentSha256,
    });
    if (observed.coarse.status === "rankable") {
      material.coarseRankable.push(item);
    } else {
      material.coarseUnavailable.push(item);
      material.unrankedAdmissions.push(item);
    }
  }

  const catalogObservation = observeGeneratedJsonConstant(input.familyCatalogSourceBytes, {
    sourceFileName: "generated/family-catalog/index.ts",
    constantName: "FAMILY_CATALOG",
    requireExported: true,
    assertionTypeName: null,
  });
  const catalog = exactFamilyCatalog(catalogObservation.value);
  for (const entry of catalog.entries) {
    const material = families.get(entry.familyId);
    if (material === undefined || material.familyDefinitionHash !== entry.familyDefinitionHash) throw new TypeError("observed Family catalog splice");
    for (const kind of ["coarse", "exact"] as const) {
      const matches = entry.extensionRefs.filter(ref => ref.capabilityId === `family.${entry.familyId}.${kind}`);
      if (matches.length !== 1) throw new TypeError(`Family ${entry.familyId} has no exact ${kind} declaration`);
      const ref = matches[0]!;
      const artifact = await write(input.sink, observedArtifacts, `declared-${kind}:${entry.familyId}`, encodeCanonicalBytes(ref), schema("generatedCapabilityRef"));
      const item = Object.freeze({ familyId: entry.familyId, itemId: ref.ownerRef, subjectKey: ref.ownerRef, evidenceArtifactRefId: artifact.ref.artifactRefId, evidenceContentSha256: artifact.contentSha256 });
      if (kind === "coarse") material.declaredCoarseCapabilities.push(item);
      else material.declaredExactCapabilities.push(item);
    }
    const releaseFamily = release.families.find(family => family.familyId === entry.familyId);
    if (releaseFamily === undefined) throw new TypeError("observed Family action-owner denominator is missing");
    for (const actionOwnerRef of releaseFamily.actionOwnerRefs) {
      const actionOwner: FullFamilyActionOwnerArtifactV1 = Object.freeze({
        schemaVersion: 1,
        kind: "aloha.full-family-action-owner-artifact",
        familyId: entry.familyId,
        familyDefinitionHash: entry.familyDefinitionHash,
        actionOwnerRef,
      });
      const artifact = await write(
        input.sink,
        observedArtifacts,
        `declared-action-owner:${actionOwnerRef}`,
        encodeFullFamilyActionOwnerArtifact(actionOwner),
        schema("generatedActionOwner"),
      );
      material.ownedActions.push(Object.freeze({
        familyId: entry.familyId,
        itemId: actionOwnerRef,
        subjectKey: actionOwnerRef,
        evidenceArtifactRefId: artifact.ref.artifactRefId,
        evidenceContentSha256: artifact.contentSha256,
      }));
    }
  }

  const frozenFamilies = [...families.values()].sort((left, right) => left.familyId.localeCompare(right.familyId)).map(value => Object.freeze({
    ...value,
    sourcePlans: Object.freeze(value.sourcePlans),
    universeCandidates: Object.freeze(value.universeCandidates),
    outcomes: Object.freeze(value.outcomes),
    instancePublications: Object.freeze(value.instancePublications),
    projectedEdges: Object.freeze(value.projectedEdges),
    declaredCoarseCapabilities: Object.freeze(value.declaredCoarseCapabilities),
    coarseRankable: Object.freeze(value.coarseRankable),
    coarseUnavailable: Object.freeze(value.coarseUnavailable),
    unrankedAdmissions: Object.freeze(value.unrankedAdmissions),
    declaredExactCapabilities: Object.freeze(value.declaredExactCapabilities),
    ownedActions: Object.freeze(value.ownedActions),
  }));
  let bundle: FullFamilyFactBundleV1 | null = null;
  let bundleArtifact: ObservedContentArtifactV1 | null = null;
  let locator: FullFamilyFactLocatorV1 | null = null;
  let locatorArtifact: ObservedContentArtifactV1 | null = null;
  if (missingFacts.length === 0) {
    const nominationByFamily = new Map(snapshot.nominationClosure.families.map(partition => [partition.familyId, partition]));
    const matrix = frozenFamilies.map(family => {
      const candidatePartition = nominationByFamily.get(family.familyId);
      if (candidatePartition === undefined
        || candidatePartition.familyDefinitionHash !== family.familyDefinitionHash) {
        throw new TypeError("nomination/observed Family matrix splice");
      }
      return sealFullFamilyMatrixEntry({
        familyId: family.familyId,
        familyDefinitionHash: family.familyDefinitionHash,
        sourcePlanRoot: family.sourcePlanRoot,
        sourcePlans: sealFamilyEvidencePartition(family.sourcePlans),
        candidatePartition,
        universeCandidates: sealFamilyEvidencePartition(family.universeCandidates),
        outcomes: sealFamilyOutcomePartition(family.outcomes),
        instancePublications: sealFamilyEvidencePartition(family.instancePublications),
        projectedEdges: sealFamilyEvidencePartition(family.projectedEdges),
        declaredCoarseCapabilities: sealFamilyEvidencePartition(family.declaredCoarseCapabilities),
        coarseRankable: sealFamilyEvidencePartition(family.coarseRankable),
        coarseUnavailable: sealFamilyEvidencePartition(family.coarseUnavailable),
        unrankedAdmissions: sealFamilyEvidencePartition(family.unrankedAdmissions),
        declaredExactCapabilities: sealFamilyEvidencePartition(family.declaredExactCapabilities),
        ownedActions: sealFamilyEvidencePartition(family.ownedActions),
      });
    });
    const releaseSetEntries = releaseEntries.map(entry => Object.freeze({
      familyId: entry.familyId,
      familyDefinitionHash: entry.familyDefinitionHash,
    }));
    const definitionProjectionObserved = releaseProjectionObserved.get("definition-catalog");
    const runtimeProjectionObserved = releaseProjectionObserved.get("runtime-composition");
    if (definitionProjectionObserved === undefined || runtimeProjectionObserved === undefined) {
      throw new TypeError("release projection artifacts are incomplete");
    }
    bundle = sealFullFamilyFacts({
      runtime: {
        generationId: readyRecord.generationId,
        releaseBindingId: terminalBinding.runtimeBindingId,
        readyCutoff: readyRecord.cutoff,
        readyCutoffRoot: hashFullFamilyReadyCutoff(readyRecord.cutoff),
        actualCurrentSource: sweep.binding.actualCurrentSource,
        actualCurrentSourceRoot: hashFullFamilyActualCurrentSource(sweep.binding.actualCurrentSource),
        recentObservationStartBlock: readyRecord.recentObservationRange.from,
        recentObservationEndBlock: readyRecord.recentObservationRange.to,
        recentObservationBlockCount: "50",
        releaseIntentRoot: release.releaseIntentRoot,
        definitionCatalogRoot: release.globalDefinitionCatalogRoot.definitionCatalogRoot,
        generatedRuntimeDescriptorRoot: release.runtimeDescriptorRoot,
        runtimeCompositionRoot: release.runtimeDescriptorRoot,
        sourceCoverageRoot: readyRecord.sourceCoverageRoot,
        candidatePartitionRoot: readyRecord.candidatePartitionRoot,
        nominationClosureRoot: readyRecord.nominationClosureRoot,
        nominationClosureStorageHash: readyRecord.nominationClosureStorageHash,
        candidatePartitionStorageHash: snapshot.candidatePartitionStorageHash,
        candidatePartitionProofStorageHash: readyRecord.candidatePartitionProofStorageHash,
        releaseProvenanceHash: readyRecord.releaseProvenanceHash,
        instanceCatalogRoot: readyRecord.instanceCatalogRoot,
        graphRoot: readyRecord.graphRoot,
        readyRecordHash: readyRecord.readyRecordHash,
        instanceCount: readyRecord.instanceCount,
        edgeCount: readyRecord.edgeCount,
        readyRecordArtifactRefId: readyObserved.ref.artifactRefId,
        readyRecordContentSha256: readyObserved.contentSha256,
      },
      releaseIntent: {
        sourceArtifactRefId: releaseIntentObserved.ref.artifactRefId,
        sourceArtifactContentSha256: releaseIntentObserved.contentSha256,
        contractRoot: release.releaseIntentRoot,
        entries: releaseSetEntries,
      },
      definitionCatalog: {
        sourceArtifactRefId: definitionProjectionObserved.ref.artifactRefId,
        sourceArtifactContentSha256: definitionProjectionObserved.contentSha256,
        contractRoot: release.globalDefinitionCatalogRoot.definitionCatalogRoot,
        entries: releaseSetEntries,
      },
      runtimeComposition: {
        sourceArtifactRefId: runtimeProjectionObserved.ref.artifactRefId,
        sourceArtifactContentSha256: runtimeProjectionObserved.contentSha256,
        contractRoot: release.runtimeDescriptorRoot,
        entries: releaseSetEntries,
      },
      sourceCoverage: {
        artifactRefId: sourceCoverageObserved.ref.artifactRefId,
        contentSha256: sourceCoverageObserved.contentSha256,
        artifact: sourceCoverageArtifact,
      },
      lineage: {
        nominationClosure: {
          artifactRefId: nominationObserved.ref.artifactRefId,
          contentSha256: nominationObserved.contentSha256,
          storageHash: readyRecord.nominationClosureStorageHash,
          artifact: snapshot.nominationClosure,
        },
        candidatePartitionProof: {
          artifactRefId: candidateProofObserved.ref.artifactRefId,
          contentSha256: candidateProofObserved.contentSha256,
          storageHash: readyRecord.candidatePartitionProofStorageHash,
          artifact: snapshot.stage12.candidatePartitionProof,
        },
        candidateProofVerifierBinding: {
          artifactRefId: verifierObserved.ref.artifactRefId,
          contentSha256: verifierObserved.contentSha256,
          artifact: verifier,
        },
      },
      families: matrix,
    });
    const storedPartitionBindings: FullFamilyStoredPartitionBindingInputV1[] = [];
    for (const family of bundle.families) {
      const partitions = [
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
      for (const [role, partition] of partitions) {
        storedPartitionBindings.push(await writeStoredPartitionIndex(
          input.sink,
          observedArtifacts,
          family.familyId,
          role,
          partition,
        ));
      }
    }
    const storedBundle = sealFullFamilyFactBundleStorageV1(bundle, storedPartitionBindings);
    bundleArtifact = await write(
      input.sink,
      observedArtifacts,
      "full-family-fact-bundle",
      encodeFullFamilyFactBundleStorageV1(storedBundle),
      FULL_FAMILY_FACT_STORAGE_SCHEMA_REF,
    );
    locator = createFullFamilyFactLocator({
      bundleArtifactRefId: bundleArtifact.ref.artifactRefId,
      bundleContentSha256: bundleArtifact.contentSha256,
    });
    locatorArtifact = await write(
      input.sink,
      observedArtifacts,
      "full-family-fact-locator",
      encodeFullFamilyFactLocator(locator),
      FULL_FAMILY_FACT_LOCATOR_SCHEMA_REF,
    );
  }
  return Object.freeze({
    kind: missingFacts.length === 0
      ? "aloha.production-full-family-observation-v1"
      : "aloha.production-full-family-observation-missing-v1",
    release,
    candidateReleaseCommit: terminalBinding.candidateReleaseCommit,
    finalDurableWindowId: terminalBinding.finalDurableWindowId,
    producerTerminalBindingRoot: terminalBinding.producerTerminalBindingRoot,
    laneTerminalSetRoot: terminalBinding.laneTerminalSetRoot,
    readyRecordHash: snapshot.ready.readyRecordHash,
    auditRoot: audit.auditRoot,
    fullGraphCoarseSweepRoot: sweep.sweepRoot,
    actualCurrentSource: sweep.binding.actualCurrentSource,
    actualCurrentSourceRoot: hashFullFamilyActualCurrentSource(sweep.binding.actualCurrentSource),
    missing: missingFacts,
    families: Object.freeze(frozenFamilies),
    observedArtifacts: Object.freeze(observedArtifacts),
    bundle,
    bundleArtifact,
    locator,
    locatorArtifact,
  });
}
