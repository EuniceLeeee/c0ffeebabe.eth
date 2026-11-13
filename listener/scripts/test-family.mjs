import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getInstalledTransactionFamilies, loadFamilyTransactionRegistry } from "../src/searcher/test/family-transaction-registry.js";

const defaultRoot = fileURLToPath(new URL("../", import.meta.url));
const digest = value => createHash("sha256").update(value).digest("hex");
const safe = error => String(error instanceof Error ? error.message : error).replace(/https?:\/\/[^\s"<>]+/g, "[REDACTED_URL]");
function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    assert(!entry.isSymbolicLink(), "test/source symlink cannot be fingerprinted");
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}
export function familyTestSourceFingerprint(root = defaultRoot) {
  const paths = [...walk(resolve(root, "src")), ...walk(resolve(root, "scripts")),
    ...["package.json", "package-lock.json", "tsconfig.json"].map(name => resolve(root, name)).filter(existsSync),
    ...["src", "scripts"].map(name => resolve(root, "..", name)).filter(existsSync).flatMap(walk),
    resolve(root, "../.github/workflows/test.yml")].filter(existsSync);
  return digest(JSON.stringify([process.version, ...[...new Set(paths)].sort().map(path => [relative(root, path), digest(readFileSync(path))])]));
}
export function parseFamilyTestArguments(argv) {
  const values = new Map(); let offline = false;
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === "--offline" && !offline) { offline = true; continue; }
    assert(["--scope", "--family", "--rpc-file", "--ready", "--out", "--executor-code-mode", "--simulation-method"].includes(key) && !values.has(key) && argv[i + 1] && !argv[i + 1].startsWith("--"), `invalid test argument ${key}`);
    values.set(key, argv[++i]);
  }
  assert((values.get("--scope") ?? "installed") === "installed", "main test scope is installed");
  assert(["deployed", "counterfactual"].includes(values.get("--executor-code-mode") ?? "counterfactual"), "invalid executor code mode");
  assert(["debug_traceCall", "eth_simulateV1"].includes(values.get("--simulation-method") ?? "eth_simulateV1"), "invalid simulation method");
  return { values, offline };
}
export function summarizeFamilyTransactionResults(family, legs, offlinePassed) {
  const rows = legs.filter(row => row.familyId === family.familyId), complete = rows.filter(row => row.inputComplete);
  const passed = complete.filter(row => row.status === "pass" && row.evidenceVerified === true);
  const actionCoverage = family.domain === "funding" ? undefined : {
    unit: "family-owned-route-action",
    exhaustive: false,
    boundary: "Known implemented actions only; every registered TX case remains independently required, including actions absent from this inventory.",
    actions: (family.executionActions ?? []).map(action => {
      const samples = passed.filter(row => row.stages?.discoveryCheckpoint?.edges?.some(edge => edge.adapterId === action.adapterId));
      return { ...action, status: samples.length ? "pass" : "sample-missing",
        samples: samples.map(row => ({ transactionHash: row.transactionHash, legId: row.legId })) };
    }),
  };
  const missingActions = actionCoverage?.actions.filter(action => action.status === "sample-missing").map(action => action.adapterId) ?? [];
  return { ...family, ...(actionCoverage ? { actionCoverage, missingActions } : {}), references: rows.length, completeInputs: complete.length, incompleteInputs: rows.length - complete.length, passedLegs: passed.length,
    result: !offlinePassed || complete.some(row => row.status === "failed") ? "failed"
      : complete.length === 0 || complete.length !== rows.length || passed.length !== complete.length || missingActions.length > 0 ? "incomplete" : "pass",
    ...(rows.length === 0 ? { missing: ["no registered historical transaction"] } : {}), legs: rows };
}
const execute = (args, root, env) => {
  const child = spawnSync(process.execPath, args, { cwd: root, env, stdio: "inherit" });
  return { exitCode: child.status, signal: child.signal, ...(child.error ? { error: safe(child.error) } : {}) };
};

