import {
  hashDomain,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  COMMON_ENVELOPE_ACQUISITION_MUTATION_IDS,
  COMMON_ENVELOPE_INVOCATION_MUTATION_IDS,
  COMMON_ENVELOPE_STORE_MUTATION_IDS,
  COMMON_ENVELOPE_TARGET_MUTATION_IDS,
  createCommonEnvelopePredicateSpecV1,
  createCommonEnvelopeRoleContractV1,
  createObserverRoleSpec,
  type ObserverRoleSpecV1,
  type PredicateSpecV1,
} from "../../../specs/qualification/src/index.ts";
import {
  ARTIFACT_LINEAGE_SCHEMA_MANIFESTS,
  type SchemaRef,
} from "./schema.ts";
export { ARTIFACT_LINEAGE_ORACLE_PROGRAM_DESCRIPTOR_DIGEST } from "./oracle-descriptor.ts";
import { ARTIFACT_LINEAGE_ORACLE_PROGRAM_DESCRIPTOR_DIGEST } from "./oracle-descriptor.ts";

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

export const ARTIFACT_LINEAGE_ACQUISITION_PROCESS_MUTATION_IDS = COMMON_ENVELOPE_ACQUISITION_MUTATION_IDS;
export const ARTIFACT_LINEAGE_TARGET_PROCESS_MUTATION_IDS = COMMON_ENVELOPE_TARGET_MUTATION_IDS;
export const ARTIFACT_LINEAGE_INVOCATION_SEAL_MUTATION_IDS = COMMON_ENVELOPE_INVOCATION_MUTATION_IDS;
export const ARTIFACT_LINEAGE_STORE_EPOCH_MUTATION_IDS = COMMON_ENVELOPE_STORE_MUTATION_IDS;

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

const ARTIFACT_LINEAGE_COMMON_ENVELOPE = createCommonEnvelopeRoleContractV1("aloha.artifact-lineage.facts");

function requireCommonRole(roleId: string): ObserverRoleSpecV1 {
  const role = ARTIFACT_LINEAGE_COMMON_ENVELOPE.requiredObserverRoles.find((candidate) => candidate.roleId === roleId);
  if (role === undefined) throw new TypeError(`artifact-lineage common role missing: ${roleId}`);
  return role;
}

/** Generic process/store roles are shared by every GateCore predicate. */
export const ARTIFACT_LINEAGE_ACQUISITION_PROCESS_OBSERVER_ROLE = requireCommonRole("acquisition-observer-process");
export const ARTIFACT_LINEAGE_TARGET_PROCESS_OBSERVER_ROLE = requireCommonRole("target-production-process");
export const ARTIFACT_LINEAGE_STORE_EPOCH_OBSERVER_ROLE = requireCommonRole("store-epoch-observation");
export const ARTIFACT_LINEAGE_INVOCATION_SEAL_OBSERVER_ROLE = requireCommonRole(ARTIFACT_LINEAGE_COMMON_ENVELOPE.signedInvocationRoleId);
export const ARTIFACT_LINEAGE_OBSERVER_ROLES = Object.freeze([
  ...ARTIFACT_LINEAGE_COMMON_ENVELOPE.requiredObserverRoles,
  ARTIFACT_LINEAGE_OBSERVER_ROLE,
].sort((left, right) => left.roleId.localeCompare(right.roleId)));

export const ARTIFACT_LINEAGE_PREDICATE_SPEC: PredicateSpecV1 = createCommonEnvelopePredicateSpecV1({
  predicateId: "aloha.artifact-lineage.facts",
  version: "2.0.0",
  claimSchemaRefs: [schemaRefOf(ARTIFACT_LINEAGE_SCHEMA_MANIFESTS.claim)],
  observationSchemaRefs: [
    schemaRefOf(ARTIFACT_LINEAGE_SCHEMA_MANIFESTS.observation),
  ],
  requiredObserverRoles: [ARTIFACT_LINEAGE_OBSERVER_ROLE],
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
  criticalMutationIds: [...ARTIFACT_LINEAGE_MUTATION_IDS],
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
