// Whole installed-JSON test round. Uses the existing sample validator and
// acceptance process; never discovers pools, mutates Ready, or starts live.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, openSync, closeSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { selectFamilyActivation } from "../../../scripts/test-family-activation-report.mjs";
import { syncDeclarativeProductionEntries } from "../build-declarative-production.js";
import { loadFamilyJsonSamples } from "./protocol-json-samples.js";
import { parseProtocolJsonAcceptanceCase } from "./protocol-json-acceptance-facts.js";
import { registerAcceptanceSample } from "./protocol-json-sample-registration.js";
import { getInstalledTransactionFamilies } from "./family-transaction-registry.js";

const defaultRoot = fileURLToPath(new URL("../../../", import.meta.url));
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const safe = (error: unknown) => String(error instanceof Error ? error.message : error).replace(/https?:\/\/[^\s"<>]+/g, "[REDACTED_URL]");
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    assert(!entry.isSymbolicLink(), "source/sample symlink is not a regression input");
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}
function fingerprint(root: string, paths: string[]): string {
  return digest(JSON.stringify([...new Set(paths)].sort().map(path => [relative(root, path), digest(readFileSync(path))])));
}

export interface RegressionCase { id: string; familyId: string; file: string; sha256: string }
export interface RegressionFamily {
  familyId: string; domain: string; definition: string;
  entry: string;
  variants: { id: string; lineageId: string }[];
  cases: RegressionCase[]; gaps: string[];
}
export interface RegressionPlan {
  format: "family-json-regression-plan-v1"; testFingerprint: string; sourceFingerprint: string;
  families: RegressionFamily[];
}

export async function buildFamilyRegressionPlan(root = defaultRoot, scope: "json" | "installed" = "json"): Promise<RegressionPlan> {
  const entries = await syncDeclarativeProductionEntries({ rootDirectory: root, mode: "check" });
  const libraries = ["protocol", "swap"].map(domain => loadFamilyJsonSamples(
    resolve(root, `src/searcher/test/fixtures/${domain}-json/index.json`), domain as "protocol" | "swap"));
  const source = files(resolve(root, "src"));
  const tests = source.filter(path => relative(root, path).split("/").some(part => part === "test" || part === "tests"));
  let families = [...entries.values()].filter(entry => entry.format !== "bindings-v1")
    .sort((a, b) => a.familyId.localeCompare(b.familyId)).map(entry => {
      const doc = json(entry.definitionFile);
      const variants = [doc.standard, ...entry.childFiles.map(json)].map(({ id, lineageId }) => ({ id, lineageId }));
      const summary = libraries.flatMap(library => library.summary).find(row => row.familyId === entry.familyId);
      const cases = libraries.flatMap(library => library.cases).filter(row => row.familyId === entry.familyId)
        .map(row => ({ id: relative(root, row.path), familyId: entry.familyId, file: relative(root, row.path), sha256: digest(readFileSync(row.path)) }));
      return { familyId: entry.familyId, domain: entry.domain, definition: relative(root, entry.definitionFile), entry: relative(root, entry.entryFile), variants, cases,
        gaps: summary ? [...summary.missingSamples, ...summary.pending.map(row => `${row.id}: ${row.missing.join(", ")}`)]
          : [entry.domain === "credit" ? "historical Credit runner/sample library not available" : "no indexed historical sample library entry"],
      };
    });
  if (scope === "installed") {
    const byId = new Map(families.map(family => [family.familyId, family]));
    families = (await getInstalledTransactionFamilies()).map(family => {
      const known = byId.get(family.familyId);
      if (known) return known;
      const entry = `src/searcher/venues/production-families/${family.sourceFile}`;
      return { familyId: family.familyId, domain: family.domain, entry, definition: entry,
        variants: family.lineages.map(lineageId => ({ id: lineageId, lineageId })),
        cases: libraries.flatMap(library => library.cases).filter(row => row.familyId === family.familyId)
          .map(row => ({ id: relative(root, row.path), familyId: family.familyId, file: relative(root, row.path), sha256: digest(readFileSync(row.path)) })),
        gaps: ["Full-domain factual acceptance uses npm test and the centralized transaction registry"],
      };
    });
  }
  assert(families.length > 0, "no installed production families");
  return { format: "family-json-regression-plan-v1", families,
    testFingerprint: digest(process.version + ":" + fingerprint(root, [...tests, ...readdirSync(resolve(root, "scripts"))
      .filter(name => /^test-.*\.(mjs|js|ts)$/.test(name)).map(name => resolve(root, "scripts", name)), resolve(root, "package.json"),
      ...["package-lock.json", "pnpm-lock.yaml", "yarn.lock"].map(name => resolve(root, name)).filter(existsSync)])),
    sourceFingerprint: fingerprint(root, source.filter(path => !tests.includes(path))),
  };
}

/** A shared test change expires every row, including disabled installed JSON
 * families. Comparing only a Family definition cannot renew old test evidence. */
export function sameRegressionInputs(current: RegressionPlan, prior: RegressionPlan): boolean {
  return prior?.format === current.format && current.testFingerprint === prior.testFingerprint &&
    current.sourceFingerprint === prior.sourceFingerprint && JSON.stringify(current.families) === JSON.stringify(prior.families);
}
export type CaseResult = { id: string; status: "not-run" | "running" | "pass" | "incomplete" | "failed"; reason?: string; evidence?: string };
export function classifyAcceptanceEvidence(facts: any, rawSample: unknown, exitCode: number | null): CaseResult["status"] {
  assert.equal(facts.format, "protocol-json-acceptance-v1");
  assert.deepEqual(facts.sample, parseProtocolJsonAcceptanceCase(rawSample), "runner evidence must bind the normalized sample input");
  // A successful child process is insufficient: aggregation must preserve the
  // same registered sample/index pins that the runner checked around execution.
  try {
    assert(facts.registration && typeof facts.registration.path === "string");
    assert.deepEqual(facts.registration, registerAcceptanceSample(facts.sample, facts.registration.path));
  } catch { return "failed"; }
  if (facts.drained !== true || !Array.isArray(facts.samples) || facts.samples.length === 0 ||
      !Array.isArray(facts.errors) || facts.errors.length > 0 ||
      facts.samples.some((row: any) => row.error || row.result === "failed" || !Array.isArray(row.executions) ||
        row.executions.some((execution: any) => execution.result !== "pass"))) return "failed";
  if (exitCode === 0 && facts.result === "pass" && facts.samples.every((row: any) => row.result === "pass" && row.executions.length > 0)) return "pass";
  if (exitCode === 1 && facts.result === "incomplete-or-failed" && facts.samples.every((row: any) => ["pass", "partial"].includes(row.result))) return "incomplete";
  return "failed";
}
export function verifyRegressionCaseEvidence(plan: RegressionPlan, rows: any[], root: string, directory: string): boolean {
  try {
    const samples = plan.families.flatMap(family => family.cases);
    assert(Array.isArray(rows) && rows.length === samples.length && new Set(rows.map(row => row.id)).size === rows.length);
    for (const sample of samples) {
      const row = rows.find(row => row.id === sample.id);
      assert(row?.status === "pass" && typeof row.evidence === "string" && /^\d{4,}\.json$/.test(row.evidence));
      const file = resolve(directory, row.evidence), bytes = readFileSync(file);
      assert.equal(row.evidenceSha256, digest(bytes));
      assert.equal(classifyAcceptanceEvidence(JSON.parse(bytes.toString()), json(resolve(root, sample.file)), row.process?.code), "pass");
    }
    return true;
  } catch { return false; }
}
export function summarizeFamilyRerun(family: RegressionFamily, rows: CaseResult[], offlinePassed: boolean) {
  const selected = family.cases.map(sample => rows.find(row => row.id === sample.id));
  const ran = selected.filter(row => row && ["pass", "incomplete", "failed"].includes(row.status)).length;
  return { familyId: family.familyId, domain: family.domain, variants: family.variants,
    expectedCases: family.cases.length, completedCases: ran, gaps: family.gaps,
    result: !offlinePassed || selected.some(row => row?.status === "failed") ? "failed"
      : family.cases.length === 0 || ran !== family.cases.length || family.gaps.length > 0 || selected.some(row => row?.status !== "pass")
        ? "incomplete" : "supplied-cases-pass",
    claim: "Rerun of supplied facts only; full variant, settlement-review and performance acceptance remain separate",
  };
}

export function selectRegressionFamilies(plan: RegressionPlan, ids: readonly string[]): RegressionPlan {
  const requested = new Set(ids);
  const families = plan.families.filter(family => requested.has(family.familyId));
  assert(ids.length > 0 && requested.size === ids.length && families.length === ids.length,
    "unknown, duplicate or empty Family regression scope");
  return { ...plan, families };
}

function readOfflineFamilyResults(path: string, plan: RegressionPlan, code: number) {
  const bytes = readFileSync(path);
  const events = bytes.toString("utf8").trimEnd().split("\n").map(line => JSON.parse(line));
  const result = selectFamilyActivation(events, plan.families.map(family => family.familyId), code);
  return { ...result, sha256: digest(bytes) };
}

/** Recheck current inputs and each Family's actual case files independently. */
export function readFamilyRegressionVerdicts(reportPath: string, current: RegressionPlan, root = defaultRoot) {
  const path = resolve(reportPath), report = json(path), directory = dirname(path);
  assert(report?.format === "family-json-regression-round-v1" && report.finished === true &&
    report.sourceStable === true && Array.isArray(report.plan?.families), "Family regression report did not finish on stable inputs");
  const scope = selectRegressionFamilies(current, report.plan.families.map((family: RegressionFamily) => family.familyId));
  assert(sameRegressionInputs(scope, report.plan), "Family regression inputs changed");
  const offline = readOfflineFamilyResults(resolve(directory, "offline-tests.jsonl"), current, report.offline?.code);
  assert.equal(offline.sha256, report.offline?.evidenceSha256, "offline Family test evidence changed");
  const ids = scope.families.flatMap(family => family.cases.map(sample => sample.id));
  assert(Array.isArray(report.cases) && report.cases.length === ids.length &&
    new Set(report.cases.map((row: CaseResult) => row.id)).size === ids.length &&
    ids.every(id => report.cases.some((row: CaseResult) => row.id === id)), "Family regression case set differs");
  return scope.families.map(family => {
    const verdict = offline.families.find(row => row.id === family.familyId);
    const offlinePassed = offline.sharedFailures.length === 0 && verdict?.definition === true &&
      verdict.failed === 0 && verdict.incomplete === 0 && report.definitions?.[family.familyId]?.status === "pass";
    const samples = new Set(family.cases.map(sample => sample.id));
    const rows = report.cases.filter((row: CaseResult) => samples.has(row.id));
    const result = summarizeFamilyRerun(family, rows, offlinePassed);
    if (result.result === "supplied-cases-pass" &&
        !verifyRegressionCaseEvidence(selectRegressionFamilies(current, [family.familyId]), rows, root, directory)) {
      return { ...result, result: "failed", evidenceError: "Family case evidence did not verify" };
    }
    return result;
  });
}

export async function familyJsonRegressionMain(argv = process.argv.slice(2)) {
  const args = new Map<string, string>(); let run = false;
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]!;
    if (key === "--run" && !run) { run = true; continue; }
    assert(["--out", "--bindings", "--family", "--check-report", "--scope"].includes(key) && !args.has(key) && argv[i + 1], "invalid regression arguments");
    args.set(key, argv[++i]!);
  }
  const scope = args.get("--scope") ?? "json";
  assert(scope === "json" || scope === "installed", "invalid regression scope");
  const root = defaultRoot, installed = await buildFamilyRegressionPlan(root, scope);
  if (args.has("--check-report")) {
    assert(!run && args.size === (args.has("--scope") ? 2 : 1), "report checking does not run tests");
    const families = readFamilyRegressionVerdicts(args.get("--check-report")!, installed, root);
    const allPassed = families.every(row => row.result === "supplied-cases-pass");
    console.log(JSON.stringify({ current: true, allPassed, families, claim: "Does not certify all variants or performance" }));
    if (!allPassed) process.exitCode = 1;
    return;
  }
  const requested = args.get("--family");
  const plan = requested ? selectRegressionFamilies(installed, [requested]) : installed;
  assert(args.has("--out"), "--out new-directory is required");
  const out = resolve(args.get("--out")!); mkdirSync(out); // Exclusive: failed attempts stay intact.
  const bindings = args.has("--bindings") ? json(resolve(args.get("--bindings")!)) : { version: 1, cases: {} };
  assert.equal(bindings.version, 1); assert(bindings.cases && typeof bindings.cases === "object" && !Array.isArray(bindings.cases));
  const samples = plan.families.flatMap(family => family.cases);
  const installedCaseIds = new Set(installed.families.flatMap(family => family.cases.map(sample => sample.id)));
  assert(Object.keys(bindings.cases).every(id => installedCaseIds.has(id)), "binding for unknown/stale case");
  const report: any = { format: "family-json-regression-round-v1", started: new Date().toISOString(), plan,
    offline: { status: "not-run" }, definitions: {}, cases: samples.map(sample => ({ id: sample.id, status: "not-run" })), finished: false };
  const checkpoint = () => {
    report.families = plan.families.map(family => ({ ...summarizeFamilyRerun(family, report.cases,
      report.offline.status === "pass" && report.definitions[family.familyId]?.status === "pass" &&
        report.offline.families?.some((row: { id: string; definition: boolean; failed: number; incomplete: number }) =>
          row.id === family.familyId && row.definition && row.failed === 0 && row.incomplete === 0)),
      ...(["not-run", "running"].includes(report.offline.status) ? { result: "not-run" } : {}),
    }));
    writeFileSync(resolve(out, "report.tmp"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    renameSync(resolve(out, "report.tmp"), resolve(out, "report.json"));
  };
  checkpoint();
  if (!run) { console.log(JSON.stringify({ families: plan.families.length, cases: samples.length, report: resolve(out, "report.json"), execution: "not-run" })); return; }
  const execute = (argv: string[], log: string) => {
    const fd = openSync(log, "wx", 0o600);
    try { const child = spawnSync(process.execPath, argv, { cwd: root, env: process.env, stdio: ["ignore", fd, fd] });
      return { code: child.status, signal: child.signal, ...(child.error ? { error: safe(child.error) } : {}) };
    } finally { closeSync(fd); }
  };
  report.offline = { status: "running" }; checkpoint();
  const offlinePath = resolve(out, "offline-tests.jsonl");
  const unit = execute(["scripts/test-protocol-json.mjs", "--activation-report", offlinePath], resolve(out, "offline.log"));
  try {
    assert(unit.code !== null, "shared test process did not finish");
    const result = readOfflineFamilyResults(offlinePath, installed, unit.code);
    report.offline = { ...unit, status: result.sharedFailures.length === 0 ? "pass" : "failed",
      evidenceSha256: result.sha256, families: result.families, sharedFailures: result.sharedFailures };
  } catch (error) {
    report.offline = { ...unit, status: "failed", reason: safe(error) };
  }
  checkpoint();
  for (const family of plan.families) {
    try {
      const { plugin } = await import(pathToFileURL(resolve(root, family.entry)).href);
      assert.equal(plugin.manifest.familyId, family.familyId); assert.equal(plugin.manifest.domain, family.domain);
      report.definitions[family.familyId] = { status: "pass", claim: "production entry import/definition only" };
    } catch (error) { report.definitions[family.familyId] = { status: "failed", reason: safe(error) }; }
    checkpoint();
  }
  for (const [index, sample] of samples.entries()) {
    const row = report.cases[index], binding = bindings.cases[sample.id];
    if (!binding) { row.reason = "missing case-specific Ready/RPC-file binding"; checkpoint(); continue; }
    assert(binding.ready && binding.rpcFile && Object.keys(binding).every(key => ["ready", "rpcFile", "revmBin"].includes(key)) &&
      Object.values(binding).every(value => typeof value === "string" && value.length > 0), "invalid execution binding");
    row.status = "running"; checkpoint();
    const name = String(index).padStart(4, "0"), evidence = resolve(out, `${name}.json`);
    const result = execute(["--import", "tsx", "src/searcher/test/protocol-json-acceptance.ts", "--case", resolve(root, sample.file),
      "--ready", resolve(binding.ready), "--rpc-file", resolve(binding.rpcFile), "--out", evidence], resolve(out, `${name}.log`));
    row.process = result; row.evidence = relative(out, evidence);
    try {
      const facts = json(evidence);
      row.status = classifyAcceptanceEvidence(facts, json(resolve(root, sample.file)), result.code);
      row.coverage = facts.coverage; row.errors = facts.errors; row.runnerResult = facts.result;
      row.evidenceSha256 = digest(readFileSync(evidence));
    } catch (error) { row.status = "failed"; row.reason = safe(error); }
    checkpoint();
  }
  report.sourceStable = sameRegressionInputs(installed, await buildFamilyRegressionPlan(root, scope));
  report.finished = true; report.ended = new Date().toISOString(); checkpoint();
  console.log(JSON.stringify({ report: resolve(out, "report.json"), sourceStable: report.sourceStable,
    results: report.families.map((row: any) => ({ familyId: row.familyId, result: row.result })) }));
  if (!report.sourceStable || report.families.some((row: any) => row.result !== "supplied-cases-pass")) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  familyJsonRegressionMain().catch(error => { console.error(safe(error)); process.exitCode = 1; });
