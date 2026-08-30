import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import {
  sealEconomicValuationOwnerQualificationCertificateSetV1,
  sealEconomicValuationOwnerQualificationCertificateV1,
} from "../../economic-valuation-owner/src/index.ts";
import {
  ECONOMIC_SAFETY_REVM_OBSERVATION_SCHEMA_REF_V1,
  sealEconomicSafetyActionOwnerProposalV1,
  sealEconomicSafetyActionOwnerQualificationCertificateV1,
  sealEconomicSafetyActionOwnerQualificationSetV1,
  sealSafetyProfileV1,
} from "../../economic-safety-profile/src/index.ts";
import {
  createRuntimeReleasePackageApprovalV1,
  createRuntimeReleaseBindingV1,
  createNominationQualificationDeploymentFactV1,
  createRuntimeReleaseDiscoverySourceQualificationV1,
  decodeRuntimeReleasePackageApprovalV1,
  decodeRuntimeReleaseNominationQualificationSetV1,
  decodeRuntimeReleaseQualifiedCapabilityProjectionV1,
  decodeRuntimeReleaseBindingV1,
  decodeNominationQualificationDeploymentFactV1,
  encodeRuntimeReleasePackageApprovalV1,
  hashQualifiedExecutorRegistryEntry,
  hashQualifiedExecutorRegistryRoot,
  hashRuntimeReleaseDiscoveryEndpointLocatorV1,
  recomputeRuntimeReleaseBindingId,
  recomputeRuntimeReleaseBindingPayloadHash,
  recomputeRuntimeReleasePackageApprovalId,
  recomputeRuntimeReleasePackageApprovalPayloadHash,
  runtimeReleaseDiscoverySourceAuthorityRootV1,
  runtimeReleaseBindingSigningBytes,
  runtimeReleasePackageApprovalSigningBytes,
  nominationQualificationDeploymentFactSigningBytes,
  RELEASE_AUTHORITY_SCHEMA_MANIFESTS,
  sealRuntimeReleaseNominationQualificationSetV1,
  type RuntimeReleaseBindingPayloadV1,
  type RuntimeReleasePackageApprovalPayloadV1,
  type NominationQualificationDeploymentFactPayloadV1,
} from "../src/index.ts";

