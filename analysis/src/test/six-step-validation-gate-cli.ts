import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const CLI = resolve("src/cli/six-step-validation-gate.ts");
const TSX = import.meta.resolve("tsx");

test("core gate reads semantic receipts and rejects lifecycle flags", () => {
  const root = mkdtempSync(resolve(tmpdir(), "six-step-judgment-cli-"));
  try {
    const input = resolve(root, "input.json");
    const output = resolve(root, "output.json");
    writeFileSync(input, JSON.stringify({
      schema_version: 1,
      gate: "six-step-judgment",
      claim: "adapter_merge",
      adapter_replays: [],
    }));
    const judged = spawnSync(process.execPath, [
      "--import",
      TSX,
      CLI,
      "--input",
      input,
      "--out",
      output,
    ], { encoding: "utf8" });
    assert.equal(judged.status, 1);
    const receipt = JSON.parse(judged.stdout);
    assert.equal(receipt.gate, "six-step-judgment");
    assert.equal(receipt.adapter_merge_ready, false);
    assert.match(receipt.errors.join("\n"), /promotion_receipt/);

    const retired = spawnSync(process.execPath, [
      "--import",
      TSX,
      CLI,
      "--phase",
      "final",
      "--finalize-cleanup",
    ], { encoding: "utf8" });
    assert.equal(retired.status, 1);
    assert.match(retired.stdout, /usage: --input/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
