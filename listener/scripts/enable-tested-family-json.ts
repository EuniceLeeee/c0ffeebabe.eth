import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { buildFamilyRegressionPlan, readFamilyRegressionVerdicts, sameRegressionInputs } from "../src/searcher/test/family-json-regression.js";

function jsonProperty(object: ts.Expression, name: string): ts.Expression {
  assert(ts.isObjectLiteralExpression(object), `expected an object containing ${name}`);
  const fields = object.properties.filter(
    (field): field is ts.PropertyAssignment =>
      ts.isPropertyAssignment(field) && ts.isStringLiteral(field.name) && field.name.text === name,
  );
  assert.equal(fields.length, 1, `expected one JSON property named ${name}`);
  return fields[0]!.initializer;
}

function enableDefault(file: string, text: string): string {
  const source = ts.parseJsonText(file, text);
  const statement = source.statements[0];
  assert(statement && ts.isExpressionStatement(statement), "invalid Family JSON");
  const activation = jsonProperty(jsonProperty(statement.expression, "production"), "activation");
  const enabled = jsonProperty(activation, "enabled");
  if (enabled.kind === ts.SyntaxKind.TrueKeyword) return text;
  assert.equal(enabled.kind, ts.SyntaxKind.FalseKeyword, "Family enabled must be boolean");
  return text.slice(0, enabled.getStart(source)) + "true" + text.slice(enabled.getEnd());
}

const root = fileURLToPath(new URL("../", import.meta.url));

function run(script: string): void {
  const result = spawnSync("npm", ["run", script], { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${script} failed (${result.signal ?? result.status})`);
}

function replaceFile(path: string, text: string): void {
  const temporary = path + "." + randomUUID() + ".tmp";
  try {
    writeFileSync(temporary, text, { flag: "wx", mode: statSync(path).mode });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

async function main(): Promise<void> {
  const [option, reportPath, ...extra] = process.argv.slice(2);
  assert(option === "--report" && reportPath && !extra.length, "expected --report PATH from the unified Family JSON regression");
  const lockPath = resolve(root, ".family-json-enable.lock");
  const lock = openSync(lockPath, "wx", 0o600);
  try {
    const plan = await buildFamilyRegressionPlan(root);
    const verdicts = readFamilyRegressionVerdicts(reportPath, plan, root);
    console.log(JSON.stringify(verdicts));
    const passed = new Set(verdicts.filter(row => row.result === "supplied-cases-pass").map(row => row.familyId));

    const updates = plan.families.filter(family => passed.has(family.familyId)).flatMap(family => {
      const path = resolve(root, family.definition);
      const original = readFileSync(path, "utf8");
      const enabled = enableDefault(path, original);
      return original === enabled ? [] : [{ path, original, enabled, entry: resolve(root, family.entry), id: family.familyId }];
    });
    if (updates.length === 0) {
      console.log("No passing JSON Family needs a default activation change.");
      return;
    }

    run("family-capability-manifest:check");
    assert(sameRegressionInputs(plan, await buildFamilyRegressionPlan(root)), "Family JSON or tests changed before activation");

    // The preflight established a coherent catalog. Changing this boolean
    // only changes the selected definitions, their entries and catalog output.
    const outputs = [
      ...updates.map(update => update.entry),
      resolve(root, "src/searcher/generated/family-capability-shadow.generated.json"),
      resolve(root, "src/searcher/generated/production-family-entries.generated.ts"),
    ];
    const originalOutputs = outputs.map(path => ({ path, original: readFileSync(path, "utf8") }));
    const applied: typeof updates = [];
    try {
      for (const update of updates) {
        assert.equal(readFileSync(update.path, "utf8"), update.original, `Family JSON changed: ${update.id}`);
        replaceFile(update.path, update.enabled);
        applied.push(update);
      }
      run("family-capability-manifest:generate");
      run("build:live");
      run("family-capability-manifest:check");
    } catch (error) {
      for (const update of applied) {
        if (readFileSync(update.path, "utf8") === update.enabled) replaceFile(update.path, update.original);
      }
      if (applied.length === updates.length) {
        for (const { path, original } of originalOutputs) {
          if (readFileSync(path, "utf8") !== original) replaceFile(path, original);
        }
      }
      throw error;
    }
    console.log(`Enabled by default: ${updates.map(update => update.id).join(", ")}`);
  } finally {
    closeSync(lock);
    unlinkSync(lockPath);
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
