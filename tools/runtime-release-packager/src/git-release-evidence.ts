import { execFileSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  deepFreeze,
  gitSha40Schema,
  nonEmptyStringSchema,
} from "../../../packages/canonical-codec/src/index.ts";

const TRUSTED_GIT_EXECUTABLE_V1 = "/usr/bin/git";
const CANONICAL_GIT_REMOTE_URL_V1 = "https://github.com/EuniceLeeee/c0ffeebabe.eth.git";
const CANONICAL_GIT_ENV_V1: NodeJS.ProcessEnv = Object.freeze({
  GIT_ALLOW_PROTOCOL: "https",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  LANG: "C",
  LC_ALL: "C",
  PATH: "/usr/bin:/bin",
});
const CANONICAL_GIT_OPTIONS_V1 = Object.freeze([
  "--no-replace-objects",
  "-c", "core.excludesFile=/dev/null",
  "-c", "core.fsmonitor=false",
  "-c", "core.hooksPath=/dev/null",
  "-c", "credential.helper=",
  "-c", "protocol.ext.allow=never",
  "-c", "protocol.file.allow=never",
  "-c", "protocol.ssh.allow=never",
  "-c", "protocol.https.allow=always",
] as const);

export interface GitReleaseEvidenceV1 {
  readonly branch: string;
  readonly upstreamRef: string;
  readonly commit: string;
}

