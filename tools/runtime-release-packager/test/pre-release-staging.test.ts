import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  encodeCanonicalBytes,
  hashDomain,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  PRE_RELEASE_RUNTIME_EXPORT_SURFACE_ROOT_V1,
  PRE_RELEASE_STAGING_ARTIFACT_NAMES_V1,
  PRE_RELEASE_STAGING_LAYOUT_V1,
  PRE_RELEASE_SYSTEMD_UNIT_V1,
  assertCanonicalPreReleaseSystemdUnitV1,
  createPreReleaseLaunchAuthorizationV1,
  decodePreReleaseLaunchAuthorizationV1,
  decodePreReleaseStagingManifestV1,
  hashPreReleaseStagingArtifactSetV1,
  preReleaseStagingArtifactPathV1,
  preReleaseLaunchAuthorizationSigningBytesV1,
  verifyPreReleaseLaunchAuthorizationSignatureV1,
  type PreReleaseLaunchAuthorizationPayloadV1,
  type PreReleaseStagingManifestV1,
} from "../src/internal/pre-release-staging-schema.ts";
import type { PreReleaseStagingArtifactIdentityV1 } from "../src/pre-release-staging-contract.ts";
import {
  claimPreReleaseAuthorizationInDatabaseV1,
  readFixedPreReleaseAuthorizationClaimV1,
} from "../src/internal/pre-release-authorization-ledger.ts";
import {
  readPreReleaseAdvisoryMaterialCapabilityV1,
} from "../src/pre-release-staging.ts";

const h = (value: string): Hash => hashDomain("test/pre-release-staging", value);
const commit = "7".repeat(40);

function predecessorFacts(authorizationId: Hash, authorizationClaimId: Hash, prefix: string) {
  return Object.freeze({
    authorizationId,
    authorizationClaimId,
    controllerReceiptId: h(`${prefix}-controller-receipt`),
    controllerImplementationIdentityHash: h(`${prefix}-controller-implementation`),
    targetProcessAnchorHash: h(`${prefix}-process-anchor`),
    processReadyEventId: h(`${prefix}-ready`),
    sigtermDrainedEventId: h(`${prefix}-drained`),
    restartTerminalId: h(`${prefix}-terminal`),
  });
}

const canonicalSystemdUnitBytes = () => new TextEncoder().encode(PRE_RELEASE_SYSTEMD_UNIT_V1);

function payload(patch: Partial<PreReleaseLaunchAuthorizationPayloadV1> = {}): PreReleaseLaunchAuthorizationPayloadV1 {
  return Object.freeze({
    schemaVersion: 1,
    kind: "aloha.pre-release-launch-authorization",
    phase: "pre-release",
    roundRole: "restart-probe",
    predecessor: null,
    candidateReleaseCommit: commit,
    runtimeBindingId: h("binding"),
    releaseProvenanceHash: h("provenance"),
    releaseAuthorityApprovalId: h("approval"),
    releaseRoleManifestRoot: h("role-root"),
    boundaryRunnerEntrypointId: "acceptance/gate-core/src/generated/release-runtime.ts#evaluateGateCore",
    boundaryRunnerClosureDigest: h("runner-closure"),
    boundaryRunnerImplementationExportDigest: h("runner-export"),
    controllerBoundaryEvidenceRoot: h("controller-boundary-evidence"),
    stagingArtifactSetRoot: h("staging-artifacts"),
    stagingManifestRoot: h("staging-manifest"),
    runtimeExportSurfaceRoot: PRE_RELEASE_RUNTIME_EXPORT_SURFACE_ROOT_V1,
    repositoryRoot: PRE_RELEASE_STAGING_LAYOUT_V1.repositoryRoot,
    artifactRoot: PRE_RELEASE_STAGING_LAYOUT_V1.artifactRoot,
    manifestPath: PRE_RELEASE_STAGING_LAYOUT_V1.manifestPath,
    canonicalJournalPath: PRE_RELEASE_STAGING_LAYOUT_V1.canonicalJournalPath,
    checkpointDatabasePath: PRE_RELEASE_STAGING_LAYOUT_V1.checkpointDatabasePath,
    processEvidenceDatabasePath: PRE_RELEASE_STAGING_LAYOUT_V1.processEvidenceDatabasePath,
    observerContentDirectory: PRE_RELEASE_STAGING_LAYOUT_V1.observerContentDirectory,
    terminalLocatorDirectory: PRE_RELEASE_STAGING_LAYOUT_V1.terminalLocatorDirectory,
    observerStoreDirectory: PRE_RELEASE_STAGING_LAYOUT_V1.observerStoreDirectory,
    logPath: PRE_RELEASE_STAGING_LAYOUT_V1.logPath,
    serviceName: PRE_RELEASE_STAGING_LAYOUT_V1.serviceName,
    systemdUnit: PRE_RELEASE_STAGING_LAYOUT_V1.systemdUnit,
    dryRun: true,
    allowedTerminal: "restart-probe-drained",
    permissions: Object.freeze({
      runRuntime: true,
      emitRestartMarker: true,
      sign: false,
      broadcast: false,
      promote: false,
    }),
    issuedAtUnixNs: "1",
    expiresAtUnixNs: "9999999999999999999",
    nonce: h("nonce"),
    ...patch,
  });
}

function rawPublicKeyHex(publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"]): `0x${string}` {
  const der = publicKey.export({ format: "der", type: "spki" });
  return `0x${der.subarray(der.length - 32).toString("hex")}`;
}

function unsignedTestAuthorization(
  patch: Partial<PreReleaseLaunchAuthorizationPayloadV1> = {},
): ReturnType<typeof createPreReleaseLaunchAuthorizationV1> {
  return createPreReleaseLaunchAuthorizationV1(
    payload(patch),
    h("durable-signer"),
    `0x${"22".repeat(64)}` as `0x${string}`,
  );
}

function claimExpectation(authorization: ReturnType<typeof unsignedTestAuthorization>, patch: Record<string, unknown> = {}) {
  return Object.freeze({
    authorization,
    runtimeBindingId: authorization.runtimeBindingId,
    releaseProvenanceHash: authorization.releaseProvenanceHash,
    stagingArtifactSetRoot: authorization.stagingArtifactSetRoot,
    stagingManifestRoot: authorization.stagingManifestRoot,
    observerStoreDirectory: PRE_RELEASE_STAGING_LAYOUT_V1.observerStoreDirectory,
    nowUnixNs: "2",
    ...patch,
  });
}

