import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Readable, Writable } from "node:stream";
import { discoverToolIndex, type ToolExecutionManifest } from "../tool-index.js";
import { forwardToolOutput } from "../tool-run-output.js";
import { redactToolOutput } from "../tool-run-security.js";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

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

test("streamed redaction matches whole-output rules across UTF-8, secret and URL boundaries", async () => {
  const env = { FIXTURE_PRIVATE_KEY: "first-secret\nsecond-secret", FIXTURE_RPC_URL: "https://host.invalid/v2/secret-path-fragment" };
  const text = "头😀 " + env.FIXTURE_PRIVATE_KEY + " end " + env.FIXTURE_RPC_URL
    + " secret-path-fragment http://localhost:8545/ http://localhost:8545/private/path "
    + "HTTPS://long.invalid/" + "x".repeat(2 * 1024 * 1024) + "\n尾😀";
  const bytes = Buffer.from(text);
  // Tiny chunks split both UTF-8 bytes and every credential/URL prefix.
  const chunks = function* () {
    for (let offset = 0; offset < bytes.length; offset += 11) yield bytes.subarray(offset, offset + 11);
  };
  let output = "";
  const result = await forwardToolOutput(Readable.from(chunks()), new Writable({
    write(chunk, _encoding, callback) { output += chunk.toString(); callback(); },
  }), env);
  assert.equal(output, redactToolOutput(text, env));
  assert.equal(result.bytes, bytes.length);
  assert.equal(result.sha256, createHash("sha256").update(bytes).digest("hex"));
});

test("tool-run streams over 64 MiB without terminating its child and records raw bytes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mev-tool-stream-"));
  const secret = "fixture-large-private-value";
  try {
    for (const directory of ["analysis", "listener", "scripts"]) fs.mkdirSync(path.join(root, directory));
    fs.writeFileSync(path.join(root, "analysis/package.json"), JSON.stringify({
      scripts: { "fixture-output": "node fixture-output.mjs" },
    }));
    fs.writeFileSync(path.join(root, "listener/package.json"), JSON.stringify({ scripts: {} }));
    fs.writeFileSync(path.join(root, "analysis/fixture-output.mjs"), `
      import {once} from 'node:events';
      for (const stream of [process.stdout, process.stderr]) {
        for (let i=0;i<40;i++) if (!stream.write('x'.repeat(1024*1024))) await once(stream,'drain');
        stream.write('\\nEND '+process.env.FIXTURE_PRIVATE_KEY+'\\n');
      }
      process.exitCode=7;
    `);
    const tool = discoverToolIndex(root).find(entry => entry.id === "analysis:fixture-output")!;
    const manifestPath = path.join(root, "selection.json");
    const manifest: ToolExecutionManifest = {
      schema_version: 2, repo_root: root, pending_nonce: null,
      requested_capabilities: tool.capabilities, recommended_tools: [tool], related_tools: [],
      executions: [], generated_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const child = spawn(process.execPath, ["--import", loader, runner,
      "--manifest", manifestPath, "--tool", tool.id], {
      cwd: root, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FIXTURE_PRIVATE_KEY: secret,
        PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH },
    });
    const hashOut = createHash("sha256"), hashErr = createHash("sha256");
    let stdoutBytes = 0, stderrBytes = 0, stdoutTail = "", stderrTail = "";
    child.stdout.on("data", (chunk: Buffer) => {
      hashOut.update(chunk); stdoutBytes += chunk.length;
      stdoutTail = (stdoutTail + chunk.toString()).slice(-1024);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      hashErr.update(chunk); stderrBytes += chunk.length;
      stderrTail = (stderrTail + chunk.toString()).slice(-1024);
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject); child.once("close", resolve);
    });
    assert.equal(code, 7);
    assert(stdoutBytes + stderrBytes > 64 * 1024 * 1024);
    assert(stdoutTail.endsWith("\nEND <redacted-env>\n"));
    const receiptLine = `tool-run receipt=${tool.id} exit=7 manifest=${manifestPath}\n`;
    assert(stderrTail.endsWith("\nEND <redacted-env>\n" + receiptLine));
    const recorded = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as ToolExecutionManifest;
    const receipt = recorded.executions[0]!;
    assert.equal(receipt.exit_code, 7);
    const suffix = `\nEND ${secret}\n`, redactedSuffix = "\nEND <redacted-env>\n";
    const rawOut = createHash("sha256").update("\n> fixture-output\n> node fixture-output.mjs\n\n");
    const rawErr = createHash("sha256");
    const redactedOut = createHash("sha256").update("\n> fixture-output\n> node fixture-output.mjs\n\n");
    const redactedErr = createHash("sha256");
    for(let i=0;i<40;i++) for(const hash of [rawOut,rawErr,redactedOut,redactedErr]) hash.update("x".repeat(1024*1024));
    assert.equal(receipt.stdout_sha256, rawOut.update(suffix).digest("hex"));
    assert.equal(receipt.stderr_sha256, rawErr.update(suffix).digest("hex"));
    assert.equal(hashOut.digest("hex"), redactedOut.update(redactedSuffix).digest("hex"));
    assert.equal(hashErr.digest("hex"), redactedErr.update(redactedSuffix + receiptLine).digest("hex"));
    assert.equal(receipt.stdout_bytes, stdoutBytes + Buffer.byteLength(suffix) - Buffer.byteLength(redactedSuffix));
    assert.equal(receipt.stderr_bytes, stderrBytes - Buffer.byteLength(receiptLine) + Buffer.byteLength(suffix) - Buffer.byteLength(redactedSuffix));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("forwarding drains a slow destination and preserves raw invalid UTF-8 bytes", async () => {
  const raw = Buffer.from([0xff, 0x61, 0xe4, 0xb8, 0xad]);
  let output = "", writes = 0;
  const result = await forwardToolOutput(Readable.from([...raw].map(byte => Buffer.from([byte]))), new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, callback) { setTimeout(() => { output += chunk.toString(); writes++; callback(); }, 5); },
  }), {});
  assert(writes > 0);
  assert.equal(output, raw.toString("utf8"));
  assert.equal(result.sha256, createHash("sha256").update(raw).digest("hex"));
  assert.equal(result.bytes, raw.length);
});

