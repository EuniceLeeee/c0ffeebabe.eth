import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  writeSync,
} from "node:fs";

const ROOT = "/var/lib/aloha/pre-release";
const AUTHORIZATION = `${ROOT}/authorization.json`;
const PIN = `${ROOT}/artifacts/runtime-release-signer-pin.json`;
const QUALIFICATION_FINAL_TERMINAL_READY = `${ROOT}/runtime/qualification-final-terminal-ready.json`;
const ARTIFACT_PATHS = Object.freeze({
  "aloha-searcher-pre-release.service": "/run/systemd/system/aloha-searcher-pre-release.service",
  "candidate-proof-verifier-binding.json": `${ROOT}/artifacts/candidate-proof-verifier-binding.json`,
  "catalog-generation.inputs.json": `${ROOT}/artifacts/runtime-facts/catalog-generation.inputs.json`,
  "deployment-bundle.mjs": `${ROOT}/artifacts/deployment-bundle.mjs`,
  "deployment-composition.mjs": `${ROOT}/artifacts/deployment-composition.mjs`,
  "deployment-source.json": `${ROOT}/artifacts/deployment-source.json`,
  "executor-state.json": `${ROOT}/artifacts/executor-state.json`,
  "family-catalog.ts": `${ROOT}/artifacts/runtime-facts/family-catalog.ts`,
  "nomination-qualification-deployment-fact.json": `${ROOT}/artifacts/nomination-qualification-deployment-fact.json`,
  "performance-profile.json": `${ROOT}/artifacts/performance-profile.json`,
  "qualified-release-runner-input.json": `${ROOT}/artifacts/qualified-release-runner-input.json`,
  "release-authority-approval.json": `${ROOT}/artifacts/release-authority-approval.json`,
  "release-intent.json": `${ROOT}/artifacts/release-intent.json`,
  "runtime-policy.json": `${ROOT}/artifacts/runtime-policy.json`,
  "runtime-boundary-projection.json": `${ROOT}/artifacts/runtime-boundary-projection.json`,
  "runtime-composition.ts": `${ROOT}/artifacts/runtime-facts/runtime-composition.ts`,
  "runtime-release-binding.json": `${ROOT}/artifacts/runtime-release-binding.json`,
  "runtime-release-signer-pin.json": PIN,
  "searcher-pre-release.env": `${ROOT}/artifacts/searcher-pre-release.env`,
  "staging-manifest.json": `${ROOT}/artifacts/staging-manifest.json`,
  "strategy-catalog.ts": `${ROOT}/artifacts/runtime-facts/strategy-catalog.ts`,
  "pre-release-owner.mjs": `${ROOT}/artifacts/pre-release-owner.mjs`,
  "production-launcher.mjs": `${ROOT}/artifacts/production-launcher.mjs`,
});
const ARTIFACT_NAMES = Object.freeze([
  "aloha-searcher-pre-release.service",
  "candidate-proof-verifier-binding.json",
  "catalog-generation.inputs.json",
  "deployment-bundle.mjs",
  "deployment-composition.mjs",
  "deployment-source.json",
  "executor-state.json",
  "family-catalog.ts",
  "nomination-qualification-deployment-fact.json",
  "performance-profile.json",
  "qualified-release-runner-input.json",
  "release-authority-approval.json",
  "release-intent.json",
  "runtime-policy.json",
  "runtime-boundary-projection.json",
  "runtime-composition.ts",
  "runtime-release-binding.json",
  "runtime-release-signer-pin.json",
  "searcher-pre-release.env",
  "staging-manifest.json",
  "strategy-catalog.ts",
  "pre-release-owner.mjs",
  "production-launcher.mjs",
]);
const EXPORTS = Object.freeze([
  "issueInstalledProductionStartupCapabilityV1",
  "issuePreReleaseStartupCapabilityV1",
  "startReleaseRuntimeSessionV1",
]);
const EXPORT_ROOT_DOMAIN = "aloha/pre-release-runtime-export-surface/v1";
const ARTIFACT_SET_DOMAIN = "aloha/pre-release-staging-artifact-set/v1";
const MANIFEST_ROOT_DOMAIN = "aloha/pre-release-staging-manifest/root/v1";
const AUTHORIZATION_PAYLOAD_DOMAIN = "aloha/pre-release-launch-authorization/payload/v1";
const AUTHORIZATION_ID_DOMAIN = "aloha/pre-release-launch-authorization/id/v1";
const AUTHORIZATION_SIGNING_DOMAIN = "aloha/pre-release-launch-authorization/signing/v1";
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

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

function exactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} has non-exact fields`);
  }
}

function regularSnapshot(path, label) {
  if (realpathSync(path) !== path || !lstatSync(path).isFile()) throw new TypeError(`${label} is not a canonical regular file`);
  const before = statSync(path, { bigint: true });
  if (before.uid !== 0n || (before.mode & 0o22n) !== 0n) throw new TypeError(`${label} is not root-owned immutable material`);
  const bytes = new Uint8Array(readFileSync(path));
  const after = statSync(path, { bigint: true });
  for (const field of ["dev", "ino", "size", "mtimeNs", "ctimeNs"]) {
    if (before[field] !== after[field]) throw new TypeError(`${label} changed while read`);
  }
  return Object.freeze({
    bytes,
    sha256: sha256(bytes),
    byteLength: String(bytes.byteLength),
    fence: Object.freeze({
      dev: String(after.dev),
      ino: String(after.ino),
      size: String(after.size),
      mtimeNs: String(after.mtimeNs),
      ctimeNs: String(after.ctimeNs),
    }),
  });
}

function assertCleanEnvironment() {
  if (process.env.SEARCHER_DRY_RUN !== "1") throw new TypeError("pre-release owner requires dry-run mode");
  for (const name of Object.keys(process.env)) {
    if (["BASH_ENV", "ENV", "NODE_OPTIONS", "NODE_PATH", "OWNER_PRIVATE_KEY", "PRIVATE_KEY"].includes(name)
      || name.startsWith("DYLD_") || name.startsWith("GIT_") || name.startsWith("LD_")) {
      throw new TypeError(`forbidden pre-release environment ${name}`);
    }
  }
  if (realpathSync(process.argv[1] ?? "") !== ARTIFACT_PATHS["pre-release-owner.mjs"]) {
    throw new TypeError("pre-release owner entrypoint path mismatch");
  }
}

function verifyAuthorization(authorization, pin, manifest, stagingArtifactSetRoot, stagingManifestRoot) {
  exactKeys(pin, ["publicKeyHex", "signerKeyId"], "runtime signer pin");
  const signatureFields = ["payloadHash", "authorizationId", "signatureAlgorithm", "signerKeyId", "signatureHex"];
  const payload = Object.fromEntries(Object.entries(authorization).filter(([key]) => !signatureFields.includes(key)));
  const payloadHash = hashDomain(AUTHORIZATION_PAYLOAD_DOMAIN, payload);
  const authorizationId = hashDomain(AUTHORIZATION_ID_DOMAIN, { payloadHash, signerKeyId: authorization.signerKeyId });
  const probe = authorization.roundRole === "restart-probe";
  const permissions = authorization.permissions;
  if (authorization.phase !== "pre-release" || authorization.kind !== "aloha.pre-release-launch-authorization"
    || authorization.dryRun !== true
    || (authorization.roundRole !== "restart-probe" && authorization.roundRole !== "qualification-final")
    || (probe ? authorization.predecessor !== null : authorization.predecessor === null)
    || authorization.allowedTerminal !== (probe ? "restart-probe-drained" : "qualification-facts-observed")
    || permissions === null || typeof permissions !== "object"
    || permissions.runRuntime !== true || permissions.emitRestartMarker !== probe
    || permissions.sign !== false || permissions.broadcast !== false || permissions.promote !== false
    || authorization.stagingArtifactSetRoot !== stagingArtifactSetRoot
    || authorization.stagingManifestRoot !== stagingManifestRoot
    || authorization.controllerBoundaryEvidenceRoot !== manifest.controllerBoundaryEvidenceRoot
    || authorization.runtimeExportSurfaceRoot !== hashDomain(EXPORT_ROOT_DOMAIN, EXPORTS)
    || authorization.payloadHash !== payloadHash || authorization.authorizationId !== authorizationId
    || authorization.signatureAlgorithm !== "ed25519" || authorization.signerKeyId !== pin.signerKeyId
    || BigInt(authorization.issuedAtUnixNs) >= BigInt(authorization.expiresAtUnixNs)
    || BigInt(Date.now()) * 1_000_000n < BigInt(authorization.issuedAtUnixNs)
    || BigInt(Date.now()) * 1_000_000n >= BigInt(authorization.expiresAtUnixNs)) {
    throw new TypeError("pre-release launch authorization does not join the staged round");
  }
  const signing = {
    domain: AUTHORIZATION_SIGNING_DOMAIN,
    version: 1,
    ...payload,
    payloadHash,
    authorizationId,
    signatureAlgorithm: "ed25519",
    signerKeyId: authorization.signerKeyId,
  };
  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(pin.publicKeyHex.slice(2), "hex")]),
    format: "der",
    type: "spki",
  });
  if (!verifySignature(null, Buffer.from(canonical(signing)), key, Buffer.from(authorization.signatureHex.slice(2), "hex"))) {
    throw new TypeError("pre-release launch authorization signature invalid");
  }
}

function preverifyRound() {
  assertCleanEnvironment();
  const snapshots = Object.create(null);
  for (const name of ARTIFACT_NAMES) {
    snapshots[name] = regularSnapshot(ARTIFACT_PATHS[name], `pre-release artifact ${name}`);
  }
  const manifestSnapshot = snapshots["staging-manifest.json"];
  const manifest = canonicalJson(manifestSnapshot.bytes, "pre-release staging manifest");
  if (manifest.phase !== "pre-release" || manifest.kind !== "aloha.pre-release-staging-manifest"
    || manifest.launcherPath !== ARTIFACT_PATHS["pre-release-owner.mjs"]
    || manifest.productionLauncherPath !== ARTIFACT_PATHS["production-launcher.mjs"]
    || manifest.catalogGenerationInputPath !== ARTIFACT_PATHS["catalog-generation.inputs.json"]
    || manifest.familyCatalogSourcePath !== ARTIFACT_PATHS["family-catalog.ts"]
    || manifest.nominationQualificationDeploymentFactPath !== ARTIFACT_PATHS["nomination-qualification-deployment-fact.json"]
    || manifest.runtimeCompositionSourcePath !== ARTIFACT_PATHS["runtime-composition.ts"]
    || manifest.strategyCatalogSourcePath !== ARTIFACT_PATHS["strategy-catalog.ts"]
    || manifest.searcherRuntimeNodeExecutableSha256 === undefined
    || manifest.searcherRuntimeArtifactRoot === undefined
    || manifest.searcherRuntimeImplementationClosureDigest === undefined
    || manifest.controllerBoundaryEvidenceRoot === undefined
    || manifest.performanceProfilePath !== ARTIFACT_PATHS["performance-profile.json"]
    || manifest.runtimeBoundaryProjectionPath !== ARTIFACT_PATHS["runtime-boundary-projection.json"]
    || manifest.launcherSha256 !== snapshots["pre-release-owner.mjs"].sha256
    || manifest.productionLauncherSha256 !== snapshots["production-launcher.mjs"].sha256
    || manifest.performanceProfileSha256 !== snapshots["performance-profile.json"].sha256
    || manifest.runtimeBoundaryProjectionSha256 !== snapshots["runtime-boundary-projection.json"].sha256
    || manifest.catalogGenerationInputSha256 !== snapshots["catalog-generation.inputs.json"].sha256
    || manifest.familyCatalogSourceSha256 !== snapshots["family-catalog.ts"].sha256
    || manifest.nominationQualificationDeploymentFactSha256 !== snapshots["nomination-qualification-deployment-fact.json"].sha256
    || manifest.runtimeCompositionSourceSha256 !== snapshots["runtime-composition.ts"].sha256
    || manifest.strategyCatalogSourceSha256 !== snapshots["strategy-catalog.ts"].sha256
    || manifest.deploymentBundleSha256 !== snapshots["deployment-bundle.mjs"].sha256
    || manifest.runtimeExportSurfaceRoot !== hashDomain(EXPORT_ROOT_DOMAIN, EXPORTS)) {
    throw new TypeError("pre-release staging manifest fixed binding mismatch");
  }
  const identities = ARTIFACT_NAMES.map(name => ({
    name,
    installPath: ARTIFACT_PATHS[name],
    contentSha256: snapshots[name].sha256,
    byteLength: snapshots[name].byteLength,
  }));
  const stagingArtifactSetRoot = hashDomain(ARTIFACT_SET_DOMAIN, identities);
  const stagingManifestRoot = hashDomain(MANIFEST_ROOT_DOMAIN, {
    contentSha256: manifestSnapshot.sha256,
    byteLength: manifestSnapshot.byteLength,
  });
  const authorizationSnapshot = regularSnapshot(AUTHORIZATION, "pre-release authorization");
  const authorization = canonicalJson(authorizationSnapshot.bytes, "pre-release authorization");
  const pin = canonicalJson(snapshots["runtime-release-signer-pin.json"].bytes, "runtime signer pin");
  verifyAuthorization(authorization, pin, manifest, stagingArtifactSetRoot, stagingManifestRoot);
  return Object.freeze({ snapshots: Object.freeze(snapshots), authorizationSnapshot });
}

function publishQualificationFinalTerminalReady(authorization) {
  const payload = Object.freeze({
    schemaVersion: 1,
    kind: "aloha.pre-release-qualification-final-terminal-ready-locator",
    authorizationId: authorization.authorizationId,
    pid: String(process.pid),
  });
  const bytes = Buffer.from(canonical(payload));
  const descriptor = openSync(
    QUALIFICATION_FINAL_TERMINAL_READY,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
    0o444,
  );
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = writeSync(descriptor, bytes, offset, bytes.byteLength - offset, null);
      if (written <= 0) throw new TypeError("qualification-final terminal-ready locator short write");
      offset += written;
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  const directory = openSync(`${ROOT}/runtime`, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try { fsyncSync(directory); } finally { closeSync(directory); }
  if (realpathSync(QUALIFICATION_FINAL_TERMINAL_READY) !== QUALIFICATION_FINAL_TERMINAL_READY
    || !lstatSync(QUALIFICATION_FINAL_TERMINAL_READY).isFile()) {
    throw new TypeError("qualification-final terminal-ready locator is not a canonical regular file");
  }
  const before = statSync(QUALIFICATION_FINAL_TERMINAL_READY, { bigint: true });
  const observed = new Uint8Array(readFileSync(QUALIFICATION_FINAL_TERMINAL_READY));
  const after = statSync(QUALIFICATION_FINAL_TERMINAL_READY, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
    || after.size !== BigInt(observed.byteLength)
    || sha256(observed) !== sha256(bytes) || observed.byteLength !== bytes.byteLength) {
    throw new TypeError("qualification-final terminal-ready locator changed after publication");
  }
}

async function holdQualificationFinalUntilSignal(authorization) {
  if (authorization.roundRole !== "qualification-final") return;
  const release = new Promise(resolve => process.once("SIGTERM", resolve));
  publishQualificationFinalTerminalReady(authorization);
  await release;
}

async function main() {
  const round = preverifyRound();
  const authorization = canonicalJson(round.authorizationSnapshot.bytes, "pre-release authorization");
  const startupSnapshot = Object.freeze({
    snapshots: round.snapshots,
    authorizationSnapshot: round.authorizationSnapshot,
  });
  const runtime = round.snapshots["deployment-bundle.mjs"];
  const module = await import(`data:text/javascript;base64,${Buffer.from(runtime.bytes).toString("base64")}#${runtime.sha256.slice(2)}`);
  const names = Object.keys(module).sort();
  if (names.length !== EXPORTS.length || names.some((name, index) => name !== EXPORTS[index])) {
    throw new TypeError("pre-release runtime bundle has a non-exact export surface");
  }
  const capability = module.issuePreReleaseStartupCapabilityV1(startupSnapshot);
  const session = await module.startReleaseRuntimeSessionV1(capability);
  await session.done;
  await holdQualificationFinalUntilSignal(authorization);
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