function runGit(repositoryRoot: string, args: readonly string[]): string {
  const canonicalRoot = realpathSync(resolve(repositoryRoot));
  if (canonicalRoot !== repositoryRoot) throw new TypeError("release repository root is not canonical");
  return execFileSync(TRUSTED_GIT_EXECUTABLE_V1, [
    ...CANONICAL_GIT_OPTIONS_V1,
    "-c", `safe.directory=${canonicalRoot}`,
    "-C", canonicalRoot,
    `--work-tree=${canonicalRoot}`,
    ...args,
  ], {
    encoding: "utf8",
    env: CANONICAL_GIT_ENV_V1,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function runGitRecords(repositoryRoot: string, args: readonly string[]): Buffer {
  const canonicalRoot = realpathSync(resolve(repositoryRoot));
  if (canonicalRoot !== repositoryRoot) throw new TypeError("release repository root is not canonical");
  return execFileSync(TRUSTED_GIT_EXECUTABLE_V1, [
    ...CANONICAL_GIT_OPTIONS_V1,
    "-c", `safe.directory=${canonicalRoot}`,
    "-C", canonicalRoot,
    `--work-tree=${canonicalRoot}`,
    ...args,
  ], {
    encoding: null,
    env: CANONICAL_GIT_ENV_V1,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function decodeNullTerminatedGitRecords(bytes: Buffer, label: string): readonly string[] {
  if (bytes.byteLength === 0) return Object.freeze([]);
  if (bytes[bytes.byteLength - 1] !== 0) throw new TypeError(`${label} is not NUL terminated`);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const records: string[] = [];
  let start = 0;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] !== 0) continue;
    if (index === start) throw new TypeError(`${label} contains an empty record`);
    try {
      records.push(decoder.decode(bytes.subarray(start, index)));
    } catch {
      throw new TypeError(`${label} contains a non-UTF-8 path`);
    }
    start = index + 1;
  }
  return Object.freeze(records);
}

function canonicalTrackedPath(path: string, aliases: Set<string>): string {
  if (path.length === 0 || path.startsWith("/") || path.includes("\\")) {
    throw new TypeError("release Git index path is not canonical relative UTF-8");
  }
  const segments = path.split("/");
  if (segments.some(segment => segment.length === 0 || segment === "." || segment === "..")) {
    throw new TypeError(`release Git index path is not canonical: ${path}`);
  }
  const normalized = path.normalize("NFC");
  if (normalized !== path) throw new TypeError(`release Git index path is not NFC: ${path}`);
  const alias = normalized.toLowerCase();
  if (aliases.has(alias)) throw new TypeError(`release Git index contains a duplicate or aliased path: ${path}`);
  aliases.add(alias);
  return path;
}

function runCanonicalRemoteGit(args: readonly string[]): string {
  return execFileSync(TRUSTED_GIT_EXECUTABLE_V1, [...CANONICAL_GIT_OPTIONS_V1, ...args], {
    cwd: "/",
    encoding: "utf8",
    env: CANONICAL_GIT_ENV_V1,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function assertCanonicalTrackedCheckoutV1(repositoryRoot: string): void {
  const indexTree = gitSha40Schema.decode(runGit(repositoryRoot, ["write-tree"]));
  const headTree = gitSha40Schema.decode(runGit(repositoryRoot, ["rev-parse", "--verify", "HEAD^{tree}"]));
  if (indexTree !== headTree) throw new TypeError("release index does not equal the exact HEAD tree");

  const flags = new Map<string, string>();
  const flagAliases = new Set<string>();
  for (const record of decodeNullTerminatedGitRecords(
    runGitRecords(repositoryRoot, ["ls-files", "-v", "-z"]),
    "release Git index flag records",
  )) {
    if (record.length < 3 || record[1] !== " ") throw new TypeError("release Git index flag record is malformed");
    const path = canonicalTrackedPath(record.slice(2), flagAliases);
    if (flags.has(path)) throw new TypeError(`release Git index has duplicate flag records: ${path}`);
    flags.set(path, record[0]!);
  }
  const seen = new Set<string>();
  const stageAliases = new Set<string>();
  for (const record of decodeNullTerminatedGitRecords(
    runGitRecords(repositoryRoot, ["ls-files", "-s", "-z"]),
    "release Git index stage records",
  )) {
    const tab = record.indexOf("\t");
    if (tab < 0) throw new TypeError("release Git index record is malformed");
    const [mode, blob, stage] = record.slice(0, tab).split(/\s+/);
    const path = canonicalTrackedPath(record.slice(tab + 1), stageAliases);
    if (mode === undefined || blob === undefined || stage === undefined || path.length === 0) {
      throw new TypeError("release Git index record is malformed");
    }
    if (stage !== "0") throw new TypeError(`release Git index has a non-zero stage: ${path}`);
    if (seen.has(path)) throw new TypeError(`release Git index has duplicate stage records: ${path}`);
    if (flags.get(path) !== "H") throw new TypeError(`release Git index has a noncanonical flag: ${path}`);
    if (mode !== "100644" && mode !== "100755") throw new TypeError(`release tracked path is not a regular file: ${path}`);
    const filePath = join(repositoryRoot, path);
    const stat = lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new TypeError(`release tracked path is not a regular file: ${path}`);
    const indexedBytes = runGitRecords(repositoryRoot, ["cat-file", "blob", blob]);
    if (!readFileSync(filePath).equals(indexedBytes)) {
      throw new TypeError(`release working bytes do not equal the exact indexed blob: ${path}`);
    }
    seen.add(path);
  }
  if (seen.size !== flags.size || [...flags].some(([path]) => !seen.has(path))) {
    throw new TypeError("release Git index records are incomplete");
  }
  const untracked = runGitRecords(repositoryRoot, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (untracked.byteLength !== 0) throw new TypeError("release repository is dirty");
}

/** Derive release identity from Git itself. Caller-supplied SHAs are never authority. */
export function observeCleanGitCheckoutV1(repositoryRootValue: string): GitReleaseEvidenceV1 {
  const repositoryRoot = realpathSync(resolve(repositoryRootValue));
  assertCanonicalTrackedCheckoutV1(repositoryRoot);
  const commit = gitSha40Schema.decode(runGit(repositoryRoot, ["rev-parse", "--verify", "HEAD"]));
  const branch = nonEmptyStringSchema.decode(runGit(repositoryRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]));
  if (runGit(repositoryRoot, ["check-ref-format", "--branch", branch]) !== branch) {
    throw new TypeError("release branch is not a canonical Git branch name");
  }
  const upstreamRef = nonEmptyStringSchema.decode(runGit(repositoryRoot, ["rev-parse", "--symbolic-full-name", "@{upstream}"]));
  if (upstreamRef !== `refs/remotes/origin/${branch}`) {
    throw new TypeError("release upstream is not the canonical origin remote-tracking ref");
  }
  return deepFreeze({ branch, upstreamRef, commit });
}

/** Prove that this clean named checkout is the current remote branch tip at package creation time. */
export function observeExactPushedGitV1(repositoryRootValue: string): GitReleaseEvidenceV1 {
  const repositoryRoot = realpathSync(resolve(repositoryRootValue));
  const checkout = observeCleanGitCheckoutV1(repositoryRoot);
  const { upstreamRef, commit } = checkout;
  const upstreamCommit = gitSha40Schema.decode(runGit(repositoryRoot, ["rev-parse", "--verify", "@{upstream}"]));
  if (upstreamCommit !== commit) throw new TypeError("release HEAD is not the exact pushed upstream commit");
  const remoteRef = `refs/heads/${checkout.branch}`;
  const remoteLine = runCanonicalRemoteGit(["ls-remote", "--exit-code", CANONICAL_GIT_REMOTE_URL_V1, remoteRef]);
  const remoteFields = remoteLine.split(/\s+/);
  if (remoteFields.length !== 2 || remoteFields[1] !== remoteRef || gitSha40Schema.decode(remoteFields[0]) !== commit) {
    throw new TypeError("release commit is not the exact current remote branch tip");
  }
  return checkout;
}

export function withExactCommitTreeV1<T>(
  repositoryRoot: string,
  commit: string,
  action: (snapshotRoot: string) => T,
): T {
  const snapshotRoot = realpathSync(mkdtempSync(join(tmpdir(), "aloha-release-source-")));
  try {
    const aliases = new Set<string>();
    const records = decodeNullTerminatedGitRecords(
      runGitRecords(repositoryRoot, ["ls-tree", "-r", "-z", "--full-tree", commit]),
      "release commit tree records",
    );
    if (records.length === 0) throw new TypeError("release commit tree is empty");
    for (const record of records) {
      const tab = record.indexOf("\t");
      if (tab < 0) throw new TypeError("release commit tree record is malformed");
      const [mode, type, object] = record.slice(0, tab).split(/\s+/);
      const path = canonicalTrackedPath(record.slice(tab + 1), aliases);
      if ((mode !== "100644" && mode !== "100755") || type !== "blob"
        || object === undefined || !/^[0-9a-f]{40,64}$/.test(object)) {
        throw new TypeError(`release commit tree has a non-regular entry: ${path}`);
      }
      const target = join(snapshotRoot, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, runGitRecords(repositoryRoot, ["cat-file", "blob", object]), {
        flag: "wx",
        mode: mode === "100755" ? 0o755 : 0o644,
      });
      if (mode === "100755") chmodSync(target, 0o755);
    }
    return action(snapshotRoot);
  } finally {
    rmSync(snapshotRoot, { recursive: true, force: true });
  }
}