const h = (value: string): Hash => hashDomain("test/runtime-release-wire", value);
const ZERO_HASH = `0x${"0".repeat(64)}` as Hash;
const executor = {
  executorKind: "revm", engineBuildFingerprint: h("engine"), executableFingerprint: h("executable"),
  closureFingerprint: h("closure"), protocolFingerprint: h("protocol"), schemaFingerprint: h("schema"),
  releaseRoleManifestRoot: h("manifest"), candidateCommit: "1".repeat(40),
};
const valuationCertificate = sealEconomicValuationOwnerQualificationCertificateV1({
  schemaVersion: 1,
  kind: "aloha.economic-valuation-owner-qualification-certificate",
  ownerRef: h("valuation-owner"),
  supportedAssetRefs: Object.freeze([h("valuation-asset")]),
  proposedOwnerLeafDigest: h("valuation-owner-leaf"),
  implementationHash: h("valuation-owner-implementation"),
  factSchemaRef: h("valuation-fact-schema"),
  implementationClosureRoot: h("valuation-implementation-closure"),
  qualificationSpecDigest: h("valuation-qualification-spec"),
  qualificationSpecClosureRoot: h("valuation-qualification-spec-closure"),
  criticalMutationCorpusRoot: h("valuation-mutation-corpus"),
  criticalMutationCorpusClosureRoot: h("valuation-mutation-corpus-closure"),
  independentOracleCaseRoot: h("valuation-oracle-cases"),
  independentOracleClosureRoot: h("valuation-oracle-closure"),
  executedPositiveCaseRoot: h("valuation-executed-positive"),
  executedNegativeCaseRoot: h("valuation-executed-negative"),
  executedInvalidCaseRoot: h("valuation-executed-invalid"),
  verifierImplementationDigest: h("valuation-verifier"),
  qualificationAuthorityApprovalId: h("valuation-qualification-approval"),
  qualificationAuthorityApprovalPayloadHash: h("valuation-qualification-approval-payload"),
});
const valuationCertificateSet = sealEconomicValuationOwnerQualificationCertificateSetV1([valuationCertificate]);
const actionOwnerProposal = sealEconomicSafetyActionOwnerProposalV1({
  familyDefinitionHash: h("action-family"),
  ownerId: "test.action",
  ownerRef: h("action-owner"),
  implementationHash: h("action-implementation"),
  schemaRef: h("action-schema"),
  implementationClosureRoot: h("action-closure"),
});
const actionOwnerCertificate = sealEconomicSafetyActionOwnerQualificationCertificateV1({
  schemaVersion: 1,
  kind: "aloha.economic-safety-action-owner-qualification-certificate",
  familyDefinitionHash: actionOwnerProposal.familyDefinitionHash,
  ownerId: actionOwnerProposal.ownerId,
  ownerRef: actionOwnerProposal.ownerRef,
  proposedOwnerLeafDigest: actionOwnerProposal.proposalLeafDigest,
  implementationHash: actionOwnerProposal.implementationHash,
  schemaRef: actionOwnerProposal.schemaRef,
  implementationClosureRoot: actionOwnerProposal.implementationClosureRoot,
  claimSchemaRefs: [actionOwnerProposal.schemaRef],
  verifierProgramDigest: h("action-verifier"),
  qualificationSpecDigest: h("action-qualification-spec"),
  criticalMutationCorpusRoot: h("action-mutations"),
  independentOracleCaseRoot: h("action-oracle-cases"),
  executedPositiveCaseRoot: h("action-positive"),
  executedNegativeCaseRoot: h("action-negative"),
  executedInvalidCaseRoot: h("action-invalid"),
  qualificationAuthorityApprovalId: h("action-approval"),
  qualificationAuthorityApprovalPayloadHash: h("action-approval-payload"),
});
const actionOwnerCertificateSet = sealEconomicSafetyActionOwnerQualificationSetV1([actionOwnerCertificate]);
const safetyProfile = sealSafetyProfileV1({
  profileRef: h("safety-profile"),
  qualifiedOwnerSetRoot: actionOwnerCertificateSet.root,
  requiredClaims: [{
    claimSchemaRef: actionOwnerProposal.schemaRef,
    ownerRef: actionOwnerProposal.ownerRef,
    qualificationLeafDigest: actionOwnerCertificate.qualificationLeafDigest,
    revmObservationSchemaRef: ECONOMIC_SAFETY_REVM_OBSERVATION_SCHEMA_REF_V1,
  }],
});
const nominationSet = () => sealRuntimeReleaseNominationQualificationSetV1([{
  proposalLeafDigest: h("nomination-proposal"),
  criticalMutationCorpusRoot: h("nomination-mutations"),
  independentOracleCaseRoot: h("nomination-oracle-cases"),
  qualificationSpecDigest: h("nomination-spec"),
  verifierQualificationCertificateRoot: h("nomination-certificate"),
}]);

