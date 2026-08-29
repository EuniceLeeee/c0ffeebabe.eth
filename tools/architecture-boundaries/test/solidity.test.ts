import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  collectFoundryBuildGraphFacts,
  validateFoundryBuildGraphFacts,
} from "../src/build-adapters/solidity.ts";
import type { BoundaryDiagnostic, TrackedFile } from "../src/index.ts";

const sha256 = (value: Buffer | string): string => `0x${createHash("sha256").update(value).digest("hex")}`;

function forgeAvailable(): boolean {
  try {
    execFileSync("forge", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function trackedFiles(root: string): TrackedFile[] {
  const output = execFileSync("git", ["ls-files", "-s"], { cwd: root, encoding: "utf8" }).trim();
  return output.length === 0 ? [] : output.split("\n").map((line) => {
    const [mode, blobSha, , path] = line.split(/\s+/);
    const bytes = readFileSync(join(root, path!));
    return {
      path: path!,
      mode: mode!,
      blobSha: blobSha!,
      contentSha256: sha256(bytes),
      byteLength: bytes.byteLength,
      language: path!.endsWith(".sol") ? "solidity" : "metadata",
      fileClass: "production-runtime",
    } satisfies TrackedFile;
  });
}

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "aloha-solidity-boundary-"));
  const write = (path: string, value: string) => {
    const target = join(root, path);
    const directory = target.slice(0, target.lastIndexOf("/"));
    execFileSync("mkdir", ["-p", directory]);
    writeFileSync(target, value);
  };
  write("contracts/foundry.toml", [
    "[profile.default]",
    "src = \"src\"",
    "test = \"test\"",
    "libs = []",
    "solc_version = \"0.8.24\"",
    "optimizer = true",
    "optimizer_runs = 200",
    "remappings = []",
    "",
  ].join("\n"));
  write("contracts/foundry-toolchain.json", readFileSync(new URL("../../../contracts/foundry-toolchain.json", import.meta.url), "utf8"));
  write("contracts/src/Child.sol", [
    "// SPDX-License-Identifier: MIT",
    "pragma solidity ^0.8.24;",
    "contract Child { function value() external pure returns (uint256) { return 7; } }",
    "",
  ].join("\n"));
  write("contracts/src/Root.sol", [
    "// SPDX-License-Identifier: MIT",
    "pragma solidity ^0.8.24;",
    "import \"./Child.sol\";",
    "contract Root { function child() external pure returns (uint256) { return 7; } }",
    "",
  ].join("\n"));
  execFileSync("git", ["init", "-b", "boundary-solidity"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "boundary@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Boundary Test"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "solidity fixture"], { cwd: root, stdio: "ignore" });
  return root;
}

