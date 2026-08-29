import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, relative, resolve, sep } from "node:path";
import type { BoundaryDiagnostic, TrackedFile } from "../index.ts";

/**
 * Solidity is a compiler language, not metadata.  This adapter is deliberately
 * independent of the TypeScript graph collector: Foundry owns source roots,
 * remappings, compiler settings, import resolution and the solc invocation.
 * The boundary consumes only the content-addressed facts returned here.
 */

export interface FoundryConfigFactV1 {
  readonly path: string;
  readonly contentSha256: string;
  readonly byteLength: number;
  /** Effective `forge config --json` fields that affect the build graph. */
  readonly effectiveConfig: Readonly<Record<string, unknown>>;
  readonly effectiveConfigRoot: string;
}

export interface SolidityImportFactV1 {
  readonly from: string;
  readonly specifier: string;
  readonly resolvedPath: string;
  readonly sourceOffset: number | null;
}

export interface SoliditySourceFactV1 {
  readonly path: string;
  readonly blobSha: string;
  readonly contentSha256: string;
  readonly byteLength: number;
  readonly compilerSourceId: number;
  readonly compilerContentSha256: string;
  readonly imports: readonly SolidityImportFactV1[];
}

export interface FoundryBuildInfoFactV1 {
  readonly path: string;
  readonly contentSha256: string;
  readonly byteLength: number;
  readonly buildInfoId: string;
  readonly sourcePaths: readonly string[];
  readonly inputRoot: string;
  readonly inputSettingsRoot: string;
  readonly outputRoot: string;
  readonly solcVersion: string;
  readonly solcLongVersion: string;
}

export interface FoundryToolchainFactV1 {
  readonly pinPath: string;
  readonly pinContentSha256: string;
  readonly forgeVersion: string;
  readonly forgeCommit: string;
  readonly forgeBuildTimestamp: string;
  readonly forgeBuildProfile: string;
  readonly forgeVersionTextSha256: string;
  readonly forgeExecutableSha256: string;
  readonly solcVersion: string;
  readonly solcLongVersion: string;
  readonly solcExecutableSha256: string;
  readonly compilerInputRoot: string;
  readonly compilerSettingsRoot: string;
}

interface FoundryToolchainPinV1 {
  readonly schemaVersion: 1;
  readonly forgeVersion: string;
  readonly forgeCommit: string;
  readonly forgeBuildTimestamp: string;
  readonly forgeBuildProfile: string;
  readonly solcVersion: string;
  readonly solcCommit: string;
}

export interface FoundryBuildGraphFactsV1 {
  readonly schemaVersion: 1;
  readonly config: FoundryConfigFactV1;
  readonly sourceFiles: readonly SoliditySourceFactV1[];
  readonly imports: readonly SolidityImportFactV1[];
  readonly buildInfos: readonly FoundryBuildInfoFactV1[];
  readonly toolchain: FoundryToolchainFactV1;
  readonly sourceRoot: string;
  readonly importRoot: string;
  readonly buildInfoRoot: string;
  readonly rootDigest: string;
}

export type SolidityDiagnosticSink = (diagnostic: BoundaryDiagnostic) => void;

const EFFECTIVE_CONFIG_KEYS = Object.freeze([
  "allow_paths",
  "auto_detect_remappings",
  "auto_detect_solc",
  "bytecode_hash",
  "cbor_metadata",
  "evm_version",
  "extra_output",
  "extra_output_files",
  "include_paths",
  "libraries",
  "libs",
  "optimizer",
  "optimizer_details",
  "optimizer_runs",
  "out",
  "remappings",
  "solc",
  "src",
  "test",
  "via_ir",
  "use_literal_content",
] as const);

function posixPath(value: string): string {
  return value.split(sep).join("/");
}

function repoRelative(root: string, value: string): string {
  return posixPath(relative(root, value));
}

function isInside(root: string, value: string): boolean {
  const result = relative(root, value);
  return result === "" || (result !== ".." && !result.startsWith(`..${sep}`) && !result.includes(`${sep}..${sep}`));
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite Solidity fact");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  throw new TypeError("unsupported Solidity fact");
}

