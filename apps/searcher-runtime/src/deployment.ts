import { readFileSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import {
  assertExactKeys,
  decodeCanonicalJson,
  decodeExactObject,
  deepFreeze,
  encodeCanonicalBytes,
  gitSha40Schema,
  hashDomain,
  hashSchema,
  nonEmptyStringSchema,
  sha256Hex,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import type {
  StartupRuntimeV1,
} from "../../../packages/startup-runtime/src/index.ts";
import {
  decodeRuntimeReleaseBindingV1,
  runtimeReleaseBindingProvenanceHash,
  type RuntimeReleaseBindingV1,
} from "../../../specs/release-authority/src/index.ts";
import {
  startReleaseSearcherStartup,
  type ReleaseSearcherStartupOwnerV1,
} from "./index.ts";
import {
  assertIssuedSearcherRuntimeApplicationOwnerV1,
  type SearcherRuntimeApplicationOwnerV1,
  type SearcherRuntimeApplicationV1,
} from "./internal/application-owner.ts";
import { assertIssuedRuntimeReleaseSearcherStartupService } from "../../../packages/runtime-release-authority/src/searcher-startup-consumer.ts";
import type { DeploymentCompositionCapabilityV1 } from "../../../packages/runtime-release-authority/src/internal/deployment-composition-owner.ts";

const MANIFEST_DOMAIN = "aloha/searcher-deployment-manifest/v1";
const ZERO_HASH = `0x${"0".repeat(64)}` as Hash;
const ZERO_COMMIT = "0".repeat(40);

/**
 * This is a deployment-side fact envelope, not a release authority.  Its
 * bytes are supplied by the deployment bundle and are checked before any
 * startup capability is used.  The release binding identity is joined to
 * the owner-issued startup port; it is never reconstructed here.
 */
export interface DeploymentManifestV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.searcher-deployment-manifest";
  readonly manifestHash: Hash;
  readonly bindingId: Hash;
  readonly releaseProvenanceHash: Hash;
  readonly candidateReleaseCommit: `${string}`;
  readonly searcherRuntimeArtifactRoot: Hash;
  readonly searcherRuntimeImplementationClosureDigest: Hash;
  readonly searcherRuntimeNodeExecutableSha256: Hash;
  readonly searcherRuntimeEntrypointSha256: Hash;
  readonly searcherRuntimeBundleModulePath: string;
  readonly searcherRuntimeBundleModuleSha256: Hash;
  readonly deploymentCompositionModulePath: string;
  readonly deploymentCompositionModuleSha256: Hash;
  readonly deploymentSourceConfigPath: string;
  readonly deploymentSourceConfigSha256: Hash;
  readonly deploymentRuntimePolicyPath: string;
  readonly deploymentRuntimePolicySha256: Hash;
  readonly deploymentExecutorStatePath: string;
  readonly deploymentExecutorStateSha256: Hash;
  readonly releaseIntentPath: string;
  readonly releaseIntentSha256: Hash;
  readonly candidateProofVerifierBindingPath: string;
  readonly candidateProofVerifierBindingSha256: Hash;
  readonly processCommandSha256: Hash;
  readonly serviceName: string;
  readonly systemdUnit: string;
  readonly systemdUnitPath: string;
  readonly systemdUnitSha256: Hash;
  readonly releaseEnvironmentPath: string;
  readonly releaseEnvironmentSha256: Hash;
  readonly logPath: string;
  readonly dryRun: true;
}

interface DeploymentManifestPayloadV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.searcher-deployment-manifest";
  readonly bindingId: Hash;
  readonly releaseProvenanceHash: Hash;
  readonly candidateReleaseCommit: `${string}`;
  readonly searcherRuntimeArtifactRoot: Hash;
  readonly searcherRuntimeImplementationClosureDigest: Hash;
  readonly searcherRuntimeNodeExecutableSha256: Hash;
  readonly searcherRuntimeEntrypointSha256: Hash;
  readonly searcherRuntimeBundleModulePath: string;
  readonly searcherRuntimeBundleModuleSha256: Hash;
  readonly deploymentCompositionModulePath: string;
  readonly deploymentCompositionModuleSha256: Hash;
  readonly deploymentSourceConfigPath: string;
  readonly deploymentSourceConfigSha256: Hash;
  readonly deploymentRuntimePolicyPath: string;
  readonly deploymentRuntimePolicySha256: Hash;
  readonly deploymentExecutorStatePath: string;
  readonly deploymentExecutorStateSha256: Hash;
  readonly releaseIntentPath: string;
  readonly releaseIntentSha256: Hash;
  readonly candidateProofVerifierBindingPath: string;
  readonly candidateProofVerifierBindingSha256: Hash;
  readonly processCommandSha256: Hash;
  readonly serviceName: string;
  readonly systemdUnit: string;
  readonly systemdUnitPath: string;
  readonly systemdUnitSha256: Hash;
  readonly releaseEnvironmentPath: string;
  readonly releaseEnvironmentSha256: Hash;
  readonly logPath: string;
  readonly dryRun: true;
}

function decimal(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new TypeError(`expected canonical decimal at ${path}`);
  }
  return value;
}

