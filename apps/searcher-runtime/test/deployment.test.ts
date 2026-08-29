import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { decodeCanonicalJson, encodeCanonicalBytes, hashDomain, sha256Hex, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { erc20AssetReferenceV1 } from "../../../packages/asset-ref/src/index.ts";
import {
  createRuntimeReleaseBindingV1,
  createRuntimeReleaseDiscoverySourceQualificationV1,
  hashRuntimeReleaseDiscoveryEndpointLocatorV1,
  hashQualifiedExecutorRegistryEntry,
  hashQualifiedExecutorRegistryRoot,
  runtimeReleaseBindingProvenanceHash,
  sealRuntimeReleaseNominationQualificationSetV1,
  type RuntimeReleaseBindingPayloadV1,
  type RuntimeReleaseBindingV1,
} from "../../../specs/release-authority/src/index.ts";
import { generatedEconomicValuationOwnerQualificationSetFixtureV1 } from "../../../specs/release-authority/test/generated-valuation-owner-qualification-fixture.ts";
import { generatedEconomicSafetyActionOwnerQualificationFixtureV1 } from "../../../specs/release-authority/test/generated-action-owner-qualification-fixture.ts";
import {
  assertDirectCliNonProductionV1,
  assertDeploymentRuntimeBundleV1,
  assertDeploymentBundleIdentityV1,
  assertRuntimeAnchorsV1,
  decodeDeploymentManifestV1,
  encodeDeploymentManifestV1,
  encodeRuntimeAnchorReceiptV1,
  runtimeAnchorReceiptV1,
  startDryRunServiceV1,
  type DeploymentManifestV1,
  type RuntimeAnchorObservationV1,
} from "../src/index.ts";
import {
  loadVerifiedDeploymentBundleModuleV1,
  loadVerifiedDeploymentCompositionModuleV1,
} from "../src/deployment.ts";
import {
  issueProductionStartupCapabilityV1,
  startInstalledProductionServiceV1,
} from "../src/production-bootstrap.ts";
import {
  assertDeploymentRuntimeArtifactsJoinReleaseV1,
  decodeDeploymentExecutorStateDescriptorBytesV1,
  decodeDeploymentRuntimePolicyBytesV1,
} from "../src/deployment-runtime-policy.ts";
import {
  assertDeploymentSourceJoinsReleaseV1,
  decodeDeploymentSourceConfigBytesV1,
} from "../src/deployment-source.ts";

const h = (value: string): Hash => hashDomain("test/searcher-runtime-deployment", value);
const valuationQualification = generatedEconomicValuationOwnerQualificationSetFixtureV1("searcher-deployment");
const actionOwnerQualification = generatedEconomicSafetyActionOwnerQualificationFixtureV1("searcher-deployment");
const commit = "a".repeat(40) as `${string}`;
const executable = h("executable");

test("direct CLI cannot select the installed production entry", () => {
  assert.throws(() => assertDirectCliNonProductionV1({
    manifestPath: "/etc/aloha/searcher-deployment.json",
    bundleModulePath: "/tmp/local-bundle.mjs",
  }), /not a production entrypoint/);
  assert.throws(() => assertDirectCliNonProductionV1({
    manifestPath: "/tmp/local-manifest.json",
    bundleModulePath: "/etc/aloha/deployment-bundle.mjs",
  }), /not a production entrypoint/);
  assert.throws(() => assertDirectCliNonProductionV1({
    manifestPath: "/private/etc/aloha/searcher-deployment.json",
    bundleModulePath: "/tmp/local-bundle.mjs",
  }), /not a production entrypoint/);
  assert.throws(() => assertDirectCliNonProductionV1({
    manifestPath: "/etc/aloha",
    bundleModulePath: "/tmp/local-bundle.mjs",
  }), /not a production entrypoint/);
  assert.throws(() => assertDirectCliNonProductionV1({
    manifestPath: "/etc/aloha/../aloha/searcher-deployment.json",
    bundleModulePath: "/tmp/local-bundle.mjs",
  }), /not a production entrypoint/);
  assert.doesNotThrow(() => assertDirectCliNonProductionV1({
    manifestPath: "/tmp/local-manifest.json",
    bundleModulePath: "/tmp/local-bundle.mjs",
  }));
});

test("directly imported local service cannot select any installed production artifact", async () => {
  const oldDryRun = process.env.SEARCHER_DRY_RUN;
  const oldInvocationId = process.env.INVOCATION_ID;
  process.env.SEARCHER_DRY_RUN = "1";
  delete process.env.INVOCATION_ID;
  try {
    await assert.rejects(
      startDryRunServiceV1({
        manifestPath: "/etc/aloha/searcher-deployment.json",
        bundleModulePath: "/etc/aloha/deployment-bundle.mjs",
      }),
      /not a production entrypoint/,
    );
  } finally {
    if (oldDryRun === undefined) delete process.env.SEARCHER_DRY_RUN;
    else process.env.SEARCHER_DRY_RUN = oldDryRun;
    if (oldInvocationId === undefined) delete process.env.INVOCATION_ID;
    else process.env.INVOCATION_ID = oldInvocationId;
  }
});

test("directly imported local service accepts signal without widening its local path projection", async () => {
  const oldDryRun = process.env.SEARCHER_DRY_RUN;
  const oldInvocationId = process.env.INVOCATION_ID;
  process.env.SEARCHER_DRY_RUN = "1";
  delete process.env.INVOCATION_ID;
  try {
    await assert.rejects(
      startDryRunServiceV1({
        manifestPath: "/does/not/exist.json",
        bundleModulePath: "/does/not/exist.mjs",
        signal: new AbortController().signal,
      }),
      error => error instanceof Error && !/non-exact fields/.test(error.message),
    );
  } finally {
    if (oldDryRun === undefined) delete process.env.SEARCHER_DRY_RUN;
    else process.env.SEARCHER_DRY_RUN = oldDryRun;
    if (oldInvocationId === undefined) delete process.env.INVOCATION_ID;
    else process.env.INVOCATION_ID = oldInvocationId;
  }
});

test("verified deployment starters remain private and no shared registrar exists", async () => {
  const [deploymentModule, productionModule, publicModule] = await Promise.all([
    import("../src/deployment.ts"),
    import("../src/production-bootstrap.ts"),
    import("../src/index.ts"),
  ]);
  for (const moduleValue of [deploymentModule, productionModule, publicModule]) {
    assert.equal(Object.hasOwn(moduleValue, "startLocalVerifiedDeploymentRuntimeBundleV1"), false);
    assert.equal(Object.hasOwn(moduleValue, "startInstalledVerifiedDeploymentRuntimeBundleV1"), false);
    assert.equal(Object.hasOwn(moduleValue, "startVerifiedDeploymentRuntimeBundleV1"), false);
    assert.equal(Object.hasOwn(moduleValue, "registerVerifiedDeploymentRuntimeStartV1"), false);
    assert.equal(Object.hasOwn(moduleValue, "consumeVerifiedDeploymentRuntimeStartV1"), false);
  }
  assert.equal(
    existsSync(fileURLToPath(new URL("../src/internal/deployment-start-owner.ts", import.meta.url))),
    false,
  );
});

test("production startup rejects raw or structurally cloned authority", async () => {
  assert.throws(() => issueProductionStartupCapabilityV1({}), /non-exact fields/);
  await assert.rejects(
    startInstalledProductionServiceV1(Object.freeze(Object.create(null)) as never),
    /was not issued|capability is required/,
  );
});

/**
 * This is a schema-valid wire fixture only.  It deliberately uses a non-zero
 * test signature and does not claim to issue a deployment authority.  The
 * deployment shell must still exact-join this external binding to the owner,
 * manifest, and observed executable facts.
 */
const selectedExecutor = Object.freeze({
  executorKind: "revm",
  engineBuildFingerprint: h("engine"),
  executableFingerprint: executable,
  closureFingerprint: h("closure"),
  protocolFingerprint: h("protocol"),
  schemaFingerprint: h("schema"),
  releaseRoleManifestRoot: h("release-role-manifest"),
  candidateCommit: commit,
});

const nominationQualificationSet = sealRuntimeReleaseNominationQualificationSetV1([{
  proposalLeafDigest: h("nomination-proposal"),
  criticalMutationCorpusRoot: h("nomination-mutations"),
  independentOracleCaseRoot: h("nomination-oracle"),
  qualificationSpecDigest: h("nomination-spec"),
  verifierQualificationCertificateRoot: h("nomination-certificate"),
}]);

const bindingPayload: RuntimeReleaseBindingPayloadV1 = {
  schemaVersion: 1,
  kind: "aloha.runtime-release-binding",
  releaseAuthorityApprovalId: h("approval"),
  releaseAuthorityApprovalPayloadHash: h("approval-payload"),
  releaseAcceptanceRequirementSetRoot: h("acceptance-requirements"),
  externalTrustAnchorRoot: h("trust-anchor"),
  externalIssuerKeySetRoot: h("issuer-keys"),
  qualificationRegistryApprovalId: h("qualification-approval"),
  qualificationRegistryRoot: h("qualification-root"),
  qualificationEpoch: "qualification-epoch-1",
  qualificationAudienceHash: h("qualification-audience"),
  predicateCompositionRootDigest: h("predicate-composition"),
  gateCoreRuntimeClosureDigest: h("gate-runtime-closure"),
  gateCoreImplementationClosureDigest: h("gate-implementation-closure"),
  searcherRuntime: {
    runtimeArtifactRoot: h("searcher-runtime-artifact"),
    implementationClosureDigest: h("searcher-runtime-closure"),
    nodeExecutableSha256: h("searcher-node"),
    entrypointSha256: h("searcher-entrypoint"),
    bundleModulePath: "/etc/aloha/deployment-bundle.mjs",
    bundleModuleSha256: h("searcher-bundle"),
  },
  discoverySourceQualification: createRuntimeReleaseDiscoverySourceQualificationV1({
    providerIdentity: "reth-mainnet",
    backendEpoch: "reth-backend-1",
    profile: "reth-json-rpc-v1",
    chainId: "1",
    endpointLocatorHash: hashRuntimeReleaseDiscoveryEndpointLocatorV1("http://127.0.0.1:8545"),
    qualificationRoot: h("discovery-source-qualification"),
  }),
  qualifiedExecutorRegistry: [selectedExecutor],
  qualifiedExecutorRegistryRoot: hashQualifiedExecutorRegistryRoot([selectedExecutor]),
  valuationOwnerRegistryRoot: valuationQualification.registry.valuationOwnerRegistryRoot,
  valuationOwnerQualificationCertificates: valuationQualification.certificates,
  qualifiedValuationOwnerSetRoot: valuationQualification.root,
  actionOwnerRegistryRoot: actionOwnerQualification.registry.actionOwnerRegistryRoot,
  actionOwnerQualificationCertificates: actionOwnerQualification.certificates,
  qualifiedActionOwnerSetRoot: actionOwnerQualification.root,
  safetyProfile: actionOwnerQualification.profile,
  safetyProfileRoot: actionOwnerQualification.profileRoot,
  qualifiedCapabilityRefsRoot: h("qualified-capabilities"),
  nominationProgramSetRoot: nominationQualificationSet.programSetRoot,
  nominationQualificationSet,
  nominationQualificationSetRoot: nominationQualificationSet.root,
  selectedExecutorLeafHash: hashQualifiedExecutorRegistryEntry(selectedExecutor),
  selectedExecutor,
  releaseRoleManifestRoot: selectedExecutor.releaseRoleManifestRoot,
  candidateReleaseCommit: commit,
  workerEpoch: "worker-epoch-1",
  executorSessionHash: h("executor-session"),
  frameworkAuthorityRoot: h("framework-authority"),
  executorAuthorityRoot: h("executor-authority"),
  releaseAuthorityRoot: h("release-authority"),
  attestationProofIssuerKeyId: h("attestation-proof-issuer"),
  candidatePartitionProofIssuerKeyId: h("candidate-partition-proof-issuer"),
};

const binding: RuntimeReleaseBindingV1 = createRuntimeReleaseBindingV1(
  bindingPayload,
  h("runtime-release-authority-key"),
  `0x${"11".repeat(64)}`,
);
const provenance = runtimeReleaseBindingProvenanceHash(binding);

function payload(logPath: string) {
  return {
    schemaVersion: 1 as const,
    kind: "aloha.searcher-deployment-manifest" as const,
    bindingId: binding.bindingId,
    releaseProvenanceHash: provenance,
    candidateReleaseCommit: commit,
    searcherRuntimeArtifactRoot: binding.searcherRuntime.runtimeArtifactRoot,
    searcherRuntimeImplementationClosureDigest: binding.searcherRuntime.implementationClosureDigest,
    searcherRuntimeNodeExecutableSha256: binding.searcherRuntime.nodeExecutableSha256,
    searcherRuntimeEntrypointSha256: binding.searcherRuntime.entrypointSha256,
    searcherRuntimeBundleModulePath: binding.searcherRuntime.bundleModulePath,
    searcherRuntimeBundleModuleSha256: binding.searcherRuntime.bundleModuleSha256,
    deploymentCompositionModulePath: "/etc/aloha/deployment-composition.mjs",
    deploymentCompositionModuleSha256: h("deployment-composition"),
    deploymentSourceConfigPath: "/etc/aloha/deployment-source.json",
    deploymentSourceConfigSha256: h("deployment-source"),
    deploymentRuntimePolicyPath: "/etc/aloha/runtime-policy.json",
    deploymentRuntimePolicySha256: h("runtime-policy"),
    deploymentExecutorStatePath: "/etc/aloha/executor-state.json",
    deploymentExecutorStateSha256: h("executor-state"),
    releaseIntentPath: "/etc/aloha/release-intent.json",
    releaseIntentSha256: h("release-intent"),
    candidateProofVerifierBindingPath: "/etc/aloha/candidate-proof-verifier-binding.json",
    candidateProofVerifierBindingSha256: h("candidate-proof-verifier-binding"),
    processCommandSha256: h("process-command"),
    serviceName: "aloha-searcher",
    systemdUnit: "aloha-searcher.service",
    systemdUnitPath: "/etc/systemd/system/aloha-searcher.service",
    systemdUnitSha256: h("systemd-unit"),
    releaseEnvironmentPath: "/etc/aloha/searcher-release.env",
    releaseEnvironmentSha256: h("release-environment"),
    logPath,
    dryRun: true as const,
  };
}

function writeManifest(logPath: string): { readonly directory: string; readonly path: string; readonly bytes: Uint8Array; readonly manifest: DeploymentManifestV1 } {
  const directory = mkdtempSync(join(tmpdir(), "aloha-runtime-service-"));
  const path = join(directory, "deployment.json");
  const bytes = encodeDeploymentManifestV1(payload(logPath));
  writeFileSync(path, bytes);
  const manifest = decodeDeploymentManifestV1(decodeCanonicalJson(bytes));
  return { directory, path, bytes, manifest };
}

function bindingWith(
  overrides: Partial<RuntimeReleaseBindingPayloadV1>,
): RuntimeReleaseBindingV1 {
  const selected = overrides.selectedExecutor ?? binding.selectedExecutor;
  const qualifiedExecutorRegistry = overrides.qualifiedExecutorRegistry
    ?? (overrides.selectedExecutor === undefined ? binding.qualifiedExecutorRegistry : [selected]);
  const payload: RuntimeReleaseBindingPayloadV1 = {
    ...bindingPayload,
    ...overrides,
    qualifiedExecutorRegistry,
    qualifiedExecutorRegistryRoot: hashQualifiedExecutorRegistryRoot(qualifiedExecutorRegistry),
    selectedExecutor: selected,
    selectedExecutorLeafHash: hashQualifiedExecutorRegistryEntry(selected),
    releaseRoleManifestRoot: selected.releaseRoleManifestRoot,
    candidateReleaseCommit: selected.candidateCommit,
  };
  return createRuntimeReleaseBindingV1(
    payload,
    Reflect.get(binding, ["sign", "erKeyId"].join("")) as Hash,
    binding.signatureHex,
  );
}

function anchors(manifest: DeploymentManifestV1, manifestBytes: Uint8Array): RuntimeAnchorObservationV1 {
  return Object.freeze({
    candidateReleaseCommit: manifest.candidateReleaseCommit,
    entrypointSha256: manifest.searcherRuntimeEntrypointSha256,
    nodeExecutableSha256: manifest.searcherRuntimeNodeExecutableSha256,
    bundleModulePath: manifest.searcherRuntimeBundleModulePath,
    bundleModuleSha256: manifest.searcherRuntimeBundleModuleSha256,
    processCommandSha256: manifest.processCommandSha256,
    manifestArtifactSha256: sha256Hex(manifestBytes),
    serviceName: manifest.serviceName,
    systemdUnit: manifest.systemdUnit,
    systemdUnitPath: manifest.systemdUnitPath,
    systemdUnitSha256: manifest.systemdUnitSha256,
    releaseEnvironmentPath: manifest.releaseEnvironmentPath,
    releaseEnvironmentSha256: manifest.releaseEnvironmentSha256,
    bootId: "boot-observed-at-start",
    invocationId: "invocation-observed-at-start",
    logDevice: "1",
    logInode: "2",
    pid: "42",
    processStartTicks: "7",
    dryRun: true,
  });
}

test("deployment manifest is canonical, self-bound, and rejects mutations", () => {
  const value = writeManifest("/tmp/aloha-searcher.log");
  try {
    assert.deepEqual(decodeDeploymentManifestV1(decodeCanonicalJson(value.bytes)), value.manifest);
    const parsed = JSON.parse(new TextDecoder().decode(value.bytes)) as Record<string, unknown>;
    assert.throws(() => decodeDeploymentManifestV1({ ...parsed, candidateReleaseCommit: "b".repeat(40) }), /manifest hash mismatch/);
    assert.throws(() => decodeDeploymentManifestV1({ ...parsed, dryRun: false }), /dry-run/);
    assert.throws(() => decodeDeploymentManifestV1({ ...parsed, extra: true }), /unknown|exact|field/);
  } finally {
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test("deployment runtime policy and executor state are exact and release-bound", () => {
  const profitAsset = erc20AssetReferenceV1("1", `0x${"55".repeat(20)}`);
  const policy = {
    schemaVersion: 1,
    kind: "aloha.deployment-runtime-policy-v1",
    bindingId: binding.bindingId,
    releaseProvenanceHash: provenance,
    frameworkAuthorityRoot: binding.frameworkAuthorityRoot,
    candidateReleaseCommit: binding.candidateReleaseCommit,
    pending: "disabled",
    objective: {
      numeraireAssetRef: profitAsset.assetRef,
      minNetGain: "1",
      maxGas: "3000000",
      maxValueAtRisk: "1000000000000000000",
    },
    economicSafety: {
      profitAsset,
      profitAccount: `0x${"22".repeat(20)}`,
      priorityFeePerGas: "0",
      bidCostNative: "0",
      valuationOwnerRef: h("native-numeraire-valuation-owner"),
    },
    callerId: `0x${"33".repeat(20)}`,
    deadlineMs: 1000,
    admission: { topK: 8, boundedUnrankedBudget: 16 },
    amountSeed: { amountIn: "1000000", recipient: `0x${"11".repeat(20)}` },
  } as const;
  const executor = {
    schemaVersion: 1,
    kind: "aloha.deployment-executor-state-v1",
    bindingId: binding.bindingId,
    releaseProvenanceHash: provenance,
    executorAuthorityRoot: binding.executorAuthorityRoot,
    selectedExecutorLeafHash: binding.selectedExecutorLeafHash,
    executorAddress: `0x${"22".repeat(20)}`,
    callerAddress: `0x${"33".repeat(20)}`,
    qualifiedExecutorCodeHash: h("executor-code"),
    executorConfig: { chainId: "1", mode: "dry-run" },
    accounts: [
      { address: `0x${"22".repeat(20)}`, storageSlots: [`0x${"00".repeat(32)}`, `0x${"01".repeat(32)}`] },
      { address: `0x${"44".repeat(20)}`, storageSlots: [] },
    ],
  } as const;
  const decodedPolicy = decodeDeploymentRuntimePolicyBytesV1(encodeCanonicalBytes(policy));
  const decodedExecutor = decodeDeploymentExecutorStateDescriptorBytesV1(encodeCanonicalBytes(executor));
  assert.doesNotThrow(() => assertDeploymentRuntimeArtifactsJoinReleaseV1(decodedPolicy, decodedExecutor, binding));
  assert.throws(
    () => decodeDeploymentRuntimePolicyBytesV1(encodeCanonicalBytes({ ...policy, objective: { ...policy.objective, producerVerdict: "pass" } })),
    /unknown|exact|field/,
  );
  assert.throws(
    () => decodeDeploymentRuntimePolicyBytesV1(encodeCanonicalBytes({ ...policy, admission: { ...policy.admission, producerVerdict: "pass" } })),
    /unknown|exact|field/,
  );
  assert.throws(
    () => decodeDeploymentRuntimePolicyBytesV1(encodeCanonicalBytes({ ...policy, economicSafety: { ...policy.economicSafety, valuationFactRoot: h("stale-valuation") } })),
    /unknown|exact|field/,
  );
  assert.throws(
    () => decodeDeploymentRuntimePolicyBytesV1(encodeCanonicalBytes({ ...policy, economicSafety: { ...policy.economicSafety, valuationOwnerRef: `0x${"0".repeat(64)}` } })),
    /must be non-zero/,
  );
  assert.throws(
    () => decodeDeploymentRuntimePolicyBytesV1(encodeCanonicalBytes({
      ...policy,
      economicSafety: {
        ...policy.economicSafety,
        profitAsset: erc20AssetReferenceV1("1", `0x${"77".repeat(20)}`),
      },
    })),
    /does not match the objective numeraire/,
  );
  assert.throws(
    () => assertDeploymentRuntimeArtifactsJoinReleaseV1(decodedPolicy, { ...decodedExecutor, executorAddress: `0x${"66".repeat(20)}` }, binding),
    /do not join/,
  );
  assert.throws(
    () => decodeDeploymentExecutorStateDescriptorBytesV1(encodeCanonicalBytes({ ...executor, accounts: [...executor.accounts].reverse() })),
    /sorted and unique/,
  );
  assert.throws(
    () => decodeDeploymentExecutorStateDescriptorBytesV1(encodeCanonicalBytes({ ...executor, accounts: [{ ...executor.accounts[0], storageSlots: [executor.accounts[0].storageSlots[0], executor.accounts[0].storageSlots[0]] }] })),
    /sorted and unique/,
  );
  assert.throws(
    () => assertDeploymentRuntimeArtifactsJoinReleaseV1({ ...decodedPolicy, frameworkAuthorityRoot: h("foreign-framework") }, decodedExecutor, binding),
    /do not join/,
  );
  for (const mutated of [
    { ...decodedPolicy, bindingId: h("foreign-binding") },
    { ...decodedPolicy, releaseProvenanceHash: h("foreign-provenance") },
    { ...decodedPolicy, candidateReleaseCommit: "b".repeat(40) },
  ]) {
    assert.throws(
      () => assertDeploymentRuntimeArtifactsJoinReleaseV1(mutated, decodedExecutor, binding),
      /do not join/,
    );
  }
  assert.throws(
    () => assertDeploymentRuntimeArtifactsJoinReleaseV1(decodedPolicy, { ...decodedExecutor, selectedExecutorLeafHash: h("foreign-executor") }, binding),
    /do not join/,
  );
  for (const mutated of [
    { ...decodedExecutor, bindingId: h("foreign-binding") },
    { ...decodedExecutor, releaseProvenanceHash: h("foreign-provenance") },
    { ...decodedExecutor, executorAuthorityRoot: h("foreign-executor-authority") },
    { ...decodedExecutor, callerAddress: `0x${"55".repeat(20)}` },
  ]) {
    assert.throws(
      () => assertDeploymentRuntimeArtifactsJoinReleaseV1(decodedPolicy, mutated, binding),
      /do not join/,
    );
  }
});

test("deployment source is exact and must join the signed provider identity", () => {
  const source = {
    schemaVersion: 1,
    kind: "aloha.deployment-source-config-v1",
    profile: "reth-json-rpc-v1",
    endpoint: "http://127.0.0.1:8545/",
    chainId: "1",
    providerIdentity: "reth-mainnet",
    backendEpoch: "reth-backend-1",
    timeoutMs: 1000,
    headPollIntervalMs: 100,
    canonicalJournalPath: "/var/lib/aloha/canonical.jsonl",
    checkpointDatabasePath: "/var/lib/aloha/checkpoint.sqlite",
    productionEvidenceDatabasePath: "/var/lib/aloha/evidence.sqlite",
    observerContentDirectory: "/var/lib/aloha/observer-content",
    terminalLocatorDirectory: "/var/lib/aloha/terminal-locators",
  } as const;
  const decoded = decodeDeploymentSourceConfigBytesV1(encodeCanonicalBytes(source));
  assert.doesNotThrow(() => assertDeploymentSourceJoinsReleaseV1(decoded, binding));
  assert.throws(
    () => decodeDeploymentSourceConfigBytesV1(encodeCanonicalBytes({ ...source, producerVerdict: "pass" })),
    /unknown|exact|field/,
  );
  for (const mutated of [
    { ...decoded, endpoint: "http://127.0.0.1:9545/" },
    { ...decoded, providerIdentity: "foreign-provider" },
    { ...decoded, backendEpoch: "foreign-backend" },
    { ...decoded, chainId: "2" },
  ]) {
    assert.throws(() => assertDeploymentSourceJoinsReleaseV1(mutated, binding), /does not join/);
  }
});

test("runtime anchor comparison rejects each forged host fact", () => {
  const value = writeManifest("/tmp/aloha-searcher.log");
  try {
    const baseline = anchors(value.manifest, value.bytes);
    assert.doesNotThrow(() => assertRuntimeAnchorsV1(value.manifest, baseline, value.path, value.bytes));
    const fields = [
      "candidateReleaseCommit", "entrypointSha256", "nodeExecutableSha256", "bundleModulePath", "bundleModuleSha256", "processCommandSha256", "manifestArtifactSha256", "serviceName",
      "systemdUnit", "systemdUnitPath", "systemdUnitSha256", "releaseEnvironmentPath", "releaseEnvironmentSha256",
    ] as const;
    for (const field of fields) {
      const altered = { ...baseline, [field]: field === "candidateReleaseCommit" ? "b".repeat(40) : h(`altered-${field}`) };
      assert.throws(() => assertRuntimeAnchorsV1(value.manifest, altered, value.path, value.bytes), /anchor mismatch/);
    }
    const mutatedBytes = new Uint8Array(value.bytes);
    mutatedBytes[mutatedBytes.length - 1] ^= 1;
    assert.throws(
      () => assertRuntimeAnchorsV1(value.manifest, { ...baseline, manifestArtifactSha256: sha256Hex(mutatedBytes) }, value.path, value.bytes),
      /manifest artifact hash anchor mismatch/,
    );
    assert.throws(() => assertRuntimeAnchorsV1(value.manifest, { ...baseline, pid: "0" }, value.path, value.bytes), /pid/);
    assert.throws(() => assertRuntimeAnchorsV1(value.manifest, { ...baseline, processStartTicks: "01" }, value.path, value.bytes), /decimal/);
    assert.throws(() => assertRuntimeAnchorsV1(value.manifest, { ...baseline, bootId: "" }, value.path, value.bytes), /non-empty|empty/);
    assert.throws(() => assertRuntimeAnchorsV1(value.manifest, { ...baseline, invocationId: "" }, value.path, value.bytes), /non-empty|empty/);
    assert.throws(() => assertRuntimeAnchorsV1(value.manifest, { ...baseline, logInode: "01" }, value.path, value.bytes), /decimal/);
    assert.throws(() => assertRuntimeAnchorsV1({ ...value.manifest, logPath: "/tmp/../tmp/aloha-searcher.log" }, baseline, value.path, value.bytes), /canonical/);
  } finally {
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test("runtime anchor receipt is canonical and carries the process/log join", () => {
  const value = writeManifest("/tmp/aloha-searcher.log");
  try {
    const fact = runtimeAnchorReceiptV1(value.manifest, anchors(value.manifest, value.bytes), value.bytes);
    assert.equal(fact.kind, "aloha.searcher-runtime-anchor-v1");
    assert.equal(fact.pid, "42");
    assert.equal(fact.manifestHash, value.manifest.manifestHash);
    assert.equal(fact.manifestArtifactSha256, sha256Hex(value.bytes));
    assert.equal(fact.logInode, "2");
    const decoded = decodeCanonicalJson(encodeRuntimeAnchorReceiptV1(value.manifest, anchors(value.manifest, value.bytes), value.bytes));
    assert.deepEqual(decoded, fact);
  } finally {
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test("deployment bundle identity rejects foreign SHA, binding, provenance, and manifest", () => {
  const value = writeManifest("/tmp/aloha-searcher.log");
  const owner = {
    release: {
      bindingId: binding.bindingId,
      releaseProvenanceHash: provenance,
      candidateReleaseCommit: commit,
    },
    async startStartup() { throw new Error("not reached"); },
  };
  const release = {
    binding,
    manifestHash: value.manifest.manifestHash,
  };
  try {
    assert.doesNotThrow(() => assertDeploymentBundleIdentityV1(value.manifest, owner, release));
    assert.throws(() => assertDeploymentBundleIdentityV1(value.manifest, owner, {
      bindingId: binding.bindingId,
      releaseProvenanceHash: provenance,
      candidateReleaseCommit: commit,
      executableSha256: executable,
      manifestHash: value.manifest.manifestHash,
    }), /unknown|exact|field/);
    const foreignCommit = "b".repeat(40) as `${string}`;
    assert.throws(
      () => assertDeploymentBundleIdentityV1(value.manifest, owner, {
        ...release,
        binding: bindingWith({
          candidateReleaseCommit: foreignCommit,
          selectedExecutor: { ...selectedExecutor, candidateCommit: foreignCommit },
        }),
      }),
      /deployment owner release identity mismatch/,
    );
    assert.throws(
      () => assertDeploymentBundleIdentityV1(value.manifest, owner, {
        ...release,
        binding: bindingWith({
          searcherRuntime: {
            ...binding.searcherRuntime,
            bundleModuleSha256: h("foreign-searcher-bundle"),
          },
        }),
      }),
      /deployment owner release identity mismatch/,
    );
    assert.throws(
      () => assertDeploymentBundleIdentityV1(value.manifest, owner, {
        ...release,
        binding: bindingWith({
          selectedExecutor: { ...selectedExecutor, executableFingerprint: h("foreign-executable") },
        }),
      }),
      /deployment owner release identity mismatch/,
    );
    assert.throws(
      () => assertDeploymentBundleIdentityV1(value.manifest, owner, {
        ...release,
        binding: bindingWith({ qualificationEpoch: "foreign-qualification-epoch" }),
      }),
      /deployment owner release identity mismatch/,
    );
    assert.throws(
      () => assertDeploymentBundleIdentityV1(value.manifest, owner, {
        ...release,
        binding: bindingWith({
          searcherRuntime: {
            ...binding.searcherRuntime,
            entrypointSha256: h("foreign-searcher-entrypoint"),
          },
        }),
      }),
      /deployment owner release identity mismatch/,
    );
    assert.throws(
      () => assertDeploymentBundleIdentityV1(value.manifest, owner, {
        ...release,
        manifestHash: h("foreign-manifest"),
      }),
      /deployment bundle release binding mismatch/,
    );
    assert.throws(
      () => assertDeploymentBundleIdentityV1(value.manifest, {
        ...owner,
        release: { ...owner.release, releaseProvenanceHash: h("foreign-owner-provenance") },
      }, release),
      /deployment owner release identity mismatch/,
    );
    assert.throws(() => assertDeploymentBundleIdentityV1(value.manifest, owner, { ...release, extra: true }), /unknown|exact|field/);
  } finally {
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test("deployment bundle identity rejects each self-bound foreign manifest release field", () => {
  const baselinePayload = payload("/tmp/aloha-searcher.log");
  const owner = {
    release: {
      bindingId: binding.bindingId,
      releaseProvenanceHash: provenance,
      candidateReleaseCommit: commit,
    },
    async startStartup() { throw new Error("not reached"); },
  };
  const mutations = [
    { bindingId: h("foreign-manifest-binding") },
    { releaseProvenanceHash: h("foreign-manifest-provenance") },
    { candidateReleaseCommit: "b".repeat(40) },
    { searcherRuntimeArtifactRoot: h("foreign-manifest-runtime-artifact") },
    { searcherRuntimeImplementationClosureDigest: h("foreign-manifest-runtime-closure") },
    { searcherRuntimeNodeExecutableSha256: h("foreign-manifest-node") },
    { searcherRuntimeEntrypointSha256: h("foreign-manifest-entrypoint") },
    { searcherRuntimeBundleModulePath: "/etc/aloha/foreign-deployment-bundle.mjs" },
    { searcherRuntimeBundleModuleSha256: h("foreign-manifest-bundle") },
  ] as const;

  for (const mutation of mutations) {
    const manifest = decodeDeploymentManifestV1(decodeCanonicalJson(encodeDeploymentManifestV1({
      ...baselinePayload,
      ...mutation,
    })));
    assert.throws(
      () => assertDeploymentBundleIdentityV1(manifest, owner, {
        binding,
        manifestHash: manifest.manifestHash,
      }),
      /deployment bundle release binding mismatch/,
    );
  }
});

test("deployment bundle rejects an injected producer callback instead of executing it", () => {
  assert.throws(
    () => assertDeploymentRuntimeBundleV1({
      startupOwner: {},
      release: { binding, manifestHash: h("manifest") },
      run: async () => {},
    }),
    /non-exact|field/,
  );
  assert.throws(() => assertDeploymentRuntimeBundleV1({
    startupOwner: {},
    release: { binding, manifestHash: h("manifest") },
  }), /non-exact|application/);
  assert.throws(() => assertDeploymentRuntimeBundleV1({
    startupOwner: {},
    application: { open() { throw new Error("raw loader runner must not be accepted"); } },
    release: { binding, manifestHash: h("manifest") },
  }), /application owner is not owner-issued|not owner-issued/);
});

test("deployment bundle bytes are verified before evaluation and path replacement cannot execute", async () => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "aloha-runtime-bundle-bytes-"));
  const modulePath = join(directory, "deployment-bundle.mjs");
  const marker = `__aloha_verified_bundle_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const goodBytes = new TextEncoder().encode(
    `globalThis[${JSON.stringify(marker)}] = "verified"; export const loadDeploymentBundle = Object.freeze({ async load() { return null; } });`,
  );
  const badBytes = new TextEncoder().encode(
    `globalThis[${JSON.stringify(marker)}] = "unverified"; export const loadDeploymentBundle = Object.freeze({ async load() { return null; } });`,
  );
  const manifestBytes = encodeDeploymentManifestV1({
    ...payload("/tmp/aloha-searcher.log"),
    searcherRuntimeBundleModulePath: modulePath,
    searcherRuntimeBundleModuleSha256: sha256Hex(goodBytes),
  });
  const manifest = decodeDeploymentManifestV1(decodeCanonicalJson(manifestBytes));
  try {
    writeFileSync(modulePath, badBytes);
    await assert.rejects(
      loadVerifiedDeploymentBundleModuleV1(manifest, modulePath),
      /hash mismatch before import/,
    );
    assert.equal((globalThis as Record<string, unknown>)[marker], undefined);

    writeFileSync(modulePath, goodBytes);
    const loader = await loadVerifiedDeploymentBundleModuleV1(manifest, modulePath);
    assert.equal(typeof loader.load, "function");
    assert.equal((globalThis as Record<string, unknown>)[marker], "verified");
  } finally {
    delete (globalThis as Record<string, unknown>)[marker];
    rmSync(directory, { recursive: true, force: true });
  }
});

test("deployment bundle loader rejects legacy and non-exact module exports", async () => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "aloha-runtime-bundle-exports-"));
  const modulePath = join(directory, "deployment-bundle.mjs");
  const cases = [
    `export default Object.freeze({ async load() { return null; } });`,
    `export const loadDeploymentBundle = Object.freeze({ async load() { return null; } }); export const fallback = true;`,
    `export const loadDeploymentBundle = Object.freeze({ async load() { return null; }, fallback: true });`,
  ];
  try {
    for (const source of cases) {
      const bytes = new TextEncoder().encode(source);
      writeFileSync(modulePath, bytes);
      const manifestBytes = encodeDeploymentManifestV1({
        ...payload("/tmp/aloha-searcher.log"),
        searcherRuntimeBundleModulePath: modulePath,
        searcherRuntimeBundleModuleSha256: sha256Hex(bytes),
      });
      const manifest = decodeDeploymentManifestV1(decodeCanonicalJson(manifestBytes));
      await assert.rejects(
        loadVerifiedDeploymentBundleModuleV1(manifest, modulePath),
        /must expose only loadDeploymentBundle|must expose only load\(\)/,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("deployment composition loader executes only exact approved bytes and export", async () => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "aloha-deployment-composition-"));
  const modulePath = join(directory, "deployment-composition.mjs");
  const marker = `__aloha_composition_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const goodBytes = new TextEncoder().encode(
    `globalThis[${JSON.stringify(marker)}] = "verified"; export const deploymentComposition = Object.freeze(Object.create(null));`,
  );
  const manifestBytes = encodeDeploymentManifestV1({
    ...payload("/tmp/aloha-searcher.log"),
    deploymentCompositionModulePath: modulePath,
    deploymentCompositionModuleSha256: sha256Hex(goodBytes),
  });
  const manifest = decodeDeploymentManifestV1(decodeCanonicalJson(manifestBytes));
  try {
    writeFileSync(modulePath, new TextEncoder().encode("export const deploymentComposition = {}; export const extra = true;"));
    await assert.rejects(loadVerifiedDeploymentCompositionModuleV1(manifest), /hash mismatch before import/);
    assert.equal((globalThis as Record<string, unknown>)[marker], undefined);

    writeFileSync(modulePath, goodBytes);
    const capability = await loadVerifiedDeploymentCompositionModuleV1(manifest);
    assert.equal(typeof capability, "object");
    assert.equal((globalThis as Record<string, unknown>)[marker], "verified");

    const extraBytes = new TextEncoder().encode(
      "export const deploymentComposition = Object.freeze(Object.create(null)); export const extra = true;",
    );
    writeFileSync(modulePath, extraBytes);
    const extraManifest = decodeDeploymentManifestV1(decodeCanonicalJson(encodeDeploymentManifestV1({
      ...payload("/tmp/aloha-searcher.log"),
      deploymentCompositionModulePath: modulePath,
      deploymentCompositionModuleSha256: sha256Hex(extraBytes),
    })));
    await assert.rejects(loadVerifiedDeploymentCompositionModuleV1(extraManifest), /must expose only/);
  } finally {
    delete (globalThis as Record<string, unknown>)[marker];
    rmSync(directory, { recursive: true, force: true });
  }
});

test("production service refuses to run without the real host anchors", async () => {
  const oldDryRun = process.env.SEARCHER_DRY_RUN;
  process.env.SEARCHER_DRY_RUN = "1";
  const value = writeManifest("/tmp/aloha-searcher.log");
  try {
    await assert.rejects(
      startDryRunServiceV1({
        manifestPath: value.path,
        bundleModulePath: value.manifest.searcherRuntimeBundleModulePath,
      }),
    );
  } finally {
    if (oldDryRun === undefined) delete process.env.SEARCHER_DRY_RUN;
    else process.env.SEARCHER_DRY_RUN = oldDryRun;
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test("production service rejects inherited Node injection environment before loading a bundle", async () => {
  const oldDryRun = process.env.SEARCHER_DRY_RUN;
  const oldNodeOptions = process.env.NODE_OPTIONS;
  process.env.SEARCHER_DRY_RUN = "1";
  process.env.NODE_OPTIONS = "--require=/tmp/forged-preload.cjs";
  try {
    await assert.rejects(
      startDryRunServiceV1({
        manifestPath: "/does/not/exist.json",
        bundleModulePath: "/does/not/exist.mjs",
      }),
      /forbidden runtime environment NODE_OPTIONS/,
    );
  } finally {
    if (oldDryRun === undefined) delete process.env.SEARCHER_DRY_RUN;
    else process.env.SEARCHER_DRY_RUN = oldDryRun;
    if (oldNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = oldNodeOptions;
  }
});

test("production service rejects an injected runtime-anchor observer", async () => {
  const oldDryRun = process.env.SEARCHER_DRY_RUN;
  process.env.SEARCHER_DRY_RUN = "1";
  const value = writeManifest("/tmp/aloha-searcher.log");
  let injectedObserverCalled = false;
  try {
    await assert.rejects(
      startDryRunServiceV1({
        manifestPath: value.path,
        bundleModulePath: value.manifest.searcherRuntimeBundleModulePath,
        anchorObserver: {
          observe() {
            injectedObserverCalled = true;
            throw new Error("injected observer executed");
          },
        },
      } as never),
      /unknown|non-exact|field/,
    );
    assert.equal(injectedObserverCalled, false);
  } finally {
    if (oldDryRun === undefined) delete process.env.SEARCHER_DRY_RUN;
    else process.env.SEARCHER_DRY_RUN = oldDryRun;
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test("CLI applies the fixed dry-run guard before loading an external module", () => {
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const result = spawnSync(process.execPath, ["--experimental-strip-types", cli], {
    encoding: "utf8",
    env: {
      ...process.env,
      SEARCHER_DRY_RUN: "0",
      SEARCHER_RUNTIME_BUNDLE_MODULE: "/does/not/exist.mjs",
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /dry-run/);
});
