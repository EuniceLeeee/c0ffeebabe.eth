import {
  assertDecimalString,
  assertHash,
  assertNonEmptyString,
  decodeCanonicalJson,
  decodeExactObject,
  deepFreeze,
  encodeCanonicalBytes,
  encodeCanonicalJson,
  fieldArray,
  hashCanonicalPartition,
  hashDomain,
  sha256Hex,
  type CanonicalJson,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  decodeFullFamilyCanonicalCutoff,
  decodeFullFamilySourcePlanRef,
  fullFamilySourcePlanIdentity,
  validateFullFamilySourceCoverage,
  type CanonicalCutoffV1,
  type SourceCoverageCertificateV1,
  type SourcePlanRefV1,
} from "./source-wire.ts";
import {
  decodeFullFamilyActionOwnerArtifact,
  decodeFullFamilyInstancePublication,
  decodeFullFamilyPersistedGraphEdge,
  decodeFullFamilyStageCapabilityRef,
} from "./runtime-wire.ts";
import {
  candidatePartitionKeysRoot,
  decodeCandidatePartitionProofV1,
  type CandidateRecordV1,
  type CandidatePartitionProofV1,
} from "../../candidate-partition-authority/src/index.ts";
import {
  decodeNominationClosureV1,
  type FamilyNominationPartitionV1,
  type NominationClosureV1,
} from "../../nomination-authority/src/index.ts";
import type { CandidateFinalOutcomeWireV1 } from "../../candidate-final-outcome/src/index.ts";
import {
  decodeRuntimeAuthorityProjectionV1,
  type RuntimeAuthorityProjectionV1,
} from "../../../packages/runtime-authority/src/index.ts";
export type { CandidateFinalOutcomeWireV1 } from "../../candidate-final-outcome/src/index.ts";
export * from "./source-wire.ts";
export * from "./runtime-wire.ts";

export type FullFamilyFactsCodecInput = string | Uint8Array | object;

export type FamilyCandidateOutcomeV1 =
  | "verified"
  | "chain-proven-rejected"
  | "unproven-rejected"
  | "retryable"
  | "invalid-program";

export const FAMILY_CANDIDATE_OUTCOMES = Object.freeze([
  "verified",
  "chain-proven-rejected",
  "unproven-rejected",
  "retryable",
  "invalid-program",
] as const);

export type FamilyDerivedStatusV1 =
  | "strict-attested-published"
  | "exact-zero-candidate"
  | "chain-proven-rejected"
  | "contract-failed"
  | "retryable"
  | "invalid-program";

export const FULL_FAMILY_EVIDENCE_ROLES = Object.freeze([
  "source-plan",
  "universe-candidate",
  "instance-publication",
  "projected-edge",
  "declared-coarse-capability",
  "coarse-rankable",
  "coarse-unavailable",
  "unranked-admission",
  "declared-exact-capability",
  "owned-action",
] as const);

export type FullFamilyEvidenceRoleV1 = (typeof FULL_FAMILY_EVIDENCE_ROLES)[number];

/**
 * Architecture-neutral projection emitted by a qualified observer for one
 * matrix item. The bundle may summarize these fields, but it cannot replace
 * this independently resolved payload.
 */
export interface FullFamilyEvidenceArtifactV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.full-family-evidence-artifact";
  /** Exact ReadyGeneration whose denominator this observation belongs to. */
  readonly readyRecordHash: Hash;
  readonly role: FullFamilyEvidenceRoleV1;
  readonly familyId: string;
  readonly itemId: Hash;
  readonly subjectKey: Hash;
}

export interface FullFamilyOutcomeArtifactV1 {
  readonly schemaVersion: 2;
  readonly kind: "aloha.full-family-outcome-artifact";
  readonly readyRecordHash: Hash;
  readonly familyId: string;
  readonly itemId: Hash;
  /** Exact durable attestation partition coordinates read and verified by the
   * qualified observer through Checkpoint's authority-bound reader. */
  readonly runId: string;
  readonly cutoff: CanonicalCutoffV1;
  readonly candidatePartitionRoot: Hash;
  readonly exactOutcomePartitionRoot: Hash;
  /** Complete raw records, not a producer classification or expected verdict. */
  readonly candidate: CandidateRecordV1;
  readonly rawOutcome: CandidateFinalOutcomeWireV1;
  /** Summary fields are redundant by design and must be derived from rawOutcome. */
  readonly candidateKey: Hash;
  readonly instanceKey: Hash | null;
  readonly outcome: FamilyCandidateOutcomeV1;
}

/** Complete canonical wire object. The neutral fact schema preserves every
 * field; the qualified verifier performs the load-bearing exact semantic
 * decode instead of treating this projection type as authority. */
export interface FullFamilyCandidateProofVerifierBindingV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.full-family-candidate-proof-verifier-binding";
  readonly runtimeBindingId: Hash;
  readonly releaseProvenanceHash: Hash;
  readonly releaseAuthorityRoot: Hash;
  readonly candidateReleaseCommit: string;
  readonly proofKeyId: Hash;
  readonly proofPublicKeyHex: `0x${string}`;
}

export type FullFamilyReleaseProjectionRoleV1 = "definition-catalog" | "runtime-composition";

export interface FullFamilyReleaseProjectionArtifactV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.full-family-release-projection-artifact";
  readonly role: FullFamilyReleaseProjectionRoleV1;
  readonly contractRoot: Hash;
  readonly count: string;
  readonly entrySetRoot: Hash;
  readonly entries: readonly FamilyReleaseEntryV1[];
}

/** Exact discovery authority resolved independently from the summary bundle. */
export interface FullFamilySourceCoverageArtifactV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.full-family-source-coverage-artifact";
  readonly readyRecordHash: Hash;
  readonly cutoff: CanonicalCutoffV1;
  /** Result receipts only. The declared denominator comes from generated runtime metadata. */
  readonly executions: readonly FullFamilySourcePlanExecutionBindingV1[];
  readonly sourceCoverage: SourceCoverageCertificateV1;
}

export interface FullFamilyRawPhysicalObservationBindingV1 {
  readonly rawLocatorHash: Hash;
  readonly artifactRefId: Hash;
  readonly contentSha256: Hash;
}

export interface FullFamilySourcePlanExecutionBindingV1 {
  readonly ownerRef: Hash;
  readonly sourcePlanRef: Hash;
  readonly familyDefinitionHash: Hash;
  readonly executionRoot: Hash;
  readonly evidenceRoot: Hash;
  readonly resultPartitionRoot: Hash;
  readonly executionArtifactRefId: Hash;
  readonly executionContentSha256: Hash;
  readonly evidenceArtifactRefId: Hash;
  readonly evidenceContentSha256: Hash;
  readonly physicalObservations: readonly FullFamilyRawPhysicalObservationBindingV1[];
}

/** Read-only projection returned by the branded generated runtime factory metadata reader. */
export interface FullFamilyGeneratedRuntimeMetadataV1 {
  readonly releaseIntentRoot: Hash;
  readonly definitionCatalogRoot: Hash;
  readonly descriptorRoot: Hash;
  readonly families: readonly Readonly<{
    readonly familyId: string;
    readonly familyDefinitionHash: Hash;
    readonly sourcePlanRoot: Hash;
    readonly sourcePlanRefs: readonly SourcePlanRefV1[];
  }>[];
}

export interface FullFamilySourceCoverageBindingV1 {
  readonly artifactRefId: Hash;
  readonly contentSha256: Hash;
  readonly artifact: FullFamilySourceCoverageArtifactV1;
}

export interface FamilyEvidenceItemV1 {
  readonly familyId: string;
  readonly itemId: Hash;
  readonly subjectKey: Hash;
  readonly evidenceArtifactRefId: Hash;
  readonly evidenceContentSha256: Hash;
}

export interface FamilyOutcomeItemV1 {
  readonly familyId: string;
  readonly itemId: Hash;
  readonly candidateKey: Hash;
  readonly instanceKey: Hash | null;
  readonly outcome: FamilyCandidateOutcomeV1;
  readonly evidenceArtifactRefId: Hash;
  readonly evidenceContentSha256: Hash;
}

export interface FamilyEvidencePartitionV1 {
  readonly count: string;
  readonly root: Hash;
  readonly items: readonly FamilyEvidenceItemV1[];
}

export interface FamilyOutcomePartitionV1 {
  readonly count: string;
  readonly root: Hash;
  readonly items: readonly FamilyOutcomeItemV1[];
}

export type FullFamilyPartitionRoleV1 =
  | "source-plans"
  | "universe-candidates"
  | "outcomes"
  | "instance-publications"
  | "projected-edges"
  | "declared-coarse-capabilities"
  | "coarse-rankable"
  | "coarse-unavailable"
  | "unranked-admissions"
  | "declared-exact-capabilities"
  | "owned-actions";

export interface FullFamilyArtifactDigestV1 {
  readonly artifactRefId: Hash;
  readonly contentSha256: Hash;
}

/** One generic storage index is shared by every Full-Family partition.  The
 * business artifact bytes remain independent content objects; pages only
 * preserve their exact ordered semantic refs. */
export interface FullFamilyArtifactRefPageV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.full-family-artifact-ref-page-v1";
  readonly refs: readonly FullFamilyArtifactDigestV1[];
  readonly nextPageRef: FullFamilyArtifactDigestV1 | null;
}

export interface FullFamilyArtifactRefIndexV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.full-family-artifact-ref-index-v1";
  readonly pageCount: string;
  readonly firstPageRef: FullFamilyArtifactDigestV1 | null;
}

export interface FullFamilyStoredPartitionV1 {
  readonly count: string;
  readonly root: Hash;
  readonly indexArtifactRefId: Hash;
  readonly indexContentSha256: Hash;
}

export interface FamilyReleaseEntryV1 {
  readonly familyId: string;
  readonly familyDefinitionHash: Hash;
  readonly entryHash: Hash;
}

export interface FamilyReleaseSetV1 {
  readonly sourceArtifactRefId: Hash;
  readonly sourceArtifactContentSha256: Hash;
  readonly contractRoot: Hash;
  readonly count: string;
  readonly entrySetRoot: Hash;
  readonly entries: readonly FamilyReleaseEntryV1[];
}

export interface FullFamilyRuntimeBindingV1 {
  readonly generationId: Hash;
  readonly releaseBindingId: Hash;
  readonly readyCutoff: CanonicalCutoffV1;
  readonly readyCutoffRoot: Hash;
  readonly actualCurrentSource: CanonicalCutoffV1;
  readonly actualCurrentSourceRoot: Hash;
  readonly recentObservationStartBlock: string;
  readonly recentObservationEndBlock: string;
  readonly recentObservationBlockCount: "50";
  readonly releaseIntentRoot: Hash;
  readonly definitionCatalogRoot: Hash;
  readonly generatedRuntimeDescriptorRoot: Hash;
  readonly runtimeCompositionRoot: Hash;
  readonly sourceCoverageRoot: Hash;
  readonly candidatePartitionRoot: Hash;
  readonly nominationClosureRoot: Hash;
  readonly nominationClosureStorageHash: Hash;
  readonly candidatePartitionStorageHash: Hash;
  readonly candidatePartitionProofStorageHash: Hash;
  readonly releaseProvenanceHash: Hash;
  readonly instanceCatalogRoot: Hash;
  readonly graphRoot: Hash;
  readonly readyRecordHash: Hash;
  readonly instanceCount: string;
  readonly edgeCount: string;
  readonly readyRecordArtifactRefId: Hash;
  readonly readyRecordContentSha256: Hash;
}

/** Exact canonical head projection retained by the promotion freshness fact. */
export interface FullFamilyCanonicalHeaderV1 extends CanonicalCutoffV1 {
  readonly parentHash: Hash;
}

export interface FullFamilyPromotionFreshnessReceiptV1 {
  readonly cutoff: CanonicalCutoffV1;
  readonly observedHead: FullFamilyCanonicalHeaderV1;
  readonly observedAgeBlocks: string;
  readonly maxPromotionAgeBlocks: string;
  readonly generationRefreshPolicyHash: Hash;
  readonly journalEpoch: string;
  readonly canonicalJournalRoot: Hash;
  readonly freshnessReceiptHash: Hash;
}

/** Neutral wire projection of the durable ReadyGeneration record. */
export interface FullFamilyReadyRecordV1 {
  readonly generationId: Hash;
  readonly parentGenerationId: Hash | null;
  readonly generationRefreshPolicyHash: Hash;
  readonly cutoff: CanonicalCutoffV1;
  readonly recentObservationRange: Readonly<{ readonly from: string; readonly to: string }>;
  readonly definitionCatalogRoot: Hash;
  readonly sourceCoverageRoot: Hash;
  readonly candidatePartitionRoot: Hash;
  readonly nominationClosureRoot: Hash;
  readonly nominationClosureStorageHash: Hash;
  readonly candidatePartitionProofStorageHash: Hash;
  readonly releaseProvenanceHash: Hash;
  readonly exactOutcomePartitionRoot: Hash;
  readonly verifiedMemoSetRoot: Hash;
  readonly instanceCatalogRoot: Hash;
  readonly graphRoot: Hash;
  readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
  readonly edgeCount: string;
  readonly instanceCount: string;
  readonly promotionFreshness: FullFamilyPromotionFreshnessReceiptV1;
  readonly promotionRevision: string;
  readonly promotedAtMonotonicNs: string;
  readonly readyRecordHash: Hash;
}

export interface FullFamilyLineageArtifactBindingV1<T> {
  readonly artifactRefId: Hash;
  readonly contentSha256: Hash;
  readonly artifact: T;
}

export interface FullFamilyStoredLineageArtifactBindingV1<T> extends FullFamilyLineageArtifactBindingV1<T> {
  readonly storageHash: Hash;
}

export interface FullFamilyLineageV1 {
  readonly nominationClosure: FullFamilyStoredLineageArtifactBindingV1<NominationClosureV1>;
  readonly candidatePartitionProof: FullFamilyStoredLineageArtifactBindingV1<CandidatePartitionProofV1>;
  readonly candidateProofVerifierBinding: FullFamilyLineageArtifactBindingV1<FullFamilyCandidateProofVerifierBindingV1>;
}

export interface FullFamilyMatrixEntryV1 {
  readonly familyId: string;
  readonly familyDefinitionHash: Hash;
  readonly sourcePlanRoot: Hash;
  readonly sourcePlans: FamilyEvidencePartitionV1;
  readonly candidatePartition: FamilyNominationPartitionV1;
  readonly universeCandidates: FamilyEvidencePartitionV1;
  readonly outcomes: FamilyOutcomePartitionV1;
  readonly instancePublications: FamilyEvidencePartitionV1;
  readonly projectedEdges: FamilyEvidencePartitionV1;
  readonly declaredCoarseCapabilities: FamilyEvidencePartitionV1;
  readonly coarseRankable: FamilyEvidencePartitionV1;
  readonly coarseUnavailable: FamilyEvidencePartitionV1;
  readonly unrankedAdmissions: FamilyEvidencePartitionV1;
  readonly declaredExactCapabilities: FamilyEvidencePartitionV1;
  readonly ownedActions: FamilyEvidencePartitionV1;
  readonly entryHash: Hash;
}

export interface FullFamilyFactBundleV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.full-family-facts";
  readonly runtime: FullFamilyRuntimeBindingV1;
  readonly releaseIntent: FamilyReleaseSetV1;
  readonly definitionCatalog: FamilyReleaseSetV1;
  readonly runtimeComposition: FamilyReleaseSetV1;
  readonly sourceCoverage: FullFamilySourceCoverageBindingV1;
  readonly lineage: FullFamilyLineageV1;
  readonly familyMatrixCount: string;
  readonly familyMatrixRoot: Hash;
  readonly universeMatrixRoot: Hash;
  readonly instanceMatrixRoot: Hash;
  readonly edgeMatrixRoot: Hash;
  readonly families: readonly FullFamilyMatrixEntryV1[];
}

export interface FullFamilyStoredSourceCoverageBindingV1 {
  readonly artifactRefId: Hash;
  readonly contentSha256: Hash;
}

export interface FullFamilyStoredLineageV1 {
  readonly nominationClosure: Omit<FullFamilyStoredLineageArtifactBindingV1<NominationClosureV1>, "artifact">;
  readonly candidatePartitionProof: Omit<FullFamilyStoredLineageArtifactBindingV1<CandidatePartitionProofV1>, "artifact">;
  readonly candidateProofVerifierBinding: Omit<FullFamilyLineageArtifactBindingV1<FullFamilyCandidateProofVerifierBindingV1>, "artifact">;
}

