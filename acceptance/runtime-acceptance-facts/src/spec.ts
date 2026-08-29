import {
  createCommonEnvelopePredicateSpecV1,
  createObserverRoleSpec,
  type ObserverRoleSpecV1,
  type PredicateSpecV1,
} from "../../../specs/qualification/src/index.ts";
import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { RUNTIME_ACCEPTANCE_SCHEMA_MANIFESTS } from "../../../specs/runtime-acceptance-facts/src/index.ts";

function schemaRefOf(manifest: { readonly id: string; readonly version: string; readonly schemaHash: Hash }) {
  return { id: manifest.id, version: manifest.version, schemaHash: manifest.schemaHash };
}

/** The exact executable mutation registry for §23.2. */
export const RUNTIME_RESTART_CRITICAL_MUTATION_IDS = Object.freeze([
  "process-anchor-before",
  "process-anchor-after",
  "same-exact-runtime-sha",
  "release-root-splice",
  "ready-root-splice",
  "graph-reuse-mode",
  "graph-lease-root-splice",
  "graph-lease-field-splice",
  "graph-lease-missing",
  "graph-root-splice",
  "systemd-executable-splice",
  "memo-reuse-accounting",
  "new-candidate-accounting",
  "invalidated-dependency-accounting",
  "retryable-accounting",
  "rejection-not-reused-accounting",
  "unchanged-old-instance-attestation",
  "single-target-probe",
  "sigterm-durable-outcomes",
  "fact-ref-locator",
  "fact-ref-content",
  "source-change-reuse",
  "producer-verdict-injection",
] as const);

/** These IDs are intentionally independent; neither leaf consumes the other. */
export const SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_CRITICAL_MUTATION_IDS = Object.freeze([
  "release-intent-root",
  "entrypoint-denominator",
  "unresolved-entrypoint-ref",
  "old-repository-load-bearing-ref",
  "ts-js-ast-closure-root",
  "generated-package-alias-root",
  "worker-child-dynamic-entrypoint-root",
  "rust-binary-closure-root",
  "solidity-deployment-abi-root",
  "deploy-systemd-exec-root",
  "executable-loaded-object-root",
  "consumer-object-lineage-root",
  "consumer-lineage-edge-deletion",
  "consumer-lineage-endpoint-replacement",
  "consumer-lineage-direction-splice",
  "consumer-lineage-orphan-endpoint",
  "runtime-log-window-root",
  "raw-denominator-deletion",
  "raw-denominator-replacement",
  "violation-hiding",
  "producer-verdict-injection",
] as const);

export const LEGACY_SHAPED_AUTHORITY_ZERO_CRITICAL_MUTATION_IDS = Object.freeze([
  "release-intent-root",
  "entrypoint-denominator",
  "unresolved-entrypoint-ref",
  "forbidden-authority-ref",
  "compatibility-facade-or-fallback-ref",
  "ts-js-ast-closure-root",
  "generated-package-alias-root",
  "worker-child-dynamic-entrypoint-root",
  "rust-binary-closure-root",
  "solidity-deployment-abi-root",
  "deploy-systemd-exec-root",
  "executable-loaded-object-root",
  "consumer-object-lineage-root",
  "consumer-lineage-edge-deletion",
  "consumer-lineage-endpoint-replacement",
  "consumer-lineage-direction-splice",
  "consumer-lineage-orphan-endpoint",
  "runtime-log-window-root",
  "raw-denominator-deletion",
  "raw-denominator-replacement",
  "violation-hiding",
  "producer-verdict-injection",
] as const);

export const RUNTIME_RESTART_OBSERVER_ROLE: ObserverRoleSpecV1 = createObserverRoleSpec({
  roleId: "runtime-restart-facts-observer",
  observationSchema: schemaRefOf(RUNTIME_ACCEPTANCE_SCHEMA_MANIFESTS.factLocator),
  anchorPolicyDigest: hashDomain("aloha/runtime-acceptance/restart-anchor-policy/v1", {
    fields: ["before.processAnchor", "after.processAnchor", "factRefs", "factRefsRoot"],
  }),
  observerQualificationSpecDigest: hashDomain("aloha/runtime-acceptance/restart-observer-qualification/v1", {
    version: "1.0.0",
    source: "content-addressed-process-diff-observer",
  }),
  requiredCriticalMutationIds: [...RUNTIME_RESTART_CRITICAL_MUTATION_IDS].sort(),
  minimumIndependentOracleCases: "1",
});

