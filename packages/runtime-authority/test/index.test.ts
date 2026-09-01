import assert from "node:assert/strict";
import test from "node:test";
import { decodeCanonicalJson, hashDomain, type Hash } from "../../canonical-codec/src/index.ts";
import {
  RUNTIME_AUTHORITY_BINDING_DOMAINS_V1,
  createUnsignedDryRunRuntimeAuthorityDescriptorV1,
  decodeRuntimeAuthorityDescriptorV1,
  decodeRuntimeAuthorityProjectionV1,
  decodeUnsignedDryRunRuntimeAuthorityDescriptorV1,
  encodeRuntimeAuthorityDescriptorV1,
  projectRuntimeAuthorityDescriptorV1,
  runtimeAuthorityBindingHashV1,
  type UnsignedDryRunRuntimeAuthorityDescriptorV1,
} from "../src/index.ts";

const h = (value: string): Hash => hashDomain("test/runtime-authority/v1", value);
const unsignedInput = Object.freeze({
  authorityClass: "dry-run" as const,
  runtimeBindingId: h("unsigned-runtime-binding"),
  implementationCommit: "b".repeat(40),
});

test("unsigned dry-run authority exact-decodes and canonically round-trips", () => {
  const descriptor = createUnsignedDryRunRuntimeAuthorityDescriptorV1(unsignedInput);
  assert.equal(descriptor.authorityBindingHash, runtimeAuthorityBindingHashV1(unsignedInput));
  assert.equal(
    descriptor.authorityBindingHash,
    hashDomain(RUNTIME_AUTHORITY_BINDING_DOMAINS_V1.dryRun, unsignedInput),
  );
  assert.equal(Object.isFrozen(descriptor), true);
  assert.deepEqual(decodeRuntimeAuthorityDescriptorV1({ ...descriptor }), descriptor);
  assert.deepEqual(decodeUnsignedDryRunRuntimeAuthorityDescriptorV1(descriptor), descriptor);
  assert.deepEqual(
    decodeRuntimeAuthorityDescriptorV1(
      decodeCanonicalJson(encodeRuntimeAuthorityDescriptorV1(descriptor)),
    ),
    descriptor,
  );
});

test("descriptor binding hash rejects every unsigned dry-run fact mutation", () => {
  const descriptor = createUnsignedDryRunRuntimeAuthorityDescriptorV1(unsignedInput);
  const mutations: readonly UnsignedDryRunRuntimeAuthorityDescriptorV1[] = [
    Object.freeze({ ...descriptor, runtimeBindingId: h("other-binding") }),
    Object.freeze({ ...descriptor, implementationCommit: "c".repeat(40) }),
    Object.freeze({ ...descriptor, authorityBindingHash: h("other-hash") }),
  ];
  for (const mutation of mutations) {
    assert.throws(() => decodeRuntimeAuthorityDescriptorV1(mutation), /binding hash mismatch/);
  }
});

test("runtime projection preserves only class, binding hash, and commit", () => {
  const projection = projectRuntimeAuthorityDescriptorV1(
    createUnsignedDryRunRuntimeAuthorityDescriptorV1(unsignedInput),
  );
  assert.deepEqual(Object.keys(projection), [
    "authorityClass",
    "authorityBindingHash",
    "implementationCommit",
  ]);
  assert.equal(projection.authorityClass, "dry-run");
  assert.equal(projection.authorityBindingHash, runtimeAuthorityBindingHashV1(unsignedInput));
  assert.equal(projection.implementationCommit, unsignedInput.implementationCommit);
  assert.equal(Object.isFrozen(projection), true);
  assert.deepEqual(decodeRuntimeAuthorityProjectionV1({ ...projection }), projection);
  assert.throws(
    () => decodeRuntimeAuthorityProjectionV1({ ...projection, privateFact: h("private") }),
    /unknown field/,
  );
  assert.throws(
    () => decodeRuntimeAuthorityProjectionV1({ ...projection, authorityClass: "advisory-observation" }),
    /expected literal/,
  );
});

test("unsigned dry-run rejects signing and release-approval facts", () => {
  for (const forbidden of [
    { signer: h("signer") },
    { signature: "not-a-signature" },
    { releaseAuthorityApprovalId: h("release-approval") },
    { releaseProvenanceHash: h("release-provenance") },
  ]) {
    assert.throws(
      () => createUnsignedDryRunRuntimeAuthorityDescriptorV1({ ...unsignedInput, ...forbidden }),
      /unknown field/,
    );
  }
});

test("descriptor inputs reject legacy advisory and all extra fields", () => {
  assert.throws(() => runtimeAuthorityBindingHashV1({ ...unsignedInput, extra: "x" }), /unknown field/);
  assert.throws(
    () => decodeRuntimeAuthorityDescriptorV1({
      authorityClass: "advisory-observation",
      observationInstanceId: h("observation-instance"),
      artifactClosureRoot: h("artifact-closure"),
      implementationCommit: "a".repeat(40),
      authorityBindingHash: h("legacy-advisory-binding"),
    }),
    /expected literal|missing field|unknown field/,
  );
});
