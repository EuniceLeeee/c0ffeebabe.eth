import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import {
  sealReleaseQualifiedCapabilitySetV1,
} from "../../../specs/capability-index/src/index.ts";
import {
  createRuntimeReleaseDiscoverySourceQualificationV1,
  createRuntimeReleaseBindingV1,
  hashQualifiedExecutorRegistryEntry,
  hashQualifiedExecutorRegistryRoot,
  hashRuntimeReleaseDiscoveryEndpointLocatorV1,
  sealRuntimeReleaseNominationQualificationSetV1,
  runtimeReleaseBindingSigningBytes,
  type RuntimeReleaseBindingPayloadV1,
} from "../../../specs/release-authority/src/index.ts";
import { generatedEconomicValuationOwnerQualificationSetFixtureV1 } from "../../../specs/release-authority/test/generated-valuation-owner-qualification-fixture.ts";
import { generatedEconomicSafetyActionOwnerQualificationFixtureV1 } from "../../../specs/release-authority/test/generated-action-owner-qualification-fixture.ts";
import {
  PRODUCTION_RELEASE_LAYOUT_V1,
  PRODUCTION_SYSTEMD_UNIT_V1,
  verifyRuntimeReleaseBindingSignatureV1,
} from "../src/index.ts";
import { observeExactPushedGitV1 } from "../src/git-release-evidence.ts";
import {
  assertProductionLauncherArtifactV1,
  assertSelfContainedQualifiedReleaseRunnerBundleV1,
  assertSelfContainedRuntimeBundleV1,
  buildQualifiedReleaseRunnerBundleV1,
  buildProductionRuntimeBundleV1,
  loadProductionLauncherArtifactV1,
} from "../src/internal/runtime-bundle-builder.ts";
import { buildExactQualifiedReleaseRunnerBundleV1 } from "../src/exact-runtime-artifacts.ts";
import {
  issueFreshQualifiedRunnerHostV1,
  invokeFreshQualifiedRunnerHostV1,
} from "../src/internal/fresh-qualified-runner-host-owner.ts";