function absolutePath(value: unknown, path: string): string {
  const decoded = nonEmptyStringSchema.decode(value, path);
  if (!decoded.startsWith("/")) throw new TypeError(`expected absolute path at ${path}`);
  return decoded;
}

function decodeManifestPayload(value: unknown, path = "$"): DeploymentManifestPayloadV1 {
  return decodeExactObject(value, {
    schemaVersion: (item, fieldPath) => {
      if (item !== 1) throw new TypeError(`unsupported deployment manifest schema at ${fieldPath}`);
      return 1 as const;
    },
    kind: (item, fieldPath) => {
      if (item !== "aloha.searcher-deployment-manifest") throw new TypeError(`invalid deployment manifest kind at ${fieldPath}`);
      return "aloha.searcher-deployment-manifest" as const;
    },
    bindingId: (item, fieldPath) => hashSchema.decode(item, fieldPath),
    releaseProvenanceHash: (item, fieldPath) => hashSchema.decode(item, fieldPath),
    candidateReleaseCommit: (item, fieldPath) => gitSha40Schema.decode(item, fieldPath),
    searcherRuntimeArtifactRoot: (item, fieldPath) => hashSchema.decode(item, fieldPath),
    searcherRuntimeImplementationClosureDigest: (item, fieldPath) => hashSchema.decode(item, fieldPath),
    searcherRuntimeNodeExecutableSha256: (item, fieldPath) => hashSchema.decode(item, fieldPath),
    searcherRuntimeEntrypointSha256: (item, fieldPath) => hashSchema.decode(item, fieldPath),
    searcherRuntimeBundleModulePath: (item, fieldPath) => absolutePath(item, fieldPath),
    searcherRuntimeBundleModuleSha256: (item, fieldPath) => hashSchema.decode(item, fieldPath),
    deploymentCompositionModulePath: (item, fieldPath) => absolutePath(item, fieldPath),
    deploymentCompositionModuleSha256: (item, fieldPath) => hashSchema.decode(item, fieldPath),
    deploymentSourceConfigPath: (item, fieldPath) => absolutePath(item, fieldPath),
    deploymentSourceConfigSha256: (item, fieldPath) => hashSchema.decode(item, fieldPath),
    deploymentRuntimePolicyPath: (item, fieldPath) => absolutePath(item, fieldPath),
    deploymentRuntimePolicySha256: (item, fieldPath) => hashSchema.decode(item, fieldPath),
    deploymentExecutorStatePath: (item, fieldPath) => absolutePath(item, fieldPath),
    deploymentExecutorStateSha256: (item, fieldPath) => hashSchema.decode(item, fieldPath),
    releaseIntentPath: (item, fieldPath) => absolutePath(item, fieldPath),
    releaseIntentSha256: (item, fieldPath) => hashSchema.decode(item, fieldPath),
    candidateProofVerifierBindingPath: (item, fieldPath) => absolutePath(item, fieldPath),
    candidateProofVerifierBindingSha256: (item, fieldPath) => hashSchema.decode(item, fieldPath),
    processCommandSha256: (item, fieldPath) => hashSchema.decode(item, fieldPath),
    serviceName: (item, fieldPath) => nonEmptyStringSchema.decode(item, fieldPath),
    systemdUnit: (item, fieldPath) => nonEmptyStringSchema.decode(item, fieldPath),
    systemdUnitPath: (item, fieldPath) => absolutePath(item, fieldPath),
    systemdUnitSha256: (item, fieldPath) => hashSchema.decode(item, fieldPath),
    releaseEnvironmentPath: (item, fieldPath) => absolutePath(item, fieldPath),
    releaseEnvironmentSha256: (item, fieldPath) => hashSchema.decode(item, fieldPath),
    logPath: (item, fieldPath) => absolutePath(item, fieldPath),
    dryRun: (item, fieldPath) => {
      if (item !== true) throw new TypeError(`deployment must be dry-run at ${fieldPath}`);
      return true as const;
    },
  }, path);
}

function manifestHash(payload: DeploymentManifestPayloadV1): Hash {
  return hashDomain(MANIFEST_DOMAIN, payload);
}