export const SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_OBSERVER_ROLE: ObserverRoleSpecV1 = createObserverRoleSpec({
  roleId: "source-repository-production-closure-zero-observer",
  observationSchema: schemaRefOf(RUNTIME_ACCEPTANCE_SCHEMA_MANIFESTS.factLocator),
  anchorPolicyDigest: hashDomain("aloha/runtime-acceptance/source-repository-closure-anchor-policy/v1", {
    fields: ["denominator", "rawDenominatorRoot", "releaseIntentRoot", "productionEntrypointDenominatorRoot", "oldRepositoryLoadBearingRefs", "unresolvedEntrypointRefs"],
  }),
  observerQualificationSpecDigest: hashDomain("aloha/runtime-acceptance/source-repository-closure-observer-qualification/v1", {
    version: "1.0.0",
    source: "source-closure-and-lineage-cross-observer",
  }),
  requiredCriticalMutationIds: [...SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_CRITICAL_MUTATION_IDS].sort(),
  minimumIndependentOracleCases: "1",
});

export const LEGACY_SHAPED_AUTHORITY_ZERO_OBSERVER_ROLE: ObserverRoleSpecV1 = createObserverRoleSpec({
  roleId: "legacy-shaped-authority-zero-observer",
  observationSchema: schemaRefOf(RUNTIME_ACCEPTANCE_SCHEMA_MANIFESTS.factLocator),
  anchorPolicyDigest: hashDomain("aloha/runtime-acceptance/legacy-shaped-authority-anchor-policy/v1", {
    fields: ["denominator", "rawDenominatorRoot", "generatedAndPackageAliasClosureRoot", "forbiddenAuthorityRefs", "compatibilityFacadeOrFallbackRefs", "unresolvedEntrypointRefs"],
  }),
  observerQualificationSpecDigest: hashDomain("aloha/runtime-acceptance/legacy-shaped-authority-observer-qualification/v1", {
    version: "1.0.0",
    source: "new-repo-authority-and-runtime-topology-cross-observer",
  }),
  requiredCriticalMutationIds: [...LEGACY_SHAPED_AUTHORITY_ZERO_CRITICAL_MUTATION_IDS].sort(),
  minimumIndependentOracleCases: "1",
});

const predicateRules = {
  claims: [],
  pass: (name: string) => hashDomain(`aloha/runtime-acceptance/${name}/pass-rule/v1`, {
    unresolvedEntrypointRefs: 0,
    violationRefs: 0,
    roots: "content-addressed-and-cross-observed",
  }),
  fail: (name: string) => hashDomain(`aloha/runtime-acceptance/${name}/fail-rule/v1`, {
    rule: "observed violation refs fail; producer verdict and log wording ignored",
  }),
  invalid: (name: string) => hashDomain(`aloha/runtime-acceptance/${name}/invalid-rule/v1`, {
    rule: "missing, unknown, malformed, unresolved, or unbound facts are invalid",
  }),
};

export const RUNTIME_RESTART_PREDICATE_PROGRAM_DESCRIPTOR_DIGEST = hashDomain("aloha/runtime-acceptance/restart-predicate-program/v1", {
  schema: "restart-facts-v1",
  checks: ["process-anchor", "exact-sha", "release-roots", "ready-graph-reuse", "producer-graph-lease-observations", "candidate-diff", "single-target", "sigterm-durable", "fact-ref-locator"],
  producerVerdict: "ignored",
});
export const RUNTIME_RESTART_ORACLE_PROGRAM_DESCRIPTOR_DIGEST = hashDomain("aloha/runtime-acceptance/restart-reference-model/v1", {
  model: "independent-recompute-of-restart-difference-durable-outcomes-and-producer-graph-lease-observations",
});
export const SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_PREDICATE_PROGRAM_DESCRIPTOR_DIGEST = hashDomain("aloha/runtime-acceptance/source-repository-closure-predicate-program/v1", {
  schema: "legacy-authority-closure-facts-v2",
  checks: ["raw-record-identities", "raw-denominator", "eleven-role-roots", "entrypoint-denominator", "old-repository-refs", "unresolved-refs", "loaded-objects", "connected-consumer-lineage", "boundary-binding-approval-manifest-package-chain", "systemd-main-child-loaded-object-chain", "sqlite-ready-main-bundle-log-chain", "runtime-log-window", "externally-signed-ordered-qualification-pair"],
});
export const SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_ORACLE_PROGRAM_DESCRIPTOR_DIGEST = hashDomain("aloha/runtime-acceptance/source-repository-closure-reference-model/v1", {
  model: "independent-raw-denominator-connected-lineage-old-repository-and-signed-qualification-pair-recomputation",
});
export const LEGACY_SHAPED_AUTHORITY_ZERO_PREDICATE_PROGRAM_DESCRIPTOR_DIGEST = hashDomain("aloha/runtime-acceptance/legacy-shaped-authority-predicate-program/v1", {
  schema: "legacy-authority-closure-facts-v2",
  checks: ["raw-record-identities", "raw-denominator", "eleven-role-roots", "entrypoint-denominator", "connected-consumer-lineage", "forbidden-authority-refs", "compatibility-fallback-refs", "unresolved-refs", "externally-signed-ordered-qualification-pair"],
});
export const LEGACY_SHAPED_AUTHORITY_ZERO_ORACLE_PROGRAM_DESCRIPTOR_DIGEST = hashDomain("aloha/runtime-acceptance/legacy-shaped-authority-reference-model/v1", {
  model: "independent-raw-denominator-connected-lineage-authority-fallback-and-signed-qualification-pair-recomputation",
});