test("external Ed25519 pre-release authorization is exact and production authority is absent", () => {
  const keys = generateKeyPairSync("ed25519");
  const signerKeyId = h("signer");
  const signingBytes = preReleaseLaunchAuthorizationSigningBytesV1(payload(), signerKeyId);
  const signature = `0x${sign(null, Buffer.from(signingBytes), keys.privateKey).toString("hex")}` as `0x${string}`;
  const authorization = createPreReleaseLaunchAuthorizationV1(payload(), signerKeyId, signature);
  assert.deepEqual(decodePreReleaseLaunchAuthorizationV1(authorization), authorization);
  verifyPreReleaseLaunchAuthorizationSignatureV1(authorization, {
    signerKeyId,
    publicKeyHex: rawPublicKeyHex(keys.publicKey),
  });
  assert.equal(rawPublicKeyHex(keys.publicKey).length, 66);
  assert.equal(authorization.phase, "pre-release");
  assert.equal(authorization.dryRun, true);
  assert.equal(authorization.permissions.sign, false);
  assert.equal(authorization.permissions.broadcast, false);
  assert.equal(authorization.permissions.promote, false);
  assert.equal(authorization.allowedTerminal, "restart-probe-drained");
  assert.equal("packageRoot" in authorization, false);
  assert.equal("releaseAcceptanceApprovalId" in authorization, false);
});

test("authorization signature mutations and signer substitution fail before launch authority", () => {
  const first = generateKeyPairSync("ed25519");
  const second = generateKeyPairSync("ed25519");
  const signerKeyId = h("signature-signer");
  const source = payload({ nonce: h("signature-nonce") });
  const signature = `0x${sign(
    null,
    Buffer.from(preReleaseLaunchAuthorizationSigningBytesV1(source, signerKeyId)),
    first.privateKey,
  ).toString("hex")}` as `0x${string}`;
  const authorization = createPreReleaseLaunchAuthorizationV1(source, signerKeyId, signature);
  const firstPin = { signerKeyId, publicKeyHex: rawPublicKeyHex(first.publicKey) };
  const secondPin = { signerKeyId, publicKeyHex: rawPublicKeyHex(second.publicKey) };
  verifyPreReleaseLaunchAuthorizationSignatureV1(authorization, firstPin);
  assert.throws(
    () => verifyPreReleaseLaunchAuthorizationSignatureV1(authorization, secondPin),
    /signature invalid/,
  );
  const flipped = `${signature.slice(0, -2)}${signature.endsWith("00") ? "01" : "00"}` as `0x${string}`;
  assert.throws(
    () => verifyPreReleaseLaunchAuthorizationSignatureV1(
      createPreReleaseLaunchAuthorizationV1(source, signerKeyId, flipped),
      firstPin,
    ),
    /signature invalid/,
  );
  assert.throws(
    () => verifyPreReleaseLaunchAuthorizationSignatureV1(authorization, { ...firstPin, signerKeyId: h("other") }),
    /signer pin mismatch/,
  );
});

test("phase, authority bits, fixed namespace, expiry, nonce, and signature identity mutations fail closed", () => {
  const signerKeyId = h("signer");
  const signature = `0x${"11".repeat(64)}` as `0x${string}`;
  const authorization = createPreReleaseLaunchAuthorizationV1(payload(), signerKeyId, signature);
  assert.throws(() => decodePreReleaseLaunchAuthorizationV1({ ...authorization, phase: "production" } as never), /expected "pre-release"/);
  assert.throws(() => decodePreReleaseLaunchAuthorizationV1({ ...authorization, permissions: { ...authorization.permissions, sign: true } } as never), /expected false/);
  assert.throws(() => decodePreReleaseLaunchAuthorizationV1({ ...authorization, permissions: { ...authorization.permissions, unexpectedAuthority: true } } as never), /unknown field/);
  assert.throws(() => decodePreReleaseLaunchAuthorizationV1({ ...authorization, allowedTerminal: "production" } as never), /invalid pre-release allowed terminal/);
  assert.throws(() => decodePreReleaseLaunchAuthorizationV1({ ...authorization, processEvidenceDatabasePath: "/tmp/forged.sqlite" } as never), /fixed pre-release value mismatch/);
  assert.throws(() => decodePreReleaseLaunchAuthorizationV1({ ...authorization, observerStoreDirectory: "/var/lib/aloha/pre-release/observer-store" } as never), /fixed pre-release value mismatch/);
  assert.throws(() => createPreReleaseLaunchAuthorizationV1(payload({ issuedAtUnixNs: "4", expiresAtUnixNs: "4" }), signerKeyId, signature), /validity interval/);
  assert.throws(() => createPreReleaseLaunchAuthorizationV1(payload({ nonce: `0x${"0".repeat(64)}` as Hash }), signerKeyId, signature), /nonce must be non-zero/);
  assert.throws(() => decodePreReleaseLaunchAuthorizationV1({ ...authorization, payloadHash: h("forged") }), /identity mismatch/);
  assert.throws(() => decodePreReleaseLaunchAuthorizationV1({ ...authorization, extra: true } as never), /unknown field/);
});

test("restart-probe and qualification-final authorizations have exact fact-only terminals", () => {
  const predecessor = predecessorFacts(h("probe-authorization"), h("probe-claim"), "probe");
  const finalPayload = payload({
    roundRole: "qualification-final",
    predecessor,
    allowedTerminal: "qualification-facts-observed",
    permissions: Object.freeze({
      runRuntime: true,
      emitRestartMarker: false,
      sign: false,
      broadcast: false,
      promote: false,
    }),
  });
  const finalAuthorization = createPreReleaseLaunchAuthorizationV1(
    finalPayload,
    h("final-signer"),
    `0x${"33".repeat(64)}` as `0x${string}`,
  );
  assert.equal(finalAuthorization.predecessor?.sigtermDrainedEventId, predecessor.sigtermDrainedEventId);
  for (const field of [
    "controllerReceiptId",
    "controllerImplementationIdentityHash",
    "targetProcessAnchorHash",
    "processReadyEventId",
    "sigtermDrainedEventId",
    "restartTerminalId",
  ] as const) {
    assert.throws(() => decodePreReleaseLaunchAuthorizationV1({
      ...finalAuthorization,
      predecessor: { ...predecessor, [field]: h(`spliced-${field}`) },
    }), /identity mismatch/);
  }
  assert.throws(() => createPreReleaseLaunchAuthorizationV1({
    ...finalPayload,
    predecessor: null,
  }, h("final-signer"), `0x${"33".repeat(64)}` as `0x${string}`), /predecessor does not match/);
  assert.throws(() => createPreReleaseLaunchAuthorizationV1({
    ...payload(),
    predecessor,
  }, h("probe-signer"), `0x${"44".repeat(64)}` as `0x${string}`), /predecessor does not match/);
});

