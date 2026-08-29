import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { createGitIndexSnapshot, createWorkingTreeSnapshot, executeMaterializedIndexCli, installSnapshotCompilerDependencies } from "../src/index-snapshot.ts";

test("index snapshot excludes unstaged and untracked working-tree bytes", () => {
  const repo = mkdtempSync(join(tmpdir(), "aloha-reuse-index-source-"));
  let snapshot: string | null = null;
  try {
    execFileSync("git", ["-C", repo, "init", "-q"]);
    writeFileSync(join(repo, "tracked.txt"), "indexed\n", "utf8");
    execFileSync("git", ["-C", repo, "add", "tracked.txt"]);
    writeFileSync(join(repo, "tracked.txt"), "working-tree\n", "utf8");
    writeFileSync(join(repo, "untracked.txt"), "untracked\n", "utf8");
    snapshot = createGitIndexSnapshot(repo);
    assert.equal(readFileSync(join(snapshot, "tracked.txt"), "utf8"), "indexed\n");
    assert.throws(() => readFileSync(join(snapshot!, "untracked.txt"), "utf8"));
  } finally {
    if (snapshot !== null) rmSync(snapshot, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("index snapshot ignores an alternate index selected by the caller environment", () => {
  const repo = mkdtempSync(join(tmpdir(), "aloha-reuse-default-index-source-"));
  const alternateIndex = join(mkdtempSync(join(tmpdir(), "aloha-reuse-alternate-index-")), "index");
  const previous = process.env.GIT_INDEX_FILE;
  let snapshot: string | null = null;
  try {
    execFileSync("git", ["-C", repo, "init", "-q"]);
    writeFileSync(join(repo, "default.txt"), "default-index\n", "utf8");
    execFileSync("git", ["-C", repo, "add", "default.txt"]);
    const alternateEnvironment = { ...process.env, GIT_INDEX_FILE: alternateIndex };
    execFileSync("git", ["-C", repo, "read-tree", "--empty"], { env: alternateEnvironment });
    writeFileSync(join(repo, "alternate.txt"), "alternate-index\n", "utf8");
    execFileSync("git", ["-C", repo, "add", "alternate.txt"], { env: alternateEnvironment });
    process.env.GIT_INDEX_FILE = alternateIndex;
    snapshot = createGitIndexSnapshot(repo);
    assert.equal(readFileSync(join(snapshot, "default.txt"), "utf8"), "default-index\n");
    assert.throws(() => readFileSync(join(snapshot!, "alternate.txt"), "utf8"));
  } finally {
    if (previous === undefined) delete process.env.GIT_INDEX_FILE;
    else process.env.GIT_INDEX_FILE = previous;
    if (snapshot !== null) rmSync(snapshot, { recursive: true, force: true });
    rmSync(dirname(alternateIndex), { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("index snapshot ignores a PATH-shadowed Git executable", () => {
  const repo = mkdtempSync(join(tmpdir(), "aloha-reuse-fixed-git-source-"));
  const fakeBin = mkdtempSync(join(tmpdir(), "aloha-reuse-fake-git-"));
  const previousPath = process.env.PATH;
  let snapshot: string | null = null;
  try {
    execFileSync("git", ["-C", repo, "init", "-q"]);
    writeFileSync(join(repo, "indexed.txt"), "indexed\n", "utf8");
    execFileSync("git", ["-C", repo, "add", "indexed.txt"]);
    writeFileSync(join(fakeBin, "git"), `#!/usr/bin/env node
const child = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args.includes("checkout-index")) {
  const prefix = args.find((value) => value.startsWith("--prefix="))?.slice("--prefix=".length);
  if (!prefix) process.exit(9);
  fs.mkdirSync(prefix, { recursive: true });
  fs.writeFileSync(path.join(prefix, "path-forged.txt"), "forged\\n");
  process.exit(0);
}
const result = child.spawnSync("/usr/bin/git", args, { stdio: "inherit" });
process.exit(result.status ?? 8);
`, "utf8");
    chmodSync(join(fakeBin, "git"), 0o755);
    process.env.PATH = `${fakeBin}${delimiter}${previousPath ?? ""}`;
    snapshot = createGitIndexSnapshot(repo);
    assert.equal(readFileSync(join(snapshot, "indexed.txt"), "utf8"), "indexed\n");
    assert.throws(() => readFileSync(join(snapshot!, "path-forged.txt"), "utf8"));
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (snapshot !== null) rmSync(snapshot, { recursive: true, force: true });
    rmSync(fakeBin, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("index snapshot materializes raw blobs without repository-local smudge filters", () => {
  const repo = mkdtempSync(join(tmpdir(), "aloha-reuse-filter-source-"));
  const checkout = mkdtempSync(join(tmpdir(), "aloha-reuse-filter-control-"));
  let snapshot: string | null = null;
  try {
    execFileSync("git", ["-C", repo, "init", "-q"]);
    writeFileSync(join(repo, ".gitattributes"), "payload.txt filter=forge\n", "utf8");
    writeFileSync(join(repo, "payload.txt"), "indexed-authority-bytes\n", "utf8");
    execFileSync("git", ["-C", repo, "add", ".gitattributes", "payload.txt"]);
    execFileSync("git", ["-C", repo, "config", "filter.forge.smudge", "sed s/indexed-authority-bytes/smudge-forged-bytes/"]);
    execFileSync("git", ["-C", repo, "checkout-index", "--force", `--prefix=${checkout}/`, "payload.txt"]);
    assert.equal(readFileSync(join(checkout, "payload.txt"), "utf8"), "smudge-forged-bytes\n", "control checkout must prove the hostile filter is active");

    snapshot = createGitIndexSnapshot(repo);
    assert.equal(readFileSync(join(snapshot, "payload.txt"), "utf8"), "indexed-authority-bytes\n");
    assert.equal(execFileSync("git", ["-C", snapshot, "show", ":payload.txt"], { encoding: "utf8" }), "indexed-authority-bytes\n");
  } finally {
    if (snapshot !== null) rmSync(snapshot, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("index snapshot rejects noncanonical index flags and non-regular modes", () => {
  const repo = mkdtempSync(join(tmpdir(), "aloha-reuse-index-shape-source-"));
  try {
    execFileSync("git", ["-C", repo, "init", "-q"]);
    writeFileSync(join(repo, "tracked.txt"), "tracked\n", "utf8");
    execFileSync("git", ["-C", repo, "add", "tracked.txt"]);
    execFileSync("git", ["-C", repo, "update-index", "--assume-unchanged", "tracked.txt"]);
    assert.throws(() => createGitIndexSnapshot(repo), /noncanonical index flag/);
    execFileSync("git", ["-C", repo, "update-index", "--no-assume-unchanged", "tracked.txt"]);
    execFileSync("git", ["-C", repo, "update-index", "--skip-worktree", "tracked.txt"]);
    assert.throws(() => createGitIndexSnapshot(repo), /noncanonical index flag/);
    execFileSync("git", ["-C", repo, "update-index", "--no-skip-worktree", "tracked.txt"]);

    writeFileSync(join(repo, "target.txt"), "target\n", "utf8");
    symlinkSync("target.txt", join(repo, "link.txt"));
    execFileSync("git", ["-C", repo, "add", "target.txt", "link.txt"]);
    assert.throws(() => createGitIndexSnapshot(repo), /mode 120000 is not a reproducible regular file/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("index snapshot preserves executable mode and exact index records", () => {
  const repo = mkdtempSync(join(tmpdir(), "aloha-reuse-executable-source-"));
  let snapshot: string | null = null;
  try {
    execFileSync("git", ["-C", repo, "init", "-q"]);
    const executable = join(repo, "run.sh");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(executable, 0o755);
    execFileSync("git", ["-C", repo, "add", "run.sh"]);
    const sourceIndex = execFileSync("git", ["-C", repo, "ls-files", "--stage", "-z"]);
    snapshot = createGitIndexSnapshot(repo);
    const snapshotIndex = execFileSync("git", ["-C", snapshot, "ls-files", "--stage", "-z"]);
    assert.ok(sourceIndex.equals(snapshotIndex));
    assert.match(snapshotIndex.toString("utf8"), /^100755 /);
    assert.equal(lstatSync(join(snapshot, "run.sh")).mode & 0o777, 0o755);
  } finally {
    if (snapshot !== null) rmSync(snapshot, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("working-tree snapshot includes unstaged and untracked bytes without changing the index", () => {
  const repo = mkdtempSync(join(tmpdir(), "aloha-reuse-worktree-source-"));
  let snapshot: string | null = null;
  try {
    execFileSync("git", ["-C", repo, "init", "-q"]);
    writeFileSync(join(repo, "tracked.txt"), "indexed\n", "utf8");
    execFileSync("git", ["-C", repo, "add", "tracked.txt"]);
    writeFileSync(join(repo, "tracked.txt"), "working-tree\n", "utf8");
    writeFileSync(join(repo, "untracked.txt"), "untracked\n", "utf8");
    writeFileSync(join(repo, ".gitignore"), "ignored.txt\n", "utf8");
    snapshot = createWorkingTreeSnapshot(repo);
    assert.equal(readFileSync(join(snapshot, "tracked.txt"), "utf8"), "working-tree\n");
    assert.equal(readFileSync(join(snapshot, "untracked.txt"), "utf8"), "untracked\n");
    assert.equal(readFileSync(join(snapshot, ".gitignore"), "utf8"), "ignored.txt\n");
    assert.equal(execFileSync("git", ["-C", repo, "show", ":tracked.txt"], { encoding: "utf8" }), "indexed\n");
  } finally {
    if (snapshot !== null) rmSync(snapshot, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("materialized index executes the indexed candidate CLI rather than divergent working-tree code", () => {
  const repo = mkdtempSync(join(tmpdir(), "aloha-reuse-index-exec-source-"));
  const marker = join(repo, "marker.txt");
  const previousIndex = process.env.GIT_INDEX_FILE;
  const previousDirectory = process.env.GIT_DIR;
  const previousWorkTree = process.env.GIT_WORK_TREE;
  const previousDyldLibraryPath = process.env.DYLD_LIBRARY_PATH;
  const previousLdLibraryPath = process.env.LD_LIBRARY_PATH;
  const previousBashEnv = process.env.BASH_ENV;
  let snapshot: string | null = null;
  try {
    execFileSync("git", ["-C", repo, "init", "-q"]);
    const cliDirectory = join(repo, "tools/reference-lock-integrity/src");
    mkdirSync(cliDirectory, { recursive: true });
    const candidateCli = join(cliDirectory, "cli.ts");
    writeFileSync(candidateCli, `import { writeFileSync } from "node:fs";
const clean = process.env.GIT_INDEX_FILE === undefined
  && process.env.GIT_DIR === undefined
  && process.env.GIT_WORK_TREE === undefined
  && process.env.DYLD_LIBRARY_PATH === undefined
  && process.env.LD_LIBRARY_PATH === undefined
  && process.env.BASH_ENV === undefined
  && process.env.GIT_CONFIG_NOSYSTEM === "1"
  && process.env.GIT_CONFIG_GLOBAL === "/dev/null"
  && process.env.GIT_NO_REPLACE_OBJECTS === "1";
writeFileSync(process.argv[2], clean ? "indexed\\n" : "polluted\\n", "utf8");
`, "utf8");
    execFileSync("git", ["-C", repo, "add", "tools/reference-lock-integrity/src/cli.ts"]);
    writeFileSync(candidateCli, `import { writeFileSync } from "node:fs"; writeFileSync(process.argv[2], "working-tree\\n", "utf8");\n`, "utf8");
    snapshot = createGitIndexSnapshot(repo);
    process.env.GIT_INDEX_FILE = join(repo, "caller-selected-index");
    process.env.GIT_DIR = join(repo, "caller-selected-git-dir");
    process.env.GIT_WORK_TREE = join(repo, "caller-selected-worktree");
    process.env.DYLD_LIBRARY_PATH = join(repo, "caller-dyld-search");
    process.env.LD_LIBRARY_PATH = join(repo, "caller-ld-search");
    process.env.BASH_ENV = join(repo, "caller-shell-profile");
    executeMaterializedIndexCli(snapshot, [marker]);
    assert.equal(readFileSync(marker, "utf8"), "indexed\n");
  } finally {
    if (previousIndex === undefined) delete process.env.GIT_INDEX_FILE;
    else process.env.GIT_INDEX_FILE = previousIndex;
    if (previousDirectory === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previousDirectory;
    if (previousWorkTree === undefined) delete process.env.GIT_WORK_TREE;
    else process.env.GIT_WORK_TREE = previousWorkTree;
    if (previousDyldLibraryPath === undefined) delete process.env.DYLD_LIBRARY_PATH;
    else process.env.DYLD_LIBRARY_PATH = previousDyldLibraryPath;
    if (previousLdLibraryPath === undefined) delete process.env.LD_LIBRARY_PATH;
    else process.env.LD_LIBRARY_PATH = previousLdLibraryPath;
    if (previousBashEnv === undefined) delete process.env.BASH_ENV;
    else process.env.BASH_ENV = previousBashEnv;
    if (snapshot !== null) rmSync(snapshot, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("snapshot dependencies are installed from the exact lock instead of caller node_modules", () => {
  const repo = mkdtempSync(join(tmpdir(), "aloha-reuse-index-dependencies-"));
  let snapshot: string | null = null;
  try {
    execFileSync("git", ["-C", repo, "init", "-q"]);
    mkdirSync(join(repo, "vendor/fixture-toolchain"), { recursive: true });
    writeFileSync(join(repo, "package.json"), `${JSON.stringify({ private: true, dependencies: { "fixture-toolchain": "file:vendor/fixture-toolchain" } })}\n`);
    writeFileSync(join(repo, "vendor/fixture-toolchain/package.json"), `${JSON.stringify({ name: "fixture-toolchain", version: "1.0.0", main: "index.js" })}\n`);
    writeFileSync(join(repo, "vendor/fixture-toolchain/index.js"), "export const identity = 'locked';\n");
    execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-C", repo, "add", "package.json", "package-lock.json", "vendor"]);
    writeFileSync(join(repo, "node_modules/fixture-toolchain/index.js"), "export const identity = 'caller-mutated';\n");
    snapshot = createGitIndexSnapshot(repo);
    installSnapshotCompilerDependencies(snapshot);
    assert.equal(readFileSync(join(snapshot, "node_modules/fixture-toolchain/index.js"), "utf8"), "export const identity = 'locked';\n");
  } finally {
    if (snapshot !== null) rmSync(snapshot, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("snapshot dependency install ignores a PATH-shadowed self-reported npm", () => {
  const repo = mkdtempSync(join(tmpdir(), "aloha-reuse-shadowed-installer-source-"));
  const fakePackage = mkdtempSync(join(tmpdir(), "aloha-reuse-fake-npm-"));
  const fakeBin = join(fakePackage, "bin");
  const previousPath = process.env.PATH;
  let snapshot: string | null = null;
  try {
    execFileSync("git", ["-C", repo, "init", "-q"]);
    mkdirSync(join(repo, "vendor/fixture-toolchain"), { recursive: true });
    writeFileSync(join(repo, "package.json"), `${JSON.stringify({ private: true, dependencies: { "fixture-toolchain": "file:vendor/fixture-toolchain" } })}\n`);
    writeFileSync(join(repo, "vendor/fixture-toolchain/package.json"), `${JSON.stringify({ name: "fixture-toolchain", version: "1.0.0", main: "index.js" })}\n`);
    writeFileSync(join(repo, "vendor/fixture-toolchain/index.js"), "export const identity = 'locked';\n");
    execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-C", repo, "add", "package.json", "package-lock.json", "vendor"]);
    snapshot = createGitIndexSnapshot(repo);

    const version = execFileSync("npm", ["--version"], { encoding: "utf8" }).trim();
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(join(fakePackage, "package.json"), `${JSON.stringify({ name: "npm", version })}\n`, "utf8");
    writeFileSync(join(fakeBin, "npm"), `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
if (process.argv.includes("--version")) { console.log(${JSON.stringify(version)}); process.exit(0); }
const target = path.join(process.cwd(), "node_modules", "fixture-toolchain");
fs.mkdirSync(target, { recursive: true });
fs.writeFileSync(path.join(target, "package.json"), ${JSON.stringify(`${JSON.stringify({ name: "fixture-toolchain", version: "1.0.0", main: "index.js" })}\n`)});
fs.writeFileSync(path.join(target, "index.js"), "export const identity = 'path-forged';\\n");
`, "utf8");
    chmodSync(join(fakeBin, "npm"), 0o755);
    process.env.PATH = `${fakeBin}${delimiter}${previousPath ?? ""}`;

    installSnapshotCompilerDependencies(snapshot);
    assert.equal(readFileSync(join(snapshot, "node_modules/fixture-toolchain/index.js"), "utf8"), "export const identity = 'locked';\n");
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (snapshot !== null) rmSync(snapshot, { recursive: true, force: true });
    rmSync(fakePackage, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("snapshot dependency install rejects an external lock record without cryptographic integrity", () => {
  const snapshot = mkdtempSync(join(tmpdir(), "aloha-reuse-index-unpinned-lock-"));
  try {
    writeFileSync(join(snapshot, "package.json"), `${JSON.stringify({ private: true, dependencies: { unpinned: "1.0.0" } })}\n`);
    writeFileSync(join(snapshot, "package-lock.json"), `${JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": { name: "fixture", version: "1.0.0", dependencies: { unpinned: "1.0.0" } },
        "node_modules/unpinned": { version: "1.0.0", resolved: "https://registry.npmjs.org/unpinned/-/unpinned-1.0.0.tgz" },
      },
    })}\n`);
    assert.throws(() => installSnapshotCompilerDependencies(snapshot), /lacks exact registry integrity/);
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
  }
});