function makePredicate(
  predicateId: string,
  role: ObserverRoleSpecV1,
  claimSchema: { readonly id: string; readonly version: string; readonly schemaHash: Hash },
  criticalMutationIds: readonly string[],
  predicateProgramDescriptorDigest: Hash,
  oracleProgramDescriptorDigest: Hash,
): PredicateSpecV1 {
  return createCommonEnvelopePredicateSpecV1({
    predicateId,
    version: "1.0.0",
    claimSchemaRefs: [schemaRefOf(claimSchema)],
    observationSchemaRefs: [role.observationSchema],
    requiredObserverRoles: [role],
    passRuleDigest: predicateRules.pass(predicateId),
    failRuleDigest: predicateRules.fail(predicateId),
    invalidRuleDigest: predicateRules.invalid(predicateId),
    anchorPolicyDigest: role.anchorPolicyDigest,
    tolerancePolicyDigest: hashDomain(`aloha/runtime-acceptance/${predicateId}/tolerance-policy/v1`, { tolerance: "exact" }),
    forbiddenProducerSelectors: ["producerVerdict", "verdict", "checks.passed", "logMessage"].sort(),
    criticalMutationIds: [...criticalMutationIds].sort(),
    independentOracleKinds: ["content-addressed-reference-model"],
    verifierQualificationSpecDigest: hashDomain(`aloha/runtime-acceptance/${predicateId}/verifier-qualification/v1`, {
      predicateProgramDescriptorDigest,
      oracleProgramDescriptorDigest,
      independentOracleCount: "1",
    }),
  });
}

export const RUNTIME_RESTART_PREDICATE_SPEC = makePredicate(
  "aloha.runtime-restart.facts",
  RUNTIME_RESTART_OBSERVER_ROLE,
  RUNTIME_ACCEPTANCE_SCHEMA_MANIFESTS.restartFacts,
  RUNTIME_RESTART_CRITICAL_MUTATION_IDS,
  RUNTIME_RESTART_PREDICATE_PROGRAM_DESCRIPTOR_DIGEST,
  RUNTIME_RESTART_ORACLE_PROGRAM_DESCRIPTOR_DIGEST,
);

export const SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_PREDICATE_SPEC = makePredicate(
  "aloha.source-repository-production-closure-zero",
  SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_OBSERVER_ROLE,
  RUNTIME_ACCEPTANCE_SCHEMA_MANIFESTS.legacyClosureFacts,
  SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_CRITICAL_MUTATION_IDS,
  SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_PREDICATE_PROGRAM_DESCRIPTOR_DIGEST,
  SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_ORACLE_PROGRAM_DESCRIPTOR_DIGEST,
);

export const LEGACY_SHAPED_AUTHORITY_ZERO_PREDICATE_SPEC = makePredicate(
  "aloha.legacy-shaped-authority-zero",
  LEGACY_SHAPED_AUTHORITY_ZERO_OBSERVER_ROLE,
  RUNTIME_ACCEPTANCE_SCHEMA_MANIFESTS.legacyClosureFacts,
  LEGACY_SHAPED_AUTHORITY_ZERO_CRITICAL_MUTATION_IDS,
  LEGACY_SHAPED_AUTHORITY_ZERO_PREDICATE_PROGRAM_DESCRIPTOR_DIGEST,
  LEGACY_SHAPED_AUTHORITY_ZERO_ORACLE_PROGRAM_DESCRIPTOR_DIGEST,
);

export const RUNTIME_RESTART_PREDICATE_SPEC_DIGEST = RUNTIME_RESTART_PREDICATE_SPEC.specDigest;
export const SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_PREDICATE_SPEC_DIGEST = SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_PREDICATE_SPEC.specDigest;
export const LEGACY_SHAPED_AUTHORITY_ZERO_PREDICATE_SPEC_DIGEST = LEGACY_SHAPED_AUTHORITY_ZERO_PREDICATE_SPEC.specDigest;
