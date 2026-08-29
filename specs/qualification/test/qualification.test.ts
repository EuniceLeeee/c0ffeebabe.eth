import assert from "node:assert/strict";
import test from "node:test";
import {
  createObserverQualificationCertificate,
  createCommonEnvelopePredicateSpecV1,
  createCommonEnvelopeRoleContractV1,
  createObserverRoleSpec,
  createPredicateSpec,
  createQualificationRegistry,
  createObserverSigningKey,
  decodeObserverSigningKey,
  encodeObserverSigningKey,
  createVerifierQualificationCertificate,
  hashPredicateSpec,
  decodeObserverCertificate,
  decodeQualificationRegistry,
  decodeVerifierCertificate,
  encodeQualificationRegistry,
  hashObserverSigningKeySetRoot,
  hashRevokedObserverKeyIdsRoot,
  recomputeObserverSigningKeyId,
  assertPredicateCommonEnvelopeRoleContractV1,
  COMMON_ENVELOPE_ROLE_CONTRACT_VERSION,
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
  observerKeySetRoot: hashObserverSigningKeySetRoot([]),
  revokedObserverKeyIdsRoot: hashRevokedObserverKeyIdsRoot([]),
  previousRegistryRoot: null,
  governanceTrustAnchorHash: h("e"),
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
  predicateImplementationExportDigest: h("8"),
  predicateProgramDescriptorDigest: h("8"),
  oracleProgramDescriptorDigest: h("9"),
  oracleImplementationClosureDigest: h("c"),
  oracleImplementationExportDigest: h("d"),
  predicateCompositionLeafDigest: h("a"),
  gateCoreImplementationClosureDigest: h("b"),
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
    registry: "0x3b977f4f99abd223256865c8e2cb73005c351ab3483e5932bb29838063e09e0b",
    observerSigningKey: "0x580dc3a5b894ed4bd33b754d10c7bf3f538967f0658dbc9ab2ae4062f1b998dc",
    observerCertificate: "0xb900e4889358d46dc81f19768781de094f0e66a16d0cf49b51095e74c920fe35",
    verifierCertificate: "0x880ae1f0d8466872a6d210eb24bff690caf0dfd4af53525dda97354a8fbadbfd",
    membershipInput: "0x210854b3c84910c4444af24e8ed5d4c7cc3c160217d601c8e58631abed6bb2a5",
    membershipResult: "0x135b0c34d17e046bd074563b4c69cf1a6de01304e7343912b051bea9802e75ac",
  });
});

test("binary decoders accept only exact native Uint8Array and never invoke hostile traps", () => {
  const encoded = encodeQualificationRegistry(registry);
  assert.deepEqual(decodeQualificationRegistry(encoded), registry);

  assert.throws(() => decodeQualificationRegistry(Buffer.from(encoded)));
  class DerivedBytes extends Uint8Array {}
  assert.throws(() => decodeQualificationRegistry(new DerivedBytes(encoded)));

  let proxyTrapHits = 0;
  const proxy = new Proxy(encoded, {
    get: () => {
      proxyTrapHits += 1;
      throw new Error("proxy trap must not run");
    },
    getOwnPropertyDescriptor: () => {
      proxyTrapHits += 1;
      throw new Error("proxy trap must not run");
    },
    getPrototypeOf: () => {
      proxyTrapHits += 1;
      throw new Error("proxy trap must not run");
    },
    ownKeys: () => {
      proxyTrapHits += 1;
      throw new Error("proxy trap must not run");
    },
  });
  assert.throws(() => decodeQualificationRegistry(proxy));
  assert.equal(proxyTrapHits, 0);

  let lengthGetterHits = 0;
  const shadowedLength = encoded.slice();
  Object.defineProperty(shadowedLength, "length", {
    configurable: true,
    get: () => {
      lengthGetterHits += 1;
      return encoded.length;
    },
  });
  assert.throws(() => decodeQualificationRegistry(shadowedLength));
  assert.equal(lengthGetterHits, 0);
});

test("predicate contains full role semantics and role mutation coverage is exact", () => {
  assert.equal(predicate.requiredObserverRoles[0]?.observationSchema.schemaHash, role.observationSchema.schemaHash);
  assert.throws(() => createObserverRoleSpec({ ...role, requiredCriticalMutationIds: ["mutation-b", "mutation-a"] }));
  assert.throws(() => createPredicateSpec({ ...predicate, observerRoleSetHash: h("f") }));
  const { specDigest: _specDigest, ...predicatePayload } = predicate;
  assert.throws(() => createPredicateSpec({ ...predicatePayload, observationSchemaRefs: [] }), /required observer role schema is not declared/);
  assert.throws(() => decodeQualificationRegistry({ ...registry, registryId: h("f") }));
});