/** Decode and verify the exact manifest envelope and its self-commitment. */
export function decodeDeploymentManifestV1(value: unknown): DeploymentManifestV1 {
  const decoded = decodeExactObject(value, {
    schemaVersion: (item, path) => {
      if (item !== 1) throw new TypeError(`unsupported deployment manifest schema at ${path}`);
      return 1 as const;
    },
    kind: (item, path) => {
      if (item !== "aloha.searcher-deployment-manifest") throw new TypeError(`invalid deployment manifest kind at ${path}`);
      return "aloha.searcher-deployment-manifest" as const;
    },
    manifestHash: (item, path) => hashSchema.decode(item, path),
    bindingId: (item, path) => hashSchema.decode(item, path),
    releaseProvenanceHash: (item, path) => hashSchema.decode(item, path),
    candidateReleaseCommit: (item, path) => gitSha40Schema.decode(item, path),
    searcherRuntimeArtifactRoot: (item, path) => hashSchema.decode(item, path),
    searcherRuntimeImplementationClosureDigest: (item, path) => hashSchema.decode(item, path),
    searcherRuntimeNodeExecutableSha256: (item, path) => hashSchema.decode(item, path),
    searcherRuntimeEntrypointSha256: (item, path) => hashSchema.decode(item, path),
    searcherRuntimeBundleModulePath: (item, path) => absolutePath(item, path),
    searcherRuntimeBundleModuleSha256: (item, path) => hashSchema.decode(item, path),
    deploymentCompositionModulePath: (item, path) => absolutePath(item, path),
    deploymentCompositionModuleSha256: (item, path) => hashSchema.decode(item, path),
    deploymentSourceConfigPath: (item, path) => absolutePath(item, path),
    deploymentSourceConfigSha256: (item, path) => hashSchema.decode(item, path),
    deploymentRuntimePolicyPath: (item, path) => absolutePath(item, path),
    deploymentRuntimePolicySha256: (item, path) => hashSchema.decode(item, path),
    deploymentExecutorStatePath: (item, path) => absolutePath(item, path),
    deploymentExecutorStateSha256: (item, path) => hashSchema.decode(item, path),
    releaseIntentPath: (item, path) => absolutePath(item, path),
    releaseIntentSha256: (item, path) => hashSchema.decode(item, path),
    candidateProofVerifierBindingPath: (item, path) => absolutePath(item, path),
    candidateProofVerifierBindingSha256: (item, path) => hashSchema.decode(item, path),
    processCommandSha256: (item, path) => hashSchema.decode(item, path),
    serviceName: (item, path) => nonEmptyStringSchema.decode(item, path),
    systemdUnit: (item, path) => nonEmptyStringSchema.decode(item, path),
    systemdUnitPath: (item, path) => absolutePath(item, path),
    systemdUnitSha256: (item, path) => hashSchema.decode(item, path),
    releaseEnvironmentPath: (item, path) => absolutePath(item, path),
    releaseEnvironmentSha256: (item, path) => hashSchema.decode(item, path),
    logPath: (item, path) => absolutePath(item, path),
    dryRun: (item, path) => {
      if (item !== true) throw new TypeError(`deployment must be dry-run at ${path}`);
      return true as const;
    },
  });
  if (decoded.manifestHash === ZERO_HASH) throw new TypeError("deployment manifest hash is zero");
  if (decoded.bindingId === ZERO_HASH || decoded.releaseProvenanceHash === ZERO_HASH) {
    throw new TypeError("deployment release identity is zero");
  }
  if (decoded.candidateReleaseCommit === ZERO_COMMIT) throw new TypeError("deployment commit is zero");
  const { manifestHash: _ignored, ...payload } = decoded;
  const expected = manifestHash(payload);
  if (decoded.manifestHash !== expected) throw new TypeError("deployment manifest hash mismatch");
  return deepFreeze(decoded);
}

/** Build canonical manifest bytes for deployment packaging/tests. */
export function encodeDeploymentManifestV1(value: DeploymentManifestPayloadV1): Uint8Array {
  const payload = decodeManifestPayload(value);
  return encodeCanonicalBytes({ ...payload, manifestHash: manifestHash(payload) });
}

export function deploymentManifestHashV1(value: DeploymentManifestV1): Hash {
  const decoded = decodeDeploymentManifestV1(value);
  return decoded.manifestHash;
}

export interface RuntimeAnchorObservationV1 {
  readonly candidateReleaseCommit: `${string}`;
  /** Hash of the actual searcher entrypoint loaded by Node. */
  readonly entrypointSha256: Hash;
  /** Hash of the actual Node executable running the process. */
  readonly nodeExecutableSha256: Hash;
  /** Canonical real path and bytes of the deployment code actually imported. */
  readonly bundleModulePath: string;
  readonly bundleModuleSha256: Hash;
  /** SHA-256 of the exact NUL-separated argv observed through /proc. */
  readonly processCommandSha256: Hash;
  /** SHA-256 of the raw manifest artifact bytes, not its semantic hash. */
  readonly manifestArtifactSha256: Hash;
  readonly serviceName: string;
  readonly systemdUnit: string;
  readonly systemdUnitPath: string;
  readonly systemdUnitSha256: Hash;
  readonly releaseEnvironmentPath: string;
  readonly releaseEnvironmentSha256: Hash;
  readonly bootId: string;
  readonly invocationId: string;
  readonly logDevice: string;
  readonly logInode: string;
  readonly pid: string;
  readonly processStartTicks: string;
  readonly dryRun: true;
}

export interface RuntimeAnchorObserverV1 {
  observe(input: {
    readonly manifestPath: string;
    /** The exact bytes decoded and admitted by the deployment shell. */
    readonly manifestBytes: Uint8Array;
    readonly logPath: string;
    readonly bundleModulePath: string;
    readonly systemdUnitPath: string;
    readonly releaseEnvironmentPath: string;
    readonly executablePath?: string;
  }): RuntimeAnchorObservationV1 | Promise<RuntimeAnchorObservationV1>;
}

