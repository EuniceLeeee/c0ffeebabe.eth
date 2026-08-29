import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";

const PACKAGE_MANIFEST = "/etc/aloha/release-package.json";
const PACKAGE_APPROVAL = "/etc/aloha/trust/runtime-release-package-approval.json";
const SIGNER_PIN = "/etc/aloha/trust/runtime-release-signer-pin.json";
const HASH = /^0x[0-9a-f]{64}$/;
const ZERO_HASH = `0x${"0".repeat(64)}`;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const PACKAGE_DOMAIN = "aloha/runtime-release-package/v1";
const APPROVAL_PAYLOAD_DOMAIN = "aloha/runtime-release-package-approval/payload/v1";
const APPROVAL_ID_DOMAIN = "aloha/runtime-release-package-approval/id/v1";
const APPROVAL_SIGNING_DOMAIN = "aloha/runtime-release-package-approval/signing/v1";
const ACCEPTANCE_CERTIFICATE_PAYLOAD_DOMAIN = "aloha.acceptance-certificate/payload/v1";
const ACCEPTANCE_CERTIFICATE_ID_DOMAIN = "aloha.acceptance-certificate/id/v1";
const FORBIDDEN_RUNTIME_ENVIRONMENT_NAMES = Object.freeze([
  "BASH_ENV", "ENV",
  "LD_AUDIT", "LD_DEBUG", "LD_DEBUG_OUTPUT", "LD_LIBRARY_PATH", "LD_PRELOAD", "LD_PROFILE",
  "NODE_EXTRA_CA_CERTS", "NODE_OPTIONS", "NODE_PATH",
  "OPENSSL_CONF", "OPENSSL_ENGINES", "OPENSSL_MODULES",
  "OWNER_PRIVATE_KEY", "PRIVATE_KEY", "SSL_CERT_DIR", "SSL_CERT_FILE",
]);
const ACCEPTANCE_CERTIFICATE_KEYS = Object.freeze([
  "schemaVersion", "kind", "certificateId", "payloadHash", "acceptanceQueryId", "subjectArtifactRoot",
  "claimSetRoot", "observationSetRoot", "rawArtifactSetRoot", "qualificationRegistryRoot",
  "externalTrustAnchorRoot", "externalIssuerKeySetRoot", "qualificationRegistryApprovalId",
  "releaseAuthorityApprovalId", "authorityPinDigest", "qualificationAudienceHash", "releaseRoleManifestRoot",
  "candidateReleaseCommit", "predicateSpecDigest", "predicateProgramDescriptorDigest",
  "oracleProgramDescriptorDigest", "predicateCompositionLeafDigest", "predicateCompositionRootDigest",
  "predicateImplementationClosureDigest", "predicateImplementationExportDigest",
  "oracleImplementationClosureDigest", "oracleImplementationExportDigest", "gateCoreImplementationClosureDigest",
  "gateCoreRuntimeClosureDigest", "verifierQualificationId", "observerQualificationIds",
  "signedInvocationAttestationId", "invocationBindingSetRoot", "reasonSetRoot", "verdict",
]);

const INSTALL_PATHS = Object.freeze({
  "acceptance-certificates.json": "/etc/aloha/acceptance-certificates.json",
  "aloha-searcher.service": "/etc/systemd/system/aloha-searcher.service",
  "catalog-generation.inputs.json": "/etc/aloha/runtime-facts/catalog-generation.inputs.json",
  "candidate-proof-verifier-binding.json": "/etc/aloha/candidate-proof-verifier-binding.json",
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
  "runtime-policy.json": "/etc/aloha/runtime-policy.json",
  "runtime-composition.ts": "/etc/aloha/runtime-facts/runtime-composition.ts",
  "runtime-release-binding.json": "/etc/aloha/runtime-release-binding.json",
  "searcher-deployment.json": "/etc/aloha/searcher-deployment.json",
  "searcher-release.env": "/etc/aloha/searcher-release.env",
  "strategy-catalog.ts": "/etc/aloha/runtime-facts/strategy-catalog.ts",
});