test("common envelope contract composes four exact versioned roles without predicate switches", () => {
  const commonInput: import("../src/index.ts").CommonEnvelopePredicateSpecInputV1 = {
    predicateId: "fixture.common-envelope",
    version: "1.0.0",
    claimSchemaRefs: predicate.claimSchemaRefs,
    observationSchemaRefs: [role.observationSchema],
    requiredObserverRoles: [role],
    passRuleDigest: h("5"),
    failRuleDigest: h("6"),
    invalidRuleDigest: h("7"),
    anchorPolicyDigest: h("8"),
    tolerancePolicyDigest: h("9"),
    forbiddenProducerSelectors: ["legacy"],
    criticalMutationIds: ["mutation-a", "mutation-b"],
    independentOracleKinds: ["chain", "math"],
    verifierQualificationSpecDigest: h("a"),
  };
  const commonPredicate = createCommonEnvelopePredicateSpecV1(commonInput);
  const contract = assertPredicateCommonEnvelopeRoleContractV1(commonPredicate);
  assert.equal(contract.version, COMMON_ENVELOPE_ROLE_CONTRACT_VERSION);
  assert.equal(contract.requiredObserverRoles.length, 4);
  assert.equal(commonPredicate.requiredObserverRoles.length, 5);
  assert.equal(
    commonPredicate.requiredObserverRoles.filter((candidate) => candidate.roleId === contract.signedInvocationRoleId).length,
    1,
  );
  assert.notEqual(
    createCommonEnvelopeRoleContractV1("fixture.other").signedInvocationRoleId,
    contract.signedInvocationRoleId,
  );

  const invocationRole = commonPredicate.requiredObserverRoles.find((candidate) => candidate.roleId === contract.signedInvocationRoleId)!;
  const mutatedRoles = commonPredicate.requiredObserverRoles.map((candidate) => candidate.roleId === invocationRole.roleId
    ? { ...candidate, anchorPolicyDigest: h("f") }
    : candidate);
  assert.throws(
    () => assertPredicateCommonEnvelopeRoleContractV1({ ...commonPredicate, requiredObserverRoles: mutatedRoles } as never),
    /common envelope role mismatch/,
  );
  assert.throws(
    () => createCommonEnvelopePredicateSpecV1({
      ...commonInput,
      requiredObserverRoles: [invocationRole],
    }),
    /collides with common envelope contract/,
  );
});

test("certificate id/payload and root mutation fail closed", () => {
  assert.throws(() => decodeObserverCertificate({ ...observer, payloadHash: h("f") }));
  assert.throws(() => decodeQualificationRegistry({ ...registry, governanceTrustAnchorHash: h("f") }));
  for (const field of [
    "predicateImplementationDigest",
    "predicateImplementationExportDigest",
    "predicateProgramDescriptorDigest",
    "oracleProgramDescriptorDigest",
    "oracleImplementationClosureDigest",
    "oracleImplementationExportDigest",
    "predicateCompositionLeafDigest",
    "gateCoreImplementationClosureDigest",
  ] as const) {
    assert.throws(() => decodeVerifierCertificate({ ...verifier, [field]: h("f") }), field);
  }
  assert.notEqual(observer.certificateId, verifier.certificateId);
});

test("every verifier program and implementation digest is non-zero and payload-bound", () => {
  const { certificateId: _certificateId, payloadHash: _payloadHash, ...payload } = verifier;
  const zeroHash = `0x${"0".repeat(64)}` as Hash;
  for (const field of [
    "predicateImplementationDigest",
    "predicateImplementationExportDigest",
    "predicateProgramDescriptorDigest",
    "oracleProgramDescriptorDigest",
    "oracleImplementationClosureDigest",
    "oracleImplementationExportDigest",
    "predicateCompositionLeafDigest",
    "gateCoreImplementationClosureDigest",
  ] as const) {
    assert.throws(
      () => createVerifierQualificationCertificate({ ...payload, [field]: zeroHash }),
      field,
    );
  }
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

test("observer signing keys are exact, content-addressed membership material", () => {
  const key = createObserverSigningKey({
    schemaVersion: 1,
    kind: "aloha.observer-signing-key",
    observerQualificationId: observer.certificateId,
    roleId: role.roleId,
    algorithm: "ed25519",
    publicKeyHex: `0x${"ab".repeat(32)}`,
    validFromRegistryEpoch: "7",
    validThroughRegistryEpoch: "9",
    audienceHash: h("f"),
  });
  assert.deepEqual(decodeObserverSigningKey(encodeObserverSigningKey(key)), key);
  assert.equal(recomputeObserverSigningKeyId(key), key.keyId);
  assert.throws(() => createObserverSigningKey({ ...key, publicKeyHex: `0x${"AB".repeat(32)}` } as never));
  assert.throws(() => createObserverSigningKey({ ...key, validFromRegistryEpoch: "10" } as never));
  assert.throws(() => createObserverSigningKey({ ...key, extra: true } as never));
  assert.throws(() => decodeObserverSigningKey({ ...key, keyId: h("0") }));
  assert.throws(() => hashObserverSigningKeySetRoot([key.keyId, key.keyId]));
  assert.equal(hashRevokedObserverKeyIdsRoot([]), hashRevokedObserverKeyIdsRoot([]));
});
