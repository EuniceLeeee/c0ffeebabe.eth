import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, chmodSync, constants, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";

export interface SnapshotInstallerIdentityV1 {
  readonly packageName: "npm";
  readonly packageVersion: string;
  readonly entrypointSha256: `0x${string}`;
  readonly implementationRoot: `0x${string}`;
}

export interface SnapshotGitIdentityV1 {
  readonly version: string;
  readonly executableSha256: `0x${string}`;
}

export const SNAPSHOT_GIT_EXECUTABLE_PATH = "/usr/bin/git";

interface ResolvedSnapshotInstallerV1 {
  readonly entrypointPath: string;
  readonly identity: SnapshotInstallerIdentityV1;
}

const sha256 = (value: string | Uint8Array): `0x${string}` => `0x${createHash("sha256").update(value).digest("hex")}`;

function npmEnvironment(): NodeJS.ProcessEnv {
  return {
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "core.fsmonitor",
    GIT_CONFIG_VALUE_0: "false",
    GIT_CONFIG_KEY_1: "core.hooksPath",
    GIT_CONFIG_VALUE_1: "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
    PATH: [dirname(realpathSync(process.execPath)), "/usr/bin", "/bin"].join(delimiter),
  };
}

export function snapshotGitEnvironmentV1(): NodeJS.ProcessEnv {
  return {
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "core.fsmonitor",
    GIT_CONFIG_VALUE_0: "false",
    GIT_CONFIG_KEY_1: "core.hooksPath",
    GIT_CONFIG_VALUE_1: "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
    PATH: "/usr/bin:/bin",
  };
}

export function activeSnapshotGitIdentityV1(): SnapshotGitIdentityV1 {
  const executable = realpathSync(SNAPSHOT_GIT_EXECUTABLE_PATH);
  const observed = spawnSync(executable, ["--version"], { encoding: "utf8", env: snapshotGitEnvironmentV1(), stdio: ["ignore", "pipe", "pipe"] });
  if (observed.error !== undefined) throw observed.error;
  const version = observed.stdout.trim();
  if (observed.status !== 0 || !/^git version [0-9]+(?:\.[0-9]+)+(?:[^\r\n]*)$/.test(version)) {
    throw new TypeError("exact Git runtime identity is unavailable");
  }
  return Object.freeze({ version, executableSha256: sha256(readFileSync(executable)) });
}

function npmImplementationRoot(packageRoot: string): `0x${string}` {
  const entries: Array<Readonly<{ path: string; kind: "file" | "symlink"; identity: string }>> = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile()) {
        entries.push({ path: relative(packageRoot, absolute).split(sep).join("/"), kind: "file", identity: sha256(readFileSync(absolute)) });
      } else if (entry.isSymbolicLink()) {
        entries.push({ path: relative(packageRoot, absolute).split(sep).join("/"), kind: "symlink", identity: readlinkSync(absolute) });
      } else {
        throw new TypeError(`npm installer contains unsupported filesystem entry ${absolute}`);
      }
    }
  };
  visit(packageRoot);
  return sha256(JSON.stringify(entries));
}

