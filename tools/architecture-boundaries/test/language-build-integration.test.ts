import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { runBoundaryGate } from "../src/index.ts";

function available(name: string): boolean {
  try {
    execFileSync(name, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("boundary receipt binds Rust and Solidity compiler/build graphs into one manifest", { skip: !available("cargo") || !available("forge") }, () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-language-build-"));
  const write = (path: string, value: string): void => {
    const directory = join(root, path.slice(0, Math.max(0, path.lastIndexOf("/"))));
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(root, path), value);
  };
  const addAndCommit = (message: string): void => {
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", message], { cwd: root, stdio: "ignore" });
  };
  try {
    execFileSync("git", ["init", "-b", "codex/language-build-fixture"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "boundary@example.invalid"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Boundary Test"], { cwd: root });
    write(".gitignore", "contracts/out/\ncontracts/cache/\nruntime/worker/target/\n");
    write("rust-toolchain.toml", readFileSync(new URL("../../../rust-toolchain.toml", import.meta.url), "utf8"));
    write("runtime/worker/Cargo.toml", "[package]\nname = \"language-build-fixture\"\nversion = \"0.1.0\"\nedition = \"2024\"\n");
    write("runtime/worker/src/main.rs", "fn main() { println!(\"v1\"); }\n");
    execFileSync("cargo", ["generate-lockfile", "--manifest-path", join(root, "runtime/worker/Cargo.toml")], { cwd: root, stdio: "ignore" });
    write("contracts/foundry.toml", "[profile.default]\nsrc = \"src\"\ntest = \"test\"\nlibs = []\nsolc_version = \"0.8.24\"\noptimizer = true\noptimizer_runs = 200\n");
    write("contracts/foundry-toolchain.json", readFileSync(new URL("../../../contracts/foundry-toolchain.json", import.meta.url), "utf8"));
    write("contracts/src/Fixture.sol", "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.24;\ncontract Fixture { function value() external pure returns (uint256) { return 1; } }\n");
    addAndCommit("language build fixture");

    const first = runBoundaryGate({ gitRoot: root, requirePushed: false });
    assert.equal(first.verdict, "pass", JSON.stringify(first.diagnostics));
    assert.ok(first.languageBuild.rust);
    assert.ok(first.languageBuild.solidity);
    assert.equal(first.compiler.languageBuildRoot, first.languageBuild.rootDigest);
    assert.match(first.denominator.manifestRoot, /^0x[0-9a-f]{64}$/);

    write("README.md", "unrelated denominator fact\n");
    addAndCommit("unrelated mutation");
    const unrelated = runBoundaryGate({ gitRoot: root, requirePushed: false });
    assert.equal(unrelated.verdict, "pass", JSON.stringify(unrelated.diagnostics));
    assert.equal(unrelated.languageBuild.rootDigest, first.languageBuild.rootDigest);
    assert.notEqual(unrelated.denominator.manifestRoot, first.denominator.manifestRoot);

    write("runtime/worker/src/main.rs", "fn main() { println!(\"v2\"); }\n");
    addAndCommit("rust source mutation");
    const rustChanged = runBoundaryGate({ gitRoot: root, requirePushed: false });
    assert.equal(rustChanged.verdict, "pass", JSON.stringify(rustChanged.diagnostics));
    assert.notEqual(rustChanged.languageBuild.rust?.rootDigest, first.languageBuild.rust.rootDigest);
    assert.notEqual(rustChanged.languageBuild.rootDigest, first.languageBuild.rootDigest);

    write("contracts/src/Fixture.sol", "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.24;\ncontract Fixture { function value() external pure returns (uint256) { return 2; } }\n");
    addAndCommit("solidity source mutation");
    const solidityChanged = runBoundaryGate({ gitRoot: root, requirePushed: false });
    assert.equal(solidityChanged.verdict, "pass", JSON.stringify(solidityChanged.diagnostics));
    assert.notEqual(solidityChanged.languageBuild.solidity?.rootDigest, rustChanged.languageBuild.solidity?.rootDigest);
    assert.notEqual(solidityChanged.languageBuild.rootDigest, rustChanged.languageBuild.rootDigest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
