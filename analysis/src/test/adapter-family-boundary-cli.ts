import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

const CLI = resolve("src/cli/adapter-family-boundary-gate.ts");
const TSX_IMPORT_URL = import.meta.resolve("tsx");

test("boundary CLI preserves exact changed paths when candidate manifest loading fails", () => {
  const temp = mkdtempSync(resolve(tmpdir(), "adapter-boundary-cli-test-"));
  try {
    git(temp, ["init", "--quiet"]);
    git(temp, ["config", "user.email", "test@example.com"]);
    git(temp, ["config", "user.name", "Boundary Test"]);
    mkdirSync(
      resolve(temp, "listener/src/searcher/test"),
      { recursive: true },
    );
    mkdirSync(resolve(temp, "analysis"), { recursive: true });
    writeFileSync(resolve(temp, "analysis/package.json"), "{}\n");
    writeFileSync(resolve(temp, "listener/package.json"), "{}\n");
    writeFileSync(
      resolve(
        temp,
        "listener/src/searcher/test/family-ownership-manifest.ts",
      ),
      [
        'import { writeFileSync } from "node:fs";',
        "const manifest = {",
        "  schema_version: 1,",
        "  families: [],",
        "  registry_order: [],",
        "  action_catalog_ids: [],",
        "};",
        'const index = process.argv.indexOf("--out");',
        "if (index < 0 || !process.argv[index + 1]) {",
        '  throw new Error("missing --out");',
        "}",
        "writeFileSync(",
        "  process.argv[index + 1],",
        "  `${JSON.stringify(manifest)}\\n`,",
        '  { flag: "wx", mode: 0o600 },',
        ");",
        "",
      ].join("\n"),
    );
    git(temp, ["add", "."]);
    git(temp, ["commit", "--quiet", "-m", "baseline"]);
    const baseline = gitOut(temp, ["rev-parse", "HEAD"]);

    mkdirSync(
      resolve(temp, "listener/src/searcher/venues/swaps"),
      { recursive: true },
    );
    writeFileSync(
      resolve(
        temp,
        "listener/src/searcher/test/family-ownership-manifest.ts",
      ),
      'throw new Error("candidate manifest schema invalid");\n',
    );
    writeFileSync(
      resolve(temp, "listener/src/searcher/venues/swaps/ekubo.ts"),
      "export const ekubo = true;\n",
    );
    git(temp, ["add", "."]);
    git(temp, ["commit", "--quiet", "-m", "broken candidate"]);
    const candidate = gitOut(temp, ["rev-parse", "HEAD"]);

    symlinkSync(
      resolve("node_modules"),
      resolve(temp, "analysis/node_modules"),
      "dir",
    );
    symlinkSync(
      resolve("../listener/node_modules"),
      resolve(temp, "listener/node_modules"),
      "dir",
    );
    const out = resolve(temp, "boundary.json");
    const result = spawnSync(process.execPath, [
      "--import",
      TSX_IMPORT_URL,
      CLI,
      "--baseline",
      baseline,
      "--candidate",
      candidate,
      "--out",
      out,
    ], {
      cwd: temp,
      encoding: "utf8",
      shell: false,
    });
    assert.equal(result.status, 1);
    const receipt = JSON.parse(readFileSync(out, "utf8")) as {
      classification: string;
      baseline_commit: string;
      candidate_commit: string;
      changed_paths: string[];
      reasons: string[];
    };
    assert.equal(receipt.classification, "framework");
    assert.equal(receipt.baseline_commit, baseline);
    assert.equal(receipt.candidate_commit, candidate);
    assert.deepEqual(receipt.changed_paths, [
      "listener/src/searcher/test/family-ownership-manifest.ts",
      "listener/src/searcher/venues/swaps/ekubo.ts",
    ]);
    assert.match(
      receipt.reasons.join("\n"),
      /gate_error: .*candidate manifest schema invalid/s,
    );
    assert.match(
      result.stdout,
      /^ADAPTER_FAMILY_BOUNDARY_RESULT=.*"changed_paths"/m,
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    result.stderr || `git ${args.join(" ")} failed`,
  );
}

function gitOut(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    result.stderr || `git ${args.join(" ")} failed`,
  );
  return result.stdout.trim().toLowerCase();
}
