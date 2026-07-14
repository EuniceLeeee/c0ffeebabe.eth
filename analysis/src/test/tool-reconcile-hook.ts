import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const analysisRoot = path.join(repoRoot, "analysis");
const reconcileHook = path.join(repoRoot, "scripts/hooks/guard-tool-reconcile.py");
const stopHook = path.join(repoRoot, "scripts/hooks/guard-reconcile-stop.py");

interface IndexedTool {
  id: string;
  command: string;
}

interface SelectionState {
  schema_version: number;
  pending_nonce: string;
  recommended_tools: IndexedTool[];
  executed_tools: string[];
  executions?: Array<{ tool_id: string; exit_code: number }>;
}

const successResponse = { stdout: "ok", stderr: "", interrupted: false };

function runHook(hook: string, payload: object, environment: NodeJS.ProcessEnv) {
  return spawnSync("python3", [hook], {
    encoding: "utf8",
    env: environment,
    input: JSON.stringify(payload),
  });
}

test("reconcile hook uses a fresh generated capability plan and requires full executed coverage", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "mev-tool-reconcile-"));
  const pending = path.join(temporary, "pending");
  const selection = path.join(temporary, "selection.json");
  const environment = {
    ...process.env,
    CLAUDE_PROJECT_DIR: repoRoot,
    MEV_HOOK_TEST: "1",
    MEV_RECONCILE_PENDING_PATH: pending,
    MEV_TOOL_SELECTION_PATH: selection,
  };
  try {
    execFileSync(process.execPath, [
      "--import", "tsx", "src/cli/tool-index.ts", "--select", "redaction,single-transaction", "--json",
    ], { cwd: analysisRoot, env: environment, stdio: "pipe" });
    assert.ok(fs.existsSync(selection), "tool-index should persist its generated selection");

    const trigger = runHook(reconcileHook, {
      tool_name: "Bash",
      tool_input: { command: "python3 -c 'print(\"slot0 traceTransaction\")'" },
    }, environment);
    assert.equal(trigger.status, 2);
    assert.ok(fs.existsSync(pending));
    assert.equal(fs.existsSync(selection), false, "new manual analysis must invalidate stale selection");

    const unrelated = runHook(reconcileHook, {
      tool_name: "Write",
      tool_input: {
        file_path: path.join(temporary, "note.md"),
        content: "tool-reconciled: analysis:tx-profit agrees",
      },
    }, environment);
    assert.equal(unrelated.status, 0);
    assert.ok(fs.existsSync(pending), "a hardcoded or stale tool name must not clear pending state");

    execFileSync(process.execPath, [
      "--import", "tsx", "src/cli/tool-index.ts", "--select", "redaction,single-transaction", "--json",
    ], { cwd: analysisRoot, env: environment, stdio: "pipe" });
    const plan = JSON.parse(fs.readFileSync(selection, "utf8")) as SelectionState;
    assert.equal(plan.schema_version, 2);
    assert.match(plan.pending_nonce, /^[a-f0-9]{32}$/);
    assert.equal(plan.recommended_tools.length, 2, "the query should require a multi-tool coverage set");

    const first = runHook(reconcileHook, {
      tool_name: "Bash",
      tool_input: { command: plan.recommended_tools[0].command },
      tool_response: successResponse,
    }, environment);
    assert.equal(first.status, 0);
    assert.ok(fs.existsSync(pending), "partial capability coverage must not clear the gate");
    const afterFirst = JSON.parse(fs.readFileSync(selection, "utf8")) as SelectionState;
    assert.deepEqual(afterFirst.executed_tools, [plan.recommended_tools[0].id]);
    assert.equal(runHook(stopHook, {}, environment).status, 2);

    const second = runHook(reconcileHook, {
      tool_name: "Bash",
      tool_input: { command: plan.recommended_tools[1].command },
      tool_response: successResponse,
    }, environment);
    assert.equal(second.status, 0);
    assert.equal(fs.existsSync(pending), false);
    assert.equal(fs.existsSync(selection), false);
    assert.equal(runHook(stopHook, {}, environment).status, 0);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("selection is bound to the current pending nonce/repository and quoted tool names do not count", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "mev-tool-reconcile-binding-"));
  const pending = path.join(temporary, "pending");
  const selection = path.join(temporary, "selection.json");
  const environment = {
    ...process.env,
    CLAUDE_PROJECT_DIR: repoRoot,
    MEV_HOOK_TEST: "1",
    MEV_RECONCILE_PENDING_PATH: pending,
    MEV_TOOL_SELECTION_PATH: selection,
  };
  try {
    assert.equal(runHook(reconcileHook, {
      tool_name: "Bash",
      tool_input: { command: "node -e 'console.log(\"priceArb builderPayment\")'" },
    }, environment).status, 2);
    execFileSync(process.execPath, [
      "--import", "tsx", "src/cli/tool-index.ts", "--select", "single-transaction,pnl", "--json",
    ], { cwd: analysisRoot, env: environment, stdio: "pipe" });
    const plan = JSON.parse(fs.readFileSync(selection, "utf8")) as SelectionState;
    const fake = runHook(reconcileHook, {
      tool_name: "Bash",
      tool_input: { command: `printf '%s\\n' '${plan.recommended_tools[0].command}'` },
      tool_response: successResponse,
    }, environment);
    assert.equal(fake.status, 0);
    assert.ok(fs.existsSync(pending), "a quoted command description must not count as execution");

    const pendingState = JSON.parse(fs.readFileSync(pending, "utf8"));
    pendingState.nonce = "rotated";
    fs.writeFileSync(pending, `${JSON.stringify(pendingState)}\n`);
    const stale = runHook(reconcileHook, {
      tool_name: "Bash",
      tool_input: { command: plan.recommended_tools[0].command },
      tool_response: successResponse,
    }, environment);
    assert.equal(stale.status, 0);
    assert.ok(fs.existsSync(pending), "a stale selection nonce must not clear the current analysis");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("printed implementation paths and conditionally skipped tools do not count as execution", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "mev-tool-reconcile-command-head-"));
  const pending = path.join(temporary, "pending");
  const selection = path.join(temporary, "selection.json");
  const environment = {
    ...process.env,
    CLAUDE_PROJECT_DIR: repoRoot,
    MEV_HOOK_TEST: "1",
    MEV_RECONCILE_PENDING_PATH: pending,
    MEV_TOOL_SELECTION_PATH: selection,
  };
  try {
    assert.equal(runHook(reconcileHook, {
      tool_name: "Bash",
      tool_input: { command: "node -e 'console.log(\"priceArb builderPayment\")'" },
    }, environment).status, 2);
    execFileSync(process.execPath, [
      "--import", "tsx", "src/cli/tool-index.ts", "--select", "single-transaction,pnl", "--json",
    ], { cwd: analysisRoot, env: environment, stdio: "pipe" });
    const plan = JSON.parse(fs.readFileSync(selection, "utf8")) as SelectionState & {
      recommended_tools: Array<IndexedTool & { implementation?: string }>;
    };
    const selected = plan.recommended_tools[0];
    const printed = runHook(reconcileHook, {
      tool_name: "Bash",
      tool_input: { command: `printf '%s\\n' '${selected.implementation ?? "src/cli/tx-profit.ts"}'` },
      tool_response: successResponse,
    }, environment);
    assert.equal(printed.status, 0);
    assert.ok(fs.existsSync(pending));
    const skipped = runHook(reconcileHook, {
      tool_name: "Bash",
      tool_input: { command: `true || ${selected.command}` },
      tool_response: successResponse,
    }, environment);
    assert.equal(skipped.status, 0);
    assert.ok(fs.existsSync(pending));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("exact indexed reconciliation id can close a selected single-tool query", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "mev-tool-reconcile-id-"));
  const pending = path.join(temporary, "pending");
  const selection = path.join(temporary, "selection.json");
  const environment = {
    ...process.env,
    CLAUDE_PROJECT_DIR: repoRoot,
    MEV_HOOK_TEST: "1",
    MEV_RECONCILE_PENDING_PATH: pending,
    MEV_TOOL_SELECTION_PATH: selection,
  };
  try {
    assert.equal(runHook(reconcileHook, {
      tool_name: "Bash",
      tool_input: { command: "node -e 'console.log(\"priceArb builderPayment\")'" },
    }, environment).status, 2);
    execFileSync(process.execPath, [
      "--import", "tsx", "src/cli/tool-index.ts", "--select", "single-transaction,pnl", "--json",
    ], { cwd: analysisRoot, env: environment, stdio: "pipe" });
    const plan = JSON.parse(fs.readFileSync(selection, "utf8")) as SelectionState;
    const selectedId = plan.recommended_tools[0].id;
    assert.equal(runHook(reconcileHook, {
      tool_name: "Write",
      tool_input: {
        file_path: path.join(temporary, "note.md"),
        content: `tool-reconciled: ${selectedId} n/a false-positive marker`,
      },
    }, environment).status, 0);
    assert.equal(fs.existsSync(pending), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("generic tool-run clears pending only from a successful descriptor-bound receipt", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "mev-tool-reconcile-runner-"));
  const pending = path.join(temporary, "pending");
  const selection = path.join(temporary, "selection.json");
  const environment = {
    ...process.env,
    CLAUDE_PROJECT_DIR: repoRoot,
    MEV_HOOK_TEST: "1",
    MEV_RECONCILE_PENDING_PATH: pending,
    MEV_TOOL_SELECTION_PATH: selection,
  };
  try {
    assert.equal(runHook(reconcileHook, {
      tool_name: "Bash",
      tool_input: { command: "node -e 'console.log(\"slot0 traceTransaction\")'" },
    }, environment).status, 2);
    execFileSync(process.execPath, [
      "--import", "tsx", "src/cli/tool-index.ts", "--select", "classification,calibration",
      "--out", selection, "--json",
    ], { cwd: analysisRoot, env: environment, stdio: "pipe" });
    const command = `npm run tool-run -- --manifest ${selection} --tool analysis:competitor-calibration --`;
    execFileSync("npm", [
      "run", "tool-run", "--", "--manifest", selection, "--tool", "analysis:competitor-calibration", "--",
    ], { cwd: analysisRoot, env: environment, stdio: "pipe" });
    const plan = JSON.parse(fs.readFileSync(selection, "utf8")) as SelectionState;
    assert.deepEqual(plan.executions?.map((entry) => entry.tool_id), ["analysis:competitor-calibration"]);
    const reconcile = runHook(reconcileHook, {
      tool_name: "Bash",
      tool_input: { command },
      tool_response: successResponse,
    }, environment);
    assert.equal(reconcile.status, 0);
    assert.equal(fs.existsSync(pending), false);
    assert.equal(fs.existsSync(selection), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
