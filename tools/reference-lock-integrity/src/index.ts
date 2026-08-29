import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { dirname, join, relative, resolve, sep } from "node:path";
import * as ts from "typescript";
import { decodeCanonicalJson, encodeCanonicalJson, hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import {
  classifyBoundaryPathV1,
  collectCatalogCompilerBoundaryProjection,
  computeProgramInputSetRoot,
  recomputeImplementationClosureDigest,
  type CatalogCompilerBoundaryProjectionV1,
  type ImplementationClosure,
} from "../../architecture-boundaries/src/index.ts";
import {
  computeReceiptSetRoot, computeReferenceLockRoot, computeReuseLedgerRoot, computeReuseReceiptId,
  decodeReferenceLock, decodeReuseLedger, decodeReuseReceiptSet,
  REFERENCE_COMMIT, REFERENCE_REPOSITORY_ID, REUSE_AUTHORITY_SCHEMA_VERSION,
  type AuthorityManifestV2, type CompilerAuthorityV2, type DestinationAuthorityV2,
  type EvidenceAuthorityV2, type ReferenceLockV2, type ReuseLedgerEntryV2, type ReuseLedgerV2,
  type ReuseReceiptSetV2, type ReuseReceiptV2, type SourceLockV2,
} from "../../../specs/reuse-ledger/src/index.ts";
import {
  CURRENT_REUSE_DECLARATIONS, EVIDENCE_REQUIREMENT_MODULE_PATH, REQUIRED_AUDIT_ENTRY_COUNT,
  REQUIRED_AUDIT_ENTRY_IDS, REQUIRED_AUDIT_ENTRY_SET_DOMAIN, REQUIRED_AUDIT_ENTRY_SET_ROOT,
} from "../../../specs/reuse-ledger/src/current-ledger.ts";
import * as evidenceRequirements from "../../../specs/reuse-ledger/src/evidence-requirements.ts";
import {
  SNAPSHOT_GIT_EXECUTABLE_PATH,
  activeSnapshotGitIdentityV1,
  activeSnapshotInstallerIdentityV1,
  snapshotGitEnvironmentV1,
} from "./index-snapshot.ts";

export const GENERATED_AUTHORITY_PATHS = Object.freeze([
  "generated/authority/reference-lock.json",
  "generated/authority/reuse-ledger.yaml",
  "generated/authority/reuse-receipts.json",
  "generated/authority/authority-manifest.json",
]);
const PAYLOAD_PATHS = GENERATED_AUTHORITY_PATHS.slice(0, 3);
const GENERATOR_ENTRYPOINT_PATHS = Object.freeze([
  "tools/reference-lock-integrity/src/cli.ts",
  "tools/reference-lock-integrity/src/runtime-cli.ts",
  "tools/reference-lock-integrity/src/index.ts",
  "tools/reference-lock-integrity/src/index-snapshot.ts",
]);

export interface GenerateAuthorityOptions { readonly repoPath: string; readonly referenceRepoPath: string }
export interface GeneratedAuthorityArtifacts { readonly referenceLock: ReferenceLockV2; readonly ledger: ReuseLedgerV2; readonly receiptSet: ReuseReceiptSetV2; readonly manifest: AuthorityManifestV2; readonly bytes: ReadonlyMap<string, string> }
export interface IntegrityCheckV2 { readonly id: string; readonly status: "pass" | "invalid"; readonly detail: string }
export interface IntegrityReportV2 { readonly kind: "aloha.reference-lock-integrity-report"; readonly schemaVersion: 2; readonly verdict: "pass" | "invalid"; readonly checks: readonly IntegrityCheckV2[]; readonly artifactSetRoot: Hash | null }

interface CanonicalGenerationStateV1 {
  readonly repoPath: string;
  readonly referenceRepoPath: string;
  readonly stageTree: string;
  readonly modulePaths: readonly string[];
  readonly projection: CatalogCompilerBoundaryProjectionV1;
  readonly installerIdentity: ReturnType<typeof activeSnapshotInstallerIdentityV1>;
  readonly gitIdentity: ReturnType<typeof activeSnapshotGitIdentityV1>;
  readonly artifactBytes: readonly (readonly [string, string])[];
  readonly artifactSetRoot: Hash;
}

const canonicalGenerations = new WeakMap<object, CanonicalGenerationStateV1>();

const sha256 = (value: string | Uint8Array): Hash => `0x${createHash("sha256").update(value).digest("hex")}` as Hash;
const canonicalBytes = (value: unknown): string => encodeCanonicalJson(value);
const sorted = <T>(values: readonly T[], key: (value: T) => string): readonly T[] => Object.freeze([...values].sort((left, right) => key(left).localeCompare(key(right))));
const check = (id: string, status: "pass" | "invalid", detail: string): IntegrityCheckV2 => Object.freeze({ id, status, detail });

function git(repoPath: string, args: readonly string[]): string {
  return execFileSync(SNAPSHOT_GIT_EXECUTABLE_PATH, ["-C", repoPath, ...args], { encoding: "utf8", env: snapshotGitEnvironmentV1(), stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function gitShow(repoPath: string, commit: string, path: string): string {
  return execFileSync(SNAPSHOT_GIT_EXECUTABLE_PATH, ["-C", repoPath, "show", `${commit}:${path}`], { encoding: "utf8", env: snapshotGitEnvironmentV1(), stdio: ["ignore", "pipe", "pipe"] });
}
function fileText(repoPath: string, path: string): string { return readFileSync(resolve(repoPath, path), "utf8"); }
function rawSlice(text: string, startLine: number, endLine: number): string {
  const lines = text.split("\n");
  if (startLine < 1 || endLine < startLine || endLine > (text.endsWith("\n") ? lines.length - 1 : lines.length)) throw new TypeError(`source range ${startLine}-${endLine} is outside file`);
  return lines.slice(startLine - 1, endLine).join("\n");
}

function selectCompilerAuthority(projection: CatalogCompilerBoundaryProjectionV1, modulePath: string): CompilerAuthorityV2 {
  const matches = projection.implementationClosures.filter(closure => closure.kind === "compiler-root" && closure.entrypoint === modulePath);
  if (matches.length !== 1) throw new TypeError(`exact compiler-root entrypoint required for ${modulePath}; found ${matches.length}`);
  const closure = matches[0]!;
  if (recomputeImplementationClosureDigest(closure) !== closure.closureDigest) throw new TypeError(`compiler closure digest mismatch ${modulePath}`);
  if (computeProgramInputSetRoot(closure.programInputs) !== closure.programInputSetRoot) throw new TypeError(`compiler input root mismatch ${modulePath}`);
  return Object.freeze({
    entrypointId: closure.entrypointId, modulePath, configPath: closure.configPath,
    closureDigest: closure.closureDigest as Hash, programInputSetRoot: closure.programInputSetRoot as Hash,
    externalDependencyRoot: closure.externalDependencyRoot as Hash,
    sourceFileSetRoot: hashDomain("aloha/reuse/compiler-source-file-set/v1", closure.files),
  });
}

function moduleContentMatchesClosure(repoPath: string, modulePath: string, closure: ImplementationClosure): void {
  const current = sha256(fileText(repoPath, modulePath));
  const file = closure.files.find(item => item.path === modulePath);
  if (file === undefined || file.contentSha256 !== current) throw new TypeError(`compiler/source bytes mismatch ${modulePath}`);
}

interface ExactTrackedFile {
  readonly path: string;
  readonly blobSha: string;
  readonly bytes: Buffer;
}

interface ExactNpmOwner {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly lockRecordPath: string;
  readonly lockRecordHash: string;
}

const parsedConfigOptionsCache = new Map<string, ts.CompilerOptions>();

function repositoryPath(path: string, label: string): string {
  if (path.length === 0 || path.startsWith("/") || path.includes("\\") || path.split("/").includes("..")) {
    throw new TypeError(`${label} is not a repository-relative path: ${path}`);
  }
  return path;
}

function exactTrackedFile(repoPath: string, rawPath: string): ExactTrackedFile {
  const path = repositoryPath(rawPath, "tracked file");
  const stage = execFileSync(SNAPSHOT_GIT_EXECUTABLE_PATH, ["-C", repoPath, "ls-files", "--stage", "--", path], { encoding: "utf8", env: snapshotGitEnvironmentV1(), stdio: ["ignore", "pipe", "pipe"] }).trim();
  const match = /^(\d{6}) ([0-9a-f]{40,64}) 0\t(.+)$/.exec(stage);
  if (match === null || match[3] !== path || (match[1] !== "100644" && match[1] !== "100755")) throw new TypeError(`exact stage-0 Git owner missing ${path}`);
  const bytes = readFileSync(resolve(repoPath, path));
  const indexedBytes = execFileSync(SNAPSHOT_GIT_EXECUTABLE_PATH, ["-C", repoPath, "cat-file", "blob", match[2]!], { encoding: null, env: snapshotGitEnvironmentV1(), stdio: ["ignore", "pipe", "pipe"] });
  if (!bytes.equals(indexedBytes)) throw new TypeError(`tracked working bytes differ from Git owner ${path}`);
  return { path, blobSha: match[2]!, bytes };
}

function exactClosureFile(repoPath: string, file: ImplementationClosure["files"][number]): void {
  const actual = exactTrackedFile(repoPath, file.path);
  if (file.blobSha !== actual.blobSha || file.contentSha256 !== sha256(actual.bytes) || file.byteLength !== actual.bytes.byteLength) {
    throw new TypeError(`closure file does not bind exact Git bytes ${file.path}`);
  }
}

function resolveExtendedConfigPath(repoPath: string, fromPath: string, specifier: string): string {
  const fromAbsolute = resolve(repoPath, fromPath);
  const candidates: string[] = [];
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const candidate = resolve(dirname(fromAbsolute), specifier);
    candidates.push(candidate, `${candidate}.json`, join(candidate, "tsconfig.json"));
  } else {
    const resolved = ts.resolveModuleName(specifier, fromAbsolute, { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext }, ts.sys).resolvedModule?.resolvedFileName;
    if (resolved !== undefined) candidates.push(resolve(resolved));
  }
  for (const candidate of candidates) {
    if (!ts.sys.fileExists(candidate)) continue;
    const path = relative(repoPath, candidate).split(sep).join("/");
    repositoryPath(path, "extended config");
    exactTrackedFile(repoPath, path);
    return path;
  }
  throw new TypeError(`extended config cannot be resolved exactly ${fromPath}:${specifier}`);
}

function exactConfigChain(repoPath: string, closure: ImplementationClosure): ts.CompilerOptions {
  if (closure.configChain.rootPath !== closure.configPath) throw new TypeError(`compiler config chain root mismatch ${closure.entrypoint}`);
  const files = new Map<string, ImplementationClosure["configChain"]["files"][number]>();
  const edges: Array<{ readonly from: string; readonly to: string; readonly specifier: string }> = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (path: string): void => {
    if (visited.has(path)) return;
    if (visiting.has(path)) throw new TypeError(`compiler config extends cycle ${closure.entrypoint}:${path}`);
    visiting.add(path);
    const actual = exactTrackedFile(repoPath, path);
    files.set(path, { path, blobSha: actual.blobSha, contentSha256: sha256(actual.bytes), byteLength: actual.bytes.byteLength });
    const loaded = ts.readConfigFile(resolve(repoPath, path), ts.sys.readFile);
    if (loaded.error !== undefined || loaded.config === null || typeof loaded.config !== "object" || Array.isArray(loaded.config)) {
      throw new TypeError(`compiler config cannot be read exactly ${closure.entrypoint}:${path}`);
    }
    const extended = (loaded.config as Record<string, unknown>).extends;
    if (extended !== undefined) {
      if (typeof extended !== "string") throw new TypeError(`compiler config extends is not one string ${closure.entrypoint}:${path}`);
      const target = resolveExtendedConfigPath(repoPath, path, extended);
      edges.push({ from: path, to: target, specifier: extended });
      visit(target);
    }
    visiting.delete(path);
    visited.add(path);
  };
  visit(closure.configPath);
  const expected = {
    rootPath: closure.configPath,
    files: [...files.values()].sort((left, right) => left.path.localeCompare(right.path)),
    edges: [...edges].sort((left, right) => `${left.from}|${left.to}|${left.specifier}`.localeCompare(`${right.from}|${right.to}|${right.specifier}`)),
  };
  if (canonicalBytes(expected) !== canonicalBytes(closure.configChain)) throw new TypeError(`compiler config chain is not exact ${closure.entrypoint}`);
  if (closure.tsconfigRoot !== hashDomain("aloha/boundary/tsconfig-chain/v1", expected)) throw new TypeError(`compiler config chain digest mismatch ${closure.entrypoint}`);
  const cacheKey = `${resolve(repoPath)}\0${canonicalBytes(expected)}`;
  const cached = parsedConfigOptionsCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const parsed = ts.getParsedCommandLineOfConfigFile(resolve(repoPath, closure.configPath), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: diagnostic => { throw new TypeError(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")); },
  });
  if (parsed === undefined || parsed.errors.length > 0) throw new TypeError(`compiler config options unavailable ${closure.entrypoint}`);
  parsedConfigOptionsCache.set(cacheKey, parsed.options);
  return parsed.options;
}

function lockRecords(repoPath: string): ReadonlyMap<string, { readonly version: string | null; readonly hash: string }> {
  const lock = exactTrackedFile(repoPath, "package-lock.json");
  const parsed = JSON.parse(lock.bytes.toString("utf8")) as { readonly packages?: Record<string, unknown> };
  if (parsed.packages === undefined || parsed.packages === null || typeof parsed.packages !== "object" || Array.isArray(parsed.packages)) throw new TypeError("exact npm lock packages map missing");
  return new Map(Object.entries(parsed.packages).map(([path, raw]) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError(`invalid npm lock owner ${path}`);
    const record = raw as Record<string, unknown>;
    return [path, { version: typeof record.version === "string" ? record.version : null, hash: hashDomain("aloha/boundary/npm-lock-record/v1", { path, record }) }] as const;
  }));
}

function packageNameFromLockPath(lockRecordPath: string): string {
  const marker = "node_modules/";
  const markerIndex = lockRecordPath.lastIndexOf(marker);
  if (markerIndex < 0 || (markerIndex > 0 && lockRecordPath[markerIndex - 1] !== "/")) {
    throw new TypeError(`npm owner is not repository locked ${lockRecordPath}`);
  }
  const parts = lockRecordPath.slice(markerIndex + marker.length).split("/");
  const name = parts[0]?.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  if (!name) throw new TypeError(`npm owner path lacks package name ${lockRecordPath}`);
  return name;
}

function lockRecordPathForResolvedFile(repoPath: string, resolvedFileName: string): string {
  const physicalRoot = resolve(realpathSync(repoPath));
  const normalized = resolve(realpathSync(resolvedFileName)).split(sep).join("/");
  const marker = "/node_modules/";
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex < 0) throw new TypeError(`external edge has no npm owner ${resolvedFileName}`);
  const prefix = normalized.slice(0, markerIndex + marker.length);
  const parts = normalized.slice(markerIndex + marker.length).split("/");
  const packageParts = parts[0]?.startsWith("@") ? parts.slice(0, 2) : parts.slice(0, 1);
  if (packageParts.length === 0 || packageParts.some(part => part.length === 0)) {
    throw new TypeError(`external edge npm package name unavailable ${resolvedFileName}`);
  }
  const lockRecordPath = relative(physicalRoot, `${prefix}${packageParts.join("/")}`).split(sep).join("/");
  repositoryPath(lockRecordPath, "external edge npm owner");
  if (!lockRecordPath.startsWith("node_modules/")) {
    throw new TypeError(`external edge npm owner is outside repository ${resolvedFileName}`);
  }
  return lockRecordPath;
}

function exactNpmOwner(repoPath: string, records: ReturnType<typeof lockRecords>, lockRecordPath: string): ExactNpmOwner {
  const packageName = packageNameFromLockPath(lockRecordPath);
  const record = records.get(lockRecordPath);
  if (record === undefined || record.version === null) throw new TypeError(`npm lock owner unavailable ${lockRecordPath}`);
  const manifestBytes = readFileSync(resolve(repoPath, lockRecordPath, "package.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as { readonly name?: unknown; readonly version?: unknown };
  if (manifest.name !== packageName || manifest.version !== record.version) throw new TypeError(`installed npm owner differs from exact lock ${lockRecordPath}`);
  return { packageName, packageVersion: record.version, lockRecordPath, lockRecordHash: record.hash };
}

function validateExternalInput(repoPath: string, input: ImplementationClosure["programInputs"][number], records: ReturnType<typeof lockRecords>): ExactNpmOwner {
  if (input.kind !== "npm" && input.kind !== "typescript-lib" && input.kind !== "typescript-compiler") throw new TypeError(`not an npm compiler input ${input.logicalPath}`);
  if (input.blobSha !== null || input.packageName === null || input.packageVersion === null || input.packageRelativePath === null
    || input.packageManifestSha256 === null || input.lockRecordPath === null || input.lockRecordHash === null) {
    throw new TypeError(`external compiler input lacks exact npm structure ${input.logicalPath}`);
  }
  repositoryPath(input.packageRelativePath, "npm package-relative path");
  const owner = exactNpmOwner(repoPath, records, input.lockRecordPath);
  if (input.packageName !== owner.packageName || input.packageVersion !== owner.packageVersion || input.lockRecordHash !== owner.lockRecordHash
    || input.logicalPath !== `npm/${owner.packageName}@${owner.packageVersion}/${input.packageRelativePath}`) {
    throw new TypeError(`external compiler input differs from exact npm owner ${input.logicalPath}`);
  }
  const packageRoot = resolve(repoPath, input.lockRecordPath);
  const manifestBytes = readFileSync(resolve(packageRoot, "package.json"));
  const physicalPath = resolve(packageRoot, input.packageRelativePath);
  if (!physicalPath.startsWith(`${packageRoot}${sep}`)) throw new TypeError(`external compiler input escapes npm owner ${input.logicalPath}`);
  const bytes = readFileSync(physicalPath);
  const compilerText = input.kind === "typescript-compiler" ? null : ts.sys.readFile(physicalPath);
  if (input.packageManifestSha256 !== sha256(manifestBytes) || input.contentSha256 !== sha256(bytes) || input.byteLength !== bytes.byteLength
    || input.compilerTextSha256 !== (compilerText === undefined || compilerText === null ? null : sha256(Buffer.from(compilerText, "utf8")))) {
    throw new TypeError(`external compiler input bytes are not exact ${input.logicalPath}`);
  }
  const actualCompilerPath = resolve(realpathSync(ts.sys.getExecutingFilePath()));
  const defaultLibRoot = dirname(resolve(realpathSync(ts.getDefaultLibFilePath({}))));
  if (input.kind === "typescript-compiler" && resolve(realpathSync(physicalPath)) !== actualCompilerPath) throw new TypeError(`TypeScript compiler input is not the active compiler ${input.logicalPath}`);
  if (input.kind === "typescript-lib" && !resolve(realpathSync(physicalPath)).startsWith(`${defaultLibRoot}${sep}`)) throw new TypeError(`TypeScript lib input is not owned by the active compiler ${input.logicalPath}`);
  return owner;
}

function exactNodeRuntimeInput(): ImplementationClosure["programInputs"][number] {
  const executable = readFileSync(process.execPath);
  const runtimeIdentity = Buffer.from(canonicalBytes({ version: process.version, versions: process.versions, release: process.release, platform: process.platform, arch: process.arch }), "utf8");
  return {
    kind: "node-runtime", logicalPath: `runtime/node@${process.version}/${process.platform}-${process.arch}`,
    blobSha: null, packageName: "node", packageVersion: process.version, packageRelativePath: null,
    packageManifestSha256: sha256(runtimeIdentity), lockRecordPath: null, lockRecordHash: null,
    contentSha256: sha256(executable), compilerTextSha256: null, byteLength: executable.byteLength,
  };
}

function exactExternalDependencyRoot(repoPath: string, closure: ImplementationClosure, options: ts.CompilerOptions): string {
  let observedRecords: ReturnType<typeof lockRecords> | null = null;
  const records = (): ReturnType<typeof lockRecords> => observedRecords ??= lockRecords(repoPath);
  const owners = new Map<string, ExactNpmOwner>();
  for (const input of closure.programInputs) {
    if (input.kind !== "npm" && input.kind !== "typescript-lib" && input.kind !== "typescript-compiler") continue;
    const owner = validateExternalInput(repoPath, input, records());
    owners.set(`${owner.lockRecordPath}:${owner.lockRecordHash}`, owner);
  }
  const dependencies = Array.from(new Set(closure.edges.filter(edge => edge.to.startsWith("@external/")).map(edge => edge.specifier))).sort();
  for (const edge of closure.edges.filter(candidate => candidate.to.startsWith("@external/"))) {
    const dependency = edge.to.slice("@external/".length);
    if (dependency.startsWith("node:") || dependency.startsWith("typescript-lib:")) continue;
    const containingFile = resolve(repoPath, repositoryPath(edge.from, "external edge source"));
    const resolvedFileName = edge.specifier.startsWith("/// <reference types=")
      ? ts.resolveTypeReferenceDirective(dependency, containingFile, options, ts.sys).resolvedTypeReferenceDirective?.resolvedFileName
      : ts.resolveModuleName(dependency, containingFile, options, ts.sys, undefined, undefined,
        edge.resolutionMode === "require" ? ts.ModuleKind.CommonJS : edge.resolutionMode === "import" ? ts.ModuleKind.ESNext : undefined).resolvedModule?.resolvedFileName;
    if (resolvedFileName === undefined) throw new TypeError(`external edge npm owner cannot be resolved ${closure.entrypoint}:${dependency}`);
    const owner = exactNpmOwner(repoPath, records(), lockRecordPathForResolvedFile(repoPath, resolvedFileName));
    owners.set(`${owner.lockRecordPath}:${owner.lockRecordHash}`, owner);
  }
  return hashDomain("aloha/boundary/external-dependencies/closure/v3", {
    dependencies,
    owners: [...owners.values()].sort((left, right) => `${left.lockRecordPath}:${left.lockRecordHash}`.localeCompare(`${right.lockRecordPath}:${right.lockRecordHash}`)),
  });
}

const FORBIDDEN_WHOLE_FILE_REFERENCE_BLOBS = new Set(
  CURRENT_REUSE_DECLARATIONS.map(declaration => declaration.sourceBlob),
);

function assertProductionRepositoryPath(path: string, label: string): void {
  const exact = repositoryPath(path, label);
  if (classifyBoundaryPathV1(exact).fileClass === "reference-only") {
    throw new TypeError(`clean-room production closure contains reference-only path ${label}:${exact}`);
  }
}

function assertNoReferenceIdentity(closure: ImplementationClosure): void {
  assertProductionRepositoryPath(closure.entrypoint, "entrypoint");
  assertProductionRepositoryPath(closure.configPath, "config");
  assertProductionRepositoryPath(closure.configChain.rootPath, "config root");
  if (closure.packageManifestPath !== null) assertProductionRepositoryPath(closure.packageManifestPath, "package manifest");
  for (const file of closure.files) assertProductionRepositoryPath(file.path, "closure file");
  for (const file of closure.configChain.files) assertProductionRepositoryPath(file.path, "config chain file");
  for (const edge of [...closure.edges, ...closure.configChain.edges]) {
    assertProductionRepositoryPath(edge.from, "compiler edge source");
    if (!edge.to.startsWith("@external/")) assertProductionRepositoryPath(edge.to, "compiler edge target");
    if (edge.to === `@external/${REFERENCE_REPOSITORY_ID}` || edge.to.startsWith(`@external/${REFERENCE_REPOSITORY_ID}/`)) {
      throw new TypeError(`clean-room production closure contains reference repository dependency ${edge.to}`);
    }
  }
  if (closure.packageName === REFERENCE_REPOSITORY_ID) {
    throw new TypeError(`clean-room production closure is owned by reference repository package ${closure.entrypoint}`);
  }
  for (const input of closure.programInputs) {
    if (input.kind === "tracked") assertProductionRepositoryPath(input.logicalPath.slice("repo/".length), "tracked compiler input");
    if (input.packageName === REFERENCE_REPOSITORY_ID) {
      throw new TypeError(`clean-room production closure contains reference repository compiler input ${input.logicalPath}`);
    }
  }
}

function assertDeclaredCleanRoomProductionClosure(repoPath: string, closure: ImplementationClosure): void {
  assertNoReferenceIdentity(closure);
  for (const file of closure.files) {
    if (FORBIDDEN_WHOLE_FILE_REFERENCE_BLOBS.has(file.blobSha)) {
      throw new TypeError(`clean-room production closure contains whole-file reference blob ${closure.entrypoint}:${file.path}`);
    }
  }
  if (closure.typescriptVersion !== ts.version) throw new TypeError(`compiler runtime version mismatch ${closure.entrypoint}`);
  if (closure.files.length !== new Set(closure.files.map(file => file.path)).size) throw new TypeError(`duplicate closure file ${closure.entrypoint}`);
  for (const file of closure.files) exactClosureFile(repoPath, file);
  const closureFileByPath = new Map(closure.files.map(file => [file.path, file]));
  const trackedInputs = closure.programInputs.filter(input => input.kind === "tracked");
  const trackedInputPaths = trackedInputs.map(input => {
    if (!input.logicalPath.startsWith("repo/")) throw new TypeError(`tracked compiler input has non-repository identity ${closure.entrypoint}`);
    if (input.packageName !== null || input.packageVersion !== null || input.packageRelativePath !== null
      || input.packageManifestSha256 !== null || input.lockRecordPath !== null || input.lockRecordHash !== null
      || input.blobSha === null) throw new TypeError(`tracked compiler input has external owner fields ${closure.entrypoint}`);
    const path = input.logicalPath.slice("repo/".length);
    const file = closureFileByPath.get(path);
    const compilerText = ts.sys.readFile(resolve(repoPath, path));
    if (file === undefined || file.blobSha !== input.blobSha || file.contentSha256 !== input.contentSha256
      || file.byteLength !== input.byteLength || compilerText === undefined
      || input.compilerTextSha256 !== sha256(Buffer.from(compilerText, "utf8"))) {
      throw new TypeError(`tracked compiler input is not exact compiler-visible Git file ${closure.entrypoint}:${path}`);
    }
    return path;
  }).sort();
  const closureFilePaths = [...closureFileByPath.keys()].sort();
  if (JSON.stringify(trackedInputPaths) !== JSON.stringify(closureFilePaths)) throw new TypeError(`tracked compiler input/file denominator mismatch ${closure.entrypoint}`);
  const runtimeInputs = closure.programInputs.filter(input => input.kind === "node-runtime");
  const requiresNodeRuntime = closure.edges.some(edge => edge.to.startsWith("@external/node:") || edge.specifier.startsWith("node:"));
  if (runtimeInputs.length !== (requiresNodeRuntime ? 1 : 0)
    || (requiresNodeRuntime && canonicalBytes(runtimeInputs[0]) !== canonicalBytes(exactNodeRuntimeInput()))) {
    throw new TypeError(`node runtime input is not exact active runtime ${closure.entrypoint}`);
  }
  const compilerOptions = exactConfigChain(repoPath, closure);
  if (closure.externalDependencyRoot !== exactExternalDependencyRoot(repoPath, closure, compilerOptions)) {
    throw new TypeError(`external dependency root is not mechanically exact ${closure.entrypoint}`);
  }
}

/** Public verification never trusts a caller's declared compiler graph. */
export function assertCleanRoomProductionClosure(repoPath: string, closure: ImplementationClosure): void {
  const projection = collectCatalogCompilerBoundaryProjection({ gitRoot: repoPath, modulePaths: [closure.entrypoint] });
  const matches = projection.implementationClosures.filter(item => item.kind === "compiler-root" && item.entrypoint === closure.entrypoint);
  if (matches.length !== 1 || canonicalBytes(matches[0]) !== canonicalBytes(closure)) {
    throw new TypeError(`clean-room compiler projection is not the canonical graph ${closure.entrypoint}`);
  }
  assertDeclaredCleanRoomProductionClosure(repoPath, matches[0]!);
}

/** Unit-only structural checks; production generation never calls this seam. */
export function assertDeclaredCleanRoomProductionClosureForTesting(repoPath: string, closure: ImplementationClosure): void {
  assertDeclaredCleanRoomProductionClosure(repoPath, closure);
}

async function runtimeExports(repoPath: string, modulePath: string): Promise<ReadonlySet<string>> {
  const namespace = await import(`${pathToFileURL(resolve(repoPath, modulePath)).href}?reuse-authority=${sha256(fileText(repoPath, modulePath)).slice(2)}`);
  return new Set(Object.keys(namespace));
}

function evidenceRequirement(exportName: string): { readonly requirementId: string; readonly testModulePath: string; readonly testCaseName: string; readonly authority: string; readonly productionOraclePass: boolean } {
  const value = (evidenceRequirements as Record<string, unknown>)[exportName];
  if (value === null || typeof value !== "object") throw new TypeError(`evidence requirement export missing ${exportName}`);
  return value as ReturnType<typeof evidenceRequirement>;
}

export async function generateAuthorityArtifacts(options: GenerateAuthorityOptions): Promise<GeneratedAuthorityArtifacts> {
  if (Object.keys(options).sort().join("\0") !== ["referenceRepoPath", "repoPath"].join("\0")) {
    throw new TypeError("reference-lock authority generator options must be exact and may not inject compiler facts");
  }
  if (git(options.referenceRepoPath, ["rev-parse", `${REFERENCE_COMMIT}^{commit}`]) !== REFERENCE_COMMIT) throw new TypeError("frozen reference commit unavailable");
  const stageTree = git(options.repoPath, ["write-tree"]);
  if (CURRENT_REUSE_DECLARATIONS.some(declaration => declaration.adoptionMode === "isolated-pure-kernel")) throw new TypeError("current 5f104ced reuse set may not expand the canonical R0 declaration whitelist");
  const modulePaths = Array.from(new Set(CURRENT_REUSE_DECLARATIONS.flatMap(declaration => [
    ...declaration.destinations.map(item => item.modulePath), EVIDENCE_REQUIREMENT_MODULE_PATH, declaration.evidence.testModulePath,
  ]).concat(GENERATOR_ENTRYPOINT_PATHS))).sort();
  const projection = collectCatalogCompilerBoundaryProjection({ gitRoot: options.repoPath, modulePaths });
  const closureByModule = new Map<string, ImplementationClosure>();
  for (const modulePath of modulePaths) {
    const matches = projection.implementationClosures.filter(item => item.kind === "compiler-root" && item.entrypoint === modulePath);
    if (matches.length !== 1) throw new TypeError(`compiler projection missing exact root ${modulePath}`);
    closureByModule.set(modulePath, matches[0]!);
    moduleContentMatchesClosure(options.repoPath, modulePath, matches[0]!);
    assertDeclaredCleanRoomProductionClosure(options.repoPath, matches[0]!);
  }
  const requirementExports = await runtimeExports(options.repoPath, EVIDENCE_REQUIREMENT_MODULE_PATH);
  const entries: ReuseLedgerEntryV2[] = [];
  const receipts: ReuseReceiptV2[] = [];
  for (const declaration of sorted(CURRENT_REUSE_DECLARATIONS, item => item.entryId)) {
    const oldText = gitShow(options.referenceRepoPath, REFERENCE_COMMIT, declaration.sourcePath);
    const actualBlob = git(options.referenceRepoPath, ["rev-parse", `${REFERENCE_COMMIT}:${declaration.sourcePath}`]);
    if (actualBlob !== declaration.sourceBlob) throw new TypeError(`reference blob mismatch ${declaration.entryId}`);
    const symbols = declaration.sourceSymbols.map(symbol => {
      const content = rawSlice(oldText, symbol.startLine, symbol.endLine);
      if (!new RegExp(`\\b${symbol.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(content)) throw new TypeError(`source symbol range does not contain ${symbol.name}`);
      return Object.freeze({ ...symbol, contentSha256: sha256(content) });
    });
    const source: SourceLockV2 = Object.freeze({ repositoryId: REFERENCE_REPOSITORY_ID, commit: REFERENCE_COMMIT, path: declaration.sourcePath, blob: declaration.sourceBlob, license: "reuse-reviewed-no-runtime-import", symbols: Object.freeze(symbols) });
    const destinations: DestinationAuthorityV2[] = [];
    for (const destination of declaration.destinations) {
      const exports = await runtimeExports(options.repoPath, destination.modulePath);
      const missing = destination.exportNames.filter(name => !exports.has(name));
      if (missing.length > 0) throw new TypeError(`destination exports missing ${destination.modulePath}: ${missing.join(",")}`);
      destinations.push(Object.freeze({ modulePath: destination.modulePath, exportNames: Object.freeze([...destination.exportNames]), contentSha256: sha256(fileText(options.repoPath, destination.modulePath)), compiler: selectCompilerAuthority(projection, destination.modulePath) }));
    }
    const requirement = evidenceRequirement(declaration.evidence.requirementExportName);
    if (!requirementExports.has(declaration.evidence.requirementExportName)) throw new TypeError(`evidence export missing ${declaration.evidence.requirementExportName}`);
    if (requirement.authority !== "requirement-only" || requirement.productionOraclePass !== false || requirement.testModulePath !== declaration.evidence.testModulePath || requirement.testCaseName !== declaration.evidence.testCaseName) throw new TypeError(`evidence requirement mismatch ${declaration.entryId}`);
    const testText = fileText(options.repoPath, declaration.evidence.testModulePath);
    if (!testText.includes(declaration.evidence.testCaseName)) throw new TypeError(`evidence test case missing ${declaration.entryId}`);
    const evidence: EvidenceAuthorityV2 = Object.freeze({
      requirementId: requirement.requirementId, requirementModulePath: EVIDENCE_REQUIREMENT_MODULE_PATH,
      requirementExportName: declaration.evidence.requirementExportName, requirementContentSha256: sha256(fileText(options.repoPath, EVIDENCE_REQUIREMENT_MODULE_PATH)),
      requirementCompiler: selectCompilerAuthority(projection, EVIDENCE_REQUIREMENT_MODULE_PATH),
      testModulePath: declaration.evidence.testModulePath, testCaseName: declaration.evidence.testCaseName, testContentSha256: sha256(testText), testCompiler: selectCompilerAuthority(projection, declaration.evidence.testModulePath),
      authority: "requirement-only", productionOraclePass: false,
    });
    const selectedSourceRoot = hashDomain("aloha/reuse/selected-source/v2", source);
    const destinationClosureRoot = hashDomain("aloha/reuse/destination-closure/v2", destinations);
    const evidenceClosureRoot = hashDomain("aloha/reuse/evidence-closure/v2", evidence);
    const receiptFacts: Omit<ReuseReceiptV2, "receiptId"> = Object.freeze({ kind: "aloha.reuse-receipt", schemaVersion: 2, entryId: declaration.entryId, adoptionMode: declaration.adoptionMode, creditStatus: declaration.creditStatus, selectedSourceRoot, destinationClosureRoot, evidenceClosureRoot, candidateCommitBinding: "external-release-post-commit-exact-join" });
    const receipt: ReuseReceiptV2 = Object.freeze({ ...receiptFacts, receiptId: computeReuseReceiptId(receiptFacts) });
    receipts.push(receipt);
    entries.push(Object.freeze({ entryId: declaration.entryId, adoptionMode: declaration.adoptionMode, creditStatus: declaration.creditStatus, nonCreditReason: declaration.nonCreditReason, productionImportAllowed: false, source, destinations: Object.freeze(destinations), evidence, releaseDependencyClosureRoot: hashDomain("aloha/reuse/release-dependency-closure/v2", destinations.map(item => item.compiler)), reuseReceiptId: receipt.receiptId }));
  }
  const orderedEntries = sorted(entries, item => item.entryId); const orderedReceipts = sorted(receipts, item => item.entryId);
  const lockEntries = orderedEntries.map(entry => Object.freeze({ entryId: entry.entryId, source: entry.source, allowedDisposition: entry.adoptionMode, releaseCredit: entry.creditStatus }));
  const referenceLock: ReferenceLockV2 = Object.freeze({ kind: "aloha.reference-lock", schemaVersion: 2, sourceRepositoryId: REFERENCE_REPOSITORY_ID, sourceCommit: REFERENCE_COMMIT, entries: Object.freeze(lockEntries), referenceLockRoot: computeReferenceLockRoot(lockEntries) });
  const ledgerFacts: Omit<ReuseLedgerV2, "reuseLedgerRoot"> = Object.freeze({ kind: "aloha.reuse-ledger", schemaVersion: 2, sourceRepositoryId: REFERENCE_REPOSITORY_ID, sourceCommit: REFERENCE_COMMIT, historicalDecisionEntryIds: Object.freeze(orderedEntries.map(item => item.entryId)), releaseReuseEntryIds: Object.freeze(orderedEntries.filter(item => item.creditStatus === "credited").map(item => item.entryId)), entries: orderedEntries, productionOraclePassClaimed: false });
  const ledger: ReuseLedgerV2 = Object.freeze({ ...ledgerFacts, reuseLedgerRoot: computeReuseLedgerRoot(ledgerFacts) });
  const receiptSet: ReuseReceiptSetV2 = Object.freeze({ kind: "aloha.reuse-receipt-set", schemaVersion: 2, receipts: orderedReceipts, receiptSetRoot: computeReceiptSetRoot(orderedReceipts) });
  const payloadValues = [referenceLock, ledger, receiptSet] as const;
  const payloadBytes = new Map(PAYLOAD_PATHS.map((path, index) => [path, canonicalBytes(payloadValues[index]) ] as const));
  const outputBytes = PAYLOAD_PATHS.map(path => { const bytes = payloadBytes.get(path)!; return Object.freeze({ path, byteLength: Buffer.byteLength(bytes), contentSha256: sha256(bytes) }); });
  const installerIdentity = activeSnapshotInstallerIdentityV1();
  const gitIdentity = activeSnapshotGitIdentityV1();
  const manifestFacts = {
    kind: "aloha.reuse-authority-manifest" as const, schemaVersion: REUSE_AUTHORITY_SCHEMA_VERSION,
    fixedOutputPaths: GENERATED_AUTHORITY_PATHS, outputBytes: Object.freeze(outputBytes),
    declarationInputRoot: hashDomain("aloha/reuse/declaration-input/v2", CURRENT_REUSE_DECLARATIONS),
    generatorInputRoot: hashDomain("aloha/reuse/generator-input/v3", {
      compilerAuthorities: GENERATOR_ENTRYPOINT_PATHS.map(path => selectCompilerAuthority(projection, path)),
      packageLock: (() => {
        const lock = exactTrackedFile(options.repoPath, "package-lock.json");
        return { path: lock.path, blobSha: lock.blobSha, contentSha256: sha256(lock.bytes), byteLength: lock.bytes.byteLength };
      })(),
      installer: installerIdentity,
      git: gitIdentity,
    }),
    selectedSourceRoot: hashDomain("aloha/reuse/all-selected-sources/v2", orderedEntries.map(item => item.source)),
    destinationClosureRoot: hashDomain("aloha/reuse/all-destination-closures/v2", orderedEntries.map(item => item.destinations)),
    evidenceClosureRoot: hashDomain("aloha/reuse/all-evidence-closures/v2", orderedEntries.map(item => item.evidence)),
    candidateCommit: null, candidateCommitBinding: "external-release-post-commit-exact-join" as const,
  };
  const manifest: AuthorityManifestV2 = Object.freeze({ ...manifestFacts, artifactSetRoot: hashDomain("aloha/reuse/authority-artifact-set/v2", manifestFacts) });
  const bytes = new Map(payloadBytes); bytes.set(GENERATED_AUTHORITY_PATHS[3]!, canonicalBytes(manifest));
  if (git(options.repoPath, ["write-tree"]) !== stageTree) throw new TypeError("reference-lock authority input index changed during generation");
  const artifactBytes = Object.freeze([...bytes].map(([path, value]) => Object.freeze([path, value] as const)));
  const issued = Object.freeze({ referenceLock, ledger, receiptSet, manifest, bytes: new Map(artifactBytes) });
  canonicalGenerations.set(issued, Object.freeze({
    repoPath: realpathSync(options.repoPath),
    referenceRepoPath: realpathSync(options.referenceRepoPath),
    stageTree,
    modulePaths: Object.freeze(modulePaths),
    projection,
    installerIdentity,
    gitIdentity,
    artifactBytes,
    artifactSetRoot: manifest.artifactSetRoot,
  }));
  return issued;
}

function readArtifact(repoPath: string, path: string): unknown { return decodeCanonicalJson(readFileSync(resolve(repoPath, path))); }

function assertCanonicalGenerationCurrent(
  generated: GeneratedAuthorityArtifacts,
  options: GenerateAuthorityOptions,
): GeneratedAuthorityArtifacts {
  const state = canonicalGenerations.get(generated);
  if (state === undefined) throw new TypeError("reference-lock canonical generation capability was not issued in this process");
  if (realpathSync(options.repoPath) !== state.repoPath || realpathSync(options.referenceRepoPath) !== state.referenceRepoPath) {
    throw new TypeError("reference-lock canonical generation repository mismatch");
  }
  if (git(options.repoPath, ["write-tree"]) !== state.stageTree
    || canonicalBytes(activeSnapshotInstallerIdentityV1()) !== canonicalBytes(state.installerIdentity)
    || canonicalBytes(activeSnapshotGitIdentityV1()) !== canonicalBytes(state.gitIdentity)
    || git(options.referenceRepoPath, ["rev-parse", `${REFERENCE_COMMIT}^{commit}`]) !== REFERENCE_COMMIT) {
    throw new TypeError("reference-lock canonical generation inputs changed");
  }
  for (const modulePath of state.modulePaths) {
    const matches = state.projection.implementationClosures.filter(item => item.kind === "compiler-root" && item.entrypoint === modulePath);
    if (matches.length !== 1) throw new TypeError(`canonical generation compiler projection missing exact root ${modulePath}`);
    moduleContentMatchesClosure(options.repoPath, modulePath, matches[0]!);
    assertDeclaredCleanRoomProductionClosure(options.repoPath, matches[0]!);
  }
  const sealedBytes = new Map(state.artifactBytes);
  if (canonicalBytes([...generated.bytes]) !== canonicalBytes(state.artifactBytes)
    || canonicalBytes(generated.referenceLock) !== sealedBytes.get(GENERATED_AUTHORITY_PATHS[0])
    || canonicalBytes(generated.ledger) !== sealedBytes.get(GENERATED_AUTHORITY_PATHS[1])
    || canonicalBytes(generated.receiptSet) !== sealedBytes.get(GENERATED_AUTHORITY_PATHS[2])
    || canonicalBytes(generated.manifest) !== sealedBytes.get(GENERATED_AUTHORITY_PATHS[3])
    || generated.manifest.artifactSetRoot !== state.artifactSetRoot) {
    throw new TypeError("reference-lock canonical generation capability was mutated");
  }
  return Object.freeze({ ...generated, bytes: sealedBytes });
}

export async function validateReferenceLockIntegrity(options: GenerateAuthorityOptions & {
  readonly artifacts?: ReadonlyMap<string, string>;
  /** Process-local output of canonical generation; structural clones fail. */
  readonly canonicalGeneration?: GeneratedAuthorityArtifacts;
}): Promise<IntegrityReportV2> {
  const checks: IntegrityCheckV2[] = [];
  let generated: GeneratedAuthorityArtifacts | null = null;
  try {
    const optionKeys = Object.keys(options).sort();
    const allowedKeys = ["artifacts", "canonicalGeneration", "referenceRepoPath", "repoPath"];
    if (optionKeys.some(key => !allowedKeys.includes(key)) || !optionKeys.includes("repoPath") || !optionKeys.includes("referenceRepoPath")) {
      throw new TypeError("reference-lock integrity options contain an authority injection seam");
    }
    generated = options.canonicalGeneration === undefined
      ? await generateAuthorityArtifacts({ repoPath: options.repoPath, referenceRepoPath: options.referenceRepoPath })
      : assertCanonicalGenerationCurrent(options.canonicalGeneration, options);
    checks.push(check("authority.regenerate", "pass", "independent inputs regenerated"));
  }
  catch (error) { checks.push(check("authority.regenerate", "invalid", error instanceof Error ? error.message : String(error))); }
  if (generated !== null) {
    checks.push(check("reuse-ledger.clean-room-production-closure", "pass", "credited compiler closure records contain no known old/reference identity across source, config, program-input, or dependency-owner facts"));
    const actual = options.artifacts ?? new Map(GENERATED_AUTHORITY_PATHS.map(path => [path, readFileSync(resolve(options.repoPath, path), "utf8")]));
    checks.push(check("authority.output-set", actual.size === GENERATED_AUTHORITY_PATHS.length && GENERATED_AUTHORITY_PATHS.every(path => actual.has(path)) ? "pass" : "invalid", `expected=${GENERATED_AUTHORITY_PATHS.length};actual=${actual.size}`));
    for (const path of GENERATED_AUTHORITY_PATHS) checks.push(check(`authority.fresh.${path}`, actual.get(path) === generated.bytes.get(path) ? "pass" : "invalid", "generated bytes exact"));
    try { decodeReferenceLock(readArtifactFrom(actual, GENERATED_AUTHORITY_PATHS[0]!)); checks.push(check("reference-lock.decode", "pass", "strict canonical schema")); } catch (error) { checks.push(check("reference-lock.decode", "invalid", String(error))); }
    try {
      const ledger = decodeReuseLedger(readArtifactFrom(actual, GENERATED_AUTHORITY_PATHS[1]!));
      checks.push(check("reuse-ledger.decode", "pass", "strict canonical schema"));
      const auditSetRoot = hashDomain(REQUIRED_AUDIT_ENTRY_SET_DOMAIN, ledger.historicalDecisionEntryIds);
      const exactAuditSet = ledger.historicalDecisionEntryIds.length === REQUIRED_AUDIT_ENTRY_COUNT
        && JSON.stringify(ledger.historicalDecisionEntryIds) === JSON.stringify(REQUIRED_AUDIT_ENTRY_IDS)
        && auditSetRoot === REQUIRED_AUDIT_ENTRY_SET_ROOT;
      checks.push(check("reuse-ledger.required-exact-set", exactAuditSet ? "pass" : "invalid", `exact=${ledger.historicalDecisionEntryIds.length};root=${auditSetRoot}`));
      checks.push(check("reuse-ledger.no-pending-credit", /future|pending/i.test(canonicalBytes(ledger.entries.filter(item => item.creditStatus === "credited"))) ? "invalid" : "pass", "credited rows contain no future/pending marker"));
      checks.push(check("reuse-ledger.lp-absence", /(^|[^a-z])lp([^a-z]|$)|liquidity.?pool/i.test(canonicalBytes(ledger)) ? "invalid" : "pass", "LP absent"));
      checks.push(check("reuse-ledger.no-production-oracle-claim", ledger.productionOraclePassClaimed === false && ledger.entries.every(item => item.evidence.productionOraclePass === false) ? "pass" : "invalid", "evidence remains requirement-only"));
    } catch (error) { checks.push(check("reuse-ledger.decode", "invalid", String(error))); }
    try { decodeReuseReceiptSet(readArtifactFrom(actual, GENERATED_AUTHORITY_PATHS[2]!)); checks.push(check("reuse-receipts.decode", "pass", "receipt identities recomputed")); } catch (error) { checks.push(check("reuse-receipts.decode", "invalid", String(error))); }
  }
  const verdict = checks.every(item => item.status === "pass") ? "pass" : "invalid";
  return Object.freeze({ kind: "aloha.reference-lock-integrity-report", schemaVersion: 2, verdict, checks: Object.freeze(checks), artifactSetRoot: generated?.manifest.artifactSetRoot ?? null });
}

function readArtifactFrom(artifacts: ReadonlyMap<string, string>, path: string): unknown { const bytes = artifacts.get(path); if (bytes === undefined) throw new TypeError(`artifact missing ${path}`); return decodeCanonicalJson(bytes); }
export function encodeIntegrityReport(report: IntegrityReportV2): string { return canonicalBytes(report); }
export function assertIntegrityPass(report: IntegrityReportV2): void { if (report.verdict !== "pass") throw new Error(report.checks.filter(item => item.status !== "pass").map(item => `${item.id}:${item.detail}`).join(";")); }