const h = (value: string): Hash => hashDomain("test/runtime-release-packager", value);
const valuationQualification = generatedEconomicValuationOwnerQualificationSetFixtureV1("runtime-release-packager");
const actionOwnerQualification = generatedEconomicSafetyActionOwnerQualificationFixtureV1("runtime-release-packager");
const executor = {
  executorKind: "revm", engineBuildFingerprint: h("engine"), executableFingerprint: h("executable"),
  closureFingerprint: h("closure"), protocolFingerprint: h("protocol"), schemaFingerprint: h("schema"),
  releaseRoleManifestRoot: h("manifest"), candidateCommit: "2".repeat(40),
};
const qualifiedCapabilityRefs = Object.freeze([
  { capabilityId: "family.test.state", version: "1.0.0", schemaHash: h("state-schema"), interpreterHash: h("state-interpreter"), ownerRef: h("state-owner") },
  { capabilityId: "family.test.exact", version: "1.0.0", schemaHash: h("exact-schema"), interpreterHash: h("exact-interpreter"), ownerRef: h("exact-owner") },
] as const);
const proposedCapabilitySet = sealReleaseQualifiedCapabilitySetV1(qualifiedCapabilityRefs);
const nominationQualificationSet = sealRuntimeReleaseNominationQualificationSetV1([
  {
    proposalLeafDigest: h("nomination-program-proposal"),
    criticalMutationCorpusRoot: h("nomination-mutation-corpus"),
    independentOracleCaseRoot: h("nomination-oracle-cases"),
    qualificationSpecDigest: h("nomination-qualification-spec"),
    verifierQualificationCertificateRoot: h("nomination-verifier-certificate"),
  },
]);
const payload: RuntimeReleaseBindingPayloadV1 = {
  schemaVersion: 1, kind: "aloha.runtime-release-binding",
  releaseAuthorityApprovalId: h("approval"), releaseAuthorityApprovalPayloadHash: h("approval-payload"),
  releaseAcceptanceRequirementSetRoot: h("acceptance-requirements"),
  externalTrustAnchorRoot: h("anchor"), externalIssuerKeySetRoot: h("keys"),
  qualificationRegistryApprovalId: h("registry-approval"), qualificationRegistryRoot: h("qualification-registry"),
  qualificationEpoch: "1", qualificationAudienceHash: h("audience"), predicateCompositionRootDigest: h("composition"),
  gateCoreRuntimeClosureDigest: h("runtime"), gateCoreImplementationClosureDigest: h("core"),
  searcherRuntime: { runtimeArtifactRoot: h("searcher-artifact"), implementationClosureDigest: h("searcher-closure"), nodeExecutableSha256: h("searcher-node"), entrypointSha256: h("searcher-entrypoint"), bundleModulePath: "/etc/aloha/deployment-bundle.mjs", bundleModuleSha256: h("searcher-bundle") },
  discoverySourceQualification: createRuntimeReleaseDiscoverySourceQualificationV1({
    providerIdentity: "reth-mainnet",
    backendEpoch: "reth-backend-1",
    profile: "reth-json-rpc-v1",
    chainId: "1",
    endpointLocatorHash: hashRuntimeReleaseDiscoveryEndpointLocatorV1("http://127.0.0.1:8545"),
    qualificationRoot: h("discovery-source-qualification"),
  }),
  qualifiedExecutorRegistry: [executor], qualifiedExecutorRegistryRoot: hashQualifiedExecutorRegistryRoot([executor]),
  valuationOwnerRegistryRoot: valuationQualification.registry.valuationOwnerRegistryRoot,
  valuationOwnerQualificationCertificates: valuationQualification.certificates,
  qualifiedValuationOwnerSetRoot: valuationQualification.root,
  actionOwnerRegistryRoot: actionOwnerQualification.registry.actionOwnerRegistryRoot,
  actionOwnerQualificationCertificates: actionOwnerQualification.certificates,
  qualifiedActionOwnerSetRoot: actionOwnerQualification.root,
  safetyProfile: actionOwnerQualification.profile,
  safetyProfileRoot: actionOwnerQualification.profileRoot,
  qualifiedCapabilityRefsRoot: proposedCapabilitySet.root,
  nominationProgramSetRoot: nominationQualificationSet.programSetRoot,
  nominationQualificationSet,
  nominationQualificationSetRoot: nominationQualificationSet.root,
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

function externallySignedBinding(
  value: RuntimeReleaseBindingPayloadV1,
  signerKeyId: Hash,
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
) {
  const signatureHex = `0x${sign(
    null,
    Buffer.from(runtimeReleaseBindingSigningBytes(value, signerKeyId)),
    privateKey,
  ).toString("hex")}` as `0x${string}`;
  return createRuntimeReleaseBindingV1(value, signerKeyId, signatureHex);
}

test("packager verifies an already signed runtime binding without authoring signing material", () => {
  const keys = generateKeyPairSync("ed25519");
  const signerKeyId = h("signer");
  const pin = { signerKeyId, publicKeyHex: rawPublicKeyHex(keys.publicKey) };
  const binding = verifyRuntimeReleaseBindingSignatureV1(
    externallySignedBinding(payload, signerKeyId, keys.privateKey),
    pin,
  );
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
  const binding = externallySignedBinding(payload, signerKeyId, first.privateKey);
  assert.throws(() => verifyRuntimeReleaseBindingSignatureV1(binding, secondPin), /signature invalid/);
  const flipped = `${binding.signatureHex.slice(0, -2)}${binding.signatureHex.endsWith("00") ? "01" : "00"}` as `0x${string}`;
  assert.throws(() => verifyRuntimeReleaseBindingSignatureV1({ ...binding, signatureHex: flipped }, firstPin), /signature invalid/);
  assert.throws(() => verifyRuntimeReleaseBindingSignatureV1({ ...binding, workerEpoch: "epoch-2" }, firstPin), /payloadHash mismatch|identity mismatch|signature invalid/);
  assert.throws(() => verifyRuntimeReleaseBindingSignatureV1(binding, { ...firstPin, publicKeyHex: "0x11" } as never), /32-byte/);
});

function git(directory: string, ...args: string[]): string {
  return execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" }).trim();
}

function packageFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aloha-release-package-")));
  const remote = join(root, "remote.git");
  const repository = join(root, "repository");
  const output = join(root, "packages");
  execFileSync("git", ["init", "--bare", remote]);
  mkdirSync(repository);
  git(repository, "init", "-b", "codex/aloha");
  git(repository, "config", "user.email", "aloha@example.invalid");
  git(repository, "config", "user.name", "Aloha Test");
  mkdirSync(join(repository, "apps/searcher-runtime/src"), { recursive: true });
  mkdirSync(join(repository, "deploy"), { recursive: true });
  const entrypointPath = join(repository, "apps/searcher-runtime/src/production-entry.mjs");
  const unitPath = join(repository, "deploy/aloha-searcher.service.template");
  const bundlePath = join(root, "deployment-bundle.mjs");
  const nodePath = join(root, "node");
  writeFileSync(entrypointPath, "export {};\n");
  writeFileSync(unitPath, PRODUCTION_SYSTEMD_UNIT_V1);
  writeFileSync(bundlePath, "export default Object.freeze({});\n");
  writeFileSync(nodePath, "test-node-executable\n");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "fixture");
  git(repository, "remote", "add", "origin", remote);
  git(repository, "push", "-u", "origin", "codex/aloha");
  const commit = git(repository, "rev-parse", "HEAD");

  return { root, remote, repository, output, entrypointPath, unitPath, bundlePath, nodePath, commit };
}

