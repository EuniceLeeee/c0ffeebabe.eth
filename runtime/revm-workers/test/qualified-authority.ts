import { generateKeyPairSync, sign } from "node:crypto";
import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import {
  createRuntimeReleaseBindingV1,
  createRuntimeReleaseDiscoverySourceQualificationV1,
  hashRuntimeReleaseDiscoveryEndpointLocatorV1,
  runtimeReleaseBindingSigningBytes,
  hashRuntimeReleaseExecutorLeaseV1,
  sealRuntimeReleaseNominationQualificationSetV1,
  type RuntimeReleaseBindingPayloadV1,
} from "../../../specs/release-authority/src/index.ts";
import { generatedEconomicValuationOwnerQualificationSetFixtureV1 } from "../../../specs/release-authority/test/generated-valuation-owner-qualification-fixture.ts";
import { generatedEconomicSafetyActionOwnerQualificationFixtureV1 } from "../../../specs/release-authority/test/generated-action-owner-qualification-fixture.ts";
import { verifyAndIssueRuntimeReleaseAuthorityV1 } from "../../../packages/runtime-release-authority/src/index.ts";
import { issueRuntimeReleaseExecutorLeaseV1 } from "../../../packages/runtime-release-authority/src/internal/revm-worker-owner.ts";
import { issueRuntimeReleaseQualifiedExecutorAuthorityIssuer } from "../../../packages/runtime-release-authority/src/internal/scheduler-authority-owner.ts";
import {
  createQualifiedExecutorRegistry,
  type QualifiedExecutorAuthorityCapability,
  type QualifiedExecutorAuthorityIssuer,
} from "../../../packages/scheduler/src/index.ts";
import {
  createTestQualifiedExecutorAuthorityIssuer,
  testReleaseApprovalPort,
} from "../../../packages/scheduler/test/fixtures/qualified-release.ts";
import type { RevmWorkerAuthorityBindingV1 } from "../src/protocol.ts";
import type { RevmWorkerAuthorityIssuer } from "../src/lifecycle.ts";
import { issueRevmWorkerAuthorityIssuer } from "../src/internal/authority.ts";

const h = (value: string): Hash => hashDomain("test/revm-release", value);
const executor = {
  executorKind: "revm",
  engineBuildFingerprint: h("engine"),
  executableFingerprint: h("executable"),
  closureFingerprint: h("closure"),
  protocolFingerprint: h("protocol"),
  schemaFingerprint: h("schema"),
  releaseRoleManifestRoot: h("manifest"),
  candidateCommit: "0123456789abcdef0123456789abcdef01234567",
} as const;

function keyHex(key: ReturnType<typeof generateKeyPairSync>["publicKey"]): `0x${string}` {
  const der = key.export({ format: "der", type: "spki" });
  return `0x${der.subarray(-32).toString("hex")}`;
}

interface Deployment {
  readonly runtime: ReturnType<typeof verifyAndIssueRuntimeReleaseAuthorityV1>;
  readonly scheduler: QualifiedExecutorAuthorityIssuer;
}

