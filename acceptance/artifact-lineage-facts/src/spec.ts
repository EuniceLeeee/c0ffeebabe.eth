import {
  hashDomain,
  sha256Hex,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  createObserverRoleSpec,
  createPredicateSpec,
  type ObserverRoleSpecV1,
  type PredicateSpecV1,
} from "../../../specs/qualification/src/index.ts";
import {
  ARTIFACT_LINEAGE_SCHEMA_MANIFESTS,
  type SchemaRef,
} from "./schema.ts";
import { QUALIFIED_FACT_SCHEMA_MANIFESTS } from "../../../specs/qualified-facts/src/index.ts";

function schemaRefOf(manifest: { readonly id: string; readonly version: string; readonly schemaHash: Hash }): SchemaRef {
  return { id: manifest.id, version: manifest.version, schemaHash: manifest.schemaHash };
}

export const ARTIFACT_LINEAGE_PREDICATE_PROGRAM_DESCRIPTOR_DIGEST = hashDomain(
  "aloha/artifact-lineage/predicate-program-descriptor/v2",
  {
    schema: "artifact-lineage-claim-observation-raw-facts-v2",
    checks: ["outcome", "raw-hex", "hash-length", "media-schema", "locator", "lease"],
    producerWitness: "ignored",
  },
);

/** Declarative oracle identity only. The live entrypoint never imports the oracle implementation. */
export const ARTIFACT_LINEAGE_ORACLE_PROGRAM_DESCRIPTOR_DIGEST =
  sha256Hex([
    "aloha/artifact-lineage/oracle-program-descriptor/v2",
    "sha256-bytes",
    "canonical-hex-copy",
    "exact-locator-media-schema",
    "outcome-required",
    "lease-epoch-only",
    "producer-outcome-ignored",
  ].join("\0"));

export const ARTIFACT_LINEAGE_MUTATION_IDS = Object.freeze([
  "artifact-ref-length",
  "claim-mirror-splice",
  "content-mutation",
  "hostile-binary",
  "lease-boundary",
  "length-mismatch",
  "locator-splice",
  "media-mismatch",
  "missing-raw-bytes",
  "object-key-splice",
  "resolution-outcome-mismatch",
  "schema-mismatch",
 ] as const);

/** Contract mutations for the neutral process/store sidecar join. These are
 * required by the verifier, but are not falsely claimed as covered by the
 * artifact-bytes qualification corpus. */
export const ARTIFACT_LINEAGE_SIDECAR_MUTATION_IDS = Object.freeze([
  "acquisition-process-anchor",
  "acquisition-raw-range-splice",
  "sidecar-duplicate-orphan-omission",
  "sidecar-facts-hash",
  "sidecar-id",
  "sidecar-observer-implementation",
  "sidecar-schema-role-swap",
  "sidecar-wrong-observer-certificate",
  "store-epoch",
  "store-identity",
  "store-raw-ref-splice",
  "target-process-anchor",
  "target-raw-range-splice",
] as const);

export const ARTIFACT_LINEAGE_ACQUISITION_PROCESS_MUTATION_IDS = Object.freeze([
  "acquisition-process-anchor",
  "acquisition-raw-range-splice",
  "sidecar-duplicate-orphan-omission",
  "sidecar-facts-hash",
  "sidecar-id",
  "sidecar-observer-implementation",
  "sidecar-schema-role-swap",
  "sidecar-wrong-observer-certificate",
] as const);
export const ARTIFACT_LINEAGE_TARGET_PROCESS_MUTATION_IDS = Object.freeze([
  "sidecar-duplicate-orphan-omission",
  "sidecar-facts-hash",
  "sidecar-id",
  "sidecar-observer-implementation",
  "sidecar-schema-role-swap",
  "sidecar-wrong-observer-certificate",
  "target-process-anchor",
  "target-raw-range-splice",
] as const);
export const ARTIFACT_LINEAGE_INVOCATION_SEAL_MUTATION_IDS = Object.freeze([
  "invocation-binding-duplicate",
  "invocation-binding-extra",
  "invocation-binding-forged-object",
  "invocation-binding-hash",
  "invocation-binding-length",
  "invocation-binding-mirror-hash",
  "invocation-binding-mirror-media",
  "invocation-binding-mirror-schema",
  "invocation-binding-object-id",
  "invocation-binding-raw-partition-overlap",
  "invocation-binding-raw-ref",
  "invocation-binding-receipt-boundary-overlap",
  "invocation-binding-reorder",
  "invocation-binding-subject-input-overlap",
  "invocation-binding-subset",
  "invocation-binding-unsigned-derived-object",
  "invocation-expiry-boundary",
  "invocation-key-audience",
  "invocation-key-expired",
  "invocation-key-locator-capability",
  "invocation-key-revoked",
  "invocation-key-role",
  "invocation-key-unregistered",
  "invocation-ordinary-observer-role",
  "invocation-query",
  "invocation-signature-byte",
  "invocation-signature-missing",
  "invocation-signature-payload",
  "invocation-signature-random",
  "invocation-snapshot",
] as const);
export const ARTIFACT_LINEAGE_STORE_EPOCH_MUTATION_IDS = Object.freeze([
  "sidecar-duplicate-orphan-omission",
  "sidecar-facts-hash",
  "sidecar-id",
  "sidecar-observer-implementation",
  "sidecar-schema-role-swap",
  "sidecar-wrong-observer-certificate",
  "store-epoch",
  "store-identity",
  "store-raw-ref-splice",
] as const);

