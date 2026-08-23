import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { hashQualifiedExecutorRegistryEntry, hashQualifiedExecutorRegistryRoot, type RuntimeReleaseBindingPayloadV1 } from "../../../specs/release-authority/src/index.ts";
import { runtimeReleaseSigningRequestV1, verifySignedRuntimeReleaseBindingV1 } from "../src/index.ts";
import { prepareRuntimeReleaseBindingPayloadV1 } from "../src/index.ts";
import { evaluateQualifiedLineageFixture } from "../../../acceptance/gate-core/test/lineage-fixture.test.ts";

const h = (value: string): Hash => hashDomain("test/runtime-release-packager", value);
const executor = {
  executorKind: "revm", engineBuildFingerprint: h("engine"), executableFingerprint: h("executable"),
  closureFingerprint: h("closure"), protocolFingerprint: h("protocol"), schemaFingerprint: h("schema"),
  releaseRoleManifestRoot: h("manifest"), candidateCommit: "2".repeat(40),
};
const payload: RuntimeReleaseBindingPayloadV1 = {
  schemaVersion: 1, kind: "aloha.runtime-release-binding",
  acceptanceCertificate: { certificateId: h("certificate"), payloadHash: h("certificate-payload"), verdict: "pass" },
  releaseAuthorityApprovalId: h("approval"), releaseAuthorityApprovalPayloadHash: h("approval-payload"),
  authorityPinDigest: h("pin"), externalTrustAnchorRoot: h("anchor"), externalIssuerKeySetRoot: h("keys"),
  qualificationRegistryApprovalId: h("registry-approval"), qualificationRegistryRoot: h("qualification-registry"),
  qualificationEpoch: "1", qualificationAudienceHash: h("audience"), predicateCompositionRootDigest: h("composition"),
  gateCoreRuntimeClosureDigest: h("runtime"), gateCoreImplementationClosureDigest: h("core"),
  qualifiedExecutorRegistryRoot: hashQualifiedExecutorRegistryRoot([executor]),
  selectedExecutorLeafHash: hashQualifiedExecutorRegistryEntry(executor), selectedExecutor: executor,
  releaseRoleManifestRoot: executor.releaseRoleManifestRoot, candidateReleaseCommit: executor.candidateCommit,
  workerEpoch: "epoch-1", executorSessionHash: h("session"), frameworkAuthorityRoot: h("framework"),
  executorAuthorityRoot: h("executor-authority"), releaseAuthorityRoot: h("release-authority"),
  attestationProofIssuerKeyId: h("attestation-proof"), candidatePartitionProofIssuerKeyId: h("partition-proof"),
};

function rawPublicKeyHex(publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"]): `0x${string}` {
  const der = publicKey.export({ format: "der", type: "spki" });
  return `0x${der.subarray(der.length - 32).toString("hex")}`;
}

test("packager emits exact bytes and verifies an external Ed25519 signature without owning a signer", () => {
  const keys = generateKeyPairSync("ed25519");
  const signerKeyId = h("signer");
  const pin = { signerKeyId, publicKeyHex: rawPublicKeyHex(keys.publicKey) };
  const bytes = runtimeReleaseSigningRequestV1(payload, signerKeyId);
  const signatureHex = `0x${sign(null, Buffer.from(bytes), keys.privateKey).toString("hex")}` as `0x${string}`;
  const binding = verifySignedRuntimeReleaseBindingV1(payload, pin, signatureHex);
  assert.equal(binding.signerKeyId, signerKeyId);
  assert.equal(binding.qualifiedExecutorRegistryRoot, payload.qualifiedExecutorRegistryRoot);
  assert.equal("authority" in binding, false);
});

