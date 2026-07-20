import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  bindToolWindowArguments,
  discoverToolIndex,
  PRODUCTION_DECISION_CAPABILITIES,
  relatedTools,
  selectTools,
  toolDescriptorSha256,
  type ToolExecutionManifest,
  validateRecordedToolSelection,
  validateToolIndex,
} from "../tool-index.js";

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const HASH = "a".repeat(64);

function evidence(toolIds: string[], capabilities: string[], window?: { from: number; to: number }) {
  const tools = discoverToolIndex(repoRoot);
  const manifest: ToolExecutionManifest = {
    schema_version: 2,
    repo_root: repoRoot,
    pending_nonce: null,
    requested_capabilities: capabilities,
    recommended_tools: selectTools(tools, capabilities),
    related_tools: relatedTools(tools, capabilities),
    executions: toolIds.map((id) => {
      const tool = tools.find((entry) => entry.id === id)!;
      const boundArgs = bindToolWindowArguments(tool, [], tool.capabilities.includes("competitor-window") ? window : undefined);
      const argv = tool.package === "repo"
        ? ["bash", tool.implementation ?? tool.script, ...boundArgs]
        : ["npm", "run", tool.script, "--", ...boundArgs];
      return {
        schema_version: 1 as const,
        tool_id: id,
        descriptor_sha256: toolDescriptorSha256(tool),
        started_at: "2026-07-14T00:00:00.000Z",
        finished_at: "2026-07-14T00:00:01.000Z",
        exit_code: 0,
        cwd: tool.package,
        argv_sha256: HASH,
        argv_redacted: argv,
        ...(window ? { window } : {}),
        stdout_sha256: HASH,
        stderr_sha256: HASH,
        stdout_bytes: 1,
        stderr_bytes: 0,
      };
    }),
    generated_at: "2026-07-14T00:00:00.000Z",
    updated_at: "2026-07-14T00:00:01.000Z",
  };
  return {
    selection: {
      capability_query: capabilities,
      selected_tools: toolIds,
      catalog_check_exit_code: 0,
      evidence_manifest: "tools.json",
      evidence_manifest_sha256: HASH,
    },
    manifest,
  };
}

test("generated index covers every analysis CLI and every curated package/repo tool still exists", () => {
  const tools = discoverToolIndex(repoRoot);
  assert.deepEqual(validateToolIndex(repoRoot, tools), []);
  assert.ok(tools.length > 80, `expected analysis + listener inventory, got ${tools.length}`);
});

test("AppleDouble metadata is ignored without hiding an ordinary orphan CLI", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "mev-tool-index-"));
  try {
    fs.mkdirSync(path.join(fixture, "analysis/src/cli"), { recursive: true });
    fs.mkdirSync(path.join(fixture, "listener"), { recursive: true });
    fs.mkdirSync(path.join(fixture, "scripts"), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, "analysis/package.json"), path.join(fixture, "analysis/package.json"));
    fs.copyFileSync(path.join(repoRoot, "listener/package.json"), path.join(fixture, "listener/package.json"));
    fs.writeFileSync(path.join(fixture, "analysis/src/cli/live-loss.ts"), "");
    fs.writeFileSync(path.join(fixture, "analysis/src/cli/._live-loss.ts"), "AppleDouble metadata");
    fs.writeFileSync(path.join(fixture, "analysis/src/cli/orphan.ts"), "");
    for (const name of ["census-gap.sh", "deploy-ab-challenger.sh", "deploy-node.sh"]) {
      fs.writeFileSync(path.join(fixture, "scripts", name), "#!/bin/sh\n");
    }
    fs.writeFileSync(path.join(fixture, "scripts/._ghost.sh"), "AppleDouble metadata");

    const tools = discoverToolIndex(fixture);
    assert.deepEqual(validateToolIndex(fixture, tools), [
      "analysis CLI has no package-script index entry: src/cli/orphan.ts",
    ]);
    assert.equal(tools.some((tool) => tool.id.includes("._ghost.sh")), false);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("production decision requires common A/B evidence without forcing a route transaction", () => {
  const tools = discoverToolIndex(repoRoot);
  const record = evidence(["analysis:ab-canary-compare"], ["ab", "comparison"]);
  const errors = validateRecordedToolSelection(record.selection, tools, PRODUCTION_DECISION_CAPABILITIES, record.manifest);
  assert.ok(errors.some((error) => error.includes("competitor-window")));
  assert.ok(errors.some((error) => error.includes("classification")));
  assert.ok(errors.some((error) => error.includes("block-scan")));
  assert.ok(!errors.some((error) => error.includes("single-transaction")));
  assert.ok(!errors.some((error) => error.includes("causality")));
  assert.ok(!errors.some((error) => error.includes("pnl")));
});