test("staging manifest is a disjoint exact dry-run schema with fixed locators", () => {
  const manifest: PreReleaseStagingManifestV1 = Object.freeze({
    schemaVersion: 1,
    kind: "aloha.pre-release-staging-manifest",
    phase: "pre-release",
    candidateReleaseCommit: commit,
    runtimeBindingId: h("binding"),
    releaseProvenanceHash: h("provenance"),
    searcherRuntimeArtifactRoot: h("runtime-artifact-root"),
    searcherRuntimeImplementationClosureDigest: h("runtime-implementation-closure"),
    searcherRuntimeNodeExecutableSha256: h("node-executable"),
    releaseAuthorityApprovalId: h("approval"),
    releaseRoleManifestRoot: h("role-root"),
    boundaryRunnerEntrypointId: "runner#entry",
    boundaryRunnerClosureDigest: h("runner-closure"),
    boundaryRunnerImplementationExportDigest: h("runner-export"),
    controllerBoundaryEvidenceRoot: h("controller-boundary-evidence"),
    repositoryRoot: PRE_RELEASE_STAGING_LAYOUT_V1.repositoryRoot,
    artifactRoot: PRE_RELEASE_STAGING_LAYOUT_V1.artifactRoot,
    launcherPath: PRE_RELEASE_STAGING_LAYOUT_V1.launcherPath,
    productionLauncherPath: PRE_RELEASE_STAGING_LAYOUT_V1.productionLauncherPath,
    bundlePath: PRE_RELEASE_STAGING_LAYOUT_V1.bundlePath,
    catalogGenerationInputPath: PRE_RELEASE_STAGING_LAYOUT_V1.catalogGenerationInputPath,
    familyCatalogSourcePath: PRE_RELEASE_STAGING_LAYOUT_V1.familyCatalogSourcePath,
    runtimeCompositionSourcePath: PRE_RELEASE_STAGING_LAYOUT_V1.runtimeCompositionSourcePath,
    strategyCatalogSourcePath: PRE_RELEASE_STAGING_LAYOUT_V1.strategyCatalogSourcePath,
    manifestPath: PRE_RELEASE_STAGING_LAYOUT_V1.manifestPath,
    deploymentCompositionPath: PRE_RELEASE_STAGING_LAYOUT_V1.deploymentCompositionPath,
    deploymentSourcePath: PRE_RELEASE_STAGING_LAYOUT_V1.deploymentSourcePath,
    runtimePolicyPath: PRE_RELEASE_STAGING_LAYOUT_V1.runtimePolicyPath,
    runtimeBoundaryProjectionPath: PRE_RELEASE_STAGING_LAYOUT_V1.runtimeBoundaryProjectionPath,
    executorStatePath: PRE_RELEASE_STAGING_LAYOUT_V1.executorStatePath,
    performanceProfilePath: PRE_RELEASE_STAGING_LAYOUT_V1.performanceProfilePath,
    qualifiedReleaseRunnerInputPath: PRE_RELEASE_STAGING_LAYOUT_V1.qualifiedReleaseRunnerInputPath,
    releaseIntentPath: PRE_RELEASE_STAGING_LAYOUT_V1.releaseIntentPath,
    candidateProofVerifierBindingPath: PRE_RELEASE_STAGING_LAYOUT_V1.candidateProofVerifierBindingPath,
    runtimeBindingPath: PRE_RELEASE_STAGING_LAYOUT_V1.runtimeBindingPath,
    nominationQualificationDeploymentFactPath: PRE_RELEASE_STAGING_LAYOUT_V1.nominationQualificationDeploymentFactPath,
    releaseAuthorityApprovalPath: PRE_RELEASE_STAGING_LAYOUT_V1.releaseAuthorityApprovalPath,
    runtimeSignerPinPath: PRE_RELEASE_STAGING_LAYOUT_V1.runtimeSignerPinPath,
    canonicalJournalPath: PRE_RELEASE_STAGING_LAYOUT_V1.canonicalJournalPath,
    checkpointDatabasePath: PRE_RELEASE_STAGING_LAYOUT_V1.checkpointDatabasePath,
    processEvidenceDatabasePath: PRE_RELEASE_STAGING_LAYOUT_V1.processEvidenceDatabasePath,
    observerContentDirectory: PRE_RELEASE_STAGING_LAYOUT_V1.observerContentDirectory,
    terminalLocatorDirectory: PRE_RELEASE_STAGING_LAYOUT_V1.terminalLocatorDirectory,
    observerStoreDirectory: PRE_RELEASE_STAGING_LAYOUT_V1.observerStoreDirectory,
    logPath: PRE_RELEASE_STAGING_LAYOUT_V1.logPath,
    serviceName: PRE_RELEASE_STAGING_LAYOUT_V1.serviceName,
    systemdUnit: PRE_RELEASE_STAGING_LAYOUT_V1.systemdUnit,
    systemdUnitPath: PRE_RELEASE_STAGING_LAYOUT_V1.systemdUnitPath,
    releaseEnvironmentPath: PRE_RELEASE_STAGING_LAYOUT_V1.releaseEnvironmentPath,
    launcherSha256: h("launcher"),
    productionLauncherSha256: h("production-launcher"),
    deploymentBundleSha256: h("bundle"),
    catalogGenerationInputSha256: h("catalog-generation-input"),
    familyCatalogSourceSha256: h("family-catalog-source"),
    runtimeCompositionSourceSha256: h("runtime-composition-source"),
    strategyCatalogSourceSha256: h("strategy-catalog-source"),
    deploymentCompositionSha256: h("composition"),
    deploymentSourceSha256: h("deployment-source"),
    runtimePolicySha256: h("runtime-policy"),
    runtimeBoundaryProjectionSha256: h("runtime-boundary-projection"),
    executorStateSha256: h("executor-state"),
    performanceProfileSha256: h("performance-profile-bytes"),
    performanceProfileHash: h("performance-profile"),
    qualifiedReleaseRunnerInputSha256: h("qualified-runner-input"),
    releaseIntentSha256: h("release-intent"),
    candidateProofVerifierBindingSha256: h("candidate-proof-verifier-binding"),
    systemdUnitSha256: h("systemd-unit"),
    releaseEnvironmentSha256: h("release-environment"),
    runtimeBindingSha256: h("binding-bytes"),
    nominationQualificationDeploymentFactSha256: h("nomination-qualification-deployment-fact-bytes"),
    releaseAuthorityApprovalSha256: h("approval-bytes"),
    runtimeSignerPinSha256: h("pin-bytes"),
    runtimeExportSurfaceRoot: PRE_RELEASE_RUNTIME_EXPORT_SURFACE_ROOT_V1,
    dryRun: true,
  });
  assert.deepEqual(decodePreReleaseStagingManifestV1(manifest), manifest);
  assert.throws(() => decodePreReleaseStagingManifestV1({ ...manifest, kind: "aloha.runtime-release-package" } as never), /pre-release-staging-manifest/);
  assert.throws(() => decodePreReleaseStagingManifestV1({ ...manifest, dryRun: false } as never), /expected true/);
  assert.throws(() => decodePreReleaseStagingManifestV1({ ...manifest, manifestPath: "/etc/aloha/searcher-deployment.json" } as never), /fixed pre-release value mismatch/);
  assert.throws(() => decodePreReleaseStagingManifestV1({ ...manifest, candidateProofVerifierBindingPath: "/tmp/forged.json" } as never), /fixed pre-release value mismatch/);
  assert.throws(() => decodePreReleaseStagingManifestV1({ ...manifest, packageRoot: h("forbidden") } as never), /unknown field/);
  assert.throws(() => decodePreReleaseStagingManifestV1({
    ...manifest,
    runtimeReleasePackageApprovalSha256: h("forbidden-package-approval"),
  } as never), /unknown field/);
  assert.equal(Buffer.from(encodeCanonicalBytes(manifest)).includes(Buffer.from("mayPromote")), false);
});

