import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { evidenceFailures, type FamilyReview } from "./family-settlement-review.js";
import { explicitSettlementAssertionFailures, isLegacySettlementRegistrarEvidence,
  legacySettlementRegistrarEvidenceFailures } from "./settlement-registrar-evidence.js";

const ordinaryAssertions = ["actual-input-debit", "actual-output-receipt", "old-inventory"];
const allAssertions = [...ordinaryAssertions, "rollback"];
const oldSummary = (passed: boolean, boring = false) => ({
  runSource: { number: 101, hash: "0x" + "01".repeat(32), generation: 1 },
  block: "0x" + "01".repeat(32),
  positive: { success: passed, grossProfit: passed ? "7" : "0", deltas: null, logs: 0 },
  [boring ? "impossible" : "rejected"]: { success: false, grossProfit: "0", deltas: null, logs: 0 },
  assertions: Object.fromEntries(allAssertions.map(key => [key, passed])),
});
function fixture(ordinary = false) {
  const store = new Map<string, Buffer>();
  const pin = (path: string, value: unknown) => {
    const bytes = Buffer.from(JSON.stringify(value)); store.set(path, bytes);
    return { path, sha256: createHash("sha256").update(bytes).digest("hex") };
  };
  const read = (path: string) => { const bytes = store.get(path); assert(bytes, "missing fixture"); return bytes; };
  const source = [pin("listener/src/fixture.ts", "source")];
  const review = pin("docs/research/reports/review.json", { families: [{ familyId: "test:fixture",
    variants: [{ id: "v1", callback: ordinary ? "internal-only" : "none", recipient: ordinary ? "no" : "yes", callerContinuation: false }] }] });
  const saved = pin("single-leg.json", { fixture: "independent historical report shape", measurements: [{ inputDelta: "-7", outputDelta: "8", oldInput: "101", oldOutput: "103" }] });
  const row: FamilyReview = { familyId: "test:fixture", domain: "protocol", coverage: "complete", source, review,
    variants: [{ id: "v1", interface: "verified", identity: "verified", callback: ordinary ? "internal-only" : "none",
      recipient: ordinary ? "no" : "yes", wiring: "verified", execution: ordinary ? "not-required" : "verified", gaps: [], evidence: [review] }] };
  const base = {
    kind: ordinary ? "family-ordinary-execution-evidence-v1" : "family-settlement-behavior-evidence-v1",
    familyId: row.familyId, variantIds: ["v1"], result: "pass", positiveExecutions: 1, rejections: 1,
    source, commonSource: [], verifiedAssertions: ordinary ? ordinaryAssertions : allAssertions, evidence: [saved],
  };
  function update(patch: object = {}) {
    const evidence = pin("execution.json", { ...base, ...patch });
    if (ordinary) row.variants[0]!.ordinaryExecutionEvidence = evidence;
    else row.variants[0]!.executionEvidence = evidence;
  }
  update();
  return { row, update, read, pin };
}

test("legacy registrar detection is shape-specific and includes Boring and incomplete summaries", () => {
  for (const value of [oldSummary(true), oldSummary(false, true), { positive: null, assertions: {} },
    { positive: { success: true, grossProfit: "1" } }, { runSource: {}, impossible: {}, assertions: {} }]) {
    assert.equal(isLegacySettlementRegistrarEvidence(value), true);
    assert.match(legacySettlementRegistrarEvidenceFailures(value)[0]!, /single-leg/);
  }
  for (const value of [null, [], {}, { assertions: { "actual-input-debit": true } },
    { executions: [{ balances: [{ before: "108", after: "101", delta: "-7" }] }] }]) {
    assert.equal(isLegacySettlementRegistrarEvidence(value), false);
    assert.deepEqual(legacySettlementRegistrarEvidenceFailures(value), []);
  }
});

test("fresh hashes and verified labels cannot pass a false legacy positive execution", () => {
  for (const ordinary of [false, true]) for (const boring of [false, true]) {
    const f = fixture(ordinary); f.update(oldSummary(false, boring));
    assert.match(evidenceFailures(f.row, [], f.read).join("\n"), /whole-transaction/);
  }
});

