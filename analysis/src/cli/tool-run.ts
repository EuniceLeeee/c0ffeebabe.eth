#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  bindToolWindowArguments,
  discoverToolIndex,
  toolDescriptorSha256,
  type ToolExecutionManifest,
  type ToolExecutionReceipt,
} from "../tool-index.js";
import {
  assertNoSecretBearingToolArgs,
  redactToolArgv,
  redactToolOutput,
} from "../tool-run-security.js";

const args = process.argv.slice(2);
const separator = args.indexOf("--");
const controlArgs = separator >= 0 ? args.slice(0, separator) : args;
const value = (name: string): string | undefined => {
  const index = controlArgs.indexOf(name);
  return index >= 0 ? controlArgs[index + 1] : undefined;
};
const manifestPath = value("--manifest");
const toolId = value("--tool");
if (!manifestPath || !toolId) {
  throw new Error("usage: tool-run --manifest <selection.json> --tool <indexed-id> [--window from..to] -- <tool args>");
}
const requestedToolArgs = separator >= 0 ? args.slice(separator + 1) : [];
assertNoSecretBearingToolArgs(requestedToolArgs);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as ToolExecutionManifest;
if (manifest.schema_version !== 2) throw new Error("tool-run requires a schema-v2 tool-index manifest");
const repoRoot = fs.realpathSync(manifest.repo_root);
const currentRoot = fs.realpathSync(path.resolve(process.cwd(), repoRoot));
if (currentRoot !== repoRoot) throw new Error("tool manifest repo_root is not current");
const tools = discoverToolIndex(repoRoot);
const tool = tools.find((entry) => entry.id === toolId);
if (!tool) throw new Error(`unknown indexed tool: ${toolId}`);
const allowed = [...manifest.recommended_tools, ...manifest.related_tools].some((entry) => entry.id === toolId);
if (!allowed) throw new Error(`${toolId} is not in this capability query's generated candidate set`);
if (tool.kind === "runtime" || tool.capabilities.some((capability) => [
  "deployment", "promotion", "cleanup", "auto-close", "branch-lifecycle",
].includes(capability))) {
  throw new Error(`${toolId} is side-effectful and cannot be used as analysis execution evidence`);
}

const windowText = value("--window");
const windowMatch = windowText?.match(/^(\d+)\.\.(\d+)$/);
const window = windowMatch ? { from: Number(windowMatch[1]), to: Number(windowMatch[2]) } : undefined;
if (window && window.from > window.to) throw new Error("--window must be from..to");
if (tool.capabilities.includes("competitor-window") && !window) {
  throw new Error(`${toolId} requires --window from..to for live-window evidence`);
}
const toolArgs = bindToolWindowArguments(tool, requestedToolArgs, window);

let executable: string;
let childArgs: string[];
let cwd: string;
if (tool.package === "analysis" || tool.package === "listener") {
  executable = "npm";
  childArgs = ["run", tool.script, "--", ...toolArgs];
  cwd = path.join(repoRoot, tool.package);
} else {
  const implementation = path.join(repoRoot, tool.implementation ?? tool.script);
  if (implementation.endsWith(".py")) {
    executable = "python3";
    childArgs = [implementation, ...toolArgs];
  } else if (implementation.endsWith(".sh")) {
    executable = "bash";
    childArgs = [implementation, ...toolArgs];
  } else {
    throw new Error(`unsupported repository tool executable: ${implementation}`);
  }
  cwd = repoRoot;
}

const startedAt = new Date().toISOString();
const result = spawnSync(executable, childArgs, {
  cwd,
  encoding: "utf8",
  env: process.env,
  maxBuffer: 64 * 1024 * 1024,
});
const finishedAt = new Date().toISOString();
const stdout = result.stdout ?? "";
const stderr = result.stderr ?? "";
if (stdout) process.stdout.write(redactToolOutput(stdout));
if (stderr) process.stderr.write(redactToolOutput(stderr));
const exitCode = result.error ? 127 : (result.status ?? 128);
const exactArgv = [executable, ...childArgs];
const receipt: ToolExecutionReceipt = {
  schema_version: 1,
  tool_id: tool.id,
  descriptor_sha256: toolDescriptorSha256(tool),
  started_at: startedAt,
  finished_at: finishedAt,
  exit_code: exitCode,
  cwd: path.relative(repoRoot, cwd) || ".",
  argv_sha256: createHash("sha256").update(JSON.stringify(exactArgv)).digest("hex"),
  argv_redacted: redactToolArgv(exactArgv),
  ...(window ? { window } : {}),
  stdout_sha256: createHash("sha256").update(stdout).digest("hex"),
  stderr_sha256: createHash("sha256").update(stderr).digest("hex"),
  stdout_bytes: Buffer.byteLength(stdout),
  stderr_bytes: Buffer.byteLength(stderr),
};
manifest.executions.push(receipt);
manifest.updated_at = finishedAt;
const temporary = `${manifestPath}.${process.pid}.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(temporary, manifestPath);
console.error(`tool-run receipt=${tool.id} exit=${exitCode} manifest=${manifestPath}`);
process.exit(exitCode);