function withProcessEnvironment(
  overrides: Readonly<Record<string, string>>,
  action: () => void,
): void {
  const previous = new Map(Object.keys(overrides).map(key => [key, process.env[key]] as const));
  try {
    for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
    action();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("dirty, unpushed, hidden-index, and symlinked Git mutations fail closed", () => {
  const dirty = packageFixture();
  writeFileSync(join(dirty.repository, "untracked"), "x");
  assert.throws(() => observeExactPushedGitV1(dirty.repository), /dirty/);

  const ahead = packageFixture();
  writeFileSync(ahead.entrypointPath, "export const ahead = true;\n");
  git(ahead.repository, "add", ".");
  git(ahead.repository, "commit", "-m", "ahead");
  assert.throws(() => observeExactPushedGitV1(ahead.repository), /exact pushed/);

  const assumed = packageFixture();
  git(assumed.repository, "update-index", "--assume-unchanged", "apps/searcher-runtime/src/production-entry.mjs");
  writeFileSync(assumed.entrypointPath, "export const hidden = true;\n");
  assert.throws(() => observeExactPushedGitV1(assumed.repository), /noncanonical flag/);

  const skipped = packageFixture();
  git(skipped.repository, "update-index", "--skip-worktree", "apps/searcher-runtime/src/production-entry.mjs");
  writeFileSync(skipped.entrypointPath, "export const hidden = true;\n");
  assert.throws(() => observeExactPushedGitV1(skipped.repository), /noncanonical flag/);

  const symlinked = packageFixture();
  const target = join(symlinked.repository, "tracked-target");
  const link = join(symlinked.repository, "tracked-link");
  writeFileSync(target, "tracked target\n");
  symlinkSync("tracked-target", link);
  git(symlinked.repository, "add", "tracked-target", "tracked-link");
  git(symlinked.repository, "commit", "-m", "tracked symlink");
  git(symlinked.repository, "push");
  assert.throws(() => observeExactPushedGitV1(symlinked.repository), /not a regular file/);

});

test("release Git evidence ignores PATH and caller Git/config/loader environment", () => {
  const attacks = [
    () => {
      const fixture = packageFixture();
      writeFileSync(join(fixture.repository, "untracked"), "x");
      const shadow = join(fixture.root, "shadow");
      mkdirSync(shadow);
      const fakeGit = join(shadow, "git");
      writeFileSync(fakeGit, "#!/bin/sh\nexit 97\n");
      chmodSync(fakeGit, 0o755);
      withProcessEnvironment({ PATH: shadow }, () => {
        assert.throws(() => observeExactPushedGitV1(fixture.repository), /dirty/);
      });
    },
    () => {
      const fixture = packageFixture();
      writeFileSync(join(fixture.repository, "untracked"), "x");
      withProcessEnvironment({
        GIT_DIR: join(fixture.root, "attacker.git"),
        GIT_INDEX_FILE: join(fixture.root, "attacker.index"),
        GIT_OBJECT_DIRECTORY: join(fixture.root, "attacker-objects"),
        GIT_REPLACE_REF_BASE: "refs/attacker/replace",
      }, () => {
        assert.throws(() => observeExactPushedGitV1(fixture.repository), /dirty/);
      });
    },
    () => {
      const fixture = packageFixture();
      writeFileSync(join(fixture.repository, "untracked"), "x");
      withProcessEnvironment({
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "core.fsmonitor",
        GIT_CONFIG_VALUE_0: join(fixture.root, "attacker-fsmonitor"),
        GIT_CONFIG_KEY_1: "core.excludesFile",
        GIT_CONFIG_VALUE_1: join(fixture.root, "attacker-excludes"),
        LD_PRELOAD: join(fixture.root, "attacker-loader.so"),
        NODE_OPTIONS: "--require=/attacker.cjs",
        npm_config_prefix: join(fixture.root, "attacker-npm"),
      }, () => {
        assert.throws(() => observeExactPushedGitV1(fixture.repository), /dirty/);
      });
    },
  ];
  for (const attack of attacks) attack();
});

test("release Git evidence pins the real linked worktree and ignores local core.worktree", () => {
  const fixture = packageFixture();
  const attackerWorktree = join(fixture.root, "attacker-worktree");
  mkdirSync(attackerWorktree);
  git(fixture.repository, "config", "core.worktree", attackerWorktree);
  writeFileSync(join(fixture.repository, "untracked"), "x");
  assert.throws(() => observeExactPushedGitV1(fixture.repository), /dirty/);
});

test("replace objects and a local fake upstream cannot become pushed authority", () => {
  const replaced = packageFixture();
  const originalEntrypoint = readFileSync(replaced.entrypointPath);
  writeFileSync(replaced.entrypointPath, "export const replacement = true;\n");
  git(replaced.repository, "add", "apps/searcher-runtime/src/production-entry.mjs");
  const replacementTree = git(replaced.repository, "write-tree");
  const replacementCommit = git(
    replaced.repository,
    "commit-tree",
    replacementTree,
    "-p",
    replaced.commit,
    "-m",
    "attacker replacement",
  );
  git(replaced.repository, "read-tree", "HEAD");
  writeFileSync(replaced.entrypointPath, originalEntrypoint);
  git(replaced.repository, "replace", replaced.commit, replacementCommit);
  git(replaced.repository, "remote", "rename", "origin", "attacker");
  assert.throws(
    () => observeExactPushedGitV1(replaced.repository),
    /canonical origin remote-tracking ref/,
  );

  const fakeRemote = packageFixture();
  git(fakeRemote.repository, "remote", "rename", "origin", "attacker");
  assert.throws(
    () => observeExactPushedGitV1(fakeRemote.repository),
    /canonical origin remote-tracking ref/,
  );
});

test("install and deploy entrypoints remain verification-only and the service unit is exact", () => {
  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const unit = readFileSync(join(repositoryRoot, "deploy/aloha-searcher.service.template"), "utf8");
  const installerPath = join(repositoryRoot, "scripts/install-aloha-searcher.sh");
  const deployPath = join(repositoryRoot, "scripts/deploy-aloha-searcher.sh");
  const installer = readFileSync(installerPath, "utf8");
  const deploy = readFileSync(deployPath, "utf8");
  const productionEntryPath = join(repositoryRoot, "tools/runtime-release-packager/assets/production-launcher.mjs");
  const packagerCliPath = join(repositoryRoot, "tools/runtime-release-packager/src/cli.ts");
  const packagerCli = readFileSync(packagerCliPath, "utf8");
  const productionEntry = readFileSync(productionEntryPath, "utf8");
  const deploymentPackage = readFileSync(new URL("../src/deployment-package.ts", import.meta.url), "utf8");
  assert.equal(unit, PRODUCTION_SYSTEMD_UNIT_V1);
  assert.equal(PRODUCTION_RELEASE_LAYOUT_V1.entrypointPath, "/etc/aloha/production-launcher.mjs");
  assert.equal(
    PRODUCTION_RELEASE_LAYOUT_V1.nominationQualificationDeploymentFactPath,
    "/etc/aloha/nomination-qualification-deployment-fact.json",
  );
  assert.match(productionEntry, /"nomination-qualification-deployment-fact\.json": "\/etc\/aloha\/nomination-qualification-deployment-fact\.json"/);
  assert.match(deploymentPackage, /load\("nomination-qualification-deployment-fact\.json"\)/);
  assert.match(deploymentPackage, /assertNominationQualificationDeploymentFactJoinsBinding/);
  assert.deepEqual(
    productionEntry.match(/^import .*$/gm),
    [
      'import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";',
      'import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";',
    ],
    "the package-owned process must import only Node builtins before preverification",
  );
  assert.ok(
    productionEntry.indexOf("const snapshot = preverifyInstalledRelease();")
      < productionEntry.indexOf("await import(`data:text/javascript;base64,"),
    "runtime snapshot import must occur only after package preverification",
  );
  assert.doesNotMatch(`${installer}\n${deploy}`, /\bsystemctl\b|\b(?:cp|mv|rm|install)\s/);
  assert.doesNotMatch(`${installer}\n${deploy}`, /ALOHA_ROOT|:-\/opt\/aloha/);
  assert.doesNotMatch(packagerCli, /release-evidence|acceptanceCertificates|releaseAcceptanceSet/);
  assert.match(installer, /^ROOT=\/opt\/aloha$/m);
  assert.match(deploy, /^ROOT=\/opt\/aloha$/m);
  assert.match(unit, /^EnvironmentFile=\/etc\/aloha\/searcher-release\.env$/m);
  assert.match(unit, /^UnsetEnvironment=BASH_ENV ENV DYLD_FALLBACK_FRAMEWORK_PATH DYLD_FALLBACK_LIBRARY_PATH DYLD_FRAMEWORK_PATH DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_CONFIG_COUNT GIT_CONFIG_GLOBAL GIT_CONFIG_NOSYSTEM GIT_CONFIG_SYSTEM GIT_DIR GIT_EXEC_PATH GIT_INDEX_FILE GIT_NO_REPLACE_OBJECTS GIT_OBJECT_DIRECTORY GIT_OPTIONAL_LOCKS GIT_REPLACE_REF_BASE GIT_WORK_TREE LD_AUDIT LD_DEBUG LD_DEBUG_OUTPUT LD_LIBRARY_PATH LD_PRELOAD LD_PROFILE NODE_EXTRA_CA_CERTS NODE_OPTIONS NODE_PATH OPENSSL_CONF OPENSSL_ENGINES OPENSSL_MODULES OWNER_PRIVATE_KEY PRIVATE_KEY SSL_CERT_DIR SSL_CERT_FILE$/m);
  assert.doesNotMatch(unit, /EnvironmentFile=-|searcher\.env/);
  assert.match(unit, /^WorkingDirectory=\/$/m);
  assert.doesNotMatch(unit, /^ExecStartPre=/m);
  assert.match(unit, /^ExecStart=\/usr\/bin\/node \/etc\/aloha\/production-launcher\.mjs$/m);
  assert.deepEqual(unit.match(/^Restart=.*$/gm), ["Restart=no"], "the one-shot acceptance process must never auto-restart");
  assert.deepEqual(unit.match(/^RuntimeMaxSec=.*$/gm), ["RuntimeMaxSec=1800s"], "the one-shot acceptance process must have one bounded lifetime");
  assert.doesNotMatch(unit, /^RestartSec=|^StartLimit/m, "the unit must not encode a retry loop around the one application");
  assert.equal(spawnSync(installerPath, [], { encoding: "utf8" }).status, 64);
  assert.equal(spawnSync(deployPath, [], { encoding: "utf8" }).status, 64);
  const packageAttempt = spawnSync(process.execPath, ["--experimental-strip-types", packagerCliPath, "package"], { encoding: "utf8" });
  assert.equal(packageAttempt.status, 64);
  assert.match(packageAttempt.stderr, /command must be check-package or check-installed/);
});

function acceptedRuntimeScannerFixture(prefix = "", dynamic = ""): Uint8Array {
  const load = dynamic || "await import(`data:text/javascript;base64,${Buffer.from(bytes).toString(\"base64\")}#${manifest.deploymentCompositionModuleSha256.slice(2)}`);";
  return Buffer.from(`${prefix}\nconst bytes = new Uint8Array();\nconst manifest = { deploymentCompositionModuleSha256: \"0x00\" };\n${load}\nexport { issueInstalledProductionStartupCapabilityV1, issuePreReleaseStartupCapabilityV1, startReleaseRuntimeSessionV1 };\n`);
}

test("production runtime bundle and launcher are deterministic, distinct, and checkout-independent", () => {
  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const first = buildProductionRuntimeBundleV1(repositoryRoot);
  const second = buildProductionRuntimeBundleV1(repositoryRoot);
  const launcher = loadProductionLauncherArtifactV1(repositoryRoot);
  assert.equal(first.sha256, second.sha256);
  assert.deepEqual(first.bytes, second.bytes);
  assert.notEqual(first.sha256, launcher.sha256);
  assertSelfContainedRuntimeBundleV1(first.bytes);
  assertProductionLauncherArtifactV1(launcher.bytes);
  const source = Buffer.from(first.bytes).toString("utf8");
  const inputPaths = Object.keys(first.metafile.inputs);
  const externalImports = Object.values(first.metafile.outputs)
    .flatMap(output => output.imports)
    .filter(imported => imported.external)
    .map(imported => imported.path);
  assert.doesNotMatch(source, new RegExp(repositoryRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(source, /architecture-boundaries|runtime-bundle-builder|esbuild|node_modules|\/opt\/aloha|file:\/\/|import\.meta/);
  assert.equal(inputPaths.some(path => /architecture-boundaries|runtime-release-packager|typescript|esbuild|node_modules/.test(path)), false);
  assert.equal(
    inputPaths.filter(path => path.startsWith("acceptance/")).every(
      path => path.startsWith("acceptance/collectors/")
        || path === "acceptance/terminal-selection-facts/src/schema.ts",
    ),
    true,
  );
  assert.equal(inputPaths.some(path => path.startsWith("acceptance/terminal-selection-facts/")
    && path !== "acceptance/terminal-selection-facts/src/schema.ts"), false);
  assert.equal(inputPaths.some(path => [
    "acceptance/collectors/src/internal/artifact-lineage-stage-one-owner.ts",
    "acceptance/collectors/src/internal/artifact-lineage-stage-two-git-owner.ts",
    "runtime/revm-workers/src/node-worker-factory.ts",
  ].includes(path)), false);
  assert.equal(externalImports.some(path => [
    "node:child_process",
    "node:module",
    "node:vm",
    "node:worker_threads",
  ].includes(path)), false);
});

test("qualified release runner bundle is deterministic, self-contained, and host-bound", async () => {
  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const first = buildQualifiedReleaseRunnerBundleV1(repositoryRoot);
  const second = buildQualifiedReleaseRunnerBundleV1(repositoryRoot);
  assert.equal(first.sha256, second.sha256);
  assert.deepEqual(first.bytes, second.bytes);
  assertSelfContainedQualifiedReleaseRunnerBundleV1(first.bytes);
  const source = Buffer.from(first.bytes).toString("utf8");
  assert.doesNotMatch(source, new RegExp(repositoryRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(source, /node_modules|\/opt\/aloha|file:\/\/|import\.meta|\bimport\s*\(/);
  const url = `data:text/javascript;base64,${Buffer.from(first.bytes).toString("base64")}`;
  const firstModule = await import(`${url}#first`);
  const secondModule = await import(`${url}#second`);
  assert.deepEqual(Object.keys(firstModule), ["createFreshQualifiedReleaseRunnerRuntimeV1"]);
  assert.notEqual(
    firstModule.createFreshQualifiedReleaseRunnerRuntimeV1,
    secondModule.createFreshQualifiedReleaseRunnerRuntimeV1,
  );
  assert.throws(
    () => firstModule.createFreshQualifiedReleaseRunnerRuntimeV1(
      Object.freeze({}),
      invokeFreshQualifiedRunnerHostV1,
    ),
    /host was not packager-owner-issued/,
  );
});

test("qualified release runner scanner rejects secondary loaders and export widening", () => {
  const accepted = Buffer.from("const createFreshQualifiedReleaseRunnerRuntimeV1=()=>Object.freeze({});\nexport { createFreshQualifiedReleaseRunnerRuntimeV1 };\n");
  assert.doesNotThrow(() => assertSelfContainedQualifiedReleaseRunnerBundleV1(accepted));
  for (const [source, reason] of [
    [Buffer.from('import "./relative.mjs";\nconst createFreshQualifiedReleaseRunnerRuntimeV1=()=>({});\nexport { createFreshQualifiedReleaseRunnerRuntimeV1 };'), /node:\* builtin/],
    [Buffer.from('import "node:child_process";\nconst createFreshQualifiedReleaseRunnerRuntimeV1=()=>({});\nexport { createFreshQualifiedReleaseRunnerRuntimeV1 };'), /node:\* builtin/],
    [Buffer.from('const createFreshQualifiedReleaseRunnerRuntimeV1=()=>import("./runner.mjs");\nexport { createFreshQualifiedReleaseRunnerRuntimeV1 };'), /dynamic import/],
    [Buffer.from('const createFreshQualifiedReleaseRunnerRuntimeV1=()=>require("runner");\nexport { createFreshQualifiedReleaseRunnerRuntimeV1 };'), /require loader/],
    [Buffer.from('const createFreshQualifiedReleaseRunnerRuntimeV1=()=>({}); const extra=1;\nexport { createFreshQualifiedReleaseRunnerRuntimeV1, extra };'), /non-exact export surface/],
  ] as const) {
    assert.throws(() => assertSelfContainedQualifiedReleaseRunnerBundleV1(source), reason);
  }
});

test("qualified release runner exact build rejects a checkout outside the Boundary commit", () => {
  const fixture = packageFixture();
  assert.throws(
    () => buildExactQualifiedReleaseRunnerBundleV1(fixture.repository, "f".repeat(40)),
    /does not equal the Boundary candidate commit/,
  );
});

test("runtime bundle scanner rejects every non-enumerable or external loader surface", () => {
  assert.doesNotThrow(() => assertSelfContainedRuntimeBundleV1(acceptedRuntimeScannerFixture()));
  for (const [source, reason] of [
    [acceptedRuntimeScannerFixture('import "./relative.mjs";'), /node:\* builtin/],
    [acceptedRuntimeScannerFixture('import "bare-package";'), /node:\* builtin/],
    [acceptedRuntimeScannerFixture('import "./native.node";'), /node:\* builtin/],
    [acceptedRuntimeScannerFixture('import { createRequire as cr } from "node:module";'), /node:\* builtin/],
    [acceptedRuntimeScannerFixture('import { Worker as W } from "node:worker_threads";'), /node:\* builtin/],
    [acceptedRuntimeScannerFixture("const r = require;"), /require loader/],
    [acceptedRuntimeScannerFixture('const e = globalThis["eval"];'), /registration primitive/],
    [acceptedRuntimeScannerFixture("const f = Function;"), /forbidden loader primitive/],
    [acceptedRuntimeScannerFixture("", 'await import(user + "data:text/javascript;base64,");'), /exact in-memory data URL/],
    [Buffer.from("const = ;"), /valid JavaScript/],
  ] as const) {
    assert.throws(() => assertSelfContainedRuntimeBundleV1(source), reason);
  }
});

test("launcher scanner binds the one data URL import to verified runtime bytes and hash", () => {
  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const launcher = loadProductionLauncherArtifactV1(repositoryRoot);
  const source = Buffer.from(launcher.bytes).toString("utf8");
  assert.throws(
    () => assertProductionLauncherArtifactV1(Buffer.from(source.replace('from "node:fs"', 'from "./fs.mjs"'))),
    /node:\* builtin/,
  );
  assert.throws(
    () => assertProductionLauncherArtifactV1(Buffer.from(source.replace("Buffer.from(runtime.bytes)", "Buffer.from(unverified.bytes)"))),
    /verified runtime snapshot/,
  );
});

test("verified bundle bytes ignore a later source tree and parent node_modules injection", () => {
  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const bundle = buildProductionRuntimeBundleV1(repositoryRoot);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aloha-bundle-isolation-")));
  const bundlePath = join(root, "verified-bundle.mjs");
  const markerPath = join(root, "attacker-loaded");
  const mutatedBootstrap = join(root, "apps/searcher-runtime/src/release-runtime.ts");
  const attackerPackage = join(root, "node_modules/attacker");
  mkdirSync(join(root, "apps/searcher-runtime/src"), { recursive: true });
  mkdirSync(attackerPackage, { recursive: true });
  writeFileSync(bundlePath, bundle.bytes);
  writeFileSync(mutatedBootstrap, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(markerPath)}, "source");`);
  writeFileSync(join(attackerPackage, "package.json"), JSON.stringify({ name: "attacker", type: "module", main: "index.mjs" }));
  writeFileSync(join(attackerPackage, "index.mjs"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(markerPath)}, "package");`);
  const child = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    'import { readFileSync } from "node:fs"; const bytes=readFileSync(process.argv[1]); const loaded=await import(`data:text/javascript;base64,${bytes.toString("base64")}`); process.stdout.write(JSON.stringify(Object.keys(loaded).sort()));',
    bundlePath,
  ], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NODE_PATH: join(root, "node_modules") },
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, '["issueInstalledProductionStartupCapabilityV1","issuePreReleaseStartupCapabilityV1","startReleaseRuntimeSessionV1"]');
  assert.equal(existsSync(markerPath), false);
});