export interface RuntimeAnchorReceiptV1 {
  readonly kind: "aloha.searcher-runtime-anchor-v1";
  readonly bindingId: Hash;
  readonly releaseProvenanceHash: Hash;
  /** Semantic manifest identity from the decoded manifest. */
  readonly manifestHash: Hash;
  /** Raw artifact identity from the independently observed manifest bytes. */
  readonly manifestArtifactSha256: Hash;
  readonly runtimeArtifactRoot: Hash;
  readonly implementationClosureDigest: Hash;
  readonly candidateReleaseCommit: `${string}`;
  readonly entrypointSha256: Hash;
  readonly nodeExecutableSha256: Hash;
  readonly bundleModulePath: string;
  readonly bundleModuleSha256: Hash;
  readonly serviceName: string;
  readonly systemdUnit: string;
  readonly bootId: string;
  readonly invocationId: string;
  readonly logDevice: string;
  readonly logInode: string;
  readonly pid: string;
  readonly processStartTicks: string;
  readonly dryRun: true;
}

export function runtimeAnchorReceiptV1(
  manifest: DeploymentManifestV1,
  anchors: RuntimeAnchorObservationV1,
  manifestBytes: Uint8Array,
): RuntimeAnchorReceiptV1 {
  assertRuntimeAnchorsV1(manifest, anchors, manifest.logPath, manifestBytes);
  return deepFreeze({
    kind: "aloha.searcher-runtime-anchor-v1",
    manifestHash: manifest.manifestHash,
    manifestArtifactSha256: anchors.manifestArtifactSha256,
    bindingId: manifest.bindingId,
    releaseProvenanceHash: manifest.releaseProvenanceHash,
    candidateReleaseCommit: anchors.candidateReleaseCommit,
    runtimeArtifactRoot: manifest.searcherRuntimeArtifactRoot,
    implementationClosureDigest: manifest.searcherRuntimeImplementationClosureDigest,
    entrypointSha256: anchors.entrypointSha256,
    nodeExecutableSha256: anchors.nodeExecutableSha256,
    bundleModulePath: anchors.bundleModulePath,
    bundleModuleSha256: anchors.bundleModuleSha256,
    serviceName: anchors.serviceName,
    systemdUnit: anchors.systemdUnit,
    bootId: anchors.bootId,
    invocationId: anchors.invocationId,
    logDevice: anchors.logDevice,
    logInode: anchors.logInode,
    pid: anchors.pid,
    processStartTicks: anchors.processStartTicks,
    dryRun: true as const,
  });
}

export function encodeRuntimeAnchorReceiptV1(
  manifest: DeploymentManifestV1,
  anchors: RuntimeAnchorObservationV1,
  manifestBytes: Uint8Array,
): Uint8Array {
  return encodeCanonicalBytes(runtimeAnchorReceiptV1(manifest, anchors, manifestBytes));
}

function readProcessStartTicks(pid: string): string {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const close = stat.lastIndexOf(")");
  if (close < 0) throw new TypeError("process stat is malformed");
  const fields = stat.slice(close + 2).trim().split(/\s+/);
  // The suffix begins at field 3 (state), so field 22 is index 19.
  return decimal(fields[19], "processStartTicks");
}

function readSystemdUnit(): string {
  const cgroup = readFileSync("/proc/self/cgroup", "utf8");
  const candidates = cgroup.split("\n").flatMap(line => {
    const tail = line.slice(line.lastIndexOf(":") + 1);
    return tail.split("/").filter(value => value.endsWith(".service"));
  });
  const unit = candidates.at(-1);
  if (!unit) throw new TypeError("systemd service anchor is unavailable");
  return unit;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new TypeError(`missing runtime anchor ${name}`);
  return value;
}

/**
 * Observe host facts without trusting a caller-provided pid, boot id, or
 * executable path.  The strict service profile intentionally fails outside a
 * systemd-like host; tests use an injected observer instead.
 */