const observerQualificationSpecDigest = hashDomain("aloha/artifact-lineage/observer-qualification-spec/v2", {
  schema: "raw-hex-bytes-hash-length-media-schema-locator-lease",
  version: "2.0.0",
});
const verifierQualificationSpecDigest = hashDomain("aloha/artifact-lineage/verifier-qualification-spec/v2", {
  predicate: "artifact-lineage-facts",
  version: "2.0.0",
});

export const ARTIFACT_LINEAGE_OBSERVER_ROLE: ObserverRoleSpecV1 = createObserverRoleSpec({
  roleId: "artifact-lineage-raw-observer",
  observationSchema: schemaRefOf(ARTIFACT_LINEAGE_SCHEMA_MANIFESTS.observation),
  anchorPolicyDigest: hashDomain("aloha/artifact-lineage/anchor-policy/v2", {
    fields: ["locator", "immutableMirrorLocator", "observedStoreEpoch"],
  }),
  observerQualificationSpecDigest,
  requiredCriticalMutationIds: [...ARTIFACT_LINEAGE_MUTATION_IDS],
  minimumIndependentOracleCases: "1",
});

function sidecarRole(
  roleId: string,
  observationSchema: { readonly id: string; readonly version: string; readonly schemaHash: Hash },
  requiredCriticalMutationIds: readonly string[],
): ObserverRoleSpecV1 {
  return createObserverRoleSpec({
    roleId,
    observationSchema: schemaRefOf(observationSchema),
    anchorPolicyDigest: hashDomain("aloha/artifact-lineage/sidecar-anchor-policy/v1", { roleId }),
    observerQualificationSpecDigest: hashDomain("aloha/artifact-lineage/sidecar-observer-qualification-spec/v1", { roleId, version: "1.0.0" }),
    requiredCriticalMutationIds: [...requiredCriticalMutationIds],
    minimumIndependentOracleCases: "1",
  });
}

/** Generic process/store roles are part of the predicate contract, not a Family adapter. */
export const ARTIFACT_LINEAGE_ACQUISITION_PROCESS_OBSERVER_ROLE = sidecarRole(
  "acquisition-observer-process",
  QUALIFIED_FACT_SCHEMA_MANIFESTS.acquisitionProcessObservation,
  ARTIFACT_LINEAGE_ACQUISITION_PROCESS_MUTATION_IDS,
);
export const ARTIFACT_LINEAGE_TARGET_PROCESS_OBSERVER_ROLE = sidecarRole(
  "target-production-process",
  QUALIFIED_FACT_SCHEMA_MANIFESTS.targetProcessObservation,
  ARTIFACT_LINEAGE_TARGET_PROCESS_MUTATION_IDS,
);
export const ARTIFACT_LINEAGE_STORE_EPOCH_OBSERVER_ROLE = sidecarRole(
  "store-epoch-observation",
  QUALIFIED_FACT_SCHEMA_MANIFESTS.storeEpochObservation,
  ARTIFACT_LINEAGE_STORE_EPOCH_MUTATION_IDS,
);
/** Dedicated seal capability; it must never share a raw/process/store role. */
export const ARTIFACT_LINEAGE_INVOCATION_SEAL_OBSERVER_ROLE: ObserverRoleSpecV1 = createObserverRoleSpec({
  roleId: "artifact-lineage-invocation-seal-observer",
  observationSchema: schemaRefOf(QUALIFIED_FACT_SCHEMA_MANIFESTS.signedObserverInvocationSnapshot),
  anchorPolicyDigest: hashDomain("aloha/artifact-lineage/invocation-seal-anchor-policy/v1", {
    roleId: "artifact-lineage-invocation-seal-observer",
    binding: "signed-observer-invocation-snapshot",
  }),
  observerQualificationSpecDigest: hashDomain("aloha/artifact-lineage/invocation-seal-observer-qualification-spec/v1", {
    roleId: "artifact-lineage-invocation-seal-observer",
    schema: "aloha.signed-observer-invocation-snapshot",
    version: "1.0.0",
  }),
  requiredCriticalMutationIds: [...ARTIFACT_LINEAGE_INVOCATION_SEAL_MUTATION_IDS],
  minimumIndependentOracleCases: "1",
});
export const ARTIFACT_LINEAGE_OBSERVER_ROLES = Object.freeze([
  ARTIFACT_LINEAGE_ACQUISITION_PROCESS_OBSERVER_ROLE,
  ARTIFACT_LINEAGE_INVOCATION_SEAL_OBSERVER_ROLE,
  ARTIFACT_LINEAGE_OBSERVER_ROLE,
  ARTIFACT_LINEAGE_STORE_EPOCH_OBSERVER_ROLE,
  ARTIFACT_LINEAGE_TARGET_PROCESS_OBSERVER_ROLE,
] as const);