function payload(): RuntimeReleaseBindingPayloadV1 {
  return {
    schemaVersion: 1, kind: "aloha.runtime-release-binding",
    releaseAuthorityApprovalId: h("approval"), releaseAuthorityApprovalPayloadHash: h("approval-payload"),
    releaseAcceptanceRequirementSetRoot: h("acceptance-requirements"),
    externalTrustAnchorRoot: h("anchor"), externalIssuerKeySetRoot: h("key-set"),
    qualificationRegistryApprovalId: h("registry-approval"), qualificationRegistryRoot: h("qualification-registry"),
    qualificationEpoch: "7", qualificationAudienceHash: h("audience"),
    predicateCompositionRootDigest: h("composition"), gateCoreRuntimeClosureDigest: h("runtime"),
    gateCoreImplementationClosureDigest: h("core"),
    qualifiedExecutorRegistry: [executor], qualifiedExecutorRegistryRoot: hashQualifiedExecutorRegistryRoot([executor]),
    valuationOwnerRegistryRoot: h("valuation-owner-registry"),
    valuationOwnerQualificationCertificates: valuationCertificateSet.certificates,
    qualifiedValuationOwnerSetRoot: valuationCertificateSet.root,
    actionOwnerRegistryRoot: h("action-owner-registry"),
    actionOwnerQualificationCertificates: actionOwnerCertificateSet.certificates,
    qualifiedActionOwnerSetRoot: actionOwnerCertificateSet.root,
    safetyProfile,
    safetyProfileRoot: safetyProfile.profileCompositionRoot,
    qualifiedCapabilityRefsRoot: h("qualified-capability-refs"),
    nominationProgramSetRoot: nominationSet().programSetRoot,
    nominationQualificationSet: nominationSet(),
    nominationQualificationSetRoot: nominationSet().root,
    searcherRuntime: { runtimeArtifactRoot: h("searcher-artifact"), implementationClosureDigest: h("searcher-closure"), nodeExecutableSha256: h("searcher-node"), entrypointSha256: h("searcher-entrypoint"), bundleModulePath: "/etc/aloha/deployment-bundle.mjs", bundleModuleSha256: h("searcher-bundle") },
    discoverySourceQualification: createRuntimeReleaseDiscoverySourceQualificationV1({
      providerIdentity: "reth-mainnet",
      backendEpoch: "reth-backend-1",
      profile: "reth-json-rpc-v1",
      chainId: "1",
      endpointLocatorHash: hashRuntimeReleaseDiscoveryEndpointLocatorV1("http://127.0.0.1:8545"),
      qualificationRoot: h("discovery-source-qualification"),
    }),
    selectedExecutorLeafHash: hashQualifiedExecutorRegistryEntry(executor), selectedExecutor: executor,
    releaseRoleManifestRoot: executor.releaseRoleManifestRoot, candidateReleaseCommit: executor.candidateCommit,
    workerEpoch: "worker-7", executorSessionHash: h("session"), frameworkAuthorityRoot: h("framework"),
    executorAuthorityRoot: h("executor-authority"), releaseAuthorityRoot: h("release-authority"),
    attestationProofIssuerKeyId: h("attestation-proof"), candidatePartitionProofIssuerKeyId: h("partition-proof"),
  };
}

function nominationDeploymentFactPayload(): NominationQualificationDeploymentFactPayloadV1 {
  return {
    schemaVersion: 1,
    kind: "aloha.nomination-qualification-deployment-fact",
    runtimeBindingId: h("nomination-binding"),
    runtimeBindingPayloadHash: h("nomination-binding-payload"),
    candidateReleaseCommit: "4".repeat(40),
    catalogImpactSnapshotRoot: h("catalog-impact-snapshot"),
    catalogFamilyProposalOwnershipRoot: h("catalog-family-proposal-ownership"),
    catalogSemanticLedgerHash: h("catalog-semantic-ledger"),
    catalogSemanticOutputRoot: h("catalog-semantic-output"),
    catalogBoundaryVerificationReceiptRoot: h("catalog-boundary-verification-receipt"),
    catalogProposedCapabilitySetRoot: h("catalog-proposed-capabilities"),
    nominationProgramSetRoot: h("nomination-program-set"),
    nominationQualificationSetRoot: h("nomination-qualification-set"),
  };
}

function packageApprovalPayload(): RuntimeReleasePackageApprovalPayloadV1 {
  return {
    schemaVersion: 1,
    kind: "aloha.runtime-release-package-approval",
    packageRoot: h("package-root"),
    bindingId: h("binding-id"),
    releaseProvenanceHash: h("release-provenance"),
    releaseAcceptanceApprovalId: h("acceptance-approval"),
    releaseAcceptanceApprovalPayloadHash: h("acceptance-approval-payload"),
    releaseAcceptanceRequirementSetRoot: h("acceptance-requirements"),
    releaseAcceptanceSetRoot: h("acceptance-results"),
    controllerBoundaryEvidenceRoot: h("controller-boundary-evidence"),
    candidateReleaseCommit: "2".repeat(40),
    performanceBasisId: h("performance-basis"),
    performanceProfileHash: h("performance-profile"),
    hardwareProfileRoot: h("hardware-profile"),
    providerRoot: h("provider-root"),
  };
}

