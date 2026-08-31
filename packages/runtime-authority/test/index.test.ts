import assert from "node:assert/strict";
import test from "node:test";
import { decodeCanonicalJson, hashDomain, type Hash } from "../../canonical-codec/src/index.ts";
import {
  RUNTIME_AUTHORITY_BINDING_DOMAINS_V1,
  createAdvisoryObservationRuntimeAuthorityDescriptorV1,
  createSignedReleaseRuntimeAuthorityDescriptorV1,
  decodeAdvisoryObservationRuntimeAuthorityDescriptorV1,
  decodeRuntimeAuthorityDescriptorV1,
  decodeRuntimeAuthorityProjectionV1,
  decodeSignedReleaseRuntimeAuthorityDescriptorV1,
  encodeRuntimeAuthorityDescriptorV1,
  projectRuntimeAuthorityDescriptorV1,
  runtimeAuthorityBindingHashV1,
  type AdvisoryObservationRuntimeAuthorityDescriptorV1,
  type SignedReleaseRuntimeAuthorityDescriptorV1,
} from "../src/index.ts";

const h = (value: string): Hash => hashDomain("test/runtime-authority/v1", value);
const implementationCommit = "a".repeat(40);

const signedInput = Object.freeze({
  authorityClass: "signed-release" as const,
  runtimeBindingId: h("runtime-binding"),
  releaseProvenanceHash: h("release-provenance"),
  implementationCommit,
});

const advisoryInput = Object.freeze({
  authorityClass: "advisory-observation" as const,
  observationInstanceId: h("observation-instance"),
  artifactClosureRoot: h("artifact-closure"),
  implementationCommit,
});

test("runtime authority descriptors exact-decode, canonically encode, and freeze", () => {
  const signed = createSignedReleaseRuntimeAuthorityDescriptorV1(signedInput);
  const advisory = createAdvisoryObservationRuntimeAuthorityDescriptorV1(advisoryInput);

  assert.equal(signed.authorityBindingHash, runtimeAuthorityBindingHashV1(signedInput));
  assert.equal(advisory.authorityBindingHash, runtimeAuthorityBindingHashV1(advisoryInput));
  assert.equal(
    signed.authorityBindingHash,
    hashDomain(RUNTIME_AUTHORITY_BINDING_DOMAINS_V1.signedRelease, signedInput),
  );
  assert.equal(
    advisory.authorityBindingHash,
    hashDomain(RUNTIME_AUTHORITY_BINDING_DOMAINS_V1.advisoryObservation, advisoryInput),
  );
  assert.notEqual(signed.authorityBindingHash, advisory.authorityBindingHash);
  assert.notEqual(
    signed.authorityBindingHash,
    hashDomain(RUNTIME_AUTHORITY_BINDING_DOMAINS_V1.advisoryObservation, signedInput),
  );
  assert.equal(Object.isFrozen(signed), true);
  assert.equal(Object.isFrozen(advisory), true);
  assert.deepEqual(decodeRuntimeAuthorityDescriptorV1({ ...signed }), signed);
  assert.deepEqual(decodeRuntimeAuthorityDescriptorV1({ ...advisory }), advisory);
  assert.equal(Object.values(signed).some(value => typeof value === "function"), false);
  assert.equal(Object.values(advisory).some(value => typeof value === "function"), false);

  const signedRoundTrip = decodeRuntimeAuthorityDescriptorV1(
    decodeCanonicalJson(encodeRuntimeAuthorityDescriptorV1(signed)),
  );
  const advisoryRoundTrip = decodeRuntimeAuthorityDescriptorV1(
    decodeCanonicalJson(encodeRuntimeAuthorityDescriptorV1(advisory)),
  );
  assert.deepEqual(signedRoundTrip, signed);
  assert.deepEqual(advisoryRoundTrip, advisory);
  assert.deepEqual(decodeSignedReleaseRuntimeAuthorityDescriptorV1(signed), signed);
  assert.deepEqual(decodeAdvisoryObservationRuntimeAuthorityDescriptorV1(advisory), advisory);
  assert.throws(
    () => decodeSignedReleaseRuntimeAuthorityDescriptorV1(advisory),
    /not signed-release/,
  );
  assert.throws(
    () => decodeAdvisoryObservationRuntimeAuthorityDescriptorV1(signed),
    /not advisory-observation/,
  );
});