for (const interruption of ["signal", "output-error"] as const) {
  test(`tool-run ${interruption} stops the npm analysis child`, { skip: process.platform === "win32", timeout: 15_000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mev-tool-cancel-"));
    let analysisPid: number | undefined;
    try {
      for (const directory of ["analysis", "listener", "scripts"]) fs.mkdirSync(path.join(root, directory));
      fs.writeFileSync(path.join(root, "analysis/package.json"), JSON.stringify({ scripts: { "fixture-output": "node fixture-output.mjs" } }));
      fs.writeFileSync(path.join(root, "listener/package.json"), JSON.stringify({ scripts: {} }));
      const pidPath = path.join(root, "analysis/child.pid");
      fs.writeFileSync(path.join(root, "analysis/fixture-output.mjs"), `
        import fs from 'node:fs';
        fs.writeFileSync('child.pid',String(process.pid));
        ${interruption === "signal" ? "process.on('SIGTERM',()=>{});" : ""}
        setInterval(()=>process.stdout.write('x'.repeat(64*1024)),10);
      `);
      const tool = discoverToolIndex(root).find(entry => entry.id === "analysis:fixture-output")!;
      const manifestPath = path.join(root, "selection.json");
      fs.writeFileSync(manifestPath, JSON.stringify({ schema_version: 2, repo_root: root, pending_nonce: null,
        requested_capabilities: tool.capabilities, recommended_tools: [tool], related_tools: [],
        executions: [], generated_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      } satisfies ToolExecutionManifest));
      const child = spawn(process.execPath, ["--import", loader, runner, "--manifest", manifestPath, "--tool", tool.id], {
        cwd: root, stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH },
      });
      child.stdout.resume(); child.stderr.resume();
      const closed = once(child, "close");
      for(let count=0;!fs.existsSync(pidPath)&&count<200;count++) await delay(10);
      assert(fs.existsSync(pidPath), "analysis child did not start");
      analysisPid = Number(fs.readFileSync(pidPath,"utf8"));
      if(interruption === "signal") child.kill("SIGTERM");
      else child.stdout.destroy();
      const [code] = await closed;
      assert.equal(code, interruption === "signal" ? 143 : 1);
      assert.throws(() => process.kill(analysisPid!, 0), /ESRCH/);
      if(interruption === "signal") {
        const manifest = JSON.parse(fs.readFileSync(manifestPath,"utf8")) as ToolExecutionManifest;
        assert.equal(manifest.executions[0]!.exit_code,143);
      }
    } finally {
      if (analysisPid) { try { process.kill(analysisPid, "SIGKILL"); } catch {} }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("tool-run records executable startup failure rather than a successful empty run", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mev-tool-spawn-"));
  try {
    for (const directory of ["analysis", "listener", "scripts"]) fs.mkdirSync(path.join(root, directory));
    fs.writeFileSync(path.join(root, "analysis/package.json"), JSON.stringify({ scripts: { "fixture-output": "node fixture-output.mjs" } }));
    fs.writeFileSync(path.join(root, "listener/package.json"), JSON.stringify({ scripts: {} }));
    const tool = discoverToolIndex(root).find(entry => entry.id === "analysis:fixture-output")!;
    const manifestPath = path.join(root, "selection.json");
    fs.writeFileSync(manifestPath, JSON.stringify({ schema_version: 2, repo_root: root, pending_nonce: null,
      requested_capabilities: tool.capabilities, recommended_tools: [tool], related_tools: [],
      executions: [], generated_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    } satisfies ToolExecutionManifest));
    const result = spawnSync(process.execPath, ["--import", loader, runner,
      "--manifest", manifestPath, "--tool", tool.id], {
      cwd: root, encoding: "utf8", env: { ...process.env, PATH: path.join(root,"missing-bin") },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 127);
    assert.match(result.stderr, /tool-run spawn failed: ENOENT/);
    const manifest = JSON.parse(fs.readFileSync(manifestPath,"utf8")) as ToolExecutionManifest;
    const receipt = manifest.executions[0]!;
    assert.equal(receipt.exit_code,127);
    assert.equal(receipt.stdout_bytes,0);
    assert.equal(receipt.stderr_bytes,0);
    assert.equal(receipt.stdout_sha256,createHash("sha256").digest("hex"));
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
