import {
  decodeCanonicalJson,
  encodeCanonicalBytes,
  hashDomain,
  type CanonicalJson,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";

export interface RuntimeBoundaryProjectionCandidateV1 {
  readonly candidateReleaseCommit: string;
  readonly branch: string;
  readonly upstreamRef: string;
  readonly remoteRef: string;
  readonly headSha: string;
  readonly upstreamSha: string;
  readonly remoteSha: string;
  readonly pushed: true;
  readonly scannedFileSetRoot: Hash;
  readonly boundaryManifestRoot: Hash;
  readonly compilerVersionRoot: Hash;
  readonly compilerConfigRoot: Hash;
  readonly compilerGraphRoot: Hash;
  readonly packageManifestRoot: Hash;
  readonly externalDependencyRoot: Hash;
  readonly languageBuildRoot: Hash;
  readonly releaseRoleManifestRoot: Hash;
  readonly releaseClosureRoot: Hash;
}

export interface RuntimeBoundaryImplementationClosureV1 {
  readonly entrypoint: string;
  readonly entrypointId: string;
  readonly kind: "compiler-root" | "package-entrypoint";
  readonly packageName: string | null;
  readonly packageManifestPath: string | null;
  readonly configPath: string;
  readonly tsconfigRoot: Hash;
  readonly optionsRoot: Hash;
  readonly programInputSetRoot: Hash;
  readonly closureDigest: Hash;
}

export interface RuntimeBoundarySelectedFileV1 {
  readonly path: string;
  readonly mode: string;
  readonly blobSha: string;
  readonly contentSha256: Hash;
  readonly byteLength: number;
  readonly language: "typescript" | "javascript" | "rust" | "solidity" | "metadata";
  readonly fileClass:
    | "acceptance-pure-core"
    | "acceptance-collector"
    | "central"
    | "production-runtime"
    | "family"
    | "strategy"
    | "authoring"
    | "generated"
    | "reference-only"
    | "metadata";
}

export interface RuntimeBoundarySelectedEdgeV1 {
  readonly from: string;
  readonly to: string;
  readonly specifier: string;
  readonly resolutionMode?: "import" | "require";
}

export interface RuntimeBoundaryReleaseClosureRefV1 {
  readonly role: "generic-core" | "qualified-runner" | "predicate-adapter" | "qualification-oracle" | "material-provider" | "release-runtime";
  readonly entrypointId: string;
  readonly entrypoint: string;
  readonly modulePath: string;
  readonly exportName: string;
  readonly predicateId: string | null;
  readonly predicateSpecDigest: string | null;
  readonly predicateProgramDescriptorDigest: string | null;
  readonly oracleProgramDescriptorDigest: string | null;
  readonly adapterVersion: string | null;
  readonly oracleVersion: string | null;
  readonly compositionLeafDigest: string | null;
  readonly commonEnvelopeRoleContractVersion: string | null;
  readonly materialProviderContractDigest: string | null;
  readonly implementationExportDigest: string | null;
  readonly closureDigest: Hash;
  readonly programInputSetRoot: Hash;
}

export interface RuntimeBoundaryReleaseClosuresV1 {
  readonly schemaVersion: 1;
  readonly genericCore: RuntimeBoundaryReleaseClosureRefV1;
  readonly qualifiedRunner: RuntimeBoundaryReleaseClosureRefV1;
  readonly predicateAdapters: readonly RuntimeBoundaryReleaseClosureRefV1[];
  readonly qualificationOracles: readonly RuntimeBoundaryReleaseClosureRefV1[];
  readonly materialProviders: readonly RuntimeBoundaryReleaseClosureRefV1[];
  readonly releaseRuntime: RuntimeBoundaryReleaseClosureRefV1;
  readonly predicateCompositionRootDigest: Hash;
  readonly commonEnvelopeRoleContractVersion: string;
  readonly roleManifestRootDigest: Hash;
  readonly rootDigest: Hash;
}

export interface RuntimeBoundaryProjectionPayloadV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.runtime-boundary-projection";
  readonly candidate: RuntimeBoundaryProjectionCandidateV1;
  readonly implementationClosures: readonly RuntimeBoundaryImplementationClosureV1[];
  readonly selectedFiles: readonly RuntimeBoundarySelectedFileV1[];
  readonly selectedEdges: readonly RuntimeBoundarySelectedEdgeV1[];
  /** Exact pure data emitted by the Rust/Solidity build adapters. */
  readonly languageBuild: CanonicalJson;
  readonly releaseClosures: RuntimeBoundaryReleaseClosuresV1;
}