test("package approval wire binds the post-package root and every release fact", () => {
  const signerKeyId = h("package-approval-signer");
  const signatureHex = `0x${"22".repeat(64)}`;
  const original = createRuntimeReleasePackageApprovalV1(
    packageApprovalPayload(),
    signerKeyId,
    signatureHex,
  );
  assert.deepEqual(decodeRuntimeReleasePackageApprovalV1(original), original);
  assert.deepEqual(
    decodeRuntimeReleasePackageApprovalV1(encodeRuntimeReleasePackageApprovalV1(original)),
    original,
  );
  assert.equal(recomputeRuntimeReleasePackageApprovalPayloadHash(original), original.payloadHash);
  assert.equal(recomputeRuntimeReleasePackageApprovalId(original), original.approvalId);

  for (const field of [
    "packageRoot",
    "bindingId",
    "releaseProvenanceHash",
    "releaseAcceptanceApprovalId",
    "releaseAcceptanceApprovalPayloadHash",
    "releaseAcceptanceRequirementSetRoot",
    "releaseAcceptanceSetRoot",
    "controllerBoundaryEvidenceRoot",
    "performanceBasisId",
    "performanceProfileHash",
    "hardwareProfileRoot",
    "providerRoot",
  ] as const) {
    const changed = createRuntimeReleasePackageApprovalV1(
      { ...packageApprovalPayload(), [field]: h(`changed:${field}`) },
      signerKeyId,
      signatureHex,
    );
    assert.notEqual(changed.payloadHash, original.payloadHash, field);
    assert.notDeepEqual(
      runtimeReleasePackageApprovalSigningBytes(changed),
      runtimeReleasePackageApprovalSigningBytes(original),
      field,
    );
  }
  const changedCommit = createRuntimeReleasePackageApprovalV1(
    { ...packageApprovalPayload(), candidateReleaseCommit: "3".repeat(40) },
    signerKeyId,
    signatureHex,
  );
  assert.notEqual(changedCommit.payloadHash, original.payloadHash);
  assert.notDeepEqual(
    runtimeReleasePackageApprovalSigningBytes(changedCommit),
    runtimeReleasePackageApprovalSigningBytes(original),
  );

  assert.throws(
    () => decodeRuntimeReleasePackageApprovalV1({ ...original, packageRoot: h("forged-package") }),
    /payloadHash mismatch/,
  );
  assert.throws(
    () => decodeRuntimeReleasePackageApprovalV1({ ...original, unexpected: true } as never),
    /exact object|unexpected|unknown/i,
  );
  assert.throws(
    () => createRuntimeReleasePackageApprovalV1(packageApprovalPayload(), signerKeyId, `0x${"00".repeat(64)}`),
    /signature must not be zero/,
  );
  assert.throws(
    () => createRuntimeReleasePackageApprovalV1(
      { ...packageApprovalPayload(), controllerBoundaryEvidenceRoot: ZERO_HASH },
      signerKeyId,
      signatureHex,
    ),
    /controllerBoundaryEvidenceRoot/,
  );
  assert.throws(
    () => decodeRuntimeReleasePackageApprovalV1({
      ...original,
      controllerBoundaryEvidenceRoot: ZERO_HASH,
    }),
    /controllerBoundaryEvidenceRoot/,
  );
  assert.throws(
    () => runtimeReleasePackageApprovalSigningBytes(packageApprovalPayload()),
    /signerKeyId is required/,
  );
});

