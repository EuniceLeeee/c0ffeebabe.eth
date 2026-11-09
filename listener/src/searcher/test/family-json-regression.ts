// Whole installed-JSON test round. Uses the existing sample validator and
// acceptance process; never discovers pools, mutates Ready, or starts live.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, openSync, closeSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { syncDeclarativeProductionEntries } from "../build-declarative-production.js";
import { loadFamilyJsonSamples } from "./protocol-json-samples.js";
import { parseProtocolJsonAcceptanceCase } from "./protocol-json-acceptance-facts.js";
import { registerAcceptanceSample } from "./protocol-json-sample-registration.js";

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

export async function buildFamilyRegressionPlan(root = defaultRoot): Promise<RegressionPlan> {
  const entries = await syncDeclarativeProductionEntries({ rootDirectory: root, mode: "check" });
  const libraries = ["protocol", "swap"].map(domain => loadFamilyJsonSamples(
    resolve(root, `src/searcher/test/fixtures/${domain}-json/index.json`), domain as "protocol" | "swap"));
  const source = files(resolve(root, "src"));
  const tests = source.filter(path => relative(root, path).split("/").some(part => part === "test" || part === "tests"));
  const families = [...entries.values()].filter(entry => entry.format !== "bindings-v1")
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
  assert(families.length > 0, "no installed JSON production families");
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

export async function familyJsonRegressionMain(argv = process.argv.slice(2)) {
  const args = new Map<string, string>(); let run = false;
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]!;
    if (key === "--run" && !run) { run = true; continue; }
    assert(["--out", "--bindings", "--check-report"].includes(key) && !args.has(key) && argv[i + 1], "invalid regression arguments");
    args.set(key, argv[++i]!);
  }
  const root = defaultRoot, plan = await buildFamilyRegressionPlan(root);
  if (args.has("--check-report")) {
    assert(!run && args.size === 1, "report checking does not run tests");
    const report = json(resolve(args.get("--check-report")!));
    const current = sameRegressionInputs(plan, report.plan);
    const evidenceIntact = verifyRegressionCaseEvidence(plan, report.cases, root, resolve(args.get("--check-report")!, ".."));
    const allPassed = current && evidenceIntact && report.finished === true && report.sourceStable === true && report.offline?.status === "pass" &&
      plan.families.every(family => report.definitions?.[family.familyId]?.status === "pass") &&
      plan.families.every(family => summarizeFamilyRerun(family, report.cases ?? [], true).result === "supplied-cases-pass");
    console.log(JSON.stringify({ current, allPassed, families: plan.families.length,
      claim: "Does not certify all variants or performance" }));
    if (!allPassed) process.exitCode = 1;
    return;
  }
  assert(args.has("--out"), "--out new-directory is required");
  const out = resolve(args.get("--out")!); mkdirSync(out); // Exclusive: failed attempts stay intact.
  const bindings = args.has("--bindings") ? json(resolve(args.get("--bindings")!)) : { version: 1, cases: {} };
  assert.equal(bindings.version, 1); assert(bindings.cases && typeof bindings.cases === "object" && !Array.isArray(bindings.cases));
  const samples = plan.families.flatMap(family => family.cases);
  assert(Object.keys(bindings.cases).every(id => samples.some(sample => sample.id === id)), "binding for unknown/stale case");
  const report: any = { format: "family-json-regression-round-v1", started: new Date().toISOString(), plan,
    offline: { status: "not-run" }, definitions: {}, cases: samples.map(sample => ({ id: sample.id, status: "not-run" })), finished: false };
  const checkpoint = () => {
    report.families = plan.families.map(family => ({ ...summarizeFamilyRerun(family, report.cases,
      report.offline.status === "pass" && report.definitions[family.familyId]?.status === "pass"),
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
  const unit = execute(["scripts/test-protocol-json.mjs"], resolve(out, "offline.log"));
  report.offline = { ...unit, status: unit.code === 0 ? "pass" : "failed" }; checkpoint();
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
    if (!binding) { row.reason = "missing case-specific Ready/RPC-file/revm binding"; checkpoint(); continue; }
    assert(Object.keys(binding).sort().join(",") === "ready,revmBin,rpcFile" && Object.values(binding).every(value => typeof value === "string" && value.length > 0), "invalid execution binding");
    row.status = "running"; checkpoint();
    const name = String(index).padStart(4, "0"), evidence = resolve(out, `${name}.json`);
    const result = execute(["--import", "tsx", "src/searcher/test/protocol-json-acceptance.ts", "--case", resolve(root, sample.file),
      "--ready", resolve(binding.ready), "--rpc-file", resolve(binding.rpcFile), "--revm-bin", resolve(binding.revmBin), "--out", evidence], resolve(out, `${name}.log`));
    row.process = result; row.evidence = relative(out, evidence);
    try {
      const facts = json(evidence);
      row.status = classifyAcceptanceEvidence(facts, json(resolve(root, sample.file)), result.code);
      row.coverage = facts.coverage; row.errors = facts.errors; row.runnerResult = facts.result;
      row.evidenceSha256 = digest(readFileSync(evidence));
    } catch (error) { row.status = "failed"; row.reason = safe(error); }
    checkpoint();
  }
  report.sourceStable = sameRegressionInputs(plan, await buildFamilyRegressionPlan(root));
  report.finished = true; report.ended = new Date().toISOString(); checkpoint();
  console.log(JSON.stringify({ report: resolve(out, "report.json"), sourceStable: report.sourceStable,
    results: report.families.map((row: any) => ({ familyId: row.familyId, result: row.result })) }));
  if (!report.sourceStable || report.families.some((row: any) => row.result !== "supplied-cases-pass")) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  familyJsonRegressionMain().catch(error => { console.error(safe(error)); process.exitCode = 1; });
