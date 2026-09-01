import {
  createCommonEnvelopePredicateSpecV1,
  createObserverRoleSpec,
  type ObserverRoleSpecV1,
  type PredicateSpecV1,
} from "../../../specs/qualification/src/index.ts";
import { encodeCanonicalJson, hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { PERFORMANCE_SCHEMA_MANIFESTS_ALL } from "./schema.ts";

function schemaRefOf(manifest: { readonly id: string; readonly version: string; readonly schemaHash: Hash }) {
  return { id: manifest.id, version: manifest.version, schemaHash: manifest.schemaHash };
}

/** Every id has an executable mutator in mutations.ts; none are documentation-only. */
export const PERFORMANCE_CRITICAL_MUTATION_IDS = Object.freeze([
  "candidate-path-sample-missing",
  "candidate-set-root-splice",
  "budget-field-missing",
  "cross-generation",
  "cross-log-inode",
  "cross-pid",
  "duration-tamper",
  "empty-denominator",
  "excluded-head",
  "generation-root-splice",
  "generation-segment-gap",
  "generation-segment-reorder",
  "generation-segment-rejoin",
  "generation-segment-root-forgery",
  "head-101",
  "head-99",
  "head-ordinal-duplicate",
  "head-ordinal-gap",
  "head-parent-splice",
  "missing-head-first",
  "missing-head-last",
  "missing-head-middle",
  "missing-timing",
  "no-op-mutator",
  "orphan-last-write",
  "orphan-new-ordinal",
  "permit-conservation",
  "percentile-interpolation",
  "profile-root-splice",
  "queue-telemetry-missing",
  "replacement-ordinal-splice",
  "terminal-duplicate",
  "six-step-duplicate-success",
  "six-step-not-run-root",
  "six-step-correlation-splice",
  "six-step-rejected",
  "timing-count-mismatch",
  "unknown-outcome",
  "unhealthy-filtered",
  "window-start-shift",
] as const).slice().sort() as readonly string[];

export type PerformanceCriticalMutationId = (typeof PERFORMANCE_CRITICAL_MUTATION_IDS)[number];

const schemaRefs = Object.values(PERFORMANCE_SCHEMA_MANIFESTS_ALL)
  .map(schemaRefOf)
  .sort((left, right) => encodeCanonicalJson(left).localeCompare(encodeCanonicalJson(right)));

export const PERFORMANCE_OBSERVER_ROLE: ObserverRoleSpecV1 = createObserverRoleSpec({
  roleId: "performance-facts-observer",
  observationSchema: schemaRefOf(PERFORMANCE_SCHEMA_MANIFESTS_ALL.event),
  anchorPolicyDigest: hashDomain("aloha/performance/observer-anchor-policy/v1", {
    exactProcessLogAnchor: true,
    exactOrdinalServingGenerationGraphReadyCoverage: true,
    maximalContiguousGenerationSegments: true,
    contentAddressedRawFacts: true,
    noCallerWindowEnd: true,
  }),
  observerQualificationSpecDigest: hashDomain("aloha/performance/observer-qualification-spec/v1", {
    version: "2.0.0",
    source: "independent-content-addressed-performance-observer",
  }),
  requiredCriticalMutationIds: [...PERFORMANCE_CRITICAL_MUTATION_IDS],
  minimumIndependentOracleCases: "1",
});

export const PERFORMANCE_PREDICATE_PROGRAM_DESCRIPTOR_DIGEST = hashDomain(
  "aloha/performance/predicate-program-descriptor/v1",
  {
    version: "2.0.0",
    algorithm: "nearest-rank",
    denominator: "100-contiguous-canonical-ordinals",
    source: "opaque-owner-issued-terminal-evidence-and-raw-performance-fact-recomputation",
    producerVerdict: "forbidden",
  },
);

export const PERFORMANCE_ORACLE_PROGRAM_DESCRIPTOR_DIGEST = hashDomain(
  "aloha/performance/oracle-program-descriptor/v1",
  {
    version: "2.0.0",
    model: "independent-performance-reference-replay",
    source: ["commitment", "heads", "lineages", "candidate-sets", "metrics", "terminals", "generation-segments", "window-receipt"],
  },
);

const verifierQualificationSpecDigest = hashDomain("aloha/performance/verifier-qualification-spec/v1", {
  version: "2.0.0",
  rules: [
    "decode-all-raw-facts",
    "recompute-ordered-roots",
    "require-same-release-runtime-process-log-profile",
    "require-exact-per-head-serving-and-maximal-contiguous-generation-segments",
    "require-exact-100-denominator",
    "require-nearest-rank-no-interpolation",
    "require-all-declared-budgets-and-hard-deadlines",
    "require-exactly-one-verified-dry-run-candidate",
    "derive-verdict-from-facts",
  ],
});

export const PERFORMANCE_CLAIM_SCHEMA_REFS = Object.freeze(schemaRefs);
export const PERFORMANCE_OBSERVATION_SCHEMA_REFS = Object.freeze(schemaRefs);

export const PERFORMANCE_PREDICATE_SPEC: PredicateSpecV1 = createCommonEnvelopePredicateSpecV1({
  predicateId: "aloha.performance.facts",
  version: "2.0.0",
  claimSchemaRefs: [...PERFORMANCE_CLAIM_SCHEMA_REFS],
  observationSchemaRefs: [...PERFORMANCE_OBSERVATION_SCHEMA_REFS],
  requiredObserverRoles: [PERFORMANCE_OBSERVER_ROLE],
  passRuleDigest: hashDomain("aloha/performance/pass-rule/v1", {
    exact100Healthy: true,
    completeNoCandidateOrCandidateTerminal: true,
    requiredSixStepDryRunCandidateCount: "1",
    sixStepBindsHeadWindowCandidateCorrelation: true,
    absoluteBudgetsIncludingCoarseAndFinalSimulation: true,
  }),
  failRuleDigest: hashDomain("aloha/performance/fail-rule/v1", {
    anyUnhealthyTerminal: true,
    percentileOrBudgetExceeded: true,
  }),
  invalidRuleDigest: hashDomain("aloha/performance/invalid-rule/v1", {
    missingDuplicateOrSplicedFacts: true,
    missingTimingOrDenominatorMismatch: true,
    nonEmptyExcludedHeads: true,
    callerVerdictIgnored: true,
  }),
  anchorPolicyDigest: hashDomain("aloha/performance/anchor-policy/v1", {
    windowStartBeforeOrdinalOne: true,
    sameProcessPidStartLogInode: true,
    exactPerHeadGenerationGraphReadyCoverage: true,
    maximalOrdinalContiguousGenerationSegments: true,
    sameProviderHardware: true,
  }),
  tolerancePolicyDigest: hashDomain("aloha/performance/tolerance-policy/v1", {
    integerMicroseconds: true,
    nearestRankNoInterpolation: true,
    exactRoots: true,
  }),
  forbiddenProducerSelectors: [
    "healthy",
    "verdict",
    "expectedVerdict",
    "expectedSuccess",
    "checks.passed",
    "windowEndMonotonicNs",
    "percentile",
    "sixStepCompleted",
    "evidenceRoot",
  ].sort(),
  criticalMutationIds: [...PERFORMANCE_CRITICAL_MUTATION_IDS],
  independentOracleKinds: ["performance-reference-model-v2"],
  verifierQualificationSpecDigest,
});

export const PERFORMANCE_PREDICATE_SPEC_DIGEST = PERFORMANCE_PREDICATE_SPEC.specDigest;