export const systemRuntimeAnchorObserverV1: RuntimeAnchorObserverV1 = Object.freeze({
  observe(input: {
    readonly manifestPath: string;
    readonly manifestBytes: Uint8Array;
    readonly logPath: string;
    readonly bundleModulePath: string;
    readonly systemdUnitPath: string;
    readonly releaseEnvironmentPath: string;
    readonly executablePath?: string;
  }) {
    const pid = String(process.pid);
    const entrypointPath = realpathSync(input.executablePath ?? process.argv[1] ?? "");
    const entrypointSha256 = sha256Hex(readFileSync(entrypointPath));
    const nodeExecutableSha256 = sha256Hex(readFileSync(realpathSync(process.execPath)));
    const bundleModulePath = realpathSync(input.bundleModulePath);
    const bundleModuleSha256 = sha256Hex(readFileSync(bundleModulePath));
    const systemdUnitPath = realpathSync(input.systemdUnitPath);
    if (systemdUnitPath !== input.systemdUnitPath) throw new TypeError("systemd unit path is not canonical");
    const releaseEnvironmentPath = realpathSync(input.releaseEnvironmentPath);
    if (releaseEnvironmentPath !== input.releaseEnvironmentPath) throw new TypeError("release environment path is not canonical");
    const processCommandSha256 = sha256Hex(readFileSync(`/proc/${pid}/cmdline`));
    const manifestArtifactSha256 = sha256Hex(readFileSync(input.manifestPath));
    const log = statSync(input.logPath);
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const systemdUnit = readSystemdUnit();
    const dryRun = process.env.SEARCHER_DRY_RUN;
    if (dryRun !== "1") throw new TypeError("runtime dry-run guard is not enabled");
    return deepFreeze({
      candidateReleaseCommit: gitSha40Schema.decode(requiredEnv("SEARCHER_RUNTIME_COMMIT")),
      entrypointSha256,
      nodeExecutableSha256,
      bundleModulePath,
      bundleModuleSha256,
      processCommandSha256,
      manifestArtifactSha256,
      serviceName: requiredEnv("SEARCHER_RUNTIME_SERVICE_NAME"),
      systemdUnit,
      systemdUnitPath,
      systemdUnitSha256: sha256Hex(readFileSync(systemdUnitPath)),
      releaseEnvironmentPath,
      releaseEnvironmentSha256: sha256Hex(readFileSync(releaseEnvironmentPath)),
      bootId: nonEmptyStringSchema.decode(bootId),
      invocationId: requiredEnv("INVOCATION_ID"),
      logDevice: String(log.dev),
      logInode: String(log.ino),
      pid,
      processStartTicks: readProcessStartTicks(pid),
      dryRun: true as const,
    });
  },
});
function exactAnchorKeys(value: RuntimeAnchorObservationV1): void {
  const keys = Reflect.ownKeys(value);
  const expected = [
    "candidateReleaseCommit", "entrypointSha256", "nodeExecutableSha256", "bundleModulePath", "bundleModuleSha256", "processCommandSha256", "manifestArtifactSha256", "serviceName",
    "systemdUnit", "systemdUnitPath", "systemdUnitSha256", "releaseEnvironmentPath", "releaseEnvironmentSha256", "bootId", "invocationId", "logDevice", "logInode", "pid",
    "processStartTicks", "dryRun",
  ];
  if (keys.length !== expected.length || expected.some(key => !keys.includes(key))) {
    throw new TypeError("runtime anchor observation has non-exact fields");
  }
}

/** Compare every independently observed runtime anchor to the frozen manifest. */
export function assertRuntimeAnchorsV1(
  manifest: DeploymentManifestV1,
  observed: RuntimeAnchorObservationV1,
  manifestPath: string,
  manifestBytes: Uint8Array,
): void {
  exactAnchorKeys(observed);
  if (!(manifestBytes instanceof Uint8Array)) throw new TypeError("manifest artifact bytes are required");
  if (observed.dryRun !== true || manifest.dryRun !== true) throw new TypeError("runtime is not fixed dry-run");
  const expectedPath = resolve(manifest.logPath);
  if (expectedPath !== manifest.logPath) throw new TypeError("log path is not canonical");
  const checks: readonly [string, unknown, unknown][] = [
    ["candidate commit", observed.candidateReleaseCommit, manifest.candidateReleaseCommit],
    ["entrypoint hash", observed.entrypointSha256, manifest.searcherRuntimeEntrypointSha256],
    ["node executable hash", observed.nodeExecutableSha256, manifest.searcherRuntimeNodeExecutableSha256],
    ["bundle module path", observed.bundleModulePath, manifest.searcherRuntimeBundleModulePath],
    ["bundle module hash", observed.bundleModuleSha256, manifest.searcherRuntimeBundleModuleSha256],
    ["process command hash", observed.processCommandSha256, manifest.processCommandSha256],
    ["manifest artifact hash", observed.manifestArtifactSha256, sha256Hex(manifestBytes)],
    ["service name", observed.serviceName, manifest.serviceName],
    ["systemd unit", observed.systemdUnit, manifest.systemdUnit],
    ["systemd unit path", observed.systemdUnitPath, manifest.systemdUnitPath],
    ["systemd unit hash", observed.systemdUnitSha256, manifest.systemdUnitSha256],
    ["release environment path", observed.releaseEnvironmentPath, manifest.releaseEnvironmentPath],
    ["release environment hash", observed.releaseEnvironmentSha256, manifest.releaseEnvironmentSha256],
  ];
  for (const [name, actual, expected] of checks) {
    if (actual !== expected) throw new TypeError(`runtime ${name} anchor mismatch`);
  }
  nonEmptyStringSchema.decode(observed.bootId, "runtime boot id");
  nonEmptyStringSchema.decode(observed.invocationId, "runtime invocation id");
  decimal(observed.logDevice, "runtime log device");
  decimal(observed.logInode, "runtime log inode");
  if (observed.pid !== String(Number(observed.pid)) || !/^[1-9][0-9]*$/.test(observed.pid)) {
    throw new TypeError("runtime pid anchor is invalid");
  }
  decimal(observed.processStartTicks, "runtime process start anchor");
  if (manifestPath.length === 0 || !manifestPath.startsWith("/")) {
    throw new TypeError("deployment manifest path must be absolute");
  }
}

