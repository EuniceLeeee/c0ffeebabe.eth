import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { discoverToolIndex, type ToolExecutionManifest } from "../tool-index.js";

const runner = fileURLToPath(new URL("../cli/tool-run.ts", import.meta.url));
const loader = fileURLToPath(new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url));

for (const code of [0, 7]) {
  test(`tool-run drains large redacted stdout/stderr before exit ${code}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mev-tool-output-"));
    const secret = "fixture-private-value";
    try {
      for (const directory of ["analysis", "listener", "scripts"]) fs.mkdirSync(path.join(root, directory));
      fs.writeFileSync(path.join(root, "analysis/package.json"), JSON.stringify({
        scripts: { "fixture-output": "node fixture-output.mjs" },
      }));
      fs.writeFileSync(path.join(root, "listener/package.json"), JSON.stringify({ scripts: {} }));
      fs.writeFileSync(path.join(root, "analysis/fixture-output.mjs"), `
        process.stdout.write('x'.repeat(2 * 1024 * 1024) + '\\nSTDOUT-END ' + process.env.FIXTURE_PRIVATE_KEY + '\\n');
        process.stderr.write('y'.repeat(2 * 1024 * 1024) + '\\nSTDERR-END ' + process.env.FIXTURE_PRIVATE_KEY + '\\n');
        process.exitCode = Number(process.argv[2]);
      `);
      const tool = discoverToolIndex(root).find(entry => entry.id === "analysis:fixture-output")!;
      const manifestPath = path.join(root, "selection.json");
      const manifest: ToolExecutionManifest = {
        schema_version: 2, repo_root: root, pending_nonce: null,
        requested_capabilities: tool.capabilities, recommended_tools: [tool], related_tools: [],
        executions: [], generated_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      };
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
      const result = spawnSync(process.execPath, ["--import", loader, runner,
        "--manifest", manifestPath, "--tool", tool.id, "--", String(code)], {
        cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, FIXTURE_PRIVATE_KEY: secret,
          PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH },
      });
      assert.ifError(result.error);
      assert.equal(result.status, code);
      assert(result.stdout.endsWith("x".repeat(2 * 1024 * 1024) + "\nSTDOUT-END <redacted-env>\n"), "large stdout suffix was lost");
      assert(result.stderr.startsWith("y".repeat(2 * 1024 * 1024) + "\nSTDERR-END <redacted-env>\n"), "large stderr suffix was lost");
      assert(result.stderr.includes(`tool-run receipt=${tool.id} exit=${code}`));
      assert(!result.stdout.includes(secret) && !result.stderr.includes(secret));
      const recorded = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as ToolExecutionManifest;
      assert.equal(recorded.executions.length, 1);
      assert.equal(recorded.executions[0]!.exit_code, code);
      const rawStdout = result.stdout.replaceAll("<redacted-env>", secret);
      const rawStderr = "y".repeat(2 * 1024 * 1024) + `\nSTDERR-END ${secret}\n`;
      assert.equal(recorded.executions[0]!.stdout_bytes, Buffer.byteLength(rawStdout));
      assert.equal(recorded.executions[0]!.stderr_bytes, Buffer.byteLength(rawStderr));
      assert.equal(recorded.executions[0]!.stdout_sha256, createHash("sha256").update(rawStdout).digest("hex"));
      assert.equal(recorded.executions[0]!.stderr_sha256, createHash("sha256").update(rawStderr).digest("hex"));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}