export interface FullFamilyStoredMatrixEntryV1 {
  readonly familyId: string;
  readonly familyDefinitionHash: Hash;
  readonly sourcePlanRoot: Hash;
  readonly candidateCount: string;
  readonly candidateSetRoot: Hash;
  readonly sourcePlans: FullFamilyStoredPartitionV1;
  readonly universeCandidates: FullFamilyStoredPartitionV1;
  readonly outcomes: FullFamilyStoredPartitionV1;
  readonly instancePublications: FullFamilyStoredPartitionV1;
  readonly projectedEdges: FullFamilyStoredPartitionV1;
  readonly declaredCoarseCapabilities: FullFamilyStoredPartitionV1;
  readonly coarseRankable: FullFamilyStoredPartitionV1;
  readonly coarseUnavailable: FullFamilyStoredPartitionV1;
  readonly unrankedAdmissions: FullFamilyStoredPartitionV1;
  readonly declaredExactCapabilities: FullFamilyStoredPartitionV1;
  readonly ownedActions: FullFamilyStoredPartitionV1;
  readonly entryHash: Hash;
}

/** Bounded wire form.  The existing FullFamilyFactBundleV1 remains the
 * materialized semantic view used by the predicate after it follows every
 * index page and independently decodes every referenced item artifact. */
export interface FullFamilyFactBundleStorageV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.full-family-facts-storage-v1";
  readonly runtime: FullFamilyRuntimeBindingV1;
  readonly releaseIntent: FamilyReleaseSetV1;
  readonly definitionCatalog: FamilyReleaseSetV1;
  readonly runtimeComposition: FamilyReleaseSetV1;
  readonly sourceCoverage: FullFamilyStoredSourceCoverageBindingV1;
  readonly lineage: FullFamilyStoredLineageV1;
  readonly familyMatrixCount: string;
  readonly familyMatrixRoot: Hash;
  readonly universeMatrixRoot: Hash;
  readonly instanceMatrixRoot: Hash;
  readonly edgeMatrixRoot: Hash;
  readonly families: readonly FullFamilyStoredMatrixEntryV1[];
}

export interface FullFamilyFactLocatorV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.full-family-fact-locator";
  readonly bundleArtifactRefId: Hash;
  readonly bundleContentSha256: Hash;
}

export interface FamilyReleaseSetDraftV1 {
  readonly sourceArtifactRefId: Hash;
  readonly sourceArtifactContentSha256: Hash;
  readonly contractRoot: Hash;
  readonly entries: readonly Omit<FamilyReleaseEntryV1, "entryHash">[];
}

export interface FullFamilyFactBundleDraftV1 {
  readonly runtime: FullFamilyRuntimeBindingV1;
  readonly releaseIntent: FamilyReleaseSetDraftV1;
  readonly definitionCatalog: FamilyReleaseSetDraftV1;
  readonly runtimeComposition: FamilyReleaseSetDraftV1;
  readonly sourceCoverage: FullFamilySourceCoverageBindingV1;
  readonly lineage: FullFamilyLineageV1;
  readonly families: readonly FullFamilyMatrixEntryV1[];
}

const ZERO_HASH = `0x${"0".repeat(64)}` as Hash;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseInput(value: FullFamilyFactsCodecInput): unknown {
  if (typeof value === "string") return decodeCanonicalJson(value);
  if (ArrayBuffer.isView(value)) return decodeCanonicalJson(value as Uint8Array);
  return value;
}

function positiveHash(value: unknown, path: string): Hash {
  const result = assertHash(value, path);
  if (result === ZERO_HASH) throw new TypeError(`zero hash at ${path}`);
  return result;
}

function nullableHash(value: unknown, path: string): Hash | null {
  return value === null ? null : positiveHash(value, path);
}

function exactLiteral<T extends string | number>(value: unknown, literal: T, path: string): T {
  if (value !== literal) throw new TypeError(`expected ${String(literal)} at ${path}`);
  return literal;
}

function decodeCandidateOutcome(value: unknown, path: string): FamilyCandidateOutcomeV1 {
  if (!(FAMILY_CANDIDATE_OUTCOMES as readonly unknown[]).includes(value)) {
    throw new TypeError(`unknown outcome at ${path}`);
  }
  return value as FamilyCandidateOutcomeV1;
}

function canonicalRecord<T extends object>(value: unknown, path: string): T {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`expected object at ${path}`);
  }
  return decodeCanonicalJson(encodeCanonicalJson(value)) as T;
}

export function deriveFullFamilyOutcomeSummary(
  candidate: CandidateRecordV1,
  rawOutcome: CandidateFinalOutcomeWireV1,
): Readonly<{
  readonly candidateKey: Hash;
  readonly instanceKey: Hash | null;
  readonly outcome: FamilyCandidateOutcomeV1;
}> {
  const candidateKey = positiveHash(candidate.familyCandidateKey, "fullFamilyOutcomeArtifact.candidate.familyCandidateKey");
  switch (rawOutcome.kind) {
    case "verified":
      return deepFreeze({
        candidateKey,
        instanceKey: hashDomain("aloha/full-family/instance-identity-ref/v1", {
          familyDefinitionHash: candidate.familyDefinitionHash,
          instanceKey: assertNonEmptyString(rawOutcome.instanceKey, "fullFamilyOutcomeArtifact.rawOutcome.instanceKey"),
        }),
        outcome: "verified" as const,
      });
    case "chainProvenRejected":
      return deepFreeze({ candidateKey, instanceKey: null, outcome: "chain-proven-rejected" as const });
    case "retryable":
      return deepFreeze({ candidateKey, instanceKey: null, outcome: "retryable" as const });
    case "invalidProgram":
      return deepFreeze({ candidateKey, instanceKey: null, outcome: "invalid-program" as const });
    default:
      throw new TypeError("unknown raw candidate outcome kind");
  }
}

function decodeEvidenceRole(value: unknown, path: string): FullFamilyEvidenceRoleV1 {
  if (!(FULL_FAMILY_EVIDENCE_ROLES as readonly unknown[]).includes(value)) {
    throw new TypeError(`unknown full-family evidence role at ${path}`);
  }
  return value as FullFamilyEvidenceRoleV1;
}

function strictSortedUnique(values: readonly string[], path: string): void {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1]! >= values[index]!) throw new TypeError(`non-canonical or duplicate identity at ${path}`);
  }
}

function sourceBindingIdentity(value: Pick<SourcePlanRefV1, "ownerRef" | "sourcePlanRef">): Hash {
  return hashDomain("aloha/source-plan-identity/v1", {
    ownerRef: value.ownerRef,
    sourcePlanRef: value.sourcePlanRef,
  });
}

function decodeEvidenceItem(value: unknown, path: string): FamilyEvidenceItemV1 {
  return decodeExactObject(value, {
    familyId: (field, itemPath) => assertNonEmptyString(field, itemPath),
    itemId: (field, itemPath) => positiveHash(field, itemPath),
    subjectKey: (field, itemPath) => positiveHash(field, itemPath),
    evidenceArtifactRefId: (field, itemPath) => positiveHash(field, itemPath),
    evidenceContentSha256: (field, itemPath) => positiveHash(field, itemPath),
  }, path);
}

function decodeOutcomeItem(value: unknown, path: string): FamilyOutcomeItemV1 {
  return decodeExactObject(value, {
    familyId: (field, itemPath) => assertNonEmptyString(field, itemPath),
    itemId: (field, itemPath) => positiveHash(field, itemPath),
    candidateKey: (field, itemPath) => positiveHash(field, itemPath),
    instanceKey: (field, itemPath) => nullableHash(field, itemPath),
    outcome: (field, itemPath) => decodeCandidateOutcome(field, itemPath),
    evidenceArtifactRefId: (field, itemPath) => positiveHash(field, itemPath),
    evidenceContentSha256: (field, itemPath) => positiveHash(field, itemPath),
  }, path);
}

export function decodeFullFamilyEvidenceArtifact(
  value: FullFamilyFactsCodecInput,
): FullFamilyEvidenceArtifactV1 {
  return deepFreeze(decodeExactObject(parseInput(value), {
    schemaVersion: (field, path) => exactLiteral(field, 1, path),
    kind: (field, path) => exactLiteral(field, "aloha.full-family-evidence-artifact", path),
    readyRecordHash: (field, path) => positiveHash(field, path),
    role: (field, path) => decodeEvidenceRole(field, path),
    familyId: (field, path) => assertNonEmptyString(field, path),
    itemId: (field, path) => positiveHash(field, path),
    subjectKey: (field, path) => positiveHash(field, path),
  }, "fullFamilyEvidenceArtifact"));
}

export function encodeFullFamilyEvidenceArtifact(value: FullFamilyEvidenceArtifactV1): Uint8Array {
  return encodeCanonicalBytes(decodeFullFamilyEvidenceArtifact(value));
}

export function decodeFullFamilyOutcomeArtifact(
  value: FullFamilyFactsCodecInput,
): FullFamilyOutcomeArtifactV1 {
  const decoded = decodeExactObject(parseInput(value), {
    schemaVersion: (field, path) => exactLiteral(field, 2, path),
    kind: (field, path) => exactLiteral(field, "aloha.full-family-outcome-artifact", path),
    readyRecordHash: (field, path) => positiveHash(field, path),
    familyId: (field, path) => assertNonEmptyString(field, path),
    itemId: (field, path) => positiveHash(field, path),
    runId: (field, path) => assertNonEmptyString(field, path),
    cutoff: (field, path) => decodeFullFamilyCanonicalCutoff(field, path),
    candidatePartitionRoot: (field, path) => positiveHash(field, path),
    exactOutcomePartitionRoot: (field, path) => positiveHash(field, path),
    candidate: (field, path) => canonicalRecord<CandidateRecordV1>(field, path),
    rawOutcome: (field, path) => canonicalRecord<CandidateFinalOutcomeWireV1>(field, path),
    candidateKey: (field, path) => positiveHash(field, path),
    instanceKey: (field, path) => nullableHash(field, path),
    outcome: (field, path) => decodeCandidateOutcome(field, path),
  }, "fullFamilyOutcomeArtifact");
  const summary = deriveFullFamilyOutcomeSummary(decoded.candidate, decoded.rawOutcome);
  if (decoded.candidate.familyId !== decoded.familyId
    || decoded.rawOutcome.familyCandidateKey !== decoded.candidate.familyCandidateKey
    || decoded.candidateKey !== summary.candidateKey
    || decoded.instanceKey !== summary.instanceKey
    || decoded.outcome !== summary.outcome) {
    throw new TypeError("fullFamilyOutcomeArtifact summary/raw mismatch");
  }
  return deepFreeze(decoded);
}

export function encodeFullFamilyOutcomeArtifact(value: FullFamilyOutcomeArtifactV1): Uint8Array {
  return encodeCanonicalBytes(decodeFullFamilyOutcomeArtifact(value));
}

function decodeEvidencePartition(value: unknown, path: string): FamilyEvidencePartitionV1 {
  const decoded = decodeExactObject(value, {
    count: (field, itemPath) => assertDecimalString(field, itemPath),
    root: (field, itemPath) => positiveHash(field, itemPath),
    items: (field, itemPath) => fieldArray(field, (item, entryPath) => decodeEvidenceItem(item, entryPath), itemPath),
  }, path);
  strictSortedUnique(decoded.items.map(item => item.itemId), `${path}.items`);
  if (decoded.count !== String(decoded.items.length)) throw new TypeError(`partition count mismatch at ${path}.count`);
  if (decoded.root !== hashFamilyEvidencePartition(decoded.items)) throw new TypeError(`partition root mismatch at ${path}.root`);
  return decoded;
}

function decodeOutcomePartition(value: unknown, path: string): FamilyOutcomePartitionV1 {
  const decoded = decodeExactObject(value, {
    count: (field, itemPath) => assertDecimalString(field, itemPath),
    root: (field, itemPath) => positiveHash(field, itemPath),
    items: (field, itemPath) => fieldArray(field, (item, entryPath) => decodeOutcomeItem(item, entryPath), itemPath),
  }, path);
  strictSortedUnique(decoded.items.map(item => item.itemId), `${path}.items`);
  strictSortedUnique([...decoded.items].sort((a, b) => compareText(a.candidateKey, b.candidateKey)).map(item => item.candidateKey), `${path}.candidateKeys`);
  if (decoded.count !== String(decoded.items.length)) throw new TypeError(`outcome count mismatch at ${path}.count`);
  if (decoded.root !== hashFamilyOutcomePartition(decoded.items)) throw new TypeError(`outcome root mismatch at ${path}.root`);
  return decoded;
}

const FULL_FAMILY_PARTITION_ROLES = Object.freeze([
  "source-plans",
  "universe-candidates",
  "outcomes",
  "instance-publications",
  "projected-edges",
  "declared-coarse-capabilities",
  "coarse-rankable",
  "coarse-unavailable",
  "unranked-admissions",
  "declared-exact-capabilities",
  "owned-actions",
] as const);

function decodePartitionRole(value: unknown, path: string): FullFamilyPartitionRoleV1 {
  if (typeof value !== "string" || !FULL_FAMILY_PARTITION_ROLES.includes(value as FullFamilyPartitionRoleV1)) {
    throw new TypeError(`unknown Full-Family partition role at ${path}`);
  }
  return value as FullFamilyPartitionRoleV1;
}

function decodeArtifactDigest(value: unknown, path: string): FullFamilyArtifactDigestV1 {
  return decodeExactObject(value, {
    artifactRefId: (field, itemPath) => positiveHash(field, itemPath),
    contentSha256: (field, itemPath) => positiveHash(field, itemPath),
  }, path);
}

function nullableArtifactDigest(value: unknown, path: string): FullFamilyArtifactDigestV1 | null {
  return value === null ? null : decodeArtifactDigest(value, path);
}

export function sealFullFamilyArtifactRefPageV1(
  input: Omit<FullFamilyArtifactRefPageV1, "schemaVersion" | "kind">,
): FullFamilyArtifactRefPageV1 {
  const refs = input.refs.map((ref, index) => decodeArtifactDigest(ref, `artifactRefPage.refs[${index}]`));
  if (refs.length === 0 || refs.length > 128) throw new TypeError("Full-Family artifact ref page size must be 1..128");
  const value = {
    schemaVersion: 1 as const,
    kind: "aloha.full-family-artifact-ref-page-v1" as const,
    refs: deepFreeze(refs),
    nextPageRef: input.nextPageRef === null ? null : decodeArtifactDigest(input.nextPageRef, "artifactRefPage.nextPageRef"),
  };
  return deepFreeze(value);
}

export function decodeFullFamilyArtifactRefPageV1(value: FullFamilyFactsCodecInput): FullFamilyArtifactRefPageV1 {
  const decoded = decodeExactObject(parseInput(value), {
    schemaVersion: (field, path) => exactLiteral(field, 1, path),
    kind: (field, path) => exactLiteral(field, "aloha.full-family-artifact-ref-page-v1", path),
    refs: (field, path) => fieldArray(field, (item, itemPath) => decodeArtifactDigest(item, itemPath), path),
    nextPageRef: (field, path) => nullableArtifactDigest(field, path),
  });
  return sealFullFamilyArtifactRefPageV1(decoded);
}

export function encodeFullFamilyArtifactRefPageV1(value: FullFamilyArtifactRefPageV1): Uint8Array {
  return encodeCanonicalBytes(decodeFullFamilyArtifactRefPageV1(value));
}

export function sealFullFamilyArtifactRefIndexV1(
  input: Omit<FullFamilyArtifactRefIndexV1, "schemaVersion" | "kind">,
): FullFamilyArtifactRefIndexV1 {
  const pageCount = assertDecimalString(input.pageCount, "artifactRefIndex.pageCount");
  if ((pageCount === "0") !== (input.firstPageRef === null)) throw new TypeError("Full-Family ref index empty mismatch");
  const value = {
    schemaVersion: 1 as const,
    kind: "aloha.full-family-artifact-ref-index-v1" as const,
    pageCount,
    firstPageRef: input.firstPageRef === null ? null : decodeArtifactDigest(input.firstPageRef, "artifactRefIndex.firstPageRef"),
  };
  return deepFreeze(value);
}