test("descriptor binding hashes reject every signed and advisory fact mutation", () => {
  const signed = createSignedReleaseRuntimeAuthorityDescriptorV1(signedInput);
  const advisory = createAdvisoryObservationRuntimeAuthorityDescriptorV1(advisoryInput);
  const signedMutations: readonly SignedReleaseRuntimeAuthorityDescriptorV1[] = [
    Object.freeze({ ...signed, runtimeBindingId: h("other-binding") }),
    Object.freeze({ ...signed, releaseProvenanceHash: h("other-provenance") }),
    Object.freeze({ ...signed, implementationCommit: "b".repeat(40) }),
    Object.freeze({ ...signed, authorityBindingHash: h("other-signed-hash") }),
  ];
  const advisoryMutations: readonly AdvisoryObservationRuntimeAuthorityDescriptorV1[] = [
    Object.freeze({ ...advisory, observationInstanceId: h("other-instance") }),
    Object.freeze({ ...advisory, artifactClosureRoot: h("other-closure") }),
    Object.freeze({ ...advisory, implementationCommit: "c".repeat(40) }),
    Object.freeze({ ...advisory, authorityBindingHash: h("other-advisory-hash") }),
  ];
  for (const mutation of [...signedMutations, ...advisoryMutations]) {
    assert.throws(() => decodeRuntimeAuthorityDescriptorV1(mutation), /binding hash mismatch/);
  }
});

test("advisory observation is exact and cannot carry release or signing identity", () => {
  const advisory = createAdvisoryObservationRuntimeAuthorityDescriptorV1(advisoryInput);
  assert.deepEqual(Object.keys(advisory), [
    "authorityClass",
    "observationInstanceId",
    "artifactClosureRoot",
    "implementationCommit",
    "authorityBindingHash",
  ]);
  for (const [field, value] of [
    ["bindingId", h("binding-id")],
    ["runtimeBindingId", h("runtime-binding-id")],
    ["releaseProvenanceHash", h("release-provenance")],
    ["releaseAuthorityRoot", h("release-authority")],
    ["qualifiedExecutorRoot", h("qualified")],
    ["signatureHex", "0x" + "11".repeat(64)],
    ["signerKeyId", h("key")],
  ] as const) {
    assert.throws(
      () => decodeRuntimeAuthorityDescriptorV1({ ...advisory, [field]: value }),
      /unknown field/,
    );
  }
});

test("generic projection has exactly three fields and cannot absorb private descriptor facts", () => {
  const signed = createSignedReleaseRuntimeAuthorityDescriptorV1(signedInput);
  const advisory = createAdvisoryObservationRuntimeAuthorityDescriptorV1(advisoryInput);
  for (const descriptor of [signed, advisory]) {
    const projection = projectRuntimeAuthorityDescriptorV1(descriptor);
    assert.deepEqual(Object.keys(projection), [
      "authorityClass",
      "authorityBindingHash",
      "implementationCommit",
    ]);
    assert.equal(Object.isFrozen(projection), true);
    assert.deepEqual(decodeRuntimeAuthorityProjectionV1({ ...projection }), projection);
    assert.throws(
      () => decodeRuntimeAuthorityProjectionV1({ ...projection, privateFact: h("private") }),
      /unknown field/,
    );
  }
});

test("descriptor inputs are exact and class discrimination is fail-closed", () => {
  assert.throws(() => runtimeAuthorityBindingHashV1({ ...signedInput, extra: "x" }), /unknown field/);
  assert.throws(() => runtimeAuthorityBindingHashV1({ ...advisoryInput, extra: "x" }), /unknown field/);
  assert.throws(
    () => decodeRuntimeAuthorityDescriptorV1({ ...createSignedReleaseRuntimeAuthorityDescriptorV1(signedInput), authorityClass: "other" }),
    /invalid runtime authority class/,
  );
});
