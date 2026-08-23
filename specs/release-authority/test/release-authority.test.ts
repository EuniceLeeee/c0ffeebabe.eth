import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import {
  createRuntimeReleaseBindingV1,
  decodeRuntimeReleaseBindingV1,
  hashQualifiedExecutorRegistryEntry,
  recomputeRuntimeReleaseBindingId,
  recomputeRuntimeReleaseBindingPayloadHash,
  runtimeReleaseBindingSigningBytes,
  type RuntimeReleaseBindingPayloadV1,
} from "../src/index.ts";

const h = (value: string): Hash => hashDomain("test/runtime-release-wire", value);
const executor = {
  executorKind: "revm", engineBuildFingerprint: h("engine"), executableFingerprint: h("executable"),
  closureFingerprint: h("closure"), protocolFingerprint: h("protocol"), schemaFingerprint: h("schema"),
  releaseRoleManifestRoot: h("manifest"), candidateCommit: "1".repeat(40),
};

function payload(): RuntimeReleaseBindingPayloadV1 {
  return {
    schemaVersion: 1, kind: "aloha.runtime-release-binding",
    acceptanceCertificate: { certificateId: h("certificate"), payloadHash: h("certificate-payload"), verdict: "pass" },
    releaseAuthorityApprovalId: h("approval"), releaseAuthorityApprovalPayloadHash: h("approval-payload"),
    authorityPinDigest: h("pin"), externalTrustAnchorRoot: h("anchor"), externalIssuerKeySetRoot: h("key-set"),
    qualificationRegistryApprovalId: h("registry-approval"), qualificationRegistryRoot: h("qualification-registry"),
    qualificationEpoch: "7", qualificationAudienceHash: h("audience"),
    predicateCompositionRootDigest: h("composition"), gateCoreRuntimeClosureDigest: h("runtime"),
    gateCoreImplementationClosureDigest: h("core"), qualifiedExecutorRegistryRoot: h("executor-registry"),
    selectedExecutorLeafHash: hashQualifiedExecutorRegistryEntry(executor), selectedExecutor: executor,
    releaseRoleManifestRoot: executor.releaseRoleManifestRoot, candidateReleaseCommit: executor.candidateCommit,
    workerEpoch: "worker-7", executorSessionHash: h("session"), frameworkAuthorityRoot: h("framework"),
    executorAuthorityRoot: h("executor-authority"), releaseAuthorityRoot: h("release-authority"),
    attestationProofIssuerKeyId: h("attestation-proof"), candidatePartitionProofIssuerKeyId: h("partition-proof"),
  };
}

test("runtime release wire identity binds every external approval and qualification coordinate", () => {
  const signer = h("signer");
  const original = createRuntimeReleaseBindingV1(payload(), signer, `0x${"11".repeat(64)}`);
  assert.deepEqual(decodeRuntimeReleaseBindingV1(original), original);
  assert.equal(recomputeRuntimeReleaseBindingPayloadHash(original), original.payloadHash);
  assert.equal(recomputeRuntimeReleaseBindingId(original), original.bindingId);
  const replacements: Partial<Record<keyof RuntimeReleaseBindingPayloadV1, unknown>> = {
    releaseAuthorityApprovalId: h("approval-2"), releaseAuthorityApprovalPayloadHash: h("approval-payload-2"),
    authorityPinDigest: h("pin-2"), externalTrustAnchorRoot: h("anchor-2"), externalIssuerKeySetRoot: h("key-set-2"),
    qualificationRegistryApprovalId: h("registry-approval-2"), qualificationRegistryRoot: h("registry-2"),
    qualificationEpoch: "8", qualificationAudienceHash: h("audience-2"),
    predicateCompositionRootDigest: h("composition-2"), gateCoreRuntimeClosureDigest: h("runtime-2"),
    gateCoreImplementationClosureDigest: h("core-2"), qualifiedExecutorRegistryRoot: h("executor-registry-2"),
    workerEpoch: "worker-8", executorSessionHash: h("session-2"),
  };
  for (const [field, replacement] of Object.entries(replacements)) {
    const mutated = createRuntimeReleaseBindingV1({ ...payload(), [field]: replacement } as RuntimeReleaseBindingPayloadV1, signer, `0x${"11".repeat(64)}`);
    assert.notEqual(mutated.payloadHash, original.payloadHash, field);
    assert.notDeepEqual(runtimeReleaseBindingSigningBytes(mutated), runtimeReleaseBindingSigningBytes(original), field);
  }
});

test("wire self-consistency never claims to verify the external signature", () => {
  const binding = createRuntimeReleaseBindingV1(payload(), h("unknown-signer"), `0x${"22".repeat(64)}`);
  assert.deepEqual(decodeRuntimeReleaseBindingV1(binding), binding);
  assert.equal("verified" in binding, false);
  assert.equal("authority" in binding, false);
  assert.throws(() => decodeRuntimeReleaseBindingV1({ ...binding, signatureHex: `0x${"00".repeat(64)}` }), /signature must not be zero/);
});