export const ARTIFACT_LINEAGE_PREDICATE_SPEC: PredicateSpecV1 = createPredicateSpec({
  predicateId: "aloha.artifact-lineage.facts",
  version: "2.0.0",
  claimSchemaRefs: [schemaRefOf(ARTIFACT_LINEAGE_SCHEMA_MANIFESTS.claim)],
  observationSchemaRefs: [
    schemaRefOf(QUALIFIED_FACT_SCHEMA_MANIFESTS.acquisitionProcessObservation),
    schemaRefOf(ARTIFACT_LINEAGE_SCHEMA_MANIFESTS.observation),
    schemaRefOf(QUALIFIED_FACT_SCHEMA_MANIFESTS.signedObserverInvocationSnapshot),
    schemaRefOf(QUALIFIED_FACT_SCHEMA_MANIFESTS.storeEpochObservation),
    schemaRefOf(QUALIFIED_FACT_SCHEMA_MANIFESTS.targetProcessObservation),
  ],
  requiredObserverRoles: [...ARTIFACT_LINEAGE_OBSERVER_ROLES],
  observerRoleSetHash: hashDomain("aloha/observer-role-set/v1", ARTIFACT_LINEAGE_OBSERVER_ROLES),
  passRuleDigest: hashDomain("aloha/artifact-lineage/pass-rule/v2", {
    rule: "content-observed outcome and raw hex bytes, hash, four-way length, media, schema, locator and lease facts all agree",
  }),
  failRuleDigest: hashDomain("aloha/artifact-lineage/fail-rule/v2", {
    rule: "raw content is valid but its content hash differs from the subject artifact",
  }),
  invalidRuleDigest: hashDomain("aloha/artifact-lineage/invalid-rule/v2", {
    rule: "missing or unbound outcome, raw observation, lease, locator, schema, media or length fact",
  }),
  anchorPolicyDigest: ARTIFACT_LINEAGE_OBSERVER_ROLE.anchorPolicyDigest,
  tolerancePolicyDigest: hashDomain("aloha/artifact-lineage/tolerance-policy/v2", { tolerance: "exact" }),
  forbiddenProducerSelectors: ["case.producerVerdict"],
  criticalMutationIds: [...new Set([...ARTIFACT_LINEAGE_MUTATION_IDS, ...ARTIFACT_LINEAGE_SIDECAR_MUTATION_IDS, ...ARTIFACT_LINEAGE_INVOCATION_SEAL_MUTATION_IDS])].sort(),
  criticalMutationSetHash: hashDomain("aloha/critical-mutation-set/v1", [...new Set([...ARTIFACT_LINEAGE_MUTATION_IDS, ...ARTIFACT_LINEAGE_SIDECAR_MUTATION_IDS, ...ARTIFACT_LINEAGE_INVOCATION_SEAL_MUTATION_IDS])].sort()),
  independentOracleKinds: ["lease-epoch", "locator", "process-anchor", "raw-bytes", "raw-range", "signed-invocation", "store-epoch"],
  verifierQualificationSpecDigest,
});

/** Stable audience policy for this predicate's dedicated invocation seal. */
export const ARTIFACT_LINEAGE_INVOCATION_AUDIENCE_HASH = hashDomain(
  "aloha/gate-core/invocation-audience/v1",
  {
    predicateSpecDigest: ARTIFACT_LINEAGE_PREDICATE_SPEC.specDigest,
    roleId: ARTIFACT_LINEAGE_INVOCATION_SEAL_OBSERVER_ROLE.roleId,
    observationSchema: ARTIFACT_LINEAGE_INVOCATION_SEAL_OBSERVER_ROLE.observationSchema,
    contractMajor: 1,
  },
);
