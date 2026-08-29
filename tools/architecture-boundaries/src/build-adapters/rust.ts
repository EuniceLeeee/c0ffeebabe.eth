import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

export interface RustBuildTrackedFileV1 {
  readonly path: string;
  readonly blobSha: string;
  readonly contentSha256: string;
  readonly byteLength: number;
  readonly language: string;
}

export interface RustBuildAdapterDiagnosticV1 {
  readonly kind: "invalid";
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface RustBuildInputFactV1 {
  readonly logicalPath: string;
  readonly origin: "tracked" | "cargo-package" | "generated" | "rust-toolchain";
  readonly ownerId: string;
  readonly contentSha256: string;
  readonly byteLength: number;
  readonly trackedBlobSha: string | null;
  readonly packageChecksum: string | null;
}

export interface RustBuildTargetFactV1 {
  readonly name: string;
  readonly kind: readonly string[];
  readonly crateTypes: readonly string[];
  readonly srcPath: string;
  readonly edition: string;
  readonly requiredFeatures: readonly string[];
  readonly doctest: boolean;
  readonly test: boolean;
  readonly doc: boolean;
}

export interface RustBuildPackageFactV1 {
  readonly packageId: string;
  readonly name: string;
  readonly version: string;
  readonly source: string | null;
  readonly checksum: string | null;
  readonly manifestPath: string;
  readonly edition: string;
  readonly features: readonly { readonly name: string; readonly members: readonly string[] }[];
  readonly targets: readonly RustBuildTargetFactV1[];
}

export interface RustBuildDependencyEdgeV1 {
  readonly fromPackageId: string;
  readonly toPackageId: string;
  readonly name: string;
  readonly kinds: readonly { readonly kind: string | null; readonly target: string | null }[];
}

export interface RustCompilerUnitFactV1 {
  readonly packageId: string;
  readonly targetName: string;
  readonly targetKinds: readonly string[];
  readonly crateTypes: readonly string[];
  readonly features: readonly string[];
  readonly profile: {
    readonly optLevel: string;
    readonly debuginfo: number | boolean | null;
    readonly debugAssertions: boolean;
    readonly overflowChecks: boolean;
    readonly test: boolean;
  };
}

export interface RustBuildScriptFactV1 {
  readonly packageId: string;
  readonly linkedLibs: readonly string[];
  readonly linkedPaths: readonly string[];
  readonly cfgs: readonly string[];
  readonly environment: readonly { readonly name: string; readonly value: string }[];
  readonly generatedInputRoot: string;
}

export interface RustBuildAdapterFactsV1 {
  readonly schemaVersion: 1;
  readonly adapterId: "aloha.cargo-rustc-build-graph";
  readonly adapterVersion: "1";
  readonly manifestPaths: readonly string[];
  readonly lockPaths: readonly string[];
  readonly toolchain: {
    readonly pinPath: string;
    readonly pinnedChannel: string;
    readonly pinContentSha256: string;
    readonly cargoVersion: string;
    readonly rustcVersion: string;
    readonly host: string;
    readonly cargoExecutableSha256: string;
    readonly rustcExecutableSha256: string;
    readonly targetLibInputRoot: string;
  };
  readonly packages: readonly RustBuildPackageFactV1[];
  readonly dependencyEdges: readonly RustBuildDependencyEdgeV1[];
  readonly compilerUnits: readonly RustCompilerUnitFactV1[];
  readonly buildScripts: readonly RustBuildScriptFactV1[];
  readonly compilerInputs: readonly RustBuildInputFactV1[];
  readonly cargoMetadataRoot: string;
  readonly packageGraphRoot: string;
  readonly featureRoot: string;
  readonly compilerMessageRoot: string;
  readonly depInfoRoot: string;
  readonly buildScriptRoot: string;
  readonly procMacroRoot: string;
  readonly generatedInputRoot: string;
  readonly compilerInputRoot: string;
  readonly rootDigest: string;
}

export interface RustBuildAdapterResultV1 {
  readonly facts: RustBuildAdapterFactsV1 | null;
  readonly diagnostics: readonly RustBuildAdapterDiagnosticV1[];
}

interface CargoMetadataPackage {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly source: string | null;
  readonly checksum: string | null;
  readonly manifest_path: string;
  readonly edition: string;
  readonly features: Readonly<Record<string, readonly string[]>>;
  readonly targets: readonly {
    readonly name: string;
    readonly kind: readonly string[];
    readonly crate_types: readonly string[];
    readonly src_path: string;
    readonly edition: string;
    readonly required_features: readonly string[];
    readonly doctest: boolean;
    readonly test: boolean;
    readonly doc: boolean;
  }[];
}

interface CargoMetadataV1 {
  readonly packages: readonly CargoMetadataPackage[];
  readonly resolve: {
    readonly nodes: readonly {
      readonly id: string;
      readonly features: readonly string[];
      readonly deps: readonly {
        readonly name: string;
        readonly pkg: string;
        readonly dep_kinds: readonly { readonly kind: string | null; readonly target: string | null }[];
      }[];
    }[];
  } | null;
}

interface PackageRoot {
  readonly rawId: string;
  readonly stableId: string;
  readonly root: string;
  readonly checksum: string | null;
}

function posix(value: string): string {
  return value.split(sep).join("/");
}

function inside(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite hash input");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  throw new TypeError("unsupported hash input");
}

function hashDomain(domain: string, value: unknown): string {
  return `0x${createHash("sha256").update(domain).update("\0").update(canonical(value)).digest("hex")}`;
}

function contentSha256(bytes: Buffer): string {
  return `0x${createHash("sha256").update(bytes).digest("hex")}`;
}

function invalid(code: string, path: string, message: string): RustBuildAdapterDiagnosticV1 {
  return { kind: "invalid", code, path: posix(path), message };
}

function findExecutable(name: string): string | null {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      const physical = realpathSync(candidate);
      if (lstatSync(physical).isFile()) return physical;
    } catch {
      // Continue through the exact PATH search order.
    }
  }
  return null;
}