test("all-true whole-loop summaries still lack single-leg facts and executed source/plan binding", () => {
  for (const patch of [oldSummary(true), oldSummary(true, true),
    { ...oldSummary(true), runSource: { number: 102, hash: "wrong-block", generation: 0 } },
    { ...oldSummary(true), block: "0x" + "02".repeat(32) },
    { ...oldSummary(true), singleLegFacts: { verified: true } }]) {
    const f = fixture();
    // The old writer always pinned trial-1, even if it executed a different
    // selected trial. A valid hash cannot establish that missing relationship.
    const wrongPlan = f.pin("trial-1-input.json", { source: { number: 99 }, plan: { id: "not-the-selected-plan" } });
    f.update({ ...patch, evidence: [wrongPlan] });
    assert.match(evidenceFailures(f.row, [], f.read).join("\n"), /executed source and plan pin/);
  }
});

test("explicit false required assertions reject in other report shapes, including ordinary execution", () => {
  for (const ordinary of [false, true]) {
    for (const key of ordinary ? ordinaryAssertions : allAssertions) for (const value of [false, null, 0, "true"]) {
      const f = fixture(ordinary); f.update({ assertions: { [key]: value } });
      assert.match(evidenceFailures(f.row, [], f.read).join("\n"), /explicit settlement assertion is not true/);
    }
  }
  for (const key of ["callback-caller", "callback-debt", "output-before-payment"]) {
    const f = fixture(); f.row.variants[0]!.callback = "output-first";
    f.update({ verifiedAssertions: [...allAssertions, "callback-caller", "callback-debt", "output-before-payment"], assertions: { [key]: false } });
    assert.match(evidenceFailures(f.row, [], f.read).join("\n"), /explicit settlement assertion is not true/);
  }
  assert.deepEqual(explicitSettlementAssertionFailures({ assertions: { unrelatedOptionalCheck: false } }, allAssertions), []);
  assert.match(explicitSettlementAssertionFailures({ assertions: false }, allAssertions)[0]!, /record/);
});

test("other historical evidence formats retain their existing contract without new acceptance claims", () => {
  for (const ordinary of [false, true]) {
    const f = fixture(ordinary);
    assert.deepEqual(evidenceFailures(f.row, [], f.read), []);
    f.update({ assertions: Object.fromEntries((ordinary ? ordinaryAssertions : allAssertions).map(key => [key, true])) });
    assert.deepEqual(evidenceFailures(f.row, [], f.read), []);
  }
});

const registrarFiles = ["settlement-register-family.ts", "settlement-register-boring.ts"];
const loader = import.meta.resolve("tsx");
const dependencyRoot = realpathSync(join(dirname(fileURLToPath(loader)), "../.."));
function registrarGuard(directory: string, project: string): string {
  // Only the CLI/imported evidence source and the loader's package/config
  // metadata are bootstrap inputs. A cloud checkout is not an artifact read.
  const allowedFiles = [join(project, "tsconfig.json"), join(realpathSync(project), "tsconfig.json")];
  // macOS temp directories have /var and /private/var spellings; Node may use
  // either canonical source URL while importing the same explicitly pinned file.
  for (const sourceDir of new Set([directory, realpathSync(directory)])) {
    allowedFiles.push(...[...registrarFiles, "settlement-registrar-evidence.ts"].map(file => join(sourceDir, file)));
    for (let current = sourceDir;; current = dirname(current)) {
      allowedFiles.push(join(current, "package.json"));
      if (dirname(current) === current) break;
    }
  }
  return `
    import fs from 'node:fs';
    import net from 'node:net';
    import { resolve, sep } from 'node:path';
    import { fileURLToPath } from 'node:url';
    import { syncBuiltinESMExports } from 'node:module';
    const sources = new Set(${JSON.stringify(allowedFiles)});
    const dependencies = ${JSON.stringify(dependencyRoot)} + sep;
    const forbidden = () => { throw Error('FORBIDDEN_REGISTRAR_SIDE_EFFECT'); };
    const read = path => {
      if (typeof path === 'number') forbidden();
      const value = resolve(path instanceof URL ? fileURLToPath(path) : String(path));
      const dependency = value.startsWith(dependencies) &&
        (/\\.(?:cjs|mjs|js)$/.test(value) || value.endsWith(sep + 'package.json'));
      if (!sources.has(value) && !dependency) forbidden();
    };
    const wrap = (owner, key, check) => {
      const original = owner[key];
      owner[key] = function(...args) { check(...args); return original.apply(this, args); };
    };
    for (const key of ['readFileSync', 'readFile', 'createReadStream']) wrap(fs, key, read);
    wrap(fs.promises, 'readFile', read);
    const open = (path, flags) => {
      if (!(flags === 'r' || flags === 0)) forbidden();
      read(path);
    };
    wrap(fs, 'openSync', open); wrap(fs, 'open', open); wrap(fs.promises, 'open', open);
    for (const key of ['writeFileSync', 'writeFile', 'appendFileSync', 'appendFile', 'createWriteStream',
      'copyFileSync', 'copyFile', 'renameSync', 'rename', 'rmSync', 'rm', 'mkdirSync', 'mkdir',
      'unlinkSync', 'unlink', 'readdirSync', 'readdir']) if (fs[key]) fs[key] = forbidden;
    for (const key of ['writeFile', 'appendFile', 'copyFile', 'rename', 'rm', 'mkdir', 'unlink', 'readdir'])
      fs.promises[key] = forbidden;
    net.Socket.prototype.connect = forbidden;
    globalThis.fetch = forbidden;
    syncBuiltinESMExports();
  `;
}
function runGuarded(guard: string, args: string[], cwd: string) {
  return spawnSync(process.execPath, ["--import", loader,
    "--import", "data:text/javascript," + encodeURIComponent(guard), ...args],
  { cwd, encoding: "utf8", env: { ...process.env, TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: join(cwd, "tsconfig.json") }, timeout: 15000 });
}
function assertRetired(directory: string, project: string) {
  for (const file of registrarFiles) {
    const result = runGuarded(registrarGuard(directory, project), [join(directory, file), "fixture", "missing-lane", "v1", "none", "yes"], project);
    assert.equal(result.error, undefined); assert.equal(result.status, 1);
    assert.match(result.stderr, /Settlement registrar disabled/);
    assert.doesNotMatch(result.stderr, /FORBIDDEN_REGISTRAR_SIDE_EFFECT/);
  }
}