/** Test seams substitute process I/O only. The CLI has no skip-verification flag. */
export async function familyTestMain(argv = process.argv.slice(2), hooks = {}) {
  if (argv.length === 1 && argv[0] === "--help") {
    console.log("npm test -- [--scope installed] [--family ID] [--rpc-file PATH] [--ready PATH] [--out NEW_DIRECTORY]\n" +
      "            [--executor-code-mode deployed|counterfactual] [--simulation-method debug_traceCall|eth_simulateV1]\n" +
      "npm test -- --offline  # Existing offline contracts only; no factual simulation acceptance\n" +
      "RPC file: {MAINNET_RPC_URL: ...}. Main tests default to eth_simulateV1 and counterfactual test executors, requiring a current BotVM artifact.");
    return { exitCode: 0 };
  }
  const { values, offline } = parseFamilyTestArguments(argv), root = hooks.root ?? defaultRoot;
  const executorCodeMode = values.get("--executor-code-mode") ?? "counterfactual";
  const simulationMethod = values.get("--simulation-method") ?? "eth_simulateV1";
  const fingerprint = hooks.fingerprint ?? familyTestSourceFingerprint;
  const sourceFingerprint = fingerprint(root);
  const installed = await (hooks.getFamilies ?? getInstalledTransactionFamilies)();
  const families = values.has("--family") ? installed.filter(family => family.familyId === values.get("--family")) : installed;
  assert(families.length > 0, "unknown Family selection");
  const out = resolve(values.get("--out") ?? resolve(root, "../logs", `family-facts-${Date.now()}-${process.pid}`));
  mkdirSync(dirname(out), { recursive: true }); mkdirSync(out);
  const report = { format: "family-main-tests-v1", scope: "installed", started: new Date().toISOString(), sourceFingerprint,
    selection: { familyIds: families.map(family => family.familyId), wholeInstalledCatalog: families.length === installed.length, installedFamilyCount: installed.length },
    execution: { executorCodeMode, simulationMethod },
    offline: { status: "not-run" }, transactions: { status: "not-run" }, families: [], finished: false };
  const rows = [], save = () => {
    report.families = families.map(family => summarizeFamilyTransactionResults(family, rows, report.offline.status === "pass"));
    writeFileSync(resolve(out, "report.tmp"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    renameSync(resolve(out, "report.tmp"), resolve(out, "report.json"));
  };
  const run = hooks.execute ?? execute;
  save();
  const unit = await run(["scripts/test-protocol-json.mjs"], root, { ...process.env, SEARCHER_DRY_RUN: "1" });
  report.offline = { status: unit.exitCode === 0 ? "pass" : "failed", ...unit }; save();
  const registry = (hooks.registry ?? loadFamilyTransactionRegistry)(root), selectedIds = new Set(families.map(family => family.familyId));
  const selected = registry.legs.filter(row => selectedIds.has(row.leg.familyId));
  report.transactions = { status: offline ? "not-run" : "running", transactionFiles: registry.transactions.length, selectedLegs: selected.length,
      completeInputs: selected.filter(row => row.missing.length === 0).length, incompleteInputs: selected.filter(row => row.missing.length > 0).length,
      uninstalledReferences: [...new Set(registry.legs.filter(row => !installed.some(family => family.familyId === row.leg.familyId)).map(row => row.leg.familyId))],
      ...(offline ? { reason: "Explicit --offline; no same-state simulation acceptance" } : {}) };
    for (const item of selected) {
      const row = { familyId: item.leg.familyId, transactionHash: item.transaction.transactionHash, legId: item.leg.id,
        file: relative(root, item.path), inputSha256: item.sha256, inputFingerprint: item.inputFingerprint,
        inputComplete: item.missing.length === 0, missing: item.missing, referenceMissing: item.leg.referenceMissing ?? [],
        status: "not-run", evidenceVerified: false };
      rows.push(row);
      if (!row.inputComplete) { row.status = "incomplete"; row.error = `incomplete simulation input: ${item.missing.join(", ")}`; save(); continue; }
      if (offline) { row.reason = "Explicit --offline; simulation was not executed"; save(); continue; }
      if (!values.has("--rpc-file")) { row.status = "incomplete"; row.error = "missing --rpc-file; simulation was not executed"; save(); continue; }
      const family = families.find(family => family.familyId === row.familyId), directory = resolve(out, String(rows.length - 1).padStart(4, "0"));
      row.status = "running"; row.evidence = relative(out, resolve(directory, "report.json")); save();
      const args = ["--import", "tsx", "src/searcher/test/family-transaction-facts.ts", "--transaction", item.path,
        "--leg", item.leg.id, "--rpc-file", resolve(values.get("--rpc-file")), "--out", directory,
        "--executor-code-mode", executorCodeMode, "--simulation-method", simulationMethod];
      if (values.has("--ready")) args.push("--ready", resolve(values.get("--ready")));
      console.log(`[family-tests] ${row.familyId} ${row.transactionHash} ${row.legId}`);
      const caseEnv = { ...process.env, SEARCHER_DRY_RUN: "1", ...(family.envKey ? { [family.envKey]: "1" } : {}) };
      try {
        row.process = await run(args, root, caseEnv);
        assert.equal(row.process.exitCode, 0, "case process did not complete successfully");
        if (hooks.verify) await hooks.verify(resolve(directory, "report.json"), item.transaction, item.leg);
        else {
          // Activation is cached at import time. Re-decode evidence in a fresh
          // process with exactly the same selected-family catalog as the case.
          row.verificationProcess = await run(["--import", "tsx", "src/searcher/test/family-transaction-facts.ts",
            "--verify-report", resolve(directory, "report.json"), "--transaction", item.path, "--leg", item.leg.id], root, caseEnv);
          assert.equal(row.verificationProcess.exitCode, 0, "raw case evidence verification failed");
        }
        row.evidenceVerified = true; row.status = "pass";
        if (existsSync(resolve(directory, "report.json"))) {
          const bytes = readFileSync(resolve(directory, "report.json"));
          const child = JSON.parse(bytes);
          assert.deepEqual(child.execution, report.execution, "case execution mode differs from requested main run");
          row.evidenceSha256 = digest(bytes); row.stages = child.stages;
          row.originalTransactionInput = child.originalTransactionInput;
        }
      } catch (error) { row.evidenceVerified = false; row.status = "failed"; row.error = safe(error); }
      // Failure diagnostics never inherit verified passing-stage status.
      if (!row.evidenceVerified && existsSync(resolve(directory, "report.json"))) try {
        const bytes = readFileSync(resolve(directory, "report.json")), child = JSON.parse(bytes);
        row.evidenceSha256 = digest(bytes); row.reportedStages = child.stages;
        row.reportedStagesVerified = false; row.failure = child.failure;
        if (child.result === "incomplete" && child.failure?.stage === "transactionBinding") {
          row.bindingVerificationProcess = await run(["--import", "tsx", "src/searcher/test/family-transaction-facts.ts",
            "--verify-binding", resolve(directory, "report.json"), "--transaction", item.path, "--leg", item.leg.id], root, caseEnv);
          if (row.bindingVerificationProcess.exitCode === 0) {
            row.status = "incomplete"; row.inputBinding = child.stages.transactionBinding;
            row.inputBindingVerified = true;
          }
        }
      } catch (error) { row.diagnosticError = safe(error); }
      save();
    }
  report.sourceStable = fingerprint(root) === sourceFingerprint;
  report.finished = true; report.finishedAt = new Date().toISOString(); save();
  if (!offline) report.transactions.status = report.families.some(family => family.result === "failed") ? "failed"
    : report.families.some(family => family.result !== "pass") ? "incomplete" : "pass";
  report.result = report.sourceStable && report.offline.status === "pass" && (offline || report.transactions.status === "pass")
    ? offline ? "offline-contracts-pass" : "pass"
    : report.sourceStable && report.offline.status === "pass" && report.transactions.status === "incomplete" ? "incomplete" : "failed";
  save();
  const cases = rows.filter(row => row.process).map(row => {
    const stages = row.stages ?? row.reportedStages ?? {};
    const status = key => stages[key] && (row.evidenceVerified ? stages[key].status : `unverified:${stages[key].status}`);
    return { case: row.evidence?.split("/")[0], family: row.familyId, status: row.status, verified: row.evidenceVerified,
      txReference: status("transactionBinding"),
      discovery: status("discoveryCheckpoint"), exact: status("exact"),
      quoted: status("quotedExecution"), runtime: status("runtimeExecution"), parity: status("simulationOutputParity"),
      inputRaw: stages.exact?.requestedAmountIn, quoteRaw: stages.exact?.quotedAmountOut,
      quotedReceivedRaw: stages.quotedExecution?.actualAmountOut, runtimeReceivedRaw: stages.runtimeExecution?.actualAmountOut };
  });
  if (cases.length) console.table(cases);
  console.table(report.families.map(({ familyId, result, references, completeInputs, passedLegs }) => ({ familyId, result, references, completeInputs, passedLegs })));
  console.log(JSON.stringify({ result: report.result, sourceStable: report.sourceStable, report: resolve(out, "report.json") }));
  return { exitCode: ["pass", "offline-contracts-pass"].includes(report.result) ? 0 : 1, report, reportPath: resolve(out, "report.json") };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  familyTestMain().then(result => { process.exitCode = result.exitCode; }, error => { console.error(safe(error)); process.exitCode = 1; });
}