test("runtime release wire identity binds every external approval and qualification coordinate", () => {
  const signer = h("signer");
  const original = createRuntimeReleaseBindingV1(payload(), signer, `0x${"11".repeat(64)}`);
  assert.deepEqual(decodeRuntimeReleaseBindingV1(original), original);
  assert.equal(recomputeRuntimeReleaseBindingPayloadHash(original), original.payloadHash);
  assert.equal(recomputeRuntimeReleaseBindingId(original), original.bindingId);
  const replacements: Partial<Record<keyof RuntimeReleaseBindingPayloadV1, unknown>> = {
    releaseAuthorityApprovalId: h("approval-2"), releaseAuthorityApprovalPayloadHash: h("approval-payload-2"),
    releaseAcceptanceRequirementSetRoot: h("acceptance-requirements-2"),
    externalTrustAnchorRoot: h("anchor-2"), externalIssuerKeySetRoot: h("key-set-2"),
    qualificationRegistryApprovalId: h("registry-approval-2"), qualificationRegistryRoot: h("registry-2"),
    qualificationEpoch: "8", qualificationAudienceHash: h("audience-2"),
    predicateCompositionRootDigest: h("composition-2"), gateCoreRuntimeClosureDigest: h("runtime-2"),
    gateCoreImplementationClosureDigest: h("core-2"),
    valuationOwnerRegistryRoot: h("valuation-owner-registry-2"),
    qualifiedCapabilityRefsRoot: h("qualified-capability-refs-2"),
    discoverySourceQualification: createRuntimeReleaseDiscoverySourceQualificationV1({
      providerIdentity: "reth-mainnet",
      backendEpoch: "reth-backend-2",
      profile: "reth-json-rpc-v1",
      chainId: "1",
      endpointLocatorHash: hashRuntimeReleaseDiscoveryEndpointLocatorV1("http://127.0.0.1:9545"),
      qualificationRoot: h("discovery-source-qualification-2"),
    }),
    workerEpoch: "worker-8", executorSessionHash: h("session-2"),
  };
  for (const [field, replacement] of Object.entries(replacements)) {
    const mutated = createRuntimeReleaseBindingV1({ ...payload(), [field]: replacement } as RuntimeReleaseBindingPayloadV1, signer, `0x${"11".repeat(64)}`);
    assert.notEqual(mutated.payloadHash, original.payloadHash, field);
    assert.notDeepEqual(runtimeReleaseBindingSigningBytes(mutated), runtimeReleaseBindingSigningBytes(original), field);
  }
  const changedValuationCertificate = sealEconomicValuationOwnerQualificationCertificateV1({
    ...valuationCertificate,
    executedNegativeCaseRoot: h("valuation-executed-negative-2"),
  });
  const changedValuationSet = sealEconomicValuationOwnerQualificationCertificateSetV1([changedValuationCertificate]);
  const changedValuation = createRuntimeReleaseBindingV1({
    ...payload(),
    valuationOwnerQualificationCertificates: changedValuationSet.certificates,
    qualifiedValuationOwnerSetRoot: changedValuationSet.root,
  }, signer, `0x${"11".repeat(64)}`);
  assert.notEqual(changedValuation.payloadHash, original.payloadHash);
  assert.notDeepEqual(runtimeReleaseBindingSigningBytes(changedValuation), runtimeReleaseBindingSigningBytes(original));
  assert.throws(() => createRuntimeReleaseBindingV1({
    ...payload(),
    qualifiedValuationOwnerSetRoot: h("forged-valuation-set-root"),
  }, signer, `0x${"11".repeat(64)}`), /qualified valuation-owner set root mismatch/);
  const changedNominationSet = sealRuntimeReleaseNominationQualificationSetV1([{
    proposalLeafDigest: h("nomination-proposal-2"),
    criticalMutationCorpusRoot: h("nomination-mutations-2"),
    independentOracleCaseRoot: h("nomination-oracle-cases-2"),
    qualificationSpecDigest: h("nomination-spec-2"),
    verifierQualificationCertificateRoot: h("nomination-certificate-2"),
  }]);
  const changedNomination = createRuntimeReleaseBindingV1({
    ...payload(),
    nominationProgramSetRoot: changedNominationSet.programSetRoot,
    nominationQualificationSet: changedNominationSet,
    nominationQualificationSetRoot: changedNominationSet.root,
  }, signer, `0x${"11".repeat(64)}`);
  assert.notEqual(changedNomination.payloadHash, original.payloadHash);
  assert.notDeepEqual(runtimeReleaseBindingSigningBytes(changedNomination), runtimeReleaseBindingSigningBytes(original));
});

test("runtime release rejects an action-owner certificate or SafetyProfile splice", () => {
  const signer = h("safety-profile-signer");
  assert.throws(() => createRuntimeReleaseBindingV1({
    ...payload(),
    qualifiedActionOwnerSetRoot: h("foreign-action-owner-set"),
  }, signer, `0x${"13".repeat(64)}`), /qualified action-owner set root mismatch/);
  assert.throws(() => createRuntimeReleaseBindingV1({
    ...payload(),
    safetyProfileRoot: h("foreign-safety-profile"),
  }, signer, `0x${"13".repeat(64)}`), /safety profile release binding mismatch/);
  const foreignProfile = sealSafetyProfileV1({
    profileRef: safetyProfile.profileRef,
    qualifiedOwnerSetRoot: actionOwnerCertificateSet.root,
    requiredClaims: [{
      ...safetyProfile.requiredClaims[0]!,
      qualificationLeafDigest: h("foreign-action-owner-leaf"),
    }],
  });
  assert.throws(() => createRuntimeReleaseBindingV1({
    ...payload(),
    safetyProfile: foreignProfile,
    safetyProfileRoot: foreignProfile.profileCompositionRoot,
  }, signer, `0x${"13".repeat(64)}`), /not an exact qualified owner member/);
});