function canonical(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    if (typeof value === "number" && !Number.isSafeInteger(value)) throw new TypeError("non-canonical number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError("non-canonical value");
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function canonicalJson(bytes, label) {
  const text = Buffer.from(bytes).toString("utf8");
  const value = JSON.parse(text);
  if (canonical(value) !== text) throw new TypeError(`${label} is not canonical exact JSON`);
  return value;
}

function sha256(bytes) {
  return `0x${createHash("sha256").update(bytes).digest("hex")}`;
}

function hashDomain(domain, payload) {
  return sha256(Buffer.concat([Buffer.from(domain), Buffer.from([0]), Buffer.from(canonical(payload))]));
}

function assertExactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} has non-exact fields`);
  }
}

function regularSnapshot(path, label) {
  if (!path.startsWith("/") || realpathSync(path) !== path) throw new TypeError(`${label} path is not canonical`);
  const before = statSync(path, { bigint: true });
  if (!lstatSync(path).isFile()) throw new TypeError(`${label} is not a regular file`);
  if (before.uid !== 0n || (before.mode & 0o22n) !== 0n) {
    throw new TypeError(`${label} is not a root-owned immutable artifact`);
  }
  const bytes = new Uint8Array(readFileSync(path));
  const after = statSync(path, { bigint: true });
  for (const field of ["dev", "ino", "size", "mtimeNs", "ctimeNs"]) {
    if (before[field] !== after[field]) throw new TypeError(`${label} changed while it was read`);
  }
  return Object.freeze({ bytes, sha256: sha256(bytes), byteLength: String(bytes.byteLength), fence: Object.freeze({
    dev: String(after.dev), ino: String(after.ino), size: String(after.size), mtimeNs: String(after.mtimeNs), ctimeNs: String(after.ctimeNs),
  }) });
}

function assertCleanRuntimeEnvironment() {
  for (const name of Object.keys(process.env)) {
    if (FORBIDDEN_RUNTIME_ENVIRONMENT_NAMES.includes(name) || name.startsWith("DYLD_") || name.startsWith("GIT_")) {
      throw new TypeError(`forbidden runtime environment ${name}`);
    }
  }
}

function approvalPayload(approval) {
  const fields = [
    "schemaVersion", "kind", "packageRoot", "bindingId", "releaseProvenanceHash",
    "releaseAcceptanceApprovalId", "releaseAcceptanceApprovalPayloadHash",
    "releaseAcceptanceRequirementSetRoot", "releaseAcceptanceSetRoot", "controllerBoundaryEvidenceRoot",
    "candidateReleaseCommit",
    "performanceBasisId", "performanceProfileHash", "hardwareProfileRoot", "providerRoot",
  ];
  const payload = Object.fromEntries(fields.map(field => [field, approval[field]]));
  assertExactKeys(payload, fields, "package approval payload");
  return payload;
}

function verifyPackageApproval(manifest, pin, approval) {
  assertExactKeys(pin, ["signerKeyId", "publicKeyHex"], "runtime signer pin");
  assertExactKeys(approval, [
    "schemaVersion", "kind", "packageRoot", "bindingId", "releaseProvenanceHash",
    "releaseAcceptanceApprovalId", "releaseAcceptanceApprovalPayloadHash",
    "releaseAcceptanceRequirementSetRoot", "releaseAcceptanceSetRoot", "controllerBoundaryEvidenceRoot",
    "candidateReleaseCommit",
    "performanceBasisId", "performanceProfileHash", "hardwareProfileRoot", "providerRoot",
    "payloadHash", "approvalId", "signatureAlgorithm", "signerKeyId", "signatureHex",
  ], "runtime package approval");
  if (!HASH.test(pin.signerKeyId) || !/^0x[0-9a-f]{64}$/.test(pin.publicKeyHex)
    || approval.signerKeyId !== pin.signerKeyId || approval.signatureAlgorithm !== "ed25519"
    || !/^0x[0-9a-f]{128}$/.test(approval.signatureHex)) throw new TypeError("runtime package approval signer is invalid");
  if (approval.controllerBoundaryEvidenceRoot === ZERO_HASH) {
    throw new TypeError("runtime package approval controller boundary evidence root must be non-zero");
  }
  const payload = approvalPayload(approval);
  const payloadHash = hashDomain(APPROVAL_PAYLOAD_DOMAIN, payload);
  const approvalId = hashDomain(APPROVAL_ID_DOMAIN, { payloadHash, signerKeyId: pin.signerKeyId });
  if (approval.payloadHash !== payloadHash || approval.approvalId !== approvalId) throw new TypeError("runtime package approval identity mismatch");
  const signingBytes = Buffer.from(canonical({
    domain: APPROVAL_SIGNING_DOMAIN, version: 1, payloadHash, approvalId, signerKeyId: pin.signerKeyId,
    ...payload, kind: "aloha.runtime-release-package-approval",
  }));
  const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(pin.publicKeyHex.slice(2), "hex")]), format: "der", type: "spki" });
  if (!verifySignature(null, signingBytes, key, Buffer.from(approval.signatureHex.slice(2), "hex"))) {
    throw new TypeError("runtime package approval signature invalid");
  }
  const joins = {
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
  for (const [field, expected] of Object.entries(joins)) if (approval[field] !== expected) throw new TypeError(`runtime package approval mismatch: ${field}`);
}

function verifyAcceptanceDenominator(artifacts, manifest) {
  const certificates = canonicalJson(artifacts["acceptance-certificates.json"].bytes, "acceptance certificates");
  const authority = canonicalJson(artifacts["release-authority-approval.json"].bytes, "release authority approval");
  const set = canonicalJson(artifacts["release-acceptance-set.json"].bytes, "release acceptance set");
  const approval = canonicalJson(artifacts["release-acceptance-approval.json"].bytes, "release acceptance approval");
  const binding = canonicalJson(artifacts["runtime-release-binding.json"].bytes, "runtime release binding");
  if (!Array.isArray(certificates) || certificates.length === 0 || !Array.isArray(set.entries)
    || !Array.isArray(authority.releaseAcceptanceRequirements)
    || certificates.length !== set.entries.length || set.entries.length !== authority.releaseAcceptanceRequirements.length) {
    throw new TypeError("release acceptance denominator is incomplete");
  }
  const certificateById = new Map(certificates.map(certificate => {
    assertExactKeys(certificate, ACCEPTANCE_CERTIFICATE_KEYS, "acceptance certificate");
    const { certificateId, payloadHash, ...payload } = certificate;
    if (certificate.schemaVersion !== 1 || certificate.kind !== "aloha.acceptance-certificate"
      || certificate.verdict !== "pass" || !Array.isArray(certificate.observerQualificationIds)
      || certificate.observerQualificationIds.some((value, index) => !HASH.test(value)
        || (index > 0 && certificate.observerQualificationIds[index - 1] >= value))) {
      throw new TypeError("acceptance certificate shape is invalid");
    }
    const expectedPayloadHash = hashDomain(ACCEPTANCE_CERTIFICATE_PAYLOAD_DOMAIN, payload);
    if (payloadHash !== expectedPayloadHash
      || certificateId !== hashDomain(ACCEPTANCE_CERTIFICATE_ID_DOMAIN, expectedPayloadHash)) {
      throw new TypeError("acceptance certificate identity mismatch");
    }
    return [certificateId, certificate];
  }));
  if (certificateById.size !== certificates.length) throw new TypeError("release acceptance certificate set contains duplicates");
  for (let index = 0; index < set.entries.length; index += 1) {
    const entry = set.entries[index];
    const requirement = authority.releaseAcceptanceRequirements[index];
    assertExactKeys(requirement, [
      "predicateId", "predicateSpecDigest", "predicateCompositionLeafDigest", "authorityPinDigest",
      "verifierCertificateId", "observerCertificateIds", "observerCertificateIdsRoot", "requirementLeafDigest",
    ], "release acceptance requirement");
    assertExactKeys(entry, [
      "predicateId", "predicateSpecDigest", "predicateCompositionLeafDigest", "requirementLeafDigest",
      "acceptanceCertificateId", "acceptanceCertificatePayloadHash", "verdict", "resultLeafDigest",
    ], "release acceptance result");
    const certificate = certificateById.get(entry.acceptanceCertificateId);
    if (certificate === undefined || certificate.verdict !== "pass" || entry.verdict !== "pass"
      || certificate.payloadHash !== entry.acceptanceCertificatePayloadHash
      || entry.predicateId !== requirement.predicateId
      || entry.predicateSpecDigest !== requirement.predicateSpecDigest
      || entry.predicateCompositionLeafDigest !== requirement.predicateCompositionLeafDigest
      || entry.requirementLeafDigest !== requirement.requirementLeafDigest
      || certificate.predicateSpecDigest !== requirement.predicateSpecDigest
      || certificate.predicateCompositionLeafDigest !== requirement.predicateCompositionLeafDigest
      || certificate.releaseAuthorityApprovalId !== authority.approvalId
      || certificate.authorityPinDigest !== requirement.authorityPinDigest
      || certificate.verifierQualificationId !== requirement.verifierCertificateId
      || canonical(certificate.observerQualificationIds) !== canonical(requirement.observerCertificateIds)
      || certificate.externalTrustAnchorRoot !== authority.externalTrustAnchorRoot
      || certificate.externalIssuerKeySetRoot !== authority.issuerKeySetRoot
      || certificate.qualificationRegistryApprovalId !== authority.registryApprovalId
      || certificate.qualificationRegistryRoot !== authority.registryRoot
      || certificate.qualificationAudienceHash !== authority.audienceHash
      || certificate.predicateCompositionRootDigest !== authority.predicateCompositionRootDigest
      || certificate.gateCoreRuntimeClosureDigest !== authority.gateCoreRuntimeClosureDigest
      || certificate.gateCoreImplementationClosureDigest !== authority.gateCoreImplementationClosureDigest
      || certificate.releaseRoleManifestRoot !== authority.releaseRoleManifestRoot
      || certificate.candidateReleaseCommit !== authority.candidateReleaseCommit) {
      throw new TypeError("release acceptance certificate does not join its requirement");
    }
  }
  if (manifest.releaseAcceptanceApprovalId !== approval.approvalId
    || manifest.releaseAcceptanceApprovalPayloadHash !== approval.payloadHash
    || manifest.releaseAcceptanceRequirementSetRoot !== set.releaseAcceptanceRequirementSetRoot
    || manifest.releaseAcceptanceSetRoot !== set.root
    || approval.releaseAcceptanceSetRoot !== set.root
    || approval.releaseAcceptanceRequirementSetRoot !== authority.releaseAcceptanceRequirementSetRoot
    || approval.releaseAuthorityApprovalId !== authority.approvalId
    || approval.releaseAuthorityApprovalPayloadHash !== authority.payloadHash
    || approval.runtimeReleaseBindingId !== binding.bindingId
    || approval.predicateCompositionRootDigest !== binding.predicateCompositionRootDigest
    || approval.gateCoreRuntimeClosureDigest !== binding.gateCoreRuntimeClosureDigest
    || approval.gateCoreImplementationClosureDigest !== binding.gateCoreImplementationClosureDigest
    || approval.releaseRoleManifestRoot !== binding.releaseRoleManifestRoot
    || approval.candidateReleaseCommit !== binding.candidateReleaseCommit
    || binding.releaseAuthorityApprovalId !== authority.approvalId
    || binding.releaseAuthorityApprovalPayloadHash !== authority.payloadHash
    || binding.releaseAcceptanceRequirementSetRoot !== authority.releaseAcceptanceRequirementSetRoot
    || binding.predicateCompositionRootDigest !== authority.predicateCompositionRootDigest
    || binding.gateCoreRuntimeClosureDigest !== authority.gateCoreRuntimeClosureDigest
    || binding.gateCoreImplementationClosureDigest !== authority.gateCoreImplementationClosureDigest
    || binding.releaseRoleManifestRoot !== authority.releaseRoleManifestRoot
    || binding.candidateReleaseCommit !== authority.candidateReleaseCommit) {
    throw new TypeError("release acceptance artifacts do not join one denominator");
  }
}

function preverifyInstalledRelease() {
  assertCleanRuntimeEnvironment();
  if (process.env.SEARCHER_DRY_RUN !== "1") throw new TypeError("runtime dry-run guard requires SEARCHER_DRY_RUN=1");
  if (realpathSync(process.argv[1] ?? "") !== INSTALL_PATHS["production-launcher.mjs"]) {
    throw new TypeError("production launcher process entrypoint is not the installed root-owned artifact");
  }
  const manifestSnapshot = regularSnapshot(PACKAGE_MANIFEST, "release package manifest");
  const manifest = canonicalJson(manifestSnapshot.bytes, "release package manifest");
  const { packageRoot: _packageRoot, ...manifestPayload } = manifest;
  if (manifest.kind !== "aloha.runtime-release-package" || manifest.schemaVersion !== 1
    || manifest.packageRoot !== hashDomain(PACKAGE_DOMAIN, manifestPayload)) throw new TypeError("release package manifest identity mismatch");
  const expectedNames = Object.keys(INSTALL_PATHS).sort();
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== expectedNames.length) throw new TypeError("release package artifact denominator mismatch");
  const artifacts = Object.create(null);
  for (let index = 0; index < expectedNames.length; index += 1) {
    const expectedName = expectedNames[index];
    const artifact = manifest.artifacts[index];
    if (artifact.name !== expectedName || artifact.installPath !== INSTALL_PATHS[expectedName]) throw new TypeError("release package artifact role mismatch");
    const snapshot = regularSnapshot(artifact.installPath, `release artifact ${expectedName}`);
    if (snapshot.sha256 !== artifact.sha256 || snapshot.byteLength !== artifact.byteLength) throw new TypeError(`release artifact mismatch: ${expectedName}`);
    artifacts[expectedName] = snapshot;
  }
  const pinSnapshot = regularSnapshot(SIGNER_PIN, "runtime signer pin");
  if (pinSnapshot.sha256 !== manifest.runtimeSignerPinSha256) throw new TypeError("runtime signer pin hash mismatch");
  const pin = canonicalJson(pinSnapshot.bytes, "runtime signer pin");
  const approvalSnapshot = regularSnapshot(PACKAGE_APPROVAL, "runtime package approval");
  const approval = canonicalJson(approvalSnapshot.bytes, "runtime package approval");
  verifyPackageApproval(manifest, pin, approval);
  verifyAcceptanceDenominator(artifacts, manifest);
  for (const [name, artifact] of Object.entries(artifacts)) {
    const post = regularSnapshot(INSTALL_PATHS[name], `post-fence release artifact ${name}`);
    if (post.sha256 !== artifact.sha256 || post.byteLength !== artifact.byteLength) throw new TypeError(`release artifact changed after verification: ${name}`);
  }
  return Object.freeze({
    manifest, manifestBytes: new Uint8Array(manifestSnapshot.bytes), pin, pinBytes: new Uint8Array(pinSnapshot.bytes),
    approval, approvalBytes: new Uint8Array(approvalSnapshot.bytes), artifacts: Object.freeze(artifacts),
  });
}

async function main() {
  const snapshot = preverifyInstalledRelease();
  const runtime = snapshot.artifacts["deployment-bundle.mjs"];
  const module = await import(`data:text/javascript;base64,${Buffer.from(runtime.bytes).toString("base64")}#${runtime.sha256.slice(2)}`);
  const exports = Object.keys(module).sort();
  if (exports.length !== 3
    || exports[0] !== "issueInstalledProductionStartupCapabilityV1"
    || exports[1] !== "issuePreReleaseStartupCapabilityV1"
    || exports[2] !== "startReleaseRuntimeSessionV1") {
    throw new TypeError("production runtime bundle has a non-exact export surface");
  }
  const capability = module.issueInstalledProductionStartupCapabilityV1(snapshot);
  const service = await module.startReleaseRuntimeSessionV1(capability);
  await service.done;
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