export function decodeFullFamilyArtifactRefIndexV1(value: FullFamilyFactsCodecInput): FullFamilyArtifactRefIndexV1 {
  const decoded = decodeExactObject(parseInput(value), {
    schemaVersion: (field, path) => exactLiteral(field, 1, path),
    kind: (field, path) => exactLiteral(field, "aloha.full-family-artifact-ref-index-v1", path),
    pageCount: (field, path) => assertDecimalString(field, path),
    firstPageRef: (field, path) => nullableArtifactDigest(field, path),
  });
  return sealFullFamilyArtifactRefIndexV1(decoded);
}

export function encodeFullFamilyArtifactRefIndexV1(value: FullFamilyArtifactRefIndexV1): Uint8Array {
  return encodeCanonicalBytes(decodeFullFamilyArtifactRefIndexV1(value));
}

function decodeReleaseEntry(value: unknown, path: string): FamilyReleaseEntryV1 {
  const decoded = decodeExactObject(value, {
    familyId: (field, itemPath) => assertNonEmptyString(field, itemPath),
    familyDefinitionHash: (field, itemPath) => positiveHash(field, itemPath),
    entryHash: (field, itemPath) => positiveHash(field, itemPath),
  }, path);
  if (decoded.entryHash !== hashFamilyReleaseEntry(decoded.familyId, decoded.familyDefinitionHash)) throw new TypeError(`release entry hash mismatch at ${path}.entryHash`);
  return decoded;
}

function decodeReleaseSet(value: unknown, path: string): FamilyReleaseSetV1 {
  const decoded = decodeExactObject(value, {
    sourceArtifactRefId: (field, itemPath) => positiveHash(field, itemPath),
    sourceArtifactContentSha256: (field, itemPath) => positiveHash(field, itemPath),
    contractRoot: (field, itemPath) => positiveHash(field, itemPath),
    count: (field, itemPath) => assertDecimalString(field, itemPath),
    entrySetRoot: (field, itemPath) => positiveHash(field, itemPath),
    entries: (field, itemPath) => fieldArray(field, (item, entryPath) => decodeReleaseEntry(item, entryPath), itemPath),
  }, path);
  strictSortedUnique(decoded.entries.map(entry => entry.familyId), `${path}.entries`);
  if (decoded.count !== String(decoded.entries.length)) throw new TypeError(`release set count mismatch at ${path}.count`);
  if (decoded.entrySetRoot !== hashFamilyReleaseSet(decoded.entries)) throw new TypeError(`release set root mismatch at ${path}.entrySetRoot`);
  return decoded;
}

export function decodeFullFamilyReleaseProjectionArtifact(
  value: FullFamilyFactsCodecInput,
): FullFamilyReleaseProjectionArtifactV1 {
  const decoded = decodeExactObject(parseInput(value), {
    schemaVersion: (field, path) => exactLiteral(field, 1, path),
    kind: (field, path) => exactLiteral(field, "aloha.full-family-release-projection-artifact", path),
    role: (field, path) => {
      if (field !== "definition-catalog" && field !== "runtime-composition") {
        throw new TypeError(`unknown release projection role at ${path}`);
      }
      return field;
    },
    contractRoot: (field, path) => positiveHash(field, path),
    count: (field, path) => assertDecimalString(field, path),
    entrySetRoot: (field, path) => positiveHash(field, path),
    entries: (field, path) => fieldArray(field, (item, itemPath) => decodeReleaseEntry(item, itemPath), path),
  }, "fullFamilyReleaseProjectionArtifact");
  strictSortedUnique(decoded.entries.map(entry => entry.familyId), "fullFamilyReleaseProjectionArtifact.entries");
  if (decoded.count !== String(decoded.entries.length)) throw new TypeError("release projection count mismatch");
  if (decoded.entrySetRoot !== hashFamilyReleaseSet(decoded.entries)) throw new TypeError("release projection root mismatch");
  return deepFreeze(decoded);
}

export function encodeFullFamilyReleaseProjectionArtifact(
  value: FullFamilyReleaseProjectionArtifactV1,
): Uint8Array {
  return encodeCanonicalBytes(decodeFullFamilyReleaseProjectionArtifact(value));
}

export function decodeFullFamilySourceCoverageArtifact(
  value: FullFamilyFactsCodecInput,
): FullFamilySourceCoverageArtifactV1 {
  const decoded = decodeExactObject(parseInput(value), {
    schemaVersion: (field, path) => exactLiteral(field, 1, path),
    kind: (field, path) => exactLiteral(field, "aloha.full-family-source-coverage-artifact", path),
    readyRecordHash: (field, path) => positiveHash(field, path),
    cutoff: (field, path) => decodeFullFamilyCanonicalCutoff(field, path),
    executions: (field, path) => fieldArray(field, (binding, bindingPath) => decodeSourceExecutionBinding(binding, bindingPath), path),
    sourceCoverage: field => field as SourceCoverageCertificateV1,
  }, "fullFamilySourceCoverageArtifact");
  strictSortedUnique(decoded.executions.map(sourceBindingIdentity), "fullFamilySourceCoverageArtifact.executions");
  if (!sameCutoff(decoded.cutoff, decoded.sourceCoverage.cutoff)) {
    throw new TypeError("source coverage artifact cutoff mismatch");
  }
  return deepFreeze(decoded);
}

function decodePhysicalObservationBinding(value: unknown, path: string): FullFamilyRawPhysicalObservationBindingV1 {
  const decoded = decodeExactObject(value, {
    rawLocatorHash: (field, itemPath) => positiveHash(field, itemPath),
    artifactRefId: (field, itemPath) => positiveHash(field, itemPath),
    contentSha256: (field, itemPath) => positiveHash(field, itemPath),
  }, path);
  if (decoded.rawLocatorHash !== decoded.contentSha256) throw new TypeError(`physical observation locator/content mismatch at ${path}`);
  return decoded;
}

function decodeSourceExecutionBinding(value: unknown, path: string): FullFamilySourcePlanExecutionBindingV1 {
  const decoded = decodeExactObject(value, {
    ownerRef: (field, itemPath) => positiveHash(field, itemPath),
    sourcePlanRef: (field, itemPath) => positiveHash(field, itemPath),
    familyDefinitionHash: (field, itemPath) => positiveHash(field, itemPath),
    executionRoot: (field, itemPath) => positiveHash(field, itemPath),
    evidenceRoot: (field, itemPath) => positiveHash(field, itemPath),
    resultPartitionRoot: (field, itemPath) => positiveHash(field, itemPath),
    executionArtifactRefId: (field, itemPath) => positiveHash(field, itemPath),
    executionContentSha256: (field, itemPath) => positiveHash(field, itemPath),
    evidenceArtifactRefId: (field, itemPath) => positiveHash(field, itemPath),
    evidenceContentSha256: (field, itemPath) => positiveHash(field, itemPath),
    physicalObservations: (field, itemPath) => fieldArray(field, (item, observationPath) => decodePhysicalObservationBinding(item, observationPath), itemPath),
  }, path);
  strictSortedUnique(decoded.physicalObservations.map(item => item.rawLocatorHash), `${path}.physicalObservations`);
  return decoded;
}

export function encodeFullFamilySourceCoverageArtifact(
  value: FullFamilySourceCoverageArtifactV1,
): Uint8Array {
  return encodeCanonicalBytes(decodeFullFamilySourceCoverageArtifact(value));
}

function decodeSourceCoverageBinding(value: unknown, path: string): FullFamilySourceCoverageBindingV1 {
  return decodeExactObject(value, {
    artifactRefId: (field, itemPath) => positiveHash(field, itemPath),
    contentSha256: (field, itemPath) => positiveHash(field, itemPath),
    artifact: field => decodeFullFamilySourceCoverageArtifact(field as object),
  }, path);
}

function decodeCandidateProofVerifierBinding(
  value: unknown,
  path: string,
): FullFamilyCandidateProofVerifierBindingV1 {
  return decodeExactObject(value, {
    schemaVersion: (field, itemPath) => exactLiteral(field, 1, itemPath),
    kind: (field, itemPath) => exactLiteral(field, "aloha.full-family-candidate-proof-verifier-binding", itemPath),
    runtimeBindingId: (field, itemPath) => positiveHash(field, itemPath),
    releaseProvenanceHash: (field, itemPath) => positiveHash(field, itemPath),
    releaseAuthorityRoot: (field, itemPath) => positiveHash(field, itemPath),
    candidateReleaseCommit: (field, itemPath) => {
      if (typeof field !== "string" || !/^[0-9a-f]{40}$/.test(field) || field === "0".repeat(40)) {
        throw new TypeError(`expected non-zero lowercase git commit at ${itemPath}`);
      }
      return field;
    },
    proofKeyId: (field, itemPath) => positiveHash(field, itemPath),
    proofPublicKeyHex: (field, itemPath) => {
      if (typeof field !== "string" || !/^0x[0-9a-f]{64}$/.test(field)) {
        throw new TypeError(`expected lowercase Ed25519 public key at ${itemPath}`);
      }
      return field as `0x${string}`;
    },
  }, path);
}

export function decodeFullFamilyCandidateProofVerifierBinding(
  value: FullFamilyFactsCodecInput,
): FullFamilyCandidateProofVerifierBindingV1 {
  return deepFreeze(decodeCandidateProofVerifierBinding(parseInput(value), "candidateProofVerifierBinding"));
}

export function encodeFullFamilyCandidateProofVerifierBinding(
  value: FullFamilyCandidateProofVerifierBindingV1,
): Uint8Array {
  return encodeCanonicalBytes(decodeFullFamilyCandidateProofVerifierBinding(value));
}

function decodeLineageBinding<T>(
  value: unknown,
  decode: (artifact: unknown) => T,
  path: string,
): FullFamilyLineageArtifactBindingV1<T> {
  return decodeExactObject(value, {
    artifactRefId: (field, itemPath) => positiveHash(field, itemPath),
    contentSha256: (field, itemPath) => positiveHash(field, itemPath),
    artifact: field => decode(field),
  }, path);
}

function decodeStoredLineageBinding<T>(
  value: unknown,
  decode: (artifact: unknown) => T,
  path: string,
): FullFamilyStoredLineageArtifactBindingV1<T> {
  return decodeExactObject(value, {
    artifactRefId: (field, itemPath) => positiveHash(field, itemPath),
    contentSha256: (field, itemPath) => positiveHash(field, itemPath),
    storageHash: (field, itemPath) => positiveHash(field, itemPath),
    artifact: field => decode(field),
  }, path);
}

function decodeLineage(value: unknown, path: string): FullFamilyLineageV1 {
  return decodeExactObject(value, {
    nominationClosure: (field, itemPath) => decodeStoredLineageBinding(field, decodeNominationClosureV1, itemPath),
    candidatePartitionProof: (field, itemPath) => decodeStoredLineageBinding(field, decodeCandidatePartitionProofV1, itemPath),
    candidateProofVerifierBinding: (field, itemPath) => decodeLineageBinding(field, artifact => decodeCandidateProofVerifierBinding(artifact, itemPath), itemPath),
  }, path);
}

export function hashFullFamilyCutoff(cutoff: CanonicalCutoffV1): Hash {
  return hashDomain("aloha/full-family/cutoff/v1", decodeFullFamilyCanonicalCutoff(cutoff));
}

export function hashFullFamilyReadyCutoff(cutoff: CanonicalCutoffV1): Hash {
  return hashDomain("aloha/full-family/ready-cutoff/v1", decodeFullFamilyCanonicalCutoff(cutoff));
}

export function hashFullFamilyActualCurrentSource(source: CanonicalCutoffV1): Hash {
  return hashDomain("aloha/full-family/actual-current-source/v1", decodeFullFamilyCanonicalCutoff(source));
}

function decodeRuntimeBinding(value: unknown, path: string): FullFamilyRuntimeBindingV1 {
  const decoded = decodeExactObject(value, {
    generationId: (field, itemPath) => positiveHash(field, itemPath),
    releaseBindingId: (field, itemPath) => positiveHash(field, itemPath),
    readyCutoff: (field, itemPath) => decodeFullFamilyCanonicalCutoff(field, itemPath),
    readyCutoffRoot: (field, itemPath) => positiveHash(field, itemPath),
    actualCurrentSource: (field, itemPath) => decodeFullFamilyCanonicalCutoff(field, itemPath),
    actualCurrentSourceRoot: (field, itemPath) => positiveHash(field, itemPath),
    recentObservationStartBlock: (field, itemPath) => assertDecimalString(field, itemPath),
    recentObservationEndBlock: (field, itemPath) => assertDecimalString(field, itemPath),
    recentObservationBlockCount: (field, itemPath) => exactLiteral(field, "50", itemPath),
    releaseIntentRoot: (field, itemPath) => positiveHash(field, itemPath),
    definitionCatalogRoot: (field, itemPath) => positiveHash(field, itemPath),
    generatedRuntimeDescriptorRoot: (field, itemPath) => positiveHash(field, itemPath),
    runtimeCompositionRoot: (field, itemPath) => positiveHash(field, itemPath),
    sourceCoverageRoot: (field, itemPath) => positiveHash(field, itemPath),
    candidatePartitionRoot: (field, itemPath) => positiveHash(field, itemPath),
    nominationClosureRoot: (field, itemPath) => positiveHash(field, itemPath),
    nominationClosureStorageHash: (field, itemPath) => positiveHash(field, itemPath),
    candidatePartitionStorageHash: (field, itemPath) => positiveHash(field, itemPath),
    candidatePartitionProofStorageHash: (field, itemPath) => positiveHash(field, itemPath),
    releaseProvenanceHash: (field, itemPath) => positiveHash(field, itemPath),
    instanceCatalogRoot: (field, itemPath) => positiveHash(field, itemPath),
    graphRoot: (field, itemPath) => positiveHash(field, itemPath),
    readyRecordHash: (field, itemPath) => positiveHash(field, itemPath),
    instanceCount: (field, itemPath) => assertDecimalString(field, itemPath),
    edgeCount: (field, itemPath) => assertDecimalString(field, itemPath),
    readyRecordArtifactRefId: (field, itemPath) => positiveHash(field, itemPath),
    readyRecordContentSha256: (field, itemPath) => positiveHash(field, itemPath),
  }, path);
  const start = BigInt(decoded.recentObservationStartBlock);
  const end = BigInt(decoded.recentObservationEndBlock);
  if (decoded.readyCutoffRoot !== hashFullFamilyReadyCutoff(decoded.readyCutoff)
    || decoded.actualCurrentSourceRoot !== hashFullFamilyActualCurrentSource(decoded.actualCurrentSource)
    || decoded.readyCutoff.chainId !== decoded.actualCurrentSource.chainId
    || BigInt(decoded.actualCurrentSource.number) < BigInt(decoded.readyCutoff.number)) {
    throw new TypeError(`ready/current source binding mismatch at ${path}`);
  }
  if (end !== BigInt(decoded.readyCutoff.number) || end - start !== 49n) throw new TypeError(`recent observation range is not readyCutoff-49..readyCutoff at ${path}`);
  return decoded;
}

function sameCutoff(left: CanonicalCutoffV1, right: CanonicalCutoffV1): boolean {
  return left.chainId === right.chainId
    && left.number === right.number
    && left.hash === right.hash
    && left.stateRoot === right.stateRoot;
}

function decodeCanonicalHeader(value: unknown, path: string): FullFamilyCanonicalHeaderV1 {
  return decodeExactObject(value, {
    chainId: (field, itemPath) => assertNonEmptyString(field, itemPath),
    number: (field, itemPath) => assertDecimalString(field, itemPath),
    hash: (field, itemPath) => assertHash(field, itemPath),
    parentHash: (field, itemPath) => assertHash(field, itemPath),
    stateRoot: (field, itemPath) => assertHash(field, itemPath),
  }, path);
}