function hashDomain(domain: string, value: unknown): string {
  return `0x${createHash("sha256").update(domain).update("\0").update(canonical(value)).digest("hex")}`;
}

function sha256(value: Buffer | string): string {
  return `0x${createHash("sha256").update(value).digest("hex")}`;
}

function report(
  sink: SolidityDiagnosticSink,
  code: string,
  path: string,
  message: string,
): void {
  sink({ kind: "invalid", code, path: posixPath(path), message, offset: null });
}

function normalizeConfigValue(
  value: unknown,
  gitRoot: string,
  sink: SolidityDiagnosticSink,
  path: string,
): unknown {
  if (typeof value === "string") {
    if (!value.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(value)) return value;
    const absolute = resolve(value);
    if (!isInside(gitRoot, absolute)) {
      report(sink, "solidity-config-path-outside-root", path, `Foundry config value ${path} resolves outside the exact Git root`);
      return "@outside-root";
    }
    return `@repo/${repoRelative(gitRoot, absolute)}`;
  }
  if (Array.isArray(value)) return value.map((item, index) => normalizeConfigValue(item, gitRoot, sink, `${path}[${index}]`));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalizeConfigValue(item, gitRoot, sink, path ? `${path}.${key}` : key)]));
  }
  return value;
}

function effectiveConfig(raw: unknown, gitRoot: string, sink: SolidityDiagnosticSink): Readonly<Record<string, unknown>> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    report(sink, "solidity-forge-config-shape", "contracts/foundry.toml", "forge config --json did not return an object");
    return Object.freeze({});
  }
  const input = raw as Record<string, unknown>;
  const selected = Object.fromEntries(EFFECTIVE_CONFIG_KEYS.map((key) => [key, input[key] ?? null]));
  return Object.freeze(normalizeConfigValue(selected, gitRoot, sink, "foundryConfig") as Record<string, unknown>);
}

function parseForgeVersion(text: string, sink: SolidityDiagnosticSink): Omit<FoundryToolchainFactV1, "pinPath" | "pinContentSha256" | "forgeExecutableSha256" | "solcExecutableSha256"> | null {
  const version = text.match(/^forge Version:?\s+([^\s]+)$/m)?.[1] ?? null;
  const commit = text.match(/^Commit SHA: ([^\s]+)$/m)?.[1] ?? null;
  const timestamp = text.match(/^Build Timestamp: (.+)$/m)?.[1] ?? null;
  const profile = text.match(/^Build Profile: ([^\s]+)$/m)?.[1] ?? null;
  if (version === null || commit === null || timestamp === null || profile === null) {
    report(sink, "solidity-forge-version-unpinned", "contracts/foundry.toml", "forge --version must expose an exact version, commit and build timestamp");
    return null;
  }
  return {
    forgeVersion: version,
    forgeCommit: commit,
    forgeBuildTimestamp: timestamp,
    forgeBuildProfile: profile,
    forgeVersionTextSha256: sha256(text),
    solcVersion: "",
    solcLongVersion: "",
    compilerInputRoot: "",
    compilerSettingsRoot: "",
  };
}

function findExecutable(name: string): string | null {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    try {
      const physical = realpathSync(join(directory, name));
      if (lstatSync(physical).isFile()) return physical;
    } catch {
      // Continue through the exact PATH order.
    }
  }
  return null;
}

function runForge(executable: string, root: string, args: readonly string[]): string {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith("FOUNDRY_") || name.startsWith("DAPP_")) delete env[name];
  }
  return execFileSync(executable, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...env, FOUNDRY_PROFILE: "default" },
  });
}