function deployment(): Deployment {
  const registry = createQualifiedExecutorRegistry(executor);
  const valuationQualification = generatedEconomicValuationOwnerQualificationSetFixtureV1("revm-workers");
  const actionOwnerQualification = generatedEconomicSafetyActionOwnerQualificationFixtureV1("revm-workers");
  const nominationQualificationSet = sealRuntimeReleaseNominationQualificationSetV1([{
    proposalLeafDigest: h("nomination-proposal"),
    criticalMutationCorpusRoot: h("nomination-mutations"),
    independentOracleCaseRoot: h("nomination-oracle"),
    qualificationSpecDigest: h("nomination-spec"),
    verifierQualificationCertificateRoot: h("nomination-certificate"),
  }]);
  const releaseApproval = {
    registryRoot: registry.registryRoot,
    releaseRoleManifestRoot: executor.releaseRoleManifestRoot,
    candidateCommit: executor.candidateCommit,
  };
  const executorAuthorityRoot = hashDomain("aloha/qualified-executor-authority/v1", {
    registryRoot: registry.registryRoot,
    releaseBinding: releaseApproval,
  });
  const payload: RuntimeReleaseBindingPayloadV1 = {
    schemaVersion: 1,
    kind: "aloha.runtime-release-binding",
    releaseAuthorityApprovalId: h("approval"), releaseAuthorityApprovalPayloadHash: h("approval-payload"), releaseAcceptanceRequirementSetRoot: h("acceptance-requirements"),
    externalTrustAnchorRoot: h("anchor"), externalIssuerKeySetRoot: h("keys"), qualificationRegistryApprovalId: h("registry-approval"), qualificationRegistryRoot: h("registry"), qualificationEpoch: "1", qualificationAudienceHash: h("audience"),
    predicateCompositionRootDigest: h("composition"), gateCoreRuntimeClosureDigest: executor.closureFingerprint, gateCoreImplementationClosureDigest: h("gate-core"),
    searcherRuntime: { runtimeArtifactRoot: h("searcher-artifact"), implementationClosureDigest: h("searcher-closure"), nodeExecutableSha256: h("searcher-node"), entrypointSha256: h("searcher-entrypoint"), bundleModulePath: "/etc/aloha/deployment-bundle.mjs", bundleModuleSha256: h("searcher-bundle") },
    discoverySourceQualification: createRuntimeReleaseDiscoverySourceQualificationV1({
      providerIdentity: "reth-mainnet",
      backendEpoch: "reth-backend-1",
      profile: "reth-json-rpc-v1",
      chainId: "1",
      endpointLocatorHash: hashRuntimeReleaseDiscoveryEndpointLocatorV1("http://127.0.0.1:8545"),
      qualificationRoot: h("discovery-source-qualification"),
    }),
    qualifiedExecutorRegistry: registry.entries, qualifiedExecutorRegistryRoot: registry.registryRoot,
    valuationOwnerRegistryRoot: valuationQualification.registry.valuationOwnerRegistryRoot,
    valuationOwnerQualificationCertificates: valuationQualification.certificates,
    qualifiedValuationOwnerSetRoot: valuationQualification.root,
    actionOwnerRegistryRoot: actionOwnerQualification.registry.actionOwnerRegistryRoot,
    actionOwnerQualificationCertificates: actionOwnerQualification.certificates,
    qualifiedActionOwnerSetRoot: actionOwnerQualification.root,
    safetyProfile: actionOwnerQualification.profile,
    safetyProfileRoot: actionOwnerQualification.profileRoot,
    qualifiedCapabilityRefsRoot: h("qualified-capability-refs"),
    nominationProgramSetRoot: nominationQualificationSet.programSetRoot, nominationQualificationSet, nominationQualificationSetRoot: nominationQualificationSet.root,
    selectedExecutorLeafHash: hashDomain("aloha/qualified-executor-registry/v1", executor), selectedExecutor: executor,
    releaseRoleManifestRoot: executor.releaseRoleManifestRoot, candidateReleaseCommit: executor.candidateCommit, workerEpoch: "release-epoch", executorSessionHash: h("release-session"),
    frameworkAuthorityRoot: h("framework"), executorAuthorityRoot, releaseAuthorityRoot: h("release-authority"), attestationProofIssuerKeyId: h("proof"), candidatePartitionProofIssuerKeyId: h("partition-proof"),
  };
  const signer = generateKeyPairSync("ed25519");
  const signerKeyId = h("signer");
  const unsigned = createRuntimeReleaseBindingV1(payload, signerKeyId, `0x${"01".repeat(64)}`);
  const signatureHex = `0x${sign(null, Buffer.from(runtimeReleaseBindingSigningBytes(unsigned, signerKeyId)), signer.privateKey).toString("hex")}`;
  const binding = createRuntimeReleaseBindingV1(payload, signerKeyId, signatureHex);
  const runtime = verifyAndIssueRuntimeReleaseAuthorityV1(binding, { signerKeyId, publicKeyHex: keyHex(signer.publicKey) });
  const implementation = createTestQualifiedExecutorAuthorityIssuer(registry, testReleaseApprovalPort(registry, executor.releaseRoleManifestRoot, executor.candidateCommit));
  const scheduler = issueRuntimeReleaseQualifiedExecutorAuthorityIssuer(runtime, implementation);
  return { runtime, scheduler };
}

export function createTestRevmAuthorityIssuer(epochs: readonly string[] = ["epoch-1", "epoch-2", "epoch-3"]): RevmWorkerAuthorityIssuer {
  const { runtime, scheduler } = deployment();
  let index = 0;
  const issued = new Map<string, { readonly capability: QualifiedExecutorAuthorityCapability; readonly lease: RevmWorkerAuthorityBindingV1 }>();
  const issue = (): RevmWorkerAuthorityBindingV1 => {
    const workerEpoch = epochs[index++ % epochs.length]!;
    const worker = { workerEpoch, ...executor };
    // Multiple healthy workers coexist under one release; each gets a fresh
    // owner-issued session without rotating/revoking its siblings.  A dead
    // controller's lease is no longer usable because that controller is
    // reaped and its callbacks are detached.
    const capability = scheduler.open({ worker });
    const lease = issueRuntimeReleaseExecutorLeaseV1(runtime, scheduler, capability);
    const result: RevmWorkerAuthorityBindingV1 = Object.freeze({ release: lease, authorityRoot: lease.executorAuthorityRoot, workerEpoch: lease.workerEpoch, executorSessionHash: lease.executorSessionHash });
    issued.set(hashRuntimeReleaseExecutorLeaseV1(lease), { capability, lease: result });
    return result;
  };
  return issueRevmWorkerAuthorityIssuer({
    issue,
    assertCurrent(binding: RevmWorkerAuthorityBindingV1): void {
      const current = issued.get(hashRuntimeReleaseExecutorLeaseV1(binding.release));
      if (!current) throw new Error("worker authority is stale");
      const provenance = scheduler.provenance(current.capability);
      if (provenance.workerEpoch !== binding.workerEpoch || provenance.executorSession !== binding.executorSessionHash) throw new Error("worker authority is stale");
    },
  });
}

export function authorityFor(epoch: string): RevmWorkerAuthorityBindingV1 {
  return createTestRevmAuthorityIssuer([epoch]).issue();
}