/**
 * The deployment shell accepts identity and owner-issued startup only. It
 * deliberately has no executable callback: the static producer loop must be
 * compiled into the candidate application, not supplied by a deployment
 * module.
 */
export interface DeploymentRuntimeBundleV1 {
  readonly startupOwner: ReleaseSearcherStartupOwnerV1;
  /** Static application owner; no loader-supplied runner/callback is accepted. */
  readonly application: SearcherRuntimeApplicationOwnerV1;
  readonly release: DeploymentBundleReleaseIdentityV1;
}

export interface DeploymentBundleReleaseIdentityV1 {
  /** Exact binding bytes/shape issued by the external release packager. */
  readonly binding: RuntimeReleaseBindingV1;
  /** Hash of the exact manifest bytes admitted by the loader. */
  readonly manifestHash: Hash;
}

export interface DeploymentBundleLoaderV1 {
  load(input: {
    readonly manifest: DeploymentManifestV1;
    readonly manifestBytes: Uint8Array;
    readonly anchors: RuntimeAnchorObservationV1;
  }): Promise<DeploymentRuntimeBundleV1>;
}

/**
 * Execute only the exact release-bound bundle bytes. Importing a data URL
 * prevents a path replacement between verification and evaluation; relative
 * module loads are intentionally unavailable at this boundary.
 */
export async function loadVerifiedDeploymentBundleModuleV1(
  manifest: DeploymentManifestV1,
  rawPath: string,
): Promise<DeploymentBundleLoaderV1> {
  const bundleModulePath = absolutePath(rawPath, "deploymentBundle.modulePath");
  if (bundleModulePath !== manifest.searcherRuntimeBundleModulePath) {
    throw new TypeError("deployment bundle module path does not match the manifest");
  }
  const bundleModuleRealPath = realpathSync(bundleModulePath);
  if (bundleModuleRealPath !== bundleModulePath) throw new TypeError("deployment bundle module path is not canonical");
  const bundleModuleBytes = new Uint8Array(readFileSync(bundleModuleRealPath));
  if (sha256Hex(bundleModuleBytes) !== manifest.searcherRuntimeBundleModuleSha256) {
    throw new TypeError("deployment bundle module hash mismatch before import");
  }
  const moduleValue = await import(
    `data:text/javascript;base64,${Buffer.from(bundleModuleBytes).toString("base64")}#${manifest.searcherRuntimeBundleModuleSha256.slice(2)}`
  );
  const exports = Object.keys(moduleValue);
  if (exports.length !== 1 || exports[0] !== "loadDeploymentBundle") {
    throw new TypeError("deployment bundle module must expose only loadDeploymentBundle");
  }
  const loader = moduleValue.loadDeploymentBundle;
  if (loader === null || typeof loader !== "object" || Array.isArray(loader)) {
    throw new TypeError("deployment bundle module loadDeploymentBundle is invalid");
  }
  const loaderKeys = Reflect.ownKeys(loader);
  if (loaderKeys.length !== 1 || loaderKeys[0] !== "load" || typeof loader.load !== "function") {
    throw new TypeError("deployment bundle loader must expose only load()");
  }
  return loader as DeploymentBundleLoaderV1;
}

/**
 * Load the package-approved composition bytes without a path/evaluation race.
 * The capability itself is subsequently consumed by the candidate-owned
 * deployment composition owner, which rejects structural objects and clones.
 */
export async function loadVerifiedDeploymentCompositionModuleV1(
  manifestValue: DeploymentManifestV1,
): Promise<DeploymentCompositionCapabilityV1> {
  const manifest = decodeDeploymentManifestV1(manifestValue);
  const modulePath = absolutePath(
    manifest.deploymentCompositionModulePath,
    "deploymentComposition.modulePath",
  );
  const realPath = realpathSync(modulePath);
  if (realPath !== modulePath || !statSync(realPath).isFile()) {
    throw new TypeError("deployment composition module is not a canonical regular file");
  }
  const bytes = new Uint8Array(readFileSync(realPath));
  return loadVerifiedDeploymentCompositionBytesV1(manifest, bytes);
}

/** Evaluate only the package-launcher snapshot; production never reopens executable module bytes. */
export async function loadVerifiedDeploymentCompositionBytesV1(
  manifestValue: DeploymentManifestV1,
  bytesValue: Uint8Array,
): Promise<DeploymentCompositionCapabilityV1> {
  const manifest = decodeDeploymentManifestV1(manifestValue);
  return loadVerifiedDeploymentCompositionSnapshotV1(
    manifest.deploymentCompositionModuleSha256,
    bytesValue,
  );
}

/** Phase-neutral in-memory evaluator. The phase owner must first join the
 * expected digest to its own signed manifest; this function never accepts a
 * path or an alternate-path compatibility rule. */
