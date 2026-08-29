import {
  createCommonEnvelopePredicateSpecV1,
  createObserverRoleSpec,
  type ObserverRoleSpecV1,
  type PredicateSpecV1,
} from "../../../specs/qualification/src/index.ts";
import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import {
  FULL_FAMILY_FACT_SCHEMA_MANIFEST,
  FULL_FAMILY_FACT_SCHEMA_REF,
  FULL_FAMILY_FACT_LOCATOR_SCHEMA_REF,
} from "./schema.ts";

const FULL_FAMILY_SEMANTIC_MUTATION_ID_LITERALS = [
  "missing-family",
  "duplicate-family",
  "unknown-family",
  "source-plan-partition-omission",
  "source-coverage-nomination-only-downgrade",
  "source-coverage-point-lookup-downgrade",
  "source-coverage-omission-bit-forgery",
  "source-coverage-declared-entry-splice",
  "source-coverage-entry-omission",
  "source-coverage-mixed-authority",
  "source-coverage-self-consistent-complete-forgery",
  "source-execution-omission",
  "source-evidence-omission",
  "source-physical-ref-splice",
  "source-execution-root-readdress",
  "generated-declared-plan-omission",
  "generated-point-plan-retyped-complete",
  "generated-definition-hash-splice",
  "generated-denominator-root-splice",
  "candidate-partition-retryable",
  "candidate-partition-invalid-program",
  "candidate-ready-record-splice",
  "candidate-partition-root-splice",
  "candidate-proof-verifier-authority-splice",
  "candidate-source-coverage-root-splice",
  "candidate-root-splice",
  "candidate-omission",
  "outcome-omission",
  "outcome-root-splice",
  "instance-root-splice",
  "edge-root-splice",
  "coarse-capability-root-splice",
  "coarse-denominator-omission",
  "exact-capability-root-splice",
  "action-owner-root-splice",
  "cross-family-item",
  "release-intent-catalog-mismatch",
  "release-intent-runtime-mismatch",
  "runtime-ready-root-splice",
  "runtime-graph-root-splice",
  "actual-current-source-root-splice",
  "actual-current-source-cross-run",
  "recent-observation-range-49",
  "recent-observation-range-51",
  "unproven-rejection",
  "strict-publication-omission",
  "evidence-artifact-ref-splice",
  "producer-verdict-injection",
] as const;

const FULL_FAMILY_READY_ARTIFACT_CRITICAL_MUTATION_ID_LITERALS = [
  "promotion-observed-head-parent-hash-omission",
] as const;

const FULL_FAMILY_OUTCOME_ARTIFACT_CRITICAL_MUTATION_ID_LITERALS = [
  "outcome-summary-raw-mismatch",
  "outcome-raw-extra-field",
  "outcome-rejection-evidence-child-omission",
  "outcome-rejection-evidence-child-splice",
  "outcome-rejection-proof-splice",
  "outcome-candidate-substitution",
  "outcome-cross-run",
  "outcome-cross-cutoff",
  "outcome-cross-candidate",
  "outcome-candidate-partition-root-splice",
  "outcome-exact-partition-root-splice",
  "outcome-release-provenance-splice",
  "outcome-release-authority-splice",
  "outcome-executor-authority-splice",
  "outcome-observer-closure-omission",
] as const;

export type FullFamilySemanticMutationId = (typeof FULL_FAMILY_SEMANTIC_MUTATION_ID_LITERALS)[number];
export type FullFamilyReadyArtifactCriticalMutationId = (typeof FULL_FAMILY_READY_ARTIFACT_CRITICAL_MUTATION_ID_LITERALS)[number];
export type FullFamilyOutcomeArtifactCriticalMutationId = (typeof FULL_FAMILY_OUTCOME_ARTIFACT_CRITICAL_MUTATION_ID_LITERALS)[number];

const FULL_FAMILY_CRITICAL_MUTATION_ID_LITERALS = [
  ...FULL_FAMILY_SEMANTIC_MUTATION_ID_LITERALS,
  ...FULL_FAMILY_READY_ARTIFACT_CRITICAL_MUTATION_ID_LITERALS,
  ...FULL_FAMILY_OUTCOME_ARTIFACT_CRITICAL_MUTATION_ID_LITERALS,
] as const;

export type FullFamilyCriticalMutationId = (typeof FULL_FAMILY_CRITICAL_MUTATION_ID_LITERALS)[number];

