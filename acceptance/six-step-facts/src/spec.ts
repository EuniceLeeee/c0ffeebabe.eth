import {
  encodeCanonicalJson,
  hashDomain,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  createCommonEnvelopePredicateSpecV1,
  createObserverRoleSpec,
  type ObserverRoleSpecV1,
  type PredicateSpecV1,
} from "../../../specs/qualification/src/index.ts";
import {
  ARTIFACT_RESOLUTION_SCHEMA_MANIFESTS,
} from "../../../specs/artifact-resolution/src/index.ts";
import {
  CORE_SCHEMA_MANIFESTS,
} from "../../../specs/core-envelope/src/index.ts";
import {
  EVIDENCE_SCHEMA_MANIFESTS,
} from "../../../specs/evidence/src/index.ts";
import { SIX_STEP_SCHEMA_MANIFESTS } from "./schema.ts";

function schemaRefOf(manifest: { readonly id: string; readonly version: string; readonly schemaHash: Hash }) {
  return { id: manifest.id, version: manifest.version, schemaHash: manifest.schemaHash };
}

/** The adapter's critical mutation set is frozen and qualification-visible. */
export const SIX_STEP_CRITICAL_MUTATION_IDS = Object.freeze([
  "catalog-root-splice",
  "cutoff-splice",
  "event-bytes-mutation",
  "event-ref-splice",
  "missing-independent-observation",
  "producer-verdict-injection",
  "production-receipt-splice",
  "runtime-process-splice",
  "semantic-artifact-splice",
  "stage-ordinal-id-mismatch",
  "stage-parent-id-mismatch",
  "stage-parent-output-mismatch",
  "stage-scope-mismatch",
  "stage1-stage2-omission",
  "stage2-ready-root-mismatch",
  "stage3-route-binding-order",
  "stage3-route-binding-root",
  "stage4-current-source-splice",
  "stage4-fallback",
  "stage5-effect-transport-splice",
  "stage5-fallback",
  "stage5-observation-pair-splice",
  "stage5-program-splice",
  "stage6-economic-arithmetic",
  "stage6-economic-receipt-root",
  "stage6-economic-splice",
  "stage6-economic-valuation-owner-splice",
  "stage6-obligation-receipt-splice",
  "stage6-repayment-conservation-splice",
  "stage6-safety-route-proof-splice",
  "stage6-simulation-splice",
  "stage6-standing-position-proof-splice",
  "stage6-standing-position-splice",
] as const);

export const SIX_STEP_OBSERVER_ROLE: ObserverRoleSpecV1 = createObserverRoleSpec({
  roleId: "six-step-evidence-observer",
  observationSchema: schemaRefOf(EVIDENCE_SCHEMA_MANIFESTS.event),
  anchorPolicyDigest: hashDomain("aloha/six-step/observer-anchor-policy/v1", {
    allowedLocatorKinds: ["content-object", "file-range", "checkpoint-record"],
    eventSchema: schemaRefOf(EVIDENCE_SCHEMA_MANIFESTS.event),
  }),
  observerQualificationSpecDigest: hashDomain("aloha/six-step/observer-qualification-spec/v1", {
    version: "1.0.0",
    source: "independent-content-addressed-event-observer",
  }),
  requiredCriticalMutationIds: [...SIX_STEP_CRITICAL_MUTATION_IDS],
  minimumIndependentOracleCases: "1",
});

const sixStepVerifierQualificationSpecDigest = hashDomain(
  "aloha/six-step/verifier-qualification-spec/v1",
  {
    version: "1.0.0",
    rules: [
      "decode-event-semantic-artifact-and-production-receipt-from-claims",
      "recompute-all-identities-and-content-addresses",
      "verify-stage-scope-and-parent-dag",
      "verify-ready-before-planner-and-linear-tail",
      "verify-current-source-exact-execution-and-final-sim-facts",
      "reject-producer-verdict-and-expected-success-fields",
    ],
  },
);

