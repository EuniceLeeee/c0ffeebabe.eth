#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  discoverToolIndex,
  relatedTools,
  selectTools,
  validateToolIndex,
} from "../tool-index.js";

const args = process.argv.slice(2);
const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const tools = discoverToolIndex(repoRoot);
const errors = validateToolIndex(repoRoot, tools);
if (errors.length > 0) {
  for (const error of errors) console.error(`FAIL: ${error}`);
  process.exit(1);
}
if (args.includes("--check")) {
  console.log(`PASS: indexed ${tools.length} analysis/listener/repo tools`);
  process.exit(0);
}

const selectIndex = args.indexOf("--select");
const requested = selectIndex >= 0
  ? (args[selectIndex + 1] ?? "").split(",").map((value) => value.trim()).filter(Boolean)
  : [];
if (selectIndex >= 0 && requested.length === 0) {
  throw new Error("usage: tool-index --select <capability[,capability]> [--json]");
}
const includeAll = args.includes("--all");
const selected = requested.length > 0
  ? selectTools(tools, requested)
  : tools.filter((tool) => includeAll || (tool.kind !== "test" && tool.kind !== "runtime"));
const related = requested.length > 0 ? relatedTools(tools, requested) : [];
const selectedCoverage = new Set(selected.flatMap((tool) => tool.capabilities));
const missing = requested.filter((capability) => !selectedCoverage.has(capability.trim().toLowerCase().replace(/_/g, "-")));
if (requested.length > 0 && missing.length > 0) {
  console.error(`No indexed tool set covers capabilities: ${missing.join(", ")}`);
  process.exit(2);
}

const selection = {
  schema_version: 2,
  repo_root: repoRoot,
  pending_nonce: null as string | null,
  requested_capabilities: requested.map((capability) => capability.toLowerCase().replace(/_/g, "-")),
  recommended_tools: selected,
  related_tools: related,
  executions: [],
  generated_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

if (requested.length > 0) {
  const outIndex = args.indexOf("--out");
  const requestedOut = outIndex >= 0 ? args[outIndex + 1] : undefined;
  const selectionPath = requestedOut
    ? path.resolve(requestedOut)
    : process.env.MEV_HOOK_TEST === "1"
      ? (process.env.MEV_TOOL_SELECTION_PATH ?? "/tmp/mev-tool-selection.json")
      : "/tmp/mev-tool-selection.json";
  const pendingPath = process.env.MEV_HOOK_TEST === "1"
    ? (process.env.MEV_RECONCILE_PENDING_PATH ?? "/tmp/mev-reconcile-pending")
    : "/tmp/mev-reconcile-pending";
  try {
    const pending = JSON.parse(fs.readFileSync(pendingPath, "utf8")) as { nonce?: unknown };
    selection.pending_nonce = typeof pending.nonce === "string" ? pending.nonce : null;
  } catch {
    selection.pending_nonce = randomUUID();
  }
  fs.mkdirSync(path.dirname(selectionPath), { recursive: true });
  const temporaryPath = `${selectionPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(selection, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, selectionPath);
}

if (args.includes("--json")) {
  console.log(JSON.stringify(selection, null, 2));
} else {
  console.log("# recommended coverage set");
  for (const tool of selected) {
    console.log(`${tool.id}\t${tool.kind}\t${tool.cost}\t${tool.capabilities.join(",")}\t${tool.command}\t${tool.summary}`);
  }
  const alternatives = related.filter((tool) => !selected.some((entry) => entry.id === tool.id));
  if (alternatives.length > 0) {
    console.log("# related alternatives");
    for (const tool of alternatives) {
      console.log(`${tool.id}\t${tool.kind}\t${tool.cost}\t${tool.capabilities.join(",")}\t${tool.command}\t${tool.summary}`);
    }
  }
}