test("retired registrars fail before external artifact reads, RPC or registry writes", () => {
  assertRetired(dirname(fileURLToPath(import.meta.url)), fileURLToPath(new URL("../../../", import.meta.url)));
});

test("cloud-path bootstrap still runs the real retired CLI while artifact/config/write/network operations remain denied", () => {
  const scratch = mkdtempSync(join(tmpdir(), "registrar-bootstrap-"));
  // This reproduces the old substring guard on every host, without writing /opt.
  const project = join(scratch, "opt/mev-cloud/fixture/listener"), directory = join(project, "src/searcher/test");
  try {
    mkdirSync(directory, { recursive: true });
    for (const file of [...registrarFiles, "settlement-registrar-evidence.ts"])
      copyFileSync(fileURLToPath(new URL(file, import.meta.url)), join(directory, file));
    writeFileSync(join(project, "package.json"), '{"type":"module"}');
    writeFileSync(join(project, "tsconfig.json"), '{"compilerOptions":{"target":"ES2022","module":"Node16"}}');
    assertRetired(directory, project);
    const artifact = join(project, "saved-artifact.json");
    writeFileSync(artifact, '{"evidence":"must not read"}');
    const guard = registrarGuard(directory, project);
    for (const operation of [
      `fs.readFileSync(${JSON.stringify(artifact)});`,
      `await fs.promises.readFile(${JSON.stringify(artifact)});`,
      `fs.readFileSync('/tmp/ds-rpc.json');`,
      `fs.readFileSync('/opt/mev-cloud/other-workspace/config.json');`,
      `fs.writeFileSync(${JSON.stringify(artifact)}, 'changed');`,
      `fs.writeFileSync(${JSON.stringify(join(directory, registrarFiles[0]!))}, 'changed');`,
      `await fs.promises.writeFile(${JSON.stringify(artifact)}, 'changed');`,
      `fs.openSync(${JSON.stringify(artifact)}, 'r+');`,
      `fs.readdirSync(${JSON.stringify(project)});`,
      `await fetch('http://127.0.0.1:1');`,
      `new net.Socket().connect(1, '127.0.0.1');`,
    ]) {
      const result = runGuarded(guard, ["--input-type=module", "--eval", `import fs from 'node:fs'; import net from 'node:net'; ${operation}`], project);
      assert.equal(result.error, undefined); assert.equal(result.status, 1);
      assert.match(result.stderr, /FORBIDDEN_REGISTRAR_SIDE_EFFECT/, operation);
    }
    assert.equal(readFileSync(artifact, "utf8"), '{"evidence":"must not read"}');
    assert.equal(readFileSync(join(directory, registrarFiles[0]!), "utf8"), readFileSync(fileURLToPath(new URL(registrarFiles[0]!, import.meta.url)), "utf8"));
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