export interface RuntimeBoundaryProjectionV1 extends RuntimeBoundaryProjectionPayloadV1 {
  readonly projectionRoot: Hash;
}

type RecordValue = Record<string, unknown>;

function record(value: unknown, path: string): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${path} must be an object`);
  return value as RecordValue;
}

function exact(value: RecordValue, keys: readonly string[], path: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${path} must have exact fields`);
  }
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${path} must be a non-empty string`);
  return value;
}

function nullableString(value: unknown, path: string): string | null {
  return value === null ? null : string(value, path);
}

function hash(value: unknown, path: string): Hash {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/.test(value)) throw new TypeError(`${path} must be a hash`);
  return value as Hash;
}

function gitSha(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) throw new TypeError(`${path} must be a Git SHA-1`);
  return value;
}

function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  return value;
}

function oneOf<T extends string>(value: unknown, values: readonly T[], path: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new TypeError(`${path} has an invalid value`);
  return value as T;
}

function candidate(value: unknown): RuntimeBoundaryProjectionCandidateV1 {
  const item = record(value, "$.candidate");
  exact(item, ["candidateReleaseCommit", "branch", "upstreamRef", "remoteRef", "headSha", "upstreamSha", "remoteSha", "pushed", "scannedFileSetRoot", "boundaryManifestRoot", "compilerVersionRoot", "compilerConfigRoot", "compilerGraphRoot", "packageManifestRoot", "externalDependencyRoot", "languageBuildRoot", "releaseRoleManifestRoot", "releaseClosureRoot"], "$.candidate");
  if (item.pushed !== true) throw new TypeError("$.candidate.pushed must equal true");
  const branch = string(item.branch, "$.candidate.branch");
  const candidateReleaseCommit = gitSha(item.candidateReleaseCommit, "$.candidate.candidateReleaseCommit");
  const headSha = gitSha(item.headSha, "$.candidate.headSha");
  const upstreamSha = gitSha(item.upstreamSha, "$.candidate.upstreamSha");
  const remoteSha = gitSha(item.remoteSha, "$.candidate.remoteSha");
  if (candidateReleaseCommit !== headSha || headSha !== upstreamSha || headSha !== remoteSha
    || item.upstreamRef !== `refs/remotes/origin/${branch}` || item.remoteRef !== `refs/heads/${branch}`) {
    throw new TypeError("$.candidate pushed Git identity mismatch");
  }
  return Object.freeze({
    candidateReleaseCommit,
    branch,
    upstreamRef: string(item.upstreamRef, "$.candidate.upstreamRef"),
    remoteRef: string(item.remoteRef, "$.candidate.remoteRef"),
    headSha,
    upstreamSha,
    remoteSha,
    pushed: true as const,
    scannedFileSetRoot: hash(item.scannedFileSetRoot, "$.candidate.scannedFileSetRoot"),
    boundaryManifestRoot: hash(item.boundaryManifestRoot, "$.candidate.boundaryManifestRoot"),
    compilerVersionRoot: hash(item.compilerVersionRoot, "$.candidate.compilerVersionRoot"),
    compilerConfigRoot: hash(item.compilerConfigRoot, "$.candidate.compilerConfigRoot"),
    compilerGraphRoot: hash(item.compilerGraphRoot, "$.candidate.compilerGraphRoot"),
    packageManifestRoot: hash(item.packageManifestRoot, "$.candidate.packageManifestRoot"),
    externalDependencyRoot: hash(item.externalDependencyRoot, "$.candidate.externalDependencyRoot"),
    languageBuildRoot: hash(item.languageBuildRoot, "$.candidate.languageBuildRoot"),
    releaseRoleManifestRoot: hash(item.releaseRoleManifestRoot, "$.candidate.releaseRoleManifestRoot"),
    releaseClosureRoot: hash(item.releaseClosureRoot, "$.candidate.releaseClosureRoot"),
  });
}

function implementationClosure(value: unknown, index: number): RuntimeBoundaryImplementationClosureV1 {
  const path = `$.implementationClosures[${index}]`;
  const item = record(value, path);
  exact(item, ["entrypoint", "entrypointId", "kind", "packageName", "packageManifestPath", "configPath", "tsconfigRoot", "optionsRoot", "programInputSetRoot", "closureDigest"], path);
  return Object.freeze({
    entrypoint: string(item.entrypoint, `${path}.entrypoint`),
    entrypointId: string(item.entrypointId, `${path}.entrypointId`),
    kind: oneOf(item.kind, ["compiler-root", "package-entrypoint"] as const, `${path}.kind`),
    packageName: nullableString(item.packageName, `${path}.packageName`),
    packageManifestPath: nullableString(item.packageManifestPath, `${path}.packageManifestPath`),
    configPath: string(item.configPath, `${path}.configPath`),
    tsconfigRoot: hash(item.tsconfigRoot, `${path}.tsconfigRoot`),
    optionsRoot: hash(item.optionsRoot, `${path}.optionsRoot`),
    programInputSetRoot: hash(item.programInputSetRoot, `${path}.programInputSetRoot`),
    closureDigest: hash(item.closureDigest, `${path}.closureDigest`),
  });
}

const LANGUAGES = ["typescript", "javascript", "rust", "solidity", "metadata"] as const;
const FILE_CLASSES = ["acceptance-pure-core", "acceptance-collector", "central", "production-runtime", "family", "strategy", "authoring", "generated", "reference-only", "metadata"] as const;

function selectedFile(value: unknown, index: number): RuntimeBoundarySelectedFileV1 {
  const path = `$.selectedFiles[${index}]`;
  const item = record(value, path);
  exact(item, ["path", "mode", "blobSha", "contentSha256", "byteLength", "language", "fileClass"], path);
  if (typeof item.byteLength !== "number" || !Number.isSafeInteger(item.byteLength) || item.byteLength < 0) throw new TypeError(`${path}.byteLength must be a non-negative safe integer`);
  return Object.freeze({
    path: string(item.path, `${path}.path`),
    mode: oneOf(item.mode, ["100644", "100755"] as const, `${path}.mode`),
    blobSha: gitSha(item.blobSha, `${path}.blobSha`),
    contentSha256: hash(item.contentSha256, `${path}.contentSha256`),
    byteLength: item.byteLength,
    language: oneOf(item.language, LANGUAGES, `${path}.language`),
    fileClass: oneOf(item.fileClass, FILE_CLASSES, `${path}.fileClass`),
  });
}

function selectedEdge(value: unknown, index: number): RuntimeBoundarySelectedEdgeV1 {
  const path = `$.selectedEdges[${index}]`;
  const item = record(value, path);
  const hasMode = Object.hasOwn(item, "resolutionMode");
  exact(item, hasMode ? ["from", "to", "specifier", "resolutionMode"] : ["from", "to", "specifier"], path);
  return Object.freeze({
    from: string(item.from, `${path}.from`),
    to: string(item.to, `${path}.to`),
    specifier: string(item.specifier, `${path}.specifier`),
    ...(hasMode ? { resolutionMode: oneOf(item.resolutionMode, ["import", "require"] as const, `${path}.resolutionMode`) } : {}),
  });
}

const RELEASE_ROLES = ["generic-core", "qualified-runner", "predicate-adapter", "qualification-oracle", "material-provider", "release-runtime"] as const;

function closureRef(value: unknown, path: string): RuntimeBoundaryReleaseClosureRefV1 {
  const item = record(value, path);
  exact(item, ["role", "entrypointId", "entrypoint", "modulePath", "exportName", "predicateId", "predicateSpecDigest", "predicateProgramDescriptorDigest", "oracleProgramDescriptorDigest", "adapterVersion", "oracleVersion", "compositionLeafDigest", "commonEnvelopeRoleContractVersion", "materialProviderContractDigest", "implementationExportDigest", "closureDigest", "programInputSetRoot"], path);
  return Object.freeze({
    role: oneOf(item.role, RELEASE_ROLES, `${path}.role`),
    entrypointId: string(item.entrypointId, `${path}.entrypointId`),
    entrypoint: string(item.entrypoint, `${path}.entrypoint`),
    modulePath: string(item.modulePath, `${path}.modulePath`),
    exportName: string(item.exportName, `${path}.exportName`),
    predicateId: nullableString(item.predicateId, `${path}.predicateId`),
    predicateSpecDigest: nullableString(item.predicateSpecDigest, `${path}.predicateSpecDigest`),
    predicateProgramDescriptorDigest: nullableString(item.predicateProgramDescriptorDigest, `${path}.predicateProgramDescriptorDigest`),
    oracleProgramDescriptorDigest: nullableString(item.oracleProgramDescriptorDigest, `${path}.oracleProgramDescriptorDigest`),
    adapterVersion: nullableString(item.adapterVersion, `${path}.adapterVersion`),
    oracleVersion: nullableString(item.oracleVersion, `${path}.oracleVersion`),
    compositionLeafDigest: nullableString(item.compositionLeafDigest, `${path}.compositionLeafDigest`),
    commonEnvelopeRoleContractVersion: nullableString(item.commonEnvelopeRoleContractVersion, `${path}.commonEnvelopeRoleContractVersion`),
    materialProviderContractDigest: nullableString(item.materialProviderContractDigest, `${path}.materialProviderContractDigest`),
    implementationExportDigest: nullableString(item.implementationExportDigest, `${path}.implementationExportDigest`),
    closureDigest: hash(item.closureDigest, `${path}.closureDigest`),
    programInputSetRoot: hash(item.programInputSetRoot, `${path}.programInputSetRoot`),
  });
}

function releaseClosures(value: unknown): RuntimeBoundaryReleaseClosuresV1 {
  const item = record(value, "$.releaseClosures");
  exact(item, ["schemaVersion", "genericCore", "qualifiedRunner", "predicateAdapters", "qualificationOracles", "materialProviders", "releaseRuntime", "predicateCompositionRootDigest", "commonEnvelopeRoleContractVersion", "roleManifestRootDigest", "rootDigest"], "$.releaseClosures");
  if (item.schemaVersion !== 1) throw new TypeError("$.releaseClosures.schemaVersion must equal 1");
  const refs = (name: "predicateAdapters" | "qualificationOracles" | "materialProviders") => Object.freeze(array(item[name], `$.releaseClosures.${name}`).map((entry, index) => closureRef(entry, `$.releaseClosures.${name}[${index}]`)));
  return Object.freeze({
    schemaVersion: 1,
    genericCore: closureRef(item.genericCore, "$.releaseClosures.genericCore"),
    qualifiedRunner: closureRef(item.qualifiedRunner, "$.releaseClosures.qualifiedRunner"),
    predicateAdapters: refs("predicateAdapters"),
    qualificationOracles: refs("qualificationOracles"),
    materialProviders: refs("materialProviders"),
    releaseRuntime: closureRef(item.releaseRuntime, "$.releaseClosures.releaseRuntime"),
    predicateCompositionRootDigest: hash(item.predicateCompositionRootDigest, "$.releaseClosures.predicateCompositionRootDigest"),
    commonEnvelopeRoleContractVersion: string(item.commonEnvelopeRoleContractVersion, "$.releaseClosures.commonEnvelopeRoleContractVersion"),
    roleManifestRootDigest: hash(item.roleManifestRootDigest, "$.releaseClosures.roleManifestRootDigest"),
    rootDigest: hash(item.rootDigest, "$.releaseClosures.rootDigest"),
  });
}

function sortedUnique<T>(values: readonly T[], key: (value: T) => string, path: string): void {
  for (let index = 1; index < values.length; index += 1) {
    if (key(values[index - 1]!) >= key(values[index]!)) throw new TypeError(`${path} must be strictly sorted and unique`);
  }
}

export function runtimeBoundaryProjectionRootV1(payload: RuntimeBoundaryProjectionPayloadV1): Hash {
  return hashDomain("aloha/runtime-boundary-projection/root/v1", payload);
}

export function decodeRuntimeBoundaryProjectionV1(value: string | Uint8Array | object): RuntimeBoundaryProjectionV1 {
  const decoded = decodeCanonicalJson(typeof value === "string" || ArrayBuffer.isView(value)
    ? value as string | Uint8Array
    : encodeCanonicalBytes(value));
  const item = record(decoded, "$");
  exact(item, ["schemaVersion", "kind", "candidate", "implementationClosures", "selectedFiles", "selectedEdges", "languageBuild", "releaseClosures", "projectionRoot"], "$");
  if (item.schemaVersion !== 1 || item.kind !== "aloha.runtime-boundary-projection") throw new TypeError("runtime boundary projection identity mismatch");
  const implementationClosures = Object.freeze(array(item.implementationClosures, "$.implementationClosures").map(implementationClosure));
  const selectedFiles = Object.freeze(array(item.selectedFiles, "$.selectedFiles").map(selectedFile));
  const selectedEdges = Object.freeze(array(item.selectedEdges, "$.selectedEdges").map(selectedEdge));
  const languageBuildRecord = record(item.languageBuild, "$.languageBuild");
  exact(languageBuildRecord, ["rust", "solidity", "rootDigest"], "$.languageBuild");
  const languageBuildRoot = hash(languageBuildRecord.rootDigest, "$.languageBuild.rootDigest");
  const result = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.runtime-boundary-projection" as const,
    candidate: candidate(item.candidate),
    implementationClosures,
    selectedFiles,
    selectedEdges,
    languageBuild: decoded && item.languageBuild as CanonicalJson,
    releaseClosures: releaseClosures(item.releaseClosures),
    projectionRoot: hash(item.projectionRoot, "$.projectionRoot"),
  });
  sortedUnique(result.implementationClosures, entry => entry.entrypointId, "$.implementationClosures");
  sortedUnique(result.selectedFiles, entry => entry.path, "$.selectedFiles");
  sortedUnique(result.selectedEdges, entry => `${entry.from}\0${entry.to}\0${entry.specifier}\0${entry.resolutionMode ?? ""}`, "$.selectedEdges");
  const selectedPaths = new Set(result.selectedFiles.map(file => file.path));
  for (const edge of result.selectedEdges) {
    if (!selectedPaths.has(edge.from) || !selectedPaths.has(edge.to)) {
      throw new TypeError(`runtime boundary edge is outside selected files: ${edge.from} -> ${edge.to}`);
    }
  }
  for (const closure of result.implementationClosures) {
    if (!selectedPaths.has(closure.entrypoint) || !selectedPaths.has(closure.configPath)
      || (closure.packageManifestPath !== null && !selectedPaths.has(closure.packageManifestPath))) {
      throw new TypeError(`runtime boundary closure paths are absent from selected files: ${closure.entrypointId}`);
    }
  }
  const release = result.releaseClosures;
  if (release.genericCore.role !== "generic-core"
    || release.qualifiedRunner.role !== "qualified-runner"
    || release.releaseRuntime.role !== "release-runtime"
    || release.predicateAdapters.some(ref => ref.role !== "predicate-adapter")
    || release.qualificationOracles.some(ref => ref.role !== "qualification-oracle")
    || release.materialProviders.some(ref => ref.role !== "material-provider")) {
    throw new TypeError("runtime boundary release closure roles are invalid");
  }
  if (release.predicateAdapters.length !== release.qualificationOracles.length
    || release.predicateAdapters.length !== release.materialProviders.length
    || release.predicateAdapters.some((ref, index) => ref.predicateId === null
      || release.qualificationOracles[index]!.predicateId !== ref.predicateId
      || release.materialProviders[index]!.predicateId !== ref.predicateId)) {
    throw new TypeError("runtime boundary predicate release closure denominator is misaligned");
  }
  const closureById = new Map(result.implementationClosures.map(closure => [closure.entrypointId, closure]));
  const releaseRefs = [
    release.genericCore,
    release.qualifiedRunner,
    release.releaseRuntime,
    ...release.predicateAdapters,
    ...release.qualificationOracles,
    ...release.materialProviders,
  ];
  for (const ref of releaseRefs) {
    const closure = closureById.get(ref.entrypointId);
    if (closure === undefined || closure.entrypoint !== ref.entrypoint
      || closure.closureDigest !== ref.closureDigest
      || closure.programInputSetRoot !== ref.programInputSetRoot) {
      throw new TypeError(`runtime boundary release ref does not match selected closure: ${ref.entrypointId}`);
    }
  }
  if (result.candidate.languageBuildRoot !== languageBuildRoot
    || result.candidate.releaseRoleManifestRoot !== result.releaseClosures.roleManifestRootDigest
    || result.candidate.releaseClosureRoot !== result.releaseClosures.rootDigest) {
    throw new TypeError("runtime boundary projection roots do not exact-join payload");
  }
  const { projectionRoot: _projectionRoot, ...payload } = result;
  if (runtimeBoundaryProjectionRootV1(payload) !== result.projectionRoot) throw new TypeError("runtime boundary projection root mismatch");
  return result;
}