test("runtime release binds a complete multi-executor denominator and exact selected membership", () => {
  const other = Object.freeze({
    ...executor,
    executorKind: "revm-secondary",
    engineBuildFingerprint: h("engine-secondary"),
    executableFingerprint: h("executable-secondary"),
  });
  const registry = [executor, other].sort((left, right) =>
    hashQualifiedExecutorRegistryEntry(left).localeCompare(hashQualifiedExecutorRegistryEntry(right)));
  const selected = registry[1]!;
  const validPayload: RuntimeReleaseBindingPayloadV1 = {
    ...payload(),
    qualifiedExecutorRegistry: registry,
    qualifiedExecutorRegistryRoot: hashQualifiedExecutorRegistryRoot(registry),
    selectedExecutor: selected,
    selectedExecutorLeafHash: hashQualifiedExecutorRegistryEntry(selected),
  };
  assert.deepEqual(
    createRuntimeReleaseBindingV1(validPayload, h("multi-signer"), `0x${"12".repeat(64)}`).selectedExecutor,
    selected,
  );
  assert.throws(() => createRuntimeReleaseBindingV1({
    ...validPayload,
    qualifiedExecutorRegistry: [...registry].reverse(),
  }, h("multi-signer"), `0x${"12".repeat(64)}`), /strictly sorted and unique/);
  assert.throws(() => createRuntimeReleaseBindingV1({
    ...validPayload,
    qualifiedExecutorRegistry: [registry[0]!, registry[0]!],
  }, h("multi-signer"), `0x${"12".repeat(64)}`), /strictly sorted and unique/);
  assert.throws(() => createRuntimeReleaseBindingV1({
    ...validPayload,
    qualifiedExecutorRegistry: [registry[0]!],
    qualifiedExecutorRegistryRoot: hashQualifiedExecutorRegistryRoot([registry[0]!]),
  }, h("multi-signer"), `0x${"12".repeat(64)}`), /not an exact qualified registry member/);
  const selectedClone = { ...selected, executableFingerprint: h("selected-clone-executable") };
  assert.throws(() => createRuntimeReleaseBindingV1({
    ...validPayload,
    selectedExecutor: selectedClone,
    selectedExecutorLeafHash: hashQualifiedExecutorRegistryEntry(selectedClone),
  }, h("multi-signer"), `0x${"12".repeat(64)}`), /not an exact qualified registry member/);
  assert.throws(() => createRuntimeReleaseBindingV1({
    ...validPayload,
    qualifiedExecutorRegistryRoot: h("foreign-executor-registry-root"),
  }, h("multi-signer"), `0x${"12".repeat(64)}`), /registry root mismatch/);
});

test("nomination deployment-fact manifest and runtime decoder share checked identity semantics", () => {
  const signerKeyId = h("nomination-deployment-fact-signer");
  const signatureHex = `0x${"33".repeat(64)}`;
  const original = createNominationQualificationDeploymentFactV1(
    nominationDeploymentFactPayload(),
    signerKeyId,
    signatureHex,
  );
  assert.deepEqual(decodeNominationQualificationDeploymentFactV1(original), original);
  assert.deepEqual(
    RELEASE_AUTHORITY_SCHEMA_MANIFESTS.nominationQualificationDeploymentFact.schema.decode(original),
    original,
  );

  for (const field of [
    "runtimeBindingId",
    "runtimeBindingPayloadHash",
    "candidateReleaseCommit",
    "catalogImpactSnapshotRoot",
    "catalogFamilyProposalOwnershipRoot",
    "catalogSemanticLedgerHash",
    "catalogSemanticOutputRoot",
    "catalogBoundaryVerificationReceiptRoot",
    "catalogProposedCapabilitySetRoot",
    "nominationProgramSetRoot",
    "nominationQualificationSetRoot",
  ] as const) {
    const mutation = field === "candidateReleaseCommit"
      ? "f".repeat(40)
      : h(`changed:${field}`);
    const changed = createNominationQualificationDeploymentFactV1(
      { ...nominationDeploymentFactPayload(), [field]: mutation },
      signerKeyId,
      signatureHex,
    );
    assert.notEqual(changed.payloadHash, original.payloadHash, field);
    assert.notDeepEqual(
      nominationQualificationDeploymentFactSigningBytes(changed),
      nominationQualificationDeploymentFactSigningBytes(original),
      field,
    );
  }
  assert.notDeepEqual(
    nominationQualificationDeploymentFactSigningBytes(original, h("changed:signerKeyId")),
    nominationQualificationDeploymentFactSigningBytes(original),
    "signerKeyId",
  );

  const identityMutation = { ...original, catalogBoundaryVerificationReceiptRoot: h("mutated-with-stale-identity") };
  assert.throws(
    () => decodeNominationQualificationDeploymentFactV1(identityMutation),
    /identity mismatch/,
  );
  assert.throws(
    () => RELEASE_AUTHORITY_SCHEMA_MANIFESTS.nominationQualificationDeploymentFact.schema.decode(identityMutation),
    /identity mismatch/,
  );
  assert.throws(
    () => createNominationQualificationDeploymentFactV1(
      { ...nominationDeploymentFactPayload(), catalogProposedCapabilitySetRoot: `0x${"0".repeat(64)}` },
      signerKeyId,
      signatureHex,
    ),
    /must be non-zero/,
  );
});

