import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { encodeCanonicalBytes, hashDomain, sha256Hex, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { erc20AssetReferenceV1 } from "../../../packages/asset-ref/src/index.ts";
import { sealReleaseQualifiedCapabilitySetV1 } from "../../../specs/capability-index/src/index.ts";
import {
  createNominationQualificationDeploymentFactV1,
  createRuntimeReleaseBindingV1,
  createRuntimeReleaseDiscoverySourceQualificationV1,
  hashQualifiedExecutorRegistryEntry,
  hashQualifiedExecutorRegistryRoot,
  hashRuntimeReleaseDiscoveryEndpointLocatorV1,
  nominationQualificationDeploymentFactSigningBytes,
  runtimeReleaseBindingProvenanceHash,
  runtimeReleaseBindingSigningBytes,
  sealRuntimeReleaseNominationQualificationSetV1,
  type NominationQualificationDeploymentFactPayloadV1,
  type RuntimeReleaseBindingPayloadV1,
} from "../../../specs/release-authority/src/index.ts";
import { generatedEconomicValuationOwnerQualificationSetFixtureV1 } from "../../../specs/release-authority/test/generated-valuation-owner-qualification-fixture.ts";
import { generatedEconomicSafetyActionOwnerQualificationFixtureV1 } from "../../../specs/release-authority/test/generated-action-owner-qualification-fixture.ts";
import {
  assertRuntimeReleasePackageApprovalJoinV1,
  decodeReleasePackageManifestForRuntimeOwnerV1,
  issuePreReleaseRuntimeStartupCapabilityV1,
} from "../src/release-runtime-owner.ts";
import { decodeReleasePackageManifestV1 } from "../../../tools/runtime-release-packager/src/deployment-package.ts";

const entrypointSource = readFileSync(new URL("../src/release-runtime.ts", import.meta.url), "utf8");
const ownerSource = readFileSync(new URL("../src/release-runtime-owner.ts", import.meta.url), "utf8");
const launcherSource = readFileSync(
  new URL("../../../tools/runtime-release-packager/assets/pre-release-owner.mjs", import.meta.url),
  "utf8",
);
const productionLauncherSource = readFileSync(
  new URL("../../../tools/runtime-release-packager/assets/production-launcher.mjs", import.meta.url),
  "utf8",
);

function orderedWithin(text: string, needles: readonly string[]): void {
  let cursor = -1;
  for (const needle of needles) {
    const next = text.indexOf(needle, cursor + 1);
    assert.ok(next > cursor, `expected boundary step after offset ${cursor}: ${needle}`);
    cursor = next;
  }
}

const h = (value: string): Hash => hashDomain("test/release-runtime-owner-contract", value);
const valuationQualification = generatedEconomicValuationOwnerQualificationSetFixtureV1("pre-release-host-boundary");
const actionOwnerQualification = generatedEconomicSafetyActionOwnerQualificationFixtureV1("pre-release-host-boundary");
const ZERO_HASH = `0x${"0".repeat(64)}` as Hash;
const packageArtifactPaths = Object.freeze({
  "acceptance-certificates.json": "/etc/aloha/acceptance-certificates.json",
  "aloha-searcher.service": "/etc/systemd/system/aloha-searcher.service",
  "candidate-proof-verifier-binding.json": "/etc/aloha/candidate-proof-verifier-binding.json",
  "catalog-generation.inputs.json": "/etc/aloha/runtime-facts/catalog-generation.inputs.json",
  "deployment-bundle.mjs": "/etc/aloha/deployment-bundle.mjs",
  "deployment-composition.mjs": "/etc/aloha/deployment-composition.mjs",
  "deployment-source.json": "/etc/aloha/deployment-source.json",
  "executor-state.json": "/etc/aloha/executor-state.json",
  "family-catalog.ts": "/etc/aloha/runtime-facts/family-catalog.ts",
  "hardware-profile.json": "/etc/aloha/hardware-profile.json",
  "nomination-qualification-deployment-fact.json": "/etc/aloha/nomination-qualification-deployment-fact.json",
  "performance-profile.json": "/etc/aloha/performance-profile.json",
  "performance-window-basis.json": "/etc/aloha/performance-window-basis.json",
  "production-launcher.mjs": "/etc/aloha/production-launcher.mjs",
  "release-acceptance-approval.json": "/etc/aloha/release-acceptance-approval.json",
  "release-acceptance-set.json": "/etc/aloha/release-acceptance-set.json",
  "release-authority-approval.json": "/etc/aloha/release-authority-approval.json",
  "release-intent.json": "/etc/aloha/release-intent.json",
  "runtime-composition.ts": "/etc/aloha/runtime-facts/runtime-composition.ts",
  "runtime-policy.json": "/etc/aloha/runtime-policy.json",
  "runtime-release-binding.json": "/etc/aloha/runtime-release-binding.json",
  "searcher-deployment.json": "/etc/aloha/searcher-deployment.json",
  "searcher-release.env": "/etc/aloha/searcher-release.env",
  "strategy-catalog.ts": "/etc/aloha/runtime-facts/strategy-catalog.ts",
});

function releasePackageFixture() {
  const payload = {
    schemaVersion: 1,
    kind: "aloha.runtime-release-package",
    git: { branch: "codex/aloha", upstreamRef: "refs/remotes/origin/codex/aloha", commit: "2".repeat(40) },
    bindingId: h("binding"),
    releaseProvenanceHash: h("provenance"),
    runtimeSignerPinSha256: h("signer-pin"),
    releaseAcceptanceApprovalId: h("acceptance-approval"),
    releaseAcceptanceApprovalPayloadHash: h("acceptance-approval-payload"),
    releaseAcceptanceRequirementSetRoot: h("acceptance-requirements"),
    releaseAcceptanceSetRoot: h("acceptance-set"),
    controllerBoundaryEvidenceRoot: h("controller-boundary-evidence"),
    deploymentManifestHash: h("deployment-manifest"),
    performance: {
      profileArtifactSha256: h("profile-artifact"), profileHash: h("profile"),
      basisArtifactSha256: h("basis-artifact"), basisId: h("basis"), providerRoot: h("provider"),
      hardwareProfileRoot: h("hardware"), hardwareProfileArtifactSha256: h("hardware-artifact"),
      eligibilityRuleHash: h("eligibility"), commitContextBindingId: h("commit-context"),
      commitAppendRecordId: h("commit-append"),
    },
    artifacts: Object.entries(packageArtifactPaths).sort(([left], [right]) => left.localeCompare(right)).map(
      ([name, installPath]) => ({ name, installPath, sha256: h(`artifact:${name}`), byteLength: "1" }),
    ),
    dryRun: true,
  } as const;
  return Object.freeze({
    ...payload,
    packageRoot: hashDomain("aloha/runtime-release-package/v1", payload),
  });
}

const preReleaseArtifactPaths = Object.freeze({
  "aloha-searcher-pre-release.service": "/run/systemd/system/aloha-searcher-pre-release.service",
  "candidate-proof-verifier-binding.json": "/var/lib/aloha/pre-release/artifacts/candidate-proof-verifier-binding.json",
  "catalog-generation.inputs.json": "/var/lib/aloha/pre-release/artifacts/runtime-facts/catalog-generation.inputs.json",
  "deployment-bundle.mjs": "/var/lib/aloha/pre-release/artifacts/deployment-bundle.mjs",
  "deployment-composition.mjs": "/var/lib/aloha/pre-release/artifacts/deployment-composition.mjs",
  "deployment-source.json": "/var/lib/aloha/pre-release/artifacts/deployment-source.json",
  "executor-state.json": "/var/lib/aloha/pre-release/artifacts/executor-state.json",
  "family-catalog.ts": "/var/lib/aloha/pre-release/artifacts/runtime-facts/family-catalog.ts",
  "nomination-qualification-deployment-fact.json": "/var/lib/aloha/pre-release/artifacts/nomination-qualification-deployment-fact.json",
  "performance-profile.json": "/var/lib/aloha/pre-release/artifacts/performance-profile.json",
  "pre-release-owner.mjs": "/var/lib/aloha/pre-release/artifacts/pre-release-owner.mjs",
  "production-launcher.mjs": "/var/lib/aloha/pre-release/artifacts/production-launcher.mjs",
  "qualified-release-runner-input.json": "/var/lib/aloha/pre-release/artifacts/qualified-release-runner-input.json",
  "release-authority-approval.json": "/var/lib/aloha/pre-release/artifacts/release-authority-approval.json",
  "release-intent.json": "/var/lib/aloha/pre-release/artifacts/release-intent.json",
  "runtime-boundary-projection.json": "/var/lib/aloha/pre-release/artifacts/runtime-boundary-projection.json",
  "runtime-composition.ts": "/var/lib/aloha/pre-release/artifacts/runtime-facts/runtime-composition.ts",
  "runtime-policy.json": "/var/lib/aloha/pre-release/artifacts/runtime-policy.json",
  "runtime-release-binding.json": "/var/lib/aloha/pre-release/artifacts/runtime-release-binding.json",
  "runtime-release-signer-pin.json": "/var/lib/aloha/pre-release/artifacts/runtime-release-signer-pin.json",
  "searcher-pre-release.env": "/var/lib/aloha/pre-release/artifacts/searcher-pre-release.env",
  "staging-manifest.json": "/var/lib/aloha/pre-release/artifacts/staging-manifest.json",
  "strategy-catalog.ts": "/var/lib/aloha/pre-release/artifacts/runtime-facts/strategy-catalog.ts",
});

function snapshot(bytes: Uint8Array) {
  return Object.freeze({
    bytes,
    sha256: sha256Hex(bytes),
    byteLength: String(bytes.byteLength),
    fence: Object.freeze({ dev: "1", ino: "1", size: String(bytes.byteLength), mtimeNs: "1", ctimeNs: "1" }),
  });
}

function preReleaseStartupFixture() {
  const keys = generateKeyPairSync("ed25519");
  const signerKeyId = h("pre-release-signer");
  const rawKey = keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  const executor = Object.freeze({
    executorKind: "revm", engineBuildFingerprint: h("engine"), executableFingerprint: h("executable"),
    closureFingerprint: h("closure"), protocolFingerprint: h("protocol"), schemaFingerprint: h("schema"),
    releaseRoleManifestRoot: h("release-role-manifest"), candidateCommit: "2".repeat(40),
  });
  const capabilities = sealReleaseQualifiedCapabilitySetV1([]);
  const nominations = sealRuntimeReleaseNominationQualificationSetV1([{
    proposalLeafDigest: h("proposal"), criticalMutationCorpusRoot: h("mutation"),
    independentOracleCaseRoot: h("oracle"), qualificationSpecDigest: h("qualification-spec"),
    verifierQualificationCertificateRoot: h("qualification-certificate"),
  }]);
  const bindingPayload: RuntimeReleaseBindingPayloadV1 = {
    schemaVersion: 1, kind: "aloha.runtime-release-binding",
    releaseAuthorityApprovalId: h("release-approval"), releaseAuthorityApprovalPayloadHash: h("release-approval-payload"),
    releaseAcceptanceRequirementSetRoot: h("acceptance-requirements"), externalTrustAnchorRoot: h("trust-anchor"),
    externalIssuerKeySetRoot: h("issuer-keys"), qualificationRegistryApprovalId: h("registry-approval"),
    qualificationRegistryRoot: h("registry"), qualificationEpoch: "1", qualificationAudienceHash: h("audience"),
    predicateCompositionRootDigest: h("predicate-composition"), gateCoreRuntimeClosureDigest: h("gate-runtime"),
    gateCoreImplementationClosureDigest: h("gate-implementation"),
    searcherRuntime: {
      runtimeArtifactRoot: h("runtime-artifact"), implementationClosureDigest: h("runtime-implementation"),
      nodeExecutableSha256: h("node"), entrypointSha256: h("entrypoint"),
      bundleModulePath: "/etc/aloha/deployment-bundle.mjs", bundleModuleSha256: h("bundle"),
    },
    discoverySourceQualification: createRuntimeReleaseDiscoverySourceQualificationV1({
      providerIdentity: "reth-mainnet", backendEpoch: "reth-1", profile: "reth-json-rpc-v1", chainId: "1",
      endpointLocatorHash: hashRuntimeReleaseDiscoveryEndpointLocatorV1("http://127.0.0.1:8545"),
      qualificationRoot: h("source-qualification"),
    }),
    qualifiedExecutorRegistry: [executor],
    qualifiedExecutorRegistryRoot: hashQualifiedExecutorRegistryRoot([executor]),
    valuationOwnerRegistryRoot: valuationQualification.registry.valuationOwnerRegistryRoot,
    valuationOwnerQualificationCertificates: valuationQualification.certificates,
    qualifiedValuationOwnerSetRoot: valuationQualification.root,
    actionOwnerRegistryRoot: actionOwnerQualification.registry.actionOwnerRegistryRoot,
    actionOwnerQualificationCertificates: actionOwnerQualification.certificates,
    qualifiedActionOwnerSetRoot: actionOwnerQualification.root,
    safetyProfile: actionOwnerQualification.profile,
    safetyProfileRoot: actionOwnerQualification.profileRoot,
    qualifiedCapabilityRefsRoot: capabilities.root,
    nominationProgramSetRoot: nominations.programSetRoot, nominationQualificationSet: nominations,
    nominationQualificationSetRoot: nominations.root, selectedExecutorLeafHash: hashQualifiedExecutorRegistryEntry(executor),
    selectedExecutor: executor, releaseRoleManifestRoot: executor.releaseRoleManifestRoot,
    candidateReleaseCommit: executor.candidateCommit, workerEpoch: "worker-1", executorSessionHash: h("session"),
    frameworkAuthorityRoot: h("framework"), executorAuthorityRoot: h("executor-authority"),
    releaseAuthorityRoot: h("release-authority"), attestationProofIssuerKeyId: h("attestation-proof"),
    candidatePartitionProofIssuerKeyId: h("partition-proof"),
  };
  const bindingSignature = `0x${sign(
    null,
    Buffer.from(runtimeReleaseBindingSigningBytes(bindingPayload, signerKeyId)),
    keys.privateKey,
  ).toString("hex")}` as `0x${string}`;
  const binding = createRuntimeReleaseBindingV1(bindingPayload, signerKeyId, bindingSignature);
  const factPayload: NominationQualificationDeploymentFactPayloadV1 = {
    schemaVersion: 1, kind: "aloha.nomination-qualification-deployment-fact",
    runtimeBindingId: binding.bindingId, runtimeBindingPayloadHash: binding.payloadHash,
    candidateReleaseCommit: binding.candidateReleaseCommit, catalogImpactSnapshotRoot: h("impact"),
    catalogFamilyProposalOwnershipRoot: h("proposal-ownership"), catalogSemanticLedgerHash: h("semantic-ledger"),
    catalogSemanticOutputRoot: h("semantic-output"), catalogBoundaryVerificationReceiptRoot: h("boundary-receipt"),
    catalogProposedCapabilitySetRoot: binding.qualifiedCapabilityRefsRoot,
    nominationProgramSetRoot: binding.nominationProgramSetRoot,
    nominationQualificationSetRoot: binding.nominationQualificationSetRoot,
  };
  const factSignature = `0x${sign(
    null,
    Buffer.from(nominationQualificationDeploymentFactSigningBytes(factPayload, signerKeyId)),
    keys.privateKey,
  ).toString("hex")}` as `0x${string}`;
  const bytes: Record<string, Uint8Array> = Object.fromEntries(
    Object.keys(preReleaseArtifactPaths).map(name => [name, encodeCanonicalBytes({})]),
  );
  bytes["runtime-release-binding.json"] = encodeCanonicalBytes(binding);
  bytes["runtime-release-signer-pin.json"] = encodeCanonicalBytes({ signerKeyId, publicKeyHex: `0x${rawKey}` });
  bytes["nomination-qualification-deployment-fact.json"] = encodeCanonicalBytes(
    createNominationQualificationDeploymentFactV1(factPayload, signerKeyId, factSignature),
  );
  bytes["deployment-source.json"] = encodeCanonicalBytes({
    schemaVersion: 1, kind: "aloha.deployment-source-config-v1", profile: "reth-json-rpc-v1",
    endpoint: "http://127.0.0.1:8545/", chainId: "1", providerIdentity: "reth-mainnet", backendEpoch: "reth-1",
    timeoutMs: 1000, headPollIntervalMs: 100, canonicalJournalPath: "/tmp/canonical.sqlite",
    checkpointDatabasePath: "/tmp/checkpoint.sqlite", productionEvidenceDatabasePath: "/tmp/evidence.sqlite",
    observerContentDirectory: "/tmp/observer-content", terminalLocatorDirectory: "/tmp/terminal-locators",
  });
  const provenance = runtimeReleaseBindingProvenanceHash(binding);
  const profitAsset = erc20AssetReferenceV1("1", `0x${"55".repeat(20)}`);
  bytes["runtime-policy.json"] = encodeCanonicalBytes({
    schemaVersion: 1, kind: "aloha.deployment-runtime-policy-v1", bindingId: binding.bindingId,
    releaseProvenanceHash: provenance, frameworkAuthorityRoot: binding.frameworkAuthorityRoot,
    candidateReleaseCommit: binding.candidateReleaseCommit, pending: "disabled",
    objective: { numeraireAssetRef: profitAsset.assetRef, minNetGain: "1", maxGas: "1", maxValueAtRisk: "1" },
    economicSafety: {
      profitAsset, profitAccount: `0x${"22".repeat(20)}`, priorityFeePerGas: "0", bidCostNative: "0",
      valuationOwnerRef: h("native-numeraire-valuation-owner"),
    },
    callerId: `0x${"33".repeat(20)}`, deadlineMs: 1000, admission: { topK: 1, boundedUnrankedBudget: 0 },
    amountSeed: { amountIn: "1", recipient: `0x${"11".repeat(20)}` },
  });
  bytes["executor-state.json"] = encodeCanonicalBytes({
    schemaVersion: 1, kind: "aloha.deployment-executor-state-v1", bindingId: binding.bindingId,
    releaseProvenanceHash: provenance, executorAuthorityRoot: binding.executorAuthorityRoot,
    selectedExecutorLeafHash: binding.selectedExecutorLeafHash, executorAddress: `0x${"22".repeat(20)}`,
    callerAddress: `0x${"33".repeat(20)}`, qualifiedExecutorCodeHash: h("executor-code"),
    executorConfig: { chainId: "1", mode: "dry-run" }, accounts: [],
  });
  bytes["staging-manifest.json"] = encodeCanonicalBytes({
    kind: "aloha.pre-release-staging-manifest", phase: "pre-release", dryRun: true,
    candidateReleaseCommit: binding.candidateReleaseCommit, runtimeBindingId: binding.bindingId,
    releaseProvenanceHash: provenance,
    bundlePath: preReleaseArtifactPaths["deployment-bundle.mjs"], deploymentBundleSha256: sha256Hex(bytes["deployment-bundle.mjs"]!),
    deploymentCompositionPath: preReleaseArtifactPaths["deployment-composition.mjs"], deploymentCompositionSha256: sha256Hex(bytes["deployment-composition.mjs"]!),
    deploymentSourcePath: preReleaseArtifactPaths["deployment-source.json"], deploymentSourceSha256: sha256Hex(bytes["deployment-source.json"]!),
    runtimePolicyPath: preReleaseArtifactPaths["runtime-policy.json"], runtimePolicySha256: sha256Hex(bytes["runtime-policy.json"]!),
    executorStatePath: preReleaseArtifactPaths["executor-state.json"], executorStateSha256: sha256Hex(bytes["executor-state.json"]!),
    performanceProfilePath: preReleaseArtifactPaths["performance-profile.json"], performanceProfileSha256: sha256Hex(bytes["performance-profile.json"]!),
    runtimeBindingPath: preReleaseArtifactPaths["runtime-release-binding.json"], runtimeBindingSha256: sha256Hex(bytes["runtime-release-binding.json"]!),
    nominationQualificationDeploymentFactPath: preReleaseArtifactPaths["nomination-qualification-deployment-fact.json"],
    nominationQualificationDeploymentFactSha256: sha256Hex(bytes["nomination-qualification-deployment-fact.json"]!),
    runtimeSignerPinPath: preReleaseArtifactPaths["runtime-release-signer-pin.json"],
    runtimeSignerPinSha256: sha256Hex(bytes["runtime-release-signer-pin.json"]!),
  });
  const now = BigInt(Date.now()) * 1_000_000n;
  const authorizationBytes = encodeCanonicalBytes({
    kind: "aloha.pre-release-launch-authorization", phase: "pre-release", dryRun: true,
    candidateReleaseCommit: binding.candidateReleaseCommit, runtimeBindingId: binding.bindingId,
    releaseProvenanceHash: provenance, issuedAtUnixNs: (now - 1_000_000_000n).toString(),
    expiresAtUnixNs: (now + 60_000_000_000n).toString(),
  });
  return Object.freeze({
    snapshots: Object.freeze(Object.fromEntries(Object.entries(bytes).map(([name, value]) => [name, snapshot(value)]))),
    authorizationSnapshot: snapshot(authorizationBytes),
  });
}

test("release runtime entrypoint exposes only the fixed native startup surface", () => {
  const exports = [...entrypointSource.matchAll(/export function ([A-Za-z0-9_]+)/g)]
    .map(match => match[1])
    .sort();
  assert.deepEqual(exports, [
    "issueInstalledProductionStartupCapabilityV1",
    "issuePreReleaseStartupCapabilityV1",
    "startReleaseRuntimeSessionV1",
  ]);
  assert.doesNotMatch(entrypointSource, /acceptance\/|runtime-release-packager|child_process|production-bootstrap/);
  const ownerImports = ownerSource.slice(0, ownerSource.indexOf("const BINDING_PATH"));
  const acceptanceImports = [...ownerImports.matchAll(/from ["']([^"']*acceptance\/[^"']*)["']/g)]
    .map(match => match[1])
    .sort();
  assert.deepEqual(acceptanceImports, [
    "../../../acceptance/collectors/src/internal/release-owned-observer-store.ts",
    "../../../acceptance/collectors/src/production-full-family-port.ts",
    "../../../acceptance/collectors/src/production-six-step-port.ts",
    "../../../acceptance/collectors/src/production-terminal-phase-port.ts",
    "../../../acceptance/collectors/src/terminal-phase-locator-index.ts",
  ]);
  assert.doesNotMatch(ownerImports, /acceptance\/(?:gate-core|full-family-facts|six-step-facts)|runtime-release-packager|runtime-acceptance-evidence\.ts|node:child_process/);
  assert.match(ownerSource, /from "\.\/native-runtime-lifecycle-evidence\.ts"/);
  assert.match(ownerSource, /decodeNominationQualificationDeploymentFactV1/);
  assert.match(ownerSource, /nominationQualificationDeploymentFactSigningBytes/);
  assert.match(ownerSource, /nominationQualificationDeploymentFact: NominationQualificationDeploymentFactV1/);
  assert.doesNotMatch(ownerSource, /createNominationQualificationDeploymentFactV1|generateKeyPair|privateKey/);
  assert.doesNotMatch(ownerSource, /runPreReleaseOwnerHostV1|prepareProductionReleaseAcceptanceV1|completeProductionReleasePackageV1/);
});

test("pre-release launcher imports the verified production bytes once and only starts native runtime", () => {
  const start = launcherSource.indexOf("async function main()");
  assert.ok(start >= 0);
  const main = launcherSource.slice(start);
  orderedWithin(main, [
    "const round = preverifyRound();",
    "const startupSnapshot = Object.freeze({",
    "snapshots: round.snapshots",
    "authorizationSnapshot: round.authorizationSnapshot",
    'const runtime = round.snapshots["deployment-bundle.mjs"]',
    "await import(`data:text/javascript;base64,${Buffer.from(runtime.bytes).toString(\"base64\")}#${runtime.sha256.slice(2)}`)",
    "Object.keys(module).sort()",
    "module.issuePreReleaseStartupCapabilityV1(startupSnapshot)",
    "module.startReleaseRuntimeSessionV1(capability)",
    "await session.done",
  ]);
  assert.equal((main.match(/await import\(/g) ?? []).length, 1);
  assert.doesNotMatch(main, /issueInstalledProductionStartupCapabilityV1\(|qualified|acceptance|package workflow|child_process/);
});

test("host launchers retain exact pre-release and final package boundary fields", () => {
  assert.match(launcherSource, /return Object\.freeze\(\{ snapshots: Object\.freeze\(snapshots\), authorizationSnapshot \}\)/);
  assert.doesNotMatch(launcherSource, /return Object\.freeze\(\{ snapshots: Object\.freeze\(snapshots\), authorizationSnapshot, authorization \}\)/);
  assert.equal((productionLauncherSource.match(/"controllerBoundaryEvidenceRoot"/g) ?? []).length, 2);
  assert.match(
    productionLauncherSource,
    /controllerBoundaryEvidenceRoot: manifest\.controllerBoundaryEvidenceRoot/,
  );
});

test("runtime owner decodes the formal package manifest and joins controller boundary approval", () => {
  const manifest = releasePackageFixture();
  const decoded = decodeReleasePackageManifestForRuntimeOwnerV1(encodeCanonicalBytes(manifest));
  assert.equal(decoded.controllerBoundaryEvidenceRoot, manifest.controllerBoundaryEvidenceRoot);
  const approval = {
    packageRoot: manifest.packageRoot,
    bindingId: manifest.bindingId,
    releaseProvenanceHash: manifest.releaseProvenanceHash,
    releaseAcceptanceApprovalId: manifest.releaseAcceptanceApprovalId,
    releaseAcceptanceApprovalPayloadHash: manifest.releaseAcceptanceApprovalPayloadHash,
    releaseAcceptanceRequirementSetRoot: manifest.releaseAcceptanceRequirementSetRoot,
    releaseAcceptanceSetRoot: manifest.releaseAcceptanceSetRoot,
    controllerBoundaryEvidenceRoot: manifest.controllerBoundaryEvidenceRoot,
    candidateReleaseCommit: manifest.git.commit,
    performanceBasisId: manifest.performance.basisId,
    performanceProfileHash: manifest.performance.profileHash,
    hardwareProfileRoot: manifest.performance.hardwareProfileRoot,
    providerRoot: manifest.performance.providerRoot,
  };
  assert.doesNotThrow(() => assertRuntimeReleasePackageApprovalJoinV1(decoded, approval));
  assert.throws(
    () => assertRuntimeReleasePackageApprovalJoinV1(decoded, {
      ...approval,
      controllerBoundaryEvidenceRoot: h("foreign-controller-boundary-evidence"),
    }),
    /controllerBoundaryEvidenceRoot/,
  );
  const { controllerBoundaryEvidenceRoot: _omitted, ...withoutControllerRoot } = manifest;
  assert.throws(
    () => decodeReleasePackageManifestForRuntimeOwnerV1(encodeCanonicalBytes(withoutControllerRoot)),
    /non-exact fields/,
  );
  assert.throws(
    () => decodeReleasePackageManifestForRuntimeOwnerV1(encodeCanonicalBytes({ ...manifest, extra: true })),
    /non-exact fields/,
  );
  const zeroControllerRoot = { ...manifest, controllerBoundaryEvidenceRoot: ZERO_HASH };
  assert.throws(
    () => decodeReleasePackageManifestForRuntimeOwnerV1(encodeCanonicalBytes(zeroControllerRoot)),
    /controllerBoundaryEvidenceRoot must be non-zero/,
  );
  assert.throws(
    () => decodeReleasePackageManifestV1(zeroControllerRoot),
    /controller boundary evidence root must be non-zero/,
  );
});

test("standalone production launcher rejects a zero controller boundary approval root", async () => {
  const source = productionLauncherSource.replace(
    /main\(\)\.catch\([\s\S]+$/,
    "export { verifyPackageApproval };\n",
  );
  const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}#zero-controller-root`);
  const manifest = releasePackageFixture();
  const signerKeyId = h("launcher-signer");
  assert.throws(
    () => module.verifyPackageApproval(
      manifest,
      { signerKeyId, publicKeyHex: `0x${"11".repeat(32)}` },
      {
        schemaVersion: 1,
        kind: "aloha.runtime-release-package-approval",
        packageRoot: manifest.packageRoot,
        bindingId: manifest.bindingId,
        releaseProvenanceHash: manifest.releaseProvenanceHash,
        releaseAcceptanceApprovalId: manifest.releaseAcceptanceApprovalId,
        releaseAcceptanceApprovalPayloadHash: manifest.releaseAcceptanceApprovalPayloadHash,
        releaseAcceptanceRequirementSetRoot: manifest.releaseAcceptanceRequirementSetRoot,
        releaseAcceptanceSetRoot: manifest.releaseAcceptanceSetRoot,
        controllerBoundaryEvidenceRoot: ZERO_HASH,
        candidateReleaseCommit: manifest.git.commit,
        performanceBasisId: manifest.performance.basisId,
        performanceProfileHash: manifest.performance.profileHash,
        hardwareProfileRoot: manifest.performance.hardwareProfileRoot,
        providerRoot: manifest.performance.providerRoot,
        payloadHash: h("launcher-payload"),
        approvalId: h("launcher-approval"),
        signatureAlgorithm: "ed25519",
        signerKeyId,
        signatureHex: `0x${"22".repeat(64)}`,
      },
    ),
    /controller boundary evidence root must be non-zero/,
  );
});

test("pre-release startup capability accepts only the launcher's exact two-field snapshot", () => {
  const fixture = preReleaseStartupFixture();
  const priorDryRun = process.env.SEARCHER_DRY_RUN;
  const priorEntrypoint = process.argv[1];
  try {
    process.env.SEARCHER_DRY_RUN = "1";
    process.argv[1] = "/var/lib/aloha/pre-release/artifacts/pre-release-owner.mjs";
    const capability = issuePreReleaseRuntimeStartupCapabilityV1(fixture);
    assert.equal(Object.isFrozen(capability), true);
    assert.deepEqual(Reflect.ownKeys(capability), []);
    assert.throws(
      () => issuePreReleaseRuntimeStartupCapabilityV1({ ...fixture, authorization: { kind: "forged" } }),
      /pre-release runtime snapshot has non-exact fields/,
    );
  } finally {
    if (priorDryRun === undefined) delete process.env.SEARCHER_DRY_RUN;
    else process.env.SEARCHER_DRY_RUN = priorDryRun;
    process.argv[1] = priorEntrypoint;
  }
});

test("pre-release runtime records native ready and drain evidence without owning A-to-B orchestration", () => {
  const attachStart = ownerSource.indexOf("async function attachNativeRuntimeLifecycleEvidenceV1(");
  const installedStart = ownerSource.indexOf("export async function startInstalledProductionServiceV1(", attachStart);
  assert.ok(attachStart >= 0 && installedStart > attachStart);
  const attach = ownerSource.slice(attachStart, installedStart);
  orderedWithin(attach, [
    "await recordProductionRuntimeProcessReadyV1(owner, service.startup)",
    "installProductionRuntimeSigtermEvidenceV1({ owner, stop: () => service.stop() })",
    "closeProductionRuntimeAcceptanceEvidenceV1(owner)",
    "await joinSignal()",
  ]);

  const preReleaseStart = ownerSource.indexOf("async function startPreReleaseRuntimeServiceV1(");
  const commonStart = ownerSource.indexOf("export function startReleaseRuntimeSessionOwnerV1(", preReleaseStart);
  assert.ok(preReleaseStart >= 0 && commonStart > preReleaseStart);
  const preRelease = ownerSource.slice(preReleaseStart, commonStart);
  orderedWithin(preRelease, [
    'if (state.phase !== "pre-release")',
    "issueProductionRuntimeAcceptanceEvidenceOwnerV1({",
    "startReleaseSearcherStartup(core.services.startup, controller.signal)",
    "applicationOwner.open(startup)",
    "application.run(controller.signal)",
    "attachNativeRuntimeLifecycleEvidenceV1(service, runtimeAcceptance)",
  ]);
  assert.doesNotMatch(preRelease, /restart-controller|resolvePreReleaseRestartPredecessor|qualified-release|prepareProductionReleaseAcceptance|completeProductionReleasePackage/);
});