function decodeToolchainPin(value: unknown, path: string, sink: SolidityDiagnosticSink): FoundryToolchainPinV1 | null {
  const record = asRecord(value);
  const keys = record === null ? [] : Object.keys(record).sort();
  const expected = ["forgeBuildProfile", "forgeBuildTimestamp", "forgeCommit", "forgeVersion", "schemaVersion", "solcCommit", "solcVersion"].sort();
  if (record === null || canonical(keys) !== canonical(expected) || record.schemaVersion !== 1) {
    report(sink, "solidity-toolchain-pin-shape", path, "Foundry toolchain pin must have exact schemaVersion 1 keys");
    return null;
  }
  for (const key of expected.filter((key) => key !== "schemaVersion")) {
    if (typeof record[key] !== "string" || record[key] === "") {
      report(sink, "solidity-toolchain-pin-shape", path, `Foundry toolchain pin field ${key} must be a non-empty string`);
      return null;
    }
  }
  if (!/^\d+\.\d+\.\d+$/.test(record.solcVersion as string) || !/^[0-9a-f]{8,40}$/.test(record.solcCommit as string)) {
    report(sink, "solidity-toolchain-pin-shape", path, "Solc version and commit must be exact");
    return null;
  }
  return {
    schemaVersion: 1,
    forgeVersion: record.forgeVersion as string,
    forgeCommit: record.forgeCommit as string,
    forgeBuildTimestamp: record.forgeBuildTimestamp as string,
    forgeBuildProfile: record.forgeBuildProfile as string,
    solcVersion: record.solcVersion as string,
    solcCommit: record.solcCommit as string,
  };
}