test("Foundry adapter records exact config, compiler, sources and import graph", { skip: !forgeAvailable() }, () => {
  const root = fixtureRoot();
  try {
    const files = trackedFiles(root);
    const diagnostics: BoundaryDiagnostic[] = [];
    const facts = collectFoundryBuildGraphFacts(root, files, (value) => diagnostics.push(value));
    assert.ok(facts, JSON.stringify(diagnostics));
    assert.deepEqual(diagnostics, []);
    assert.equal(facts.config.path, "contracts/foundry.toml");
    assert.equal(facts.sourceFiles.length, 2);
    assert.equal(facts.imports.length, 1);
    assert.equal(facts.imports[0]?.from, "contracts/src/Root.sol");
    assert.equal(facts.imports[0]?.resolvedPath, "contracts/src/Child.sol");
    assert.equal(facts.buildInfos.length, 1);
    assert.equal(facts.toolchain.solcVersion, "0.8.24");
    assert.equal(facts.toolchain.pinPath, "contracts/foundry-toolchain.json");
    assert.match(facts.toolchain.forgeExecutableSha256, /^0x[0-9a-f]{64}$/);
    assert.match(facts.toolchain.solcExecutableSha256, /^0x[0-9a-f]{64}$/);
    assert.match(facts.rootDigest, /^0x[0-9a-f]{64}$/);
    const validation: BoundaryDiagnostic[] = [];
    validateFoundryBuildGraphFacts(root, files, facts, (value) => validation.push(value));
    assert.deepEqual(validation, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Foundry adapter rejects source/config drift and forged stored roots", { skip: !forgeAvailable() }, () => {
  const root = fixtureRoot();
  try {
    const baselineFiles = trackedFiles(root);
    const baselineDiagnostics: BoundaryDiagnostic[] = [];
    const baseline = collectFoundryBuildGraphFacts(root, baselineFiles, (value) => baselineDiagnostics.push(value));
    assert.ok(baseline, JSON.stringify(baselineDiagnostics));
    assert.deepEqual(baselineDiagnostics, []);

    writeFileSync(join(root, "contracts/src/Root.sol"), "// mutated\n" + readFileSync(join(root, "contracts/src/Root.sol"), "utf8"));
    const sourceDrift: BoundaryDiagnostic[] = [];
    const afterSourceMutation = collectFoundryBuildGraphFacts(root, baselineFiles, (value) => sourceDrift.push(value));
    assert.equal(afterSourceMutation, null);
    assert.ok(sourceDrift.some((item) => item.code === "solidity-build-info-drift"), JSON.stringify(sourceDrift));

    writeFileSync(join(root, "contracts/foundry.toml"), readFileSync(join(root, "contracts/foundry.toml"), "utf8").replace("optimizer_runs = 200", "optimizer_runs = 201"));
    const configDrift: BoundaryDiagnostic[] = [];
    const afterConfigMutation = collectFoundryBuildGraphFacts(root, baselineFiles, (value) => configDrift.push(value));
    assert.equal(afterConfigMutation, null);
    assert.ok(configDrift.some((item) => item.code === "solidity-build-info-drift" || item.code === "solidity-config-content-drift"), JSON.stringify(configDrift));

    const forged = {
      ...baseline,
      sourceRoot: `0x${"0".repeat(64)}`,
    };
    const forgedDiagnostics: BoundaryDiagnostic[] = [];
    validateFoundryBuildGraphFacts(root, baselineFiles, forged, (value) => forgedDiagnostics.push(value));
    assert.ok(forgedDiagnostics.some((item) => item.code === "solidity-source-root-mismatch"));
    assert.ok(forgedDiagnostics.some((item) => item.code === "solidity-build-graph-root-mismatch"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Foundry adapter fails closed when compiler import resolution is unavailable", { skip: !forgeAvailable() }, () => {
  const root = fixtureRoot();
  try {
    const files = trackedFiles(root);
    writeFileSync(join(root, "contracts/src/Root.sol"), readFileSync(join(root, "contracts/src/Root.sol"), "utf8").replace("./Child.sol", "./Missing.sol"));
    const diagnostics: BoundaryDiagnostic[] = [];
    const facts = collectFoundryBuildGraphFacts(root, files, (value) => diagnostics.push(value));
    assert.equal(facts, null);
    assert.ok(diagnostics.some((item) => item.code === "solidity-toolchain-unavailable"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Foundry adapter requires the tracked exact toolchain pin", { skip: !forgeAvailable() }, () => {
  const root = fixtureRoot();
  try {
    const pinPath = join(root, "contracts/foundry-toolchain.json");
    const pin = JSON.parse(readFileSync(pinPath, "utf8")) as Record<string, unknown>;
    writeFileSync(pinPath, `${JSON.stringify({ ...pin, forgeCommit: "0".repeat(40) }, null, 2)}\n`);
    execFileSync("git", ["add", "contracts/foundry-toolchain.json"], { cwd: root, stdio: "ignore" });
    const diagnostics: BoundaryDiagnostic[] = [];
    const facts = collectFoundryBuildGraphFacts(root, trackedFiles(root), (value) => diagnostics.push(value));
    assert.equal(facts, null);
    assert.ok(diagnostics.some((item) => item.code === "solidity-forge-pin-mismatch"), JSON.stringify(diagnostics));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