function decodePromotionFreshness(value: unknown, path: string): FullFamilyPromotionFreshnessReceiptV1 {
  const decoded = decodeExactObject(value, {
    cutoff: (field, itemPath) => decodeFullFamilyCanonicalCutoff(field, itemPath),
    observedHead: (field, itemPath) => decodeCanonicalHeader(field, itemPath),
    observedAgeBlocks: (field, itemPath) => assertDecimalString(field, itemPath),
    maxPromotionAgeBlocks: (field, itemPath) => assertDecimalString(field, itemPath),
    generationRefreshPolicyHash: (field, itemPath) => positiveHash(field, itemPath),
    journalEpoch: (field, itemPath) => assertDecimalString(field, itemPath),
    canonicalJournalRoot: (field, itemPath) => positiveHash(field, itemPath),
    freshnessReceiptHash: (field, itemPath) => positiveHash(field, itemPath),
  }, path);
  if (decoded.cutoff.chainId !== decoded.observedHead.chainId) throw new TypeError(`freshness chain mismatch at ${path}`);
  const age = BigInt(decoded.observedHead.number) - BigInt(decoded.cutoff.number);
  if (age < 0n || age.toString() !== decoded.observedAgeBlocks || age > BigInt(decoded.maxPromotionAgeBlocks)) {
    throw new TypeError(`freshness age mismatch at ${path}`);
  }
  const payload = {
    cutoff: decoded.cutoff,
    observedHead: decoded.observedHead,
    observedAgeBlocks: decoded.observedAgeBlocks,
    maxPromotionAgeBlocks: decoded.maxPromotionAgeBlocks,
    generationRefreshPolicyHash: decoded.generationRefreshPolicyHash,
    journalEpoch: decoded.journalEpoch,
    canonicalJournalRoot: decoded.canonicalJournalRoot,
  };
  if (decoded.freshnessReceiptHash !== hashDomain("aloha/promotion-freshness-receipt/v1", payload)) {
    throw new TypeError(`freshness receipt hash mismatch at ${path}`);
  }
  return decoded;
}

export function decodeFullFamilyReadyRecord(value: FullFamilyFactsCodecInput): FullFamilyReadyRecordV1 {
  const decoded = decodeExactObject(parseInput(value), {
    generationId: (field, path) => positiveHash(field, path),
    parentGenerationId: (field, path) => nullableHash(field, path),
    generationRefreshPolicyHash: (field, path) => positiveHash(field, path),
    cutoff: (field, path) => decodeFullFamilyCanonicalCutoff(field, path),
    recentObservationRange: (field, path) => decodeExactObject(field, {
      from: (item, itemPath) => assertDecimalString(item, itemPath),
      to: (item, itemPath) => assertDecimalString(item, itemPath),
    }, path),
    definitionCatalogRoot: (field, path) => positiveHash(field, path),
    sourceCoverageRoot: (field, path) => positiveHash(field, path),
    candidatePartitionRoot: (field, path) => positiveHash(field, path),
    nominationClosureRoot: (field, path) => positiveHash(field, path),
    nominationClosureStorageHash: (field, path) => positiveHash(field, path),
    candidatePartitionProofStorageHash: (field, path) => positiveHash(field, path),
    releaseProvenanceHash: (field, path) => positiveHash(field, path),
    exactOutcomePartitionRoot: (field, path) => positiveHash(field, path),
    verifiedMemoSetRoot: (field, path) => positiveHash(field, path),
    instanceCatalogRoot: (field, path) => positiveHash(field, path),
    graphRoot: (field, path) => positiveHash(field, path),
    runtimeAuthority: (field) => decodeRuntimeAuthorityProjectionV1(field),
    edgeCount: (field, path) => assertDecimalString(field, path),
    instanceCount: (field, path) => assertDecimalString(field, path),
    promotionFreshness: (field, path) => decodePromotionFreshness(field, path),
    promotionRevision: (field, path) => assertDecimalString(field, path),
    promotedAtMonotonicNs: (field, path) => assertDecimalString(field, path),
    readyRecordHash: (field, path) => positiveHash(field, path),
  }, "readyGeneration");
  if (!sameCutoff(decoded.cutoff, decoded.promotionFreshness.cutoff)
    || decoded.generationRefreshPolicyHash !== decoded.promotionFreshness.generationRefreshPolicyHash) {
    throw new TypeError("ready promotion freshness binding mismatch");
  }
  if (BigInt(decoded.recentObservationRange.from) > BigInt(decoded.recentObservationRange.to)
    || decoded.recentObservationRange.to !== decoded.cutoff.number) {
    throw new TypeError("ready recent observation range mismatch");
  }
  const payload = {
    generationId: decoded.generationId,
    parentGenerationId: decoded.parentGenerationId,
    generationRefreshPolicyHash: decoded.generationRefreshPolicyHash,
    cutoff: decoded.cutoff,
    recentObservationRange: decoded.recentObservationRange,
    definitionCatalogRoot: decoded.definitionCatalogRoot,
    sourceCoverageRoot: decoded.sourceCoverageRoot,
    candidatePartitionRoot: decoded.candidatePartitionRoot,
    nominationClosureRoot: decoded.nominationClosureRoot,
    nominationClosureStorageHash: decoded.nominationClosureStorageHash,
    candidatePartitionProofStorageHash: decoded.candidatePartitionProofStorageHash,
    releaseProvenanceHash: decoded.releaseProvenanceHash,
    exactOutcomePartitionRoot: decoded.exactOutcomePartitionRoot,
    verifiedMemoSetRoot: decoded.verifiedMemoSetRoot,
    instanceCatalogRoot: decoded.instanceCatalogRoot,
    graphRoot: decoded.graphRoot,
    runtimeAuthority: decoded.runtimeAuthority,
    edgeCount: decoded.edgeCount,
    instanceCount: decoded.instanceCount,
    promotionFreshness: decoded.promotionFreshness,
    promotedAtMonotonicNs: decoded.promotedAtMonotonicNs,
    promotionRevision: decoded.promotionRevision,
  };
  if (decoded.readyRecordHash !== hashDomain("aloha/ready-generation/v1", payload)) {
    throw new TypeError("ready record hash mismatch");
  }
  return deepFreeze(decoded);
}

export function encodeFullFamilyReadyRecord(value: FullFamilyReadyRecordV1): Uint8Array {
  return encodeCanonicalBytes(decodeFullFamilyReadyRecord(value));
}

function decodeFamilyNominationPartition(value: unknown, path: string): FamilyNominationPartitionV1 {
  const decoded = decodeExactObject(value, {
    familyId: (field, itemPath) => assertNonEmptyString(field, itemPath),
    familyDefinitionHash: (field, itemPath) => positiveHash(field, itemPath),
    familyCandidateKeys: (field, itemPath) => fieldArray(field, (item, keyPath) => positiveHash(item, keyPath), itemPath),
    candidateSetRoot: (field, itemPath) => positiveHash(field, itemPath),
    candidateCount: (field, itemPath) => assertDecimalString(field, itemPath),
  }, path);
  strictSortedUnique(decoded.familyCandidateKeys, `${path}.familyCandidateKeys`);
  if (decoded.candidateCount !== String(decoded.familyCandidateKeys.length)
    || decoded.candidateSetRoot !== hashCanonicalPartition("aloha/nomination-family-candidates/v1", decoded.familyCandidateKeys)) {
    throw new TypeError(`candidate nomination partition mismatch at ${path}`);
  }
  return decoded;
}

function matrixEntryPayload(entry: Omit<FullFamilyMatrixEntryV1, "entryHash"> | FullFamilyMatrixEntryV1): object {
  return {
    familyId: entry.familyId,
    familyDefinitionHash: entry.familyDefinitionHash,
    sourcePlanRoot: entry.sourcePlanRoot,
    sourcePlans: entry.sourcePlans.root,
    candidatePartition: entry.candidatePartition,
    universeCandidates: entry.universeCandidates.root,
    outcomes: entry.outcomes.root,
    instancePublications: entry.instancePublications.root,
    projectedEdges: entry.projectedEdges.root,
    declaredCoarseCapabilities: entry.declaredCoarseCapabilities.root,
    coarseRankable: entry.coarseRankable.root,
    coarseUnavailable: entry.coarseUnavailable.root,
    unrankedAdmissions: entry.unrankedAdmissions.root,
    declaredExactCapabilities: entry.declaredExactCapabilities.root,
    ownedActions: entry.ownedActions.root,
  };
}

function decodeMatrixEntry(value: unknown, path: string): FullFamilyMatrixEntryV1 {
  const decoded = decodeExactObject(value, {
    familyId: (field, itemPath) => assertNonEmptyString(field, itemPath),
    familyDefinitionHash: (field, itemPath) => positiveHash(field, itemPath),
    sourcePlanRoot: (field, itemPath) => positiveHash(field, itemPath),
    sourcePlans: (field, itemPath) => decodeEvidencePartition(field, itemPath),
    candidatePartition: (field, itemPath) => decodeFamilyNominationPartition(field, itemPath),
    universeCandidates: (field, itemPath) => decodeEvidencePartition(field, itemPath),
    outcomes: (field, itemPath) => decodeOutcomePartition(field, itemPath),
    instancePublications: (field, itemPath) => decodeEvidencePartition(field, itemPath),
    projectedEdges: (field, itemPath) => decodeEvidencePartition(field, itemPath),
    declaredCoarseCapabilities: (field, itemPath) => decodeEvidencePartition(field, itemPath),
    coarseRankable: (field, itemPath) => decodeEvidencePartition(field, itemPath),
    coarseUnavailable: (field, itemPath) => decodeEvidencePartition(field, itemPath),
    unrankedAdmissions: (field, itemPath) => decodeEvidencePartition(field, itemPath),
    declaredExactCapabilities: (field, itemPath) => decodeEvidencePartition(field, itemPath),
    ownedActions: (field, itemPath) => decodeEvidencePartition(field, itemPath),
    entryHash: (field, itemPath) => positiveHash(field, itemPath),
  }, path);
  if (decoded.entryHash !== hashFullFamilyMatrixEntry(decoded)) throw new TypeError(`family entry hash mismatch at ${path}.entryHash`);
  return decoded;
}

function matrixRoot(domain: string, families: readonly FullFamilyMatrixEntryV1[], select: (family: FullFamilyMatrixEntryV1) => Hash): Hash {
  return hashDomain(domain, families.map(family => ({ familyId: family.familyId, root: select(family) })));
}

function decodeBundle(value: unknown, path = "$" ): FullFamilyFactBundleV1 {
  const decoded = decodeExactObject(value, {
    schemaVersion: (field, itemPath) => exactLiteral(field, 1, itemPath),
    kind: (field, itemPath) => exactLiteral(field, "aloha.full-family-facts", itemPath),
    runtime: (field, itemPath) => decodeRuntimeBinding(field, itemPath),
    releaseIntent: (field, itemPath) => decodeReleaseSet(field, itemPath),
    definitionCatalog: (field, itemPath) => decodeReleaseSet(field, itemPath),
    runtimeComposition: (field, itemPath) => decodeReleaseSet(field, itemPath),
    sourceCoverage: (field, itemPath) => decodeSourceCoverageBinding(field, itemPath),
    lineage: (field, itemPath) => decodeLineage(field, itemPath),
    familyMatrixCount: (field, itemPath) => assertDecimalString(field, itemPath),
    familyMatrixRoot: (field, itemPath) => positiveHash(field, itemPath),
    universeMatrixRoot: (field, itemPath) => positiveHash(field, itemPath),
    instanceMatrixRoot: (field, itemPath) => positiveHash(field, itemPath),
    edgeMatrixRoot: (field, itemPath) => positiveHash(field, itemPath),
    families: (field, itemPath) => fieldArray(field, (item, entryPath) => decodeMatrixEntry(item, entryPath), itemPath),
  }, path);
  strictSortedUnique(decoded.families.map(family => family.familyId), `${path}.families`);
  if (decoded.familyMatrixCount !== String(decoded.families.length)) throw new TypeError(`family matrix count mismatch at ${path}`);
  if (decoded.familyMatrixRoot !== hashFullFamilyMatrixRoot(decoded.families)) throw new TypeError(`family matrix root mismatch at ${path}`);
  if (decoded.universeMatrixRoot !== hashFullFamilyUniverseMatrixRoot(decoded.families)) throw new TypeError(`universe matrix root mismatch at ${path}`);
  if (decoded.instanceMatrixRoot !== hashFullFamilyInstanceMatrixRoot(decoded.families)) throw new TypeError(`instance matrix root mismatch at ${path}`);
  if (decoded.edgeMatrixRoot !== hashFullFamilyEdgeMatrixRoot(decoded.families)) throw new TypeError(`edge matrix root mismatch at ${path}`);
  return decoded;
}

function decodeStoredPartition(value: unknown, path: string): FullFamilyStoredPartitionV1 {
  return decodeExactObject(value, {
    count: (field, itemPath) => assertDecimalString(field, itemPath),
    root: (field, itemPath) => positiveHash(field, itemPath),
    indexArtifactRefId: (field, itemPath) => positiveHash(field, itemPath),
    indexContentSha256: (field, itemPath) => positiveHash(field, itemPath),
  }, path);
}

function decodeStoredMatrixEntry(value: unknown, path: string): FullFamilyStoredMatrixEntryV1 {
  const decoded = decodeExactObject(value, {
    familyId: (field, itemPath) => assertNonEmptyString(field, itemPath),
    familyDefinitionHash: (field, itemPath) => positiveHash(field, itemPath),
    sourcePlanRoot: (field, itemPath) => positiveHash(field, itemPath),
    candidateCount: (field, itemPath) => assertDecimalString(field, itemPath),
    candidateSetRoot: (field, itemPath) => positiveHash(field, itemPath),
    sourcePlans: (field, itemPath) => decodeStoredPartition(field, itemPath),
    universeCandidates: (field, itemPath) => decodeStoredPartition(field, itemPath),
    outcomes: (field, itemPath) => decodeStoredPartition(field, itemPath),
    instancePublications: (field, itemPath) => decodeStoredPartition(field, itemPath),
    projectedEdges: (field, itemPath) => decodeStoredPartition(field, itemPath),
    declaredCoarseCapabilities: (field, itemPath) => decodeStoredPartition(field, itemPath),
    coarseRankable: (field, itemPath) => decodeStoredPartition(field, itemPath),
    coarseUnavailable: (field, itemPath) => decodeStoredPartition(field, itemPath),
    unrankedAdmissions: (field, itemPath) => decodeStoredPartition(field, itemPath),
    declaredExactCapabilities: (field, itemPath) => decodeStoredPartition(field, itemPath),
    ownedActions: (field, itemPath) => decodeStoredPartition(field, itemPath),
    entryHash: (field, itemPath) => positiveHash(field, itemPath),
  }, path);
  if (decoded.candidateCount !== decoded.universeCandidates.count) {
    throw new TypeError(`stored Full-Family matrix entry mismatch at ${path}`);
  }
  return decoded;
}

function decodeStoredSourceCoverage(value: unknown, path: string): FullFamilyStoredSourceCoverageBindingV1 {
  return decodeExactObject(value, {
    artifactRefId: (field, itemPath) => positiveHash(field, itemPath),
    contentSha256: (field, itemPath) => positiveHash(field, itemPath),
  }, path);
}

function decodeStoredLineage(value: unknown, path: string): FullFamilyStoredLineageV1 {
  return decodeExactObject(value, {
    nominationClosure: (field, itemPath) => decodeExactObject(field, {
      artifactRefId: (entry, entryPath) => positiveHash(entry, entryPath),
      contentSha256: (entry, entryPath) => positiveHash(entry, entryPath),
      storageHash: (entry, entryPath) => positiveHash(entry, entryPath),
    }, itemPath),
    candidatePartitionProof: (field, itemPath) => decodeExactObject(field, {
      artifactRefId: (entry, entryPath) => positiveHash(entry, entryPath),
      contentSha256: (entry, entryPath) => positiveHash(entry, entryPath),
      storageHash: (entry, entryPath) => positiveHash(entry, entryPath),
    }, itemPath),
    candidateProofVerifierBinding: (field, itemPath) => decodeExactObject(field, {
      artifactRefId: (entry, entryPath) => positiveHash(entry, entryPath),
      contentSha256: (entry, entryPath) => positiveHash(entry, entryPath),
    }, itemPath),
  }, path);
}

