import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { basename, join, relative, resolve, sep } from "node:path";
import {
  decodeCanonicalJson,
  encodeCanonicalBytes,
  hashDomain,
  sha256Hex,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  decodeSignedReleaseAuthorityApprovalV3,
  encodeSignedReleaseAuthorityApprovalV3,
} from "../../../specs/qualification/src/index.ts";
import {
  decodeReleaseIntent,
} from "../../../specs/release-intent/src/index.ts";
import {
  decodeProcessAnchor,
  hashProcessAnchor,
  type ProcessAnchorV1,
} from "../../../specs/core-envelope/src/index.ts";
import {
  decodeRuntimeReleaseBindingV1,
  encodeRuntimeReleaseBindingV1,
  runtimeReleaseBindingProvenanceHash,
} from "../../../specs/release-authority/src/index.ts";
import {
  deriveLegacyAuthorityClosureReceipt,
  LEGACY_CLOSURE_ROOT_ROLES,
  RUNTIME_ACCEPTANCE_SCHEMA_MANIFESTS,
  sealLegacyAuthorityClosureFacts,
  sealLegacyClosureFact,
  sealLegacyClosureRawArtifact,
  sealLegacyClosureRawDenominator,
  sealLegacyClosureRawEdge,
  sealLegacyClosureRawEntrypoint,
  sealRuntimeFactRef,
  decodeRuntimeBoundaryProjectionV1,
  type LegacyAuthorityClosureFactsV1,
  type LegacyClosureRawArtifactV1,
  type LegacyClosureRawEdgeV1,
  type LegacyClosureRawEntrypointV1,
  type LegacyClosureRootRoleV1,
  type RuntimeFactRefV1,
  type RuntimeBoundaryProjectionV1,
  type RuntimeBoundarySelectedFileV1,
} from "../../../specs/runtime-acceptance-facts/src/index.ts";
import {
  readQualifiedReleaseLineageObservationV1,
  type QualifiedReleaseAcceptanceRunnerCapabilityV1,
} from "../../../tools/runtime-release-packager/src/internal/qualified-release-public-runner-state.ts";
import {
  readPreReleaseAdvisoryMaterialCapabilityV1,
  type PreReleaseAdvisoryMaterialCapabilityV1,
  type PreReleaseAdvisoryMaterialProjectionV1,
} from "../../../tools/runtime-release-packager/src/pre-release-staging.ts";
import {
  preReleaseAuthorizationClaimIdV1,
  preReleaseAuthorizationClaimPayloadV1,
  type PreReleaseStagingArtifactNameV1,
} from "../../../tools/runtime-release-packager/src/pre-release-staging-contract.ts";
import {
  PRE_RELEASE_SYSTEMD_UNIT_V1,
  decodePreReleaseLaunchAuthorizationV1,
  decodePreReleaseStagingManifestV1,
  hashPreReleaseStagingArtifactSetV1,
  type PreReleaseStagingManifestV1,
} from "../../../tools/runtime-release-packager/src/internal/pre-release-staging-schema.ts";
import {
  ContentAddressedObserverSinkV1,
  type ObservedContentArtifactV1,
} from "./content-addressed-sink.ts";
import {
  readReleaseOwnedObserverStoreV1,
  type ReleaseOwnedObserverStoreCapabilityV1,
} from "./internal/release-owned-observer-store.ts";

const SOURCE_PREDICATE_ID = "aloha.source-repository-production-closure-zero";
const LEGACY_PREDICATE_ID = "aloha.legacy-shaped-authority-zero";

const RAW_BYTES_SCHEMA = Object.freeze({
  id: "aloha.production-closure-observed-raw-bytes",
  version: "1.0.0",
  schemaHash: hashDomain("aloha/production-closure-observed-raw-bytes-schema/v1", {
    contract: "exact immutable bytes; semantic interpretation is role-owned",
  }),
});

const BOUNDARY_PROJECTION_SCHEMA = Object.freeze({
  id: "aloha.production-closure-boundary-projection",
  version: "1.0.0",
  schemaHash: hashDomain("aloha/production-closure-boundary-projection-schema/v1", {
    fields: ["candidate", "implementationClosures", "selectedFiles", "selectedEdges", "languageBuild", "releaseClosures", "projectionRoot"],
  }),
});

type Manifest = PreReleaseStagingManifestV1;

export type ProductionClosureRawObservationV1 =
  | Readonly<{
      readonly status: "available";
      readonly candidateReleaseCommit: string;
      readonly artifacts: readonly ObservedContentArtifactV1[];
      readonly facts: LegacyAuthorityClosureFactsV1;
    }>
  | Readonly<{
      readonly status: "missing" | "invalid";
      readonly reasons: readonly string[];
      readonly evidence: unknown;
    }>;

export interface ProductionClosureRawObserverInputV1 {
  readonly preReleaseAdvisoryMaterial: PreReleaseAdvisoryMaterialCapabilityV1;
  readonly qualifiedReleaseRunner: QualifiedReleaseAcceptanceRunnerCapabilityV1;
  readonly observerStore: ReleaseOwnedObserverStoreCapabilityV1;
}

class MissingObservation extends Error {
  readonly reasons: readonly string[];
  readonly evidence: unknown;