test("pre-release staging accepts only the exact canonical hardened systemd unit", () => {
  const canonical = canonicalSystemdUnitBytes();
  assert.deepEqual(assertCanonicalPreReleaseSystemdUnitV1(canonical, "unit"), canonical);
  assert.equal(PRE_RELEASE_STAGING_LAYOUT_V1.runtimeOutputDirectory, "/var/lib/aloha/pre-release/runtime");
  assert.equal(PRE_RELEASE_STAGING_LAYOUT_V1.canonicalJournalPath, "/var/lib/aloha/pre-release/runtime/canonical-journal.sqlite");
  assert.equal(PRE_RELEASE_STAGING_LAYOUT_V1.checkpointDatabasePath, "/var/lib/aloha/pre-release/runtime/checkpoint.sqlite");
  assert.equal(PRE_RELEASE_STAGING_LAYOUT_V1.processEvidenceDatabasePath, "/var/lib/aloha/pre-release/runtime/process-evidence.sqlite");
  assert.equal(PRE_RELEASE_STAGING_LAYOUT_V1.observerContentDirectory, "/var/lib/aloha-acceptance/pre-release/observer-store/content");
  assert.equal(PRE_RELEASE_STAGING_LAYOUT_V1.terminalLocatorDirectory, "/var/lib/aloha-acceptance/pre-release/observer-store/terminal-locators");
  assert.equal(PRE_RELEASE_STAGING_LAYOUT_V1.authorizationLedgerPath, "/var/lib/aloha/pre-release/authorization-ledger/authorization-claims.sqlite");
  assert.equal(PRE_RELEASE_STAGING_LAYOUT_V1.advisoryJudgmentPath, "/var/lib/aloha/pre-release/runtime/advisory-judgment.json");
  assert.equal(PRE_RELEASE_STAGING_LAYOUT_V1.factLogPath, "/var/lib/aloha/pre-release/runtime/pre-release-fact-log.jsonl");
  assert.equal(PRE_RELEASE_STAGING_LAYOUT_V1.releaseAcceptanceSigningRequestPath, "/var/lib/aloha/pre-release/runtime/release-acceptance-signing-request.json");
  assert.equal(PRE_RELEASE_STAGING_LAYOUT_V1.productionArtifactBaseRepositoryPath, "/var/lib/aloha/pre-release/runtime/production-artifact-bases");
  assert.equal(PRE_RELEASE_STAGING_LAYOUT_V1.productionPackagingInputDirectory, "/var/lib/aloha/pre-release/package-inputs");
  assert.equal(PRE_RELEASE_STAGING_LAYOUT_V1.productionDeploymentInfrastructureInputPath, "/var/lib/aloha/pre-release/package-inputs/deployment-runtime-infrastructure.json");
  assert.equal(PRE_RELEASE_STAGING_LAYOUT_V1.productionRevmWorkerInputPath, "/var/lib/aloha/pre-release/package-inputs/aloha-revm-worker");
  assert.equal(PRE_RELEASE_STAGING_LAYOUT_V1.productionProofSignerInputPath, "/var/lib/aloha/pre-release/package-inputs/aloha-proof-signer");
  assert.equal(dirname(PRE_RELEASE_STAGING_LAYOUT_V1.authorizationLedgerPath), "/var/lib/aloha/pre-release/authorization-ledger");
  assert.ok(PRE_RELEASE_STAGING_LAYOUT_V1.advisoryJudgmentPath.startsWith(`${PRE_RELEASE_STAGING_LAYOUT_V1.runtimeOutputDirectory}/`));
  assert.match(PRE_RELEASE_SYSTEMD_UNIT_V1, /^User=aloha$/m);
  assert.match(PRE_RELEASE_SYSTEMD_UNIT_V1, /^WorkingDirectory=\/$/m);
  assert.match(PRE_RELEASE_SYSTEMD_UNIT_V1, /^Environment=SEARCHER_DRY_RUN=1$/m);
  assert.match(PRE_RELEASE_SYSTEMD_UNIT_V1, /^EnvironmentFile=\/var\/lib\/aloha\/pre-release\/artifacts\/searcher-pre-release\.env$/m);
  assert.match(PRE_RELEASE_SYSTEMD_UNIT_V1, /^UnsetEnvironment=.* NODE_OPTIONS .* OWNER_PRIVATE_KEY PRIVATE_KEY /m);
  assert.match(PRE_RELEASE_SYSTEMD_UNIT_V1, /^ExecStart=\/usr\/bin\/node \/var\/lib\/aloha\/pre-release\/artifacts\/pre-release-owner\.mjs$/m);
  assert.doesNotMatch(PRE_RELEASE_SYSTEMD_UNIT_V1, /^ExecStartPre=/m);
  for (const directive of [
    "NoNewPrivileges=true",
    "ProtectSystem=strict",
    "ProtectHome=true",
    "PrivateTmp=true",
    "Restart=no",
    "RuntimeMaxSec=2h",
    "KillSignal=SIGTERM",
    "TimeoutStopSec=5min",
    "ReadOnlyPaths=/var/lib/aloha/pre-release/repository /var/lib/aloha/pre-release/artifacts",
    "ReadWritePaths=/var/lib/aloha/pre-release/runtime /var/lib/aloha-acceptance/pre-release/observer-store /var/log/aloha/pre-release.log",
  ]) assert.match(PRE_RELEASE_SYSTEMD_UNIT_V1, new RegExp(`^${directive.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}$`, "m"));

  const mutations = [
    PRE_RELEASE_SYSTEMD_UNIT_V1.replace("ExecStart=/usr/bin/node", "ExecStartPre=/usr/bin/true\nExecStart=/usr/bin/node"),
    PRE_RELEASE_SYSTEMD_UNIT_V1.replace("User=aloha\n", ""),
    PRE_RELEASE_SYSTEMD_UNIT_V1.replace("User=aloha", "User=root"),
    PRE_RELEASE_SYSTEMD_UNIT_V1.replace(
      "ReadWritePaths=/var/lib/aloha/pre-release/runtime /var/lib/aloha-acceptance/pre-release/observer-store /var/log/aloha/pre-release.log",
      "ReadWritePaths=/var/lib/aloha/pre-release/runtime /var/lib/aloha-acceptance/pre-release/observer-store /var/lib/aloha-acceptance /var/log/aloha/pre-release.log",
    ),
    `${PRE_RELEASE_SYSTEMD_UNIT_V1.slice(0, -1)}# spliced\n`,
  ];
  for (const mutation of mutations) {
    assert.throws(
      () => assertCanonicalPreReleaseSystemdUnitV1(new TextEncoder().encode(mutation), "unit"),
      /canonical hardened pre-release systemd unit/,
    );
  }

  let traps = 0;
  const proxy = new Proxy(canonical, {
    get() { traps += 1; throw new Error("must not read proxy"); },
    getPrototypeOf() { traps += 1; throw new Error("must not inspect proxy"); },
  });
  assert.throws(() => assertCanonicalPreReleaseSystemdUnitV1(proxy, "unit"), /concrete Uint8Array/);
  assert.equal(traps, 0);

  class ForgedUnitBytes extends Uint8Array {}
  assert.throws(
    () => assertCanonicalPreReleaseSystemdUnitV1(new ForgedUnitBytes(canonical), "unit"),
    /concrete Uint8Array/,
  );
  const accessor = canonical.slice();
  let accessorReads = 0;
  Object.defineProperty(accessor, "forged", {
    enumerable: true,
    get() { accessorReads += 1; throw new Error("must not read accessor"); },
  });
  assert.throws(() => assertCanonicalPreReleaseSystemdUnitV1(accessor, "unit"), /concrete Uint8Array/);
  assert.equal(accessorReads, 0);
});