export const FULL_FAMILY_SEMANTIC_MUTATION_IDS: readonly FullFamilySemanticMutationId[] = Object.freeze(
  [...FULL_FAMILY_SEMANTIC_MUTATION_ID_LITERALS].sort(),
);

export const FULL_FAMILY_READY_ARTIFACT_CRITICAL_MUTATION_IDS: readonly FullFamilyReadyArtifactCriticalMutationId[] = Object.freeze(
  [...FULL_FAMILY_READY_ARTIFACT_CRITICAL_MUTATION_ID_LITERALS].sort(),
);

export const FULL_FAMILY_OUTCOME_ARTIFACT_CRITICAL_MUTATION_IDS: readonly FullFamilyOutcomeArtifactCriticalMutationId[] = Object.freeze(
  [...FULL_FAMILY_OUTCOME_ARTIFACT_CRITICAL_MUTATION_ID_LITERALS].sort(),
);

export const FULL_FAMILY_CRITICAL_MUTATION_IDS: readonly FullFamilyCriticalMutationId[] = Object.freeze(
  [...FULL_FAMILY_CRITICAL_MUTATION_ID_LITERALS].sort(),
);

export const FULL_FAMILY_OBSERVER_ROLE: ObserverRoleSpecV1 = createObserverRoleSpec({
  roleId: "full-family-facts-observer",
  observationSchema: FULL_FAMILY_FACT_LOCATOR_SCHEMA_REF,
  anchorPolicyDigest: hashDomain("aloha/full-family/observer-anchor-policy/v1", {
    exactCutoff: true,
    exactReleaseIntentDenominator: true,
    exactFamilyPartitionsAndArtifactRefs: true,
    exactReadyGenerationAndGraphBinding: true,
    authorityBoundCheckpointFullFamilyRead: true,
    completeCandidateFinalOutcomeBytes: true,
    exactCandidateAndOutcomePartitionRoots: true,
    noProducerVerdict: true,
  }),
  observerQualificationSpecDigest: hashDomain("aloha/full-family/observer-qualification-spec/v1", {
    version: "10.0.0",
    source: "generated-denominator-and-action-owner-declarations-plus-authority-bound-checkpoint-full-family-read-and-complete-candidate-final-outcome-observer",
    promotionObservedHead: "exact-five-field-canonical-header",
    outcomeIssuerAuthenticity: "qualified-observer-verifies-external-proof-not-self-consistent-hash",
  }),
  requiredCriticalMutationIds: [...FULL_FAMILY_CRITICAL_MUTATION_IDS],
  minimumIndependentOracleCases: "1",
});

export const FULL_FAMILY_PREDICATE_PROGRAM_DESCRIPTOR_DIGEST = hashDomain(
  "aloha/full-family/predicate-program-descriptor/v1",
  {
    version: "10.0.0",
    source: "branded-generated-runtime-denominator-signed-candidate-lineage-complete-raw-outcome-and-exact-partition-recomputation",
    statusRules: ["derived-strict-attested-published", "derived-exact-zero-candidate", "derived-chain-proven-rejected"],
    forbiddenSelectors: ["family-name", "producer-verdict", "expected-verdict"],
  },
);

export const FULL_FAMILY_ORACLE_PROGRAM_DESCRIPTOR_DIGEST = hashDomain(
  "aloha/full-family/oracle-program-descriptor/v1",
  {
    version: "10.0.0",
    source: "independent-generated-denominator-family-matrix-reference-model-plus-qualified-checkpoint-outcome-observer",
    model: "reference-model-for-bundle-semantics-and-qualified-observer-for-external-outcome-proof-authenticity",
  },
);

