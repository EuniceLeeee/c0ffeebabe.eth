import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

const CLI = resolve("src/cli/six-step-validation-gate.ts");
const TSX_IMPORT_URL = import.meta.resolve("tsx");

test("gate rejects a caller-authored pass envelope instead of validating it", () => {
  const temp = mkdtempSync(resolve(tmpdir(), "six-step-cli-test-"));
  try {
    const fake = resolve(temp, "handwritten-pass.json");
    writeFileSync(fake, JSON.stringify({
      status: "final_validated",
      production_route_stage: Array(6).fill({ status: "pass" }),
    }));
    const result = spawnSync(process.execPath, [
      "--import",
      TSX_IMPORT_URL,
      CLI,
      "--evidence",
      fake,
      "--phase",
      "final",
    ], {
      cwd: resolve("."),
      encoding: "utf8",
      shell: false,
    });
    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout) as {
      verdict: string;
      errors: string[];
    };
    assert.equal(output.verdict, "fail");
    assert.match(output.errors.join("\n"), /unknown option --evidence/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("gate refuses cleanup outside a generated final run", () => {
  const result = spawnSync(process.execPath, [
    "--import",
    TSX_IMPORT_URL,
    CLI,
    "--finalize-cleanup",
  ], {
    cwd: resolve("."),
    encoding: "utf8",
    shell: false,
  });
  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout) as {
    verdict: string;
    cleanup?: unknown;
  };
  assert.equal(output.verdict, "fail");
  assert.equal(output.cleanup, undefined);
});

test("bootstrap phase can never request branch cleanup", () => {
  const result = spawnSync(process.execPath, [
    "--import",
    TSX_IMPORT_URL,
    CLI,
    "--phase",
    "bootstrap",
    "--finalize-cleanup",
    "--request",
    "/tmp/not-read-bootstrap-request.json",
    "--out",
    "/tmp/not-written-bootstrap-receipt.json",
  ], {
    cwd: resolve("."),
    encoding: "utf8",
    shell: false,
  });
  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout) as {
    verdict: string;
    cleanup?: unknown;
    errors: string[];
  };
  assert.equal(output.verdict, "fail");
  assert.equal(output.cleanup, undefined);
  assert.match(output.errors.join("\n"), /allowed only in final phase/);
});