export function decodeFullFamilyFactBundleStorageV1(
  value: FullFamilyFactsCodecInput,
): FullFamilyFactBundleStorageV1 {
  const decoded = decodeExactObject(parseInput(value), {
    schemaVersion: (field, path) => exactLiteral(field, 1, path),
    kind: (field, path) => exactLiteral(field, "aloha.full-family-facts-storage-v1", path),
    runtime: (field, path) => decodeRuntimeBinding(field, path),
    releaseIntent: (field, path) => decodeReleaseSet(field, path),
    definitionCatalog: (field, path) => decodeReleaseSet(field, path),
    runtimeComposition: (field, path) => decodeReleaseSet(field, path),
    sourceCoverage: (field, path) => decodeStoredSourceCoverage(field, path),
    lineage: (field, path) => decodeStoredLineage(field, path),
    familyMatrixCount: (field, path) => assertDecimalString(field, path),
    familyMatrixRoot: (field, path) => positiveHash(field, path),
    universeMatrixRoot: (field, path) => positiveHash(field, path),
    instanceMatrixRoot: (field, path) => positiveHash(field, path),
    edgeMatrixRoot: (field, path) => positiveHash(field, path),
    families: (field, path) => fieldArray(field, (entry, entryPath) => decodeStoredMatrixEntry(entry, entryPath), path),
  });
  strictSortedUnique(decoded.families.map(family => family.familyId), "storedFullFamily.families");
  if (decoded.familyMatrixCount !== String(decoded.families.length)
    || decoded.familyMatrixRoot !== hashDomain("aloha/full-family/matrix-root/v2", decoded.families.map(entry => entry.entryHash))
    || decoded.universeMatrixRoot !== hashDomain("aloha/full-family/universe-matrix-root/v1", decoded.families.map(entry => ({ familyId: entry.familyId, root: entry.universeCandidates.root })))
    || decoded.instanceMatrixRoot !== hashDomain("aloha/full-family/instance-matrix-root/v1", decoded.families.map(entry => ({ familyId: entry.familyId, root: entry.instancePublications.root })))
    || decoded.edgeMatrixRoot !== hashDomain("aloha/full-family/edge-matrix-root/v1", decoded.families.map(entry => ({ familyId: entry.familyId, root: entry.projectedEdges.root })))) {
    throw new TypeError("stored Full-Family bundle root/count mismatch");
  }
  return deepFreeze(decoded);
}

export function encodeFullFamilyFactBundleStorageV1(value: FullFamilyFactBundleStorageV1): Uint8Array {
  return encodeCanonicalBytes(decodeFullFamilyFactBundleStorageV1(value));
}

export function hashFamilyEvidencePartition(items: readonly FamilyEvidenceItemV1[]): Hash {
  return hashDomain("aloha/full-family/evidence-partition/v2", items);
}

export function hashFamilyOutcomePartition(items: readonly FamilyOutcomeItemV1[]): Hash {
  return hashDomain("aloha/full-family/outcome-partition/v2", items);
}

export function hashFamilyReleaseEntry(familyId: string, familyDefinitionHash: Hash): Hash {
  return hashDomain("aloha/full-family/release-entry/v2", { familyId, familyDefinitionHash });
}

export function hashFamilyReleaseSet(entries: readonly FamilyReleaseEntryV1[]): Hash {
  return hashDomain("aloha/full-family/release-set/v2", entries);
}

export function hashFullFamilyMatrixEntry(entry: Omit<FullFamilyMatrixEntryV1, "entryHash"> | FullFamilyMatrixEntryV1): Hash {
  return hashDomain("aloha/full-family/matrix-entry/v2", matrixEntryPayload(entry));
}

export function hashFullFamilyMatrixRoot(entries: readonly FullFamilyMatrixEntryV1[]): Hash {
  return hashDomain("aloha/full-family/matrix-root/v2", entries.map(entry => entry.entryHash));
}

export function hashFullFamilyUniverseMatrixRoot(entries: readonly FullFamilyMatrixEntryV1[]): Hash {
  return matrixRoot("aloha/full-family/universe-matrix-root/v1", entries, family => family.universeCandidates.root);
}

export function hashFullFamilyInstanceMatrixRoot(entries: readonly FullFamilyMatrixEntryV1[]): Hash {
  return matrixRoot("aloha/full-family/instance-matrix-root/v1", entries, family => family.instancePublications.root);
}

export function hashFullFamilyEdgeMatrixRoot(entries: readonly FullFamilyMatrixEntryV1[]): Hash {
  return matrixRoot("aloha/full-family/edge-matrix-root/v1", entries, family => family.projectedEdges.root);
}

export function sealFamilyEvidencePartition(items: readonly FamilyEvidenceItemV1[]): FamilyEvidencePartitionV1 {
  const decoded = items.map((item, index) => decodeEvidenceItem(item, `evidence[${index}]`)).sort((left, right) => compareText(left.itemId, right.itemId));
  strictSortedUnique(decoded.map(item => item.itemId), "evidence");
  return deepFreeze({ count: String(decoded.length), root: hashFamilyEvidencePartition(decoded), items: decoded });
}

export function sealFamilyOutcomePartition(items: readonly FamilyOutcomeItemV1[]): FamilyOutcomePartitionV1 {
  const decoded = items.map((item, index) => decodeOutcomeItem(item, `outcomes[${index}]`)).sort((left, right) => compareText(left.itemId, right.itemId));
  strictSortedUnique(decoded.map(item => item.itemId), "outcomes");
  strictSortedUnique([...decoded].sort((a, b) => compareText(a.candidateKey, b.candidateKey)).map(item => item.candidateKey), "outcome candidate keys");
  return deepFreeze({ count: String(decoded.length), root: hashFamilyOutcomePartition(decoded), items: decoded });
}

export function sealFamilyReleaseSet(input: FamilyReleaseSetDraftV1): FamilyReleaseSetV1 {
  const entries = input.entries.map((entry, index) => decodeExactObject(entry, {
    familyId: (field, path) => assertNonEmptyString(field, path),
    familyDefinitionHash: (field, path) => positiveHash(field, path),
  }, `releaseEntries[${index}]`)).map(entry => ({ ...entry, entryHash: hashFamilyReleaseEntry(entry.familyId, entry.familyDefinitionHash) })).sort((left, right) => compareText(left.familyId, right.familyId));
  strictSortedUnique(entries.map(entry => entry.familyId), "releaseEntries");
  return deepFreeze({
    sourceArtifactRefId: positiveHash(input.sourceArtifactRefId, "releaseSet.sourceArtifactRefId"),
    sourceArtifactContentSha256: positiveHash(input.sourceArtifactContentSha256, "releaseSet.sourceArtifactContentSha256"),
    contractRoot: positiveHash(input.contractRoot, "releaseSet.contractRoot"),
    count: String(entries.length),
    entrySetRoot: hashFamilyReleaseSet(entries),
    entries,
  });
}

export function sealFullFamilyMatrixEntry(input: Omit<FullFamilyMatrixEntryV1, "entryHash">): FullFamilyMatrixEntryV1 {
  const entry = {
    familyId: assertNonEmptyString(input.familyId, "family.familyId"),
    familyDefinitionHash: positiveHash(input.familyDefinitionHash, "family.familyDefinitionHash"),
    sourcePlanRoot: positiveHash(input.sourcePlanRoot, "family.sourcePlanRoot"),
    sourcePlans: decodeEvidencePartition(input.sourcePlans, "family.sourcePlans"),
    candidatePartition: decodeFamilyNominationPartition(input.candidatePartition, "family.candidatePartition"),
    universeCandidates: decodeEvidencePartition(input.universeCandidates, "family.universeCandidates"),
    outcomes: decodeOutcomePartition(input.outcomes, "family.outcomes"),
    instancePublications: decodeEvidencePartition(input.instancePublications, "family.instancePublications"),
    projectedEdges: decodeEvidencePartition(input.projectedEdges, "family.projectedEdges"),
    declaredCoarseCapabilities: decodeEvidencePartition(input.declaredCoarseCapabilities, "family.declaredCoarseCapabilities"),
    coarseRankable: decodeEvidencePartition(input.coarseRankable, "family.coarseRankable"),
    coarseUnavailable: decodeEvidencePartition(input.coarseUnavailable, "family.coarseUnavailable"),
    unrankedAdmissions: decodeEvidencePartition(input.unrankedAdmissions, "family.unrankedAdmissions"),
    declaredExactCapabilities: decodeEvidencePartition(input.declaredExactCapabilities, "family.declaredExactCapabilities"),
    ownedActions: decodeEvidencePartition(input.ownedActions, "family.ownedActions"),
  };
  return deepFreeze({ ...entry, entryHash: hashFullFamilyMatrixEntry(entry) });
}

export function sealFullFamilyFacts(input: FullFamilyFactBundleDraftV1): FullFamilyFactBundleV1 {
  const runtime = decodeRuntimeBinding(input.runtime, "fullFamily.runtime");
  const releaseIntent = sealFamilyReleaseSet(input.releaseIntent);
  const definitionCatalog = sealFamilyReleaseSet(input.definitionCatalog);
  const runtimeComposition = sealFamilyReleaseSet(input.runtimeComposition);
  const sourceCoverage = decodeSourceCoverageBinding(input.sourceCoverage, "fullFamily.sourceCoverage");
  const lineage = decodeLineage(input.lineage, "fullFamily.lineage");
  const families = input.families.map((entry, index) => decodeMatrixEntry(entry, `fullFamily.families[${index}]`)).sort((left, right) => compareText(left.familyId, right.familyId));
  strictSortedUnique(families.map(family => family.familyId), "fullFamily.families");
  return deepFreeze({
    schemaVersion: 1,
    kind: "aloha.full-family-facts",
    runtime,
    releaseIntent,
    definitionCatalog,
    runtimeComposition,
    sourceCoverage,
    lineage,
    familyMatrixCount: String(families.length),
    familyMatrixRoot: hashFullFamilyMatrixRoot(families),
    universeMatrixRoot: hashFullFamilyUniverseMatrixRoot(families),
    instanceMatrixRoot: hashFullFamilyInstanceMatrixRoot(families),
    edgeMatrixRoot: hashFullFamilyEdgeMatrixRoot(families),
    families,
  });
}

export interface FullFamilyStoredPartitionBindingInputV1 {
  readonly familyId: string;
  readonly role: FullFamilyPartitionRoleV1;
  readonly count: string;
  readonly root: Hash;
  readonly indexArtifactRefId: Hash;
  readonly indexContentSha256: Hash;
}

function partitionStorageKey(familyId: string, role: FullFamilyPartitionRoleV1): string {
  return `${familyId}\u001f${role}`;
}

export function sealFullFamilyFactBundleStorageV1(
  bundle: FullFamilyFactBundleV1,
  bindings: readonly FullFamilyStoredPartitionBindingInputV1[],
): FullFamilyFactBundleStorageV1 {
  const decoded = decodeFullFamilyFacts(bundle);
  const byKey = new Map<string, FullFamilyStoredPartitionV1>();
  for (const [index, binding] of bindings.entries()) {
    const familyId = assertNonEmptyString(binding.familyId, `storedBindings[${index}].familyId`);
    const role = decodePartitionRole(binding.role, `storedBindings[${index}].role`);
    const key = partitionStorageKey(familyId, role);
    if (byKey.has(key)) throw new TypeError("duplicate Full-Family stored partition binding");
    byKey.set(key, deepFreeze({
      count: assertDecimalString(binding.count, `storedBindings[${index}].count`),
      root: positiveHash(binding.root, `storedBindings[${index}].root`),
      indexArtifactRefId: positiveHash(binding.indexArtifactRefId, `storedBindings[${index}].indexArtifactRefId`),
      indexContentSha256: positiveHash(binding.indexContentSha256, `storedBindings[${index}].indexContentSha256`),
    }));
  }
  const take = (
    familyId: string,
    role: FullFamilyPartitionRoleV1,
    semantic: FamilyEvidencePartitionV1 | FamilyOutcomePartitionV1,
  ): FullFamilyStoredPartitionV1 => {
    const stored = byKey.get(partitionStorageKey(familyId, role));
    if (stored === undefined || stored.count !== semantic.count || stored.root !== semantic.root) {
      throw new TypeError(`missing or mismatched Full-Family stored partition ${familyId}/${role}`);
    }
    byKey.delete(partitionStorageKey(familyId, role));
    return stored;
  };
  const families = decoded.families.map(family => deepFreeze({
    familyId: family.familyId,
    familyDefinitionHash: family.familyDefinitionHash,
    sourcePlanRoot: family.sourcePlanRoot,
    candidateCount: family.candidatePartition.candidateCount,
    candidateSetRoot: family.candidatePartition.candidateSetRoot,
    sourcePlans: take(family.familyId, "source-plans", family.sourcePlans),
    universeCandidates: take(family.familyId, "universe-candidates", family.universeCandidates),
    outcomes: take(family.familyId, "outcomes", family.outcomes),
    instancePublications: take(family.familyId, "instance-publications", family.instancePublications),
    projectedEdges: take(family.familyId, "projected-edges", family.projectedEdges),
    declaredCoarseCapabilities: take(family.familyId, "declared-coarse-capabilities", family.declaredCoarseCapabilities),
    coarseRankable: take(family.familyId, "coarse-rankable", family.coarseRankable),
    coarseUnavailable: take(family.familyId, "coarse-unavailable", family.coarseUnavailable),
    unrankedAdmissions: take(family.familyId, "unranked-admissions", family.unrankedAdmissions),
    declaredExactCapabilities: take(family.familyId, "declared-exact-capabilities", family.declaredExactCapabilities),
    ownedActions: take(family.familyId, "owned-actions", family.ownedActions),
    entryHash: family.entryHash,
  }));
  if (byKey.size !== 0) throw new TypeError("orphan Full-Family stored partition binding");
  const value = {
    schemaVersion: 1 as const,
    kind: "aloha.full-family-facts-storage-v1" as const,
    runtime: decoded.runtime,
    releaseIntent: decoded.releaseIntent,
    definitionCatalog: decoded.definitionCatalog,
    runtimeComposition: decoded.runtimeComposition,
    sourceCoverage: deepFreeze({
      artifactRefId: decoded.sourceCoverage.artifactRefId,
      contentSha256: decoded.sourceCoverage.contentSha256,
    }),
    lineage: deepFreeze({
      nominationClosure: deepFreeze({
        artifactRefId: decoded.lineage.nominationClosure.artifactRefId,
        contentSha256: decoded.lineage.nominationClosure.contentSha256,
        storageHash: decoded.lineage.nominationClosure.storageHash,
      }),
      candidatePartitionProof: deepFreeze({
        artifactRefId: decoded.lineage.candidatePartitionProof.artifactRefId,
        contentSha256: decoded.lineage.candidatePartitionProof.contentSha256,
        storageHash: decoded.lineage.candidatePartitionProof.storageHash,
      }),
      candidateProofVerifierBinding: deepFreeze({
        artifactRefId: decoded.lineage.candidateProofVerifierBinding.artifactRefId,
        contentSha256: decoded.lineage.candidateProofVerifierBinding.contentSha256,
      }),
    }),
    familyMatrixCount: decoded.familyMatrixCount,
    familyMatrixRoot: decoded.familyMatrixRoot,
    universeMatrixRoot: decoded.universeMatrixRoot,
    instanceMatrixRoot: decoded.instanceMatrixRoot,
    edgeMatrixRoot: decoded.edgeMatrixRoot,
    families: deepFreeze(families),
  };
  return deepFreeze(value);
}

export type FullFamilyStoredArtifactResolverV1 = (
  artifactRefId: Hash,
  contentSha256: Hash,
) => Uint8Array;

export type FullFamilyStoredItemDecoderV1 = (input: Readonly<{
  readonly familyId: string;
  readonly role: FullFamilyPartitionRoleV1;
  readonly itemKind: "evidence" | "outcome";
  readonly artifactRefId: Hash;
  readonly contentSha256: Hash;
  readonly bytes: Uint8Array;
}>) => FamilyEvidenceItemV1 | FamilyOutcomeItemV1;

function storedInstanceIdentityRef(familyDefinitionHash: Hash, instanceKey: string): Hash {
  return hashDomain("aloha/full-family/instance-identity-ref/v1", { familyDefinitionHash, instanceKey });
}

/** Domain decoder paired with the generic ref-page reader.  It reconstructs
 * the semantic item from the one original observer artifact; pages never
 * duplicate those fields. */