export async function loadVerifiedDeploymentCompositionSnapshotV1(
  expectedSha256: Hash,
  bytesValue: Uint8Array,
): Promise<DeploymentCompositionCapabilityV1> {
  const manifest = Object.freeze({
    deploymentCompositionModuleSha256: hashSchema.decode(
      expectedSha256,
      "deploymentComposition.expectedSha256",
    ),
  });
  if (!(bytesValue instanceof Uint8Array)) {
    throw new TypeError("deployment composition snapshot bytes are required");
  }
  const bytes = new Uint8Array(bytesValue);
  if (sha256Hex(bytes) !== manifest.deploymentCompositionModuleSha256) {
    throw new TypeError("deployment composition snapshot hash mismatch before import");
  }
  const moduleValue = await import(
    `data:text/javascript;base64,${Buffer.from(bytes).toString("base64")}#${manifest.deploymentCompositionModuleSha256.slice(2)}`
  );
  const exports = Object.keys(moduleValue);
  if (exports.length !== 1 || exports[0] !== "deploymentComposition") {
    throw new TypeError("deployment composition module must expose only deploymentComposition");
  }
  return moduleValue.deploymentComposition as DeploymentCompositionCapabilityV1;
}

type DeploymentBundleReleaseV1 = DeploymentBundleReleaseIdentityV1;

export interface DryRunServiceHandleV1 {
  readonly anchors: RuntimeAnchorObservationV1;
  readonly startup: StartupRuntimeV1;
  readonly application: SearcherRuntimeApplicationV1;
  readonly done: Promise<void>;
  stop(): Promise<void>;
}

export function assertDeploymentRuntimeBundleV1(value: unknown): asserts value is DeploymentRuntimeBundleV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("deployment runtime bundle is required");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 3 || !keys.includes("startupOwner") || !keys.includes("application") || !keys.includes("release")) {
    throw new TypeError("deployment runtime bundle has non-exact fields");
  }
  const bundle = value as Record<string, unknown>;
  assertIssuedRuntimeReleaseSearcherStartupService(bundle.startupOwner);
  assertIssuedSearcherRuntimeApplicationOwnerV1(bundle.application);
  if (bundle.release === null || typeof bundle.release !== "object") {
    throw new TypeError("deployment release identity is required");
  }
  decodeDeploymentBundleReleaseV1(bundle.release);
}

function decodeDeploymentBundleReleaseV1(value: unknown): DeploymentBundleReleaseV1 {
  return decodeExactObject(value, {
    binding: (item, path) => decodeRuntimeReleaseBindingV1(item as object),
    manifestHash: (item, path) => hashSchema.decode(item, path),
  });
}

/** Join the external deployment identity to the owner-issued release port. */
export function assertDeploymentBundleIdentityV1(
  manifest: DeploymentManifestV1,
  owner: ReleaseSearcherStartupOwnerV1,
  releaseValue: unknown,
): asserts releaseValue is DeploymentBundleReleaseIdentityV1 {
  if (owner === null || typeof owner !== "object" || owner.release === null || typeof owner.release !== "object") {
    throw new TypeError("deployment startup owner identity is required");
  }
  const release = decodeDeploymentBundleReleaseV1(releaseValue);
  const binding = release.binding;
  const provenanceHash = runtimeReleaseBindingProvenanceHash(binding);
  if (owner.release.bindingId !== binding.bindingId
    || owner.release.releaseProvenanceHash !== provenanceHash
    || owner.release.candidateReleaseCommit !== binding.candidateReleaseCommit) {
    throw new TypeError("deployment owner release identity mismatch");
  }
  if (binding.bindingId !== manifest.bindingId
    || provenanceHash !== manifest.releaseProvenanceHash
    || binding.candidateReleaseCommit !== manifest.candidateReleaseCommit
    || binding.searcherRuntime.runtimeArtifactRoot !== manifest.searcherRuntimeArtifactRoot
    || binding.searcherRuntime.implementationClosureDigest !== manifest.searcherRuntimeImplementationClosureDigest
    || binding.searcherRuntime.nodeExecutableSha256 !== manifest.searcherRuntimeNodeExecutableSha256
    || binding.searcherRuntime.entrypointSha256 !== manifest.searcherRuntimeEntrypointSha256
    || binding.searcherRuntime.bundleModulePath !== manifest.searcherRuntimeBundleModulePath
    || binding.searcherRuntime.bundleModuleSha256 !== manifest.searcherRuntimeBundleModuleSha256
    || release.manifestHash !== manifest.manifestHash) {
    throw new TypeError("deployment bundle release binding mismatch");
  }
}