export const SIX_STEP_PREDICATE_PROGRAM_DESCRIPTOR_DIGEST = hashDomain(
  "aloha/six-step/predicate-program-descriptor/v1",
  {
    version: "1.0.0",
    stages: [
      "universe_instance",
      "edge_ready_generation",
      "planner_consumption",
      "current_source_exact",
      "execution_program",
      "final_simulation",
    ],
    source: "claims-only-event-decoder",
    producerVerdict: "forbidden",
  },
);

/** Declarative oracle identity; this export is qualification-only. */
export const SIX_STEP_ORACLE_PROGRAM_DESCRIPTOR_DIGEST = hashDomain(
  "aloha/six-step/oracle-program-descriptor/v1",
  {
    version: "1.0.0",
    model: "independent-dag-replay",
    source: ["event-id", "artifact-id", "receipt-id", "parent-output", "stage-facts"],
  },
);

export const SIX_STEP_CLAIM_SCHEMA_REFS = Object.freeze([
  schemaRefOf(CORE_SCHEMA_MANIFESTS.readOnlyArtifactRef),
  schemaRefOf(ARTIFACT_RESOLUTION_SCHEMA_MANIFESTS.artifactResolutionClaim),
  schemaRefOf(ARTIFACT_RESOLUTION_SCHEMA_MANIFESTS.observedImmutableMirror),
].sort((left, right) => encodeCanonicalJson(left).localeCompare(encodeCanonicalJson(right))));

export const SIX_STEP_OBSERVATION_SCHEMA_REFS = Object.freeze([
  schemaRefOf(EVIDENCE_SCHEMA_MANIFESTS.event),
  schemaRefOf(SIX_STEP_SCHEMA_MANIFESTS.eventFact),
  schemaRefOf(SIX_STEP_SCHEMA_MANIFESTS.stageFacts),
].sort((left, right) => encodeCanonicalJson(left).localeCompare(encodeCanonicalJson(right))));

export const SIX_STEP_PREDICATE_SPEC: PredicateSpecV1 = createCommonEnvelopePredicateSpecV1({
  predicateId: "aloha.six-step.facts",
  version: "1.0.0",
  claimSchemaRefs: [...SIX_STEP_CLAIM_SCHEMA_REFS],
  observationSchemaRefs: [...SIX_STEP_OBSERVATION_SCHEMA_REFS],
  requiredObserverRoles: [SIX_STEP_OBSERVER_ROLE],
  passRuleDigest: hashDomain("aloha/six-step/pass-rule/v1", {
    allSixStages: true,
    verifiedStage1: true,
    successfulStage2To6: true,
    exactParentDag: true,
  }),
  failRuleDigest: hashDomain("aloha/six-step/fail-rule/v1", {
    completeChainButTerminalFailure: true,
  }),
  invalidRuleDigest: hashDomain("aloha/six-step/invalid-rule/v1", {
    missingClaim: true,
    missingObservation: true,
    malformedOrSplicedIdentity: true,
    missingStageOrParent: true,
  }),
  anchorPolicyDigest: hashDomain("aloha/six-step/anchor-policy/v1", {
    sameCutoff: true,
    sameGenerationGraphForProducerTail: true,
    sameProcessForProducerTail: true,
  }),
  tolerancePolicyDigest: hashDomain("aloha/six-step/tolerance-policy/v1", {
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
  criticalMutationIds: [...SIX_STEP_CRITICAL_MUTATION_IDS],
  independentOracleKinds: ["six-step-reference-model"],
  verifierQualificationSpecDigest: sixStepVerifierQualificationSpecDigest,
});

export const SIX_STEP_SCHEMA_REFINEMENT_DIGEST = hashDomain(
  "aloha/six-step/schema-refinement/v1",
  {
    eventFactSchema: SIX_STEP_SCHEMA_MANIFESTS.eventFact.schemaHash,
    stageFactsSchema: SIX_STEP_SCHEMA_MANIFESTS.stageFacts.schemaHash,
    evidenceEventSchema: EVIDENCE_SCHEMA_MANIFESTS.event.schemaHash,
  },
);
