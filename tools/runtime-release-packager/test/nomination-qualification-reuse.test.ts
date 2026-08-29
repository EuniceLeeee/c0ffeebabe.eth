import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as packager from "../src/index.ts";
import { encodeCanonicalBytes, hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import {
  catalogImpactFamilyProposalOwnershipRootV1,
  createCatalogImpactReceiptV1,
  sealCatalogImpactSnapshotV1,
  type CatalogImpactArtifactFactV1,
} from "../../catalog-generator/src/index.ts";
import { issueFixtureCurrentCatalogImpactAnalysisCapabilityV1 } from "../../catalog-generator/test/fixtures/current-impact-analysis.ts";
import {
  createNominationQualificationDeploymentFactV1,
  createRuntimeReleaseBindingV1,
  createRuntimeReleaseDiscoverySourceQualificationV1,
  hashQualifiedExecutorRegistryEntry,
  hashQualifiedExecutorRegistryRoot,
  hashRuntimeReleaseDiscoveryEndpointLocatorV1,
  nominationQualificationDeploymentFactSigningBytes,
  runtimeReleaseBindingSigningBytes,
  sealRuntimeReleaseNominationQualificationSetV1,
  type NominationQualificationDeploymentFactPayloadV1,
  type RuntimeReleaseBindingPayloadV1,
  type RuntimeReleaseNominationQualificationEntryV1,
} from "../../../specs/release-authority/src/index.ts";
import { generatedEconomicValuationOwnerQualificationSetFixtureV1 } from "../../../specs/release-authority/test/generated-valuation-owner-qualification-fixture.ts";
import { generatedEconomicSafetyActionOwnerQualificationFixtureV1 } from "../../../specs/release-authority/test/generated-action-owner-qualification-fixture.ts";
import { createNominationQualificationReuseConsumerV1 } from "../src/nomination-qualification-reuse.ts";
import { observeProductionNominationQualificationReuseCompositionV1 } from "../src/nomination-qualification-reuse-owner.ts";
import type { NominationQualificationReuseOwnerCompositionV1 } from "../src/internal/nomination-qualification-reuse-owner-state.ts";
import { issueFixtureNominationQualificationReuseOwnerCompositionV1 } from "./fixtures/nomination-qualification-reuse.ts";

const h = (value: string): Hash => hashDomain("test/nomination-qualification-reuse-v2", value);
const emptyDependencyRoot = hashDomain("aloha/requested-capability-closure/v1", []);
const runtimeKeys = generateKeyPairSync("ed25519");
const deploymentKeys = generateKeyPairSync("ed25519");
const attackerKeys = generateKeyPairSync("ed25519");
const runtimeSignerKeyId = h("runtime-signer");
const deploymentSignerKeyId = h("deployment-signer");
const rawKey = (key: typeof runtimeKeys.publicKey) => `0x${key.export({ format: "der", type: "spki" }).subarray(-32).toString("hex")}` as const;
const runtimePin = Object.freeze({ signerKeyId: runtimeSignerKeyId, publicKeyHex: rawKey(runtimeKeys.publicKey) });
const deploymentPin = Object.freeze({ signerKeyId: deploymentSignerKeyId, publicKeyHex: rawKey(deploymentKeys.publicKey) });
const executor = Object.freeze({
  executorKind: "revm", engineBuildFingerprint: h("engine"), executableFingerprint: h("executable"),
  closureFingerprint: h("closure"), protocolFingerprint: h("protocol"), schemaFingerprint: h("schema"),
  releaseRoleManifestRoot: h("manifest"), candidateCommit: "2".repeat(40),
});

function familyArtifact(familyId: string, proposal: Hash, memoVariant = "stable"): CatalogImpactArtifactFactV1 {
  return Object.freeze({
    artifactId: `family:${familyId}`, artifactKind: "family" as const, familyId,
    definitionCatalogLeafDigest: h(`definition:${familyId}`), requestedDependencyClosure: Object.freeze([]),
    requestedDependencyRoot: emptyDependencyRoot, memoRoot: h(`memo:${familyId}:${memoVariant}`),
    nominationProposalLeafDigests: Object.freeze([proposal]),
  });
}

function snapshot(artifacts: readonly CatalogImpactArtifactFactV1[]) {
  return sealCatalogImpactSnapshotV1({
    definitionCatalogRoot: hashDomain("aloha/definition-catalog/v1", artifacts.map(value => value.definitionCatalogLeafDigest).sort()),
    capabilities: [], artifacts,
  });
}

type QualificationInput = Omit<RuntimeReleaseNominationQualificationEntryV1, "qualificationLeafDigest">;
function qualification(proposalLeafDigest: Hash, variant = "stable"): QualificationInput {
  return Object.freeze({
    proposalLeafDigest, criticalMutationCorpusRoot: h(`mutation:${proposalLeafDigest}`),
    independentOracleCaseRoot: h(`oracle:${proposalLeafDigest}`), qualificationSpecDigest: h(`spec:${proposalLeafDigest}`),
    verifierQualificationCertificateRoot: h(`certificate:${proposalLeafDigest}:${variant}`),
  });
}

function signedBinding(
  entries: readonly QualificationInput[],
  epoch: string,
  keys = runtimeKeys,
  signerKeyId = runtimeSignerKeyId,
  qualifiedCapabilityRefsRoot = h("capabilities"),
) {
  const set = sealRuntimeReleaseNominationQualificationSetV1(entries);
  const valuationQualification = generatedEconomicValuationOwnerQualificationSetFixtureV1(`nomination-reuse:${epoch}`);
  const actionOwnerQualification = generatedEconomicSafetyActionOwnerQualificationFixtureV1(`nomination-reuse:${epoch}`);
  const payload: RuntimeReleaseBindingPayloadV1 = {
    schemaVersion: 1, kind: "aloha.runtime-release-binding", releaseAuthorityApprovalId: h(`approval:${epoch}`),
    releaseAuthorityApprovalPayloadHash: h(`approval-payload:${epoch}`), releaseAcceptanceRequirementSetRoot: h("requirements"),
    externalTrustAnchorRoot: h("anchor"), externalIssuerKeySetRoot: h("keys"), qualificationRegistryApprovalId: h(`registry:${epoch}`),
    qualificationRegistryRoot: h("registry-root"), qualificationEpoch: epoch, qualificationAudienceHash: h("audience"),
    predicateCompositionRootDigest: h("composition"), gateCoreRuntimeClosureDigest: h("runtime"), gateCoreImplementationClosureDigest: h("core"),
    searcherRuntime: { runtimeArtifactRoot: h("artifact"), implementationClosureDigest: h("searcher-closure"), nodeExecutableSha256: h("node"), entrypointSha256: h("entrypoint"), bundleModulePath: "/opt/aloha/release.mjs", bundleModuleSha256: h("bundle") },
    discoverySourceQualification: createRuntimeReleaseDiscoverySourceQualificationV1({ providerIdentity: "reth", backendEpoch: "reth-1", profile: "reth-json-rpc-v1", chainId: "1", endpointLocatorHash: hashRuntimeReleaseDiscoveryEndpointLocatorV1("http://127.0.0.1:8545"), qualificationRoot: h("source") }),
    qualifiedExecutorRegistry: [executor], qualifiedExecutorRegistryRoot: hashQualifiedExecutorRegistryRoot([executor]),
    valuationOwnerRegistryRoot: valuationQualification.registry.valuationOwnerRegistryRoot,
    valuationOwnerQualificationCertificates: valuationQualification.certificates,
    qualifiedValuationOwnerSetRoot: valuationQualification.root,
    actionOwnerRegistryRoot: actionOwnerQualification.registry.actionOwnerRegistryRoot,
    actionOwnerQualificationCertificates: actionOwnerQualification.certificates,
    qualifiedActionOwnerSetRoot: actionOwnerQualification.root,
    safetyProfile: actionOwnerQualification.profile,
    safetyProfileRoot: actionOwnerQualification.profileRoot,
    qualifiedCapabilityRefsRoot,
    nominationProgramSetRoot: set.programSetRoot, nominationQualificationSet: set, nominationQualificationSetRoot: set.root,
    selectedExecutorLeafHash: hashQualifiedExecutorRegistryEntry(executor), selectedExecutor: executor,
    releaseRoleManifestRoot: executor.releaseRoleManifestRoot, candidateReleaseCommit: executor.candidateCommit,
    workerEpoch: `worker-${epoch}`, executorSessionHash: h(`session:${epoch}`), frameworkAuthorityRoot: h("framework"),
    executorAuthorityRoot: h("executor-authority"), releaseAuthorityRoot: h("release-authority"),
    attestationProofIssuerKeyId: h("attestation"), candidatePartitionProofIssuerKeyId: h("partition"),
  };
  const signature = `0x${sign(null, Buffer.from(runtimeReleaseBindingSigningBytes(payload, signerKeyId)), keys.privateKey).toString("hex")}` as const;
  return createRuntimeReleaseBindingV1(payload, signerKeyId, signature);
}

function signedDeploymentFact(
  binding: ReturnType<typeof signedBinding>,
  impactSnapshot: ReturnType<typeof snapshot>,
  ledger: Hash,
  output: Hash,
  boundaryVerificationReceiptRoot: Hash,
  keys = deploymentKeys,
  signerKeyId = deploymentSignerKeyId,
) {
  const payload: NominationQualificationDeploymentFactPayloadV1 = {
    schemaVersion: 1, kind: "aloha.nomination-qualification-deployment-fact",
    runtimeBindingId: binding.bindingId, runtimeBindingPayloadHash: binding.payloadHash,
    candidateReleaseCommit: binding.candidateReleaseCommit, catalogImpactSnapshotRoot: impactSnapshot.snapshotRoot,
    catalogFamilyProposalOwnershipRoot: catalogImpactFamilyProposalOwnershipRootV1(impactSnapshot),
    catalogSemanticLedgerHash: ledger, catalogSemanticOutputRoot: output,
    catalogBoundaryVerificationReceiptRoot: boundaryVerificationReceiptRoot,
    catalogProposedCapabilitySetRoot: binding.qualifiedCapabilityRefsRoot,
    nominationProgramSetRoot: binding.nominationProgramSetRoot, nominationQualificationSetRoot: binding.nominationQualificationSetRoot,
  };
  const signature = `0x${sign(null, Buffer.from(nominationQualificationDeploymentFactSigningBytes(payload, signerKeyId)), keys.privateKey).toString("hex")}` as const;
  return createNominationQualificationDeploymentFactV1(payload, signerKeyId, signature);
}

function fixture(options: { readonly changedSwapMemo?: boolean; readonly swappedBoth?: boolean } = {}) {
  const swap = h("proposal:swap");
  const protocol = h("proposal:protocol");
  const lp = h("proposal:lp");
  const originalPrior = snapshot([familyArtifact("protocol", protocol), familyArtifact("swap", swap)]);
  const prior = options.swappedBoth
    ? snapshot([familyArtifact("protocol", swap), familyArtifact("swap", protocol)])
    : originalPrior;
  const current = options.swappedBoth
    ? prior
    : snapshot([familyArtifact("lp", lp), familyArtifact("protocol", protocol), familyArtifact("swap", swap, options.changedSwapMemo ? "changed" : "stable")]);
  const receipt = createCatalogImpactReceiptV1({ pinnedBeforeSnapshotRoot: prior.snapshotRoot, before: prior, after: current });
  const ledger = h("current-ledger");
  const output = h("current-output");
  const boundaryVerificationReceiptRoot = h("boundary-verification");
  const proposedCapabilitySetRoot = h("capabilities");
  const capability = issueFixtureCurrentCatalogImpactAnalysisCapabilityV1({
    priorSnapshot: prior, currentSnapshot: current, impactReceipt: receipt,
    semanticLedgerHash: ledger, semanticOutputRoot: output, proposedCapabilitySetRoot,
    verificationReceiptRoot: boundaryVerificationReceiptRoot,
  });
  const priorBinding = signedBinding([qualification(swap), qualification(protocol)], "prior", runtimeKeys, runtimeSignerKeyId, proposedCapabilitySetRoot);
  const priorFact = signedDeploymentFact(priorBinding, originalPrior, h("prior-ledger"), h("prior-output"), h("prior-boundary-verification"));
  return { swap, protocol, lp, prior, current, receipt, ledger, output, proposedCapabilitySetRoot, boundaryVerificationReceiptRoot, capability, priorBinding, priorFact };
}

function consumer(value: ReturnType<typeof fixture>) {
  return createNominationQualificationReuseConsumerV1(issueFixtureNominationQualificationReuseOwnerCompositionV1({
    currentCatalogImpact: value.capability, priorRuntimeBinding: value.priorBinding, priorDeploymentFact: value.priorFact,
    priorRuntimeSignerPin: runtimePin, currentRuntimeSignerPin: runtimePin,
    priorDeploymentFactSignerPin: deploymentPin, currentDeploymentFactSignerPin: deploymentPin,
  }));
}

test("pre-sign reuses 100% of unrelated existing Families and puts the unsigned new proposal in the denominator", () => {
  const value = fixture();
  const owner = consumer(value);
  const report = owner.analyzePreSign();
  assert.deepEqual(report.reusedFamilies.map(item => item.familyId), ["protocol", "swap"]);
  assert.deepEqual(report.requalificationDenominator.map(item => item.familyId), ["lp"]);
  assert.equal(report.requalificationDenominator[0]!.nominationProposalLeafDigests[0], value.lp);
  const currentBinding = signedBinding([qualification(value.swap), qualification(value.protocol), qualification(value.lp)], "current");
  const currentFact = signedDeploymentFact(currentBinding, value.current, value.ledger, value.output, value.boundaryVerificationReceiptRoot);
  assert.equal(owner.verifyPostSign({ currentRuntimeBinding: currentBinding, currentDeploymentFact: currentFact }).verifiedQualificationEntryCount, 3);
});

test("the same proposal with changed memo semantics must requalify before signing", () => {
  const report = consumer(fixture({ changedSwapMemo: true })).analyzePreSign();
  assert.deepEqual(report.reusedFamilies.map(item => item.familyId), ["protocol"]);
  assert.deepEqual(report.requalificationDenominator.map(item => item.familyId), ["lp", "swap"]);
});

test("two self-consistent swapped snapshots cannot replace the externally deployed prior ownership", () => {
  assert.throws(() => consumer(fixture({ swappedBoth: true })), /does not join the owner-observed catalog/);
});

test("a structural fake current A-prime capability retaining old Families is unavailable", () => {
  const value = fixture();
  assert.throws(() => createNominationQualificationReuseConsumerV1({
    currentCatalogImpact: Object.freeze({}) as never, priorRuntimeBinding: value.priorBinding, priorDeploymentFact: value.priorFact,
    priorRuntimeSignerPin: runtimePin, currentRuntimeSignerPin: runtimePin,
    priorDeploymentFactSignerPin: deploymentPin, currentDeploymentFactSignerPin: deploymentPin,
  } as unknown as NominationQualificationReuseOwnerCompositionV1), /not release-owner-issued/);
});

test("owner registration deep-decodes signed coordinates before retaining process-local provenance", () => {
  const value = fixture();
  const currentBindingValue = signedBinding([
    qualification(value.swap), qualification(value.protocol), qualification(value.lp),
  ], "current-deep-copy");
  const currentFactValue = signedDeploymentFact(
    currentBindingValue,
    value.current,
    value.ledger,
    value.output,
    value.boundaryVerificationReceiptRoot,
  );
  const priorBinding = structuredClone(value.priorBinding);
  const priorFact = structuredClone(value.priorFact);
  const currentBinding = structuredClone(currentBindingValue);
  const currentFact = structuredClone(currentFactValue);
  const composition = issueFixtureNominationQualificationReuseOwnerCompositionV1({
    currentCatalogImpact: value.capability,
    priorRuntimeBinding: priorBinding,
    priorDeploymentFact: priorFact,
    currentRuntimeBinding: currentBinding,
    currentDeploymentFact: currentFact,
    priorRuntimeSignerPin: structuredClone(runtimePin),
    currentRuntimeSignerPin: structuredClone(runtimePin),
    priorDeploymentFactSignerPin: structuredClone(deploymentPin),
    currentDeploymentFactSignerPin: structuredClone(deploymentPin),
  });
  Object.assign(priorBinding.nominationQualificationSet.entries[0]!, { verifierQualificationCertificateRoot: h("mutated-prior-entry") });
  Object.assign(priorFact, { catalogImpactSnapshotRoot: h("mutated-prior-fact") });
  Object.assign(currentBinding.nominationQualificationSet.entries[0]!, { verifierQualificationCertificateRoot: h("mutated-current-entry") });
  Object.assign(currentFact, { catalogImpactSnapshotRoot: h("mutated-current-fact") });
  const owner = createNominationQualificationReuseConsumerV1(composition);
  assert.equal(owner.analyzePreSign().reusedFamilies.length, 2);
  assert.equal(owner.verifyPostSign({
    currentRuntimeBinding: currentBindingValue,
    currentDeploymentFact: currentFactValue,
  }).verifiedQualificationEntryCount, 3);
});

test("caller pin replacement plus a rerooted current deployment fact cannot pass post-sign", () => {
  const value = fixture();
  const owner = consumer(value);
  const currentBinding = signedBinding([qualification(value.swap), qualification(value.protocol), qualification(value.lp)], "current-attacker");
  const attackerFact = signedDeploymentFact(currentBinding, value.current, value.ledger, value.output, value.boundaryVerificationReceiptRoot, attackerKeys, h("attacker-signer"));
  assert.throws(() => owner.verifyPostSign({ currentRuntimeBinding: currentBinding, currentDeploymentFact: attackerFact }), /signer pin mismatch/);
});

test("post-sign rejects a changed entry that pre-sign classified as reused", () => {
  const value = fixture();
  const owner = consumer(value);
  const currentBinding = signedBinding([qualification(value.swap, "changed"), qualification(value.protocol), qualification(value.lp)], "changed-reuse");
  const currentFact = signedDeploymentFact(currentBinding, value.current, value.ledger, value.output, value.boundaryVerificationReceiptRoot);
  assert.throws(() => owner.verifyPostSign({ currentRuntimeBinding: currentBinding, currentDeploymentFact: currentFact }), /reused qualification entry changed/);
});

test("K1 to K2 runtime signer rotation is unavailable even when both releases are self-consistently signed", () => {
  const value = fixture();
  const attackerRuntimeSignerKeyId = h("attacker-runtime-signer");
  const attackerDeploymentSignerKeyId = h("attacker-deployment-signer");
  const attackerRuntimePin = Object.freeze({ signerKeyId: attackerRuntimeSignerKeyId, publicKeyHex: rawKey(attackerKeys.publicKey) });
  const attackerDeploymentPin = Object.freeze({ signerKeyId: attackerDeploymentSignerKeyId, publicKeyHex: rawKey(attackerKeys.publicKey) });
  const attackerCurrentBinding = signedBinding(
    [qualification(value.swap), qualification(value.protocol), qualification(value.lp)],
    "attacker-current",
    attackerKeys,
    attackerRuntimeSignerKeyId,
    value.proposedCapabilitySetRoot,
  );
  const attackerCurrentFact = signedDeploymentFact(
    attackerCurrentBinding,
    value.current,
    value.ledger,
    value.output,
    value.boundaryVerificationReceiptRoot,
    attackerKeys,
    attackerDeploymentSignerKeyId,
  );
  assert.throws(() => issueFixtureNominationQualificationReuseOwnerCompositionV1({
    currentCatalogImpact: value.capability,
    priorRuntimeBinding: value.priorBinding,
    priorDeploymentFact: value.priorFact,
    currentRuntimeBinding: attackerCurrentBinding,
    currentDeploymentFact: attackerCurrentFact,
    priorRuntimeSignerPin: runtimePin,
    currentRuntimeSignerPin: attackerRuntimePin,
    priorDeploymentFactSignerPin: deploymentPin,
    currentDeploymentFactSignerPin: attackerDeploymentPin,
  }), /runtime signer pin continuity mismatch/);
});

test("runtime signer pin continuity rejects extra fields instead of comparing a caller-selected identity subset", () => {
  const value = fixture();
  assert.throws(() => issueFixtureNominationQualificationReuseOwnerCompositionV1({
    currentCatalogImpact: value.capability,
    priorRuntimeBinding: value.priorBinding,
    priorDeploymentFact: value.priorFact,
    priorRuntimeSignerPin: runtimePin,
    currentRuntimeSignerPin: { ...runtimePin, unverifiedAlias: runtimeSignerKeyId } as never,
    priorDeploymentFactSignerPin: deploymentPin,
    currentDeploymentFactSignerPin: deploymentPin,
  }), /unknown field "unverifiedAlias"/);
});

test("production observer admits K1 to K1 and makes K1 to K2 unavailable through fixed installed paths", () => {
  const value = fixture();
  const root = mkdtempSync(join(tmpdir(), "aloha-nomination-reuse-production-"));
  const installed = join(root, "installed");
  mkdirSync(installed);
  writeFileSync(join(installed, "runtime-release-binding.json"), encodeCanonicalBytes(value.priorBinding));
  writeFileSync(join(installed, "nomination-qualification-deployment-fact.json"), encodeCanonicalBytes(value.priorFact));
  writeFileSync(join(installed, "runtime-release-signer-pin.json"), encodeCanonicalBytes(runtimePin));
  writeFileSync(join(root, "current-catalog-state.json"), encodeCanonicalBytes({
    priorSnapshot: value.prior,
    currentSnapshot: value.current,
    impactReceipt: value.receipt,
    semanticLedgerHash: value.ledger,
    semanticOutputRoot: value.output,
    proposedCapabilitySetRoot: value.proposedCapabilitySetRoot,
    verificationReceiptRoot: value.boundaryVerificationReceiptRoot,
  }));

  const writeCase = (
    name: string,
    binding: ReturnType<typeof signedBinding>,
    fact: ReturnType<typeof signedDeploymentFact>,
    pin: typeof runtimePin,
  ): void => {
    const directory = join(root, name);
    mkdirSync(directory);
    writeFileSync(join(directory, "runtime-release-binding.json"), encodeCanonicalBytes(binding));
    writeFileSync(join(directory, "nomination-qualification-deployment-fact.json"), encodeCanonicalBytes(fact));
    writeFileSync(join(directory, "runtime-release-signer-pin.json"), encodeCanonicalBytes(pin));
    writeFileSync(join(directory, "qualified-runner-wire.json"), encodeCanonicalBytes({
      boundary: {}, runtimeBinding: binding, runtimeSignerPin: pin,
      externalQualifications: [], predicateMaterials: [],
    }));
  };

  writeCase("k1", value.priorBinding, value.priorFact, runtimePin);
  const k2SignerKeyId = h("production-path-k2-runtime-signer");
  const k2DeploymentSignerKeyId = h("production-path-k2-deployment-signer");
  const k2Pin = Object.freeze({ signerKeyId: k2SignerKeyId, publicKeyHex: rawKey(attackerKeys.publicKey) });
  const k2Binding = signedBinding(
    [qualification(value.swap), qualification(value.protocol), qualification(value.lp)],
    "production-path-k2",
    attackerKeys,
    k2SignerKeyId,
    value.proposedCapabilitySetRoot,
  );
  const k2Fact = signedDeploymentFact(
    k2Binding,
    value.current,
    value.ledger,
    value.output,
    value.boundaryVerificationReceiptRoot,
    attackerKeys,
    k2DeploymentSignerKeyId,
  );
  writeCase("k2", k2Binding, k2Fact, k2Pin);

  try {
    const child = spawnSync(process.execPath, [
      "--experimental-strip-types",
      new URL("./fixtures/nomination-qualification-reuse-production.mjs", import.meta.url).pathname,
    ], {
      cwd: new URL("../../..", import.meta.url).pathname,
      env: { ...process.env, ALOHA_NOMINATION_REUSE_TEST_ROOT: root },
      encoding: "utf8",
      timeout: 600_000,
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    assert.deepEqual(JSON.parse(child.stdout), ["available", "unavailable"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("post-sign joins the runtime capability root and Boundary receipt to the current catalog", () => {
  const value = fixture();
  const owner = consumer(value);
  const wrongCapabilityBinding = signedBinding(
    [qualification(value.swap), qualification(value.protocol), qualification(value.lp)],
    "wrong-capability-root",
    runtimeKeys,
    runtimeSignerKeyId,
    h("wrong-capability-root"),
  );
  const wrongCapabilityFact = signedDeploymentFact(
    wrongCapabilityBinding,
    value.current,
    value.ledger,
    value.output,
    value.boundaryVerificationReceiptRoot,
  );
  assert.throws(
    () => owner.verifyPostSign({ currentRuntimeBinding: wrongCapabilityBinding, currentDeploymentFact: wrongCapabilityFact }),
    /does not join the owner-observed catalog/,
  );

  const currentBinding = signedBinding([qualification(value.swap), qualification(value.protocol), qualification(value.lp)], "wrong-boundary-root");
  const wrongBoundaryFact = signedDeploymentFact(currentBinding, value.current, value.ledger, value.output, h("wrong-boundary-root"));
  assert.throws(
    () => owner.verifyPostSign({ currentRuntimeBinding: currentBinding, currentDeploymentFact: wrongBoundaryFact }),
    /does not join the owner-observed catalog/,
  );
});

test("production reuse remains typed unavailable and the packager root exports no configurable factory", () => {
  assert.deepEqual(observeProductionNominationQualificationReuseCompositionV1(Object.freeze({})), {
    status: "unavailable",
    code: "verified-release-authority-composition-unavailable",
    advisoryOnly: true,
  });
  assert.equal("createNominationQualificationReuseConsumerV1" in packager, false);
  const root = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const ownerSource = readFileSync(new URL("../src/nomination-qualification-reuse-owner.ts", import.meta.url), "utf8");
  assert.doesNotMatch(root, /createNominationQualificationReuseConsumerV1|CreateNominationQualificationReuseConsumerInputV1/);
  assert.doesNotMatch(root, /registerNominationQualificationReuseOwnerCompositionV1|nomination-qualification-reuse-owner-state/);
  assert.match(ownerSource, /observeProductionNominationQualificationReuseCompositionV1\(\s*capability: PreReleaseAdvisoryMaterialCapabilityV1/);
  assert.match(ownerSource, /arguments\.length !== 1/);
  assert.match(ownerSource, /const INSTALLED_RUNTIME_BINDING_PATH = "\/etc\/aloha\/runtime-release-binding\.json"/);
  assert.match(ownerSource, /const INSTALLED_DEPLOYMENT_FACT_PATH = "\/etc\/aloha\/nomination-qualification-deployment-fact\.json"/);
  assert.match(ownerSource, /readPreReleaseAdvisoryMaterialV1\(capability\)/);
  assert.match(ownerSource, /Buffer\.from\(priorSignerPinBytes\)\.equals\(Buffer\.from\(currentSignerPinBytes\)\)/);
  assert.doesNotMatch(ownerSource, /createNominationQualificationDeploymentFactV1|generateKeyPair|privateKey|sign\(/);
});