function assertFixedDryRunEnvironment(): void {
  if (process.env.SEARCHER_DRY_RUN !== "1") throw new TypeError("runtime dry-run guard requires SEARCHER_DRY_RUN=1");
  for (const name of ["NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "PRIVATE_KEY", "OWNER_PRIVATE_KEY"]) {
    if (process.env[name] !== undefined) throw new TypeError(`forbidden runtime environment ${name}`);
  }
}

/** The package-owned entry is the only production process; this CLI remains local-only. */
function physicalPathWithExistingAncestor(path: string): string {
  let cursor = resolve(path);
  const suffix: string[] = [];
  while (true) {
    try {
      return resolve(realpathSync(cursor), ...suffix);
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) return resolve(path);
      suffix.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

function isInstalledProductionPath(path: string): boolean {
  if (!path.startsWith("/")) throw new TypeError("direct searcher CLI paths must be absolute");
  const installedRoot = physicalPathWithExistingAncestor("/etc/aloha");
  const candidate = physicalPathWithExistingAncestor(path);
  return candidate === installedRoot || candidate.startsWith(`${installedRoot}/`);
}

export function assertDirectCliNonProductionV1(input: Readonly<{
  readonly manifestPath: string;
  readonly bundleModulePath: string;
}>): void {
  assertExactKeys(input, ["manifestPath", "bundleModulePath"], "direct CLI deployment paths");
  if (isInstalledProductionPath(input.manifestPath)
    || isInstalledProductionPath(input.bundleModulePath)
    || process.env.INVOCATION_ID !== undefined) {
    throw new TypeError("direct searcher CLI is not a production entrypoint");
  }
}

/**
 * Start the one dry-run service.  The loader is the deployment boundary: it
 * may return only an owner-issued startup port and release identity.  No raw
 * binding, key, executable runner, or authority constructor enters this
 * function.
 */
export async function startDryRunServiceV1(input: {
  readonly manifestPath: string;
  readonly bundleModulePath: string;
  readonly signal?: AbortSignal;
}): Promise<DryRunServiceHandleV1> {
  const inputKeys = ["manifestPath", "bundleModulePath"];
  if (Object.prototype.hasOwnProperty.call(input, "signal")) inputKeys.push("signal");
  assertExactKeys(input, inputKeys, "startDryRunService");
  assertFixedDryRunEnvironment();
  assertDirectCliNonProductionV1({
    manifestPath: input.manifestPath,
    bundleModulePath: input.bundleModulePath,
  });
  if (!input.manifestPath.startsWith("/")) throw new TypeError("deployment manifest path must be absolute");
  const manifestBytes = new Uint8Array(readFileSync(input.manifestPath));
  const manifest = decodeDeploymentManifestV1(decodeCanonicalJson(manifestBytes));
  const bundleModulePath = absolutePath(input.bundleModulePath, "startDryRunService.bundleModulePath");
  if (bundleModulePath !== manifest.searcherRuntimeBundleModulePath) {
    throw new TypeError("deployment bundle module path does not match the manifest");
  }
  const anchors = await systemRuntimeAnchorObserverV1.observe({
    manifestPath: input.manifestPath,
    manifestBytes,
    logPath: manifest.logPath,
    bundleModulePath,
    systemdUnitPath: manifest.systemdUnitPath,
    releaseEnvironmentPath: manifest.releaseEnvironmentPath,
  });
  assertRuntimeAnchorsV1(manifest, anchors, input.manifestPath, manifestBytes);
  const loader = await loadVerifiedDeploymentBundleModuleV1(manifest, bundleModulePath);
  const bundle = await loader.load({ manifest, manifestBytes: new Uint8Array(manifestBytes), anchors });
  return startLocalVerifiedDeploymentRuntimeBundleV1({
    manifest,
    manifestBytes,
    manifestPath: input.manifestPath,
    anchors,
    bundle,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}

/**
 * Start an already verified, owner-issued runtime bundle.  This is shared by
 * the package-owned production entry and the local dry-run loader; it accepts
 * no executable callback or caller verdict.
 */
async function startLocalVerifiedDeploymentRuntimeBundleV1(input: Readonly<{
    readonly manifest: DeploymentManifestV1;
    readonly manifestBytes: Uint8Array;
    readonly manifestPath: string;
    readonly anchors: RuntimeAnchorObservationV1;
    readonly bundle: DeploymentRuntimeBundleV1;
    readonly signal?: AbortSignal;
  }>): Promise<DryRunServiceHandleV1> {
  const manifest = decodeDeploymentManifestV1(input.manifest);
  const manifestBytes = new Uint8Array(input.manifestBytes);
  const anchors = input.anchors;
  const bundle = input.bundle;
  assertDeploymentRuntimeBundleV1(bundle);
  assertDeploymentBundleIdentityV1(manifest, bundle.startupOwner, bundle.release);
  assertRuntimeAnchorsV1(manifest, anchors, input.manifestPath, manifestBytes);
  const controller = new AbortController();
  const abort = () => controller.abort();
  input.signal?.addEventListener("abort", abort, { once: true });
  if (input.signal?.aborted) controller.abort();
  let startup: StartupRuntimeV1;
  try {
    startup = await startReleaseSearcherStartup(bundle.startupOwner, controller.signal);
  } catch (error) {
    input.signal?.removeEventListener("abort", abort);
    throw error;
  }
  let application: SearcherRuntimeApplicationV1;
  try {
    application = bundle.application.open(startup);
  } catch (error) {
    await startup.close();
    input.signal?.removeEventListener("abort", abort);
    throw error;
  }
  const applicationRun = application.run(controller.signal);
  const done = applicationRun.finally(async () => {
    await application.stop();
    input.signal?.removeEventListener("abort", abort);
  });
  return Object.freeze({
    anchors,
    startup,
    application,
    done,
    async stop() {
      controller.abort();
      await done;
    },
  });
}

export function sha256FileV1(path: string): Hash {
  return `0x${createHash("sha256").update(readFileSync(path)).digest("hex")}` as Hash;
}