export const decodeFullFamilyStoredItemV1: FullFamilyStoredItemDecoderV1 = input => {
  let item: FamilyEvidenceItemV1 | FamilyOutcomeItemV1;
  if (input.role === "source-plans" || input.role === "universe-candidates") {
    const artifact = decodeFullFamilyEvidenceArtifact(input.bytes);
    item = {
      familyId: artifact.familyId,
      itemId: artifact.itemId,
      subjectKey: artifact.subjectKey,
      evidenceArtifactRefId: input.artifactRefId,
      evidenceContentSha256: input.contentSha256,
    };
  } else if (input.role === "outcomes") {
    const artifact = decodeFullFamilyOutcomeArtifact(input.bytes);
    item = {
      familyId: artifact.familyId,
      itemId: artifact.itemId,
      candidateKey: artifact.candidateKey,
      instanceKey: artifact.instanceKey,
      outcome: artifact.outcome,
      evidenceArtifactRefId: input.artifactRefId,
      evidenceContentSha256: input.contentSha256,
    };
  } else if (input.role === "instance-publications") {
    const artifact = decodeFullFamilyInstancePublication(decodeCanonicalJson(input.bytes));
    item = {
      familyId: artifact.familyId,
      itemId: artifact.instancePublicationHash,
      subjectKey: storedInstanceIdentityRef(artifact.familyDefinitionHash, artifact.instanceKey),
      evidenceArtifactRefId: input.artifactRefId,
      evidenceContentSha256: input.contentSha256,
    };
  } else if (input.role === "projected-edges") {
    const artifact = decodeFullFamilyPersistedGraphEdge(decodeCanonicalJson(input.bytes));
    item = {
      familyId: artifact.owningFamilyId,
      itemId: artifact.edgeId,
      subjectKey: storedInstanceIdentityRef(artifact.owningFamilyDefinitionHash, artifact.owningInstanceKey),
      evidenceArtifactRefId: input.artifactRefId,
      evidenceContentSha256: input.contentSha256,
    };
  } else if (input.role === "declared-coarse-capabilities" || input.role === "declared-exact-capabilities") {
    const artifact = decodeFullFamilyStageCapabilityRef(decodeCanonicalJson(input.bytes));
    item = {
      familyId: artifact.familyId,
      itemId: artifact.ownerRef,
      subjectKey: artifact.ownerRef,
      evidenceArtifactRefId: input.artifactRefId,
      evidenceContentSha256: input.contentSha256,
    };
  } else if (input.role === "owned-actions") {
    const artifact = decodeFullFamilyActionOwnerArtifact(decodeCanonicalJson(input.bytes));
    item = {
      familyId: artifact.familyId,
      itemId: artifact.actionOwnerRef,
      subjectKey: artifact.actionOwnerRef,
      evidenceArtifactRefId: input.artifactRefId,
      evidenceContentSha256: input.contentSha256,
    };
  } else {
    const observation = decodeExactObject(decodeCanonicalJson(input.bytes), {
      schemaVersion: (field, path) => exactLiteral(field, 1, path),
      kind: (field, path) => exactLiteral(field, "aloha.family-runtime-coarse-edge-sweep-observation-v1", path),
      familyId: (field, path) => assertNonEmptyString(field, path),
      familyDefinitionHash: (field, path) => positiveHash(field, path),
      releaseMembershipRoot: (field, path) => positiveHash(field, path),
      binding: (field, path) => canonicalRecord<Record<string, CanonicalJson>>(field, path),
      routeHandleBindingHash: (field, path) => positiveHash(field, path),
      amountHash: (field, path) => positiveHash(field, path),
      projectionId: (field, path) => positiveHash(field, path),
      stateOutcome: (field, path) => canonicalRecord<Record<string, CanonicalJson>>(field, path),
      coarseOutcome: (field, path) => canonicalRecord<Record<string, CanonicalJson>>(field, path),
      observationRoot: (field, path) => positiveHash(field, path),
    });
    const { observationRoot, ...observationBody } = observation;
    const binding = canonicalRecord<Record<string, CanonicalJson>>(observation.binding, "coarseObservation.binding");
    const edgeId = positiveHash(binding.edgeId, "coarseObservation.binding.edgeId");
    const coarseOutcome = canonicalRecord<Record<string, CanonicalJson>>(observation.coarseOutcome, "coarseObservation.coarseOutcome");
    const coarse = canonicalRecord<Record<string, CanonicalJson>>(coarseOutcome.artifact, "coarseObservation.coarseOutcome.artifact");
    const status = coarse.status;
    if (observationRoot !== hashDomain("aloha/family-runtime-coarse-edge-sweep-observation/v1", observationBody)
      || coarseOutcome.kind !== "verified" || coarse.kind !== "coarse"
      || (status !== "rankable" && status !== "unavailable")
      || (input.role === "coarse-rankable") !== (status === "rankable")
      || (input.role === "coarse-unavailable" || input.role === "unranked-admissions") !== (status === "unavailable")) {
      throw new TypeError("stored Full-Family coarse observation is invalid");
    }
    item = {
      familyId: observation.familyId,
      itemId: positiveHash(coarse.artifactHash, "coarseObservation.artifactHash"),
      subjectKey: edgeId,
      evidenceArtifactRefId: input.artifactRefId,
      evidenceContentSha256: input.contentSha256,
    };
  }
  const decoded = "candidateKey" in item
    ? decodeOutcomeItem(item, "storedFullFamily.item")
    : decodeEvidenceItem(item, "storedFullFamily.item");
  if (decoded.familyId !== input.familyId
    || (input.itemKind === "outcome") !== ("candidateKey" in decoded)) {
    throw new TypeError(`stored Full-Family item domain splice:${input.familyId}/${input.role}`);
  }
  return decoded;
};

function resolveStoredBytes(
  resolver: FullFamilyStoredArtifactResolverV1,
  ref: FullFamilyArtifactDigestV1,
  path: string,
): Uint8Array {
  const bytes = resolver(ref.artifactRefId, ref.contentSha256);
  if (!(bytes instanceof Uint8Array) || sha256Hex(bytes) !== ref.contentSha256) {
    throw new TypeError(`Full-Family stored artifact digest mismatch at ${path}`);
  }
  return bytes;
}

function materializeStoredPartition(
  familyId: string,
  role: FullFamilyPartitionRoleV1,
  itemKind: "evidence" | "outcome",
  stored: FullFamilyStoredPartitionV1,
  resolver: FullFamilyStoredArtifactResolverV1,
  decodeItem: FullFamilyStoredItemDecoderV1,
): FamilyEvidencePartitionV1 | FamilyOutcomePartitionV1 {
  const indexRef = Object.freeze({
    artifactRefId: stored.indexArtifactRefId,
    contentSha256: stored.indexContentSha256,
  });
  const index = decodeFullFamilyArtifactRefIndexV1(resolveStoredBytes(resolver, indexRef, `${familyId}.${role}.index`));
  const items: Array<FamilyEvidenceItemV1 | FamilyOutcomeItemV1> = [];
  let next = index.firstPageRef;
  let ordinal = 0;
  while (next !== null) {
    if (ordinal >= Number(index.pageCount)) throw new TypeError(`Full-Family artifact ref page cycle at ${familyId}/${role}`);
    const page = decodeFullFamilyArtifactRefPageV1(resolveStoredBytes(resolver, next, `${familyId}.${role}.page[${ordinal}]`));
    for (const ref of page.refs) {
      const bytes = resolveStoredBytes(resolver, ref, `${familyId}.${role}.item[${items.length}]`);
      items.push(decodeItem({ familyId, role, itemKind, ...ref, bytes }));
    }
    next = page.nextPageRef;
    ordinal += 1;
  }
  if (String(ordinal) !== index.pageCount || String(items.length) !== stored.count) {
    throw new TypeError(`Full-Family artifact ref page closure mismatch at ${familyId}/${role}`);
  }
  const materialized = itemKind === "evidence"
    ? sealFamilyEvidencePartition(items as FamilyEvidenceItemV1[])
    : sealFamilyOutcomePartition(items as FamilyOutcomeItemV1[]);
  if (materialized.count !== stored.count || materialized.root !== stored.root) {
    throw new TypeError(`Full-Family materialized partition root mismatch at ${familyId}/${role}`);
  }
  return materialized;
}

export function materializeFullFamilyFactBundleStorageV1(
  storage: FullFamilyFactBundleStorageV1,
  resolver: FullFamilyStoredArtifactResolverV1,
  decodeItem: FullFamilyStoredItemDecoderV1,
): FullFamilyFactBundleV1 {
  const decoded = decodeFullFamilyFactBundleStorageV1(storage);
  const readDirect = (artifactRefId: Hash, contentSha256: Hash, path: string) => resolveStoredBytes(
    resolver,
    Object.freeze({ artifactRefId, contentSha256 }),
    path,
  );
  const sourceCoverageArtifact = decodeFullFamilySourceCoverageArtifact(readDirect(
    decoded.sourceCoverage.artifactRefId,
    decoded.sourceCoverage.contentSha256,
    "sourceCoverage",
  ));
  const nominationClosure = decodeNominationClosureV1(decodeCanonicalJson(readDirect(
    decoded.lineage.nominationClosure.artifactRefId,
    decoded.lineage.nominationClosure.contentSha256,
    "nominationClosure",
  )));
  const candidatePartitionProof = decodeCandidatePartitionProofV1(decodeCanonicalJson(readDirect(
    decoded.lineage.candidatePartitionProof.artifactRefId,
    decoded.lineage.candidatePartitionProof.contentSha256,
    "candidatePartitionProof",
  )));
  const candidateProofVerifierBinding = decodeFullFamilyCandidateProofVerifierBinding(readDirect(
    decoded.lineage.candidateProofVerifierBinding.artifactRefId,
    decoded.lineage.candidateProofVerifierBinding.contentSha256,
    "candidateProofVerifierBinding",
  ));
  const families = decoded.families.map(stored => {
    const sourcePlans = materializeStoredPartition(stored.familyId, "source-plans", "evidence", stored.sourcePlans, resolver, decodeItem) as FamilyEvidencePartitionV1;
    const universeCandidates = materializeStoredPartition(stored.familyId, "universe-candidates", "evidence", stored.universeCandidates, resolver, decodeItem) as FamilyEvidencePartitionV1;
    const outcomes = materializeStoredPartition(stored.familyId, "outcomes", "outcome", stored.outcomes, resolver, decodeItem) as FamilyOutcomePartitionV1;
    const candidateKeys = universeCandidates.items.map(item => item.subjectKey).sort(compareText);
    const candidatePartition = deepFreeze({
      familyId: stored.familyId,
      familyDefinitionHash: stored.familyDefinitionHash,
      familyCandidateKeys: candidateKeys,
      candidateSetRoot: hashCanonicalPartition("aloha/nomination-family-candidates/v1", candidateKeys),
      candidateCount: String(candidateKeys.length),
    });
    if (candidatePartition.candidateCount !== stored.candidateCount
      || candidatePartition.candidateSetRoot !== stored.candidateSetRoot) {
      throw new TypeError(`stored Full-Family candidate denominator mismatch:${stored.familyId}`);
    }
    const family = sealFullFamilyMatrixEntry({
      familyId: stored.familyId,
      familyDefinitionHash: stored.familyDefinitionHash,
      sourcePlanRoot: stored.sourcePlanRoot,
      sourcePlans,
      candidatePartition,
      universeCandidates,
      outcomes,
      instancePublications: materializeStoredPartition(stored.familyId, "instance-publications", "evidence", stored.instancePublications, resolver, decodeItem) as FamilyEvidencePartitionV1,
      projectedEdges: materializeStoredPartition(stored.familyId, "projected-edges", "evidence", stored.projectedEdges, resolver, decodeItem) as FamilyEvidencePartitionV1,
      declaredCoarseCapabilities: materializeStoredPartition(stored.familyId, "declared-coarse-capabilities", "evidence", stored.declaredCoarseCapabilities, resolver, decodeItem) as FamilyEvidencePartitionV1,
      coarseRankable: materializeStoredPartition(stored.familyId, "coarse-rankable", "evidence", stored.coarseRankable, resolver, decodeItem) as FamilyEvidencePartitionV1,
      coarseUnavailable: materializeStoredPartition(stored.familyId, "coarse-unavailable", "evidence", stored.coarseUnavailable, resolver, decodeItem) as FamilyEvidencePartitionV1,
      unrankedAdmissions: materializeStoredPartition(stored.familyId, "unranked-admissions", "evidence", stored.unrankedAdmissions, resolver, decodeItem) as FamilyEvidencePartitionV1,
      declaredExactCapabilities: materializeStoredPartition(stored.familyId, "declared-exact-capabilities", "evidence", stored.declaredExactCapabilities, resolver, decodeItem) as FamilyEvidencePartitionV1,
      ownedActions: materializeStoredPartition(stored.familyId, "owned-actions", "evidence", stored.ownedActions, resolver, decodeItem) as FamilyEvidencePartitionV1,
    });
    if (family.entryHash !== stored.entryHash) throw new TypeError(`stored Full-Family matrix entry hash mismatch:${stored.familyId}`);
    return family;
  });
  const bundle = sealFullFamilyFacts({
    runtime: decoded.runtime,
    releaseIntent: {
      sourceArtifactRefId: decoded.releaseIntent.sourceArtifactRefId,
      sourceArtifactContentSha256: decoded.releaseIntent.sourceArtifactContentSha256,
      contractRoot: decoded.releaseIntent.contractRoot,
      entries: decoded.releaseIntent.entries.map(({ familyId, familyDefinitionHash }) => ({ familyId, familyDefinitionHash })),
    },
    definitionCatalog: {
      sourceArtifactRefId: decoded.definitionCatalog.sourceArtifactRefId,
      sourceArtifactContentSha256: decoded.definitionCatalog.sourceArtifactContentSha256,
      contractRoot: decoded.definitionCatalog.contractRoot,
      entries: decoded.definitionCatalog.entries.map(({ familyId, familyDefinitionHash }) => ({ familyId, familyDefinitionHash })),
    },
    runtimeComposition: {
      sourceArtifactRefId: decoded.runtimeComposition.sourceArtifactRefId,
      sourceArtifactContentSha256: decoded.runtimeComposition.sourceArtifactContentSha256,
      contractRoot: decoded.runtimeComposition.contractRoot,
      entries: decoded.runtimeComposition.entries.map(({ familyId, familyDefinitionHash }) => ({ familyId, familyDefinitionHash })),
    },
    sourceCoverage: {
      ...decoded.sourceCoverage,
      artifact: sourceCoverageArtifact,
    },
    lineage: {
      nominationClosure: { ...decoded.lineage.nominationClosure, artifact: nominationClosure },
      candidatePartitionProof: { ...decoded.lineage.candidatePartitionProof, artifact: candidatePartitionProof },
      candidateProofVerifierBinding: { ...decoded.lineage.candidateProofVerifierBinding, artifact: candidateProofVerifierBinding },
    },
    families,
  });
  if (bundle.familyMatrixRoot !== decoded.familyMatrixRoot
    || bundle.universeMatrixRoot !== decoded.universeMatrixRoot
    || bundle.instanceMatrixRoot !== decoded.instanceMatrixRoot
    || bundle.edgeMatrixRoot !== decoded.edgeMatrixRoot) {
    throw new TypeError("stored Full-Family materialized matrix root mismatch");
  }
  return bundle;
}

export function decodeFullFamilyFacts(value: FullFamilyFactsCodecInput): FullFamilyFactBundleV1 {
  return deepFreeze(decodeBundle(parseInput(value)));
}

export function encodeFullFamilyFacts(value: FullFamilyFactBundleV1): Uint8Array {
  return encodeCanonicalBytes(decodeFullFamilyFacts(value));
}

export function isFullFamilyFactBundle(value: unknown): value is FullFamilyFactBundleV1 {
  try {
    decodeFullFamilyFacts(value as FullFamilyFactsCodecInput);
    return true;
  } catch {
    return false;
  }
}

export function decodeFullFamilyFactLocator(value: FullFamilyFactsCodecInput): FullFamilyFactLocatorV1 {
  return deepFreeze(decodeExactObject(parseInput(value), {
    schemaVersion: (field, path) => exactLiteral(field, 1, path),
    kind: (field, path) => exactLiteral(field, "aloha.full-family-fact-locator", path),
    bundleArtifactRefId: (field, path) => positiveHash(field, path),
    bundleContentSha256: (field, path) => positiveHash(field, path),
  }));
}

export function createFullFamilyFactLocator(input: Omit<FullFamilyFactLocatorV1, "schemaVersion" | "kind">): FullFamilyFactLocatorV1 {
  return decodeFullFamilyFactLocator({ schemaVersion: 1, kind: "aloha.full-family-fact-locator", ...input });
}

