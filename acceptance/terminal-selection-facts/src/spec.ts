import {
  encodeCanonicalJson,
  hashDomain,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  createCommonEnvelopePredicateSpecV1,
  createCommonEnvelopeRoleContractV1,
  createObserverRoleSpec,
  type ObserverRoleSpecV1,
  type PredicateSpecV1,
} from "../../../specs/qualification/src/index.ts";
import { ARTIFACT_RESOLUTION_SCHEMA_MANIFESTS } from "../../../specs/artifact-resolution/src/index.ts";
import { CORE_SCHEMA_MANIFESTS } from "../../../specs/core-envelope/src/index.ts";
import {
  TERMINAL_SELECTION_ARTIFACT_SCHEMA_REFS,
  TERMINAL_SELECTION_SCHEMA_MANIFESTS,
} from "./schema.ts";

function schemaRefOf(manifest: { readonly id: string; readonly version: string; readonly schemaHash: Hash }) {
  return Object.freeze({ id: manifest.id, version: manifest.version, schemaHash: manifest.schemaHash });
}

export const TERMINAL_SELECTION_CRITICAL_MUTATION_IDS = Object.freeze([
  "raw-sqlite-before-after-splice",
  "raw-storage-set-splice",
  "raw-selection-root-splice",
  "selection-policy-splice",
  "eligible-success-root-splice",
  "selected-terminal-splice",
  "terminal-manifest-root-splice",
  "full-family-projection-splice",
  "terminal-invocation-root-splice",
  "six-step-predicate-closure-splice",
  "process-evidence-root-splice",
  "process-append-record-splice",
  "process-anchor-splice",
  "release-process-splice",
  "serving-process-splice",
  "source-coverage-process-splice",
  "release-anchor-splice",
  "artifact-ref-splice",
  "artifact-mirror-splice",
  "missing-independent-observation",
  "cross-observation-denominator-splice",
  "producer-verdict-injection",
].sort());

export const TERMINAL_SELECTION_RAW_OBSERVER_ROLE: ObserverRoleSpecV1 = createObserverRoleSpec({
  roleId: "terminal-selection-lineage-observer",
  observationSchema: schemaRefOf(TERMINAL_SELECTION_SCHEMA_MANIFESTS.rawSelection),
  anchorPolicyDigest: hashDomain("aloha/terminal-selection/observer-anchor-policy/v1", {
    sources: [
      TERMINAL_SELECTION_ARTIFACT_SCHEMA_REFS.rawSelection,
      TERMINAL_SELECTION_ARTIFACT_SCHEMA_REFS.terminalManifest,
      TERMINAL_SELECTION_ARTIFACT_SCHEMA_REFS.fullFamilyProjection,
      TERMINAL_SELECTION_ARTIFACT_SCHEMA_REFS.processEvidence,
    ],
    joins: ["raw-to-terminal", "terminal-to-full-family-projection", "terminal-to-six-step-artifact-closure", "terminal-to-process", "same-release", "same-process"],
  }),
  observerQualificationSpecDigest: hashDomain("aloha/terminal-selection/observer-qualification-spec/v1", {
    version: "1.0.0",
    source: "readonly-sqlite-plus-content-addressed-terminal-process-observer",
  }),
  requiredCriticalMutationIds: [...TERMINAL_SELECTION_CRITICAL_MUTATION_IDS],
  minimumIndependentOracleCases: "1",
});

const TERMINAL_SELECTION_COMMON_ENVELOPE = createCommonEnvelopeRoleContractV1("aloha.terminal-selection-lineage.facts");
export const TERMINAL_SELECTION_INVOCATION_SEAL_ROLE = TERMINAL_SELECTION_COMMON_ENVELOPE.requiredObserverRoles.find(
  (role) => role.roleId === TERMINAL_SELECTION_COMMON_ENVELOPE.signedInvocationRoleId,
)!;

/** Compatibility-free descriptive alias for the raw-fact observer role. */
export const TERMINAL_SELECTION_OBSERVER_ROLE = TERMINAL_SELECTION_RAW_OBSERVER_ROLE;

