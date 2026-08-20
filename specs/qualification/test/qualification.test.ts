import assert from "node:assert/strict";
import test from "node:test";
import {
  createObserverQualificationCertificate,
  createObserverRoleSpec,
  createPredicateSpec,
  createQualificationRegistry,
  createVerifierQualificationCertificate,
  hashPredicateSpec,
  decodeObserverCertificate,
  decodeQualificationRegistry,
  QUALIFICATION_SCHEMA_MANIFESTS,
  type Hash,
} from "../src/index.ts";
import { hashDomain } from "../../../packages/canonical-codec/src/index.ts";

const h = (digit: string): Hash => (`0x${digit.repeat(64)}`) as Hash;
const role: import("../src/index.ts").ObserverRoleSpecV1 = createObserverRoleSpec({
  roleId: "chain-observer",
  observationSchema: { id: "observed-facts", version: "1.0.0", schemaHash: h("1") },
  anchorPolicyDigest: h("2"),
  observerQualificationSpecDigest: h("3"),
  requiredCriticalMutationIds: ["mutation-a", "mutation-b"],
  minimumIndependentOracleCases: "1",
});
const predicate = createPredicateSpec({
  predicateId: "strict-swap",
  version: "1.0.0",
  claimSchemaRefs: [{ id: "claim", version: "1.0.0", schemaHash: h("4") }],
  observationSchemaRefs: [role.observationSchema],
  requiredObserverRoles: [role],
  observerRoleSetHash: hashDomain("aloha/observer-role-set/v1", [role]),
  passRuleDigest: h("5"),
  failRuleDigest: h("6"),
  invalidRuleDigest: h("7"),
  anchorPolicyDigest: h("8"),
  tolerancePolicyDigest: h("9"),
  forbiddenProducerSelectors: ["legacy"],
  criticalMutationIds: ["mutation-a", "mutation-b"],
  criticalMutationSetHash: hashDomain("aloha/critical-mutation-set/v1", ["mutation-a", "mutation-b"]),
  independentOracleKinds: ["chain", "math"],
  verifierQualificationSpecDigest: h("a"),
});

const registry = createQualificationRegistry({
  schemaVersion: 1,
  kind: "aloha.qualification-registry",
  epoch: "7",
  trustedIssuerSetRoot: h("b"),
  certificateSetRoot: h("c"),
  revokedCertificateIdsRoot: h("d"),
  previousRegistryRoot: null,
  governanceApprovalHash: h("e"),
});

const observer = createObserverQualificationCertificate({
  schemaVersion: 1,
  kind: "aloha.observer-qualification",
  qualificationSpecDigest: role.observerQualificationSpecDigest,
  observerImplementationDigest: h("f"),
  observedSchemaIds: [role.observationSchema],
  qualifiedLocatorKinds: ["chain-object"],
  anchorValidationMethodDigest: h("1"),
  positiveCaseRoot: h("2"),
  negativeCaseRoot: h("3"),
  invalidCaseRoot: h("4"),
  declaredCriticalMutationIds: role.requiredCriticalMutationIds,
  rejectedOrInvalidMutationIds: role.requiredCriticalMutationIds,
  independentOracleCaseRoot: h("5"),
  independentOracleCaseCount: "1",
  issuerId: "issuer-a",
  issuedAtRegistryEpoch: registry.epoch,
  verdict: "qualified",
});

const verifier = createVerifierQualificationCertificate({
  schemaVersion: 1,
  kind: "aloha.verifier-qualification",
  qualificationSpecDigest: h("6"),
  predicateSpecDigest: predicate.specDigest,
  predicateImplementationDigest: h("7"),
  observerQualificationIds: [observer.certificateId],
  requiredObserverRoles: [{ ...role, observerQualificationId: observer.certificateId }],
  caseSetRoot: h("8"),
  declaredCriticalMutationIds: predicate.criticalMutationIds,
  rejectedOrInvalidMutationIds: predicate.criticalMutationIds,
  independentOracleCaseRoot: h("9"),
  independentOracleCaseCount: "1",
  oldReferenceCaseCount: "0",
  counterexampleRoot: h("a"),
  issuerId: "issuer-a",
  issuedAtRegistryEpoch: registry.epoch,
  verdict: "qualified",
});

test("qualification manifests are exact content-addressed schemas", () => {
  assert.deepEqual(Object.fromEntries(Object.entries(QUALIFICATION_SCHEMA_MANIFESTS).map(([key, manifest]) => [key, manifest.schemaHash])), {
    observerRole: "0x6f155b672917c0f60a7c40778106387635f295c31ebe481366f25506b1a0b812",
    predicate: "0xad0fc85efe8a119c42dac6ee6716ea6bc36541569d385dcb9fb11ef19085b6e8",
    registry: "0x4eded5bef651ec0a180d2b6c99e51d6fa9e05907c9d0b9a8d37e1dbf54836d45",
    observerCertificate: "0xb900e4889358d46dc81f19768781de094f0e66a16d0cf49b51095e74c920fe35",
    verifierCertificate: "0x6d6f86e5bd998803173e967ddc6629cb6d6c42f91006b70753811b9bba2e4e75",
    membershipInput: "0xd65b84213a03ee4aad5deeff4d9b9feffe0cd50106a939dc20d4c48220beb575",
    membershipResult: "0x135b0c34d17e046bd074563b4c69cf1a6de01304e7343912b051bea9802e75ac",
  });
});

test("predicate contains full role semantics and role mutation coverage is exact", () => {
  assert.equal(predicate.requiredObserverRoles[0]?.observationSchema.schemaHash, role.observationSchema.schemaHash);
  assert.throws(() => createObserverRoleSpec({ ...role, requiredCriticalMutationIds: ["mutation-b", "mutation-a"] }));
  assert.throws(() => createPredicateSpec({ ...predicate, observerRoleSetHash: h("f") }));
  assert.throws(() => decodeQualificationRegistry({ ...registry, registryId: h("f") }));
});

test("certificate id/payload and root mutation fail closed", () => {
  assert.throws(() => decodeObserverCertificate({ ...observer, payloadHash: h("f") }));
  assert.throws(() => decodeQualificationRegistry({ ...registry, governanceApprovalHash: h("f") }));
  assert.notEqual(observer.certificateId, verifier.certificateId);
});

test("creators perform exact structural decode before hashing", () => {
  assert.throws(() => createObserverRoleSpec({ ...role, extra: true } as never));
  assert.throws(() => {
    const { specDigest: _specDigest, ...payload } = predicate;
    return createPredicateSpec({ ...payload, extra: true } as never);
  });
  assert.throws(() => createQualificationRegistry({ ...registry, extra: true } as never));
  assert.throws(() => createObserverQualificationCertificate({ ...observer, extra: true } as never));
  assert.throws(() => createVerifierQualificationCertificate({ ...verifier, extra: true } as never));
  let getterHits = 0;
  const getterRole = { ...role } as Record<string, unknown>;
  Object.defineProperty(getterRole, "roleId", { enumerable: true, get: () => { getterHits += 1; return role.roleId; } });
  assert.throws(() => createObserverRoleSpec(getterRole as never));
  assert.equal(getterHits, 0);

  const getterPredicate = { ...predicate } as Record<string, unknown>;
  Object.defineProperty(getterPredicate, "predicateId", { enumerable: true, get: () => { getterHits += 1; return predicate.predicateId; } });
  assert.throws(() => hashPredicateSpec(getterPredicate as never));
  assert.equal(getterHits, 0);
});