function run(
  executable: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): { readonly stdout: string; readonly stderr: string; readonly ok: boolean; readonly error: string | null } {
  const result = spawnSync(executable, [...args], {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 512 * 1024 * 1024,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ok: result.status === 0 && result.error === undefined,
    error: result.error ? String(result.error) : result.status === 0 ? null : `exit ${String(result.status)}`,
  };
}

function walkFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const result: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) result.push(path);
    }
  };
  visit(root);
  return result.sort();
}

function nearestTrackedAncestor(
  sourcePath: string,
  fileName: string,
  tracked: ReadonlyMap<string, RustBuildTrackedFileV1>,
): string | null {
  let directory = dirname(sourcePath);
  for (;;) {
    const candidate = posix(join(directory, fileName));
    if (tracked.has(candidate)) return candidate;
    if (directory === "." || directory === "") return tracked.has(fileName) ? fileName : null;
    const next = posix(dirname(directory));
    if (next === directory) return null;
    directory = next;
  }
}

function stablePackageId(root: string, value: CargoMetadataPackage): string {
  const manifest = resolve(value.manifest_path);
  if (inside(root, manifest)) return `workspace:${posix(relative(root, manifest))}#${value.name}@${value.version}`;
  return `${value.source ?? "external"}#${value.name}@${value.version}`;
}

function validateMetadata(value: unknown): CargoMetadataV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("cargo metadata object expected");
  const metadata = value as Partial<CargoMetadataV1>;
  if (!Array.isArray(metadata.packages)) throw new TypeError("cargo metadata packages missing");
  for (const entry of metadata.packages) {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || typeof entry.name !== "string" || typeof entry.version !== "string" || typeof entry.manifest_path !== "string" || !Array.isArray(entry.targets) || !entry.features || typeof entry.features !== "object") {
      throw new TypeError("cargo metadata package malformed");
    }
  }
  if (metadata.resolve !== null && (!metadata.resolve || !Array.isArray(metadata.resolve.nodes))) throw new TypeError("cargo resolve graph missing");
  return metadata as CargoMetadataV1;
}