function solcExecutable(version: string): string | null {
  const home = process.env.HOME;
  const svmHome = process.env.SVM_HOME;
  const roots = [
    svmHome,
    home ? join(home, ".svm") : null,
    home ? join(home, "Library", "Application Support", "svm") : null,
  ].filter((value): value is string => value !== null && value !== undefined);
  for (const root of roots) {
    for (const candidate of [join(root, version, `solc-${version}`), join(root, version, "solc")]) {
      try {
        const physical = realpathSync(candidate);
        if (lstatSync(physical).isFile()) return physical;
      } catch {
        // Try the next deterministic SVM location.
      }
    }
  }
  return null;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function sourcePathFromBuildInfo(configRoot: string, gitRoot: string, sourcePath: string): string {
  const configPath = repoRelative(gitRoot, configRoot);
  const normalized = posixPath(sourcePath).replace(/^\.\//, "");
  return normalized.startsWith(`${configPath}/`) ? normalized : `${configPath}/${normalized}`;
}

function resolveImportPath(
  configRoot: string,
  gitRoot: string,
  fromPath: string,
  specifier: string,
  effective: Readonly<Record<string, unknown>>,
): string | null {
  const fromAbsolute = resolve(gitRoot, fromPath);
  const candidates: string[] = [];
  if (specifier.startsWith(".")) candidates.push(resolve(dirname(fromAbsolute), specifier));
  const remappings = Array.isArray(effective.remappings) ? effective.remappings : [];
  for (const item of remappings) {
    if (typeof item !== "string") continue;
    const separator = item.indexOf("=");
    if (separator <= 0) continue;
    const prefix = item.slice(0, separator);
    const target = item.slice(separator + 1);
    if (specifier.startsWith(prefix)) candidates.push(resolve(configRoot, target, specifier.slice(prefix.length)));
  }
  candidates.push(resolve(configRoot, specifier));
  const sourceRoot = typeof effective.src === "string" ? effective.src : "src";
  const testRoot = typeof effective.test === "string" ? effective.test : "test";
  candidates.push(resolve(configRoot, sourceRoot, specifier));
  candidates.push(resolve(configRoot, testRoot, specifier));
  for (const candidate of candidates) {
    const normalized = candidate.endsWith(".sol") ? candidate : `${candidate}.sol`;
    if (!isInside(configRoot, normalized)) continue;
    try {
      readFileSync(normalized);
      return repoRelative(gitRoot, resolve(normalized));
    } catch {
      // The exact source set check below emits the diagnostic if none match.
    }
  }
  return null;
}

function importFactsFromAst(
  configRoot: string,
  gitRoot: string,
  sourcePath: string,
  outputSource: Record<string, unknown>,
  effective: Readonly<Record<string, unknown>>,
  sink: SolidityDiagnosticSink,
): SolidityImportFactV1[] {
  const ast = asRecord(outputSource.ast);
  const nodes = ast?.nodes;
  if (!Array.isArray(nodes)) {
    report(sink, "solidity-build-info-import-ast-missing", sourcePath, "Foundry build-info must retain each source AST so import edges are compiler facts");
    return [];
  }
  const imports: SolidityImportFactV1[] = [];
  for (const nodeValue of nodes) {
    const node = asRecord(nodeValue);
    if (node?.nodeType !== "ImportDirective") continue;
    const specifier = asString(node.file);
    const resolvedFromCompiler = asString(node.absolutePath);
    if (specifier === null || resolvedFromCompiler === null) {
      report(sink, "solidity-import-fact-incomplete", sourcePath, "Foundry ImportDirective must bind both source specifier and absolutePath");
      continue;
    }
    const resolvedPath = sourcePathFromBuildInfo(configRoot, gitRoot, resolvedFromCompiler);
    const normalizedResolved = resolveImportPath(configRoot, gitRoot, sourcePath, specifier, effective);
    if (normalizedResolved === null || normalizedResolved !== resolvedPath) {
      report(sink, "solidity-import-resolution-mismatch", sourcePath, `Compiler import ${specifier} does not resolve to the exact tracked path ${resolvedPath}`);
    }
    const src = asString(node.src);
    const sourceOffset = src === null ? null : Number.parseInt(src.split(":", 1)[0]!, 10);
    imports.push({ from: sourcePath, specifier, resolvedPath, sourceOffset: Number.isFinite(sourceOffset) ? sourceOffset : null });
  }
  return imports.sort((left, right) => `${left.from}|${left.specifier}|${left.resolvedPath}`.localeCompare(`${right.from}|${right.specifier}|${right.resolvedPath}`));
}

function expectedSolidityFiles(root: string, configRoot: string, files: readonly TrackedFile[], sink: SolidityDiagnosticSink): TrackedFile[] {
  const sourceFiles = files.filter((file) => file.language === "solidity");
  const result: TrackedFile[] = [];
  for (const file of sourceFiles) {
    const absolute = resolve(root, file.path);
    if (!isInside(configRoot, absolute)) {
      report(sink, "solidity-source-outside-foundry-root", file.path, "Every tracked Solidity source must be owned by one tracked foundry.toml");
      continue;
    }
    result.push(file);
  }
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

function buildInfoCandidates(configRoot: string, gitRoot: string, sink: SolidityDiagnosticSink): Array<{ readonly path: string; readonly value: Record<string, unknown>; readonly bytes: Buffer }> {
  const out = resolve(configRoot, "out", "build-info");
  let names: string[];
  try {
    names = readdirSync(out).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    report(sink, "solidity-build-info-missing", repoRelative(gitRoot, out), `Foundry build-info directory is unavailable: ${String(error)}`);
    return [];
  }
  const result: Array<{ readonly path: string; readonly value: Record<string, unknown>; readonly bytes: Buffer }> = [];
  for (const name of names) {
    const absolute = join(out, name);
    try {
      const bytes = readFileSync(absolute);
      const value = asRecord(JSON.parse(bytes.toString("utf8")));
      if (value !== null) result.push({ path: repoRelative(gitRoot, absolute), value, bytes });
    } catch (error) {
      report(sink, "solidity-build-info-unreadable", repoRelative(gitRoot, absolute), String(error));
    }
  }
  return result;
}

function exactSourceSet(value: unknown): string[] {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value as Record<string, unknown>).map(posixPath).sort()
    : [];
}

function sourceContentHash(value: unknown): string | null {
  const source = asRecord(value);
  const content = source?.content;
  return typeof content === "string" ? sha256(content) : null;
}

function recomputeSourceRoot(facts: Pick<FoundryBuildGraphFactsV1, "sourceFiles">): string {
  return hashDomain("aloha/solidity/source-set/v1", facts.sourceFiles.map((file) => ({
    path: file.path,
    blobSha: file.blobSha,
    contentSha256: file.contentSha256,
    byteLength: file.byteLength,
    compilerSourceId: file.compilerSourceId,
    compilerContentSha256: file.compilerContentSha256,
    imports: file.imports,
  })));
}

function recomputeImportRoot(facts: Pick<FoundryBuildGraphFactsV1, "imports">): string {
  return hashDomain("aloha/solidity/import-graph/v1", facts.imports);
}

function recomputeBuildInfoRoot(facts: Pick<FoundryBuildGraphFactsV1, "buildInfos">): string {
  return hashDomain("aloha/solidity/build-info-set/v1", facts.buildInfos);
}

function recomputeRoot(facts: Omit<FoundryBuildGraphFactsV1, "rootDigest">): string {
  return hashDomain("aloha/solidity/foundry-build-graph/v1", facts);
}

/**
 * Validate a stored adapter result against the current tracked denominator.
 * This is intentionally pure and is used by the boundary before the receipt
 * is allowed to carry the Solidity facts.  It catches a forged receipt even
 * when its individual fields are made self-consistent.
 */
export function validateFoundryBuildGraphFacts(
  root: string,
  files: readonly TrackedFile[],
  facts: FoundryBuildGraphFactsV1,
  sink: SolidityDiagnosticSink,
): void {
  if (facts.schemaVersion !== 1) report(sink, "solidity-fact-schema", facts.config.path, "Foundry build graph facts must use schemaVersion 1");
  const tracked = new Map(files.map((file) => [file.path, file]));
  const config = tracked.get(facts.config.path);
  if (config === undefined || facts.config.path !== posixPath(facts.config.path)) {
    report(sink, "solidity-config-not-tracked", facts.config.path, "Foundry config is not in the exact Git denominator");
  } else {
    if (config.contentSha256 !== facts.config.contentSha256 || config.byteLength !== facts.config.byteLength) {
      report(sink, "solidity-config-content-drift", facts.config.path, "Foundry config bytes do not match the tracked denominator");
    }
  }
  const toolchainPin = tracked.get(facts.toolchain.pinPath);
  if (toolchainPin === undefined) {
    report(sink, "solidity-toolchain-pin-not-tracked", facts.toolchain.pinPath, "Stored Foundry facts do not join a tracked toolchain pin");
  } else if (toolchainPin.contentSha256 !== facts.toolchain.pinContentSha256) {
    report(sink, "solidity-toolchain-pin-drift", facts.toolchain.pinPath, "Stored Foundry facts do not match the tracked toolchain pin bytes");
  }
  const sourcePaths = files.filter((file) => file.language === "solidity").map((file) => file.path).sort();
  const factPaths = facts.sourceFiles.map((file) => file.path).sort();
  if (canonical(sourcePaths) !== canonical(factPaths)) report(sink, "solidity-source-set-mismatch", facts.config.path, "Stored Solidity facts do not cover exactly the tracked Solidity source set");
  for (const source of facts.sourceFiles) {
    const current = tracked.get(source.path);
    if (current === undefined) {
      report(sink, "solidity-source-not-tracked", source.path, "Stored Solidity source fact is absent from the exact Git denominator");
      continue;
    }
    if (current.blobSha !== source.blobSha || current.contentSha256 !== source.contentSha256 || current.byteLength !== source.byteLength) {
      report(sink, "solidity-source-content-drift", source.path, "Stored Solidity source fact does not match the tracked source bytes");
    }
  }
  if (recomputeSourceRoot(facts) !== facts.sourceRoot) report(sink, "solidity-source-root-mismatch", facts.config.path, "Solidity source fact root does not recompute");
  if (recomputeImportRoot(facts) !== facts.importRoot) report(sink, "solidity-import-root-mismatch", facts.config.path, "Solidity import fact root does not recompute");
  if (recomputeBuildInfoRoot(facts) !== facts.buildInfoRoot) report(sink, "solidity-build-info-root-mismatch", facts.config.path, "Foundry build-info fact root does not recompute");
  const withoutRoot = { ...facts } as Omit<FoundryBuildGraphFactsV1, "rootDigest">;
  delete (withoutRoot as { rootDigest?: string }).rootDigest;
  if (recomputeRoot(withoutRoot) !== facts.rootDigest) report(sink, "solidity-build-graph-root-mismatch", facts.config.path, "Foundry build graph root does not recompute");
}

/**
 * Run the pinned Foundry toolchain and collect its exact compiler graph.  A
 * missing toolchain or stale build-info is an invalid boundary observation;
 * the caller must not replace it with metadata-only config hashing.
 */
export function collectFoundryBuildGraphFacts(
  gitRoot: string,
  files: readonly TrackedFile[],
  sink: SolidityDiagnosticSink,
): FoundryBuildGraphFactsV1 | null {
  const sourceFiles = files.filter((file) => file.language === "solidity");
  if (sourceFiles.length === 0) return null;
  const configs = files.filter((file) => file.path.endsWith("/foundry.toml") || file.path === "foundry.toml");
  const roots = configs.filter((config) => sourceFiles.every((file) => isInside(resolve(gitRoot, dirname(config.path)), resolve(gitRoot, file.path))));
  if (roots.length !== 1) {
    report(sink, "solidity-foundry-config-ambiguous", configs.map((file) => file.path).join(",") || "foundry.toml", "Exactly one tracked foundry.toml must own every tracked Solidity source");
    return null;
  }
  const configFile = roots[0]!;
  const configRoot = resolve(gitRoot, dirname(configFile.path));
  const tracked = new Map(files.map((file) => [file.path, file]));
  const pinPath = posixPath(join(dirname(configFile.path), "foundry-toolchain.json"));
  const pinFile = tracked.get(pinPath);
  if (pinFile === undefined) {
    report(sink, "solidity-toolchain-pin-missing", pinPath, "Solidity entered the denominator without an exact tracked Foundry/solc toolchain pin");
    return null;
  }
  let pinBytes: Buffer;
  let pin: FoundryToolchainPinV1 | null;
  try {
    pinBytes = readFileSync(resolve(gitRoot, pinPath));
    pin = decodeToolchainPin(JSON.parse(pinBytes.toString("utf8")), pinPath, sink);
  } catch (error) {
    report(sink, "solidity-toolchain-pin-unreadable", pinPath, String(error));
    return null;
  }
  if (pin === null) return null;
  if (sha256(pinBytes) !== pinFile.contentSha256 || pinBytes.byteLength !== pinFile.byteLength) {
    report(sink, "solidity-toolchain-pin-drift", pinPath, "Foundry toolchain pin bytes differ from the exact tracked denominator");
    return null;
  }
  const forgeExecutable = findExecutable("forge");
  if (forgeExecutable === null) {
    report(sink, "solidity-toolchain-unavailable", pinPath, "Pinned forge executable is unavailable");
    return null;
  }
  let configBytes: Buffer;
  try {
    configBytes = readFileSync(resolve(gitRoot, configFile.path));
  } catch (error) {
    report(sink, "solidity-config-unreadable", configFile.path, String(error));
    return null;
  }
  if (sha256(configBytes) !== configFile.contentSha256 || configBytes.byteLength !== configFile.byteLength) {
    report(sink, "solidity-config-content-drift", configFile.path, "Foundry config bytes differ from the tracked denominator");
  }
  const ownedSources = expectedSolidityFiles(gitRoot, configRoot, files, sink);
  if (ownedSources.length !== sourceFiles.length) return null;
  let forgeConfigRaw: unknown;
  let forgeVersionText: string;
  try {
    forgeConfigRaw = JSON.parse(runForge(forgeExecutable, gitRoot, ["config", "--root", configRoot, "--json", "--offline"]));
    forgeVersionText = runForge(forgeExecutable, gitRoot, ["--version"]);
    runForge(forgeExecutable, gitRoot, ["build", "--root", configRoot, "--build-info", "--force", "--offline"]);
  } catch (error) {
    report(sink, "solidity-toolchain-unavailable", configFile.path, `Pinned forge config/build failed: ${String(error)}`);
    return null;
  }
  const toolchain = parseForgeVersion(forgeVersionText, sink);
  if (toolchain === null) return null;
  if (
    toolchain.forgeVersion !== pin.forgeVersion
    || toolchain.forgeCommit !== pin.forgeCommit
    || toolchain.forgeBuildTimestamp !== pin.forgeBuildTimestamp
    || toolchain.forgeBuildProfile !== pin.forgeBuildProfile
  ) {
    report(sink, "solidity-forge-pin-mismatch", pinPath, "Observed forge identity does not exact-match the tracked toolchain pin");
    return null;
  }
  const configEffective = effectiveConfig(forgeConfigRaw, gitRoot, sink);
  const configFact: FoundryConfigFactV1 = Object.freeze({
    path: configFile.path,
    contentSha256: configFile.contentSha256,
    byteLength: configFile.byteLength,
    effectiveConfig: configEffective,
    effectiveConfigRoot: hashDomain("aloha/solidity/effective-config/v1", configEffective),
  });
  const expectedPaths = ownedSources.map((file) => file.path).sort();
  const candidates = buildInfoCandidates(configRoot, gitRoot, sink);
  const matching = candidates.filter((candidate) => {
    const input = asRecord(candidate.value.input);
    const inputSources = asRecord(input?.sources);
    const paths = Object.keys(inputSources ?? {}).map((path) => sourcePathFromBuildInfo(configRoot, gitRoot, path)).sort();
    if (canonical(paths) !== canonical(expectedPaths)) return false;
    return expectedPaths.every((path) => {
      const source = inputSources?.[path.slice(repoRelative(gitRoot, configRoot).length + 1)] ?? inputSources?.[path];
      const current = tracked.get(path);
      return current !== undefined && sourceContentHash(source) === current.contentSha256;
    });
  });
  if (matching.length !== 1) {
    report(sink, "solidity-build-info-drift", configFile.path, `Expected exactly one fresh Foundry build-info record for ${expectedPaths.length} tracked Solidity sources; observed ${matching.length}`);
    return null;
  }
  const buildInfo = matching[0]!;
  const input = asRecord(buildInfo.value.input);
  const output = asRecord(buildInfo.value.output);
  const inputSources = asRecord(input?.sources);
  const outputSources = asRecord(output?.sources);
  const solcVersion = asString(buildInfo.value.solcVersion);
  const solcLongVersion = asString(buildInfo.value.solcLongVersion);
  if (input === null || output === null || inputSources === null || outputSources === null || solcVersion === null || solcLongVersion === null) {
    report(sink, "solidity-build-info-incomplete", buildInfo.path, "Foundry build-info must include exact input, output, source and compiler facts");
    return null;
  }
  const solcPath = solcExecutable(pin.solcVersion);
  if (solcPath === null) {
    report(sink, "solidity-solc-executable-missing", pinPath, `Pinned solc ${pin.solcVersion} is unavailable in the deterministic SVM store`);
    return null;
  }
  let observedSolcLongVersion: string;
  try {
    const output = execFileSync(solcPath, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    observedSolcLongVersion = /^Version:\s*(\S+)$/m.exec(output)?.[1] ?? "";
  } catch (error) {
    report(sink, "solidity-solc-introspection-failed", pinPath, String(error));
    return null;
  }
  if (solcVersion !== pin.solcVersion || !observedSolcLongVersion.startsWith(`${pin.solcVersion}+commit.${pin.solcCommit}`)) {
    report(sink, "solidity-solc-pin-mismatch", pinPath, "Observed build-info and solc executable do not exact-match the tracked toolchain pin");
    return null;
  }
  const sourceFacts: SoliditySourceFactV1[] = [];
  const imports: SolidityImportFactV1[] = [];
  for (const file of ownedSources) {
    const configRelative = repoRelative(gitRoot, configRoot);
    const sourceKey = file.path.startsWith(`${configRelative}/`) ? file.path.slice(configRelative.length + 1) : file.path;
    const inputSource = asRecord(inputSources[sourceKey] ?? inputSources[file.path]);
    const outputSource = asRecord(outputSources[sourceKey] ?? outputSources[file.path]);
    const compilerContentSha256 = sourceContentHash(inputSource);
    if (inputSource === null || outputSource === null || compilerContentSha256 === null) {
      report(sink, "solidity-build-source-missing", file.path, "Fresh Foundry build-info is missing exact source content/output AST");
      continue;
    }
    const id = typeof outputSource.id === "number" ? outputSource.id : -1;
    if (id < 0) report(sink, "solidity-build-source-id-missing", file.path, "Foundry output source must carry a numeric source ID");
    const sourceImports = importFactsFromAst(configRoot, gitRoot, file.path, outputSource, configEffective, sink);
    sourceFacts.push(Object.freeze({
      path: file.path,
      blobSha: file.blobSha,
      contentSha256: file.contentSha256,
      byteLength: file.byteLength,
      compilerSourceId: id,
      compilerContentSha256,
      imports: Object.freeze(sourceImports),
    }));
    imports.push(...sourceImports);
  }
  const settings = normalizeConfigValue(input.settings ?? null, gitRoot, sink, "input.settings");
  const compilerInputRoot = hashDomain("aloha/solidity/compiler-input/v1", {
    language: input.language ?? null,
    version: input.version ?? null,
    sources: sourceFacts.map((source) => ({ path: source.path, compilerContentSha256: source.compilerContentSha256 })),
    basePath: input.basePath ?? null,
    allowPaths: input.allowPaths ?? null,
    includePaths: input.includePaths ?? null,
  });
  const compilerSettingsRoot = hashDomain("aloha/solidity/compiler-settings/v1", settings);
  const outputRoot = hashDomain("aloha/solidity/compiler-output/v1", normalizeConfigValue(output, gitRoot, sink, "input.output"));
  const buildInfoFact: FoundryBuildInfoFactV1 = Object.freeze({
    path: buildInfo.path,
    contentSha256: sha256(buildInfo.bytes),
    byteLength: buildInfo.bytes.byteLength,
    buildInfoId: asString(buildInfo.value.id) ?? "",
    sourcePaths: Object.freeze(expectedPaths),
    inputRoot: compilerInputRoot,
    inputSettingsRoot: compilerSettingsRoot,
    outputRoot,
    solcVersion,
    solcLongVersion,
  });
  const finalToolchain: FoundryToolchainFactV1 = Object.freeze({
    ...toolchain,
    pinPath,
    pinContentSha256: pinFile.contentSha256,
    forgeExecutableSha256: sha256(readFileSync(forgeExecutable)),
    solcVersion,
    solcLongVersion: observedSolcLongVersion,
    solcExecutableSha256: sha256(readFileSync(solcPath)),
    compilerInputRoot,
    compilerSettingsRoot,
  });
  const factsWithoutRoot = {
    schemaVersion: 1 as const,
    config: configFact,
    sourceFiles: Object.freeze(sourceFacts.sort((left, right) => left.path.localeCompare(right.path))),
    imports: Object.freeze(imports.sort((left, right) => `${left.from}|${left.specifier}|${left.resolvedPath}`.localeCompare(`${right.from}|${right.specifier}|${right.resolvedPath}`))),
    buildInfos: Object.freeze([buildInfoFact]),
    toolchain: finalToolchain,
    sourceRoot: "",
    importRoot: "",
    buildInfoRoot: "",
  };
  const facts: FoundryBuildGraphFactsV1 = {
    ...factsWithoutRoot,
    sourceRoot: recomputeSourceRoot(factsWithoutRoot),
    importRoot: recomputeImportRoot(factsWithoutRoot),
    buildInfoRoot: recomputeBuildInfoRoot(factsWithoutRoot),
    rootDigest: "",
  };
  const { rootDigest: _rootDigest, ...complete } = facts;
  const finalized = Object.freeze({ ...facts, rootDigest: recomputeRoot(complete) });
  validateFoundryBuildGraphFacts(gitRoot, files, finalized, sink);
  return finalized;
}