test("artifact-set root requires exact roles, locators, and content identities", () => {
  const entries = PRE_RELEASE_STAGING_ARTIFACT_NAMES_V1.map((name, index): PreReleaseStagingArtifactIdentityV1 => Object.freeze({
    name,
    installPath: preReleaseStagingArtifactPathV1(name),
    contentSha256: h(`artifact-${index}`),
    byteLength: String(index + 1),
  }));
  const root = hashPreReleaseStagingArtifactSetV1(entries);
  assert.match(root, /^0x[0-9a-f]{64}$/);
  assert.equal(entries.length, 23);
  assert.throws(() => hashPreReleaseStagingArtifactSetV1(entries.slice(1)), /denominator mismatch/);
  assert.throws(() => hashPreReleaseStagingArtifactSetV1([entries[1]!, entries[0]!, ...entries.slice(2)]), /denominator mismatch/);
  assert.throws(() => hashPreReleaseStagingArtifactSetV1([...entries, entries[0]!]), /denominator mismatch/);
  assert.throws(() => hashPreReleaseStagingArtifactSetV1(entries.map((entry, index) => index === 3
    ? { ...entry, name: "runtime-release-package-approval.json" as never }
    : entry)), /unknown pre-release artifact name/);
  assert.throws(() => hashPreReleaseStagingArtifactSetV1(entries.map((entry, index) => index === 4
    ? { ...entry, installPath: "/var/lib/aloha/pre-release/artifacts/spliced.json" }
    : entry)), /artifact path mismatch/);
  const hashSplice = entries.map((entry, index) => index === 5
    ? { ...entry, contentSha256: h("spliced-content") }
    : entry);
  assert.notEqual(hashPreReleaseStagingArtifactSetV1(hashSplice), root);
  const lengthSplice = entries.map((entry, index) => index === 6
    ? { ...entry, byteLength: String(Number(entry.byteLength) + 1) }
    : entry);
  assert.notEqual(hashPreReleaseStagingArtifactSetV1(lengthSplice), root);
});