export function encodeFullFamilyFactLocator(value: FullFamilyFactLocatorV1): Uint8Array {
  return encodeCanonicalBytes(decodeFullFamilyFactLocator(value));
}

function sameReleaseEntries(left: FamilyReleaseSetV1, right: FamilyReleaseSetV1): boolean {
  return left.count === right.count && left.entrySetRoot === right.entrySetRoot
    && left.entries.length === right.entries.length
    && left.entries.every((entry, index) => {
      const other = right.entries[index];
      return other !== undefined && entry.familyId === other.familyId
        && entry.familyDefinitionHash === other.familyDefinitionHash
        && entry.entryHash === other.entryHash;
    });
}

function assertPartitionFamily(familyId: string, partition: FamilyEvidencePartitionV1 | FamilyOutcomePartitionV1, path: string): void {
  for (const [index, item] of partition.items.entries()) if (item.familyId !== familyId) throw new TypeError(`cross-family item at ${path}.items[${index}]`);
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every(value => right.has(value));
}

function sameJson(left: unknown, right: unknown): boolean {
  return encodeCanonicalJson(left) === encodeCanonicalJson(right);
}

function disjoint(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return [...left].every(value => !right.has(value));
}

function allUniqueAcrossFamilies(families: readonly FullFamilyMatrixEntryV1[], select: (family: FullFamilyMatrixEntryV1) => readonly string[], path: string): void {
  const values = families.flatMap(select);
  if (new Set(values).size !== values.length) throw new TypeError(`cross-family duplicate identity at ${path}`);
}

function validateGeneratedRuntimeMetadata(metadata: FullFamilyGeneratedRuntimeMetadataV1): FullFamilyGeneratedRuntimeMetadataV1 {
  positiveHash(metadata.releaseIntentRoot, "generatedRuntime.releaseIntentRoot");
  positiveHash(metadata.definitionCatalogRoot, "generatedRuntime.definitionCatalogRoot");
  positiveHash(metadata.descriptorRoot, "generatedRuntime.descriptorRoot");
  if (!Array.isArray(metadata.families) || metadata.families.length === 0) throw new TypeError("generated-runtime-family-denominator-empty");
  strictSortedUnique(metadata.families.map(family => assertNonEmptyString(family.familyId, "generatedRuntime.familyId")), "generatedRuntime.families");
  for (const family of metadata.families) {
    positiveHash(family.familyDefinitionHash, `generatedRuntime.${family.familyId}.familyDefinitionHash`);
    positiveHash(family.sourcePlanRoot, `generatedRuntime.${family.familyId}.sourcePlanRoot`);
    if (!Array.isArray(family.sourcePlanRefs) || family.sourcePlanRefs.length === 0) throw new TypeError(`generated-runtime-source-plan-empty:${family.familyId}`);
    const plans: readonly SourcePlanRefV1[] = family.sourcePlanRefs.map((plan: SourcePlanRefV1, index: number) => decodeFullFamilySourcePlanRef(plan, `generatedRuntime.${family.familyId}.sourcePlanRefs[${index}]`));
    strictSortedUnique(plans.map(fullFamilySourcePlanIdentity), `generatedRuntime.${family.familyId}.sourcePlanRefs`);
    if (plans.some((plan: SourcePlanRefV1) => plan.familyDefinitionHash !== family.familyDefinitionHash)) throw new TypeError(`generated-runtime-source-plan-definition-splice:${family.familyId}`);
  }
  return metadata;
}

export function fullFamilyQualificationLeafDigest(
  family: FullFamilyGeneratedRuntimeMetadataV1["families"][number],
): Hash {
  return hashDomain("aloha/full-family/qualification-leaf/v1", {
    familyId: family.familyId,
    familyDefinitionHash: family.familyDefinitionHash,
    sourcePlanRoot: family.sourcePlanRoot,
    sourcePlanRefs: family.sourcePlanRefs,
  });
}

export function fullFamilyGeneratedDenominatorRoot(metadata: FullFamilyGeneratedRuntimeMetadataV1): Hash {
  const decoded = validateGeneratedRuntimeMetadata(metadata);
  return hashDomain("aloha/full-family/generated-denominator/v1", {
    descriptorRoot: decoded.descriptorRoot,
    definitionCatalogRoot: decoded.definitionCatalogRoot,
    leaves: decoded.families.map(fullFamilyQualificationLeafDigest),
  });
}

export function validateFullFamilyFacts(
  bundle: FullFamilyFactBundleV1,
  generatedRuntime: FullFamilyGeneratedRuntimeMetadataV1,
): void {
  const decoded = decodeFullFamilyFacts(bundle);
  const generated = validateGeneratedRuntimeMetadata(generatedRuntime);
  if (decoded.runtime.releaseIntentRoot !== generated.releaseIntentRoot
    || decoded.runtime.definitionCatalogRoot !== generated.definitionCatalogRoot
    || decoded.runtime.generatedRuntimeDescriptorRoot !== generated.descriptorRoot) {
    throw new TypeError("generated-runtime-root-mismatch");
  }
  if (!sameReleaseEntries(decoded.releaseIntent, decoded.definitionCatalog)) throw new TypeError("release-intent-definition-catalog-mismatch");
  if (!sameReleaseEntries(decoded.releaseIntent, decoded.runtimeComposition)) throw new TypeError("release-intent-runtime-composition-mismatch");
  if (decoded.releaseIntent.contractRoot !== decoded.runtime.releaseIntentRoot) throw new TypeError("release-intent-root-mismatch");
  if (decoded.definitionCatalog.contractRoot !== decoded.runtime.definitionCatalogRoot) throw new TypeError("definition-catalog-root-mismatch");
  if (decoded.runtimeComposition.contractRoot !== decoded.runtime.runtimeCompositionRoot) throw new TypeError("runtime-composition-root-mismatch");
  const coverageArtifact = decoded.sourceCoverage.artifact;
  if (coverageArtifact.readyRecordHash !== decoded.runtime.readyRecordHash
    || !sameCutoff(coverageArtifact.cutoff, decoded.runtime.readyCutoff)
    || coverageArtifact.sourceCoverage.sourceCoverageRoot !== decoded.runtime.sourceCoverageRoot) {
    throw new TypeError("source-coverage-runtime-binding-mismatch");
  }
  const nominationClosure = decoded.lineage.nominationClosure.artifact;
  const proof = decoded.lineage.candidatePartitionProof.artifact;
  const verifierBinding = decoded.lineage.candidateProofVerifierBinding.artifact;
  if (!sameCutoff(nominationClosure.cutoff, decoded.runtime.readyCutoff)
    || nominationClosure.root !== decoded.runtime.nominationClosureRoot
    || decoded.lineage.nominationClosure.storageHash !== decoded.runtime.nominationClosureStorageHash
    || nominationClosure.sourceCoverageRoot !== decoded.runtime.sourceCoverageRoot
    || nominationClosure.candidatePartitionRoot !== decoded.runtime.candidatePartitionRoot) {
    throw new TypeError("nomination-closure-runtime-binding-mismatch");
  }
  const nominatedKeys = nominationClosure.families.flatMap(family => family.familyCandidateKeys).sort(compareText);
  if (!sameCutoff(proof.cutoff, decoded.runtime.readyCutoff)
    || proof.candidatePartitionRoot !== decoded.runtime.candidatePartitionRoot
    || proof.candidatePartitionStorageHash !== decoded.runtime.candidatePartitionStorageHash
    || decoded.lineage.candidatePartitionProof.storageHash !== decoded.runtime.candidatePartitionProofStorageHash
    || proof.nominationClosureRoot !== decoded.runtime.nominationClosureRoot
    || proof.nominationClosureStorageHash !== decoded.runtime.nominationClosureStorageHash
    || proof.recordCount !== String(nominatedKeys.length)
    || proof.recordCount !== nominationClosure.candidateCount
    || proof.candidateKeysRoot !== candidatePartitionKeysRoot(nominatedKeys)
    || proof.recentObservationRoot !== nominationClosure.recentObservationRoot
    || proof.sourceCoverageRoot !== decoded.runtime.sourceCoverageRoot
    || proof.releaseProvenanceHash !== decoded.runtime.releaseProvenanceHash) {
    throw new TypeError("candidate-partition-proof-runtime-binding-mismatch");
  }
  if (verifierBinding.runtimeBindingId !== decoded.runtime.releaseBindingId
    || verifierBinding.releaseProvenanceHash !== decoded.runtime.releaseProvenanceHash
    || verifierBinding.proofKeyId !== proof.issuerKeyId
    || verifierBinding.proofKeyId !== proof.signerKeyId) {
    throw new TypeError("candidate-proof-verifier-runtime-binding-mismatch");
  }
  const releaseByFamily = new Map(decoded.releaseIntent.entries.map(entry => [entry.familyId, entry]));
  if (generated.families.length !== releaseByFamily.size) throw new TypeError("generated-runtime-family-denominator-mismatch");
  for (const family of generated.families) {
    const release = releaseByFamily.get(family.familyId);
    if (release?.familyDefinitionHash !== family.familyDefinitionHash) throw new TypeError(`generated-runtime-family-definition-splice:${family.familyId}`);
  }
  if (releaseByFamily.size !== decoded.families.length) throw new TypeError("family-denominator-mismatch");
  if (new Set(decoded.releaseIntent.entries.map(release => release.familyDefinitionHash)).size !== decoded.releaseIntent.entries.length) {
    throw new TypeError("duplicate-family-definition-hash");
  }
  const plansByFamily = new Map(generated.families.map(family => [family.familyId, [...family.sourcePlanRefs]]));
  const declaredPlans = generated.families.flatMap(family => family.sourcePlanRefs)
    .sort((left, right) => compareText(fullFamilySourcePlanIdentity(left), fullFamilySourcePlanIdentity(right)));
  if (!sameSet(new Set(nominationClosure.sourcePlanIdentities), new Set(declaredPlans.map(fullFamilySourcePlanIdentity)))) {
    throw new TypeError("nomination-source-plan-denominator-mismatch");
  }
  validateFullFamilySourceCoverage(coverageArtifact.sourceCoverage, declaredPlans);
  const executionByPlan = new Map(coverageArtifact.executions.map(binding => [sourceBindingIdentity(binding), binding]));
  if (executionByPlan.size !== coverageArtifact.executions.length || executionByPlan.size !== declaredPlans.length) {
    throw new TypeError("source-plan-execution-denominator-mismatch");
  }
  const coverageByPlan = new Map(coverageArtifact.sourceCoverage.entries.map(entry => [fullFamilySourcePlanIdentity(entry), entry]));
  for (const plan of declaredPlans) {
    const identity = fullFamilySourcePlanIdentity(plan);
    const execution = executionByPlan.get(identity);
    const coverage = coverageByPlan.get(identity);
    if (execution === undefined || coverage === undefined
      || execution.familyDefinitionHash !== plan.familyDefinitionHash
      || execution.executionRoot !== coverage.executionRoot
      || execution.resultPartitionRoot !== coverage.resultPartitionRoot) {
      throw new TypeError("source-plan-execution-coverage-binding-mismatch");
    }
  }
  for (const [index, family] of decoded.families.entries()) {
    const release = releaseByFamily.get(family.familyId);
    if (release === undefined) throw new TypeError(`unknown-family:${family.familyId}`);
    if (release.familyDefinitionHash !== family.familyDefinitionHash) throw new TypeError(`family-definition-mismatch:${family.familyId}`);
    const generatedFamily = generated.families.find(value => value.familyId === family.familyId);
    if (generatedFamily === undefined || generatedFamily.sourcePlanRoot !== family.sourcePlanRoot) throw new TypeError(`generated-source-plan-root-mismatch:${family.familyId}`);
    const partitions = [family.sourcePlans, family.universeCandidates, family.outcomes, family.instancePublications, family.projectedEdges, family.declaredCoarseCapabilities, family.coarseRankable, family.coarseUnavailable, family.unrankedAdmissions, family.declaredExactCapabilities, family.ownedActions];
    partitions.forEach((partition, partitionIndex) => assertPartitionFamily(family.familyId, partition, `$.families[${index}].partitions[${partitionIndex}]`));
    const familyPlans = plansByFamily.get(family.familyId) ?? [];
    if (familyPlans.length === 0) throw new TypeError(`source-plan-partition-incomplete:${family.familyId}`);
    const declaredPlanIds = new Set(familyPlans.map(fullFamilySourcePlanIdentity));
    const observedPlanIds = new Set(family.sourcePlans.items.map(item => item.subjectKey));
    if (observedPlanIds.size !== family.sourcePlans.items.length || !sameSet(declaredPlanIds, observedPlanIds)) {
      throw new TypeError(`source-plan-partition-mismatch:${family.familyId}`);
    }
    const partition = family.candidatePartition;
    const closurePartition = nominationClosure.families.find(value => value.familyId === family.familyId);
    const observedCandidateKeys = [...family.universeCandidates.items.map(item => item.subjectKey)].sort(compareText);
    if (closurePartition === undefined || !sameJson(partition, closurePartition)
      || partition.familyDefinitionHash !== family.familyDefinitionHash
      || partition.candidateCount !== family.universeCandidates.count
      || !sameSet(new Set(partition.familyCandidateKeys), new Set(observedCandidateKeys))) {
      throw new TypeError(`candidate-partition-mismatch:${family.familyId}`);
    }
    if (family.universeCandidates.items.length === 0) {
      const authoritativePlans = familyPlans.filter(plan => (
        plan.completeness === "complete-snapshot" || plan.completeness === "contiguous-history"
      ));
      if (authoritativePlans.length === 0
        || authoritativePlans.some(plan => coverageByPlan.get(fullFamilySourcePlanIdentity(plan))?.contributesOmissionAuthority !== true)) {
        throw new TypeError(`source-coverage-omission-authority-missing:${family.familyId}`);
      }
    }
    const candidates = new Set(family.universeCandidates.items.map(item => item.subjectKey));
    if (candidates.size !== family.universeCandidates.items.length) throw new TypeError(`candidate-key-duplicate:${family.familyId}`);
    const outcomes = new Set(family.outcomes.items.map(item => item.candidateKey));
    if (!sameSet(candidates, outcomes)) throw new TypeError(`candidate-outcome-denominator-mismatch:${family.familyId}`);
    for (const outcome of family.outcomes.items) {
      if ((outcome.outcome === "verified") !== (outcome.instanceKey !== null)) throw new TypeError(`candidate-instance-binding-mismatch:${family.familyId}`);
    }
    const verifiedInstances = new Set(family.outcomes.items.flatMap(outcome => outcome.instanceKey === null ? [] : [outcome.instanceKey]));
    const publications = new Set(family.instancePublications.items.map(item => item.subjectKey));
    if (!sameSet(verifiedInstances, publications)) throw new TypeError(`verified-publication-denominator-mismatch:${family.familyId}`);
    const publishedEdgeSubjects = new Set(family.projectedEdges.items.map(item => item.subjectKey));
    if ([...publishedEdgeSubjects].some(instanceKey => !publications.has(instanceKey))) throw new TypeError(`edge-instance-mismatch:${family.familyId}`);
    if ([...publications].some(instanceKey => !publishedEdgeSubjects.has(instanceKey))) throw new TypeError(`published-instance-edge-missing:${family.familyId}`);
    const edgeIds = new Set(family.projectedEdges.items.map(item => item.itemId));
    const rankable = new Set(family.coarseRankable.items.map(item => item.subjectKey));
    const unavailable = new Set(family.coarseUnavailable.items.map(item => item.subjectKey));
    if (!disjoint(rankable, unavailable) || !sameSet(edgeIds, new Set([...rankable, ...unavailable]))) throw new TypeError(`coarse-edge-denominator-mismatch:${family.familyId}`);
    const unranked = new Set(family.unrankedAdmissions.items.map(item => item.subjectKey));
    if (!sameSet(unavailable, unranked)) throw new TypeError(`unranked-admission-denominator-mismatch:${family.familyId}`);
    if (verifiedInstances.size === 0 && (family.instancePublications.items.length !== 0 || family.projectedEdges.items.length !== 0 || rankable.size !== 0 || unavailable.size !== 0 || unranked.size !== 0)) throw new TypeError(`publication-without-verified-instance:${family.familyId}`);
  }
  allUniqueAcrossFamilies(decoded.families, family => family.universeCandidates.items.map(item => item.subjectKey), "candidate keys");
  allUniqueAcrossFamilies(decoded.families, family => family.instancePublications.items.map(item => item.subjectKey), "instance keys");
  allUniqueAcrossFamilies(decoded.families, family => family.projectedEdges.items.map(item => item.itemId), "edge ids");
  const instanceCount = decoded.families.reduce((sum, family) => sum + BigInt(family.instancePublications.count), 0n);
  const edgeCount = decoded.families.reduce((sum, family) => sum + BigInt(family.projectedEdges.count), 0n);
  if (instanceCount.toString() !== decoded.runtime.instanceCount) throw new TypeError("instance-catalog-count-mismatch");
  if (edgeCount.toString() !== decoded.runtime.edgeCount) throw new TypeError("graph-edge-count-mismatch");
}