export const TERMINAL_SELECTION_PREDICATE_PROGRAM_DESCRIPTOR_DIGEST = hashDomain(
  "aloha/terminal-selection/predicate-program-descriptor/v1",
  {
    version: "1.0.0",
    inputs: ["raw-sqlite-selection", "durable-terminal-manifest", "full-family-projection", "selected-process-evidence", "six-step-predicate-artifacts"],
    joins: ["selection", "terminal", "full-family-projection", "six-step-artifact-closure", "append-records", "process-anchor", "release", "serving"],
    producerVerdict: "forbidden",
  },
);

export const TERMINAL_SELECTION_ORACLE_PROGRAM_DESCRIPTOR_DIGEST = hashDomain(
  "aloha/terminal-selection/oracle-program-descriptor/v1",
  {
    version: "1.0.0",
    model: "independent-content-addressed-terminal-closure-lineage-replay",
  },
);

const claimSchemaRefs = Object.freeze([
  schemaRefOf(CORE_SCHEMA_MANIFESTS.readOnlyArtifactRef),
  schemaRefOf(ARTIFACT_RESOLUTION_SCHEMA_MANIFESTS.artifactResolutionClaim),
  schemaRefOf(ARTIFACT_RESOLUTION_SCHEMA_MANIFESTS.observedImmutableMirror),
].sort((left, right) => encodeCanonicalJson(left).localeCompare(encodeCanonicalJson(right))));

const observationSchemaRefs = Object.freeze([
  schemaRefOf(TERMINAL_SELECTION_SCHEMA_MANIFESTS.fact),
  TERMINAL_SELECTION_ARTIFACT_SCHEMA_REFS.rawSelection,
  TERMINAL_SELECTION_ARTIFACT_SCHEMA_REFS.terminalManifest,
  TERMINAL_SELECTION_ARTIFACT_SCHEMA_REFS.fullFamilyProjection,
  TERMINAL_SELECTION_ARTIFACT_SCHEMA_REFS.processEvidence,
].sort((left, right) => encodeCanonicalJson(left).localeCompare(encodeCanonicalJson(right))));

export const TERMINAL_SELECTION_PREDICATE_SPEC: PredicateSpecV1 = createCommonEnvelopePredicateSpecV1({
  predicateId: "aloha.terminal-selection-lineage.facts",
  version: "1.0.0",
  claimSchemaRefs: [...claimSchemaRefs],
  observationSchemaRefs: [...observationSchemaRefs],
  requiredObserverRoles: [TERMINAL_SELECTION_RAW_OBSERVER_ROLE],
  passRuleDigest: hashDomain("aloha/terminal-selection/pass-rule/v1", {
    rawSqliteSnapshotStable: true,
    exactMechanicalSelection: true,
    durableTerminalManifest: true,
    selectedProcessEvidence: true,
    exactLineageJoins: true,
  }),
  failRuleDigest: hashDomain("aloha/terminal-selection/fail-rule/v1", {
    noSuccessfulDryRun: true,
    selectionPolicyMismatch: true,
  }),
  invalidRuleDigest: hashDomain("aloha/terminal-selection/invalid-rule/v1", {
    missingRawOrTerminalOrProcess: true,
    unstableSqliteSnapshot: true,
    malformedOrSplicedIdentity: true,
    missingIndependentObservation: true,
  }),
  anchorPolicyDigest: hashDomain("aloha/terminal-selection/combined-anchor-policy/v1", {
    invocationSeal: TERMINAL_SELECTION_INVOCATION_SEAL_ROLE.anchorPolicyDigest,
    rawObservation: TERMINAL_SELECTION_RAW_OBSERVER_ROLE.anchorPolicyDigest,
  }),
  tolerancePolicyDigest: hashDomain("aloha/terminal-selection/tolerance-policy/v1", {
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
  criticalMutationIds: [...TERMINAL_SELECTION_CRITICAL_MUTATION_IDS],
  independentOracleKinds: ["terminal-selection-lineage-reference-model"],
  verifierQualificationSpecDigest: hashDomain("aloha/terminal-selection/verifier-qualification-spec/v1", {
    predicateProgramDescriptorDigest: TERMINAL_SELECTION_PREDICATE_PROGRAM_DESCRIPTOR_DIGEST,
    oracleProgramDescriptorDigest: TERMINAL_SELECTION_ORACLE_PROGRAM_DESCRIPTOR_DIGEST,
    independentOracleCount: "1",
  }),
});

export const TERMINAL_SELECTION_PREDICATE_SPEC_DIGEST = TERMINAL_SELECTION_PREDICATE_SPEC.specDigest;