test("durable claim survives reopen and rejects authorization and nonce replay", () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "aloha-pre-release-claims-")));
  const databasePath = join(directory, "claims.sqlite");
  try {
    const authorization = unsignedTestAuthorization({ nonce: h("durable-nonce") });
    const first = claimPreReleaseAuthorizationInDatabaseV1(databasePath, claimExpectation(authorization));
    assert.equal(first.authorizationId, authorization.authorizationId);
    assert.equal(first.nonce, authorization.nonce);
    assert.equal(first.stagingArtifactSetRoot, authorization.stagingArtifactSetRoot);
    assert.match(first.ledgerInode, /^[1-9][0-9]*$/);
    assert.throws(
      () => claimPreReleaseAuthorizationInDatabaseV1(databasePath, claimExpectation(authorization)),
      /already durably consumed/,
    );
    const sameNonceDifferentAuthorization = unsignedTestAuthorization({
      nonce: authorization.nonce,
      stagingManifestRoot: h("other-manifest"),
    });
    assert.throws(
      () => claimPreReleaseAuthorizationInDatabaseV1(
        databasePath,
        claimExpectation(sameNonceDifferentAuthorization),
      ),
      /nonce was already durably consumed/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("fixed-ledger projection reader rejects structural and cross-claim DTO substitution", () => {
  const first = unsignedTestAuthorization({ nonce: h("opaque-first") });
  const second = unsignedTestAuthorization({ nonce: h("opaque-second") });
  const structural = Object.freeze({
    authorizationId: first.authorizationId,
    claimId: h("structural-claim"),
  });
  assert.throws(
    () => readFixedPreReleaseAuthorizationClaimV1(first, structural as never),
    /not fixed-ledger-issued/,
  );
  assert.throws(
    () => readFixedPreReleaseAuthorizationClaimV1(second, structural as never),
    /not fixed-ledger-issued/,
  );
  assert.throws(
    () => readFixedPreReleaseAuthorizationClaimV1(first, Object.freeze(Object.create(null))),
    /not fixed-ledger-issued/,
  );
});

test("durable ledger admits exactly one restart-probe then its bound qualification-final", () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "aloha-pre-release-two-pid-ledger-")));
  const databasePath = join(directory, "claims.sqlite");
  try {
    const probe = unsignedTestAuthorization({ nonce: h("two-pid-probe-nonce") });
    const prematureFinal = unsignedTestAuthorization({
      roundRole: "qualification-final",
      predecessor: predecessorFacts(probe.authorizationId, h("not-yet-claimed"), "premature-probe"),
      allowedTerminal: "qualification-facts-observed",
      permissions: Object.freeze({
        runRuntime: true,
        emitRestartMarker: false,
        sign: false,
        broadcast: false,
        promote: false,
      }),
      nonce: h("premature-final-nonce"),
    });
    assert.throws(
      () => claimPreReleaseAuthorizationInDatabaseV1(databasePath, claimExpectation(prematureFinal)),
      /requires a durable restart-probe claim/,
    );

    const probeClaim = claimPreReleaseAuthorizationInDatabaseV1(databasePath, claimExpectation(probe));
    assert.equal(probeClaim.predecessor, null);
    const secondProbe = unsignedTestAuthorization({ nonce: h("second-probe-nonce") });
    assert.throws(
      () => claimPreReleaseAuthorizationInDatabaseV1(databasePath, claimExpectation(secondProbe)),
      /already has a restart-probe round/,
    );

    const finalPatch = Object.freeze({
      roundRole: "qualification-final" as const,
      predecessor: predecessorFacts(probe.authorizationId, probeClaim.claimId, "probe"),
      allowedTerminal: "qualification-facts-observed" as const,
      permissions: Object.freeze({
        runRuntime: true as const,
        emitRestartMarker: false,
        sign: false as const,
        broadcast: false as const,
        promote: false as const,
      }),
    });
    const splicedFinal = unsignedTestAuthorization({
      ...finalPatch,
      predecessor: Object.freeze({ ...finalPatch.predecessor, authorizationClaimId: h("spliced-probe-claim") }),
      nonce: h("spliced-final-nonce"),
    });
    assert.throws(
      () => claimPreReleaseAuthorizationInDatabaseV1(databasePath, claimExpectation(splicedFinal)),
      /predecessor claim was spliced/,
    );

    const finalAuthorization = unsignedTestAuthorization({ ...finalPatch, nonce: h("final-nonce") });
    const finalClaim = claimPreReleaseAuthorizationInDatabaseV1(databasePath, claimExpectation(finalAuthorization));
    assert.deepEqual(finalClaim.predecessor, finalPatch.predecessor);
    const secondFinal = unsignedTestAuthorization({ ...finalPatch, nonce: h("second-final-nonce") });
    assert.throws(
      () => claimPreReleaseAuthorizationInDatabaseV1(databasePath, claimExpectation(secondFinal)),
      /already has a qualification-final round/,
    );
    const mutable = new DatabaseSync(databasePath);
    mutable.prepare("UPDATE pre_release_authorization_claim_v1 SET predecessor_controller_receipt_id = ? WHERE authorization_id = ?")
      .run(h("spliced-controller-receipt"), finalAuthorization.authorizationId);
    mutable.close();
    assert.throws(
      () => claimPreReleaseAuthorizationInDatabaseV1(databasePath, claimExpectation(finalAuthorization)),
      /durable claim was spliced/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("qualification-final cannot splice a predecessor from another staging identity", () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "aloha-pre-release-cross-staging-")));
  const databasePath = join(directory, "claims.sqlite");
  try {
    const probe = unsignedTestAuthorization({ nonce: h("cross-stage-probe") });
    const probeClaim = claimPreReleaseAuthorizationInDatabaseV1(databasePath, claimExpectation(probe));
    const final = unsignedTestAuthorization({
      roundRole: "qualification-final",
      predecessor: predecessorFacts(probe.authorizationId, probeClaim.claimId, "cross-stage"),
      stagingManifestRoot: h("different-staging-manifest"),
      allowedTerminal: "qualification-facts-observed",
      permissions: Object.freeze({
        runRuntime: true,
        emitRestartMarker: false,
        sign: false,
        broadcast: false,
        promote: false,
      }),
      nonce: h("cross-stage-final"),
    });
    assert.throws(
      () => claimPreReleaseAuthorizationInDatabaseV1(databasePath, claimExpectation(final)),
      /cross-staging transition is invalid/,
    );

    const replacementProbe = unsignedTestAuthorization({
      stagingArtifactSetRoot: h("different-staging-artifacts"),
      stagingManifestRoot: h("different-staging-manifest"),
      nonce: h("cross-stage-replacement-probe"),
    });
    assert.throws(
      () => claimPreReleaseAuthorizationInDatabaseV1(databasePath, claimExpectation(replacementProbe)),
      /cross-staging transition is invalid/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("failed validation does not consume and a later exact claim succeeds", () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "aloha-pre-release-claim-rollback-")));
  const databasePath = join(directory, "claims.sqlite");
  try {
    const authorization = unsignedTestAuthorization({ nonce: h("rollback-nonce") });
    assert.throws(
      () => claimPreReleaseAuthorizationInDatabaseV1(databasePath, claimExpectation(authorization, {
        stagingArtifactSetRoot: h("forged-artifact-root"),
      }) as never),
      /exact binding mismatch/,
    );
    assert.throws(
      () => claimPreReleaseAuthorizationInDatabaseV1(databasePath, claimExpectation(authorization, {
        nowUnixNs: authorization.expiresAtUnixNs,
      }) as never),
      /outside its validity interval/,
    );
    const claimed = claimPreReleaseAuthorizationInDatabaseV1(databasePath, claimExpectation(authorization));
    assert.equal(claimed.authorizationId, authorization.authorizationId);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a post-insert receipt-fence failure rolls back instead of consuming", () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "aloha-pre-release-claim-fence-")));
  const databasePath = join(directory, "claims.sqlite");
  try {
    writeFileSync(databasePath, new Uint8Array());
    chmodSync(databasePath, 0o666);
    const authorization = unsignedTestAuthorization({ nonce: h("receipt-fence-nonce") });
    assert.throws(
      () => claimPreReleaseAuthorizationInDatabaseV1(databasePath, claimExpectation(authorization)),
      /owner-controlled regular file|path changed across database open/,
    );
    chmodSync(databasePath, 0o600);
    const claimed = claimPreReleaseAuthorizationInDatabaseV1(databasePath, claimExpectation(authorization));
    assert.equal(claimed.authorizationId, authorization.authorizationId);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("durable row and uniqueness-schema splices are invalid, not replay success", () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "aloha-pre-release-claim-splice-")));
  const databasePath = join(directory, "claims.sqlite");
  try {
    const authorization = unsignedTestAuthorization({ nonce: h("splice-nonce") });
    claimPreReleaseAuthorizationInDatabaseV1(databasePath, claimExpectation(authorization));
    const database = new DatabaseSync(databasePath);
    database.prepare("UPDATE pre_release_authorization_claim_v1 SET staging_manifest_root = ? WHERE authorization_id = ?")
      .run(h("spliced-manifest"), authorization.authorizationId);
    database.close();
    assert.throws(
      () => claimPreReleaseAuthorizationInDatabaseV1(databasePath, claimExpectation(authorization)),
      /durable claim was spliced/,
    );

    const schemaDirectory = realpathSync(mkdtempSync(join(tmpdir(), "aloha-pre-release-schema-splice-")));
    try {
      const schemaPath = join(schemaDirectory, "claims.sqlite");
      const valid = unsignedTestAuthorization({ nonce: h("schema-nonce") });
      claimPreReleaseAuthorizationInDatabaseV1(schemaPath, claimExpectation(valid));
      const mutable = new DatabaseSync(schemaPath);
      mutable.exec("ALTER TABLE pre_release_authorization_claim_v1 RENAME TO forged_claims");
      mutable.exec("CREATE TABLE pre_release_authorization_claim_v1 (authorization_id TEXT)");
      mutable.close();
      const next = unsignedTestAuthorization({ nonce: h("schema-next-nonce") });
      assert.throws(
        () => claimPreReleaseAuthorizationInDatabaseV1(schemaPath, claimExpectation(next)),
        /schema mismatch|uniqueness contract mismatch/,
      );
    } finally {
      rmSync(schemaDirectory, { recursive: true, force: true });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("advisory material reader rejects structural capabilities and old import/completion APIs are absent", () => {
  assert.throws(() => readPreReleaseAdvisoryMaterialCapabilityV1(Object.freeze({})), /not staging-owner-issued/);
  const owner = readFileSync(new URL("../src/internal/pre-release-staging-owner.ts", import.meta.url), "utf8");
  assert.doesNotMatch(owner, /IssuePreReleaseLaunchInputV1|CompletePreReleaseRuntimeInputV1|issuePreReleaseLaunchCapabilityV1|importPreReleaseRuntimeBundleV1|completePreReleaseRuntimeLaunchV1/);
});

test("cross-boundary surface has one reader and does not export the issuer from package root", () => {
  const surface = readFileSync(new URL("../src/pre-release-staging.ts", import.meta.url), "utf8");
  const contract = readFileSync(new URL("../src/pre-release-staging-contract.ts", import.meta.url), "utf8");
  const root = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const owner = readFileSync(new URL("../src/internal/pre-release-staging-owner.ts", import.meta.url), "utf8");
  const launcher = readFileSync(new URL("../assets/pre-release-owner.mjs", import.meta.url), "utf8");
  const state = readFileSync(new URL("../src/internal/pre-release-runtime-receipt-state.ts", import.meta.url), "utf8");
  assert.match(surface, /readPreReleaseAdvisoryMaterialCapabilityV1/);
  assert.doesNotMatch(surface, /issuePreReleaseLaunchCapabilityV1|completePreReleaseRuntimeLaunchV1|importPreReleaseRuntimeBundleV1/);
  assert.doesNotMatch(root, /pre-release-staging/);
  assert.doesNotMatch(owner, /inputValue\.(?:repositoryRoot|artifactRoot|manifestPath|databasePath|logPath)/);
  assert.doesNotMatch(owner, /assets\/pre-release-owner\.mjs|new URL\([^)]*import\.meta|import\.meta/);
  assert.doesNotMatch(owner, /assets\/production-launcher\.mjs|legacy|fallback/i);
  assert.match(launcher, /issuePreReleaseStartupCapabilityV1/);
  assert.match(launcher, /startReleaseRuntimeSessionV1/);
  assert.doesNotMatch(launcher, /\/etc\/aloha|legacy|fallback/i);
  let prior = -1;
  for (const name of PRE_RELEASE_STAGING_ARTIFACT_NAMES_V1) {
    const next = launcher.indexOf(JSON.stringify(name), prior + 1);
    assert.ok(next > prior, `launcher artifact denominator is out of order at ${name}`);
    prior = next;
  }
  assert.doesNotMatch(state, /pre-release-staging-owner/);
  assert.match(contract, /readonly stagingArtifacts: readonly PreReleaseStagingArtifactIdentityV1\[\]/);
  assert.match(contract, /readonly name: PreReleaseStagingArtifactNameV1/);
  assert.match(contract, /readonly installPath: string/);
  assert.match(contract, /readonly contentSha256: Hash/);
  assert.match(contract, /readonly byteLength: string/);
  assert.doesNotMatch(contract, /deploymentCompositionBytes|deploymentSourceBytes|runtimePolicyBytes|executorStateBytes/);
});

test("final runner derives controller install only from a genuine Boundary receipt and uses unit as ready marker", () => {
  const source = readFileSync(new URL("../src/final-pre-release-runner.ts", import.meta.url), "utf8");
  const boundaryIssue = source.indexOf("issueQualifiedPreReleaseControllerBoundaryEvidenceV1(boundaryReceipt, repositoryRoot)");
  const exactBuild = source.indexOf("buildExactPreReleaseStagingRuntimeArtifactsV1(repositoryRoot, evidence.candidateReleaseCommit)", boundaryIssue);
  const entrypoint = source.indexOf("const entrypoint =", exactBuild);
  const unit = source.indexOf("const unit =", entrypoint);
  assert.ok(boundaryIssue >= 0 && exactBuild > boundaryIssue && entrypoint > exactBuild && unit > entrypoint);
  assert.doesNotMatch(source, /repositoryRootValue|expectedCommitValue|export function createPreReleaseQualificationFinalAuthorizationSigningRequestV1/);
  assert.match(source, /readFixedPreReleaseRestartControllerReceiptV1\(\)/);
  assert.match(source, /controllerBoundaryEvidenceRoot: evidence\.evidenceRoot/);
  const directControllerJoin = "controllerReceipt.target.controllerBoundaryEvidenceRoot !== controllerBoundaryEvidenceRoot";
  assert.match(source, new RegExp(directControllerJoin.replaceAll(".", "\\.")));
  const mutant = source.replace(directControllerJoin, "false");
  assert.equal(mutant.includes(directControllerJoin), false, "controller-root mutation must kill the direct join gate");
});

test("fixed final CLI keeps Boundary receipt in-process and runner orders A, controller, B freeze, snapshots, and thaw", () => {
  const cli = readFileSync(new URL("../src/final-pre-release-cli.ts", import.meta.url), "utf8");
  assert.match(cli, /runBoundaryGate\(\{ requirePushed: true \}\)/);
  assert.match(cli, /await runFinalPreReleaseV1\(receipt\)/);
  assert.doesNotMatch(cli, /JSON\.parse|decodeCanonicalJson|process\.argv\[/);
  const source = readFileSync(new URL("../src/final-pre-release-runner.ts", import.meta.url), "utf8");
  let cursor = source.indexOf("export async function runFinalPreReleaseV1(");
  for (const step of [
    "installExactPreReleaseRestartControllerV1(boundaryReceipt)",
    "claimFixedPreReleaseAuthorizationV1(claimExpectation(probeRaw.authorization))",
    "installActiveAuthorization(probeRaw.bytes, null)",
    'systemctl(["start", PRE_RELEASE_STAGING_LAYOUT_V1.systemdUnit])',
    'systemctl(["start", "--no-block", PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1.controllerSystemdUnit])',
    "sealPreReleaseRestartTerminalV1({",
    "readFixedPreReleaseRestartControllerReceiptV1()",
    "canonicalAuthorization(PRE_RELEASE_STAGING_LAYOUT_V1.qualificationFinalAuthorizationPath)",
    "verifyPreReleaseLaunchAuthorizationSignatureV1(finalRaw.authorization, signerPin)",
    "assertQualificationFinalSafetyAuthorizationV1(",
    "claimFixedPreReleaseAuthorizationV1(claimExpectation(finalRaw.authorization))",
    "installActiveAuthorization(finalRaw.bytes, probeRaw.bytes)",
    "observePreReleaseBReadyFactsV1(predecessor)",
    "observeQualificationFinalTerminalReadyV1(finalRaw.authorization, bFacts)",
    "invokeFixedPreReleaseFreezeV1()",
    "bindStablePreReleaseFrozenCgroupV1(",
    "publishPreReleaseBDurableSnapshotsV1()",
    "issueFrozenPreReleaseBQualificationCapabilityV1(Object.freeze({",
    "importFrozenPreReleaseBRuntimeV1(bQualificationCapability)",
    "issueImportedFrozenPreReleaseBAdvisoryMaterialV1(importedB)",
    "observeProductionReleaseAcceptanceAdvisoryV1(advisoryMaterial)",
    "PRE_RELEASE_STAGING_LAYOUT_V1.advisoryJudgmentPath",
    "readImportedFrozenPreReleaseBTerminalPhysicalObservationV1(importedB)",
    "readPreReleaseFactLogV1(",
    "PRE_RELEASE_STAGING_LAYOUT_V1.factLogPath",
    "readFixedProductionPackagingInputsV1()",
    "prepareProductionReleaseAcceptanceForExternalOwnerV1(",
    "readProductionReleaseAcceptanceSigningRequestV1(",
    "prepareFrozenProductionArtifactBaseV1({",
    "PRE_RELEASE_STAGING_LAYOUT_V1.releaseAcceptanceSigningRequestPath",
    "materializeFrozenProductionArtifactBaseV1(",
    "invokeFixedPreReleaseThawV1(bProcess)",
    'systemctl(["stop", PRE_RELEASE_STAGING_LAYOUT_V1.systemdUnit])',
  ]) {
    const next = source.indexOf(step, cursor + 1);
    assert.ok(next > cursor, `final pre-release step is absent or out of order: ${step}`);
    cursor = next;
  }
  assert.match(source, /readdirSync\(directory\)\.sort\(\)/);
  assert.match(source, /sha256Hex\(revmWorkerBytes\) !== deploymentInfrastructure\.revmWorkerExecutableSha256/);
  assert.match(source, /sha256Hex\(proofSignerBytes\) !== deploymentInfrastructure\.externalProofSigner\.executableSha256/);
  assert.doesNotMatch(source, /\bsign\s*\(|broadcast:\s*true|promote:\s*true/);
  assert.doesNotMatch(source, /releaseAcceptanceApproval|runtimeReleasePackageApproval/);
  assert.doesNotMatch(source, /void importedB|advisoryJudgment\.status\s*!==\s*"pass"/);
});

test("qualification-final launcher publishes only a locator and holds the process for root observation", () => {
  const launcher = readFileSync(new URL("../assets/pre-release-owner.mjs", import.meta.url), "utf8");
  const sessionDone = launcher.indexOf("await session.done");
  const hold = launcher.indexOf("await holdQualificationFinalUntilSignal(authorization)", sessionDone);
  const signal = launcher.indexOf('process.once("SIGTERM", resolve)', launcher.indexOf("async function holdQualificationFinalUntilSignal"));
  const publish = launcher.indexOf("publishQualificationFinalTerminalReady(authorization)", signal);
  assert.ok(sessionDone >= 0 && hold > sessionDone && signal >= 0 && publish > signal);
  assert.match(launcher, /if \(authorization\.roundRole !== "qualification-final"\) return/);
  assert.match(launcher, /O_CREAT \| fsConstants\.O_EXCL \| fsConstants\.O_WRONLY \| fsConstants\.O_NOFOLLOW/);
  assert.match(launcher, /fsyncSync\(descriptor\)/);
  assert.match(launcher, /kind: "aloha\.pre-release-qualification-final-terminal-ready-locator"/);
  assert.doesNotMatch(launcher, /terminal-ready[^\n]*(?:verdict|pass|profitable|accepted)/i);
});

test("staging owner imports B only from final-runner authority and immutable frozen evidence", () => {
  const owner = readFileSync(new URL("../src/internal/pre-release-staging-owner.ts", import.meta.url), "utf8");
  const state = readFileSync(new URL("../src/internal/pre-release-b-qualification-state.ts", import.meta.url), "utf8");
  const importStart = owner.indexOf("export async function importFrozenPreReleaseBRuntimeV1(");
  const readQualification = owner.indexOf("readFrozenPreReleaseBQualificationCapabilityV1(capability)", importStart);
  const installRunner = owner.indexOf("installFrozenQualifiedRunner(qualification, stagingArtifactBytes)", readQualification);
  const processReceipt = owner.indexOf("processImportReceipt(", installRunner);
  assert.ok(importStart >= 0 && readQualification > importStart && installRunner > readQualification && processReceipt > installRunner);
  assert.match(owner, /boundaryReceipt: qualification\.boundaryReceipt/);
  assert.match(owner, /readPreReleaseQualifiedRunnerInputBytesV1\(runner\)/);
  assert.match(owner, /processEvidenceDatabasePath: processEvidence\.snapshotPath/);
  assert.match(owner, /checkpointDatabasePath: checkpoint\.snapshotPath/);
  assert.match(owner, /PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1\.bProcessEvidenceSnapshotPath/);
  assert.match(owner, /PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1\.bCheckpointSnapshotPath/);
  assert.match(owner, /new DatabaseSync\(expectedPath, \{ readOnly: true \}\)/);
  assert.match(owner, /PRAGMA integrity_check/);
  assert.match(owner, /publication\.device !== String\(afterRead\.dev\)/);
  assert.match(owner, /publication\.contentSha256 !== sha256Hex\(bytes\)/);
  assert.match(owner, /sha256Hex\(new Uint8Array\(readFileSync\(expectedPath\)\)\) !== publication\.contentSha256/);
  assert.match(owner, /frozen\.systemdFreezerState !== "frozen"/);
  assert.match(owner, /hashDomain\("aloha\/pre-release-process-import-receipt\/id\/v1"/);
  assert.doesNotMatch(owner, /export function importFrozenPreReleaseBRuntimeV1\([^)]*StateV1/);
  assert.match(state, /const qualifications = new WeakMap<object, FrozenPreReleaseBQualificationStateV1>\(\)/);
  assert.match(state, /Reflect\.ownKeys\(capability\)\.length !== 0/);
  assert.doesNotMatch(state, /JSON\.parse|decodeCanonicalJson/);
});