export const FULL_FAMILY_PREDICATE_SPEC: PredicateSpecV1 = createCommonEnvelopePredicateSpecV1({
  predicateId: "aloha.full-family.facts",
  version: "10.0.0",
  claimSchemaRefs: [FULL_FAMILY_FACT_SCHEMA_REF],
  observationSchemaRefs: [FULL_FAMILY_FACT_LOCATOR_SCHEMA_REF],
  requiredObserverRoles: [FULL_FAMILY_OBSERVER_ROLE],
  passRuleDigest: hashDomain("aloha/full-family/pass-rule/v1", {
    releaseIntentEqualsCatalogAndRuntime: true,
    completeDenominator: true,
    noRetryableOrInvalidProgram: true,
    statusDerivedFromExactPartitions: true,
    candidateOutcomeExactClosure: true,
    completeCandidateAndRawOutcomeExactDecode: true,
    readyCutoffAndActualCurrentSourceAreIndependentRootBoundFacts: true,
    summaryDerivedOnlyFromRawOutcomeKind: true,
    exactCandidateAndOutcomePartitionRootRecomputation: true,
    outcomeArtifactsInsideAuthenticatedObserverSubjectRefClosure: true,
    acceptedStatuses: ["strict-attested-published", "exact-zero-candidate", "chain-proven-rejected"],
    exactZeroRequiresNonemptyAuthoritativePlanSubset: true,
    nonAuthoritativePlansNeitherAuthorizeNorVetoExactZero: true,
    denominatorFromBrandedGeneratedRuntimeMetadata: true,
    sourceExecutionEvidenceAndPhysicalObservationExactJoin: true,
    ownedActionsAreGeneratedOwnerDeclarationsNotLiveExecution: true,
    neutralNominationClosureExactJoin: true,
    candidatePartitionProofEd25519Verification: true,
    verifierBindingFromSignedObserverSubjectRefClosure: true,
    candidateProofVerifierCanonicalBytesExactExternallySignedSelectedPredicateAuthorityPin: true,
  }),
  failRuleDigest: hashDomain("aloha/full-family/fail-rule/v1", {
    unprovenRejectionOrPublicationContractViolation: true,
  }),
  invalidRuleDigest: hashDomain("aloha/full-family/invalid-rule/v1", {
    rootOrCountMismatch: true,
    familySetMismatch: true,
    silentMissing: true,
    crossFamilyEvidence: true,
    orphanOrUnresolvedArtifactEvidence: true,
    sourceCoverageCertificateOrPartitionMismatch: true,
    generatedDescriptorDefinitionOrSourcePlanRootMismatch: true,
    sourceExecutionEvidenceOrPhysicalObservationOmissionOrSplice: true,
    nominationClosureOrCandidateProofOmissionOrSplice: true,
    candidateProofSignatureOrVerifierBindingMismatch: true,
    candidateProofVerifierExternalAuthorityPinMismatch: true,
    candidateFinalOutcomeWireOrLineageMismatch: true,
    candidateOrExactOutcomePartitionRootMismatch: true,
    outcomeObserverSubjectRefClosureOmission: true,
    actualCurrentSourceRootOrArtifactMismatch: true,
    readyGraphRootMismatch: true,
    promotionFreshnessObservedHeadMustBeExactFiveFieldCanonicalHeader: true,
    recentObservationNotExactly50Blocks: true,
    producerVerdictInjection: true,
  }),
  anchorPolicyDigest: hashDomain("aloha/full-family/anchor-policy/v1", {
    oneCutoff: true,
    cutoffMinus49ThroughCutoff: true,
    allReleaseSetsExact: true,
    sameReadyGenerationInstanceAndGraphRoots: true,
    sameReadyGenerationCutoffAndSourceCoverageRoot: true,
    currentSourceFromNativeSearchAuditNotReadyCutoffSubstitution: true,
    promotionFreshnessRetainsObservedHeadParentEdge: true,
  }),
  tolerancePolicyDigest: hashDomain("aloha/full-family/tolerance-policy/v1", {
    exactBytes: true,
    exactHashes: true,
    noNumericTolerance: true,
  }),
  forbiddenProducerSelectors: [
    "producer",
    "producerVerdict",
    "expectedVerdict",
    "expectedSuccess",
    "checks.passed",
    "verdict",
  ].sort(),
  criticalMutationIds: [...FULL_FAMILY_CRITICAL_MUTATION_IDS],
  independentOracleKinds: ["full-family-reference-model"],
  verifierQualificationSpecDigest: hashDomain("aloha/full-family/verifier-qualification-spec/v1", {
    schema: FULL_FAMILY_FACT_SCHEMA_MANIFEST.schemaHash,
    exactDecode: true,
    semanticRecomputation: true,
    realEd25519CandidateProofVerification: true,
    exactExternallySignedSelectedPredicateAuthorityArtifactPin: true,
    authorityBoundCheckpointFullFamilyObserver: true,
    completeCandidateFinalOutcomeWireDecode: true,
    exactCandidateAndOutcomePartitionRecomputation: true,
    externalIssuerSignatureAuthenticityIsObserverQualificationFact: true,
    exactFiveFieldPromotionObservedHeadDecode: true,
  }),
});

export const FULL_FAMILY_PREDICATE_SPEC_DIGEST: Hash = FULL_FAMILY_PREDICATE_SPEC.specDigest;
