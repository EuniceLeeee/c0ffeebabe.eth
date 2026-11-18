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
    assert(["--scope", "--family", "--rpc-file", "--ready", "--out", "--executor-code-mode", "--simulation-method", "--execution-source"].includes(key) && !values.has(key) && argv[i + 1] && !argv[i + 1].startsWith("--"), `invalid test argument ${key}`);
    values.set(key, argv[++i]);
  }
  assert((values.get("--scope") ?? "installed") === "installed", "main test scope is installed");
  assert(["deployed", "counterfactual"].includes(values.get("--executor-code-mode") ?? "counterfactual"), "invalid executor code mode");
  assert(["debug_traceCall", "eth_simulateV1"].includes(values.get("--simulation-method") ?? "eth_simulateV1"), "invalid simulation method");
  assert(["transaction", "parent"].includes(values.get("--execution-source") ?? "transaction"), "invalid execution source");
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
    result: family.enabled === false ? "disabled"
      : !offlinePassed || complete.some(row => row.status === "failed") ? "failed"
      : complete.length === 0 || complete.length !== rows.length || passed.length !== complete.length || missingActions.length > 0 ? "incomplete" : "pass",
    ...(rows.length === 0 ? { missing: ["no registered historical transaction"] } : {}), legs: rows };
}

/** Legacy fixture names select reference inputs only. The production selector
 * owner is assigned later, after independently verifying the child's binding. */
export function planFamilyTransactionTests(installed, legs, requestedFamilyId) {
  const selectorMode = installed.some(family => family.selectorExecution === true);
  const selectorDomain = leg => ["protocol", "swap", "funding", "credit"].includes(leg.domain);
  const installedRequest = requestedFamilyId === undefined ? undefined : installed.find(f => f.familyId === requestedFamilyId);
  // A retired label can still select historical inputs; it never selects the
  // production implementation or grants a funding provider binding.
  const reference = !installedRequest && selectorMode && requestedFamilyId !== undefined
    ? legs.find(row => row.leg.familyId === requestedFamilyId && selectorDomain(row.leg))?.leg : undefined;
  const requested = installedRequest ?? reference;
  assert(requestedFamilyId === undefined || requested, "unknown Family/reference selection");
  const referenceSelection = selectorMode && requested && selectorDomain(requested) && requested.selectorExecution !== true;
  const routingFamilies = selectorMode
    ? installed.filter(family => family.selectorExecution === true || !selectorDomain(family)) : installed;
  const families = requested && !referenceSelection ? [requested] : routingFamilies;
  assert(families.length > 0, "empty transaction test scope");
  const ids = new Set(families.map(family => family.familyId));
  const inputs = legs.filter(row => referenceSelection ? row.leg.familyId === requested.familyId
    : selectorMode && selectorDomain(row.leg) ? families.some(family => family.selectorExecution && family.enabled !== false && family.domain === row.leg.domain)
    : ids.has(row.leg.familyId));
  return { selectorMode, families, inputs,
    ...(referenceSelection ? { referenceFamilyId: requested.familyId } : {}),
    ...(requested?.selectorExecution ? { executionFamilyId: requested.familyId } : {}) };
}
const execute = (args, root, env) => {
  const child = spawnSync(process.execPath, args, { cwd: root, env, stdio: "inherit" });
  return { exitCode: child.status, signal: child.signal, ...(child.error ? { error: safe(child.error) } : {}) };
};