function resolveSnapshotInstaller(): ResolvedSnapshotInstallerV1 {
  const nodeDirectory = dirname(realpathSync(process.execPath));
  const commandPath = resolve(nodeDirectory, "npm");
  try { accessSync(commandPath, constants.X_OK); } catch { throw new TypeError("node-distribution npm installer is unavailable"); }
  const entrypointPath = realpathSync(commandPath);
  let packageRoot = dirname(entrypointPath);
  while (true) {
    const manifestPath = join(packageRoot, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { readonly name?: unknown; readonly version?: unknown };
      if (manifest.name === "npm" && typeof manifest.version === "string") {
        const observed = spawnSync(process.execPath, [entrypointPath, "--version"], { encoding: "utf8", env: npmEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
        if (observed.error !== undefined) throw observed.error;
        if (observed.status !== 0 || observed.stdout.trim() !== manifest.version) throw new TypeError("npm installer version does not match its package manifest");
        return {
          entrypointPath,
          identity: Object.freeze({
            packageName: "npm",
            packageVersion: manifest.version,
            entrypointSha256: sha256(readFileSync(entrypointPath)),
            implementationRoot: npmImplementationRoot(packageRoot),
          }),
        };
      }
    }
    const parent = dirname(packageRoot);
    if (parent === packageRoot) throw new TypeError("npm installer package root is unavailable");
    packageRoot = parent;
  }
}

export function activeSnapshotInstallerIdentityV1(): SnapshotInstallerIdentityV1 {
  return resolveSnapshotInstaller().identity;
}

interface IndexedBlobV1 {
  readonly mode: "100644" | "100755";
  readonly objectId: string;
  readonly path: string;
}

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function gitBytes(repoPath: string, args: readonly string[]): Buffer {
  return execFileSync(SNAPSHOT_GIT_EXECUTABLE_PATH, ["-C", repoPath, ...args], {
    encoding: null,
    env: snapshotGitEnvironmentV1(),
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gitBlobObjectId(bytes: Buffer): string {
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

function decodeIndexPath(bytes: Buffer): string {
  let path: string;
  try {
    path = UTF8_DECODER.decode(bytes);
  } catch {
    throw new TypeError("Git index contains a non-UTF-8 path");
  }
  if (!Buffer.from(path, "utf8").equals(bytes)
    || path.length === 0
    || path.startsWith("/")
    || path.includes("\\")
    || path.split("/").some(part => part.length === 0 || part === "." || part === ".." || part.toLowerCase() === ".git")) {
    throw new TypeError(`Git index contains an unsafe path ${JSON.stringify(path)}`);
  }
  return path;
}

function parseIndexedBlobs(indexBytes: Buffer): readonly IndexedBlobV1[] {
  const entries: IndexedBlobV1[] = [];
  const seen = new Set<string>();
  let offset = 0;
  while (offset < indexBytes.length) {
    const end = indexBytes.indexOf(0, offset);
    if (end < 0) throw new TypeError("Git index record is not NUL terminated");
    const record = indexBytes.subarray(offset, end);
    offset = end + 1;
    if (record.length === 0) throw new TypeError("Git index contains an empty record");
    const tab = record.indexOf(0x09);
    if (tab < 0) throw new TypeError("Git index contains a malformed stage record");
    const header = record.subarray(0, tab).toString("ascii");
    const match = /^(\d{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-3])$/.exec(header);
    if (match === null) throw new TypeError("Git index contains a malformed stage header");
    const path = decodeIndexPath(record.subarray(tab + 1));
    if (match[3] !== "0") throw new TypeError(`Git index contains a nonzero stage for ${path}`);
    if (match[1] !== "100644" && match[1] !== "100755") {
      throw new TypeError(`Git index mode ${match[1]} is not a reproducible regular file for ${path}`);
    }
    if (seen.has(path)) throw new TypeError(`Git index contains a duplicate path ${path}`);
    seen.add(path);
    entries.push(Object.freeze({ mode: match[1], objectId: match[2]!, path }));
  }
  return Object.freeze(entries);
}

function assertCanonicalIndexFlags(flagBytes: Buffer, entries: readonly IndexedBlobV1[]): void {
  const flags = new Map<string, string>();
  let offset = 0;
  while (offset < flagBytes.length) {
    const end = flagBytes.indexOf(0, offset);
    if (end < 0) throw new TypeError("Git index flag record is not NUL terminated");
    const record = flagBytes.subarray(offset, end);
    offset = end + 1;
    if (record.length < 3 || record[1] !== 0x20) throw new TypeError("Git index contains a malformed flag record");
    const flag = String.fromCharCode(record[0]!);
    const path = decodeIndexPath(record.subarray(2));
    if (flags.has(path)) throw new TypeError(`Git index contains duplicate flags for ${path}`);
    flags.set(path, flag);
  }
  if (flags.size !== entries.length) throw new TypeError("Git index flag denominator does not match its stage denominator");
  for (const entry of entries) {
    if (flags.get(entry.path) !== "H") {
      throw new TypeError(`Git index path ${entry.path} has a noncanonical index flag`);
    }
  }
}

/** Materialize exactly the caller's raw Git index blobs.  This deliberately
 * avoids checkout conversion and git-add so repository-local filters,
 * attributes, replacement objects, and working-tree bytes cannot alter the
 * compiler denominator. */
export function createGitIndexSnapshot(repoPath: string): string {
  const root = mkdtempSync(join(tmpdir(), "aloha-reuse-authority-index-"));
  const env = snapshotGitEnvironmentV1();
  try {
    const sourceObjectFormat = execFileSync(
      SNAPSHOT_GIT_EXECUTABLE_PATH,
      ["-C", repoPath, "rev-parse", "--show-object-format"],
      { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    if (sourceObjectFormat !== "sha1") throw new TypeError(`unsupported Git object format ${sourceObjectFormat}`);
    const indexBefore = gitBytes(repoPath, ["ls-files", "--stage", "-z"]);
    const flagsBefore = gitBytes(repoPath, ["ls-files", "-v", "-z"]);
    const entries = parseIndexedBlobs(indexBefore);
    assertCanonicalIndexFlags(flagsBefore, entries);

    execFileSync(SNAPSHOT_GIT_EXECUTABLE_PATH, ["-C", root, "init", "-q"], { env });
    for (const entry of entries) {
      const bytes = gitBytes(repoPath, ["cat-file", "blob", entry.objectId]);
      const destination = resolve(root, entry.path);
      if (destination !== root && !destination.startsWith(`${root}${sep}`)) {
        throw new TypeError(`Git index path escapes the snapshot root ${entry.path}`);
      }
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, bytes);
      chmodSync(destination, entry.mode === "100755" ? 0o755 : 0o644);
      const snapshotObjectId = execFileSync(
        SNAPSHOT_GIT_EXECUTABLE_PATH,
        ["-C", root, "hash-object", "-w", "--stdin"],
        { input: bytes, encoding: "utf8", env, stdio: ["pipe", "pipe", "pipe"] },
      ).trim();
      if (snapshotObjectId !== entry.objectId) {
        throw new TypeError(`materialized Git blob identity mismatch for ${entry.path}`);
      }
      execFileSync(
        SNAPSHOT_GIT_EXECUTABLE_PATH,
        ["-C", root, "update-index", "--add", "--cacheinfo", entry.mode, entry.objectId, entry.path],
        { env, stdio: ["ignore", "pipe", "pipe"] },
      );
    }

    const indexAfter = gitBytes(repoPath, ["ls-files", "--stage", "-z"]);
    const flagsAfter = gitBytes(repoPath, ["ls-files", "-v", "-z"]);
    if (!indexAfter.equals(indexBefore) || !flagsAfter.equals(flagsBefore)) {
      throw new TypeError("source Git index changed while its clean-room snapshot was materialized");
    }
    if (!gitBytes(root, ["ls-files", "--stage", "-z"]).equals(indexBefore)) {
      throw new TypeError("materialized Git index does not exact-match the source index");
    }
    assertCanonicalIndexFlags(gitBytes(root, ["ls-files", "-v", "-z"]), entries);
    for (const entry of entries) {
      const destination = resolve(root, entry.path);
      const stat = lstatSync(destination);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new TypeError(`materialized Git path is not a regular file ${entry.path}`);
      }
      const expectedMode = entry.mode === "100755" ? 0o755 : 0o644;
      if ((stat.mode & 0o777) !== expectedMode) {
        throw new TypeError(`materialized Git mode mismatch for ${entry.path}`);
      }
      if (gitBlobObjectId(readFileSync(destination)) !== entry.objectId) {
        throw new TypeError(`materialized Git working bytes mismatch for ${entry.path}`);
      }
    }
    return root;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

/** Materialize the complete non-ignored working tree without changing the
 * caller's index.  This is generation input only; required checks use the
 * index snapshot above. */
export function createWorkingTreeSnapshot(repoPath: string): string {
  const root = mkdtempSync(join(tmpdir(), "aloha-reuse-authority-worktree-"));
  const env = snapshotGitEnvironmentV1();
  const output = execFileSync(SNAPSHOT_GIT_EXECUTABLE_PATH, ["-C", repoPath, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { env });
  const paths = output.toString("utf8").split("\0").filter(Boolean).sort();
  for (const path of paths) {
    if (path.startsWith("/") || path.includes("\\") || path.split("/").includes("..")) {
      throw new TypeError(`invalid working-tree snapshot path ${path}`);
    }
    const source = resolve(repoPath, path);
    if (!existsSync(source)) continue;
    const destination = resolve(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true });
  }
  execFileSync(SNAPSHOT_GIT_EXECUTABLE_PATH, ["-C", root, "init", "-q"], { env });
  execFileSync(SNAPSHOT_GIT_EXECUTABLE_PATH, ["-C", root, "add", "-A"], { env });
  return root;
}

function assertExactExternalLockSources(snapshotRoot: string): void {
  const parsed = JSON.parse(readFileSync(resolve(snapshotRoot, "package-lock.json"), "utf8")) as {
    readonly packages?: Record<string, unknown>;
  };
  if (parsed.packages === undefined || parsed.packages === null || typeof parsed.packages !== "object" || Array.isArray(parsed.packages)) {
    throw new TypeError("snapshot package lock lacks an exact packages map");
  }
  for (const [path, raw] of Object.entries(parsed.packages)) {
    if (!path.startsWith("node_modules/") || raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    if (record.link === true) continue;
    if (typeof record.version !== "string"
      || typeof record.resolved !== "string"
      || !record.resolved.startsWith("https://registry.npmjs.org/")
      || typeof record.integrity !== "string"
      || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(record.integrity)) {
      throw new TypeError(`snapshot external dependency lacks exact registry integrity ${path}`);
    }
  }
}

export function installSnapshotCompilerDependencies(snapshotRoot: string): void {
  assertExactExternalLockSources(snapshotRoot);
  const installer = resolveSnapshotInstaller();
  const cacheRoot = resolve(snapshotRoot, ".aloha-npm-cache");
  rmSync(cacheRoot, { recursive: true, force: true });
  try {
    mkdirSync(cacheRoot, { recursive: true });
    const userConfigPath = resolve(cacheRoot, "user.npmrc");
    const globalConfigPath = resolve(cacheRoot, "global.npmrc");
    writeFileSync(userConfigPath, "");
    writeFileSync(globalConfigPath, "");
    const result = spawnSync(process.execPath, [
      installer.entrypointPath,
      "ci",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--registry=https://registry.npmjs.org/",
      `--userconfig=${userConfigPath}`,
      `--globalconfig=${globalConfigPath}`,
      `--cache=${cacheRoot}`,
    ], {
      cwd: snapshotRoot,
      env: npmEnvironment(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error !== undefined) throw result.error;
    if (result.status !== 0) {
      throw new TypeError(`exact snapshot dependency install failed with status ${result.status ?? "unknown"}: ${result.stderr.trim()}`);
    }
    const after = resolveSnapshotInstaller().identity;
    if (JSON.stringify(after) !== JSON.stringify(installer.identity)) {
      throw new TypeError("npm installer changed while snapshot dependencies were installed");
    }
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
}

/** Execute the candidate index's own CLI bytes.  The launcher never imports
 * the working-tree validator before this child has completed. */
export function executeMaterializedIndexCli(snapshotRoot: string, args: readonly string[]): void {
  const cliPath = resolve(snapshotRoot, "tools/reference-lock-integrity/src/cli.ts");
  const result = spawnSync(process.execPath, ["--experimental-strip-types", cliPath, ...args], { env: npmEnvironment(), stdio: "inherit" });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new TypeError(`candidate index reference-lock CLI failed with status ${result.status ?? "unknown"}`);
}