test("generated tool index does not replace the legacy analysis dispatcher", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "analysis/package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.equal(packageJson.scripts.analysis, "tsx src/cli/index.ts");
  assert.equal(packageJson.scripts["tool-index"], "tsx src/cli/tool-index.ts");
});

test("capability selection chooses the canonical deep transaction analyzer", () => {
  const tools = selectTools(discoverToolIndex(repoRoot), ["single-transaction", "causality"]);
  assert.equal(tools[0]?.id, "analysis:bundle-postmortem");
});

test("fixture calibration cannot satisfy live competitor-window evidence", () => {
  const tools = discoverToolIndex(repoRoot);
  const calibration = tools.find((tool) => tool.id === "analysis:competitor-calibration");
  assert.equal(calibration?.capabilities.includes("competitor-window"), false);
  const selected = selectTools(tools, [...PRODUCTION_DECISION_CAPABILITIES]);
  assert.ok(selected.some((tool) => tool.capabilities.includes("competitor-window")
    && tool.id !== "analysis:competitor-calibration"));
});

test("capability selection composes a minimal multi-tool coverage set", () => {
  const synthetic = [
    { id: "a", capabilities: ["live", "classification"], priority: 80, curated: true },
    { id: "b", capabilities: ["pnl"], priority: 90, curated: true },
    { id: "c", capabilities: ["live"], priority: 100, curated: true },
  ] as ReturnType<typeof discoverToolIndex>;
  assert.deepEqual(selectTools(synthetic, ["live", "classification", "pnl"]).map((tool) => tool.id), ["a", "b"]);
  assert.deepEqual(relatedTools(synthetic, ["live", "pnl"]).map((tool) => tool.id), ["c", "b", "a"]);
});

test("recorded selection is checked against the live generated catalog", () => {
  const tools = discoverToolIndex(repoRoot);
  const pnl = evidence(["analysis:tx-profit"], ["single-transaction", "pnl"]);
  assert.deepEqual(validateRecordedToolSelection(pnl.selection, tools, [], pnl.manifest), []);
  const flow = evidence(["analysis:tx-profit", "analysis:tx-flow"], ["single-transaction", "pnl", "flow"]);
  assert.deepEqual(validateRecordedToolSelection(flow.selection, tools, [], flow.manifest), []);
  const incomplete = evidence(["analysis:tx-profit"], ["single-transaction", "causality"]);
  assert.ok(validateRecordedToolSelection(incomplete.selection, tools, [], incomplete.manifest)
    .some((error) => error.includes("tool set does not provide")));
});

test("live competitor execution receipt must bind the exact declared window", () => {
  const tools = discoverToolIndex(repoRoot);
  const record = evidence(["analysis:census-report"], ["competitor-window", "classification"], { from: 100, to: 200 });
  assert.deepEqual(validateRecordedToolSelection(record.selection, tools, [], record.manifest, { from: 100, to: 200 }), []);
  assert.ok(validateRecordedToolSelection(record.selection, tools, [], record.manifest, { from: 101, to: 200 })
    .some((error) => error.includes("exactly match")));
});

test("window arguments are runner-owned and injected from the declared receipt window", () => {
  const tools = discoverToolIndex(repoRoot);
  const census = tools.find((tool) => tool.id === "analysis:census-report")!;
  assert.deepEqual(bindToolWindowArguments(census, ["--watch", "0xabc"], { from: 100, to: 200 }), [
    "--watch", "0xabc", "--from-block", "100", "--to-block", "200",
  ]);
  assert.throws(
    () => bindToolWindowArguments(census, ["--from-block", "99"], { from: 100, to: 200 }),
    /owned by tool-run/,
  );
  const gap = tools.find((tool) => tool.id === "repo:scripts/census-gap.sh")!;
  assert.deepEqual(bindToolWindowArguments(gap, ["watch.csv", "/tmp/out"], { from: 100, to: 200 }), [
    "100", "200", "watch.csv", "/tmp/out",
  ]);
});