/** Test seams substitute process I/O only. The CLI has no skip-verification flag. */
export async function familyTestMain(argv = process.argv.slice(2), hooks = {}) {
  if (argv.length === 1 && argv[0] === "--help") {
    console.log("npm test -- [--scope installed] [--family ID] [--rpc-file PATH] [--ready PATH] [--out NEW_DIRECTORY]\n" +
      "            [--executor-code-mode deployed|counterfactual] [--simulation-method debug_traceCall|eth_simulateV1] [--execution-source transaction|parent]\n" +
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
  const registry = (hooks.registry ?? loadFamilyTransactionRegistry)(root);
  const plan = planFamilyTransactionTests(installed, registry.legs, values.get("--family"));
  const { families, inputs: selected } = plan;
  const out = resolve(values.get("--out") ?? resolve(root, "../logs", `family-facts-${Date.now()}-${process.pid}`));
  mkdirSync(dirname(out), { recursive: true }); mkdirSync(out);
  const report = { format: "family-main-tests-v1", scope: "installed", started: new Date().toISOString(), sourceFingerprint,
    selection: { familyIds: families.map(family => family.familyId), wholeInstalledCatalog: families.length === installed.length, installedFamilyCount: installed.length,
      readyScope: "production-active-catalog", grouping: plan.selectorMode ? "verified-execution-selector" : "registered-family",
      ...(plan.referenceFamilyId ? { referenceFamilyId: plan.referenceFamilyId } : {}) },
    execution: { executorCodeMode, simulationMethod }, executionSource: values.get("--execution-source") ?? "transaction",
    offline: { status: "not-run" }, transactions: { status: "not-run" }, families: [], finished: false };
  const rows = [], save = () => {
    report.families = families.filter(family => !plan.referenceFamilyId || rows.some(row => row.familyId === family.familyId))
      .map(family => summarizeFamilyTransactionResults(family, rows, report.offline.status === "pass"));
    report.unassignedLegs = rows.filter(row => !row.familyId);
    report.outsideSelection = rows.filter(row => row.familyId && !families.some(family => family.familyId === row.familyId));
    writeFileSync(resolve(out, "report.tmp"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    renameSync(resolve(out, "report.tmp"), resolve(out, "report.json"));
  };
  const run = hooks.execute ?? execute;
  save();
  const unit = await run(["scripts/test-protocol-json.mjs"], root, { ...process.env, SEARCHER_DRY_RUN: "1" });
  report.offline = { status: unit.exitCode === 0 ? "pass" : "failed", ...unit }; save();
  report.transactions = { status: offline ? "not-run" : "running", transactionFiles: registry.transactions.length, selectedLegs: selected.length,
      completeInputs: selected.filter(row => row.missing.length === 0).length, incompleteInputs: selected.filter(row => row.missing.length > 0).length,
      uninstalledReferences: [...new Set(registry.legs.filter(row => !installed.some(family => family.familyId === row.leg.familyId)).map(row => row.leg.familyId))],
      ...(offline ? { reason: "Explicit --offline; no same-state simulation acceptance" } : {}) };
    for (const item of selected) {
      const resolveSelectorOwner = plan.selectorMode && ["protocol", "swap", "funding", "credit"].includes(item.leg.domain);
      const row = { familyId: resolveSelectorOwner ? null : item.leg.familyId, referenceFamilyId: item.leg.familyId,
        transactionHash: item.transaction.transactionHash, legId: item.leg.id,
        file: relative(root, item.path), inputSha256: item.sha256, inputFingerprint: item.inputFingerprint,
        inputComplete: item.missing.length === 0, missing: item.missing, referenceMissing: item.leg.referenceMissing ?? [],
        status: "not-run", evidenceVerified: false };
      rows.push(row);
      if (!row.inputComplete) { row.status = "incomplete"; row.error = `incomplete simulation input: ${item.missing.join(", ")}`; save(); continue; }
      if (offline) { row.reason = "Explicit --offline; simulation was not executed"; save(); continue; }
      const family = row.familyId && families.find(family => family.familyId === row.familyId);
      if (family?.enabled === false) { row.status = "incomplete"; row.error = "Family is disabled by production activation; no override was applied"; save(); continue; }
      if (!values.has("--rpc-file")) { row.status = "incomplete"; row.error = "missing --rpc-file; simulation was not executed"; save(); continue; }
      const directory = resolve(out, String(rows.length - 1).padStart(4, "0"));
      row.status = "running"; row.evidence = relative(out, resolve(directory, "report.json")); save();
      const args = ["--import", "tsx", "src/searcher/test/family-transaction-facts.ts", "--transaction", item.path,
        "--leg", item.leg.id, "--rpc-file", resolve(values.get("--rpc-file")), "--out", directory,
        "--executor-code-mode", executorCodeMode, "--simulation-method", simulationMethod];
      if (values.has("--execution-source")) args.push("--execution-source", values.get("--execution-source"));
      if (values.has("--ready")) args.push("--ready", resolve(values.get("--ready")));
      console.log(`[family-tests] ${row.familyId ?? "selector-pending"} ${row.transactionHash} ${row.legId}`);
      const caseEnv = { ...process.env, SEARCHER_DRY_RUN: "1" };
      const assignVerifiedOwner = child => {
        if (!resolveSelectorOwner) return;
        const binding = child.executionBinding;
        const owner = installed.find(entry => entry.selectorExecution === true && entry.familyId === binding?.familyId);
        assert(owner && owner.enabled !== false && owner.domain === binding.domain,
          "verified case requires an active selector execution owner");
        row.familyId = binding.familyId; row.executionBinding = binding;
        row.inputBindingVerified = true;
      };
      try {
        row.process = await run(args, root, caseEnv);
        assert.equal(row.process.exitCode, 0, "case process did not complete successfully");
        if (hooks.verify) await hooks.verify(resolve(directory, "report.json"), item.transaction, item.leg);
        else {
          // Re-decode evidence with exactly the same production activation
          // defaults and explicit environment overrides as the case.
          row.verificationProcess = await run(["--import", "tsx", "src/searcher/test/family-transaction-facts.ts",
            "--verify-report", resolve(directory, "report.json"), "--transaction", item.path, "--leg", item.leg.id], root, caseEnv);
          assert.equal(row.verificationProcess.exitCode, 0, "raw case evidence verification failed");
        }
        row.evidenceVerified = true; row.status = "pass";
        if (existsSync(resolve(directory, "report.json"))) {
          const bytes = readFileSync(resolve(directory, "report.json"));
          const child = JSON.parse(bytes);
          assignVerifiedOwner(child);
          assert.deepEqual(child.execution, report.execution, "case execution mode differs from requested main run");
          assert.equal(child.stateSelection?.mode ?? "transaction", report.executionSource, "case execution source mode differs from requested main run");
          row.stateSelection = child.stateSelection;
          row.evidenceSha256 = digest(bytes); row.stages = child.stages;
          row.originalTransactionInput = child.originalTransactionInput;
        } else assert(!resolveSelectorOwner, "selector case report is missing");
      } catch (error) { row.evidenceVerified = false; row.status = "failed"; row.error = safe(error); }
      // Failure diagnostics never inherit verified passing-stage status.
      if (!row.evidenceVerified && existsSync(resolve(directory, "report.json"))) try {
        const bytes = readFileSync(resolve(directory, "report.json")), child = JSON.parse(bytes);
        row.evidenceSha256 = digest(bytes); row.reportedStages = child.stages;
        row.reportedStagesVerified = false; row.failure = child.failure;
        if ((child.result === "incomplete" && child.failure?.stage === "transactionBinding") ||
            (resolveSelectorOwner && child.executionBinding)) {
          row.bindingVerificationProcess = await run(["--import", "tsx", "src/searcher/test/family-transaction-facts.ts",
            "--verify-binding", resolve(directory, "report.json"), "--transaction", item.path, "--leg", item.leg.id], root, caseEnv);
          if (row.bindingVerificationProcess.exitCode === 0) {
            if (child.result === "incomplete" && child.failure?.stage === "transactionBinding") row.status = "incomplete";
            row.inputBinding = child.stages.transactionBinding;
            row.inputBindingVerified = true;
            if (child.executionBinding) assignVerifiedOwner(child);
          }
        }
      } catch (error) { row.diagnosticError = safe(error); }
      save();
    }
  report.sourceStable = fingerprint(root) === sourceFingerprint;
  report.finished = true; report.finishedAt = new Date().toISOString(); save();
  const requiredRows = rows.filter(row => !row.familyId || families.some(family => family.familyId === row.familyId && family.enabled !== false));
  if (!offline) report.transactions.status = requiredRows.some(row => row.status === "failed") || report.families.some(family => family.result === "failed") ? "failed"
    : requiredRows.length === 0 || requiredRows.some(row => row.status !== "pass") ||
      report.families.some(family => !["pass", "disabled"].includes(family.result)) ||
      report.families.every(family => family.result === "disabled") ? "incomplete" : "pass";
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