test("nomination qualification set is exact, ordered, non-empty, and duplicate-free", () => {
  const first = h("nomination-leaf-a");
  const second = h("nomination-leaf-b");
  const entry = (proposalLeafDigest: Hash) => ({
    proposalLeafDigest,
    criticalMutationCorpusRoot: h(`mutations:${proposalLeafDigest}`),
    independentOracleCaseRoot: h(`oracle:${proposalLeafDigest}`),
    qualificationSpecDigest: h(`spec:${proposalLeafDigest}`),
    verifierQualificationCertificateRoot: h(`certificate:${proposalLeafDigest}`),
  });
  const sealed = sealRuntimeReleaseNominationQualificationSetV1([entry(second), entry(first)]);
  assert.deepEqual(sealed.entries.map(value => value.proposalLeafDigest), [first, second].sort());
  assert.deepEqual(decodeRuntimeReleaseNominationQualificationSetV1(sealed), sealed);
  assert.throws(() => sealRuntimeReleaseNominationQualificationSetV1([]), /empty/);
  assert.throws(() => sealRuntimeReleaseNominationQualificationSetV1([entry(first), entry(first)]), /duplicate proposals/);
  assert.throws(
    () => decodeRuntimeReleaseNominationQualificationSetV1({ ...sealed, entries: [...sealed.entries].reverse() }),
    /root\/order mismatch/,
  );
  assert.throws(
    () => decodeRuntimeReleaseNominationQualificationSetV1({ ...sealed, root: h("forged-nomination-root") }),
    /root\/order mismatch/,
  );
});