test("unknown signer, signature mutation, and payload mutation all fail closed", () => {
  const first = generateKeyPairSync("ed25519");
  const second = generateKeyPairSync("ed25519");
  const signerKeyId = h("signer");
  const firstPin = { signerKeyId, publicKeyHex: rawPublicKeyHex(first.publicKey) };
  const secondPin = { signerKeyId, publicKeyHex: rawPublicKeyHex(second.publicKey) };
  const signatureHex = `0x${sign(null, Buffer.from(runtimeReleaseSigningRequestV1(payload, signerKeyId)), first.privateKey).toString("hex")}` as `0x${string}`;
  assert.throws(() => verifySignedRuntimeReleaseBindingV1(payload, secondPin, signatureHex), /signature invalid/);
  const flipped = `${signatureHex.slice(0, -2)}${signatureHex.endsWith("00") ? "01" : "00"}` as `0x${string}`;
  assert.throws(() => verifySignedRuntimeReleaseBindingV1(payload, firstPin, flipped), /signature invalid/);
  assert.throws(() => verifySignedRuntimeReleaseBindingV1({ ...payload, workerEpoch: "epoch-2" }, firstPin, signatureHex), /signature invalid/);
  assert.throws(() => verifySignedRuntimeReleaseBindingV1(payload, { ...firstPin, publicKeyHex: "0x11" } as never, signatureHex), /32-byte/);
});

test("packager joins a certificate emitted by GateCore to the exact external approval and executor registry", () => {
  const qualified = evaluateQualifiedLineageFixture();
  const workerExecutor = {
    ...executor,
    releaseRoleManifestRoot: qualified.result.certificate.releaseRoleManifestRoot,
    candidateCommit: qualified.result.certificate.candidateReleaseCommit,
  };
  const registry = {
    entries: [workerExecutor],
    registryRoot: hashQualifiedExecutorRegistryRoot([workerExecutor]),
  };
  const worker = {
    selectedExecutor: workerExecutor,
    workerEpoch: "epoch-1",
    executorSessionHash: h("qualified-session"),
    frameworkAuthorityRoot: h("qualified-framework"),
    executorAuthorityRoot: h("qualified-executor-authority"),
    releaseAuthorityRoot: h("qualified-release-authority"),
    attestationProofIssuerKeyId: h("qualified-attestation-proof"),
    candidatePartitionProofIssuerKeyId: h("qualified-partition-proof"),
  };
  const prepared = prepareRuntimeReleaseBindingPayloadV1({
    acceptanceCertificate: qualified.result.certificate,
    externalQualification: qualified.externalQualification,
    executorRegistry: registry,
    worker,
  });
  assert.equal(prepared.acceptanceCertificate.certificateId, qualified.result.certificate.certificateId);
  assert.equal(prepared.releaseAuthorityApprovalId, qualified.result.certificate.releaseAuthorityApprovalId);
  assert.equal(prepared.qualifiedExecutorRegistryRoot, registry.registryRoot);
  assert.equal(prepared.selectedExecutorLeafHash, hashQualifiedExecutorRegistryEntry(workerExecutor));

  const foreign = evaluateQualifiedLineageFixture();
  assert.throws(() => prepareRuntimeReleaseBindingPayloadV1({
    acceptanceCertificate: foreign.result.certificate,
    externalQualification: qualified.externalQualification,
    executorRegistry: registry,
    worker,
  }), /certificate and signed release approval mismatch/);
  assert.throws(() => prepareRuntimeReleaseBindingPayloadV1({
    acceptanceCertificate: qualified.result.certificate,
    externalQualification: qualified.externalQualification,
    executorRegistry: { ...registry, registryRoot: h("forged-registry") },
    worker,
  }), /registry root mismatch/);
  assert.throws(() => prepareRuntimeReleaseBindingPayloadV1({
    acceptanceCertificate: qualified.result.certificate,
    externalQualification: qualified.externalQualification,
    executorRegistry: registry,
    worker: { ...worker, selectedExecutor: { ...workerExecutor, executableFingerprint: h("foreign-executable") } },
  }), /not a registry member/);
});