export function deriveFullFamilyStatus(
  family: FullFamilyMatrixEntryV1,
  sourceCoverage: FullFamilySourceCoverageArtifactV1,
  generatedFamily: FullFamilyGeneratedRuntimeMetadataV1["families"][number],
): FamilyDerivedStatusV1 {
  if (family.outcomes.items.some(item => item.outcome === "retryable")) return "retryable";
  if (family.outcomes.items.some(item => item.outcome === "invalid-program")) return "invalid-program";
  if (family.universeCandidates.items.length === 0) {
    const entriesByPlan = new Map(sourceCoverage.sourceCoverage.entries.map(entry => [fullFamilySourcePlanIdentity(entry), entry]));
    const familyPlans = generatedFamily.sourcePlanRefs;
    const authoritativePlans = familyPlans.filter(plan => (
      plan.completeness === "complete-snapshot" || plan.completeness === "contiguous-history"
    ));
    if (authoritativePlans.length === 0
      || authoritativePlans.some(plan => entriesByPlan.get(fullFamilySourcePlanIdentity(plan))?.contributesOmissionAuthority !== true)) {
      return "invalid-program";
    }
    return "exact-zero-candidate";
  }
  if (family.outcomes.items.some(item => item.outcome === "unproven-rejected")) return "contract-failed";
  const verified = family.outcomes.items.filter(item => item.outcome === "verified");
  if (verified.length === 0) return family.outcomes.items.every(item => item.outcome === "chain-proven-rejected") ? "chain-proven-rejected" : "contract-failed";
  if (family.instancePublications.items.length === 0 || family.projectedEdges.items.length === 0
    || family.declaredCoarseCapabilities.items.length === 0 || family.declaredExactCapabilities.items.length === 0
    || family.ownedActions.items.length === 0) return "contract-failed";
  return "strict-attested-published";
}

export function referencedFullFamilyArtifactDigests(bundle: FullFamilyFactBundleV1): ReadonlyMap<Hash, Hash> {
  const result = new Map<Hash, Hash>();
  const add = (artifactRefId: Hash, contentSha256: Hash) => {
    const existing = result.get(artifactRefId);
    if (existing !== undefined && existing !== contentSha256) throw new TypeError("artifact ref is bound to multiple content digests");
    result.set(artifactRefId, contentSha256);
  };
  add(bundle.releaseIntent.sourceArtifactRefId, bundle.releaseIntent.sourceArtifactContentSha256);
  add(bundle.definitionCatalog.sourceArtifactRefId, bundle.definitionCatalog.sourceArtifactContentSha256);
  add(bundle.runtimeComposition.sourceArtifactRefId, bundle.runtimeComposition.sourceArtifactContentSha256);
  add(bundle.sourceCoverage.artifactRefId, bundle.sourceCoverage.contentSha256);
  add(bundle.lineage.nominationClosure.artifactRefId, bundle.lineage.nominationClosure.contentSha256);
  add(bundle.lineage.candidatePartitionProof.artifactRefId, bundle.lineage.candidatePartitionProof.contentSha256);
  add(bundle.lineage.candidateProofVerifierBinding.artifactRefId, bundle.lineage.candidateProofVerifierBinding.contentSha256);
  for (const execution of bundle.sourceCoverage.artifact.executions) {
    add(execution.executionArtifactRefId, execution.executionContentSha256);
    add(execution.evidenceArtifactRefId, execution.evidenceContentSha256);
    for (const observation of execution.physicalObservations) add(observation.artifactRefId, observation.contentSha256);
  }
  add(bundle.runtime.readyRecordArtifactRefId, bundle.runtime.readyRecordContentSha256);
  for (const family of bundle.families) {
    const evidence = [family.sourcePlans, family.universeCandidates, family.outcomes, family.instancePublications, family.projectedEdges, family.declaredCoarseCapabilities, family.coarseRankable, family.coarseUnavailable, family.unrankedAdmissions, family.declaredExactCapabilities, family.ownedActions];
    for (const partition of evidence) for (const item of partition.items) add(item.evidenceArtifactRefId, item.evidenceContentSha256);
  }
  return result;
}

export const FULL_FAMILY_SCHEMA_DESCRIPTOR = deepFreeze({
  version: "10.0.0",
  bundle: ["runtime", "releaseIntent", "definitionCatalog", "runtimeComposition", "sourceCoverage", "lineage", "familyMatrixCount", "familyMatrixRoot", "universeMatrixRoot", "instanceMatrixRoot", "edgeMatrixRoot", "families"],
  runtime: ["generationId", "releaseBindingId", "readyCutoff", "readyCutoffRoot", "actualCurrentSource", "actualCurrentSourceRoot", "recentObservationStartBlock", "recentObservationEndBlock", "recentObservationBlockCount=50", "releaseIntentRoot", "definitionCatalogRoot", "generatedRuntimeDescriptorRoot", "runtimeCompositionRoot", "sourceCoverageRoot", "candidatePartitionRoot", "nominationClosureRoot", "nominationClosureStorageHash", "candidatePartitionStorageHash", "candidatePartitionProofStorageHash", "releaseProvenanceHash", "instanceCatalogRoot", "graphRoot", "readyRecordHash", "instanceCount", "edgeCount", "readyRecordArtifactRefId", "readyRecordContentSha256"],
  releaseSet: ["sourceArtifactRefId", "sourceArtifactContentSha256", "contractRoot", "count", "entrySetRoot", "entries"],
  family: ["sourcePlanRoot", "sourcePlans", "candidatePartition", "universeCandidates", "outcomes", "instancePublications", "projectedEdges", "declaredCoarseCapabilities", "coarseRankable", "coarseUnavailable", "unrankedAdmissions", "declaredExactCapabilities", "ownedActions"],
  candidateOutcomes: [...FAMILY_CANDIDATE_OUTCOMES],
  status: "derived-not-input",
  sourceCoverage: ["content-addressed-artifact", "exact-cutoff", "execution-results-only", "execution-evidence-physical-observation-join", "discovery-validated-certificate"],
  denominatorAuthority: ["branded-generated-runtime-factory-metadata", "descriptorRoot", "definitionCatalogRoot", "per-family-sourcePlanRoot-and-refs"],
  promotionFreshness: ["four-field-ready-cutoff", "independent-four-field-actual-current-source", "five-field-observed-head", "observedHead.parentHash", "exact-age", "canonical-journal-root", "receipt-hash"],
  exactZeroCandidate: "complete-empty-partition-plus-nonempty-authoritative-source-plan-subset-all-contribute-omission-authority",
  artifactBinding: "locator-plus-normalized-ref-claim-lease-observation-plus-exact-role-payload",
});

export const FULL_FAMILY_FACT_SCHEMA_MANIFEST = Object.freeze({
  id: "aloha.full-family-facts",
  version: "10.0.0",
  schemaHash: hashDomain("aloha/schema-definition/v1", FULL_FAMILY_SCHEMA_DESCRIPTOR),
});

export const FULL_FAMILY_FACT_STORAGE_SCHEMA_MANIFEST = Object.freeze({
  id: "aloha.full-family-facts-storage",
  version: "1.0.0",
  schemaHash: hashDomain("aloha/schema-definition/v1", {
    kind: "aloha.full-family-facts-storage-v1",
    semantics: "bounded-header-plus-shared-linked-ref-page-index",
    materializedSchemaHash: FULL_FAMILY_FACT_SCHEMA_MANIFEST.schemaHash,
  }),
});

function artifactSchemaManifest(id: string, descriptor: unknown, version = "1.0.0") {
  return Object.freeze({
    id,
    version,
    schemaHash: hashDomain("aloha/schema-definition/v1", { id, version, descriptor }),
  });
}

/** Schema refs required on every independently resolved nested artifact. */
export const FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS = Object.freeze({
  artifactRefIndex: artifactSchemaManifest("aloha.full-family-artifact-ref-index", {
    kind: "aloha.full-family-artifact-ref-index-v1",
    exactBinding: ["pageCount", "firstPageRef"],
  }),
  artifactRefPage: artifactSchemaManifest("aloha.full-family-artifact-ref-page", {
    kind: "aloha.full-family-artifact-ref-page-v1",
    maxItems: 128,
    exactBinding: ["refs", "nextPageRef"],
  }),
  releaseIntent: artifactSchemaManifest("aloha.full-family-release-intent-artifact", {
    decoder: "specs/release-intent.decodeReleaseIntent",
    exactBinding: ["releaseIntentRoot", "family-denominator"],
  }),
  releaseProjection: artifactSchemaManifest("aloha.full-family-release-projection-artifact", {
    exactFields: ["schemaVersion=1", "kind", "role", "contractRoot", "count", "entrySetRoot", "entries"],
    roles: ["definition-catalog", "runtime-composition"],
  }),
  definitionCatalog: artifactSchemaManifest("aloha.generated-family-definition-catalog", {
    decoder: "generated/family-catalog.FAMILY_CATALOG",
    exactBinding: ["releaseIntentRoot", "definitionCatalogRoot", "family-denominator", "capability-and-action-owner-refs"],
  }),
  runtimeComposition: artifactSchemaManifest("aloha.generated-family-runtime-metadata", {
    decoder: "family-composition.readGeneratedFamilyRuntimeFactoryMetadata",
    exactBinding: ["releaseIntentRoot", "definitionCatalogRoot", "descriptorRoot", "family-source-plan-denominator"],
  }),
  readyRecord: artifactSchemaManifest("aloha.full-family-ready-record-artifact", {
    decoder: "decodeFullFamilyReadyRecord",
    exactBinding: ["generation", "ready-cutoff", "five-field-promotion-observed-head", "50-block-range-at-ready-cutoff", "catalog", "coverage", "candidate-partition", "exact-outcome-partition", "instance-catalog", "graph", "counts"],
  }),
  sourceCoverage: artifactSchemaManifest("aloha.full-family-source-coverage-artifact", {
    exactFields: ["schemaVersion=1", "kind", "readyRecordHash", "cutoff", "executions", "sourceCoverage"],
    validationAuthority: "specs/full-family-facts.validateFullFamilySourceCoverage",
    exactBinding: ["generated-runtime-denominator", "ready-record", "cutoff", "sourceCoverageRoot", "familyDefinitionHash", "execution", "evidence", "physical-observation", "result-partition"],
  }),
  sourceExecution: artifactSchemaManifest("aloha.source-plan-execution", {
    decoder: "specs/full-family-facts.decodeFullFamilySourcePlanExecution",
  }),
  sourceEvidence: artifactSchemaManifest("aloha.source-plan-evidence", {
    decoder: "specs/full-family-facts.decodeFullFamilySourcePlanEvidenceReceipt",
  }),
  sourcePhysicalObservation: artifactSchemaManifest("aloha.family-source-plan-physical-observation", {
    decoder: "specs/full-family-facts.decodeFullFamilySourcePlanPhysicalObservation",
  }),
  nominationClosure: artifactSchemaManifest("aloha.nomination-closure", {
    decoder: "nomination-authority.decodeNominationClosureV1",
  }),
  candidatePartitionProof: artifactSchemaManifest("aloha.candidate-partition-proof", {
    decoder: "candidate-partition-authority.decodeCandidatePartitionProofV1",
    verification: "real-ed25519-against-qualified-verifier-binding",
  }),
  candidateProofVerifierBinding: artifactSchemaManifest("aloha.full-family-candidate-proof-verifier-binding", {
    exactFields: ["schemaVersion=1", "kind", "runtimeBindingId", "releaseProvenanceHash", "releaseAuthorityRoot", "candidateReleaseCommit", "proofKeyId", "proofPublicKeyHex"],
    authority: "gate-core-verified-signed-observer-subject-ref-closure",
  }),
  evidence: artifactSchemaManifest("aloha.full-family-evidence-artifact", {
    exactFields: ["schemaVersion=1", "kind", "readyRecordHash", "role", "familyId", "itemId", "subjectKey"],
    roles: [...FULL_FAMILY_EVIDENCE_ROLES],
  }),
  generatedCapabilityRef: artifactSchemaManifest("aloha.generated-family-capability-ref", {
    decoder: "specs/full-family-facts.decodeFullFamilyStageCapabilityRef",
    exactBinding: ["familyId", "familyDefinitionHash", "capabilityId", "ownerRef"],
  }),
  generatedActionOwner: artifactSchemaManifest("aloha.full-family-action-owner-artifact", {
    decoder: "specs/full-family-facts.decodeFullFamilyActionOwnerArtifact",
    exactBinding: ["familyId", "familyDefinitionHash", "actionOwnerRef"],
    semantics: "generated-action-owner-denominator-not-live-action-execution",
  }),
  instancePublication: artifactSchemaManifest("aloha.instance-publication", {
    decoder: "specs/full-family-facts.decodeFullFamilyInstancePublication",
    exactBinding: ["familyId", "familyDefinitionHash", "instancePublicationHash", "instance-key-ref", "cutoff"],
  }),
  graphEdge: artifactSchemaManifest("aloha.persisted-graph-edge", {
    decoder: "specs/full-family-facts.decodeFullFamilyPersistedGraphEdge",
    exactBinding: ["edgeId", "owningFamilyId", "owningFamilyDefinitionHash", "instancePublicationHash", "projectionHash"],
  }),
  familySearchCoarse: artifactSchemaManifest("aloha.family-search-coarse-artifact", {
    decoder: "specs/full-family-facts.fullFamilySearchArtifactHash",
    exactBinding: ["source", "routeBindingHash", "objectiveRef", "amountHash", "payloadHash", "projectionHash", "rankKey"],
  }),
  coarseObservation: artifactSchemaManifest("aloha.family-runtime-coarse-edge-sweep-observation", {
    owner: "generated-family-runtime",
    exactKind: "aloha.family-runtime-coarse-edge-sweep-observation-v1",
  }),
  outcome: artifactSchemaManifest("aloha.full-family-outcome-artifact", {
    exactFields: [
      "schemaVersion=2", "kind", "readyRecordHash", "familyId", "itemId", "runId", "cutoff",
      "candidatePartitionRoot", "exactOutcomePartitionRoot", "candidate", "rawOutcome",
      "candidateKey", "instanceKey", "outcome",
    ],
    summary: "derived-only-from-complete-raw-candidate-final-outcome",
    rawValidation: "candidate-final-outcome.validateCandidateFinalOutcomeV1-plus-qualified-checkpoint-observer",
    outcomes: [...FAMILY_CANDIDATE_OUTCOMES],
  }, "2.0.0"),
});

export const FULL_FAMILY_FACT_LOCATOR_SCHEMA_MANIFEST = Object.freeze({
  id: "aloha.full-family-fact-locator",
  version: "1.0.0",
  schemaHash: hashDomain("aloha/schema-definition/v1", {
    exactFields: ["schemaVersion", "kind", "bundleArtifactRefId", "bundleContentSha256"],
    bundleSchemaHash: FULL_FAMILY_FACT_STORAGE_SCHEMA_MANIFEST.schemaHash,
  }),
});

export const FULL_FAMILY_FACT_SCHEMA_REF = Object.freeze({ ...FULL_FAMILY_FACT_SCHEMA_MANIFEST });
export const FULL_FAMILY_FACT_STORAGE_SCHEMA_REF = Object.freeze({ ...FULL_FAMILY_FACT_STORAGE_SCHEMA_MANIFEST });
export const FULL_FAMILY_FACT_LOCATOR_SCHEMA_REF = Object.freeze({ ...FULL_FAMILY_FACT_LOCATOR_SCHEMA_MANIFEST });