test("discovery qualification separates signed endpoint join from durable source continuity", () => {
  const value = payload().discoverySourceQualification;
  assert.throws(
    () => createRuntimeReleaseBindingV1({
      ...payload(),
      discoverySourceQualification: { ...value, sourceConfigRoot: h("forged-source-config") },
    } as RuntimeReleaseBindingPayloadV1, h("signer"), `0x${"11".repeat(64)}`),
    /config root mismatch/,
  );
  const replacedBackend = createRuntimeReleaseDiscoverySourceQualificationV1({
    providerIdentity: value.providerIdentity,
    backendEpoch: "reth-backend-2",
    profile: value.profile,
    chainId: value.chainId,
    endpointLocatorHash: value.endpointLocatorHash,
    qualificationRoot: h("discovery-source-qualification-2"),
  });
  const original = createRuntimeReleaseBindingV1(payload(), h("signer"), `0x${"11".repeat(64)}`);
  const changed = createRuntimeReleaseBindingV1({
    ...payload(),
    discoverySourceQualification: replacedBackend,
  }, h("signer"), `0x${"11".repeat(64)}`);
  assert.notEqual(changed.bindingId, original.bindingId);
  assert.notEqual(
    runtimeReleaseDiscoverySourceAuthorityRootV1(replacedBackend),
    runtimeReleaseDiscoverySourceAuthorityRootV1(value),
  );

  const movedEndpoint = createRuntimeReleaseDiscoverySourceQualificationV1({
    providerIdentity: value.providerIdentity,
    backendEpoch: value.backendEpoch,
    profile: value.profile,
    chainId: value.chainId,
    endpointLocatorHash: hashRuntimeReleaseDiscoveryEndpointLocatorV1("http://127.0.0.1:9545"),
    qualificationRoot: value.qualificationRoot,
  });
  assert.equal(movedEndpoint.sourceConfigRoot, value.sourceConfigRoot);
  assert.equal(
    runtimeReleaseDiscoverySourceAuthorityRootV1(movedEndpoint),
    runtimeReleaseDiscoverySourceAuthorityRootV1(value),
  );
  const movedBinding = createRuntimeReleaseBindingV1({
    ...payload(),
    discoverySourceQualification: movedEndpoint,
  }, h("signer"), `0x${"11".repeat(64)}`);
  assert.notEqual(movedBinding.bindingId, original.bindingId);
  assert.notDeepEqual(runtimeReleaseBindingSigningBytes(movedBinding), runtimeReleaseBindingSigningBytes(original));

  const changedProvider = createRuntimeReleaseDiscoverySourceQualificationV1({
    providerIdentity: "reth-secondary",
    backendEpoch: value.backendEpoch,
    profile: value.profile,
    chainId: value.chainId,
    endpointLocatorHash: value.endpointLocatorHash,
    qualificationRoot: value.qualificationRoot,
  });
  const changedQualification = createRuntimeReleaseDiscoverySourceQualificationV1({
    providerIdentity: value.providerIdentity,
    backendEpoch: value.backendEpoch,
    profile: value.profile,
    chainId: value.chainId,
    endpointLocatorHash: value.endpointLocatorHash,
    qualificationRoot: h("discovery-source-qualification-2"),
  });
  const changedChain = createRuntimeReleaseDiscoverySourceQualificationV1({
    providerIdentity: value.providerIdentity,
    backendEpoch: value.backendEpoch,
    profile: value.profile,
    chainId: "10",
    endpointLocatorHash: value.endpointLocatorHash,
    qualificationRoot: value.qualificationRoot,
  });
  for (const changed of [changedProvider, changedQualification, changedChain]) {
    assert.notEqual(
      runtimeReleaseDiscoverySourceAuthorityRootV1(changed),
      runtimeReleaseDiscoverySourceAuthorityRootV1(value),
    );
  }
});

test("wire self-consistency never claims to verify the external signature", () => {
  const binding = createRuntimeReleaseBindingV1(payload(), h("unknown-signer"), `0x${"22".repeat(64)}`);
  assert.deepEqual(decodeRuntimeReleaseBindingV1(binding), binding);
  assert.equal("verified" in binding, false);
  assert.equal("authority" in binding, false);
  assert.throws(() => decodeRuntimeReleaseBindingV1({ ...binding, signatureHex: `0x${"00".repeat(64)}` }), /signature must not be zero/);
});

function qualifiedProjection() {
  const refs = [{
    capabilityId: "family.swap.exact",
    version: "1.0.0",
    schemaHash: h("swap-schema"),
    interpreterHash: h("swap-interpreter"),
    ownerRef: h("swap-owner"),
  }];
  return {
    schemaVersion: 1 as const,
    kind: "aloha.runtime-release-qualified-capability-projection" as const,
    bindingId: h("binding"),
    releaseProvenanceHash: h("provenance"),
    qualifiedCapabilityRefsRoot: hashDomain("aloha/proposed-capability-set/v1", {
      refs,
      leafRoots: [hashDomain("aloha/proposed-capability-ref/v1", refs[0])],
    }),
    refs,
  };
}

test("qualified capability projection is exact, rooted, and mutation-failing", () => {
  const projection = qualifiedProjection();
  const decoded = decodeRuntimeReleaseQualifiedCapabilityProjectionV1(projection);
  assert.deepEqual(decoded, projection);
  assert.throws(
    () => decodeRuntimeReleaseQualifiedCapabilityProjectionV1({ ...projection, unexpected: true }),
    /unknown|unexpected|exact/i,
  );
  assert.throws(
    () => decodeRuntimeReleaseQualifiedCapabilityProjectionV1({ ...projection, qualifiedCapabilityRefsRoot: h("wrong-root") }),
    /root mismatch/,
  );
  assert.throws(
    () => decodeRuntimeReleaseQualifiedCapabilityProjectionV1({
      ...projection,
      refs: [{ ...projection.refs[0], ownerRef: h("foreign-owner") }],
    }),
    /root mismatch/,
  );
});