function makeTokens(source: string): string[] {
  const result: string[] = [];
  let current = "";
  let escaped = false;
  for (const character of source) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (/\s/.test(character)) {
      if (current) result.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  if (escaped) current += "\\";
  if (current) result.push(current);
  return result;
}

function depInfoSources(targetDirectory: string, workingDirectory: string): { readonly files: readonly string[]; readonly depInfoRoot: string } {
  const records = walkFiles(targetDirectory)
    .filter((path) => path.endsWith(".d"))
    .map((path) => {
      const normalized = readFileSync(path, "utf8").replace(/\\\r?\n/g, " ");
      const dependencies = new Set<string>();
      for (const line of normalized.split(/\r?\n/)) {
        const separator = line.indexOf(": ");
        if (separator < 0) continue;
        for (const item of makeTokens(line.slice(separator + 2))) dependencies.add(isAbsolute(item) ? resolve(item) : resolve(workingDirectory, item));
      }
      return {
        path: posix(relative(targetDirectory, path)),
        dependencies: Array.from(dependencies).sort(),
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  return {
    files: Array.from(new Set(records.flatMap((record) => record.dependencies))).sort(),
    depInfoRoot: hashDomain("aloha/rust/dep-info/v1", records),
  };
}

function normalizeProfile(value: unknown): RustCompilerUnitFactV1["profile"] {
  const profile = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    optLevel: typeof profile.opt_level === "string" ? profile.opt_level : "",
    debuginfo: typeof profile.debuginfo === "number" || typeof profile.debuginfo === "boolean" ? profile.debuginfo : null,
    debugAssertions: profile.debug_assertions === true,
    overflowChecks: profile.overflow_checks === true,
    test: profile.test === true,
  };
}

function exactStrings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new TypeError("string array expected");
  return [...value].sort();
}

function normalizeEnvironmentValue(value: string, roots: readonly { readonly physical: string; readonly logical: string }[]): string {
  let result = value;
  for (const root of [...roots].sort((a, b) => b.physical.length - a.physical.length)) {
    result = result.split(root.physical).join(root.logical);
  }
  return posix(result);
}

/**
 * Collects Rust build facts by executing the pinned Cargo/Rustc graph.  The
 * adapter never accepts a caller-provided file list or success verdict: local
 * inputs must join the exact tracked denominator and external inputs must join
 * a Cargo metadata package protected by the exact Cargo.lock.
 */
export function collectRustBuildAdapterFacts(
  rootInput: string,
  trackedFiles: readonly RustBuildTrackedFileV1[],
): RustBuildAdapterResultV1 {
  const diagnostics: RustBuildAdapterDiagnosticV1[] = [];
  const rustSources = trackedFiles.filter((file) => file.language === "rust");
  if (rustSources.length === 0) return { facts: null, diagnostics };

  const root = resolve(rootInput);
  const tracked = new Map(trackedFiles.map((file) => [file.path, file]));
  const pinPath = "rust-toolchain.toml";
  const pin = tracked.get(pinPath);
  if (!pin) {
    diagnostics.push(invalid("rust-toolchain-pin-missing", pinPath, "Rust entered the denominator without a tracked rust-toolchain.toml"));
    return { facts: null, diagnostics };
  }
  const pinText = readFileSync(join(root, pinPath), "utf8");
  const channel = /^\s*channel\s*=\s*"(\d+\.\d+\.\d+)"\s*$/m.exec(pinText)?.[1] ?? null;
  if (!channel) {
    diagnostics.push(invalid("rust-toolchain-pin-not-exact", pinPath, "Rust toolchain channel must be an exact semantic version"));
    return { facts: null, diagnostics };
  }

  const manifestPaths = Array.from(new Set(rustSources.map((file) => nearestTrackedAncestor(file.path, "Cargo.toml", tracked))))
    .filter((value): value is string => value !== null)
    .sort();
  for (const source of rustSources) {
    if (nearestTrackedAncestor(source.path, "Cargo.toml", tracked) === null) diagnostics.push(invalid("rust-source-manifest-missing", source.path, "Tracked Rust source has no tracked Cargo.toml owner"));
  }
  if (manifestPaths.length === 0) return { facts: null, diagnostics };
  const lockPaths = Array.from(new Set(manifestPaths.map((path) => nearestTrackedAncestor(path, "Cargo.lock", tracked))))
    .filter((value): value is string => value !== null)
    .sort();
  for (const manifest of manifestPaths) {
    if (nearestTrackedAncestor(manifest, "Cargo.lock", tracked) === null) diagnostics.push(invalid("cargo-lock-missing", manifest, "Cargo manifest has no tracked Cargo.lock ancestor"));
  }
  if (diagnostics.length > 0) return { facts: null, diagnostics };

  const cargoExecutable = findExecutable("cargo");
  const rustcExecutable = findExecutable("rustc");
  if (!cargoExecutable || !rustcExecutable) {
    diagnostics.push(invalid("rust-toolchain-executable-missing", pinPath, "Pinned cargo and rustc executables must both be available"));
    return { facts: null, diagnostics };
  }
  const cargoHome = join(tmpdir(), "aloha-boundary-cargo-home-v1");
  mkdirSync(cargoHome, { recursive: true });
  for (const configName of ["config", "config.toml"]) {
    if (existsSync(join(cargoHome, configName))) diagnostics.push(invalid("cargo-home-config-present", configName, "Boundary-owned CARGO_HOME must not contain mutable configuration"));
  }
  if (diagnostics.length > 0) return { facts: null, diagnostics };

  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "TMPDIR", "TMP", "TEMP", "RUSTUP_HOME", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "SystemRoot"] as const) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  if (env.RUSTUP_HOME === undefined && process.env.HOME !== undefined) env.RUSTUP_HOME = join(process.env.HOME, ".rustup");
  env.HOME = cargoHome;
  env.CARGO_HOME = cargoHome;
  env.CARGO_TERM_COLOR = "never";
  env.CARGO_INCREMENTAL = "0";
  env.CARGO_REGISTRIES_CRATES_IO_PROTOCOL = "sparse";
  env.RUSTC = rustcExecutable;
  env.RUSTFLAGS = "";
  env.RUSTDOCFLAGS = "";
  env.LC_ALL = "C";
  env.LANG = "C";
  env.TZ = "UTC";
  env.SOURCE_DATE_EPOCH = "0";

  const cargoVersionResult = run(cargoExecutable, ["--version", "--verbose"], root, env);
  const rustcVersionResult = run(rustcExecutable, ["--version", "--verbose"], root, env);
  const targetLibResult = run(rustcExecutable, ["--print", "target-libdir"], root, env);
  if (!cargoVersionResult.ok || !rustcVersionResult.ok || !targetLibResult.ok) {
    diagnostics.push(invalid("rust-toolchain-introspection-failed", pinPath, [cargoVersionResult.error, rustcVersionResult.error, targetLibResult.error].filter(Boolean).join("; ")));
    return { facts: null, diagnostics };
  }
  const cargoVersion = cargoVersionResult.stdout.trim();
  const rustcVersion = rustcVersionResult.stdout.trim();
  const rustcRelease = /^release:\s*(\S+)$/m.exec(rustcVersion)?.[1] ?? null;
  const host = /^host:\s*(\S+)$/m.exec(rustcVersion)?.[1] ?? null;
  if (rustcRelease !== channel || host === null) {
    diagnostics.push(invalid("rust-toolchain-pin-mismatch", pinPath, `Pinned ${channel} but rustc reported ${rustcRelease ?? "unknown"}`));
    return { facts: null, diagnostics };
  }

  const compilerInputs = new Map<string, RustBuildInputFactV1>();
  const recordInput = (
    path: string,
    origin: RustBuildInputFactV1["origin"],
    ownerId: string,
    logicalPath: string,
    trackedFile: RustBuildTrackedFileV1 | null,
    packageChecksum: string | null,
  ): void => {
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch (error) {
      diagnostics.push(invalid("rust-compiler-input-unreadable", logicalPath, String(error)));
      return;
    }
    const content = contentSha256(bytes);
    if (trackedFile && (trackedFile.contentSha256 !== content || trackedFile.byteLength !== bytes.byteLength)) {
      diagnostics.push(invalid("rust-compiler-input-index-mismatch", logicalPath, "Cargo-visible local input differs from the exact tracked denominator"));
      return;
    }
    const fact: RustBuildInputFactV1 = {
      logicalPath,
      origin,
      ownerId,
      contentSha256: content,
      byteLength: bytes.byteLength,
      trackedBlobSha: trackedFile?.blobSha ?? null,
      packageChecksum,
    };
    const previous = compilerInputs.get(logicalPath);
    if (previous && canonical(previous) !== canonical(fact)) diagnostics.push(invalid("rust-compiler-input-alias", logicalPath, "One logical compiler input resolved to different physical facts"));
    else compilerInputs.set(logicalPath, fact);
  };

  const pinAbsolute = join(root, pinPath);
  recordInput(pinAbsolute, "tracked", "rust-toolchain", pinPath, pin, null);
  recordInput(cargoExecutable, "rust-toolchain", "cargo", `rust-toolchain/${channel}/bin/cargo`, null, null);
  recordInput(rustcExecutable, "rust-toolchain", "rustc", `rust-toolchain/${channel}/bin/rustc`, null, null);
  const targetLibDirectory = resolve(targetLibResult.stdout.trim());
  for (const path of walkFiles(targetLibDirectory)) {
    recordInput(path, "rust-toolchain", "rustc-target-lib", `rust-toolchain/${channel}/target-lib/${posix(relative(targetLibDirectory, path))}`, null, null);
  }
  const targetLibInputs = Array.from(compilerInputs.values()).filter((input) => input.ownerId === "rustc-target-lib").sort((a, b) => a.logicalPath.localeCompare(b.logicalPath));
  const targetLibInputRoot = hashDomain("aloha/rust/target-lib-inputs/v1", targetLibInputs);

  const allPackages = new Map<string, RustBuildPackageFactV1>();
  const allEdges = new Map<string, RustBuildDependencyEdgeV1>();
  const allUnits = new Map<string, RustCompilerUnitFactV1>();
  const allBuildScripts = new Map<string, RustBuildScriptFactV1>();
  const metadataFacts: unknown[] = [];
  const depInfoRoots: string[] = [];
  const generatedInputs = new Set<string>();
  const compiledTrackedRust = new Set<string>();

  for (const manifestPath of manifestPaths) {
    const manifestAbsolute = join(root, manifestPath);
    const manifestDirectory = dirname(manifestAbsolute);
    for (let directory = manifestDirectory;; directory = dirname(directory)) {
      for (const name of [join(".cargo", "config"), join(".cargo", "config.toml")]) {
        const path = join(directory, name);
        if (!existsSync(path)) continue;
        const logical = posix(relative(root, path));
        const trackedConfig = tracked.get(logical);
        if (!inside(root, path) || !trackedConfig) diagnostics.push(invalid("cargo-config-not-tracked", logical, "Cargo configuration affecting the build must be tracked"));
        else recordInput(path, "tracked", "cargo-config", logical, trackedConfig, null);
      }
      if (directory === root) break;
      if (!inside(root, dirname(directory))) break;
    }
    if (diagnostics.length > 0) continue;

    const targetDirectory = mkdtempSync(join(tmpdir(), "aloha-rust-target-"));
    try {
      const invocationEnv = { ...env, CARGO_TARGET_DIR: targetDirectory };
      const metadataResult = run(cargoExecutable, ["metadata", "--locked", "--format-version", "1", "--manifest-path", manifestAbsolute], manifestDirectory, invocationEnv);
      if (!metadataResult.ok) {
        diagnostics.push(invalid("cargo-metadata-failed", manifestPath, `${metadataResult.error ?? "failed"}: ${metadataResult.stderr.trim()}`));
        continue;
      }
      let metadata: CargoMetadataV1;
      try {
        metadata = validateMetadata(JSON.parse(metadataResult.stdout));
      } catch (error) {
        diagnostics.push(invalid("cargo-metadata-invalid", manifestPath, String(error)));
        continue;
      }
      const stableIds = new Map(metadata.packages.map((entry) => [entry.id, stablePackageId(root, entry)]));
      const packageRoots: PackageRoot[] = metadata.packages.map((entry) => ({
        rawId: entry.id,
        stableId: stableIds.get(entry.id)!,
        root: resolve(dirname(entry.manifest_path)),
        checksum: entry.checksum ?? null,
      })).sort((a, b) => b.root.length - a.root.length);

      const logicalPath = (pathInput: string): { readonly logical: string; readonly owner: PackageRoot | null } => {
        const path = resolve(pathInput);
        if (inside(root, path)) return { logical: posix(relative(root, path)), owner: packageRoots.find((entry) => inside(entry.root, path)) ?? null };
        const owner = packageRoots.find((entry) => inside(entry.root, path)) ?? null;
        if (owner) return { logical: `cargo/${encodeURIComponent(owner.stableId)}/${posix(relative(owner.root, path))}`, owner };
        if (inside(targetDirectory, path)) return { logical: `cargo-generated/${posix(relative(targetDirectory, path))}`, owner: null };
        return { logical: `unowned/${contentSha256(Buffer.from(path))}`, owner: null };
      };

      const packages = metadata.packages.map((entry): RustBuildPackageFactV1 => ({
        packageId: stableIds.get(entry.id)!,
        name: entry.name,
        version: entry.version,
        source: entry.source ?? null,
        checksum: entry.checksum ?? null,
        manifestPath: logicalPath(entry.manifest_path).logical,
        edition: entry.edition,
        features: Object.entries(entry.features).sort(([a], [b]) => a.localeCompare(b)).map(([name, members]) => ({ name, members: [...members].sort() })),
        targets: entry.targets.map((target): RustBuildTargetFactV1 => ({
          name: target.name,
          kind: [...target.kind].sort(),
          crateTypes: [...target.crate_types].sort(),
          srcPath: logicalPath(target.src_path).logical,
          edition: target.edition,
          requiredFeatures: [...(target.required_features ?? [])].sort(),
          doctest: target.doctest === true,
          test: target.test === true,
          doc: target.doc === true,
        })).sort((a, b) => `${a.name}:${a.srcPath}`.localeCompare(`${b.name}:${b.srcPath}`)),
      })).sort((a, b) => a.packageId.localeCompare(b.packageId));
      for (const entry of packages) allPackages.set(entry.packageId, entry);

      const edges = (metadata.resolve?.nodes ?? []).flatMap((node) => node.deps.map((dependency): RustBuildDependencyEdgeV1 => ({
        fromPackageId: stableIds.get(node.id) ?? node.id,
        toPackageId: stableIds.get(dependency.pkg) ?? dependency.pkg,
        name: dependency.name,
        kinds: dependency.dep_kinds.map((kind) => ({ kind: kind.kind ?? null, target: kind.target ?? null })).sort((a, b) => `${a.kind}:${a.target}`.localeCompare(`${b.kind}:${b.target}`)),
      }))).sort((a, b) => `${a.fromPackageId}:${a.name}:${a.toPackageId}`.localeCompare(`${b.fromPackageId}:${b.name}:${b.toPackageId}`));
      for (const edge of edges) allEdges.set(canonical(edge), edge);
      metadataFacts.push({ manifestPath, packages, edges, activeFeatures: (metadata.resolve?.nodes ?? []).map((node) => ({ packageId: stableIds.get(node.id) ?? node.id, features: [...node.features].sort() })).sort((a, b) => a.packageId.localeCompare(b.packageId)) });

      for (const path of lockPaths) {
        const file = tracked.get(path);
        if (file) recordInput(join(root, path), "tracked", "cargo-manifest", path, file, null);
      }
      for (const entry of metadata.packages) {
        const manifest = logicalPath(entry.manifest_path);
        const localTracked = inside(root, resolve(entry.manifest_path)) ? tracked.get(manifest.logical) ?? null : null;
        recordInput(entry.manifest_path, localTracked ? "tracked" : "cargo-package", stableIds.get(entry.id)!, manifest.logical, localTracked, entry.checksum ?? null);
      }

      const checkResult = run(cargoExecutable, [
        "check",
        "--locked",
        "--release",
        "--all-targets",
        "--all-features",
        "--message-format=json-render-diagnostics",
        "--manifest-path",
        manifestAbsolute,
        "--target-dir",
        targetDirectory,
      ], manifestDirectory, invocationEnv);
      if (!checkResult.ok) {
        diagnostics.push(invalid("cargo-compiler-graph-failed", manifestPath, `${checkResult.error ?? "failed"}: ${checkResult.stderr.trim()}`));
        continue;
      }
      const rootsForNormalization = [
        { physical: targetDirectory, logical: "$TARGET" },
        { physical: root, logical: "$REPO" },
        { physical: cargoHome, logical: "$CARGO_HOME" },
      ];
      for (const line of checkResult.stdout.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let message: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(line);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("message object expected");
          message = parsed as Record<string, unknown>;
        } catch (error) {
          diagnostics.push(invalid("cargo-compiler-message-invalid", manifestPath, String(error)));
          continue;
        }
        if (message.reason === "compiler-artifact") {
          const rawPackageId = typeof message.package_id === "string" ? message.package_id : null;
          const target = message.target && typeof message.target === "object" && !Array.isArray(message.target) ? message.target as Record<string, unknown> : null;
          if (!rawPackageId || !target || typeof target.name !== "string") {
            diagnostics.push(invalid("cargo-compiler-artifact-invalid", manifestPath, "Compiler artifact omitted package or target identity"));
            continue;
          }
          try {
            const unit: RustCompilerUnitFactV1 = {
              packageId: stableIds.get(rawPackageId) ?? rawPackageId,
              targetName: target.name,
              targetKinds: exactStrings(target.kind),
              crateTypes: exactStrings(target.crate_types),
              features: exactStrings(message.features),
              profile: normalizeProfile(message.profile),
            };
            allUnits.set(canonical(unit), unit);
          } catch (error) {
            diagnostics.push(invalid("cargo-compiler-artifact-invalid", manifestPath, String(error)));
          }
        } else if (message.reason === "build-script-executed") {
          const rawPackageId = typeof message.package_id === "string" ? message.package_id : null;
          const outDir = typeof message.out_dir === "string" ? resolve(message.out_dir) : null;
          if (!rawPackageId || !outDir || !inside(targetDirectory, outDir)) {
            diagnostics.push(invalid("cargo-build-script-message-invalid", manifestPath, "Build script omitted an owned output directory"));
            continue;
          }
          const generated: RustBuildInputFactV1[] = [];
          for (const path of walkFiles(outDir)) {
            const logical = `cargo-generated/${encodeURIComponent(stableIds.get(rawPackageId) ?? rawPackageId)}/${posix(relative(outDir, path))}`;
            recordInput(path, "generated", stableIds.get(rawPackageId) ?? rawPackageId, logical, null, null);
            generatedInputs.add(logical);
            const fact = compilerInputs.get(logical);
            if (fact) generated.push(fact);
          }
          try {
            const environmentEntries: Array<readonly [string, string]> = Array.isArray(message.env)
              ? message.env.map((entry) => {
                if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || typeof entry[1] !== "string") throw new TypeError("build-script environment pair expected");
                return [entry[0], entry[1]] as const;
              })
              : message.env && typeof message.env === "object"
                ? Object.entries(message.env as Record<string, unknown>).map(([name, value]) => {
                  if (typeof value !== "string") throw new TypeError("build-script environment value must be string");
                  return [name, value] as const;
                })
                : [];
            const fact: RustBuildScriptFactV1 = {
              packageId: stableIds.get(rawPackageId) ?? rawPackageId,
              linkedLibs: exactStrings(message.linked_libs),
              linkedPaths: exactStrings(message.linked_paths).map((value) => normalizeEnvironmentValue(value, rootsForNormalization)),
              cfgs: exactStrings(message.cfgs),
              environment: environmentEntries.map(([name, value]) => {
                return { name, value: normalizeEnvironmentValue(value, rootsForNormalization) };
              }).sort((a, b) => a.name.localeCompare(b.name)),
              generatedInputRoot: hashDomain("aloha/rust/build-script-generated-input/v1", generated.sort((a, b) => a.logicalPath.localeCompare(b.logicalPath))),
            };
            allBuildScripts.set(fact.packageId, fact);
          } catch (error) {
            diagnostics.push(invalid("cargo-build-script-message-invalid", manifestPath, String(error)));
          }
        }
      }

      const depInfo = depInfoSources(targetDirectory, manifestDirectory);
      depInfoRoots.push(depInfo.depInfoRoot);
      for (const path of depInfo.files) {
        const resolved = resolve(path);
        const logical = logicalPath(resolved);
        if (inside(root, resolved)) {
          const file = tracked.get(logical.logical);
          if (!file) {
            diagnostics.push(invalid("rust-compiler-input-not-tracked", logical.logical, "Rustc consumed a repository input outside the exact tracked denominator"));
            continue;
          }
          recordInput(resolved, "tracked", logical.owner?.stableId ?? "workspace", logical.logical, file, null);
          if (file.language === "rust") compiledTrackedRust.add(file.path);
        } else if (logical.owner) {
          recordInput(resolved, "cargo-package", logical.owner.stableId, logical.logical, null, logical.owner.checksum);
        } else if (inside(targetDirectory, resolved)) {
          recordInput(resolved, "generated", "cargo-generated", logical.logical, null, null);
          generatedInputs.add(logical.logical);
        } else {
          diagnostics.push(invalid("rust-compiler-input-unowned", logical.logical, "Rustc dep-info contains an input not owned by Git, Cargo.lock, generated output, or the pinned toolchain"));
        }
      }
    } finally {
      rmSync(targetDirectory, { recursive: true, force: true });
    }
  }

  for (const source of rustSources) {
    if (!compiledTrackedRust.has(source.path)) diagnostics.push(invalid("rust-source-not-in-compiler-graph", source.path, "Tracked Rust source did not enter the pinned all-targets/all-features compiler graph"));
  }
  if (diagnostics.length > 0) return { facts: null, diagnostics };

  const packages = Array.from(allPackages.values()).sort((a, b) => a.packageId.localeCompare(b.packageId));
  const dependencyEdges = Array.from(allEdges.values()).sort((a, b) => `${a.fromPackageId}:${a.name}:${a.toPackageId}`.localeCompare(`${b.fromPackageId}:${b.name}:${b.toPackageId}`));
  const compilerUnits = Array.from(allUnits.values()).sort((a, b) => canonical(a).localeCompare(canonical(b)));
  const buildScripts = Array.from(allBuildScripts.values()).sort((a, b) => a.packageId.localeCompare(b.packageId));
  const inputs = Array.from(compilerInputs.values()).sort((a, b) => a.logicalPath.localeCompare(b.logicalPath));
  const cargoMetadataRoot = hashDomain("aloha/rust/cargo-metadata/v1", metadataFacts);
  const packageGraphRoot = hashDomain("aloha/rust/package-graph/v1", { packages, dependencyEdges });
  const featureRoot = hashDomain("aloha/rust/features/v1", {
    packageFeatures: packages.map((entry) => ({ packageId: entry.packageId, features: entry.features })),
    activeFeatures: compilerUnits.map((entry) => ({ packageId: entry.packageId, targetName: entry.targetName, features: entry.features })),
  });
  const compilerMessageRoot = hashDomain("aloha/rust/compiler-messages/v1", compilerUnits);
  const depInfoRoot = hashDomain("aloha/rust/dep-info-set/v1", depInfoRoots.sort());
  const buildScriptRoot = hashDomain("aloha/rust/build-scripts/v1", buildScripts);
  const procMacroRoot = hashDomain("aloha/rust/proc-macros/v1", {
    packages: packages.filter((entry) => entry.targets.some((target) => target.kind.includes("proc-macro"))).map((entry) => entry.packageId),
    units: compilerUnits.filter((entry) => entry.targetKinds.includes("proc-macro")),
  });
  const generatedInputRoot = hashDomain("aloha/rust/generated-inputs/v1", inputs.filter((entry) => generatedInputs.has(entry.logicalPath)));
  const compilerInputRoot = hashDomain("aloha/rust/compiler-inputs/v1", inputs);
  const toolchain = {
    pinPath,
    pinnedChannel: channel,
    pinContentSha256: pin.contentSha256,
    cargoVersion,
    rustcVersion,
    host,
    cargoExecutableSha256: contentSha256(readFileSync(cargoExecutable)),
    rustcExecutableSha256: contentSha256(readFileSync(rustcExecutable)),
    targetLibInputRoot,
  };
  const digestInput = {
    schemaVersion: 1 as const,
    adapterId: "aloha.cargo-rustc-build-graph" as const,
    adapterVersion: "1" as const,
    manifestPaths,
    lockPaths,
    toolchain,
    cargoMetadataRoot,
    packageGraphRoot,
    featureRoot,
    compilerMessageRoot,
    depInfoRoot,
    buildScriptRoot,
    procMacroRoot,
    generatedInputRoot,
    compilerInputRoot,
  };
  const facts: RustBuildAdapterFactsV1 = {
    ...digestInput,
    packages,
    dependencyEdges,
    compilerUnits,
    buildScripts,
    compilerInputs: inputs,
    rootDigest: hashDomain("aloha/rust/build-adapter/v1", digestInput),
  };
  return { facts, diagnostics };
}
