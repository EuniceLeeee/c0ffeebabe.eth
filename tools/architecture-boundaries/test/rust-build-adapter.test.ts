import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  collectRustBuildAdapterFacts,
  type RustBuildTrackedFileV1,
} from "../src/build-adapters/rust.ts";

function hash(bytes: Buffer): string {
  return `0x${createHash("sha256").update(bytes).digest("hex")}`;
}

function toolchainRelease(): string {
  const value = execFileSync("rustc", ["--version", "--verbose"], { encoding: "utf8" });
  const release = /^release:\s*(\d+\.\d+\.\d+)$/m.exec(value)?.[1];
  assert.ok(release);
  return release;
}

function trackedFiles(root: string): RustBuildTrackedFileV1[] {
  const records = execFileSync("git", ["ls-files", "-s"], { cwd: root, encoding: "utf8" }).trim().split("\n").filter(Boolean);
  return records.map((record) => {
    const match = /^(\d+) ([0-9a-f]+) 0\t(.+)$/.exec(record);
    assert.ok(match);
    const path = match[3]!;
    const bytes = readFileSync(join(root, path));
    return {
      path,
      blobSha: match[2]!,
      contentSha256: hash(bytes),
      byteLength: bytes.byteLength,
      language: path.endsWith(".rs") ? "rust" : "metadata",
    };
  }).sort((a, b) => a.path.localeCompare(b.path));
}

function add(root: string): void {
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
}

test("cargo adapter binds the real compiler graph and fails closed on untracked or uncompiled Rust", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-rust-adapter-"));
  try {
    execFileSync("git", ["init", "-b", "codex/rust-adapter-fixture"], { cwd: root, stdio: "ignore" });
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "rust-toolchain.toml"), `[toolchain]\nchannel = "${toolchainRelease()}"\nprofile = "minimal"\n`);
    writeFileSync(join(root, "Cargo.toml"), `[package]\nname = "rust-adapter-fixture"\nversion = "0.1.0"\nedition = "2024"\n`);
    writeFileSync(join(root, "src/main.rs"), "fn main() { println!(\"v1\"); }\n");
    execFileSync("cargo", ["generate-lockfile"], { cwd: root, stdio: "ignore" });
    add(root);

    const first = collectRustBuildAdapterFacts(root, trackedFiles(root));
    assert.deepEqual(first.diagnostics, []);
    assert.ok(first.facts);
    assert.ok(first.facts.compilerInputs.some((input) => input.logicalPath === "src/main.rs" && input.origin === "tracked"));
    assert.ok(first.facts.compilerUnits.some((unit) => unit.packageId.includes("rust-adapter-fixture@0.1.0")));
    assert.match(first.facts.toolchain.targetLibInputRoot, /^0x[0-9a-f]{64}$/);

    writeFileSync(join(root, "README.md"), "unrelated\n");
    add(root);
    const unrelated = collectRustBuildAdapterFacts(root, trackedFiles(root));
    assert.deepEqual(unrelated.diagnostics, []);
    assert.equal(unrelated.facts?.rootDigest, first.facts.rootDigest);

    writeFileSync(join(root, "src/main.rs"), "fn main() { println!(\"v2\"); }\n");
    add(root);
    const changed = collectRustBuildAdapterFacts(root, trackedFiles(root));
    assert.deepEqual(changed.diagnostics, []);
    assert.ok(changed.facts);
    assert.notEqual(changed.facts.rootDigest, first.facts.rootDigest);
    assert.notEqual(changed.facts.compilerInputRoot, first.facts.compilerInputRoot);

    writeFileSync(join(root, "src/hidden.rs"), "pub fn hidden() {}\n");
    writeFileSync(join(root, "src/main.rs"), "mod hidden; fn main() { hidden::hidden(); }\n");
    execFileSync("git", ["add", "src/main.rs"], { cwd: root, stdio: "ignore" });
    const untracked = collectRustBuildAdapterFacts(root, trackedFiles(root));
    assert.equal(untracked.facts, null);
    assert.ok(untracked.diagnostics.some((entry) => entry.code === "rust-compiler-input-not-tracked"));

    add(root);
    writeFileSync(join(root, "src/dead.rs"), "pub fn dead() {}\n");
    execFileSync("git", ["add", "src/dead.rs"], { cwd: root, stdio: "ignore" });
    const dead = collectRustBuildAdapterFacts(root, trackedFiles(root));
    assert.equal(dead.facts, null);
    assert.ok(dead.diagnostics.some((entry) => entry.code === "rust-source-not-in-compiler-graph"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cargo adapter requires an exact tracked toolchain pin", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-rust-pin-"));
  try {
    execFileSync("git", ["init", "-b", "codex/rust-pin-fixture"], { cwd: root, stdio: "ignore" });
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "Cargo.toml"), `[package]\nname = "rust-pin-fixture"\nversion = "0.1.0"\nedition = "2024"\n`);
    writeFileSync(join(root, "Cargo.lock"), "version = 4\n\n[[package]]\nname = \"rust-pin-fixture\"\nversion = \"0.1.0\"\n");
    writeFileSync(join(root, "src/main.rs"), "fn main() {}\n");
    add(root);
    const missing = collectRustBuildAdapterFacts(root, trackedFiles(root));
    assert.equal(missing.facts, null);
    assert.ok(missing.diagnostics.some((entry) => entry.code === "rust-toolchain-pin-missing"));

    writeFileSync(join(root, "rust-toolchain.toml"), "[toolchain]\nchannel = \"stable\"\n");
    add(root);
    const floating = collectRustBuildAdapterFacts(root, trackedFiles(root));
    assert.equal(floating.facts, null);
    assert.ok(floating.diagnostics.some((entry) => entry.code === "rust-toolchain-pin-not-exact"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