  constructor(reasons: readonly string[], evidence: unknown = null) {
    super(reasons.join(","));
    this.name = "MissingObservation";
    this.reasons = reasons;
    this.evidence = evidence;
  }
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} must be non-empty`);
  return value;
}

function decimalField(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new TypeError(`${label} must be a canonical decimal string`);
  }
  return value;
}

function absoluteField(value: unknown, label: string): string {
  const path = stringField(value, label);
  if (!path.startsWith("/") || resolve(path) !== path) throw new TypeError(`${label} must be a normalized absolute path`);
  return path;
}

function canonicalRegularPath(value: string, label: string): string {
  if (!existsSync(value)) throw new MissingObservation([`${label}-missing`], { path: value });
  const physical = realpathSync(value);
  if (!lstatSync(physical).isFile()) throw new TypeError(`${label} is not a regular file`);
  return physical;
}

function stableBytes(value: string, label: string, requireCanonical = false): Readonly<{ readonly path: string; readonly bytes: Uint8Array }> {
  const physical = canonicalRegularPath(value, label);
  if (requireCanonical && physical !== value) throw new TypeError(`${label} path is not canonical`);
  const before = statSync(physical, { bigint: true });
  const bytes = new Uint8Array(readFileSync(physical));
  const after = statSync(physical, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
    throw new TypeError(`${label} changed during observation`);
  }
  return Object.freeze({ path: physical, bytes });
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function decodeManifest(bytes: Uint8Array, expectedRoot: Hash): Manifest {
  const manifest = decodePreReleaseStagingManifestV1(decodeCanonicalJson(bytes));
  const root = hashDomain("aloha/pre-release-staging-manifest/root/v1", {
    contentSha256: sha256Hex(bytes),
    byteLength: String(bytes.byteLength),
  });
  if (root !== expectedRoot || !sameBytes(bytes, encodeCanonicalBytes(manifest))) {
    throw new TypeError("pre-release staging manifest identity or canonical bytes mismatch");
  }
  return manifest;
}

function relativeInside(root: string, path: string): string | null {
  const candidate = relative(root, path).split(sep).join("/");
  return candidate === "" || candidate === ".." || candidate.startsWith("../") ? null : candidate;
}

function authorityShape(subject: string): "neutral" | "strict-authority" | "legacy-shaped-authority" | "compatibility-facade-or-fallback" {
  const normalized = subject.toLowerCase();
  if (/(^|[./_-])(compat(?:ibility)?|fallback|facade|shadow[-_]?authority|dual[-_]?track)([./_-]|$)/.test(normalized)) {
    return "compatibility-facade-or-fallback";
  }
  if (/(^|[./_-])legacy([./_-]|$)/.test(normalized)
    && /(authority|catalog|checkpoint|graph|runtime|topology|writer)/.test(normalized)) {
    return "legacy-shaped-authority";
  }
  if (/(authority|issuer|capability|certificate|approval|owner)/.test(normalized)) return "strict-authority";
  return "neutral";
}

function repositoryLogicalKey(repositoryRoot: string, path: string, physicalPath: string): string {
  const physicalRelative = relativeInside(repositoryRoot, physicalPath);
  const origin = path.startsWith("tools/reference-only/") || physicalRelative !== path ? "reference" : "candidate";
  return `${origin}/${authorityShape(path)}/${path}`;
}

function externalLogicalKey(kind: string, bytes: Uint8Array, hint: string): string {
  const subject = `${kind}/${basename(hint).replace(/[^A-Za-z0-9._-]/g, "-")}/${sha256Hex(bytes).slice(2)}`;
  return `external/${authorityShape(subject)}/${subject}`;
}

function mediaType(path: string): string {
  return path.endsWith(".json") ? "application/json"
    : /\.(?:ts|js|mjs|cjs|rs|sol)$/.test(path) ? "text/plain"
      : "application/octet-stream";
}

function processStat(bytes: Uint8Array, label: string): Readonly<{ readonly pid: string; readonly parentPid: string; readonly startTicks: string }> {
  const text = Buffer.from(bytes).toString("utf8").trim();
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open <= 0 || close <= open) throw new TypeError(`${label} is malformed`);
  const pid = text.slice(0, open).trim();
  const suffix = text.slice(close + 2).trim().split(/\s+/);
  if (!/^[1-9][0-9]*$/.test(pid) || !/^[0-9]+$/.test(suffix[1] ?? "") || !/^[0-9]+$/.test(suffix[19] ?? "")) {
    throw new TypeError(`${label} identity is malformed`);
  }
  return Object.freeze({ pid, parentPid: suffix[1]!, startTicks: suffix[19]! });
}

interface ProcessSnapshot {
  readonly pid: string;
  readonly parentPid: string;
  readonly startTicks: string;
  readonly statBytes: Uint8Array;
  readonly cmdlineBytes: Uint8Array;
  readonly mapsBytes: Uint8Array;
  readonly cgroupBytes: Uint8Array;
  readonly executablePath: string;
  readonly executableBytes: Uint8Array;
  readonly argv: readonly string[];
  readonly executableMappings: readonly Readonly<{ readonly path: string; readonly bytes: Uint8Array }>[];
}

function processSnapshot(pid: string): ProcessSnapshot {
  const root = `/proc/${pid}`;
  if (!existsSync(root)) throw new MissingObservation(["runtime-process-missing"], { pid });
  const statBytes = new Uint8Array(readFileSync(`${root}/stat`));
  const stat = processStat(statBytes, `process ${pid} stat`);
  if (stat.pid !== pid) throw new TypeError("runtime process stat pid mismatch");
  const cmdlineBytes = new Uint8Array(readFileSync(`${root}/cmdline`));
  const mapsBytes = new Uint8Array(readFileSync(`${root}/maps`));
  const cgroupBytes = new Uint8Array(readFileSync(`${root}/cgroup`));
  const executablePath = realpathSync(`${root}/exe`);
  const executableBytes = stableBytes(executablePath, `process-${pid}-executable`).bytes;
  const argv = Buffer.from(cmdlineBytes).toString("utf8").split("\0").filter(value => value.length > 0);
  if (argv.length === 0) throw new TypeError("runtime process command line is empty");
  const mappings = new Map<string, Uint8Array>();
  for (const line of Buffer.from(mapsBytes).toString("utf8").split("\n")) {
    if (line.length === 0) continue;
    const match = /^(?:[0-9a-f]+)-(?:[0-9a-f]+)\s+([-r][-w][-x][sp])\s+\S+\s+\S+\s+\S+\s*(.*)$/.exec(line);
    if (match === null) throw new TypeError("runtime process maps line is malformed");
    if (!match[1]!.includes("x")) continue;
    const mapped = match[2]!;
    if (mapped.length === 0 || mapped.startsWith("[")) continue;
    if (mapped.endsWith(" (deleted)")) throw new TypeError("runtime loaded executable object was deleted");
    if (!mapped.startsWith("/")) throw new TypeError("runtime loaded executable object path is unresolved");
    const physical = canonicalRegularPath(mapped, "runtime-loaded-object");
    if (!mappings.has(physical)) mappings.set(physical, stableBytes(physical, "runtime-loaded-object").bytes);
  }
  if (mappings.size === 0) throw new MissingObservation(["runtime-loaded-objects-missing"], { pid });
  const afterStat = processStat(new Uint8Array(readFileSync(`${root}/stat`)), `process ${pid} stat recheck`);
  if (afterStat.pid !== stat.pid || afterStat.startTicks !== stat.startTicks || afterStat.parentPid !== stat.parentPid) {
    throw new TypeError("runtime process identity changed during observation");
  }
  return Object.freeze({
    pid,
    parentPid: stat.parentPid,
    startTicks: stat.startTicks,
    statBytes,
    cmdlineBytes,
    mapsBytes,
    cgroupBytes,
    executablePath,
    executableBytes,
    argv: Object.freeze(argv),
    executableMappings: Object.freeze([...mappings].sort(([a], [b]) => a.localeCompare(b)).map(([path, bytes]) => Object.freeze({ path, bytes }))),
  });
}

function currentProcessTree(anchor: ProcessAnchorV1): readonly ProcessSnapshot[] {
  if (!existsSync("/proc") || !lstatSync("/proc").isDirectory()) throw new MissingObservation(["procfs-unavailable"]);
  const main = processSnapshot(anchor.pid);
  if (main.startTicks !== anchor.processStartTicks) throw new TypeError("pre-release process start tick mismatch");
  const byParent = new Map<string, string[]>();
  for (const name of readdirSync("/proc")) {
    if (!/^[1-9][0-9]*$/.test(name) || name === anchor.pid) continue;
    try {
      const stat = processStat(new Uint8Array(readFileSync(`/proc/${name}/stat`)), `process ${name} stat`);
      const children = byParent.get(stat.parentPid) ?? [];
      children.push(name);
      byParent.set(stat.parentPid, children);
    } catch {
      // A process that exits while scanning cannot be a stable denominator.
    }
  }
  const childIds: string[] = [];
  const queue = [...(byParent.get(anchor.pid) ?? [])].sort();
  while (queue.length > 0) {
    const pid = queue.shift()!;
    childIds.push(pid);
    queue.push(...(byParent.get(pid) ?? []).sort());
  }
  if (childIds.length === 0) throw new MissingObservation(["runtime-child-entrypoint-missing"], { pid: anchor.pid });
  const snapshots = [main, ...childIds.map(processSnapshot)];
  for (const child of snapshots.slice(1)) {
    if (!snapshots.some(parent => parent.pid === child.parentPid)) throw new TypeError("runtime child lineage is unresolved");
  }
  return Object.freeze(snapshots);
}

function runtimeStorageSet(path: string): Readonly<{
  readonly main: Readonly<{ readonly path: string; readonly bytes: Uint8Array }>;
  readonly wal: Readonly<{ readonly path: string; readonly bytes: Uint8Array }> | null;
  readonly root: Hash;
}> {
  const main = stableBytes(path, "runtime-sqlite", true);
  const walPath = `${path}-wal`;
  const wal = existsSync(walPath) ? stableBytes(walPath, "runtime-sqlite-wal", true) : null;
  const files = [
    { role: "main", byteLength: String(main.bytes.byteLength), sha256: sha256Hex(main.bytes) },
    ...(wal === null ? [] : [{ role: "wal", byteLength: String(wal.bytes.byteLength), sha256: sha256Hex(wal.bytes) }]),
  ];
  return Object.freeze({
    main,
    wal,
    root: hashDomain("aloha/raw-runtime-acceptance-sqlite-storage-set/v1", files),
  });
}

function observeSystemdProcessJoin(
  receipt: PreReleaseAdvisoryMaterialProjectionV1["processImportReceipt"],
  main: ProcessSnapshot,
): Uint8Array {
  const cgroupText = Buffer.from(main.cgroupBytes).toString("utf8");
  const cgroupUnits = cgroupText.split("\n").flatMap(line => {
    const tail = line.slice(line.lastIndexOf(":") + 1);
    return tail.split("/").filter(value => value.endsWith(".service"));
  });
  if (!cgroupUnits.includes(receipt.systemdUnit)) {
    throw new TypeError("runtime process cgroup does not join the declared systemd unit");
  }
  if (!/^[0-9a-f]{32}$/.test(receipt.systemdInvocationId)) {
    throw new TypeError("runtime systemd invocation id is malformed");
  }
  const invocationPath = `/run/systemd/units/invocation:${receipt.systemdInvocationId}`;
  if (!existsSync(invocationPath) || !lstatSync(invocationPath).isSymbolicLink()) {
    throw new MissingObservation(["runtime-systemd-invocation-missing"], {
      invocationId: receipt.systemdInvocationId,
      systemdUnit: receipt.systemdUnit,
    });
  }
  const invocationTarget = readlinkSync(invocationPath);
  if (basename(invocationTarget) !== receipt.systemdUnit) {
    throw new TypeError("runtime systemd invocation does not join the declared unit");
  }
  return encodeCanonicalBytes({
    schemaVersion: 1,
    kind: "aloha.observed-systemd-process-join",
    pid: receipt.processAnchor.pid,
    processStartTicks: receipt.processAnchor.processStartTicks,
    invocationId: receipt.systemdInvocationId,
    invocationTarget,
    systemdUnit: receipt.systemdUnit,
    cgroupSha256: sha256Hex(main.cgroupBytes),
  });
}

function assertReceiptHostAndProcessJoin(
  preRelease: PreReleaseAdvisoryMaterialProjectionV1,
  main: ProcessSnapshot,
): void {
  const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  if (bootId.length === 0) throw new MissingObservation(["runtime-host-identity-missing"]);
  const receipt = preRelease.processImportReceipt;
  const anchor = decodeProcessAnchor(receipt.processAnchor);
  const expectedServiceIdentityHash = hashDomain("aloha/pre-release-service-identity/v1", {
    serviceName: receipt.serviceName,
    systemdUnit: receipt.systemdUnit,
    authorizationId: preRelease.signedAuthorization.authorizationId,
    authorizationClaimId: preRelease.authorizationClaim.claimId,
  });
  const expectedProcessAnchor: ProcessAnchorV1 = Object.freeze({
    systemId: `${receipt.serviceName}/${receipt.systemdUnit}`,
    commitSha: receipt.candidateReleaseCommit,
    executableHash: sha256Hex(main.executableBytes),
    deploymentManifestHash: preRelease.stagingManifestRoot,
    serviceIdentityHash: expectedServiceIdentityHash,
    pid: main.pid,
    processStartTicks: main.startTicks,
    bootIdHash: hashDomain("aloha/runtime-boot-id/v1", bootId),
  });
  if (receipt.processAnchorHash !== hashProcessAnchor(anchor)
    || !sameBytes(encodeCanonicalBytes(anchor), encodeCanonicalBytes(expectedProcessAnchor))) {
    throw new TypeError("pre-release process receipt anchor does not join observed process/host facts");
  }
}

class DenominatorBuilder {
  readonly sink: ContentAddressedObserverSinkV1;
  readonly artifacts: LegacyClosureRawArtifactV1[] = [];
  readonly edges: LegacyClosureRawEdgeV1[] = [];
  readonly entrypoints: LegacyClosureRawEntrypointV1[] = [];
  readonly providerArtifacts: ObservedContentArtifactV1[] = [];
  readonly factRefs = new Map<Hash, RuntimeFactRefV1>();
  readonly roleArtifacts = new Map<LegacyClosureRootRoleV1, Set<Hash>>(LEGACY_CLOSURE_ROOT_ROLES.map(role => [role, new Set()]));
  readonly roleEdges = new Map<LegacyClosureRootRoleV1, Set<Hash>>(LEGACY_CLOSURE_ROOT_ROLES.map(role => [role, new Set()]));
  readonly roleEntrypoints = new Map<LegacyClosureRootRoleV1, Set<Hash>>(LEGACY_CLOSURE_ROOT_ROLES.map(role => [role, new Set()]));
  readonly artifactByKey = new Map<string, LegacyClosureRawArtifactV1>();

  constructor(sink: ContentAddressedObserverSinkV1) {
    this.sink = sink;
  }

  async addArtifact(input: Readonly<{
    readonly logicalKey: string;
    readonly bytes: Uint8Array;
    readonly mediaType: string;
    readonly schema?: NonNullable<ObservedContentArtifactV1["ref"]["schema"]>;
    readonly roles: readonly LegacyClosureRootRoleV1[];
  }>): Promise<LegacyClosureRawArtifactV1> {
    const existing = this.artifactByKey.get(input.logicalKey);
    if (existing !== undefined) {
      if (existing.contentSha256 !== sha256Hex(input.bytes)) throw new TypeError("one logical artifact key resolved to different bytes");
      for (const role of input.roles) this.roleArtifacts.get(role)!.add(existing.artifactId);
      return existing;
    }
    const observed = await this.sink.write({ bytes: input.bytes, mediaType: input.mediaType, schema: input.schema ?? RAW_BYTES_SCHEMA });
    if (observed.ref.schema === null) throw new TypeError("observer sink removed the required artifact schema");
    const ref = sealRuntimeFactRef({
      artifactRefId: observed.ref.artifactRefId,
      contentSha256: observed.contentSha256,
      byteLength: String(observed.bytes.byteLength),
      schema: observed.ref.schema,
      locator: observed.ref.locator,
    });
    const artifact = sealLegacyClosureRawArtifact({
      logicalKey: input.logicalKey,
      contentSha256: observed.contentSha256,
      byteLength: String(observed.bytes.byteLength),
      factRefId: ref.factId,
      locatorId: ref.locatorId,
      locator: ref.locator,
    });
    this.providerArtifacts.push(observed);
    this.factRefs.set(ref.factId, ref);
    this.artifacts.push(artifact);
    this.artifactByKey.set(input.logicalKey, artifact);
    for (const role of input.roles) this.roleArtifacts.get(role)!.add(artifact.artifactId);
    return artifact;
  }

  addEdge(input: Readonly<{
    readonly relation: LegacyClosureRawEdgeV1["relation"];
    readonly source: LegacyClosureRawArtifactV1;
    readonly target: LegacyClosureRawArtifactV1 | null;
    readonly targetLogicalKey: string;
    readonly evidence: LegacyClosureRawArtifactV1;
    readonly roles: readonly LegacyClosureRootRoleV1[];
  }>): LegacyClosureRawEdgeV1 {
    const edge = sealLegacyClosureRawEdge({
      relation: input.relation,
      sourceArtifactId: input.source.artifactId,
      targetArtifactId: input.target?.artifactId ?? null,
      targetLogicalKey: input.targetLogicalKey,
      locatorId: input.evidence.locatorId,
      locator: input.evidence.locator,
    });
    if (!this.edges.some(value => value.edgeId === edge.edgeId)) this.edges.push(edge);
    for (const role of input.roles) this.roleEdges.get(role)!.add(edge.edgeId);
    return edge;
  }

  addEntrypoint(input: Readonly<{
    readonly kind: LegacyClosureRawEntrypointV1["entrypointKind"];
    readonly logicalKey: string;
    readonly artifact: LegacyClosureRawArtifactV1 | null;
    readonly evidence: LegacyClosureRawArtifactV1;
    readonly roles: readonly LegacyClosureRootRoleV1[];
  }>): LegacyClosureRawEntrypointV1 {
    const entrypoint = sealLegacyClosureRawEntrypoint({
      entrypointKind: input.kind,
      logicalKey: input.logicalKey,
      artifactId: input.artifact?.artifactId ?? null,
      locatorId: input.evidence.locatorId,
      locator: input.evidence.locator,
    });
    if (!this.entrypoints.some(value => value.entrypointId === entrypoint.entrypointId)) this.entrypoints.push(entrypoint);
    for (const role of input.roles) this.roleEntrypoints.get(role)!.add(entrypoint.entrypointId);
    return entrypoint;
  }

  async facts(
    predicateSpecDigests: readonly [Hash, Hash],
    qualificationCertificateIds: readonly [Hash, Hash],
  ): Promise<LegacyAuthorityClosureFactsV1> {
    const allArtifacts = this.artifacts.map(value => value.artifactId);
    const allEdges = this.edges.map(value => value.edgeId);
    const allEntrypoints = this.entrypoints.map(value => value.entrypointId);
    const closures = [];
    for (const role of LEGACY_CLOSURE_ROOT_ROLES) {
      const entrypointIds = role === "production-entrypoint-denominator" ? allEntrypoints : [...this.roleEntrypoints.get(role)!];
      const artifactIds = role === "production-entrypoint-denominator" ? allArtifacts : [...this.roleArtifacts.get(role)!];
      const edgeIds = role === "production-entrypoint-denominator" ? allEdges : [...this.roleEdges.get(role)!];
      const payload = {
        role,
        entrypointIds: [...entrypointIds].sort(),
        artifactIds: [...artifactIds].sort(),
        edgeIds: [...edgeIds].sort(),
      };
      const observedRoot = hashDomain("aloha/legacy-authority-closure/role-root/v2", payload);
      const semanticBytes = encodeCanonicalBytes({ ...payload, observedRoot });
      const observed = await this.sink.write({
        bytes: semanticBytes,
        mediaType: "application/json",
        schema: RUNTIME_ACCEPTANCE_SCHEMA_MANIFESTS.legacyClosureRootFactPayload,
      });
      if (observed.ref.schema === null) throw new TypeError("observer sink removed the required closure fact schema");
      const ref = sealRuntimeFactRef({
        artifactRefId: observed.ref.artifactRefId,
        contentSha256: observed.contentSha256,
        byteLength: String(observed.bytes.byteLength),
        schema: observed.ref.schema,
        locator: observed.ref.locator,
      });
      this.providerArtifacts.push(observed);
      this.factRefs.set(ref.factId, ref);
      closures.push(sealLegacyClosureFact({ ...payload, factRefId: ref.factId }));
    }
    const denominator = sealLegacyClosureRawDenominator({
      artifacts: this.artifacts,
      edges: this.edges,
      entrypoints: this.entrypoints,
      closures,
    });
    const receipt = deriveLegacyAuthorityClosureReceipt(predicateSpecDigests, qualificationCertificateIds, denominator);
    return sealLegacyAuthorityClosureFacts(receipt, [...this.factRefs.values()].sort((a, b) => a.factId.localeCompare(b.factId)), denominator);
  }
}

function roleForRepositoryPath(path: string): readonly LegacyClosureRootRoleV1[] {
  const roles: LegacyClosureRootRoleV1[] = [];
  if (/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(path) || /(?:^|\/)tsconfig(?:\.[^/]+)?\.json$/.test(path) || path.endsWith("/package.json")) roles.push("ts-js-ast-module-closure");
  if (path.includes("/generated/") || path.endsWith("/package.json") || path.endsWith("package-lock.json")) roles.push("generated-package-alias-closure");
  if (path.startsWith("runtime/revm-workers/") || path.includes("worker") || path.includes("child")) roles.push("worker-child-dynamic-entrypoint");
  if (path.startsWith("runtime/revm-worker-rust/") || /(?:Cargo\.toml|Cargo\.lock|\.rs)$/.test(path)) roles.push("rust-binary-closure");
  if (path.startsWith("contracts/") || /(?:\.sol|abi\.ts|abi\.json)$/.test(path)) roles.push("solidity-deployment-abi-ownership");
  if (path.startsWith("deploy/")) roles.push("deploy-manifest-systemd-exec");
  return Object.freeze(roles.length === 0 ? ["ts-js-ast-module-closure"] : [...new Set(roles)]);
}

function resolveModuleArtifact(builder: DenominatorBuilder, modulePath: string): LegacyClosureRawArtifactV1 | null {
  const candidates = [...builder.artifactByKey.entries()].filter(([key]) => key.endsWith(`/${modulePath}`) || key.endsWith(`/${modulePath}.ts`) || key.endsWith(`/${modulePath}/index.ts`));
  return candidates.length === 1 ? candidates[0]![1] : null;
}

interface ObservedPreReleaseArtifactV1 {
  readonly name: PreReleaseStagingArtifactNameV1;
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly contentSha256: Hash;
}

function observeAuthorizationClaimLedger(preRelease: PreReleaseAdvisoryMaterialProjectionV1): Uint8Array {
  const claim = preRelease.authorizationClaim;
  const observed = stableBytes(claim.ledgerPath, "pre-release-authorization-ledger", true);
  const stat = statSync(observed.path, { bigint: true });
  if (String(stat.dev) !== claim.ledgerDevice || String(stat.ino) !== claim.ledgerInode) {
    throw new TypeError("pre-release authorization claim ledger identity mismatch");
  }
  const database = new DatabaseSync(observed.path, { readOnly: true });
  try {
    const integrity = database.prepare("PRAGMA integrity_check").all() as readonly { integrity_check?: unknown }[];
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
      throw new TypeError("pre-release authorization claim ledger integrity check failed");
    }
    const rows = database.prepare(`SELECT authorization_id, signer_key_id, nonce, phase, round_role,
      predecessor_authorization_id, predecessor_authorization_claim_id, predecessor_controller_receipt_id,
      predecessor_controller_implementation_identity_hash, predecessor_target_process_anchor_hash,
      predecessor_process_ready_event_id, predecessor_sigterm_drained_event_id, predecessor_restart_terminal_id,
      candidate_release_commit, runtime_binding_id, release_provenance_hash, controller_boundary_evidence_root,
      staging_artifact_set_root, staging_manifest_root, observer_store_directory, issued_at_unix_ns,
      expires_at_unix_ns, payload_hash, signature_hash, claim_id
      FROM pre_release_authorization_claim_v1 WHERE authorization_id = ?`).all(claim.authorizationId) as readonly Record<string, unknown>[];
    if (rows.length !== 1) throw new TypeError("pre-release authorization claim row cardinality mismatch");
    const row = rows[0]!;
    const expected = {
      authorization_id: claim.authorizationId,
      signer_key_id: claim.signerKeyId,
      nonce: claim.nonce,
      phase: claim.phase,
      round_role: claim.roundRole,
      predecessor_authorization_id: claim.predecessor?.authorizationId ?? null,
      predecessor_authorization_claim_id: claim.predecessor?.authorizationClaimId ?? null,
      predecessor_controller_receipt_id: claim.predecessor?.controllerReceiptId ?? null,
      predecessor_controller_implementation_identity_hash: claim.predecessor?.controllerImplementationIdentityHash ?? null,
      predecessor_target_process_anchor_hash: claim.predecessor?.targetProcessAnchorHash ?? null,
      predecessor_process_ready_event_id: claim.predecessor?.processReadyEventId ?? null,
      predecessor_sigterm_drained_event_id: claim.predecessor?.sigtermDrainedEventId ?? null,
      predecessor_restart_terminal_id: claim.predecessor?.restartTerminalId ?? null,
      candidate_release_commit: claim.candidateReleaseCommit,
      runtime_binding_id: claim.runtimeBindingId,
      release_provenance_hash: claim.releaseProvenanceHash,
      controller_boundary_evidence_root: claim.controllerBoundaryEvidenceRoot,
      staging_artifact_set_root: claim.stagingArtifactSetRoot,
      staging_manifest_root: claim.stagingManifestRoot,
      observer_store_directory: claim.observerStoreDirectory,
      issued_at_unix_ns: claim.issuedAtUnixNs,
      expires_at_unix_ns: claim.expiresAtUnixNs,
      payload_hash: claim.payloadHash,
      signature_hash: claim.signatureHash,
      claim_id: claim.claimId,
    };
    if (Reflect.ownKeys(row).length !== Reflect.ownKeys(expected).length
      || Object.entries(expected).some(([key, value]) => row[key] !== value)) {
      throw new TypeError("pre-release authorization claim row was spliced");
    }
  } finally {
    database.close();
  }
  const after = stableBytes(claim.ledgerPath, "pre-release-authorization-ledger", true);
  if (!sameBytes(observed.bytes, after.bytes)) throw new TypeError("pre-release authorization claim ledger changed during observation");
  return observed.bytes;
}

function observePreReleaseArtifacts(
  preRelease: PreReleaseAdvisoryMaterialProjectionV1,
): ReadonlyMap<PreReleaseStagingArtifactNameV1, ObservedPreReleaseArtifactV1> {
  const receipt = preRelease.processImportReceipt;
  if (hashPreReleaseStagingArtifactSetV1(preRelease.stagingArtifacts) !== preRelease.stagingArtifactSetRoot
    || hashPreReleaseStagingArtifactSetV1(receipt.stagingArtifacts) !== preRelease.stagingArtifactSetRoot
    || !sameBytes(encodeCanonicalBytes(preRelease.stagingArtifacts), encodeCanonicalBytes(receipt.stagingArtifacts))) {
    throw new TypeError("pre-release staging artifact denominator was spliced");
  }
  const observed = new Map<PreReleaseStagingArtifactNameV1, ObservedPreReleaseArtifactV1>();
  for (const identity of preRelease.stagingArtifacts) {
    const snapshot = stableBytes(identity.installPath, `pre-release-artifact:${identity.name}`, true);
    const contentSha256 = sha256Hex(snapshot.bytes);
    if (contentSha256 !== identity.contentSha256 || String(snapshot.bytes.byteLength) !== identity.byteLength) {
      throw new TypeError(`pre-release artifact bytes do not exact-join receipt: ${identity.name}`);
    }
    observed.set(identity.name, Object.freeze({ name: identity.name, path: snapshot.path, bytes: snapshot.bytes, contentSha256 }));
  }
  return observed;
}

function assertPreReleaseDenominator(
  preRelease: PreReleaseAdvisoryMaterialProjectionV1,
  qualifiedRelease: ReturnType<typeof readQualifiedReleaseLineageObservationV1>,
  store: ReturnType<typeof readReleaseOwnedObserverStoreV1>,
  manifest: Manifest,
  artifacts: ReadonlyMap<PreReleaseStagingArtifactNameV1, ObservedPreReleaseArtifactV1>,
): void {
  const authorization = decodePreReleaseLaunchAuthorizationV1(preRelease.signedAuthorization);
  const claim = preRelease.authorizationClaim;
  const receipt = preRelease.processImportReceipt;
  const binding = qualifiedRelease.runtimeBinding;
  const provenance = runtimeReleaseBindingProvenanceHash(binding);
  const manifestArtifact = artifacts.get("staging-manifest.json")!;
  const entrypoint = artifacts.get("pre-release-owner.mjs")!;
  const bundle = artifacts.get("deployment-bundle.mjs")!;
  const { receiptId: _receiptId, ...receiptPayload } = receipt;
  const expectedReceiptId = hashDomain("aloha/pre-release-process-import-receipt/id/v1", receiptPayload);
  const expectedClaimPayload = preReleaseAuthorizationClaimPayloadV1(authorization);
  const expectedClaimId = preReleaseAuthorizationClaimIdV1(authorization);
  const expectedStore = {
    bindingId: binding.bindingId,
    releaseAuthorityApprovalId: qualifiedRelease.releaseAuthorityApproval.approvalId,
    qualificationRegistryRoot: qualifiedRelease.releaseAuthorityApproval.registryRoot,
    predicateCompositionRootDigest: qualifiedRelease.releaseAuthorityApproval.predicateCompositionRootDigest,
    releaseRoleManifestRoot: qualifiedRelease.boundary.releaseRoleManifestRoot,
    candidateReleaseCommit: qualifiedRelease.boundary.candidateReleaseCommit,
  };
  const manifestArtifactJoins: readonly [PreReleaseStagingArtifactNameV1, string, Hash][] = [
    ["aloha-searcher-pre-release.service", manifest.systemdUnitPath, manifest.systemdUnitSha256],
    ["candidate-proof-verifier-binding.json", manifest.candidateProofVerifierBindingPath, manifest.candidateProofVerifierBindingSha256],
    ["catalog-generation.inputs.json", manifest.catalogGenerationInputPath, manifest.catalogGenerationInputSha256],
    ["deployment-bundle.mjs", manifest.bundlePath, manifest.deploymentBundleSha256],
    ["deployment-composition.mjs", manifest.deploymentCompositionPath, manifest.deploymentCompositionSha256],
    ["deployment-source.json", manifest.deploymentSourcePath, manifest.deploymentSourceSha256],
    ["executor-state.json", manifest.executorStatePath, manifest.executorStateSha256],
    ["family-catalog.ts", manifest.familyCatalogSourcePath, manifest.familyCatalogSourceSha256],
    ["performance-profile.json", manifest.performanceProfilePath, manifest.performanceProfileSha256],
    ["qualified-release-runner-input.json", manifest.qualifiedReleaseRunnerInputPath, manifest.qualifiedReleaseRunnerInputSha256],
    ["release-authority-approval.json", manifest.releaseAuthorityApprovalPath, manifest.releaseAuthorityApprovalSha256],
    ["release-intent.json", manifest.releaseIntentPath, manifest.releaseIntentSha256],
    ["runtime-policy.json", manifest.runtimePolicyPath, manifest.runtimePolicySha256],
    ["runtime-boundary-projection.json", manifest.runtimeBoundaryProjectionPath, manifest.runtimeBoundaryProjectionSha256],
    ["runtime-composition.ts", manifest.runtimeCompositionSourcePath, manifest.runtimeCompositionSourceSha256],
    ["runtime-release-binding.json", manifest.runtimeBindingPath, manifest.runtimeBindingSha256],
    ["runtime-release-signer-pin.json", manifest.runtimeSignerPinPath, manifest.runtimeSignerPinSha256],
    ["searcher-pre-release.env", manifest.releaseEnvironmentPath, manifest.releaseEnvironmentSha256],
    ["staging-manifest.json", manifest.manifestPath, manifestArtifact.contentSha256],
    ["strategy-catalog.ts", manifest.strategyCatalogSourcePath, manifest.strategyCatalogSourceSha256],
    ["pre-release-owner.mjs", manifest.launcherPath, manifest.launcherSha256],
    ["production-launcher.mjs", manifest.productionLauncherPath, manifest.productionLauncherSha256],
  ];
  if (manifestArtifactJoins.some(([name, path, hash]) => {
    const artifact = artifacts.get(name);
    return artifact === undefined || artifact.path !== path || artifact.contentSha256 !== hash;
  })) {
    throw new TypeError("pre-release staging manifest artifact paths or hashes were spliced");
  }
  if (preRelease.phase !== "pre-release" || authorization.phase !== "pre-release" || claim.phase !== "pre-release"
    || claim.roundRole !== "qualification-final"
    || receipt.phase !== "pre-release" || receipt.dryRun !== true
    || authorization.dryRun !== true || authorization.roundRole !== "qualification-final"
    || authorization.allowedTerminal !== "qualification-facts-observed"
    || authorization.permissions.sign !== false || authorization.permissions.broadcast !== false
    || authorization.permissions.promote !== false
    || expectedReceiptId !== receipt.receiptId || expectedClaimId !== claim.claimId
    || !sameBytes(encodeCanonicalBytes(expectedClaimPayload), encodeCanonicalBytes({
      authorizationId: claim.authorizationId,
      signerKeyId: claim.signerKeyId,
      nonce: claim.nonce,
      phase: claim.phase,
      roundRole: claim.roundRole,
      predecessor: claim.predecessor,
      candidateReleaseCommit: claim.candidateReleaseCommit,
      runtimeBindingId: claim.runtimeBindingId,
      releaseProvenanceHash: claim.releaseProvenanceHash,
      controllerBoundaryEvidenceRoot: claim.controllerBoundaryEvidenceRoot,
      stagingArtifactSetRoot: claim.stagingArtifactSetRoot,
      stagingManifestRoot: claim.stagingManifestRoot,
      observerStoreDirectory: claim.observerStoreDirectory,
      issuedAtUnixNs: claim.issuedAtUnixNs,
      expiresAtUnixNs: claim.expiresAtUnixNs,
      payloadHash: claim.payloadHash,
      signatureHash: claim.signatureHash,
    }))
    || receipt.processAnchorHash !== hashProcessAnchor(decodeProcessAnchor(receipt.processAnchor))
    || preRelease.stagingManifestRoot !== hashDomain("aloha/pre-release-staging-manifest/root/v1", {
      contentSha256: manifestArtifact.contentSha256,
      byteLength: String(manifestArtifact.bytes.byteLength),
    })
    || preRelease.locators.repositoryRoot !== authorization.repositoryRoot
    || preRelease.locators.artifactRoot !== authorization.artifactRoot
    || preRelease.locators.manifestPath !== authorization.manifestPath
    || preRelease.locators.processEvidenceDatabasePath !== authorization.processEvidenceDatabasePath
    || preRelease.locators.checkpointDatabasePath !== authorization.checkpointDatabasePath
    || preRelease.locators.observerStoreDirectory !== authorization.observerStoreDirectory
    || preRelease.locators.logPath !== authorization.logPath
    || preRelease.locators.authorizationLedgerPath !== claim.ledgerPath
    || receipt.manifestPath !== preRelease.locators.manifestPath
    || receipt.processEvidenceDatabasePath !== preRelease.locators.processEvidenceDatabasePath
    || receipt.checkpointDatabasePath !== preRelease.locators.checkpointDatabasePath
    || receipt.observerStoreDirectory !== preRelease.locators.observerStoreDirectory
    || receipt.logPath !== preRelease.locators.logPath
    || receipt.entrypointPath !== entrypoint.path || receipt.entrypointSha256 !== entrypoint.contentSha256
    || receipt.bundlePath !== bundle.path || receipt.bundleSha256 !== bundle.contentSha256
    || receipt.stagingArtifactSetRoot !== preRelease.stagingArtifactSetRoot
    || receipt.stagingManifestRoot !== preRelease.stagingManifestRoot
    || receipt.authorizationId !== authorization.authorizationId
    || receipt.authorizationClaimId !== claim.claimId
    || claim.authorizationId !== authorization.authorizationId
    || claim.signerKeyId !== authorization.signerKeyId || claim.nonce !== authorization.nonce
    || claim.payloadHash !== authorization.payloadHash || claim.signatureHash !== expectedClaimPayload.signatureHash
    || claim.stagingArtifactSetRoot !== preRelease.stagingArtifactSetRoot
    || claim.stagingManifestRoot !== preRelease.stagingManifestRoot
    || claim.observerStoreDirectory !== preRelease.locators.observerStoreDirectory
    || authorization.stagingArtifactSetRoot !== preRelease.stagingArtifactSetRoot
    || authorization.stagingManifestRoot !== preRelease.stagingManifestRoot
    || manifest.repositoryRoot !== preRelease.locators.repositoryRoot
    || manifest.artifactRoot !== preRelease.locators.artifactRoot
    || manifest.manifestPath !== preRelease.locators.manifestPath
    || manifest.processEvidenceDatabasePath !== preRelease.locators.processEvidenceDatabasePath
    || manifest.checkpointDatabasePath !== preRelease.locators.checkpointDatabasePath
    || manifest.observerStoreDirectory !== preRelease.locators.observerStoreDirectory
    || manifest.logPath !== preRelease.locators.logPath
    || manifest.launcherPath !== receipt.entrypointPath || manifest.launcherSha256 !== receipt.entrypointSha256
    || manifest.bundlePath !== receipt.bundlePath || manifest.deploymentBundleSha256 !== receipt.bundleSha256
    || manifest.serviceName !== receipt.serviceName || manifest.systemdUnit !== receipt.systemdUnit
    || receipt.runtimeExportSurfaceRoot !== manifest.runtimeExportSurfaceRoot
    || authorization.runtimeExportSurfaceRoot !== manifest.runtimeExportSurfaceRoot
    || authorization.candidateReleaseCommit !== qualifiedRelease.boundary.candidateReleaseCommit
    || claim.candidateReleaseCommit !== qualifiedRelease.boundary.candidateReleaseCommit
    || receipt.candidateReleaseCommit !== qualifiedRelease.boundary.candidateReleaseCommit
    || manifest.candidateReleaseCommit !== qualifiedRelease.boundary.candidateReleaseCommit
    || authorization.runtimeBindingId !== binding.bindingId || claim.runtimeBindingId !== binding.bindingId
    || receipt.runtimeBindingId !== binding.bindingId || manifest.runtimeBindingId !== binding.bindingId
    || authorization.releaseProvenanceHash !== provenance || claim.releaseProvenanceHash !== provenance
    || receipt.releaseProvenanceHash !== provenance || manifest.releaseProvenanceHash !== provenance
    || authorization.releaseAuthorityApprovalId !== qualifiedRelease.releaseAuthorityApproval.approvalId
    || manifest.releaseAuthorityApprovalId !== qualifiedRelease.releaseAuthorityApproval.approvalId
    || authorization.releaseRoleManifestRoot !== qualifiedRelease.boundary.releaseRoleManifestRoot
    || manifest.releaseRoleManifestRoot !== qualifiedRelease.boundary.releaseRoleManifestRoot
    || authorization.boundaryRunnerEntrypointId !== qualifiedRelease.boundary.qualifiedRunnerEntrypointId
    || manifest.boundaryRunnerEntrypointId !== qualifiedRelease.boundary.qualifiedRunnerEntrypointId
    || authorization.boundaryRunnerClosureDigest !== qualifiedRelease.boundary.qualifiedRunnerClosureDigest
    || manifest.boundaryRunnerClosureDigest !== qualifiedRelease.boundary.qualifiedRunnerClosureDigest
    || authorization.boundaryRunnerImplementationExportDigest !== qualifiedRelease.boundary.qualifiedRunnerImplementationExportDigest
    || manifest.boundaryRunnerImplementationExportDigest !== qualifiedRelease.boundary.qualifiedRunnerImplementationExportDigest
    || Object.entries(expectedStore).some(([key, value]) => store.authority[key as keyof typeof store.authority] !== value)
    || store.observedStoreEpoch !== BigInt(binding.bindingId).toString(10)) {
    throw new TypeError("pre-release receipt, runner, staging manifest, claim, and observer store do not exact-join");
  }
}

function stagingArtifactRoles(name: PreReleaseStagingArtifactNameV1): readonly LegacyClosureRootRoleV1[] {
  if (["deployment-bundle.mjs", "deployment-composition.mjs", "pre-release-owner.mjs"].includes(name)) {
    return ["executable-loaded-object", "consumer-object-lineage"];
  }
  if (["release-intent.json", "release-authority-approval.json", "runtime-release-binding.json", "runtime-release-signer-pin.json", "staging-manifest.json"].includes(name)) {
    return ["release-intent", "consumer-object-lineage"];
  }
  if (name === "candidate-proof-verifier-binding.json") return ["consumer-object-lineage"];
  return ["deploy-manifest-systemd-exec", "consumer-object-lineage"];
}

async function buildAvailable(
  preRelease: PreReleaseAdvisoryMaterialProjectionV1,
  qualifiedRelease: ReturnType<typeof readQualifiedReleaseLineageObservationV1>,
  store: ReturnType<typeof readReleaseOwnedObserverStoreV1>,
  stagingArtifacts: ReadonlyMap<PreReleaseStagingArtifactNameV1, ObservedPreReleaseArtifactV1>,
  manifest: Manifest,
  boundary: RuntimeBoundaryProjectionV1,
): Promise<ProductionClosureRawObservationV1> {
  const repositoryRoot = preRelease.locators.repositoryRoot;
  const receipt = preRelease.processImportReceipt;
  const binding = qualifiedRelease.runtimeBinding;
  const runtimeClosures = boundary.implementationClosures.filter(
    closure => closure.closureDigest === binding.searcherRuntime.implementationClosureDigest,
  );
  if (manifest.candidateReleaseCommit !== boundary.candidate.candidateReleaseCommit
    || qualifiedRelease.boundary.candidateGitRoot !== repositoryRoot
    || qualifiedRelease.boundary.candidateReleaseCommit !== boundary.candidate.candidateReleaseCommit
    || manifest.releaseRoleManifestRoot !== boundary.candidate.releaseRoleManifestRoot
    || manifest.searcherRuntimeImplementationClosureDigest !== binding.searcherRuntime.implementationClosureDigest
    || runtimeClosures.length !== 1) {
    throw new TypeError("pre-release receipt and qualified release do not join exact staged Boundary projection");
  }
  const closures = boundary.implementationClosures;
  const paths = boundary.selectedFiles.map(file => file.path);
  const tracked = new Map<string, RuntimeBoundarySelectedFileV1>(boundary.selectedFiles.map(file => [file.path, file]));
  const edges = boundary.selectedEdges;
  const processes = currentProcessTree(receipt.processAnchor);
  const mainProcess = processes[0]!;
  assertReceiptHostAndProcessJoin(preRelease, mainProcess);
  const systemdProcessJoinBytes = observeSystemdProcessJoin(receipt, mainProcess);
  const systemdUnitBytes = stagingArtifacts.get("aloha-searcher-pre-release.service")!.bytes;
  const canonicalSystemdUnitBytes = new TextEncoder().encode(PRE_RELEASE_SYSTEMD_UNIT_V1);
  if (!sameBytes(systemdUnitBytes, canonicalSystemdUnitBytes)) {
    throw new TypeError("pre-release systemd unit bytes are not the canonical hardened unit");
  }
  if (sha256Hex(mainProcess.executableBytes) !== binding.searcherRuntime.nodeExecutableSha256
    || !mainProcess.argv.includes(receipt.entrypointPath)
    || !Buffer.from(systemdUnitBytes).toString("utf8").includes(receipt.entrypointPath)) {
    throw new TypeError("pre-release process, unit, and entrypoint do not exact-join receipt");
  }

  const databasePath = canonicalRegularPath(receipt.processEvidenceDatabasePath, "pre-release-runtime-sqlite");
  const databaseStat = statSync(databasePath, { bigint: true });
  if (databasePath !== receipt.processEvidenceDatabasePath
    || String(databaseStat.dev) !== receipt.databaseDevice
    || String(databaseStat.ino) !== receipt.databaseInode
    || receipt.databaseStoreIdentityHash !== hashDomain("aloha/pre-release-runtime-store-identity/v1", {
      authorizationId: receipt.authorizationId, databasePath,
      device: String(databaseStat.dev), inode: String(databaseStat.ino),
    })) throw new TypeError("pre-release runtime SQLite identity does not exact-join receipt");
  const storageBefore = runtimeStorageSet(databasePath);
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const integrity = database.prepare("PRAGMA integrity_check").all() as readonly { integrity_check?: unknown }[];
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") throw new TypeError("pre-release runtime SQLite integrity check failed");
  } finally { database.close(); }
  const runtimeStorage = runtimeStorageSet(databasePath);
  if (storageBefore.root !== runtimeStorage.root) throw new TypeError("pre-release runtime SQLite changed during observation");
  if (sha256Hex(runtimeStorage.main.bytes) !== receipt.databaseContentSha256) {
    throw new TypeError("pre-release runtime SQLite bytes do not exact-join receipt");
  }

  const logObserved = stableBytes(receipt.logPath, "pre-release-runtime-log", true);
  const logStat = statSync(logObserved.path, { bigint: true });
  const logStart = BigInt(decimalField(receipt.logStartInclusive, "pre-release log start"));
  const logEnd = BigInt(decimalField(receipt.logEndExclusive, "pre-release log end"));
  if (String(logStat.dev) !== receipt.logDevice || String(logStat.ino) !== receipt.logInode
    || logStart >= logEnd || logEnd > BigInt(logObserved.bytes.byteLength) || logEnd > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TypeError("pre-release log window identity or range does not exact-join receipt");
  }
  const logBytes = logObserved.bytes.slice(Number(logStart), Number(logEnd));
  if (sha256Hex(logBytes) !== receipt.logContentSha256) throw new TypeError("pre-release log bytes do not exact-join receipt");

  const builder = new DenominatorBuilder(store.sink);
  const rawByRepositoryPath = new Map<string, LegacyClosureRawArtifactV1>();
  for (const path of paths) {
    const file = tracked.get(path);
    if (file === undefined) throw new TypeError(`Boundary selected file is absent from Git denominator: ${path}`);
    const observed = stableBytes(join(repositoryRoot, path), `repository-source:${path}`);
    if (sha256Hex(observed.bytes) !== file.contentSha256 || observed.bytes.byteLength !== file.byteLength) throw new TypeError(`repository source changed after Boundary: ${path}`);
    rawByRepositoryPath.set(path, await builder.addArtifact({ logicalKey: repositoryLogicalKey(repositoryRoot, path, observed.path), bytes: observed.bytes, mediaType: mediaType(path), roles: roleForRepositoryPath(path) }));
  }
  const boundaryProjection = await builder.addArtifact({
    logicalKey: `candidate/neutral/boundary/${manifest.candidateReleaseCommit}`,
    bytes: stagingArtifacts.get("runtime-boundary-projection.json")!.bytes,
    mediaType: "application/json", schema: BOUNDARY_PROJECTION_SCHEMA,
    roles: ["release-intent", "ts-js-ast-module-closure", "generated-package-alias-closure", "worker-child-dynamic-entrypoint", "rust-binary-closure", "solidity-deployment-abi-ownership", "consumer-object-lineage"],
  });
  for (const edge of edges) {
    const source = rawByRepositoryPath.get(edge.from);
    const target = rawByRepositoryPath.get(edge.to) ?? null;
    if (source === undefined) throw new TypeError(`Boundary edge source is absent from selected raw closure: ${edge.from}`);
    builder.addEdge({ relation: "imports", source, target, targetLogicalKey: target?.logicalKey ?? `candidate/neutral/${edge.to}`, evidence: source, roles: [...new Set([...roleForRepositoryPath(edge.from), ...roleForRepositoryPath(edge.to)])] });
  }
  for (const closure of closures) {
    const artifact = rawByRepositoryPath.get(closure.entrypoint) ?? null;
    builder.addEntrypoint({ kind: closure.entrypoint.startsWith("runtime/revm-workers/") ? "worker-child" : "ts-js", logicalKey: artifact?.logicalKey ?? `candidate/neutral/${closure.entrypoint}`, artifact, evidence: artifact ?? boundaryProjection, roles: closure.entrypoint.startsWith("runtime/revm-workers/") ? ["worker-child-dynamic-entrypoint", "ts-js-ast-module-closure"] : ["ts-js-ast-module-closure"] });
  }

  const packaged = new Map<PreReleaseStagingArtifactNameV1, LegacyClosureRawArtifactV1>();
  for (const observed of stagingArtifacts.values()) packaged.set(observed.name, await builder.addArtifact({ logicalKey: externalLogicalKey(`pre-release-${observed.name}`, observed.bytes, observed.path), bytes: observed.bytes, mediaType: mediaType(observed.path), roles: stagingArtifactRoles(observed.name) }));
  const manifestArtifact = packaged.get("staging-manifest.json")!;
  for (const [name, artifact] of packaged) if (name !== "staging-manifest.json") builder.addEdge({ relation: name === "aloha-searcher-pre-release.service" ? "deploys" : "binds", source: manifestArtifact, target: artifact, targetLogicalKey: artifact.logicalKey, evidence: manifestArtifact, roles: stagingArtifactRoles(name) });

  const approvalBytes = stagingArtifacts.get("release-authority-approval.json")!.bytes;
  const approval = decodeSignedReleaseAuthorityApprovalV3(approvalBytes);
  const bindingBytes = stagingArtifacts.get("runtime-release-binding.json")!.bytes;
  const observedBinding = decodeRuntimeReleaseBindingV1(bindingBytes);
  const releaseClosures = boundary.releaseClosures;
  if (!sameBytes(approvalBytes, encodeSignedReleaseAuthorityApprovalV3(qualifiedRelease.releaseAuthorityApproval))
    || !sameBytes(bindingBytes, encodeRuntimeReleaseBindingV1(binding))
    || !sameBytes(approvalBytes, encodeSignedReleaseAuthorityApprovalV3(approval))
    || !sameBytes(bindingBytes, encodeRuntimeReleaseBindingV1(observedBinding))
    || approval.predicateCompositionRootDigest !== releaseClosures.predicateCompositionRootDigest
    || approval.candidateReleaseCommit !== boundary.candidate.candidateReleaseCommit
    || approval.gateCoreRuntimeClosureDigest !== releaseClosures.releaseRuntime.closureDigest
    || approval.gateCoreImplementationClosureDigest !== releaseClosures.genericCore.closureDigest
    || approval.releaseRoleManifestRoot !== releaseClosures.roleManifestRootDigest
    || boundary.candidate.releaseRoleManifestRoot !== releaseClosures.roleManifestRootDigest
    || boundary.candidate.releaseClosureRoot !== releaseClosures.rootDigest
    || qualifiedRelease.boundary.qualifiedRunnerEntrypointId !== releaseClosures.qualifiedRunner.entrypointId
    || qualifiedRelease.boundary.qualifiedRunnerClosureDigest !== releaseClosures.qualifiedRunner.closureDigest
    || qualifiedRelease.boundary.qualifiedRunnerImplementationExportDigest !== releaseClosures.qualifiedRunner.implementationExportDigest
    || manifest.launcherSha256 !== receipt.entrypointSha256
    || binding.searcherRuntime.bundleModuleSha256 !== receipt.bundleSha256
    || qualifiedRelease.runtimeSignerPinSha256 !== stagingArtifacts.get("runtime-release-signer-pin.json")!.contentSha256) {
    throw new TypeError("pre-release runner, approval, runtime binding, and Boundary closure were spliced");
  }
  const requirements = new Map(approval.releaseAcceptanceRequirements.map(value => [value.predicateId, value]));
  const sourceRequirement = requirements.get(SOURCE_PREDICATE_ID);
  const legacyRequirement = requirements.get(LEGACY_PREDICATE_ID);
  if (sourceRequirement === undefined || legacyRequirement === undefined) throw new TypeError("release authority approval does not bind both closure-zero predicates");

  const releaseIntentArtifact = packaged.get("release-intent.json")!;
  const releaseIntent = decodeReleaseIntent(decodeCanonicalJson(stagingArtifacts.get("release-intent.json")!.bytes));
  for (const entry of [...releaseIntent.families, ...releaseIntent.strategies]) {
    const target = resolveModuleArtifact(builder, entry.modulePath);
    builder.addEdge({ relation: "resolves-to", source: releaseIntentArtifact, target, targetLogicalKey: target?.logicalKey ?? `candidate/neutral/${entry.modulePath}`, evidence: releaseIntentArtifact, roles: ["release-intent"] });
    builder.addEntrypoint({ kind: "release-intent", logicalKey: target?.logicalKey ?? `candidate/neutral/${entry.modulePath}`, artifact: target, evidence: releaseIntentArtifact, roles: ["release-intent"] });
  }

  const restartProbeAuthorizationObserved = stableBytes(preRelease.locators.restartProbeAuthorizationPath, "pre-release-restart-probe-authorization", true);
  const qualificationFinalAuthorizationObserved = stableBytes(preRelease.locators.qualificationFinalAuthorizationPath, "pre-release-qualification-final-authorization", true);
  const restartProbeAuthorization = decodePreReleaseLaunchAuthorizationV1(decodeCanonicalJson(restartProbeAuthorizationObserved.bytes));
  const qualificationFinalAuthorization = decodePreReleaseLaunchAuthorizationV1(decodeCanonicalJson(qualificationFinalAuthorizationObserved.bytes));
  if (!sameBytes(restartProbeAuthorizationObserved.bytes, encodeCanonicalBytes(restartProbeAuthorization))
    || !sameBytes(qualificationFinalAuthorizationObserved.bytes, encodeCanonicalBytes(qualificationFinalAuthorization))
    || !sameBytes(qualificationFinalAuthorizationObserved.bytes, encodeCanonicalBytes(preRelease.signedAuthorization))
    || restartProbeAuthorization.roundRole !== "restart-probe" || restartProbeAuthorization.predecessor !== null
    || qualificationFinalAuthorization.roundRole !== "qualification-final"
    || qualificationFinalAuthorization.predecessor?.authorizationId !== restartProbeAuthorization.authorizationId
    || preRelease.authorizationClaim.predecessor?.authorizationId !== restartProbeAuthorization.authorizationId) {
    throw new TypeError("pre-release immutable A/B signed authorization lineage mismatch");
  }
  const claimLedgerBytes = observeAuthorizationClaimLedger(preRelease);
  const receiptBytes = encodeCanonicalBytes(receipt);
  const probeAuthorizationArtifact = await builder.addArtifact({ logicalKey: externalLogicalKey("pre-release-restart-probe-authorization", restartProbeAuthorizationObserved.bytes, preRelease.locators.restartProbeAuthorizationPath), bytes: restartProbeAuthorizationObserved.bytes, mediaType: "application/json", roles: ["release-intent", "consumer-object-lineage"] });
  const authorizationArtifact = await builder.addArtifact({ logicalKey: externalLogicalKey("pre-release-qualification-final-authorization", qualificationFinalAuthorizationObserved.bytes, preRelease.locators.qualificationFinalAuthorizationPath), bytes: qualificationFinalAuthorizationObserved.bytes, mediaType: "application/json", roles: ["release-intent", "consumer-object-lineage"] });
  const claimArtifact = await builder.addArtifact({ logicalKey: externalLogicalKey("pre-release-authorization-claim-ledger", claimLedgerBytes, preRelease.authorizationClaim.ledgerPath), bytes: claimLedgerBytes, mediaType: "application/vnd.sqlite3", roles: ["release-intent", "consumer-object-lineage"] });
  const receiptArtifact = await builder.addArtifact({ logicalKey: externalLogicalKey("pre-release-process-import-facts", receiptBytes, preRelease.locators.advisoryJudgmentPath), bytes: receiptBytes, mediaType: "application/json", roles: ["consumer-object-lineage", "runtime-log-window", "deploy-manifest-systemd-exec"] });
  builder.addEdge({ relation: "binds", source: probeAuthorizationArtifact, target: authorizationArtifact, targetLogicalKey: authorizationArtifact.logicalKey, evidence: authorizationArtifact, roles: ["release-intent", "consumer-object-lineage"] });
  builder.addEdge({ relation: "binds", source: authorizationArtifact, target: claimArtifact, targetLogicalKey: claimArtifact.logicalKey, evidence: claimArtifact, roles: ["release-intent", "consumer-object-lineage"] });
  builder.addEdge({ relation: "binds", source: claimArtifact, target: receiptArtifact, targetLogicalKey: receiptArtifact.logicalKey, evidence: receiptArtifact, roles: ["consumer-object-lineage"] });
  builder.addEdge({ relation: "binds", source: boundaryProjection, target: packaged.get("runtime-release-binding.json")!, targetLogicalKey: packaged.get("runtime-release-binding.json")!.logicalKey, evidence: boundaryProjection, roles: ["release-intent", "consumer-object-lineage"] });

  const databaseArtifact = await builder.addArtifact({ logicalKey: externalLogicalKey("pre-release-runtime-sqlite", runtimeStorage.main.bytes, runtimeStorage.main.path), bytes: runtimeStorage.main.bytes, mediaType: "application/vnd.sqlite3", roles: ["consumer-object-lineage", "runtime-log-window"] });
  builder.addEdge({ relation: "binds", source: receiptArtifact, target: databaseArtifact, targetLogicalKey: databaseArtifact.logicalKey, evidence: receiptArtifact, roles: ["consumer-object-lineage", "runtime-log-window"] });
  if (runtimeStorage.wal !== null) {
    const wal = await builder.addArtifact({ logicalKey: externalLogicalKey("pre-release-runtime-sqlite-wal", runtimeStorage.wal.bytes, runtimeStorage.wal.path), bytes: runtimeStorage.wal.bytes, mediaType: "application/octet-stream", roles: ["consumer-object-lineage", "runtime-log-window"] });
    builder.addEdge({ relation: "binds", source: databaseArtifact, target: wal, targetLogicalKey: wal.logicalKey, evidence: databaseArtifact, roles: ["consumer-object-lineage", "runtime-log-window"] });
  }
  const logArtifact = await builder.addArtifact({ logicalKey: externalLogicalKey("pre-release-runtime-log-window", logBytes, receipt.logPath), bytes: logBytes, mediaType: "text/plain", roles: ["runtime-log-window", "consumer-object-lineage"] });
  builder.addEntrypoint({ kind: "runtime-log-window", logicalKey: logArtifact.logicalKey, artifact: logArtifact, evidence: receiptArtifact, roles: ["runtime-log-window"] });
  builder.addEdge({ relation: "emits", source: receiptArtifact, target: logArtifact, targetLogicalKey: logArtifact.logicalKey, evidence: receiptArtifact, roles: ["runtime-log-window", "consumer-object-lineage"] });

  const processArtifacts = new Map<string, { executable: LegacyClosureRawArtifactV1; stat: LegacyClosureRawArtifactV1; cmdline: LegacyClosureRawArtifactV1; maps: LegacyClosureRawArtifactV1; cgroup: LegacyClosureRawArtifactV1 }>();
  for (const process of processes) {
    const isMain = process.pid === receipt.processAnchor.pid;
    const roles: readonly LegacyClosureRootRoleV1[] = isMain ? ["executable-loaded-object", "consumer-object-lineage", "deploy-manifest-systemd-exec"] : ["executable-loaded-object", "consumer-object-lineage", "worker-child-dynamic-entrypoint", "rust-binary-closure"];
    const executable = await builder.addArtifact({ logicalKey: externalLogicalKey(isMain ? "main-executable" : "child-executable", process.executableBytes, process.executablePath), bytes: process.executableBytes, mediaType: "application/octet-stream", roles });
    const stat = await builder.addArtifact({ logicalKey: externalLogicalKey(`process-${process.pid}-stat`, process.statBytes, "stat"), bytes: process.statBytes, mediaType: "text/plain", roles });
    const cmdline = await builder.addArtifact({ logicalKey: externalLogicalKey(`process-${process.pid}-cmdline`, process.cmdlineBytes, "cmdline"), bytes: process.cmdlineBytes, mediaType: "application/octet-stream", roles });
    const maps = await builder.addArtifact({ logicalKey: externalLogicalKey(`process-${process.pid}-maps`, process.mapsBytes, "maps"), bytes: process.mapsBytes, mediaType: "text/plain", roles: ["executable-loaded-object", "consumer-object-lineage"] });
    const cgroup = await builder.addArtifact({ logicalKey: externalLogicalKey(`process-${process.pid}-cgroup`, process.cgroupBytes, "cgroup"), bytes: process.cgroupBytes, mediaType: "text/plain", roles });
    processArtifacts.set(process.pid, { executable, stat, cmdline, maps, cgroup });
    builder.addEdge({ relation: "executes", source: cmdline, target: executable, targetLogicalKey: executable.logicalKey, evidence: cmdline, roles });
    builder.addEntrypoint({ kind: isMain ? "executable" : process.executablePath.includes("revm") ? "rust-binary" : "worker-child", logicalKey: executable.logicalKey, artifact: executable, evidence: cmdline, roles });
    for (const mapping of process.executableMappings) {
      const loaded = await builder.addArtifact({ logicalKey: externalLogicalKey("loaded-object", mapping.bytes, mapping.path), bytes: mapping.bytes, mediaType: "application/octet-stream", roles: ["executable-loaded-object", "consumer-object-lineage"] });
      builder.addEdge({ relation: "loads", source: executable, target: loaded, targetLogicalKey: loaded.logicalKey, evidence: maps, roles: ["executable-loaded-object", "consumer-object-lineage"] });
    }
  }
  for (const process of processes.slice(1)) {
    const parent = processArtifacts.get(process.parentPid); const child = processArtifacts.get(process.pid)!;
    if (parent === undefined) throw new TypeError("runtime child parent artifact is missing");
    builder.addEdge({ relation: "spawns", source: parent.executable, target: child.executable, targetLogicalKey: child.executable.logicalKey, evidence: child.stat, roles: ["worker-child-dynamic-entrypoint", "consumer-object-lineage"] });
  }
  const main = processArtifacts.get(receipt.processAnchor.pid)!;
  const unit = packaged.get("aloha-searcher-pre-release.service")!;
  const entrypoint = packaged.get("pre-release-owner.mjs")!;
  const runtimeBundle = packaged.get("deployment-bundle.mjs")!;
  const systemdJoin = await builder.addArtifact({ logicalKey: externalLogicalKey("pre-release-systemd-process-join", systemdProcessJoinBytes, receipt.systemdUnit), bytes: systemdProcessJoinBytes, mediaType: "application/json", roles: ["deploy-manifest-systemd-exec", "consumer-object-lineage"] });
  builder.addEdge({ relation: "binds", source: systemdJoin, target: main.cgroup, targetLogicalKey: main.cgroup.logicalKey, evidence: systemdJoin, roles: ["deploy-manifest-systemd-exec", "consumer-object-lineage"] });
  builder.addEdge({ relation: "executes", source: unit, target: main.executable, targetLogicalKey: main.executable.logicalKey, evidence: systemdJoin, roles: ["deploy-manifest-systemd-exec", "executable-loaded-object", "consumer-object-lineage"] });
  builder.addEdge({ relation: "executes", source: main.cmdline, target: entrypoint, targetLogicalKey: entrypoint.logicalKey, evidence: receiptArtifact, roles: ["deploy-manifest-systemd-exec", "consumer-object-lineage"] });
  builder.addEdge({ relation: "loads", source: entrypoint, target: runtimeBundle, targetLogicalKey: runtimeBundle.logicalKey, evidence: receiptArtifact, roles: ["executable-loaded-object", "consumer-object-lineage"] });
  builder.addEdge({ relation: "binds", source: receiptArtifact, target: main.executable, targetLogicalKey: main.executable.logicalKey, evidence: receiptArtifact, roles: ["consumer-object-lineage"] });
  builder.addEntrypoint({ kind: "systemd-exec", logicalKey: main.executable.logicalKey, artifact: main.executable, evidence: unit, roles: ["deploy-manifest-systemd-exec"] });
  builder.addEntrypoint({ kind: "consumer", logicalKey: receiptArtifact.logicalKey, artifact: receiptArtifact, evidence: receiptArtifact, roles: ["consumer-object-lineage"] });

  const facts = await builder.facts([sourceRequirement.predicateSpecDigest, legacyRequirement.predicateSpecDigest], [sourceRequirement.verifierCertificateId, legacyRequirement.verifierCertificateId]);
  return Object.freeze({ status: "available" as const, candidateReleaseCommit: manifest.candidateReleaseCommit, artifacts: Object.freeze(builder.providerArtifacts), facts });
}

export async function observeProductionClosureRawFactsV1(input: ProductionClosureRawObserverInputV1): Promise<ProductionClosureRawObservationV1> {
  try {
    if (input === null || typeof input !== "object") throw new TypeError("production closure raw observer input has non-exact fields");
    const inputKeys = Reflect.ownKeys(input);
    const expectedInputKeys = [
      "preReleaseAdvisoryMaterial", "qualifiedReleaseRunner", "observerStore",
    ];
    if (inputKeys.length !== expectedInputKeys.length
      || inputKeys.some(key => typeof key !== "string" || !expectedInputKeys.includes(key))) {
      throw new TypeError("production closure raw observer input has non-exact fields");
    }
    const preRelease = readPreReleaseAdvisoryMaterialCapabilityV1(input.preReleaseAdvisoryMaterial);
    const qualifiedRelease = readQualifiedReleaseLineageObservationV1(input.qualifiedReleaseRunner);
    const store = readReleaseOwnedObserverStoreV1(input.observerStore);
    const repositoryRoot = absoluteField(preRelease.locators.repositoryRoot, "production closure repository root");
    if (!existsSync(repositoryRoot) || realpathSync(repositoryRoot) !== repositoryRoot || !lstatSync(repositoryRoot).isDirectory()) throw new TypeError("production closure repository root is not canonical");
    const stagingArtifacts = observePreReleaseArtifacts(preRelease);
    const manifestObserved = stagingArtifacts.get("staging-manifest.json")!;
    const manifest = decodeManifest(manifestObserved.bytes, preRelease.stagingManifestRoot);
    assertPreReleaseDenominator(preRelease, qualifiedRelease, store, manifest, stagingArtifacts);
    const projectionObserved = stagingArtifacts.get("runtime-boundary-projection.json")!;
    if (projectionObserved.contentSha256 !== manifest.runtimeBoundaryProjectionSha256) {
      throw new TypeError("runtime Boundary projection bytes do not exact-join staging manifest");
    }
    const boundary = decodeRuntimeBoundaryProjectionV1(projectionObserved.bytes);
    const stagedProductionLauncher = stagingArtifacts.get("production-launcher.mjs")!;
    const projectedProductionLauncher = boundary.selectedFiles.find(
      file => file.path === "tools/runtime-release-packager/assets/production-launcher.mjs",
    );
    if (projectedProductionLauncher === undefined
      || projectedProductionLauncher.contentSha256 !== stagedProductionLauncher.contentSha256
      || projectedProductionLauncher.byteLength !== stagedProductionLauncher.bytes.byteLength) {
      throw new TypeError("staged production launcher does not exact-join pushed Boundary projection source");
    }
    return await buildAvailable(preRelease, qualifiedRelease, store, stagingArtifacts, manifest, boundary);
  } catch (error) {
    if (error instanceof MissingObservation) return Object.freeze({ status: "missing" as const, reasons: Object.freeze([...error.reasons]), evidence: error.evidence });
    return Object.freeze({ status: "invalid" as const, reasons: Object.freeze([error instanceof Error ? error.message : "production-closure-observation-failed"]), evidence: null });
  }
}
